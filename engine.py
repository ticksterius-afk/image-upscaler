"""Model download, loading and tiled inference."""

from __future__ import annotations

import math
import threading
import urllib.request
from pathlib import Path
from typing import Callable

import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image
from spandrel import ImageModelDescriptor, ModelLoader

MODELS_DIR = Path(__file__).resolve().parent / "models"
MODELS_DIR.mkdir(exist_ok=True)

DEVICE = torch.device("cuda" if torch.cuda.is_available() else "cpu")
# fp16 only pays off on GPUs with fast half-precision (Volta / RTX and newer).
# Pascal cards like the GTX 10-series run fp16 far slower than fp32.
USE_HALF = DEVICE.type == "cuda" and torch.cuda.get_device_capability()[0] >= 7

Progress = Callable[[int, int], None]


class Cancelled(Exception):
    pass


def device_info() -> dict:
    if DEVICE.type == "cuda":
        props = torch.cuda.get_device_properties(0)
        return {
            "device": "cuda",
            "name": props.name.replace("NVIDIA ", ""),
            "vram_gb": round(props.total_memory / 1024**3, 1),
            "precision": "fp16" if USE_HALF else "fp32",
            "torch": torch.__version__,
        }
    return {"device": "cpu", "name": "CPU", "vram_gb": 0, "precision": "fp32", "torch": torch.__version__}


# ---------------------------------------------------------------- weights

def weights_path(model: dict) -> Path | None:
    return MODELS_DIR / model["file"] if model["file"] else None


def is_downloaded(model: dict) -> bool:
    path = weights_path(model)
    return path is None or path.exists()


