#!/usr/bin/env python3
"""DeepMT image generator — Stable Diffusion (sd-turbo) on Apple MPS.
Serves endpoints on loopback only:
    GET  /health    -> {"ok": true, "loaded": bool}
    POST /generate  -> {prompt, seed?, size?}  => PNG bytes (text2img)
    POST /edit      -> {prompt, image, seed?, strength?, size?}  => PNG bytes (img2img)
The first /generate call downloads the model (stabilityai/sd-turbo, ~1.2 GB).
Uses 2 sampling steps and guidance 0 (the turbo recipe) => a few seconds/image.
512x512 is generated natively (sd-turbo's sweet spot); 1024x1024 is a 512
render upscaled with Lanczos — clean and still fast (~2s).

Image *edits* preserve the source's aspect ratio: the image is padded to the
square the pipeline wants, rendered, then cropped back to the original
orientation — it is never stretched, and it also optionally outpaints a little
hinge. `size` is the longest edge in px.
"""
import base64
import io
import os

from flask import Flask, Response, jsonify, request

import torch
from diffusers import AutoPipelineForImage2Image
from PIL import Image

PORT = int(os.environ.get("IMG_PORT", "7861"))
MODEL = os.environ.get("IMG_MODEL", "stabilityai/sd-turbo")
STEPS = int(os.environ.get("IMG_STEPS", "2"))
SIZE = int(os.environ.get("IMG_SIZE", "512"))

ALLOWED_SIZES = (512, 1024)

app = Flask(__name__)
pipe = None


def load():
    global pipe
    if pipe is None:
        print(f"[imagegen] loading {MODEL} (first run downloads weights)\u2026", flush=True)
        p = AutoPipelineForImage2Image.from_pretrained(
            MODEL,
            torch_dtype=torch.float16,
            safety_checker=None,
            requires_safety_checker=False,
        )
        p.to("mps")
        pipe = p
        print("[imagegen] model ready", flush=True)


def _generator(seed):
    if seed is None:
        return None
    return torch.Generator(device="mps").manual_seed(int(seed) % (2 ** 32))


def _pn(data):
    return Response(data, mimetype="image/png")


def _png(img):
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)
    return _pn(buf.read())


def _target_dims(w, h, size):
    """Longest-edge target preserving aspect ratio, snapped to multiples of 8."""
    if size <= 0:
        size = SIZE
    if w <= 0 or h <= 0:
        return size, size
    if w >= h:
        ow = size
        oh = int(round(h * size / w / 8.0) * 8)
    else:
        oh = size
        ow = int(round(w * size / h / 8.0) * 8)
    ow = max(8, min(ow, 2048))
    oh = max(8, min(oh, 2048))
    return ow, oh


def _pad_square(img, size=512, fill=(127, 122, 118)):
    """Letterbox a source image onto a square canvas, preserving its aspect."""
    if img.size == (size, size):
        return img
    scale = min(size / img.width, size / img.height)
    nw = max(1, int(round(img.width * scale)))
    nh = max(1, int(round(img.height * scale)))
    resized = img.resize((nw, nh), Image.Resampling.LANCZOS)
    canvas = Image.new("RGB", (size, size), fill)
    canvas.paste(resized, ((size - nw) // 2, (size - nh) // 2))
    return canvas


def _crop_to_aspect(img, out_w, out_h):
    """Center-crop a (square) result to the target aspect ratio, then resize."""
    if img.size == (out_w, out_h):
        return img
    ratio = out_w / out_h
    w, h = img.size
    if w / h > ratio:
        new_w = int(h * ratio)
        new_h = h
    else:
        new_w = w
        new_h = int(w / ratio)
    left = (w - new_w) // 2
    top = (h - new_h) // 2
    return img.crop((left, top, left + new_w, top + new_h)).resize(
        (out_w, out_h), Image.Resampling.LANCZOS
    )


@app.get("/health")
def health():
    return jsonify(ok=True, loaded=pipe is not None)


@app.post("/generate")
def generate():
    load()
    data = request.get_json(silent=True) or {}
    prompt = str(data.get("prompt") or "").strip()
    if not prompt:
        return jsonify(error="prompt required"), 400
    px = int(data.get("size") or SIZE)
    if px not in ALLOWED_SIZES:
        return jsonify(error=f"size must be one of {ALLOWED_SIZES}"), 400
    # strength 1.0 = full denoise from scratch, i.e. text-to-image semantics on
    # the single loaded img2img pipeline (keeps one model in memory).
    base = Image.new("RGB", (SIZE, SIZE), (128, 128, 128))
    image = pipe(
        prompt,
        image=base,
        num_inference_steps=STEPS,
        guidance_scale=0.0,
        strength=1.0,
        generator=_generator(data.get("seed")),
    ).images[0]
    if px != image.size[0]:
        image = image.resize((px, px), Image.Resampling.LANCZOS)
    return _png(image)


@app.post("/edit")
def edit():
    load()
    data = request.get_json(silent=True) or {}
    prompt = str(data.get("prompt") or "").strip()
    if not prompt:
        return jsonify(error="prompt required"), 400
    raw = data.get("image")
    if not raw:
        return jsonify(error="image required (base64 PNG)"), 400
    px = int(data.get("size") or SIZE)
    if px not in ALLOWED_SIZES:
        return jsonify(error=f"size must be one of {ALLOWED_SIZES}"), 400
    try:
        base = Image.open(io.BytesIO(base64.b64decode(raw))).convert("RGB")
    except Exception:
        return jsonify(error="image must be valid base64 PNG/JPEG"), 400
    w0, h0 = base.size
    # Out orientation preserves the source aspect (never stretched).
    out_w, out_h = _target_dims(w0, h0, px)
    # The pipeline renders a square; letterbox the source so the edit keeps
    # the full composition (the model works the margins like an outpainting).
    square = _pad_square(base, SIZE)
    strength = float(data.get("strength") or 0.45)
    strength = max(0.15, min(0.95, strength))
    # With a 2-step recipe, low strengths round the denoise loop to zero steps
    # (empty latents). Scale the step count so at least one step always runs.
    steps = max(STEPS, min(8, int(1.0 / strength) + 1))
    image = pipe(
        prompt,
        image=square,
        num_inference_steps=steps,
        guidance_scale=0.0,
        strength=strength,
        generator=_generator(data.get("seed")),
    ).images[0]
    # Crop the square back to the source's orientation and scale to target.
    image = _crop_to_aspect(image, out_w, out_h)
    return _png(image)


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=PORT, threaded=False)
