/*
 * reel-voice: ProtoArt Reel's voice clean-up processor (offline).
 *
 *   Voice Clean  - neural noise / ambience removal (RNNoise, BSD-3) steered per frequency band, with
 *                  reflections (release), an ambience gate driven by the voice detector, voice or
 *                  ambience focus.
 *   DeReverb     - late-reverberation suppression in the STFT domain (statistical reverb model),
 *                  with strength, tail smoothing, presence restore and per-band amounts.
 *   Output       - stereo width, output gain, peak limiter.
 *
 * Reads raw 32-bit float interleaved audio at 48 kHz (1 or 2 channels) on stdin and writes a
 * 32-bit float WAV to the path given. Prints "P <frames>" progress lines and "DONE <frames>".
 *
 * Usage: reel-voice --out file.wav --channels 2 [--clean 0..1] [--focus voice|ambience]
 *        [--process 0..1] [--reflections 0..1] [--gate-mix 0..1] [--gate-threshold 0..1]
 *        [--gate-attack ms] [--gate-release ms] [--dereverb 0..1] [--strength 1..3] [--room s]
 *        [--tail 0..1] [--presence 0..1] [--bands g1,g2,g3,g4,g5,g6] [--width 0..1]
 *        [--gain dB] [--limit 0|1]
 */
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "rnnoise/rnnoise.h"

#define RATE 48000
#define N 1024          /* STFT size */
#define H 256           /* hop (75% overlap) */
#define BINS (N / 2 + 1)
#define RN 480          /* RNNoise frame */
#define MAXCH 2
#ifndef PSM_A
#define PSM_A 0.3f
#endif
#ifndef FLOOR_P
#define FLOOR_P 0.001f
#endif

/* ------------------------------------------------------------------ options */
static struct {
  const char *out; int ch;
  float clean, process, reflections, gateMix, gateThr, gateAtk, gateRel; int ambience;
  float dereverb, strength, room, tail, presence;
  float bands[6]; float width, gainDb; int limit;
} opt = { NULL, 1, 0, 1, 0.3f, 0, 0.3f, 20, 300, 0, 0, 1.5f, 0.8f, 0.3f, 0, {1,1,1,1,1,1}, 1, 0, 1 };
static const float BAND_HZ[6] = { 100, 250, 600, 1500, 4000, 10000 };

static void parse(int argc, char **argv) {
  for (int i = 1; i + 1 < argc; i += 2) {
    const char *k = argv[i], *v = argv[i + 1];
    if (!strcmp(k, "--out")) opt.out = v;
    else if (!strcmp(k, "--channels")) opt.ch = atoi(v) == 2 ? 2 : 1;
    else if (!strcmp(k, "--clean")) opt.clean = atof(v);
    else if (!strcmp(k, "--focus")) opt.ambience = !strcmp(v, "ambience");
    else if (!strcmp(k, "--process")) opt.process = atof(v);
    else if (!strcmp(k, "--reflections")) opt.reflections = atof(v);
    else if (!strcmp(k, "--gate-mix")) opt.gateMix = atof(v);
    else if (!strcmp(k, "--gate-threshold")) opt.gateThr = atof(v);
    else if (!strcmp(k, "--gate-attack")) opt.gateAtk = atof(v);
    else if (!strcmp(k, "--gate-release")) opt.gateRel = atof(v);
    else if (!strcmp(k, "--dereverb")) opt.dereverb = atof(v);
    else if (!strcmp(k, "--strength")) opt.strength = atof(v);
    else if (!strcmp(k, "--room")) opt.room = atof(v);
    else if (!strcmp(k, "--tail")) opt.tail = atof(v);
    else if (!strcmp(k, "--presence")) opt.presence = atof(v);
    else if (!strcmp(k, "--width")) opt.width = atof(v);
    else if (!strcmp(k, "--gain")) opt.gainDb = atof(v);
    else if (!strcmp(k, "--limit")) opt.limit = atoi(v);
    else if (!strcmp(k, "--bands")) sscanf(v, "%f,%f,%f,%f,%f,%f", &opt.bands[0], &opt.bands[1], &opt.bands[2], &opt.bands[3], &opt.bands[4], &opt.bands[5]);
  }
#define CL(x, a, b) x = (x < a ? a : x > b ? b : x)
  CL(opt.clean, 0, 1); CL(opt.process, 0, 1); CL(opt.reflections, 0, 1); CL(opt.gateMix, 0, 1); CL(opt.gateThr, 0, 1);
  CL(opt.gateAtk, 1, 1000); CL(opt.gateRel, 5, 3000); CL(opt.dereverb, 0, 1); CL(opt.strength, 0.5f, 3); CL(opt.room, 0.1f, 4);
  CL(opt.tail, 0, 1); CL(opt.presence, 0, 1); CL(opt.width, 0, 1.5f); CL(opt.gainDb, -24, 24);
  for (int i = 0; i < 6; i++) CL(opt.bands[i], 0, 1.5f);
}