def download(model: dict, on_progress: Progress, cancel: threading.Event) -> None:
    dest = weights_path(model)
    if dest is None or dest.exists():
        return
    tmp = dest.with_name(dest.name + ".part")
    req = urllib.request.Request(model["url"], headers={"User-Agent": "LocalUpscaler/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp, open(tmp, "wb") as f:
            total = int(resp.headers.get("Content-Length") or 0) or model["bytes"]
            done = 0
            while chunk := resp.read(1 << 20):
                if cancel.is_set():
                    raise Cancelled
                f.write(chunk)
                done += len(chunk)
                on_progress(done, total)
        tmp.replace(dest)
    finally:
        tmp.unlink(missing_ok=True)


# ---------------------------------------------------------------- loading

_loaded: dict = {"id": None, "desc": None}


def load(model: dict) -> ImageModelDescriptor:
    if _loaded["id"] == model["id"]:
        return _loaded["desc"]
    unload()
    path = weights_path(model)
    try:
        desc = ModelLoader().load_from_file(path)
    except Exception:
        # A corrupt or truncated file should be re-downloaded next time.
        path.unlink(missing_ok=True)
        raise
    if not isinstance(desc, ImageModelDescriptor):
        raise ValueError(f"{model['name']} is not an image-to-image model")
    desc.to(DEVICE).eval()
    if USE_HALF and desc.supports_half:
        desc.half()
    _loaded.update(id=model["id"], desc=desc)
    return desc


def unload() -> None:
    _loaded.update(id=None, desc=None)
    if DEVICE.type == "cuda":
        torch.cuda.empty_cache()


# ---------------------------------------------------------------- inference

def has_alpha(img: Image.Image) -> bool:
    """True only if the image actually uses transparency, not just has an alpha channel."""
    if img.mode not in ("RGBA", "LA", "PA") and not (img.mode == "P" and "transparency" in img.info):
        return False
    return img.convert("RGBA").getchannel("A").getextrema()[0] < 255


def pass_targets(w: int, h: int, scale: float, native: int) -> list[tuple[int, int]]:
    """Sizes each model pass should end at. One pass when scale <= native;
    more when it's larger (e.g. 8x from a 4x model: 4x -> shrink to 2x -> 4x)."""
    targets = [(max(1, int(w * scale + 0.5)), max(1, int(h * scale + 0.5)))]
    while targets[-1][0] > w * native or targets[-1][1] > h * native:
        tw, th = targets[-1]
        targets.append((math.ceil(tw / native), math.ceil(th / native)))
    return targets[::-1]


def upscale(img: Image.Image, model: dict, scale: float,
            on_progress: Callable[[float, str], None], cancel: threading.Event) -> Image.Image:
    """on_progress receives (fraction 0-1, human-readable step)."""
    alpha = img.convert("RGBA").getchannel("A") if has_alpha(img) else None
    out = img.convert("RGB")
    w, h = out.size

    if model["file"] is None:
        target = pass_targets(w, h, scale, native=10**6)[-1]
        out = out.resize(target, Image.LANCZOS)
        on_progress(1.0, "")
    else:
        desc = load(model)
        targets = pass_targets(w, h, scale, desc.scale)
        # Weight progress by each pass's input size so the bar moves evenly.
        work = [w * h] + [tw * th for tw, th in targets[:-1]]
        total_work, done_before = sum(work), 0
        for i, target in enumerate(targets):
            def pass_progress(n: int, total: int, i=i, base=done_before) -> None:
                step = f"Tile {n} of {total}" if total > 1 else ""
                if len(targets) > 1:
                    step = " · ".join(filter(None, [f"Pass {i + 1} of {len(targets)}", step]))
                on_progress((base + work[i] * n / total) / total_work, step)
            out = _run_tiled(desc, out, model["tile"], pass_progress, cancel)
            if out.size != target:
                out = out.resize(target, Image.LANCZOS)
            done_before += work[i]
        target = targets[-1]

    if alpha is not None:
        out.putalpha(alpha.resize(target, Image.LANCZOS))
    return out


def _run_tiled(desc: ImageModelDescriptor, rgb: Image.Image, tile: int,
               on_progress: Progress, cancel: threading.Event) -> Image.Image:
    arr = np.asarray(rgb, dtype=np.float32) / 255.0
    src = torch.from_numpy(arr).permute(2, 0, 1).unsqueeze(0)
    while True:
        try:
            return _tiles(desc, src, tile, on_progress, cancel)
        except torch.cuda.OutOfMemoryError:
            torch.cuda.empty_cache()
            if tile <= 64:
                raise
            tile //= 2


def _tiles(desc: ImageModelDescriptor, src: torch.Tensor, tile: int,
           on_progress: Progress, cancel: threading.Event) -> Image.Image:
    _, _, h, w = src.shape
    s = desc.scale
    overlap = 16
    dtype = next(desc.model.parameters()).dtype
    out = np.empty((h * s, w * s, 3), dtype=np.uint8)

    # Split evenly so there are no thin slivers at the right/bottom edges.
    rows, cols = math.ceil(h / tile), math.ceil(w / tile)
    th, tw = math.ceil(h / rows), math.ceil(w / cols)
    total, done = rows * cols, 0

    for y0 in range(0, h, th):
        for x0 in range(0, w, tw):
            if cancel.is_set():
                raise Cancelled
            y1, x1 = min(y0 + th, h), min(x0 + tw, w)
            # Give each tile some surrounding context, then crop it away.
            ey0, ex0 = max(0, y0 - overlap), max(0, x0 - overlap)
            ey1, ex1 = min(h, y1 + overlap), min(w, x1 + overlap)
            patch = src[:, :, ey0:ey1, ex0:ex1]
            ph, pw = patch.shape[2:]
            pad_h, pad_w = _padding(desc, ph, pw)
            if pad_h or pad_w:
                patch = F.pad(patch, (0, pad_w, 0, pad_h), mode="replicate")

            cy, cx = (y0 - ey0) * s, (x0 - ex0) * s
            with torch.inference_mode():
                res = desc(patch.to(DEVICE, dtype))
                res = res[0, :, cy:cy + (y1 - y0) * s, cx:cx + (x1 - x0) * s]
                res = res.float().clamp_(0, 1).mul_(255).round_().byte()
            out[y0 * s:y1 * s, x0 * s:x1 * s] = res.permute(1, 2, 0).cpu().numpy()

            done += 1
            on_progress(done, total)

    return Image.fromarray(out)


def _padding(desc: ImageModelDescriptor, h: int, w: int) -> tuple[int, int]:
    req = desc.size_requirements
    mult = max(1, req.multiple_of)
    nh = max(req.minimum, math.ceil(h / mult) * mult)
    nw = max(req.minimum, math.ceil(w / mult) * mult)
    if req.square:
        nh = nw = max(nh, nw)
    return nh - h, nw - w
