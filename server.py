"""Local image upscaler: web UI + API. Run with `python server.py`."""

from __future__ import annotations

import io
import re
import subprocess
import sys
import tempfile
import threading
import time
import uuid
import webbrowser
import zipfile
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from urllib.parse import quote

import torch
import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from PIL import Image, ImageOps
from starlette.background import BackgroundTask

import engine
from catalog import MODELS, MODELS_BY_ID

ROOT = Path(__file__).resolve().parent
OUTPUTS = ROOT / "outputs"
OUTPUTS.mkdir(exist_ok=True)
HOST, PORT = "127.0.0.1", 8765
MAX_IMAGES = 8  # originals kept in memory; batches upload one at a time, just before each runs
MIN_SCALE, MAX_SCALE = 1.0, 8.0
WEBP_MAX = 16383
BATCH_NAME = re.compile(r"^batch-[\d_-]+$")
FORMATS = {"png": "image/png", "jpg": "image/jpeg", "webp": "image/webp"}

Image.MAX_IMAGE_PIXELS = None  # local files only; outputs are legitimately huge

app = FastAPI(title="Upscaler")
executor = ThreadPoolExecutor(max_workers=1)  # one GPU, one job at a time


@dataclass
class Job:
    id: str
    model_id: str
    scale: float
    name: str
    folder: Path
    status: str = "queued"  # queued, downloading, loading, upscaling, saving, done, error, cancelled
    progress: float = 0.0
    detail: str = ""
    error: str | None = None
    created: float = field(default_factory=time.time)
    started: float | None = None
    stage_started: float | None = None
    finished: float | None = None
    output_path: Path | None = None
    output_size: tuple[int, int] | None = None
    cancel: threading.Event = field(default_factory=threading.Event)

    def stage(self, status: str, detail: str = "") -> None:
        self.status, self.detail, self.progress = status, detail, 0.0
        self.stage_started = time.time()

    def public(self) -> dict:
        now = time.time()
        eta = None
        if self.status == "upscaling" and self.progress > 0.02:
            spent = now - self.stage_started
            eta = spent / self.progress * (1 - self.progress)
        return {
            "id": self.id,
            "model_id": self.model_id,
            "scale": self.scale,
            "status": self.status,
            "progress": round(self.progress, 4),
            "detail": self.detail,
            "error": self.error,
            "eta": eta,
            "elapsed": ((self.finished or now) - self.started) if self.started else 0,
            "output": {
                "width": self.output_size[0], "height": self.output_size[1],
                "file": self.output_path.name,
            } if self.output_size else None,
        }


images: dict[str, dict] = {}
jobs: dict[str, Job] = {}


# ---------------------------------------------------------------- api

@app.get("/api/system")
def system():
    return engine.device_info()


@app.get("/api/models")
def list_models():
    return [{**m, "downloaded": engine.is_downloaded(m)} for m in MODELS]


@app.post("/api/images")
async def upload_image(file: UploadFile = File(...)):
    data = await file.read()
    try:
        img = Image.open(io.BytesIO(data))
        img.load()
        img = ImageOps.exif_transpose(img)
    except Exception:
        raise HTTPException(400, "That file isn't an image this app can read.")
    image_id = uuid.uuid4().hex[:12]
    images[image_id] = {"image": img, "name": Path(file.filename or "image").stem}
    while len(images) > MAX_IMAGES:
        images.pop(next(iter(images)))
    return {"id": image_id, "width": img.width, "height": img.height, "alpha": engine.has_alpha(img)}


@app.get("/api/images/{image_id}/preview")
def image_preview(image_id: str):
    """PNG of the original, for formats browsers can't display (e.g. TIFF)."""
    entry = images.get(image_id)
    if entry is None:
        raise HTTPException(404, "Unknown image.")
    img = entry["image"]
    buf = io.BytesIO()
    img.convert("RGBA" if engine.has_alpha(img) else "RGB").save(buf, "PNG", compress_level=1)
    return Response(buf.getvalue(), media_type="image/png")


