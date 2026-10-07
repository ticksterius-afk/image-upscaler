'use strict';

const $ = (s, root = document) => root.querySelector(s);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const store = {
  get(k, d) { try { return localStorage.getItem('upscaler.' + k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('upscaler.' + k, v); } catch { /* storage unavailable */ } },
};

const FILTERS = [['all', 'All'], ['photo', 'Photos'], ['art', 'Anime & art'], ['faithful', 'Faithful'], ['fast', 'Fast']];
const PRESETS = [2, 3, 4];
const MIN_SCALE = 1, MAX_SCALE = 8;
const ACTIVE = ['uploading', 'queued', 'downloading', 'loading', 'upscaling', 'saving', 'preview'];
const WEBP_MAX = 16383;
const BIG_OUTPUT_MP = 120;
const IMAGE_EXT = /\.(png|jpe?g|webp|bmp|gif|tiff?)$/i;

const state = {
  appMode: store.get('mode', 'single'),
  system: null,
  models: [],
  filter: 'all',
  modelId: store.get('model', 'realesrgan-x4plus'),
  scale: clamp(Number(store.get('scale', 4)) || 4, MIN_SCALE, MAX_SCALE),
  customOpen: false,
  fmt: store.get('fmt', 'png'),
  // single mode
  image: null,   // { id, file, name, bytes, width, height, alpha, url }
  runs: [],      // { id, modelId, scale, elapsed, width, height, file, url }
  runId: null,   // active run; null shows the original
  job: null,
  // batch mode
  batch: {
    items: [],   // see addBatchFiles()
    folder: null,
    running: false,
    cancel: false,
    current: null,
    run: null,   // { modelId, scale, started }
  },
};
state.customOpen = !PRESETS.includes(state.scale);
const view = { z: 1, tx: 0, ty: 0, fit: true, mode: 'split', split: 0.5 };

const icons = {
  check: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
  cloud: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 11v8M8.5 15.5 12 19l3.5-3.5"/><path d="M20 16.6A4.5 4.5 0 0 0 17.5 8h-1.3A7 7 0 1 0 4 14.9"/></svg>',
  clock: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  alert: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5v.01"/></svg>',
  compare: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M12 2v20"/></svg>',
  remove: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  image: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="1.6"/><path d="m21 15-4.5-4.5L7 20"/></svg>',
};

// ------------------------------------------------------------------ formatting

function fmtBytes(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + ' GB';
  if (n >= 1e6) return (n >= 1e7 ? Math.round(n / 1e6) : (n / 1e6).toFixed(1)) + ' MB';
  return Math.max(1, Math.round(n / 1e3)) + ' KB';
}
function fmtDuration(sec) {
  if (sec < 1) return 'under a second';
  if (sec < 10) return sec.toFixed(1) + ' s';
  if (sec < 90) return Math.round(sec) + ' s';
  const min = Math.round(sec / 60);
  return min < 90 ? min + ' min' : (sec / 3600).toFixed(1) + ' h';
}
const fmtMP = px => { const mp = px / 1e6; return (mp < 10 ? mp.toFixed(1) : Math.round(mp).toLocaleString()) + ' MP'; };
const fmtDims = (w, h) => `${w.toLocaleString()} × ${h.toLocaleString()}`;
const fmtScale = s => `${+Number(s).toFixed(2)}×`;
const outDims = (w, h, s) => [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))];
const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

// ------------------------------------------------------------------ api

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try { msg = (await res.json()).detail || msg; } catch { /* not json */ }
    throw new Error(msg);
  }
  return res.json();
}

async function uploadImage(file) {
  const fd = new FormData();
  fd.append('file', file, file.name || 'image.png');
  return api('/api/images', { method: 'POST', body: fd });
}

function startJob(imageId, batchFolder) {
  const fd = new FormData();
  fd.append('image_id', imageId);
  fd.append('model_id', state.modelId);
  fd.append('scale', state.scale);
  if (batchFolder) fd.append('batch', batchFolder);
  return api('/api/upscale', { method: 'POST', body: fd });
}

// ------------------------------------------------------------------ derived

const currentModel = () => state.models.find(m => m.id === state.modelId) || state.models[0];
const modelById = id => state.models.find(m => m.id === id);
const activeRun = () => state.runs.find(r => r.id === state.runId) || null;
const singleBusy = () => !!state.job && ACTIVE.includes(state.job.status);
const batchBusy = () => state.batch.running;
const isBatch = () => state.appMode === 'batch';

/** Input sizes of each model pass (mirrors engine.pass_targets on the server). */
function passInputs(w, h, scale, native) {
  if (!native) return [[w, h]];
  const targets = [outDims(w, h, scale)];
  while (targets.at(-1)[0] > w * native || targets.at(-1)[1] > h * native) {
    const [a, b] = targets.at(-1);
    targets.push([Math.ceil(a / native), Math.ceil(b / native)]);
  }
  targets.reverse();
  return [[w, h], ...targets.slice(0, -1)];
}
const passCount = (scale, native) => passInputs(1000, 1000, scale, native).length;

function estimateOne(m, w, h, scale) {
  if (m.sec_per_mp == null || !w) return 0;
  return passInputs(w, h, scale, m.native).reduce((t, [a, b]) => t + m.sec_per_mp * a * b / 1e6, 0);
}

/** Items the next batch run will process: unfinished ones, or everything if all are done. */
function batchQueue() {
  const items = state.batch.items;
  if (state.batch.running) return items.filter(i => i.status === 'waiting' || i === state.batch.current);
  const left = items.filter(i => i.status !== 'done');
  return left.length ? left : items;
}

function workload() {
  if (!isBatch()) return state.image ? [state.image] : [];
  return batchQueue().filter(i => i.width);
}

function estimate(m) {
  const items = workload();
  if (!items.length || m.sec_per_mp == null) return null;
  return items.reduce((t, i) => t + estimateOne(m, i.width, i.height, state.scale), 0) + (m.file ? 1.5 : 0);
}

// ------------------------------------------------------------------ rendering: shared panel

function renderAll() {
  const hasContent = isBatch() ? state.batch.items.length > 0 : !!state.image;
  document.body.classList.toggle('has-content', hasContent);
  for (const b of document.querySelectorAll('[data-appmode]')) b.setAttribute('aria-selected', b.dataset.appmode === state.appMode);
  $('#dropveil').textContent = isBatch() ? 'Drop to add to the batch' : 'Drop to replace the image';
  renderStep1();
  renderFilters();
  renderModels();
  renderScales();
  renderGo();
  renderResult();
  renderBatchBadge();
  if (isBatch()) {
    $('#empty').hidden = $('#viewer').hidden = $('#toolbar').hidden = true;
    $('#batchView').hidden = false;
    renderBatch();
  } else {
    $('#batchView').hidden = true;
    renderStage();
  }
}