/* ------------------------------------------------------------------ FFT (radix-2, in place) */
static float cosT[N / 2], sinT[N / 2];
static int rev[N];
static void fft_init(void) {
  for (int i = 0; i < N / 2; i++) { cosT[i] = cosf(2 * M_PI * i / N); sinT[i] = -sinf(2 * M_PI * i / N); }
  int bits = 0; while ((1 << bits) < N) bits++;
  for (int i = 0; i < N; i++) { int r = 0; for (int b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b); rev[i] = r; }
}
static void fft(float *re, float *im, int inverse) {
  for (int i = 0; i < N; i++) if (i < rev[i]) { float t = re[i]; re[i] = re[rev[i]]; re[rev[i]] = t; t = im[i]; im[i] = im[rev[i]]; im[rev[i]] = t; }
  for (int len = 2; len <= N; len <<= 1) {
    int step = N / len;
    for (int i = 0; i < N; i += len)
      for (int j = 0; j < len / 2; j++) {
        float wr = cosT[j * step], wi = inverse ? -sinT[j * step] : sinT[j * step];
        float ur = re[i + j], ui = im[i + j];
        float vr = re[i + j + len / 2] * wr - im[i + j + len / 2] * wi, vi = re[i + j + len / 2] * wi + im[i + j + len / 2] * wr;
        re[i + j] = ur + vr; im[i + j] = ui + vi; re[i + j + len / 2] = ur - vr; im[i + j + len / 2] = ui - vi;
      }
  }
  if (inverse) for (int i = 0; i < N; i++) { re[i] /= N; im[i] /= N; }
}

/* ------------------------------------------------------------------ WAV out */
static FILE *wav; static long long framesOut = 0;
static void wav_header(long long frames) {
  int ch = opt.ch; unsigned data = (unsigned)(frames * ch * 4);
  unsigned char h[58]; memset(h, 0, sizeof h);
#define W32(o, v) do { unsigned _v = (unsigned)(v); h[o] = _v; h[o+1] = _v >> 8; h[o+2] = _v >> 16; h[o+3] = _v >> 24; } while (0)
#define W16(o, v) do { h[o] = (v) & 255; h[o+1] = ((v) >> 8) & 255; } while (0)
  memcpy(h, "RIFF", 4); W32(4, 50 + data); memcpy(h + 8, "WAVE", 4); memcpy(h + 12, "fmt ", 4); W32(16, 18);
  W16(20, 3); W16(22, ch); W32(24, RATE); W32(28, RATE * ch * 4); W16(32, ch * 4); W16(34, 32); W16(36, 0);
  memcpy(h + 38, "fact", 4); W32(42, 4); W32(46, (unsigned)frames); memcpy(h + 50, "data", 4); W32(54, data);
  fseek(wav, 0, SEEK_SET); fwrite(h, 1, 58, wav);
}

