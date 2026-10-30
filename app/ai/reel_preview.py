"""A rough live preview of a picture while it's being made, without the cost of decoding it.

The latents at each step already hold the picture's layout. Their three strongest directions
(a quick PCA over the channels) show the shapes and light of the picture, the way a painter's
underdrawing does: false colour, but the composition is there and sharpens with every step.
Returns a small PNG as base64, or None if the latents aren't in a shape we understand.
"""
import base64
import io
import math


def _grid(n, width, height):
    """Rows, columns for n latent tokens of a width x height picture."""
    for div in (16, 8, 32):
        gh, gw = max(1, round(height / div)), max(1, round(width / div))
        if gh * gw == n:
            return gh, gw
    gw = max(1, round(math.sqrt(n * width / max(1, height))))
    gh = n // gw if gw else 0
    return (gh, gw) if gh * gw == n else None


def latent_preview(latents, width, height, max_side=160):
    try:
        import numpy as np
        from PIL import Image
        a = np.array(latents, dtype=np.float32)
        a = np.squeeze(a)
        if a.ndim == 3 and a.shape[0] <= 128 and a.shape[1] * a.shape[2] > a.shape[0]:   # C, H, W
            c, h, w = a.shape
            flat = a.reshape(c, h * w).T
        elif a.ndim == 2:                                                                   # tokens, D
            g = _grid(a.shape[0], width, height)
            if not g:
                return None
            h, w = g
            flat = a
        else:
            return None
        flat = flat - flat.mean(axis=0, keepdims=True)
        # top three components (SVD of a D x D covariance: cheap even for big pictures)
        cov = flat.T @ flat / max(1, flat.shape[0] - 1)
        vals, vecs = np.linalg.eigh(cov)
        comps = flat @ vecs[:, ::-1][:, :3]
        lo, hi = np.percentile(comps, 2, axis=0), np.percentile(comps, 98, axis=0)
        rgb = np.clip((comps - lo) / np.maximum(hi - lo, 1e-6), 0, 1)
        img = Image.fromarray((rgb.reshape(h, w, 3) * 255).astype("uint8"), "RGB")
        k = max_side / max(w, h)
        img = img.resize((max(1, round(w * k)), max(1, round(h * k))), Image.BILINEAR)
        buf = io.BytesIO()
        img.save(buf, "PNG", optimize=True)
        return base64.b64encode(buf.getvalue()).decode("ascii")
    except Exception:
        return None