function renderStep1() {
  const el = $('#imageInfo');
  $('#step1Title').textContent = isBatch() ? 'Images' : 'Image';

  if (isBatch()) {
    const items = state.batch.items;
    if (!items.length) {
      el.innerHTML = `<div class="image-empty">No images yet<button class="btn-sm" data-action="add-batch">Add images…</button></div>`;
      return;
    }
    const px = items.reduce((t, i) => t + (i.width ? i.width * i.height : 0), 0);
    const bytes = items.reduce((t, i) => t + i.bytes, 0);
    const thumb = items.find(i => i.thumb)?.thumb;
    el.innerHTML = `
      <div class="image-card">
        ${thumb ? `<img class="thumb" src="${esc(thumb)}" alt="">` : `<div class="thumb"></div>`}
        <div class="img-meta">
          <div class="img-name">${plural(items.length, 'image')}</div>
          <div class="img-sub">${px ? fmtMP(px) + ' total · ' : ''}${fmtBytes(bytes)}</div>
        </div>
        <button class="btn-sm" data-action="add-batch">Add more</button>
      </div>`;
    return;
  }

  const img = state.image;
  if (!img) {
    el.innerHTML = `<div class="image-empty">No image yet<button class="btn-sm" data-action="browse">Browse…</button></div>`;
    return;
  }
  const extras = [fmtDims(img.width, img.height), fmtBytes(img.bytes)];
  if (img.alpha) extras.push('transparent');
  el.innerHTML = `
    <div class="image-card">
      <img class="thumb" src="${esc(img.url)}" alt="">
      <div class="img-meta">
        <div class="img-name" title="${esc(img.name)}">${esc(img.name)}</div>
        <div class="img-sub">${extras.join(' · ')}</div>
      </div>
      <button class="btn-sm" data-action="browse">Replace</button>
    </div>`;
}

function renderFilters() {
  $('#filters').innerHTML = FILTERS.map(([id, label]) =>
    `<button class="chip" data-filter="${id}" aria-pressed="${state.filter === id}">${label}</button>`).join('');
}

function bars(v) {
  return `<span class="bars">${[1, 2, 3, 4, 5].map(i => `<i class="${i <= v ? 'on' : ''}"></i>`).join('')}</span>`;
}

function modelCard(m, focusable) {
  const selected = m.id === state.modelId;
  const est = estimate(m);
  const status = !m.file
    ? `<span class="state ready">${icons.check}Built in</span>`
    : m.downloaded
      ? `<span class="state ready">${icons.check}Ready</span>`
      : `<span class="state">${icons.cloud}${fmtBytes(m.bytes)} download on first use</span>`;
  const r = m.ratings;
  return `
    <div class="model" role="radio" data-id="${m.id}" aria-checked="${selected}" tabindex="${focusable ? 0 : -1}">
      <div class="m-head">
        <span class="radio"></span>
        <span class="m-name">${esc(m.name)}</span>
        ${m.recommended ? '<span class="badge">Recommended</span>' : ''}
        ${m.native === 2 ? '<span class="m-arch">2× native</span>' : ''}
      </div>
      <p class="m-tag">${esc(m.tagline)}</p>
      <div class="meters">
        <div class="meter" title="How quickly it runs">Speed${bars(r.speed)}</div>
        <div class="meter" title="How much crisp texture and sharpness it produces">Detail${bars(r.detail)}</div>
        <div class="meter" title="How faithful it stays to the original (low = invents more detail)">Fidelity${bars(r.fidelity)}</div>
      </div>
      <div class="m-foot">
        ${status}
        ${est != null ? `<span class="state" title="Estimated time on this computer">${icons.clock}≈ ${fmtDuration(est)}</span>` : ''}
      </div>
      <div class="m-more">
        <ul class="pc pros">${m.pros.map(p => `<li>${esc(p)}</li>`).join('')}</ul>
        <ul class="pc cons">${m.cons.map(c => `<li>${esc(c)}</li>`).join('')}</ul>
        <p class="best"><b>Best for:</b> ${esc(m.best_for)}</p>
        <p class="best"><b>Architecture:</b> ${esc(m.arch)}${m.bytes ? ` · ${fmtBytes(m.bytes)}` : ''}</p>
      </div>
    </div>`;
}

function renderModels() {
  const shown = state.models.filter(m => state.filter === 'all' || m.tags.includes(state.filter));
  const selectedShown = shown.some(m => m.id === state.modelId);
  $('#models').innerHTML = shown.map((m, i) =>
    modelCard(m, selectedShown ? m.id === state.modelId : i === 0)).join('');
  $('#modelCount').textContent = `${shown.length} of ${state.models.length}`;
}

function renderScales() {
  const custom = state.customOpen;
  $('#scales').innerHTML = PRESETS.map(s =>
    `<button data-scale="${s}" aria-pressed="${!custom && state.scale === s}" title="Make images ${s}× wider and taller">${s}×</button>`
  ).join('') + `<button data-scale="custom" aria-pressed="${custom}" title="Pick any factor from 1× to 8×">${custom ? fmtScale(state.scale) : 'Custom'}</button>`;

  $('#customRow').hidden = !custom;
  const input = $('#customScale');
  if (document.activeElement !== input) input.value = +state.scale.toFixed(2);

  const dims = $('#dims');
  if (isBatch()) {
    const items = state.batch.items.filter(i => i.width);
    if (!items.length) { dims.innerHTML = `<span>Every image becomes <b>${fmtScale(state.scale)}</b> larger</span>`; }
    else {
      const px = items.reduce((t, i) => { const [w, h] = outDims(i.width, i.height, state.scale); return t + w * h; }, 0);
      const biggest = Math.max(...items.map(i => i.width * i.height)) * state.scale ** 2 / 1e6;
      dims.innerHTML = `
        <span>Every image becomes <b>${fmtScale(state.scale)}</b> larger</span>
        <span class="${biggest > BIG_OUTPUT_MP ? 'warn' : ''}">${fmtMP(px)} out</span>`;
    }
  } else if (state.image) {
    const [ow, oh] = outDims(state.image.width, state.image.height, state.scale);
    const big = ow * oh / 1e6 > BIG_OUTPUT_MP;
    dims.innerHTML = `
      <span>${fmtDims(state.image.width, state.image.height)} → <b>${fmtDims(ow, oh)}</b></span>
      <span class="${big ? 'warn' : ''}" title="${big ? 'Very large output: slower and memory-hungry' : ''}">${fmtMP(ow * oh)}</span>`;
  } else {
    dims.innerHTML = '<span>Output size appears once you add an image</span>';
  }
  renderScaleNote();
}