/* ------------------------------------------------------------------ state */
static float win[N];
static DenoiseState *rn;
/* Input history (aligned to the STFT), per channel + the RNNoise-cleaned mono signal. */
static float *xs[MAXCH], *ds; static long long histLen = 0, histCap = 0, histBase = 0; /* absolute index of xs[..][0] */
static float ola[MAXCH][N];
static float Gs[BINS], Gd[BINS], Psm[BINS];
static float *lateHist; static int lateFrames, lateIdx = 0;
static float bandW[BINS];
static float gateEnv = 1, lastVad = 1, tailEnv = 1, vadSm = 1, tailness = 0;
static float limGain = 1;
static int rnDelay = 0;

static void hist_push(const float *x, int n) {
  if (histLen + n > histCap) {
    long long ncap = (histLen + n) * 2 + 8192;
    for (int c = 0; c < opt.ch; c++) xs[c] = realloc(xs[c], ncap * sizeof(float));
    ds = realloc(ds, ncap * sizeof(float));
    histCap = ncap;
  }
  for (int i = 0; i < n; i++) {
    for (int c = 0; c < opt.ch; c++) xs[c][histLen + i] = x ? x[i * opt.ch + c] : 0;
    ds[histLen + i] = 0;
  }
  histLen += n;
}
static void hist_drop(long long upto) { /* drop samples before absolute index upto */
  long long k = upto - histBase;
  if (k <= 0) return;
  for (int c = 0; c < opt.ch; c++) memmove(xs[c], xs[c] + k, (histLen - k) * sizeof(float));
  memmove(ds, ds + k, (histLen - k) * sizeof(float));
  histLen -= k; histBase = upto;
}

static float bandWeight(float hz) {
  if (hz <= BAND_HZ[0]) return opt.bands[0];
  if (hz >= BAND_HZ[5]) return opt.bands[5];
  for (int i = 0; i < 5; i++) if (hz < BAND_HZ[i + 1]) {
    float t = (log2f(hz) - log2f(BAND_HZ[i])) / (log2f(BAND_HZ[i + 1]) - log2f(BAND_HZ[i]));
    return opt.bands[i] + (opt.bands[i + 1] - opt.bands[i]) * t;
  }
  return 1;
}

/* Output side: samples [pos, pos+n) of the processed signal; only 0 <= index < totalIn is written. */
static long long totalIn = 0;
static void emit(long long pos, float *L, float *R, int n) {
  float g = powf(10, opt.gainDb / 20);
  float rel = expf(-1.0f / (0.05f * RATE)), ceilv = 0.891f; /* -1 dBFS */
  for (int i = 0; i < n; i++) {
    long long idx = pos + i;
    if (idx < 0 || idx >= totalIn) continue;
    float l = L[i] * g, r = R ? R[i] * g : 0;
    if (R && opt.width != 1) { float m = (l + r) * 0.5f, s = (l - r) * 0.5f * opt.width; l = m + s; r = m - s; }
    if (opt.limit) {
      float pk = fabsf(l); if (R && fabsf(r) > pk) pk = fabsf(r);
      float want = pk * limGain > ceilv ? ceilv / pk : 1;
      limGain = want < limGain ? want : limGain * rel + (1 - rel) * want; /* instant attack, smooth release */
      if (limGain > 1) limGain = 1;
      l *= limGain; r *= limGain;
    }
    float fr[2] = { l, r };
    fwrite(fr, sizeof(float), opt.ch, wav);
    framesOut++;
  }
}