@app.post("/api/upscale")
def start_upscale(image_id: str = Form(...), model_id: str = Form(...), scale: float = Form(...),
                  batch: str | None = Form(None)):
    entry = images.get(image_id)
    if entry is None:
        raise HTTPException(404, "The image expired. Please add it again.")
    model = MODELS_BY_ID.get(model_id)
    if model is None:
        raise HTTPException(404, "Unknown model.")
    if not MIN_SCALE <= scale <= MAX_SCALE:
        raise HTTPException(400, f"Scale must be between {MIN_SCALE:g}x and {MAX_SCALE:g}x.")
    folder = _batch_dir(batch) if batch else OUTPUTS
    job = Job(id=uuid.uuid4().hex[:12], model_id=model_id, scale=round(scale, 2),
              name=entry["name"], folder=folder)
    jobs[job.id] = job
    executor.submit(_run, job, entry["image"])
    return job.public()


@app.post("/api/batches")
def create_batch():
    name = datetime.now().strftime("batch-%Y-%m-%d_%H-%M-%S")
    path, n = OUTPUTS / name, 2
    while path.exists():
        path, n = OUTPUTS / f"{name}-{n}", n + 1
    path.mkdir()
    return {"name": path.name}


@app.get("/api/batches/{name}/zip")
def batch_zip(name: str, format: str = "png"):
    """Every finished image in the batch, as one ZIP in the chosen format."""
    folder = _batch_dir(name)
    fmt = _check_format(format)
    files = sorted(folder.glob("*.png"))
    if not files:
        raise HTTPException(404, "This batch has no finished images yet.")
    tmp = tempfile.NamedTemporaryFile(suffix=".zip", delete=False)
    tmp.close()
    # PNG/JPG/WebP are already compressed, so store rather than deflate.
    with zipfile.ZipFile(tmp.name, "w", zipfile.ZIP_STORED) as zf:
        for f in files:
            if fmt == "png":
                zf.write(f, f.name)
            else:
                img = Image.open(f)
                if fmt == "webp" and max(img.size) > WEBP_MAX:
                    fmt_for_file, data = "png", f.read_bytes()
                else:
                    fmt_for_file, data = fmt, _encode(img, fmt)
                zf.writestr(f"{f.stem}.{fmt_for_file}", data)
    return FileResponse(tmp.name, media_type="application/zip", filename=f"{name}.zip",
                        background=BackgroundTask(Path(tmp.name).unlink, missing_ok=True))


@app.post("/api/batches/{name}/reveal")
def reveal_batch(name: str):
    folder = _batch_dir(name)
    if sys.platform == "win32":
        subprocess.Popen(["explorer", str(folder)])
    return {"ok": True}


def _batch_dir(name: str) -> Path:
    if not BATCH_NAME.match(name) or not (OUTPUTS / name).is_dir():
        raise HTTPException(404, "Unknown batch.")
    return OUTPUTS / name


@app.get("/api/jobs/{job_id}")
def job_status(job_id: str):
    return _job(job_id).public()


@app.post("/api/jobs/{job_id}/cancel")
def cancel_job(job_id: str):
    job = _job(job_id)
    job.cancel.set()
    if job.status == "queued":
        job.status = "cancelled"
    return job.public()


@app.get("/api/jobs/{job_id}/result")
def job_result(job_id: str, format: str = "png", download: bool = False):
    job = _job(job_id)
    if job.status != "done" or not job.output_path or not job.output_path.exists():
        raise HTTPException(409, "Result isn't ready.")
    fmt = _check_format(format)
    name = f"{job.output_path.stem}.{fmt}"
    disposition = f"{'attachment' if download else 'inline'}; filename*=UTF-8''{quote(name)}"
    headers = {"Content-Disposition": disposition, "Cache-Control": "max-age=31536000, immutable"}

    if fmt == "png":
        return FileResponse(job.output_path, media_type="image/png", headers=headers)

    img = Image.open(job.output_path)
    if fmt == "webp" and max(img.size) > WEBP_MAX:
        raise HTTPException(400, f"WebP can't exceed {WEBP_MAX}px on a side. Use PNG or JPG.")
    return Response(_encode(img, fmt), media_type=FORMATS[fmt], headers=headers)