function renderScaleNote() {
  const m = currentModel();
  const note = $('#scaleNote');
  let text = '', warn = false;
  if (m?.native) {
    const passes = passCount(state.scale, m.native);
    if (state.scale === 1) text = 'At 1× the size stays the same. The model only cleans up noise, blur and JPEG artifacts.';
    else if (passes > 1) {
      text = `${m.name} is a ${m.native}× model, so it runs ${passes} passes to reach ${fmtScale(state.scale)}. This takes noticeably longer.`;
      warn = passes > 2;
    }
  }
  note.hidden = !text;
  note.textContent = text;
  note.classList.toggle('warn', warn);
}

function setScale(s, { fromCustom = false } = {}) {
  s = Math.round(clamp(Number(s) || MIN_SCALE, MIN_SCALE, MAX_SCALE) * 100) / 100;
  state.scale = s;
  if (!fromCustom) state.customOpen = false;
  store.set('scale', s);
  renderScales();
  renderModels();
  renderGo();
  if (isBatch()) renderBatch();
}

function stageInfo(job) {
  const m = modelById(job.model_id);
  const pct = Math.round(job.progress * 100);
  switch (job.status) {
    case 'uploading': return { title: 'Sending image', detail: '', pct: null };
    case 'queued': return { title: 'Waiting to start', detail: '', pct: null };
    case 'downloading': return { title: `Downloading ${m.name}`, detail: `${job.detail} · first time only`, pct };
    case 'loading': return { title: 'Loading model', detail: state.system?.device === 'cuda' ? `onto ${state.system.name}` : '', pct: null };
    case 'upscaling': {
      const parts = [job.detail, job.eta != null && job.progress < 1 ? `about ${fmtDuration(job.eta)} left` : ''];
      return { title: `Upscaling with ${m.name}`, detail: parts.filter(Boolean).join(' · '), pct };
    }
    case 'saving': return { title: 'Saving result', detail: 'Writing a lossless PNG', pct: null };
    case 'preview': return { title: 'Preparing preview', detail: '', pct: null };
    default: return { title: '', detail: '', pct: null };
  }
}

function setGo({ label, est = '', fill = 0, disabled = false, running = false }) {
  const btn = $('#goBtn');
  btn.disabled = disabled;
  btn.classList.toggle('running', running);
  if (running) btn.setAttribute('aria-disabled', 'true'); else btn.removeAttribute('aria-disabled');
  $('#goLabel').textContent = label;
  $('#goEst').textContent = est;
  $('#goFill').style.width = fill + '%';
}

function renderGo() {
  const m = currentModel();
  const est = m && estimate(m);
  const estText = [est != null ? '≈ ' + fmtDuration(est) : '', m && !m.downloaded ? `+ ${fmtBytes(m.bytes)} download` : '']
    .filter(Boolean).join(' ');

  if (isBatch()) {
    const b = state.batch;
    $('#cancelBtn').hidden = !b.running;
    if (b.running) {
      const p = batchProgress();
      setGo({ label: `Image ${p.index} of ${p.total}`, est: Math.round(p.fraction * 100) + '%', fill: p.fraction * 100, running: true });
    } else if (singleBusy()) {
      setGo({ label: 'Single upscale in progress…', disabled: true });
    } else if (!b.items.length) {
      setGo({ label: 'Add images to start', disabled: true });
    } else {
      const done = b.items.filter(i => i.status === 'done').length;
      const queue = batchQueue().length;
      const label = done === 0 ? `Upscale ${plural(queue, 'image')}`
        : done === b.items.length ? `Upscale all ${queue} again`
          : `Upscale ${queue} remaining`;
      setGo({ label, est: estText });
    }
    document.title = b.running ? `(${Math.round(batchProgress().fraction * 100)}%) Upscaler` : 'Upscaler';
    return;
  }

  $('#cancelBtn').hidden = !singleBusy();
  if (singleBusy()) {
    const info = stageInfo(state.job);
    setGo({ label: info.title.split(' with ')[0], est: info.pct != null ? info.pct + '%' : '', fill: info.pct ?? 0, running: true });
    document.title = info.pct != null ? `(${info.pct}%) Upscaler` : 'Upscaler';
    return;
  }
  document.title = 'Upscaler';
  if (batchBusy()) setGo({ label: 'Batch in progress…', disabled: true });
  else if (!state.image || !m) setGo({ label: 'Add an image to start', disabled: true });
  else setGo({ label: `Upscale ${fmtScale(state.scale)}`, est: estText });
}

function renderResult() {
  let show = false, maxSide = 0;
  if (isBatch()) {
    const done = state.batch.items.filter(i => i.status === 'done');
    show = done.length > 0 && !!state.batch.folder;
    maxSide = Math.max(0, ...done.map(i => Math.max(i.output.width, i.output.height)));
    $('#downloadLabel').textContent = done.length ? `Download ${done.length} as ZIP` : 'Download ZIP';
    $('#savedName').textContent = `Saved in outputs\\${state.batch.folder}`;
    $('#savedName').title = state.batch.folder || '';
  } else {
    const run = activeRun();
    show = !!run;
    if (run) {
      maxSide = Math.max(run.width, run.height);
      $('#downloadLabel').textContent = 'Download';
      $('#savedName').textContent = `Saved as outputs\\${run.file}`;
      $('#savedName').title = run.file;
    }
  }
  $('#result').hidden = !show;
  if (!show) return;

  // A ZIP silently keeps oversized images as PNG, so WebP is only blocked for single downloads.
  const webpOk = isBatch() || maxSide <= WEBP_MAX;
  if (state.fmt === 'webp' && !webpOk) state.fmt = 'png';
  for (const b of $('#formats').children) {
    b.setAttribute('aria-pressed', b.dataset.fmt === state.fmt);
    if (b.dataset.fmt === 'webp') {
      b.disabled = !webpOk;
      b.title = webpOk ? 'Small files, keeps transparency' : `WebP is limited to ${WEBP_MAX.toLocaleString()} px per side`;
    }
  }
}

function renderBatchBadge() {
  const b = state.batch, el = $('#batchCount');
  el.hidden = !b.items.length;
  el.classList.toggle('live', b.running);
  el.textContent = b.running ? `${b.items.filter(i => i.status === 'done').length}/${b.items.length}` : b.items.length;
}

