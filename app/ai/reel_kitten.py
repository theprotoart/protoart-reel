"""ProtoArt Reel: natural speech from text with KittenTTS 2 (KittenML, Apache 2.0), on this Mac's graphics chip (MLX).

Runs in Reel's own Python environment for it (made when the person presses GET KITTEN VOICES). Speaks JSON lines:

  {"cmd": "voices"}                                  -> {"type": "voices", "voices": [...]}
  {"cmd": "say", "text": ..., "voice": "Bruno",      -> {"type": "done", "seconds": ...}
   "out": "/path/speech.wav", "preset": "stable"}
  {"cmd": "say", ..., "reference": "/path/me.wav",   (a cloned voice: the recording and what it says)
   "reference_text": "what is said in it"}
  {"cmd": "quit"}

Run with --setup <test.wav> once after installing: it loads the model (downloading it into the Hugging Face cache the
first time), speaks one short line as a check and prints the voices. Everything else runs with the network off.
"""
import json
import os
import sys

REPO = "KittenML/kitten-tts-2"
OUT_RATE = 48000
model = None


def send(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def load():
    global model
    if model is None:
        send({"type": "progress", "msg": "Loading the voice model…"})
        from kittenml import KittenTTS
        model = KittenTTS(REPO, backend="mlx", cache_dir=os.environ.get("HF_HUB_CACHE") or None)
    return model


def write_wav(audio, rate, path):
    """24 kHz from the model -> 48 kHz, 24-bit (what the rest of Reel expects), written atomically."""
    import numpy as np
    import soundfile as sf
    from scipy.signal import resample_poly
    a = np.asarray(audio, dtype=np.float32).reshape(-1)
    if rate != OUT_RATE:
        from math import gcd
        g = gcd(OUT_RATE, int(rate))
        a = resample_poly(a, OUT_RATE // g, int(rate) // g).astype(np.float32)
    peak = float(np.max(np.abs(a))) if a.size else 0.0
    if peak > 0.99:
        a = a * (0.99 / peak)
    tmp = path + ".part"
    sf.write(tmp, a, OUT_RATE, subtype="PCM_24", format="WAV")
    os.replace(tmp, path)
    return a.size / OUT_RATE


def say(req):
    m = load()
    text = str(req.get("text") or "").strip()
    if not text:
        raise ValueError("Nothing to say.")
    out = str(req.get("out") or "")
    if not out.endswith(".wav"):
        raise ValueError("Bad output file.")
    kw = {"preset": "expressive" if req.get("preset") == "expressive" else "stable",
          "normalize": bool(req.get("normalize", True))}
    if isinstance(req.get("seed"), int):
        kw["advanced"] = {"seed": int(req["seed"])}
    ref = req.get("reference")
    if ref:
        if not os.path.isfile(ref):
            raise ValueError("That saved voice's recording is missing.")
        ref_text = str(req.get("reference_text") or "").strip()
        if not ref_text:
            raise ValueError("That saved voice has no transcript; save it again.")
        kw["reference"] = ref
        kw["reference_text"] = ref_text
    else:
        kw["voice"] = str(req.get("voice") or "Bruno")
    send({"type": "progress", "msg": "Speaking…"})
    audio = m.generate(text, **kw)
    return write_wav(audio, m.sample_rate, out)


def setup(test_out):
    m = load()
    audio = m.generate("Hello. This is Kitten, speaking from ProtoArt Reel.", voice="Bruno")
    seconds = write_wav(audio, m.sample_rate, test_out)
    if seconds < 0.5:
        raise RuntimeError("The test line came out empty.")
    send({"type": "ready", "voices": list(m.available_voices), "seconds": seconds})


def serve():
    for line in sys.stdin:
        try:
            req = json.loads(line)
        except ValueError:
            continue
        cmd = req.get("cmd")
        if cmd == "quit":
            break
        try:
            if cmd == "voices":
                send({"type": "voices", "voices": list(load().available_voices)})
            elif cmd == "say":
                send({"type": "done", "seconds": say(req)})
            else:
                send({"type": "error", "msg": f"unknown command {cmd!r}"})
        except Exception as e:  # noqa: BLE001
            send({"type": "error", "msg": f"{type(e).__name__}: {e}"})


if __name__ == "__main__":
    if len(sys.argv) >= 3 and sys.argv[1] == "--setup":
        try:
            setup(sys.argv[2])
        except Exception as e:  # noqa: BLE001
            send({"type": "error", "msg": f"{type(e).__name__}: {e}"})
            sys.exit(1)
    else:
        serve()