def _check_format(fmt: str) -> str:
    fmt = fmt.lower()
    if fmt not in FORMATS:
        raise HTTPException(400, "Format must be png, jpg or webp.")
    return fmt


def _encode(img: Image.Image, fmt: str) -> bytes:
    buf = io.BytesIO()
    if fmt == "jpg":
        if img.mode == "RGBA":  # JPEG has no transparency: flatten onto white
            bg = Image.new("RGB", img.size, "white")
            bg.paste(img, mask=img.getchannel("A"))
            img = bg
        img.convert("RGB").save(buf, "JPEG", quality=95, subsampling=0, optimize=True)
    else:
        img.save(buf, "WEBP", quality=95, method=4)
    return buf.getvalue()


@app.post("/api/jobs/{job_id}/reveal")
def reveal(job_id: str):
    job = _job(job_id)
    if not job.output_path:
        raise HTTPException(409, "Result isn't ready.")
    if sys.platform == "win32":
        subprocess.Popen(["explorer", "/select,", str(job.output_path)])
    return {"ok": True}


def _job(job_id: str) -> Job:
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(404, "Unknown job.")
    return job


# ---------------------------------------------------------------- worker

def _run(job: Job, img: Image.Image) -> None:
    if job.cancel.is_set():
        job.status = "cancelled"
        return
    model = MODELS_BY_ID[job.model_id]
    job.started = time.time()
    try:
        if not engine.is_downloaded(model):
            job.stage("downloading")

            def on_download(done: int, total: int) -> None:
                job.progress = done / total
                job.detail = f"{done / 1e6:.0f} of {total / 1e6:.0f} MB"

            engine.download(model, on_download, job.cancel)

        if model["file"]:
            job.stage("loading")
            engine.load(model)

        job.stage("upscaling")

        def on_progress(fraction: float, step: str) -> None:
            job.progress, job.detail = fraction, step

        out = engine.upscale(img, model, job.scale, on_progress, job.cancel)

        job.stage("saving")
        path = _output_path(job.folder, job.name, model["id"], job.scale)
        out.save(path, compress_level=3)
        job.output_path, job.output_size = path, out.size
        job.status = "done"
    except engine.Cancelled:
        job.status = "cancelled"
    except torch.cuda.OutOfMemoryError:
        job.status, job.error = "error", "The GPU ran out of memory. Try a smaller image or a lighter model."
    except Exception as e:  # surface anything else to the UI rather than dying silently
        job.status, job.error = "error", f"{type(e).__name__}: {e}"
    finally:
        job.finished = time.time()


def _output_path(folder: Path, name: str, model_id: str, scale: float) -> Path:
    safe = "".join(c if c.isalnum() or c in "-_ " else "_" for c in name).strip() or "image"
    stem = f"{safe}_{model_id}_x{scale:g}"
    path, n = folder / f"{stem}.png", 2
    while path.exists():
        path, n = folder / f"{stem}_{n}.png", n + 1
    return path


app.mount("/", StaticFiles(directory=ROOT / "static", html=True), name="static")


if __name__ == "__main__":
    url = f"http://{HOST}:{PORT}"
    print(f"\n  Upscaler running at {url}  (Ctrl+C to stop)\n")
    if "--no-browser" not in sys.argv:
        threading.Timer(1.5, webbrowser.open, args=(url,)).start()
    uvicorn.run(app, host=HOST, port=PORT, log_level="warning")