// ------------------------------------------------------------------ rendering: single-image stage

function renderStage() {
  const img = state.image;
  $('#empty').hidden = !!img;
  $('#viewer').hidden = !img;
  $('#toolbar').hidden = !img;
  if (!img) return;

  renderRuns();
  const run = activeRun();
  $('#modes').hidden = !run;
  for (const b of $('#modes').querySelectorAll('[data-mode]')) b.setAttribute('aria-pressed', b.dataset.mode === view.mode);

  if (run) {
    const m = modelById(run.modelId);
    $('#tagAfter').innerHTML = `After · <b>${esc(m.name)} ${fmtScale(run.scale)}</b>`;
  }
  $('#tagBefore').hidden = !run || view.mode === 'after';
  $('#tagAfter').hidden = !run || view.mode === 'before';
  $('#divider').hidden = !run || view.mode !== 'split';
  renderBusy();
  applyView();
}

function renderRuns() {
  const chips = [`<button class="run" data-run="" aria-pressed="${!state.runId}">Original</button>`];
  for (const r of state.runs) {
    const m = modelById(r.modelId);
    chips.push(`<button class="run" data-run="${r.id}" aria-pressed="${state.runId === r.id}" title="${esc(r.file)}">
      ${esc(m.name)} <span class="meta">${fmtScale(r.scale)} · ${fmtDuration(r.elapsed)}</span></button>`);
  }
  $('#runs').innerHTML = chips.join('');
  $('#runs').hidden = state.runs.length === 0;
}

function renderBusy() {
  const busy = singleBusy();
  $('#busy').hidden = !busy;
  if (!busy) return;
  const info = stageInfo(state.job);
  $('#busyTitle').textContent = info.title;
  $('#busyDetail').textContent = info.detail;
  $('#busyPct').textContent = info.pct != null ? info.pct + '%' : '';
  $('#busyBar').classList.toggle('indeterminate', info.pct == null);
  $('#busyBar').firstElementChild.style.width = (info.pct ?? 0) + '%';
}

// ------------------------------------------------------------------ viewer

const viewer = $('#viewer'), canvas = $('#canvas'), frame = $('#frame');
const imgBefore = $('#imgBefore'), imgAfter = $('#imgAfter');
const TOOLBAR_SPACE = 64;

function contentSize() {
  const run = activeRun();
  if (run) return { w: run.width, h: run.height };
  return state.image ? { w: state.image.width, h: state.image.height } : { w: 1, h: 1 };
}

function fitZoom() {
  const { w, h } = contentSize();
  const vw = viewer.clientWidth, vh = viewer.clientHeight - TOOLBAR_SPACE;
  return Math.min((vw - 64) / w, (vh - 48) / h, 8);
}

function fitView() {
  const { w, h } = contentSize();
  view.z = fitZoom();
  view.tx = (viewer.clientWidth - w * view.z) / 2;
  view.ty = (viewer.clientHeight - TOOLBAR_SPACE - h * view.z) / 2 + 8;
  view.fit = true;
  applyView();
}

function zoomAt(z, mx, my) {
  z = clamp(z, Math.min(fitZoom() * 0.5, 0.05), 32);
  view.tx = mx - (mx - view.tx) * z / view.z;
  view.ty = my - (my - view.ty) * z / view.z;
  view.z = z;
  view.fit = false;
  applyView();
}

const zoomCenter = z => zoomAt(z, viewer.clientWidth / 2, (viewer.clientHeight - TOOLBAR_SPACE) / 2);

function applyView() {
  if (!state.image || isBatch()) return;
  const { w, h } = contentSize();
  const { z, tx, ty } = view;
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  canvas.style.transform = `translate(${tx}px, ${ty}px) scale(${z})`;
  canvas.classList.toggle('pixels', z >= 2);
  Object.assign(frame.style, { left: tx + 'px', top: ty + 'px', width: w * z + 'px', height: h * z + 'px' });
  $('#zoomLabel').textContent = Math.round(z * 100) + '%';

  const run = activeRun();
  const mode = run ? view.mode : 'before';
  imgAfter.hidden = !run || mode === 'before';
  imgBefore.hidden = mode === 'after';
  if (run && mode === 'split') {
    const splitX = view.split * viewer.clientWidth;
    const inset = clamp(w - (splitX - tx) / z, 0, w);
    imgBefore.style.clipPath = `inset(0 ${inset}px 0 0)`;
    $('#divider').style.left = splitX + 'px';
  } else {
    imgBefore.style.clipPath = 'none';
  }
}

/** Switch what the canvas shows while keeping the same on-screen size and position. */
function showRun(id) {
  const prev = contentSize();
  state.runId = id || null;
  const run = activeRun();
  if (run) imgAfter.src = run.url;
  const now = contentSize();
  if (!view.fit && prev.w !== now.w) view.z *= prev.w / now.w;
  if (view.fit) fitView();
  renderStage();
  renderResult();
}

let drag = null;
viewer.addEventListener('pointerdown', e => {
  if (e.button !== 0 || singleBusy()) return;
  const onDivider = !!e.target.closest('#divider');
  drag = { kind: onDivider ? 'split' : 'pan', x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty };
  viewer.setPointerCapture(e.pointerId);
  viewer.classList.add(onDivider ? 'splitting' : 'panning');
});
viewer.addEventListener('pointermove', e => {
  if (!drag) return;
  if (drag.kind === 'split') {
    const r = viewer.getBoundingClientRect();
    view.split = clamp((e.clientX - r.left) / r.width, 0, 1);
  } else {
    view.tx = drag.tx + e.clientX - drag.x;
    view.ty = drag.ty + e.clientY - drag.y;
    view.fit = false;
  }
  applyView();
});
const endDrag = () => { drag = null; viewer.classList.remove('splitting', 'panning'); };
viewer.addEventListener('pointerup', endDrag);
viewer.addEventListener('pointercancel', endDrag);