/* One STFT frame starting at absolute sample index pos. */
static void frame(long long pos) {
  static float re[MAXCH + 2][N], im[MAXCH + 2][N];
  long long o = pos - histBase;
  int C = opt.ch;
  /* channels + mono mix (index C) + cleaned mono (index C+1) */
  for (int i = 0; i < N; i++) {
    float m = 0;
    for (int c = 0; c < C; c++) { float v = xs[c][o + i]; re[c][i] = v * win[i]; im[c][i] = 0; m += v; }
    re[C][i] = (m / C) * win[i]; im[C][i] = 0;
    re[C + 1][i] = ds[o + i] * win[i]; im[C + 1][i] = 0;
  }
  for (int c = 0; c < C + 2; c++) if (c <= C || opt.clean > 0) fft(re[c], im[c], 0);

  float relC = expf(-(float)H / (RATE * (0.005f + 0.5f * opt.reflections * opt.reflections)));
  float relD = expf(-(float)H / (RATE * (0.001f + 0.4f * opt.tail * opt.tail)));
  float delta = 3 * logf(10) / opt.room;
  float decay = expf(-2 * delta * (lateFrames * (float)H / RATE));
  /* gate follows the voice detector */
  if (opt.clean > 0 && opt.gateMix > 0 && !opt.ambience) {
    float target = lastVad < opt.gateThr ? 1 - opt.gateMix : 1;
    float tc = target < gateEnv ? opt.gateAtk : opt.gateRel;
    float k = expf(-(float)H / (RATE * tc / 1000));
    gateEnv = target + (gateEnv - target) * k;
  }
  /* dereverb tail gate: between words, what remains is mostly reverb */
  if (opt.dereverb > 0) {
    float depth = powf(10, -(6 + 18 * opt.dereverb * (opt.strength > 1.5f ? 1.5f : opt.strength) / 1.5f) / 20);
    float target = 1 - tailness * (1 - depth);
    float tc = target < tailEnv ? 0.03f + 0.5f * opt.tail : 0.004f;
    float kk = expf(-(float)H / (RATE * tc));
    tailEnv = target + (tailEnv - target) * kk;
  }
  float presBoost = 1;
  if (opt.dereverb > 0 && opt.presence > 0) {
    /* how much dereverb took out of the 1.5–5 kHz presence region last frame */
    float s = 0; int n = 0;
    for (int k = (int)(1500.0f * N / RATE); k <= (int)(5000.0f * N / RATE); k++) { s += Gd[k]; n++; }
    presBoost = 1 + opt.presence * (1 - s / n) * 0.8f;
  }
  if (opt.dereverb > 0) {
    /* statistical late-reverb model: what's left now of the sound from ~50 ms ago */
    static float graw[BINS];
    float pNow = 0, pPred = 0;
    for (int k = 0; k < BINS; k++) {
      float px = re[C][k] * re[C][k] + im[C][k] * im[C][k];
      Psm[k] = PSM_A * Psm[k] + (1 - PSM_A) * px;
      float late = decay * lateHist[lateIdx * BINS + k] * opt.strength;
      float g = 1 - late / (Psm[k] + 1e-12f);
      graw[k] = g < FLOOR_P ? FLOOR_P : g;
      if (k > 4 && k < BINS * 0.5f) { pNow += Psm[k]; pPred += decay * lateHist[lateIdx * BINS + k]; }
      lateHist[lateIdx * BINS + k] = Psm[k];
    }
    for (int k = 0; k < BINS; k++) {
      /* smooth across neighbouring bins (less "musical noise"), then hold per the tail setting */
      float g = (graw[k > 0 ? k - 1 : k] + 2 * graw[k] + graw[k < BINS - 1 ? k + 1 : k]) * 0.25f;
      g = sqrtf(g);
      Gd[k] = g >= Gd[k] ? g : g + (Gd[k] - g) * relD;
    }
    lateIdx = (lateIdx + 1) % lateFrames;
    /* a frame whose power is no more than the reverb model predicts is a decaying tail */
    tailness = pNow <= pPred * 1.6f ? 1 : pNow > pPred * 4 ? 0 : (pPred * 4 - pNow) / (pPred * 2.4f);
  }
  for (int k = 0; k < BINS; k++) {
    float hz = (float)k * RATE / N;
    float bw = bandW[k];
    float G = 1;
    float px = re[C][k] * re[C][k] + im[C][k] * im[C][k];
    if (opt.clean > 0) {
      float pd = re[C + 1][k] * re[C + 1][k] + im[C + 1][k] * im[C + 1][k];
      float g = sqrtf(pd / (px + 1e-12f)); if (g > 1) g = 1;
      Gs[k] = g > Gs[k] * relC ? g : Gs[k] * relC;
      float a = opt.clean * opt.process * bw; if (a > 1) a = 1;
      G *= opt.ambience ? 1 - a * Gs[k] : 1 - a * (1 - Gs[k]);
    }
    if (opt.dereverb > 0) {
      float a = opt.dereverb * bw; if (a > 1) a = 1;
      G *= 1 - a * (1 - Gd[k]);
      if (hz > 1500 && hz < 5000) G *= presBoost;
    }
    G *= gateEnv * tailEnv;
    for (int c = 0; c < C; c++) { re[c][k] *= G; im[c][k] *= G; if (k > 0 && k < N / 2) { re[c][N - k] = re[c][k]; im[c][N - k] = -im[c][k]; } }
  }
  for (int c = 0; c < C; c++) {
    fft(re[c], im[c], 1);
    for (int i = 0; i < N; i++) ola[c][i] += re[c][i] * win[i] / 1.5f; /* Hann² at 75% overlap sums to 1.5 */
  }
  /* the first H samples of the overlap-add buffer are complete */
  emit(pos, ola[0], C > 1 ? ola[1] : NULL, H);
  for (int c = 0; c < C; c++) { memmove(ola[c], ola[c] + H, (N - H) * sizeof(float)); memset(ola[c] + N - H, 0, H * sizeof(float)); }
}

