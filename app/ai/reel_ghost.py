"""ProtoArt Reel: isolate or remove a sound you describe in words ("dog barking", "keyboard typing", "music"), with Meta's
SAM-Audio run on this Mac's graphics chip by mlx-audio (the idea of AudioGhost AI, made for Apple silicon).

Runs in Reel's own Python environment for it (made when the person presses GET SOUND SEPARATION). JSON lines:

  {"cmd": "separate", "src": "/…/fxsrc-x.wav", "from": 12.0, "to": 95.5, "prompt": "dog barking",
   "model": "mlx-community/sam-audio-small-fp16", "quality": "fast" | "best",
   "target": "/…/out-sound.wav", "residual": "/…/out-rest.wav"}
      -> {"type": "progress", "f": 0..1, "msg": "…"} … {"type": "done", "seconds": …, "peak_gb": …}
  {"cmd": "quit"}

  --setup <model> <test.wav>: loads the model (downloading it and the T5 text encoder the first time) and separates
  two seconds as a check. Everything else runs with the network off.
"""
import json
import os
import struct
import sys

OUT_RATE = 48000
models = {}


def send(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def load(name):
    if name not in models:
        models.clear()  # one model in memory at a time
        send({"type": "progress", "f": 0.02, "msg": "Loading the separation model…"})
        from mlx_audio.sts import SAMAudio
        models[name] = SAMAudio.from_pretrained(name)
    return models[name]


def read_wav_range(path, t0, t1):
    """Mono float32 samples of [t0, t1) seconds from a PCM / float WAV, read straight from disk (not the whole file)."""
    import numpy as np
    with open(path, "rb") as f:
        head = f.read(12)
        if head[:4] != b"RIFF" or head[8:12] != b"WAVE":
            raise ValueError("Not a WAV file")
        fmt = None
        while True:
            h = f.read(8)
            if len(h) < 8:
                raise ValueError("No sound in the file")
            cid, size = h[:4], struct.unpack("<I", h[4:])[0]
            if cid == b"fmt ":
                b = f.read(size)
                code, ch, rate = struct.unpack("<HHI", b[:8])
                bits = struct.unpack("<H", b[14:16])[0]
                if code == 0xFFFE and size >= 26:
                    code = struct.unpack("<H", b[24:26])[0]
                fmt = (code, ch, rate, bits)
            elif cid == b"data":
                start = f.tell()
                break
            else:
                f.seek(size + (size & 1), 1)
    code, ch, rate, bits = fmt
    dtype = {(3, 32): "<f4", (1, 16): "<i2", (1, 32): "<i4"}.get((code, bits))
    if not dtype:
        raise ValueError(f"Unsupported WAV ({code}, {bits} bit)")
    frame = ch * bits // 8
    total = (os.path.getsize(path) - start) // frame if size in (0, 0xFFFFFFFF) else size // frame
    a, b = max(0, int(t0 * rate)), min(total, int(t1 * rate))
    if b <= a:
        raise ValueError("That part of the clip has no sound")
    mm = np.memmap(path, dtype=dtype, mode="r", offset=start + a * frame, shape=((b - a) * ch,))
    x = np.asarray(mm, dtype=np.float32).reshape(-1, ch).mean(axis=1)
    if dtype == "<i2":
        x /= 32768.0
    elif dtype == "<i4":
        x /= 2147483648.0
    return x, rate


def resample(x, src, dst):
    if src == dst:
        return x
    from math import gcd
    from scipy.signal import resample_poly
    g = gcd(int(src), int(dst))
    return resample_poly(x, int(dst) // g, int(src) // g).astype("float32")


def write_wav(path, x, rate=OUT_RATE):
    """32-bit float mono WAV (full quality), written to a temporary name then moved into place."""
    import numpy as np
    x = np.clip(np.asarray(x, dtype=np.float32).reshape(-1), -1.0, 1.0)
    data = x.astype("<f4").tobytes()
    head = b"RIFF" + struct.pack("<I", 36 + len(data)) + b"WAVEfmt " + struct.pack("<IHHIIHH", 16, 3, 1, rate, rate * 4, 4, 32) + b"data" + struct.pack("<I", len(data))
    tmp = path + ".part"
    with open(tmp, "wb") as f:
        f.write(head)
        f.write(data)
    os.replace(tmp, path)


class Progress:
    """Stands in for tqdm inside SAM-Audio's chunk loop, so each finished chunk moves Reel's bar."""

    def __init__(self, it=None, total=None, **_kw):
        self.it = it
        self.n = total if total is not None else (len(it) if hasattr(it, "__len__") else None)

    def __iter__(self):
        for i, v in enumerate(self.it):
            if self.n:
                send({"type": "progress", "f": 0.1 + 0.85 * i / self.n, "msg": f"Separating… part {i + 1} of {self.n}"})
            yield v

    def update(self, *_a):
        pass

    def close(self):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *_a):
        return False


def separate(req):
    import mlx.core as mx
    import numpy as np
    name = str(req.get("model") or "mlx-community/sam-audio-small-fp16")
    prompt = " ".join(str(req.get("prompt") or "").split())[:200]
    if not prompt:
        raise ValueError("Describe the sound first (like “dog barking” or “keyboard typing”).")
    for k in ("target", "residual"):
        if not str(req.get(k) or "").endswith(".wav"):
            raise ValueError("Bad output file.")
    model = load(name)
    import mlx_audio.sts.models.sam_audio.model as samm
    samm.tqdm = Progress  # progress per chunk instead of a text bar
    send({"type": "progress", "f": 0.06, "msg": "Reading the sound…"})
    x, rate = read_wav_range(str(req["src"]), float(req.get("from") or 0), float(req.get("to") or 0))
    sr = model.sample_rate
    y = resample(x, rate, sr)
    best = req.get("quality") == "best"
    # euler 16 steps: faster than real time on M-series; midpoint 32: studio quality (about 4x slower)
    ode = {"method": "midpoint", "step_size": 2 / 32} if best else {"method": "euler", "step_size": 2 / 32}
    send({"type": "progress", "f": 0.1, "msg": "Separating…"})
    result = model.separate_long(mx.array(y[None, None, :]), [prompt], chunk_seconds=10.0, overlap_seconds=3.0,
                                 ode_opt=ode, ode_decode_chunk_size=50, seed=42, verbose=False)
    send({"type": "progress", "f": 0.96, "msg": "Saving…"})
    tgt = np.array(result.target[0], dtype=np.float32).reshape(-1)
    res = np.array(result.residual[0], dtype=np.float32).reshape(-1)
    n = len(y)  # same length as what went in, so it lines up with the clip
    fit = lambda a: np.pad(a, (0, max(0, n - len(a))))[:n]
    write_wav(req["target"], resample(fit(tgt), sr, OUT_RATE))
    write_wav(req["residual"], resample(fit(res), sr, OUT_RATE))
    mx.clear_cache()
    return {"seconds": n / sr, "peak_gb": float(result.peak_memory or 0)}


def setup(name, test_out):
    import mlx.core as mx
    import numpy as np
    model = load(name)
    sr = model.sample_rate
    t = np.arange(int(2 * sr)) / sr
    x = (0.3 * np.sin(2 * np.pi * 440 * t) + 0.05 * np.random.default_rng(1).standard_normal(len(t))).astype("float32")
    r = model.separate(mx.array(x[None, None, :]), ["a beeping tone"], ode_opt={"method": "euler", "step_size": 2 / 8})
    y = np.array(r.target[0], dtype=np.float32).reshape(-1)
    if y.size < sr or not np.isfinite(y).all():
        raise RuntimeError("The test separation came out empty.")
    write_wav(test_out, resample(y, sr, OUT_RATE))
    send({"type": "ready", "sample_rate": sr, "peak_gb": float(r.peak_memory or 0)})


def serve():
    for line in sys.stdin:
        try:
            req = json.loads(line)
        except ValueError:
            continue
        if req.get("cmd") == "quit":
            break
        try:
            if req.get("cmd") == "separate":
                send({"type": "done", **separate(req)})
            else:
                send({"type": "error", "msg": "unknown command"})
        except Exception as e:  # noqa: BLE001
            send({"type": "error", "msg": f"{type(e).__name__}: {e}"})


if __name__ == "__main__":
    if len(sys.argv) >= 4 and sys.argv[1] == "--setup":
        try:
            setup(sys.argv[2], sys.argv[3])
        except Exception as e:  # noqa: BLE001
            send({"type": "error", "msg": f"{type(e).__name__}: {e}"})
            sys.exit(1)
    else:
        serve()