viewer.addEventListener('wheel', e => {
  e.preventDefault();
  const r = viewer.getBoundingClientRect();
  zoomAt(view.z * Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
}, { passive: false });

viewer.addEventListener('dblclick', e => {
  if (e.target.closest('#divider')) return;
  const r = viewer.getBoundingClientRect();
  if (view.fit) zoomAt(Math.max(1, fitZoom() * 2), e.clientX - r.left, e.clientY - r.top);
  else fitView();
});

new ResizeObserver(() => (view.fit ? fitView() : applyView())).observe(viewer);

// ------------------------------------------------------------------ single image

function canDisplay(url) {
  return new Promise(resolve => {
    const probe = new Image();
    probe.onload = () => resolve(probe.naturalWidth > 0);
    probe.onerror = () => resolve(false);
    probe.src = url;
  });
}

async function displayUrl(file, imageId) {
  const url = URL.createObjectURL(file);
  if (await canDisplay(url)) return url;
  URL.revokeObjectURL(url);          // e.g. TIFF: let the server render a preview
  return `/api/images/${imageId}/preview`;
}

function setSingleImage(image, runs = []) {
  if (state.image?.url.startsWith('blob:')) URL.revokeObjectURL(state.image.url);
  state.image = image;
  state.runs = runs;
  state.runId = null;
  view.mode = 'split';
  view.split = 0.5;
  view.fit = true;
  imgBefore.src = image.url;
  imgAfter.removeAttribute('src');
}

async function loadFile(file) {
  if (!file) return;
  if (singleBusy()) { toast('Wait for the current upscale to finish, or cancel it first.'); return; }
  let info;
  try {
    info = await uploadImage(file);
  } catch (err) {
    toast(err.message, 'error');
    return;
  }
  const url = await displayUrl(file, info.id);
  setSingleImage({ ...info, file, name: file.name || 'Pasted image', bytes: file.size, url });
  renderAll();
  fitView();
}

async function upscaleSingle() {
  if (!state.image || isBusy()) return;
  let job;
  try {
    job = await startJob(state.image.id);
  } catch (err) {
    if (!/expired/i.test(err.message)) { toast(err.message, 'error'); return; }
    // The server forgot the image (restart or memory limit): re-send it once.
    try {
      state.image.id = (await uploadImage(state.image.file)).id;
      job = await startJob(state.image.id);
    } catch (err2) { toast(err2.message, 'error'); return; }
  }
  state.job = job;
  renderGo();
  renderBusy();

  const final = await pollJob(job.id, j => { if (state.job?.id === j.id) { state.job = j; renderGo(); renderBusy(); } });
  if (!final) {
    state.job = null;
    renderGo(); renderBusy();
    toast('Lost contact with the upscaler. Is the server still running?', 'error');
    return;
  }

  if (final.status === 'done') {
    modelById(final.model_id).downloaded = true;
    const url = `/api/jobs/${final.id}/result`;
    state.job = { ...final, status: 'preview', progress: 0 };
    renderGo(); renderBusy();
    try {
      const pre = new Image();
      pre.src = url;
      await pre.decode();
    } catch { /* very large images may not decode ahead of time; the viewer still loads them */ }
    state.runs.push({
      id: final.id, modelId: final.model_id, scale: final.scale, elapsed: final.elapsed,
      width: final.output.width, height: final.output.height, file: final.output.file, url,
    });
    state.job = null;
    if (view.mode === 'before') view.mode = 'split';
    showRun(final.id);
    renderModels();
    renderGo();
    toast(`Done in ${fmtDuration(final.elapsed)}. Drag the slider to compare.`, 'good');
  } else {
    state.job = null;
    renderGo(); renderBusy();
    if (final.status === 'error') toast(final.error || 'Something went wrong.', 'error');
    else toast('Upscale cancelled.');
  }
}

/** Poll a job until it finishes. Returns the final job, or null if the server went away. */
async function pollJob(id, onUpdate) {
  for (;;) {
    await sleep(250);
    let job;
    try { job = await api(`/api/jobs/${id}`); } catch { return null; }
    onUpdate(job);
    if (!ACTIVE.includes(job.status)) return job;
  }
}

// ------------------------------------------------------------------ batch

let itemSeq = 0;

async function makeThumb(file) {
  try {
    const bmp = await createImageBitmap(file);
    const { width, height } = bmp;
    const size = 96, k = size / Math.min(width, height);
    const c = document.createElement('canvas');
    c.width = c.height = size;
    c.getContext('2d').drawImage(bmp, (size - width * k) / 2, (size - height * k) / 2, width * k, height * k);
    bmp.close();
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85));
    return { width, height, thumb: URL.createObjectURL(blob) };
  } catch {
    return { width: 0, height: 0, thumb: null };   // e.g. TIFF: dimensions arrive after upload
  }
}

function isImageFile(f) { return f.type.startsWith('image/') || IMAGE_EXT.test(f.name); }

async function addBatchFiles(files) {
  const b = state.batch;
  const seen = new Set(b.items.map(i => `${i.name}|${i.bytes}|${i.file.lastModified}`));
  const fresh = files.filter(f => isImageFile(f) && !seen.has(`${f.name}|${f.size}|${f.lastModified}`));
  const skipped = files.length - fresh.length;
  if (!fresh.length) {
    toast(skipped ? 'Those images are already in the batch.' : "Those don't look like images.", 'error');
    return;
  }
  const items = fresh.map(file => ({
    key: ++itemSeq, file, name: file.name, bytes: file.size, width: 0, height: 0, thumb: null,
    status: 'waiting', progress: 0, detail: '', error: null, jobId: null, imageId: null,
    output: null, elapsed: 0, modelId: null, scale: null, est: 0,
  }));
  b.items.push(...items);
  renderAll();
  if (skipped) toast(`Added ${plural(fresh.length, 'image')}. Skipped ${skipped} already in the batch or not images.`);

  for (const item of items) {   // thumbnails fill in progressively
    Object.assign(item, await makeThumb(item.file));
    if (!b.items.includes(item)) { if (item.thumb) URL.revokeObjectURL(item.thumb); continue; }
    updateBatchRow(item);
  }
  renderStep1(); renderScales(); renderModels(); renderGo(); renderBatchHead();
}

function removeBatchItem(key) {
  const b = state.batch;
  const item = b.items.find(i => i.key === key);
  if (!item || item === b.current) return;
  if (item.thumb) URL.revokeObjectURL(item.thumb);
  b.items.splice(b.items.indexOf(item), 1);
  rowEls.get(key)?.remove();
  rowEls.delete(key);
  if (!b.items.length && !b.running) b.folder = null;
  renderAll();
}

function clearBatch() {
  const b = state.batch;
  if (b.running) { toast('Cancel the batch before clearing it.'); return; }
  for (const i of b.items) if (i.thumb) URL.revokeObjectURL(i.thumb);
  b.items = [];
  b.folder = null;
  renderAll();
}

function resetItem(item) {
  Object.assign(item, { status: 'waiting', progress: 0, detail: '', error: null, jobId: null, output: null, elapsed: 0 });
}

