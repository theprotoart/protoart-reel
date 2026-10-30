"""ProtoArt Reel picture engine #2: FLUX.2 [klein] 4B (Black Forest Labs, Apache 2.0) on Apple's GPU
(MLX, via mflux), using Protoart Studio's installed fast engine and its 4-bit model. Built for 8 GB Macs
the way Studio does it:

  * the 4-bit copy (~4.4 GB) is used as is; LoRAs stay as small add-ons (not folded in, which would
    re-save touched layers at 8 bits and push an 8 GB Mac into swap);
  * on small Macs the prompt is encoded first and the text encoder (~2 GB) is then dropped so the
    picture model has the memory; encoded prompts are cached so 2-4 variations don't reload it;
  * starting from a picture uses klein's edit mode (reference picture + words), as Studio does;
  * 4 steps (the model is distilled for that), guidance 1, no negative prompt.

JSON lines on stdin/stdout:
  in : {"cmd": "load", "path": <model folder>, "low_ram": bool, "loras": [[path, scale], ...], "variant": "txt"|"edit"}
       {"cmd": "generate", "prompt", "width", "height", "steps", "seed", "out", "image"}
       {"cmd": "cancel"} | {"cmd": "quit"}
  out: {"type": "status"|"progress"|"loaded"|"done"|"prepared"|"error", ...}
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


def _klein(variant="txt"):
    """mflux's FLUX.2 klein class (txt2img or edit) and model config (import paths moved between versions)."""
    try:
        from mflux.models.flux2.variants import Flux2Klein, Flux2KleinEdit
    except ImportError:
        try:
            from mflux.models.flux2.variants.txt2img.flux2_klein import Flux2Klein
            from mflux.models.flux2.variants.edit.flux2_klein_edit import Flux2KleinEdit
        except ImportError as e:
            raise RuntimeError("Protoart Studio's fast engine is too old for FLUX.2 [klein]. Update Protoart Studio, then try again.") from e
    try:
        from mflux.models.common.config.model_config import ModelConfig
    except ImportError:
        from mflux.models.common.config import ModelConfig  # type: ignore
    return (Flux2KleinEdit if variant == "edit" else Flux2Klein), ModelConfig.flux2_klein_4b()


class Hooks:
    def __init__(self, w):
        self.w = w

    def call_before_loop(self, seed, prompt, latents, config, **kw):
        if self.w.low_ram and self.w.model is not None:
            import mlx.core as mx
            self.w.model.text_encoder = None  # prompt is encoded; give the picture model the memory
            gc.collect()
            mx.clear_cache()

    def call_in_loop(self, t, seed, prompt, latents, config, time_steps, **kw):
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

    def call_after_loop(self, seed, prompt, latents, config, **kw):
        pass


class Worker:
    def __init__(self):
        self.model = None
        self.path = None
        self.loras = []
        self.low_ram = False
        self.steps = 0
        self.size = (1024, 1024)
        self.cache = {}
        self.variant = "txt"

    def load(self, path, low_ram=False, force=False, loras=None, variant="txt"):
        loras = [tuple(x) for x in (loras or [])]
        if self.model is not None and self.path == path and self.loras == loras and self.variant == variant and not force:
            return
        import mlx.core as mx
        Klein, cfg = _klein(variant)
        self.model = None
        gc.collect()
        mx.clear_cache()
        send({"type": "status", "msg": "Loading FLUX.2 [klein]…"})
        t0 = time.time()
        kw = dict(model_path=path, model_config=cfg)
        if loras:
            kw.update(lora_paths=[p for p, _ in loras], lora_scales=[float(s) for _, s in loras], bake_lora=False)
        try:
            self.model = Klein(**kw)
        except TypeError:  # an mflux without bake_lora
            kw.pop("bake_lora", None)
            self.model = Klein(**kw)
        self.path, self.loras, self.low_ram, self.variant = path, loras, bool(low_ram), variant
        if self.low_ram:
            mx.set_cache_limit(1 << 30)
        # cache encoded prompts, so dropping the text encoder doesn't cost a reload per variation
        original = self.model._encode_prompt_pair
        cache = self.cache = {}

        def cached(*, prompt, negative_prompt, guidance):
            key = (prompt, negative_prompt, float(guidance or 1.0))
            if key in cache:
                return cache[key]
            res = original(prompt=prompt, negative_prompt=negative_prompt, guidance=guidance)
            mx.eval([x for x in res if x is not None])
            if len(cache) > 8:
                cache.clear()
            cache[key] = res
            return res

        self.model._encode_prompt_pair = cached
        self.model.callbacks.register(Hooks(self))
        send({"type": "status", "msg": f"FLUX ready ({time.time() - t0:.0f}s)"})

    def generate(self, a):
        import mlx.core as mx
        m = self.model
        if m is None:
            raise RuntimeError("model not loaded")
        key = (a["prompt"], " ", 1.0)
        if m.text_encoder is None and key not in self.cache:
            self.load(self.path, self.low_ram, force=True, loras=self.loras, variant=self.variant)
            m = self.model
        self.steps = int(a.get("steps") or 4)
        kw = dict(seed=int(a["seed"]), prompt=a["prompt"], num_inference_steps=self.steps,
                  width=int(a["width"]), height=int(a["height"]), guidance=1.0)
        if a.get("image"):
            if self.variant != "edit":
                raise RuntimeError("FLUX.2 needs its edit mode to start from a picture")
            kw["image_paths"] = [a["image"]]  # klein changes the picture as the words say
        self.size = (int(a["width"]), int(a["height"]))
        send({"type": "status", "msg": "Painting…"})
        res = m.generate_image(**kw)
        res.image.save(a["out"])
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
                w.load(msg["path"], msg.get("low_ram"), loras=msg.get("loras"), variant=msg.get("variant") or "txt")
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
