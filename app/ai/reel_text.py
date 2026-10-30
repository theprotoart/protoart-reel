"""ProtoArt Reel prompt writer: a small local language model (Qwen2.5, from Protoart Studio's
prompt enhancer) turns a video's title and description into an image prompt for a thumbnail.
JSON lines: {"cmd": "suggest", "model": <snapshot folder>, "title", "description", "style", "mode"}
-> {"type": "done", "prompt": ...}."""
import json
import re
import sys
import threading
import traceback

_lock = threading.Lock()


def send(msg):
    with _lock:
        sys.stdout.write(json.dumps(msg) + "\n")
        sys.stdout.flush()


SYSTEM = (
    "You write one prompt for a text-to-image model that will paint the background art of a YouTube "
    "thumbnail. Describe a single striking scene that captures the video's topic: the main subject, "
    "setting, lighting, colours, composition and art style, in 2 to 3 sentences. Leave clear open space "
    "on one side for a big title that will be added later. Never ask for text, letters, words, logos or "
    "watermarks in the image. Always write in English. Output only the prompt.")
EXAMPLE_IN = "Title: How to speed up your Mac\nStyle: bold high-contrast YouTube thumbnail style"
EXAMPLE_OUT = ("A sleek silver laptop bursting forward out of a swirl of glowing blue speed lines, sparks and "
               "motion blur trailing behind it, on a deep navy background. Dramatic rim lighting and saturated "
               "colours, the laptop on the right third with clean empty space on the left, bold high-contrast "
               "YouTube thumbnail style.")


class Writer:
    def __init__(self):
        self.path = None
        self.tok = None
        self.model = None
        self.device = "cpu"

    def load(self, path):
        if self.path == path and self.model is not None:
            return
        import torch
        from transformers import AutoModelForCausalLM, AutoTokenizer
        send({"type": "status", "msg": "Loading the prompt writer…"})
        self.device = "mps" if torch.backends.mps.is_available() else "cpu"
        dtype = torch.float16 if self.device == "mps" else torch.float32
        self.tok = AutoTokenizer.from_pretrained(path, local_files_only=True)
        self.model = AutoModelForCausalLM.from_pretrained(path, torch_dtype=dtype, local_files_only=True).to(self.device).eval()
        self.path = path

    def suggest(self, a):
        import torch
        self.load(a["model"])
        topic = f"Title: {a.get('title') or 'Untitled video'}"
        if a.get("description"):
            topic += f"\nAbout: {a['description'][:600]}"
        topic += f"\nStyle: {a.get('style') or 'bold YouTube thumbnail'}"
        if a.get("mode") == "img2img":
            topic += "\n(The image will be painted over a frame of the video, so keep the scene compatible with a screenshot.)"
        msgs = [{"role": "system", "content": SYSTEM}, {"role": "user", "content": EXAMPLE_IN},
                {"role": "assistant", "content": EXAMPLE_OUT}, {"role": "user", "content": topic}]
        text = self.tok.apply_chat_template(msgs, tokenize=False, add_generation_prompt=True)
        inputs = self.tok(text, return_tensors="pt").to(self.device)
        start = inputs["input_ids"].shape[1]
        send({"type": "status", "msg": "Writing a prompt…"})
        with torch.no_grad():
            out = self.model.generate(**inputs, max_new_tokens=150, do_sample=True, temperature=0.7, top_p=0.9,
                                      repetition_penalty=1.1, pad_token_id=self.tok.eos_token_id)
        result = self.tok.decode(out[0][start:], skip_special_tokens=True)
        return clean(result)


def clean(t):
    t = "".join(ch for ch in t if ord(ch) < 0x250 or 0x2000 <= ord(ch) <= 0x206F)
    t = " ".join(t.replace("\n", " ").split())
    t = re.sub(r"^(prompt|description|output)\s*:\s*", "", t, flags=re.IGNORECASE).strip().strip('"').strip()
    return t


def main():
    w = Writer()
    for line in sys.stdin:
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        if msg.get("cmd") == "quit":
            break
        try:
            if msg.get("cmd") == "suggest":
                send({"type": "done", "prompt": w.suggest(msg)})
        except Exception as e:
            traceback.print_exc()
            send({"type": "error", "msg": f"{type(e).__name__}: {e}"})


if __name__ == "__main__":
    main()