async function runBatch() {
  const b = state.batch;
  if (b.running || singleBusy() || !b.items.length) return;

  const everythingDone = b.items.every(i => i.status === 'done');
  if (everythingDone) {             // a fresh run with (probably) new settings: new folder
    b.items.forEach(resetItem);
    b.folder = null;
  } else {
    b.items.filter(i => i.status !== 'done').forEach(resetItem);
  }
  try {
    if (!b.folder) b.folder = (await api('/api/batches', { method: 'POST' })).name;
  } catch (err) { toast(err.message, 'error'); return; }

  const m = currentModel();
  b.running = true;
  b.cancel = false;
  b.run = { modelId: m.id, scale: state.scale, started: performance.now() };
  for (const i of b.items) if (i.status === 'waiting') i.est = estimateOne(m, i.width, i.height, state.scale);
  renderAll();

  let item;
  while (!b.cancel && (item = b.items.find(i => i.status === 'waiting'))) {
    b.current = item;
    item.modelId = m.id;
    item.scale = state.scale;
    if (!item.est) item.est = estimateOne(m, item.width, item.height, state.scale);
    const ok = await runBatchItem(item);
    if (!ok) break;                 // server unreachable
  }

  const finished = b.items.filter(i => i.status === 'done').length;
  const failed = b.items.filter(i => i.status === 'error').length;
  const secs = (performance.now() - b.run.started) / 1000;
  b.running = false;
  b.current = null;
  renderAll();

  if (b.cancel) toast(`Batch paused: ${finished} of ${b.items.length} done. Press Upscale to continue.`);
  else if (failed) toast(`Batch finished: ${finished} done, ${failed} failed.`, 'error');
  else toast(`Batch finished: ${plural(finished, 'image')} in ${fmtDuration(secs)}.`, 'good');
}

async function runBatchItem(item) {
  const b = state.batch;
  item.status = 'uploading';
  refreshBatchProgress(item);
  try {
    const info = await uploadImage(item.file);
    Object.assign(item, { imageId: info.id, width: info.width, height: info.height });
    if (!item.est) item.est = estimateOne(currentModel(), item.width, item.height, item.scale);
    const job = await startJob(info.id, b.folder);
    item.jobId = job.id;
    Object.assign(item, { status: job.status });
    refreshBatchProgress(item);

    const final = await pollJob(job.id, j => {
      Object.assign(item, { status: j.status, progress: j.progress, detail: j.detail, eta: j.eta });
      refreshBatchProgress(item);
    });
    if (!final) {
      item.status = 'error';
      item.error = 'Lost contact with the upscaler.';
      toast('Lost contact with the upscaler. Is the server still running?', 'error');
      return false;
    }
    item.status = final.status === 'cancelled' ? 'waiting' : final.status;
    if (final.status === 'done') {
      item.output = final.output;
      item.elapsed = final.elapsed;
      modelById(final.model_id).downloaded = true;
    } else if (final.status === 'error') {
      item.error = final.error || 'Something went wrong.';
    }
  } catch (err) {
    item.status = 'error';
    item.error = err.message;
  }
  refreshBatchProgress(item);
  renderResult();
  return true;
}

function cancelBatch() {
  const b = state.batch;
  if (!b.running) return;
  b.cancel = true;
  if (b.current?.jobId) api(`/api/jobs/${b.current.jobId}/cancel`, { method: 'POST' }).catch(() => {});
  renderBatchHead();
}

/** Overall progress, weighting each image by its estimated work. */
function batchProgress() {
  const b = state.batch;
  const inRun = b.items.filter(i => i.status !== 'done' || i.modelId === b.run?.modelId && i.scale === b.run?.scale);
  const weight = i => i.est || 1;
  const total = inRun.reduce((t, i) => t + weight(i), 0) || 1;
  const done = inRun.reduce((t, i) => t + (i.status === 'done' ? weight(i) : i === b.current ? weight(i) * (i.progress || 0) : 0), 0);

  // Correct the estimate using how long finished images actually took.
  const finished = inRun.filter(i => i.status === 'done' && i.elapsed);
  const ratio = finished.length ? finished.reduce((t, i) => t + i.elapsed, 0) / finished.reduce((t, i) => t + weight(i), 0) : 1;
  const remaining = (total - done) * ratio;
  const index = Math.min(inRun.length, inRun.filter(i => i.status === 'done').length + 1);
  return { fraction: done / total, index, total: inRun.length, eta: currentModel()?.sec_per_mp != null ? remaining : null };
}

// batch rendering: rows are created once and updated in place so thumbnails don't flicker
const rowEls = new Map();

function renderBatch() {
  const b = state.batch;
  $('#batchEmpty').hidden = b.items.length > 0;
  $('#batchWrap').hidden = !b.items.length;
  const list = $('#batchList');
  const keys = new Set(b.items.map(i => i.key));
  for (const [key, el] of rowEls) if (!keys.has(key)) { el.remove(); rowEls.delete(key); }
  for (const item of b.items) {
    let el = rowEls.get(item.key);
    if (!el) {
      el = document.createElement('li');
      el.className = 'brow';
      el.dataset.key = item.key;
      el.innerHTML = `
        <div class="bthumb"></div>
        <div class="binfo"><div class="bname"></div><div class="bmeta"></div></div>
        <div class="bstatus"></div>
        <div class="bactions">
          <button class="icon-btn accent" data-row="compare" title="Open in the comparison viewer">${icons.compare}</button>
          <button class="icon-btn" data-row="remove" title="Remove from batch">${icons.remove}</button>
        </div>`;
      rowEls.set(item.key, el);
    }
    list.append(el);                  // keeps DOM order in sync with items
    updateBatchRow(item);
  }
  renderBatchHead();
}

