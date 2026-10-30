"""ProtoArt Reel thumbnail engine: ERNIE-Image Turbo on Apple's GPU (MLX, via mflux), using
Protoart Studio's installed fast engine and downloaded model. JSON lines on stdin/stdout:

  in : {"cmd": "load", "path": <model snapshot folder>, "low_ram": bool}
       {"cmd": "generate", "prompt", "negative_prompt", "width", "height", "steps", "seed", "out",
        "image": <start image path or null>, "strength": <0..1 or null>}
       {"cmd": "cancel"} | {"cmd": "quit"}
  out: {"type": "status"|"progress"|"loaded"|"done"|"error", ...}
"""
import gc
import json
import sys
import threading
import time
import traceback

_lock = threading.Lock()
cancel = threading.Event()


def send(msg):
    with _lock:
        sys.stdout.write(json.dumps(msg) + "\n")
        sys.stdout.flush()


class Cancelled(Exception):
    pass


class Hooks:
    def __init__(self, w):
        self.w = w

    def call_before_loop(self, seed, prompt, latents, config, **kw):
        if self.w.low_ram and self.w.model is not None:
            import mlx.core as mx
            self.w.model.text_encoder = None  # prompt is encoded; give the picture model the memory
            gc.collect()
            mx.clear_cache()

    def call_in_loop(self, t, seed, prompt, latents, config, time_steps):
        if cancel.is_set():
            raise Cancelled()
        steps = self.w.steps or config.num_inference_steps
        done = (t - getattr(config, "init_time_step", 0)) + 1
        send({"type": "progress", "step": min(done, steps), "steps": steps})
        if done < steps:  # the last step is the picture itself
            try:
                import mlx.core as mx
                from reel_preview import latent_preview
                png = latent_preview(latents.astype(mx.float32), *self.w.size)
                if png:
                    send({"type": "preview", "png": png, "step": done, "steps": steps})
            except Exception:
                pass

    def call_after_loop(self, seed, prompt, latents, config):
        pass


class Worker:
    def __init__(self):
        self.model = None
        self.path = None
        self.loras = []
        self.low_ram = False
        self.steps = 0
        self.size = (1024, 1024)

    def load(self, path, low_ram=False, force=False, loras=None):
        loras = [tuple(x) for x in (loras or [])]
        if self.model is not None and self.path == path and self.loras == loras and not force:
            return
        import mlx.core as mx
        from mflux.models.common.config import ModelConfig
        from mflux.models.ernie_image import ErnieImage
        self.model = None
        gc.collect()
        mx.clear_cache()
        send({"type": "status", "msg": "Loading ERNIE-Image Turbo…"})
        t0 = time.time()
        lora_kw = dict(lora_paths=[p for p, _ in loras] or None, lora_scales=[float(s) for _, s in loras] or None)
        self.model = ErnieImage(model_path=path, model_config=ModelConfig.ernie_image_turbo(), **lora_kw)
        self.path = path
        self.loras = loras
        self.low_ram = bool(low_ram)
        if self.low_ram:
            mx.set_cache_limit(1 << 30)
        self.model.callbacks.register(Hooks(self))
        send({"type": "status", "msg": f"ERNIE ready ({time.time() - t0:.0f}s)"})

    def generate(self, a):
        import mlx.core as mx
        m = self.model
        if m is None:
            raise RuntimeError("model not loaded")
        neg = a.get("negative_prompt") or None
        key = (a["prompt"], neg, 1.0)
        if m.text_encoder is None and key not in m.prompt_cache:
            self.load(self.path, self.low_ram, force=True, loras=self.loras)
            m = self.model
        self.steps = int(a["steps"])
        kw = dict(seed=int(a["seed"]), prompt=a["prompt"], num_inference_steps=self.steps,
                  width=int(a["width"]), height=int(a["height"]), guidance=1.0, negative_prompt=neg)
        if a.get("image"):
            kw["image_path"] = a["image"]
            kw["image_strength"] = float(a.get("strength") or 0.6)
        self.size = (int(a["width"]), int(a["height"]))
        send({"type": "status", "msg": "Painting…"})
        res = m.generate_image(**kw)
        res.image.save(a["out"])
        if len(m.prompt_cache) > 16:
            m.prompt_cache.clear()
        gc.collect()
        mx.clear_cache()


def main():
    w = Worker()
    jobs, cv = [], threading.Condition()

    def reader():
        for line in sys.stdin:
            try:
                msg = json.loads(line)
            except ValueError:
                continue
            if msg.get("cmd") == "cancel":
                cancel.set()
                continue
            with cv:
                jobs.append(msg)
                cv.notify()
        with cv:
            jobs.append({"cmd": "quit"})
            cv.notify()

    threading.Thread(target=reader, daemon=True).start()
    while True:
        with cv:
            while not jobs:
                cv.wait()
            msg = jobs.pop(0)
        cmd = msg.get("cmd")
        if cmd == "quit":
            break
        cancel.clear()
        try:
            if cmd == "load":
                w.load(msg["path"], msg.get("low_ram"), loras=msg.get("loras"))
                send({"type": "loaded"})
            elif cmd == "generate":
                w.generate(msg)
                send({"type": "done", "path": msg["out"]})
        except Cancelled:
            send({"type": "error", "cancelled": True, "msg": "Stopped"})
        except Exception as e:
            traceback.print_exc()
            send({"type": "error", "msg": f"{type(e).__name__}: {e}"})


if __name__ == "__main__":
    main()
