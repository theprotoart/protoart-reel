"""ProtoArt Reel: word-for-word speech ("verbatim"), with nyra's CrisperWhisper 2.0 run on this Mac's graphics chip.
Ordinary speech recognition (Apple's included) is made to leave ums out; CrisperWhisper writes every one down, with
its timing to the word, so 💬 FILLER WORDS reads them off the transcript instead of guessing them by ear.

Runs in Reel's own Python environment for it (made when the person presses GET WORD-FOR-WORD SPEECH). JSON lines:

  {"cmd": "transcribe", "src": "/…/rec-mic.wav", "from": 0.0, "to": 753.0, "model": "large", "language": "en"}
      -> {"type": "progress", "f": 0..1, "msg": "…"} … {"type": "done", "words": [[start, end, "word"], …], "seconds": …}
  {"cmd": "quit"}

  --setup <model> : loads the model (downloading it the first time) and transcribes two seconds as a check.
  Everything else runs with the network off.
"""
import json
import os
import struct
import sys
import time

models = {}


def send(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def device():
    try:
        import torch
        if torch.backends.mps.is_available():
            return "mps"
    except Exception:
        pass
    return "cpu"


def load(size):
    if size not in models:
        models.clear()  # one model in memory at a time
        send({"type": "progress", "f": 0.02, "msg": "Loading the word-for-word speech model…"})
        from crisperwhisper import CrisperWhisperModel
        dev = device()
        try:
            models[size] = CrisperWhisperModel(size, backend="transformers", device=dev, compute_type="float16")
        except Exception:
            if dev == "cpu":
                raise
            # the graphics chip couldn't take it: the processor can (slower)
            models[size] = CrisperWhisperModel(size, backend="transformers", device="cpu", compute_type="float32")
    return models[size]


def read_wav_range(path, t0, t1):
    """Mono float32 samples of [t0, t1) seconds from a PCM / float WAV, read straight from disk."""
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
        raise ValueError("That part has no sound")
    mm = np.memmap(path, dtype=dtype, mode="r", offset=start + a * frame, shape=((b - a) * ch,))
    x = np.asarray(mm, dtype=np.float32).reshape(-1, ch).mean(axis=1)
    if dtype == "<i2":
        x /= 32768.0
    elif dtype == "<i4":
        x /= 2147483648.0
    return x, rate


def to16k(x, rate):
    if rate == 16000:
        return x
    import numpy as np
    try:
        import soxr
        return soxr.resample(x, rate, 16000).astype(np.float32)
    except Exception:
        n = int(len(x) * 16000 / rate)
        return np.interp(np.linspace(0, len(x) - 1, n), np.arange(len(x)), x).astype(np.float32)


def transcribe(size, x, language, t0=0.0, on_progress=None):
    """Words [[start, end, word]] (seconds from t0) of 16 kHz samples, in pieces of about five minutes."""
    model = load(size)
    out = []
    piece = 16000 * 300
    n = max(1, -(-len(x) // piece))
    for i in range(n):
        a = i * piece
        # each piece runs 2 s into the next, and the words there are left to it
        seg = x[a:a + piece + 32000]
        if on_progress:
            on_progress(i / n)
        r = model.transcribe(seg, language=language, mode="verbatim", sr=16000, word_timestamps=True)
        for w in (r.words or []):
            if w.start is None or w.end is None:
                continue
            s = a / 16000 + float(w.start)
            if i + 1 < n and s >= (a + piece) / 16000:
                continue
            out.append([round(t0 + s, 3), round(t0 + a / 16000 + float(w.end), 3), str(w.word)])
    if on_progress:
        on_progress(1.0)
    return out


def main():
    if len(sys.argv) >= 3 and sys.argv[1] == "--setup":
        import numpy as np
        size = sys.argv[2]
        load(size)
        # two seconds of a hum, as a check that it runs at all
        t = np.arange(32000) / 16000.0
        x = (0.1 * np.sin(2 * np.pi * 110 * t)).astype(np.float32)
        transcribe(size, x, "en")
        send({"type": "ready", "device": device()})
        return
    for line in sys.stdin:
        try:
            msg = json.loads(line)
        except Exception:
            continue
        cmd = msg.get("cmd")
        if cmd == "quit":
            break
        if cmd != "transcribe":
            send({"type": "error", "msg": "Unknown command"})
            continue
        try:
            started = time.time()
            t0, t1 = float(msg.get("from", 0)), float(msg.get("to", 0))
            x, rate = read_wav_range(msg["src"], t0, t1)
            x = to16k(x, rate)
            secs = len(x) / 16000

            def prog(f):
                send({"type": "progress", "f": 0.05 + 0.95 * f, "msg": f"Writing down every word… {int(f * 100)}%"})

            words = transcribe(msg.get("model", "large"), x, msg.get("language", "en"), t0, prog)
            send({"type": "done", "words": words, "seconds": round(time.time() - started, 1), "audio": round(secs, 1)})
        except Exception as e:  # noqa: BLE001
            send({"type": "error", "msg": str(e)[:300]})


if __name__ == "__main__":
    main()