int main(int argc, char **argv) {
  parse(argc, argv);
  if (!opt.out) { fprintf(stderr, "missing --out\n"); return 2; }
  wav = fopen(opt.out, "wb");
  if (!wav) { fprintf(stderr, "can't write %s\n", opt.out); return 1; }
  wav_header(0);
  fft_init();
  for (int i = 0; i < N; i++) win[i] = 0.5f - 0.5f * cosf(2 * M_PI * i / N);
  for (int k = 0; k < BINS; k++) { bandW[k] = bandWeight((float)k * RATE / N); Gs[k] = Gd[k] = 1; Psm[k] = 0; }
  lateFrames = (int)(0.05f * RATE / H + 0.5f); if (lateFrames < 1) lateFrames = 1;
  lateHist = calloc((size_t)lateFrames * BINS, sizeof(float));
  /* RNNoise also gives the voice detector the gates use, so it runs whenever either process is on */
  if (opt.clean > 0 || opt.dereverb > 0) { rn = rnnoise_create(NULL); rnDelay = RN; }

  /* History holds input samples by absolute index, starting at -N (zeros) so the first frames
     can reach back before sample 0. ds holds RNNoise's cleaned mono signal, realigned to its input. */
  histBase = -N;
  hist_push(NULL, N);
  static float in[RN * MAXCH], mono[RN], den[RN];
  long long fed = 0, lastP = 0, pos = -(N - H);
  int eof = 0, padLeft = 0;
  for (;;) {
    size_t got = 0;
    if (!eof) {
      got = fread(in, sizeof(float) * opt.ch, RN, stdin);
      if (got < RN) { memset(in + got * opt.ch, 0, (RN - got) * opt.ch * sizeof(float)); eof = 1; padLeft = rnDelay + 2 * N; }
      totalIn += got;
    } else if (padLeft > 0) {
      memset(in, 0, sizeof in); padLeft -= RN;
    } else break;
    long long t0 = fed;
    for (int i = 0; i < RN; i++) { float m = 0; for (int c = 0; c < opt.ch; c++) m += in[i * opt.ch + c]; mono[i] = m / opt.ch * 32768.0f; }
    hist_push(in, RN);
    fed += RN;
    if (rn) {
      lastVad = rnnoise_process_frame(rn, den, mono);
      /* RNNoise output lags its input by one frame */
      for (int i = 0; i < RN; i++) { long long idx = t0 - rnDelay + i; if (idx >= histBase) ds[idx - histBase] = den[i] / 32768.0f; }
    }
    long long ready = fed - rnDelay; /* history is complete (x and d) below this index */
    while (pos + N <= ready) {
      frame(pos);
      pos += H;
      if (pos - histBase > 8 * N) hist_drop(pos - 2 * N);
    }
    if (fed - lastP >= RATE) { printf("P %lld\n", totalIn); fflush(stdout); lastP = fed; }
  }
  wav_header(framesOut);
  fclose(wav);
  printf("DONE %lld\n", framesOut);
  return 0;
}
