# Upscaler

Local AI image upscaling with a before/after viewer. Runs on your GPU through PyTorch.

**Start:** double-click `start.bat`. The first run installs everything (about 2.5 GB), and after that it opens http://127.0.0.1:8765 in your browser.

1. Drop, paste (Ctrl+V) or browse for an image.
2. Pick a model. Each card lists pros, cons and what it's best for.
3. Choose 2×, 3×, 4×, or **Custom** for any factor from 1× to 8× (decimals work), then press **Upscale**.

Each model's weights download from its official release the first time you use it, into `models/`. Results are saved as PNG in `outputs/`, and you can download them as PNG, JPG or WebP.

**Custom factors:** below a model's native factor, the app runs the model once and shrinks the result to the exact size. Above it, the app runs the model more than once, so 8× with a 4× model takes two passes and is slower. 1× keeps the size and only cleans up noise and JPEG artifacts.

**Batch:** switch to the **Batch** tab, or drop several files at once. Every image gets the same model and factor. Results go to their own `outputs/batch-<date>` folder, and **Download as ZIP** exports them all as PNG, JPG or WebP. Cancel stops after the current image, and pressing Upscale again continues with the remaining ones. Click any finished row to compare it in the slider viewer.

**Viewer shortcuts:** scroll to zoom, drag to pan, drag the white handle to compare. `F` fits the image, `1` shows actual pixels, and `B` / `S` / `A` switch between Before, Split and After. `Ctrl+Enter` upscales and `Esc` cancels.

| File | Purpose |
|---|---|
| `catalog.py` | Model list with links, ratings, pros and cons |
| `engine.py` | Downloading, loading, tiled GPU inference |
| `server.py` | FastAPI server and job queue |
| `static/` | The web UI |