function updateBatchRow(item) {
  const el = rowEls.get(item.key);
  if (!el) return;
  const thumbBox = el.querySelector('.bthumb');
  if (item.thumb && !thumbBox.querySelector('img')) thumbBox.innerHTML = `<img src="${esc(item.thumb)}" alt="">`;
  else if (!item.thumb && !thumbBox.innerHTML) thumbBox.innerHTML = icons.image;

  el.querySelector('.bname').textContent = item.name;
  el.querySelector('.bname').title = item.name;
  const meta = el.querySelector('.bmeta');
  meta.classList.toggle('err', item.status === 'error');
  if (item.status === 'error') meta.textContent = item.error;
  else if (item.status === 'done' && item.output) {
    meta.innerHTML = `${fmtDims(item.width, item.height)} → <b>${fmtDims(item.output.width, item.output.height)}</b> · ${esc(modelById(item.modelId).name)} ${fmtScale(item.scale)}`;
  } else if (item.width) {
    const [ow, oh] = outDims(item.width, item.height, item.status === 'waiting' ? state.scale : item.scale);
    meta.innerHTML = `${fmtDims(item.width, item.height)} → <b>${fmtDims(ow, oh)}</b> · ${fmtBytes(item.bytes)}`;
  } else meta.textContent = fmtBytes(item.bytes);

  const st = el.querySelector('.bstatus');
  const current = item === state.batch.current && ACTIVE.includes(item.status);
  el.classList.toggle('current', current);
  el.classList.toggle('done', item.status === 'done');
  st.className = 'bstatus';
  if (item.status === 'done') {
    st.classList.add('done');
    st.innerHTML = `${icons.check} Done in ${fmtDuration(item.elapsed)}`;
  } else if (item.status === 'error') {
    st.classList.add('error');
    st.innerHTML = `${icons.alert} Failed`;
  } else if (current) {
    st.classList.add('active');
    const info = stageInfo({ ...item, model_id: item.modelId });
    const pct = info.pct;
    st.innerHTML = `<div class="mini ${pct == null ? 'indeterminate' : ''}"><i style="width:${pct ?? 0}%"></i></div>
      <span>${pct != null ? pct + '%' : esc(info.title.split(' with ')[0])}</span>`;
    st.title = [info.title, info.detail].filter(Boolean).join(' · ');
  } else {
    st.textContent = state.batch.running ? 'Waiting' : 'Ready';
    st.title = '';
  }

  el.querySelector('[data-row="compare"]').disabled = item.status !== 'done';
  el.querySelector('[data-row="remove"]').disabled = current;
}

function renderBatchHead() {
  const b = state.batch;
  if (!b.items.length) return;
  const done = b.items.filter(i => i.status === 'done').length;
  const failed = b.items.filter(i => i.status === 'error').length;
  $('#batchTitle').textContent = plural(b.items.length, 'image');
  const bits = [];
  if (done) bits.push(`<span class="good">${done} done</span>`);
  if (failed) bits.push(`<span class="bad">${failed} failed</span>`);
  const waiting = b.items.length - done - failed;
  if (waiting && (done || failed)) bits.push(`${waiting} to go`);
  const m = currentModel();
  bits.push(b.running
    ? `with <b>${esc(modelById(b.run.modelId).name)}</b> at <b>${fmtScale(b.run.scale)}</b>`
    : `next run: <b>${esc(m?.name || '')}</b> at <b>${fmtScale(state.scale)}</b>`);
  $('#batchSub').innerHTML = bits.join(' · ');

  $('#batchProgress').hidden = !b.running;
  if (b.running) {
    const p = batchProgress();
    $('#bpTitle').textContent = b.cancel ? 'Stopping after this image…' : `Upscaling image ${p.index} of ${p.total} · ${Math.round(p.fraction * 100)}%`;
    $('#bpEta').textContent = p.eta != null && p.fraction < 1 ? `about ${fmtDuration(p.eta)} left` : '';
    $('#bpBar').style.width = p.fraction * 100 + '%';
  }
  for (const btn of document.querySelectorAll('[data-action="clear-batch"]')) btn.disabled = b.running;
}

function refreshBatchProgress(item) {
  updateBatchRow(item);
  renderBatchHead();
  renderBatchBadge();
  renderGo();
}

async function compareBatchItem(key) {
  const item = state.batch.items.find(i => i.key === key);
  if (!item || item.status !== 'done') return;
  if (singleBusy()) { toast('Wait for the current single upscale to finish first.'); return; }
  const url = await displayUrl(item.file, item.imageId);
  const run = {
    id: item.jobId, modelId: item.modelId, scale: item.scale, elapsed: item.elapsed,
    width: item.output.width, height: item.output.height, file: item.output.file,
    url: `/api/jobs/${item.jobId}/result`,
  };
  setSingleImage({
    id: item.imageId, file: item.file, name: item.name, bytes: item.bytes,
    width: item.width, height: item.height, alpha: false, url,
  }, [run]);
  setAppMode('single');
  showRun(run.id);
  fitView();
}

// ------------------------------------------------------------------ mode + input routing

function setAppMode(mode) {
  if (state.appMode === mode) return;
  state.appMode = mode;
  store.set('mode', mode);
  renderAll();
  if (mode === 'single' && state.image) fitView();
}

const isBusy = () => singleBusy() || batchBusy();

function browse() { (isBatch() ? $('#batchInput') : $('#fileInput')).click(); }

/** Route incoming files: one file in single mode replaces the image; anything else goes to the batch. */
function acceptFiles(files) {
  files = [...files];
  if (!files.length) return;
  if (!isBatch() && files.length === 1) { loadFile(files[0]); return; }
  if (!isBatch()) {
    setAppMode('batch');
    toast(`Switched to Batch for ${plural(files.length, 'file')}.`);
  }
  addBatchFiles(files);
}

$('#fileInput').addEventListener('change', e => { acceptFiles(e.target.files); e.target.value = ''; });
$('#batchInput').addEventListener('change', e => { addBatchFiles([...e.target.files]); e.target.value = ''; });

let dragDepth = 0;
const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', e => {
  if (!hasFiles(e)) return;
  dragDepth++;
  document.body.classList.add('dragging');
});
window.addEventListener('dragleave', e => {
  if (!hasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) document.body.classList.remove('dragging');
});
window.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('drop', e => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  const files = [...e.dataTransfer.files].filter(isImageFile);
  if (files.length) acceptFiles(files);
  else toast("That doesn't look like an image.", 'error');
});

window.addEventListener('paste', e => {
  if (e.target.matches?.('input, textarea')) return;
  const blobs = [...(e.clipboardData?.items || [])].filter(i => i.type.startsWith('image/')).map(i => i.getAsFile());
  if (!blobs.length) return;
  e.preventDefault();
  acceptFiles(blobs.map((blob, n) => {
    const ext = (blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
    return new File([blob], `pasted-image${n ? '-' + (n + 1) : ''}.${ext}`, { type: blob.type });
  }));
});

// ------------------------------------------------------------------ selection

function selectModel(id, focus = false) {
  if (!modelById(id)) return;
  state.modelId = id;
  store.set('model', id);
  renderModels();
  renderScales();
  renderGo();
  if (isBatch()) { renderBatchHead(); }
  const card = $(`.model[data-id="${id}"]`);
  if (card) {
    if (focus) card.focus({ preventScroll: true });
    requestAnimationFrame(() => card.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  }
}

// ------------------------------------------------------------------ misc ui

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, kind === 'error' ? 6000 : 3500);
}

function download() {
  let href;
  if (isBatch()) {
    if (!state.batch.folder) return;
    href = `/api/batches/${state.batch.folder}/zip?format=${state.fmt}`;
    toast('Preparing the ZIP…');
  } else {
    const run = activeRun();
    if (!run) return;
    href = `/api/jobs/${run.id}/result?format=${state.fmt}&download=true`;
  }
  const a = document.createElement('a');
  a.href = href;
  a.download = '';
  document.body.append(a);
  a.click();
  a.remove();
}

function reveal() {
  const path = isBatch()
    ? state.batch.folder && `/api/batches/${state.batch.folder}/reveal`
    : activeRun() && `/api/jobs/${activeRun().id}/reveal`;
  if (path) api(path, { method: 'POST' }).catch(err => toast(err.message, 'error'));
}

function setMode(mode) {
  if (!activeRun() || isBatch()) return;
  view.mode = mode;
  renderStage();
}

function upscale() { if (isBatch()) runBatch(); else upscaleSingle(); }
function cancel() {
  if (isBatch()) cancelBatch();
  else if (singleBusy() && state.job.status !== 'preview') {
    api(`/api/jobs/${state.job.id}/cancel`, { method: 'POST' }).catch(() => { /* polling will notice */ });
  }
}

// ------------------------------------------------------------------ events

document.addEventListener('click', e => {
  const t = e.target.closest('[data-action], [data-filter], [data-scale], [data-nudge], [data-fmt], [data-mode], [data-run], [data-appmode], [data-row], .model, .brow.done');
  if (!t || t.disabled) return;
  const d = t.dataset;
  if (d.action === 'browse') browse();
  else if (d.action === 'add-batch') $('#batchInput').click();
  else if (d.action === 'clear-batch') clearBatch();
  else if (d.appmode) setAppMode(d.appmode);
  else if (d.filter) { state.filter = d.filter; renderFilters(); renderModels(); }
  else if (d.scale === 'custom') {
    state.customOpen = true;
    renderScales();
    $('#customScale').focus();
    $('#customScale').select();
  } else if (d.scale) setScale(d.scale);
  else if (d.nudge) setScale(state.scale + Number(d.nudge), { fromCustom: true });
  else if (d.fmt) { state.fmt = d.fmt; store.set('fmt', state.fmt); renderResult(); }
  else if (d.mode) setMode(d.mode);
  else if ('run' in d) showRun(d.run);
  else if (d.row) {
    const key = Number(t.closest('.brow').dataset.key);
    if (d.row === 'remove') removeBatchItem(key); else compareBatchItem(key);
  } else if (t.classList.contains('model')) selectModel(d.id);
  else if (t.classList.contains('brow')) compareBatchItem(Number(d.key));
});

const customInput = $('#customScale');
customInput.addEventListener('input', () => {
  const v = parseFloat(customInput.value.replace(',', '.'));
  if (v >= MIN_SCALE && v <= MAX_SCALE) setScale(v, { fromCustom: true });
});
customInput.addEventListener('change', () => setScale(parseFloat(customInput.value.replace(',', '.')), { fromCustom: true }));
customInput.addEventListener('blur', () => { customInput.value = +state.scale.toFixed(2); });
customInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); customInput.blur(); }
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    e.preventDefault();
    setScale(state.scale + (e.key === 'ArrowUp' ? 0.1 : -0.1) * (e.shiftKey ? 5 : 1), { fromCustom: true });
    customInput.value = +state.scale.toFixed(2);
  }
});

for (const id of ['#dropCard', '#batchDrop']) {
  $(id).addEventListener('click', browse);
  $(id).addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); browse(); } });
}
$('#goBtn').addEventListener('click', () => { if (!isBusy()) upscale(); });
$('#cancelBtn').addEventListener('click', cancel);
$('#downloadBtn').addEventListener('click', download);
$('#revealBtn').addEventListener('click', reveal);
$('#zoomIn').addEventListener('click', () => zoomCenter(view.z * 1.25));
$('#zoomOut').addEventListener('click', () => zoomCenter(view.z / 1.25));
$('#zoomLabel').addEventListener('click', () => zoomCenter(1));
$('#zoomFit').addEventListener('click', fitView);

$('#models').addEventListener('keydown', e => {
  const cards = [...$('#models').querySelectorAll('.model')];
  const i = cards.indexOf(document.activeElement);
  if (i < 0) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const next = cards[clamp(i + (e.key === 'ArrowDown' ? 1 : -1), 0, cards.length - 1)];
    selectModel(next.dataset.id, true);
  } else if (e.key === ' ' || e.key === 'Enter') {
    e.preventDefault();
    selectModel(cards[i].dataset.id, true);
  }
});

document.addEventListener('keydown', e => {
  if (e.target.matches('input, textarea') || e.ctrlKey && e.key !== 'Enter' || e.metaKey || e.altKey) return;
  const inCards = e.target.closest?.('#models');
  const viewing = !isBatch() && state.image;
  switch (e.key) {
    case 'Enter':
      if (!inCards && (e.ctrlKey || e.target === document.body)) { e.preventDefault(); upscale(); }
      break;
    case 'Escape': cancel(); break;
    case 'f': case 'F': if (viewing) fitView(); break;
    case '1': if (viewing) zoomCenter(1); break;
    case '+': case '=': if (viewing) zoomCenter(view.z * 1.25); break;
    case '-': case '_': if (viewing) zoomCenter(view.z / 1.25); break;
    case 'b': case 'B': setMode('before'); break;
    case 's': case 'S': setMode('split'); break;
    case 'a': case 'A': setMode('after'); break;
  }
});

window.addEventListener('beforeunload', e => { if (isBusy()) e.preventDefault(); });

// ------------------------------------------------------------------ boot

async function boot() {
  renderAll();
  try {
    const [system, models] = await Promise.all([api('/api/system'), api('/api/models')]);
    state.system = system;
    state.models = models;
    if (!modelById(state.modelId)) state.modelId = (models.find(m => m.recommended) || models[0]).id;

    const dev = $('#device');
    if (system.device === 'cuda') {
      dev.className = 'device ok';
      $('#deviceName').textContent = `${system.name} · ${system.vram_gb} GB`;
      dev.title = `Running on your GPU with PyTorch ${system.torch} (${system.precision})`;
    } else {
      dev.className = 'device cpu';
      $('#deviceName').textContent = 'CPU only: AI models will be slow';
    }
  } catch {
    $('#device').className = 'device off';
    $('#deviceName').textContent = 'Server offline';
    toast('Could not reach the upscaler server. Start it with start.bat.', 'error');
  }
  renderAll();
}

boot();
