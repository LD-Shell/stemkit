/**
 * Plot Digitizer | UI layer.
 *
 * Pixel-to-data mapping, calibration validation, point management, CSV
 * generation, and Python escaping live in stemkit-core. This file handles
 * canvas rendering, pointer input, and the zoom/loupe interaction.
 */
import {
  toDataCoordinates,
  validateCalibrationForm,
  pixelResolution,
  erasePoints as coreErasePoints,
  sortPoints,
  formatValue,
  generateCSV,
  pythonString,
  pythonIdentifier
} from '../src/core/digitizer.js';

/**
 * A figure to practise on, drawn here rather than shipped as an image: a
 * growth curve on labelled gridlines, 0 to 10 across and 0 to 100 up.
 */
function drawSampleFigure() {
  const W = 800, H = 560;
  const L = 90, R = 760, T = 50, B = 480;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, W, H);
  const px = x => L + (x / 10) * (R - L);
  const py = y => B - (y / 100) * (B - T);

  g.strokeStyle = '#e5e7eb'; g.lineWidth = 1;
  for (let x = 0; x <= 10; x += 2) { g.beginPath(); g.moveTo(px(x), T); g.lineTo(px(x), B); g.stroke(); }
  for (let y = 0; y <= 100; y += 20) { g.beginPath(); g.moveTo(L, py(y)); g.lineTo(R, py(y)); g.stroke(); }

  g.strokeStyle = '#111827'; g.lineWidth = 2;
  g.beginPath(); g.moveTo(L, T); g.lineTo(L, B); g.lineTo(R, B); g.stroke();

  g.fillStyle = '#111827'; g.font = '18px Arial, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'top';
  for (let x = 0; x <= 10; x += 2) g.fillText(String(x), px(x), B + 10);
  g.textAlign = 'right'; g.textBaseline = 'middle';
  for (let y = 0; y <= 100; y += 20) g.fillText(String(y), L - 10, py(y));
  g.textAlign = 'center'; g.textBaseline = 'alphabetic';
  g.fillText('Time (h)', (L + R) / 2, H - 20);
  g.save(); g.translate(28, (T + B) / 2); g.rotate(-Math.PI / 2);
  g.fillText('Conversion (%)', 0, 0); g.restore();

  // y = 100 (1 - e^(-x/3)), with a second, slower series.
  const series = [
    { colour: '#111827', f: x => 100 * (1 - Math.exp(-x / 3)) },
    { colour: '#6b7280', f: x => 100 * (1 - Math.exp(-x / 7)) }
  ];
  for (const s of series) {
    g.strokeStyle = s.colour; g.lineWidth = 3;
    g.beginPath();
    for (let x = 0; x <= 10.0001; x += 0.1) {
      if (x === 0) g.moveTo(px(x), py(s.f(x))); else g.lineTo(px(x), py(s.f(x)));
    }
    g.stroke();
    g.fillStyle = s.colour;
    for (let x = 0; x <= 10; x += 1) { g.beginPath(); g.arc(px(x), py(s.f(x)), 5, 0, Math.PI * 2); g.fill(); }
  }
  return c.toDataURL('image/png');
}

document.addEventListener('DOMContentLoaded', () => {

  // --- 1. State ---
  const PALETTE = ['#ef4444', '#3b82f6', '#10b981', '#f59e0b', '#8b5cf6'];
  let datasetCounter = 1;

  const state = {
    mode: 'idle',
    image: null,
    showBackground: true,
    calibration: { pxX1: null, pxX2: null, pxY1: null, pxY2: null },
    datasets: [{ id: 'ds_1', name: 'Series 1', color: PALETTE[0], points: [] }],
    activeDatasetId: 'ds_1',
    mouseX: 0,
    mouseY: 0,
    isDragging: false,
    lastTracePoint: null,
    eraseRadius: 10,
    zoomLevel: 1
  };

  // --- 2. Bindings ---
  const main = document.getElementById('main');
  const uploadZone = document.getElementById('uploadZone');
  const fileInput = document.getElementById('fileInput');
  const chooseFileBtn = document.getElementById('chooseFileBtn');
  const loadSampleBtn = document.getElementById('loadSampleBtn');
  const changeImageBtn = document.getElementById('changeImageBtn');
  const workspace = document.getElementById('workspace');

  const canvas = document.getElementById('plotCanvas');
  const ctx = canvas.getContext('2d');
  const loupe = document.getElementById('loupeCanvas');
  const loupeCtx = loupe ? loupe.getContext('2d') : null;

  const valX1 = document.getElementById('valX1');
  const valX2 = document.getElementById('valX2');
  const valY1 = document.getElementById('valY1');
  const valY2 = document.getElementById('valY2');
  const isLogX = document.getElementById('isLogX');
  const isLogY = document.getElementById('isLogY');
  const calibStatus = document.getElementById('calibStatus');

  const datasetList = document.getElementById('datasetList');
  const btnAddDataset = document.getElementById('btnAddDataset');
  const btnManualMode = document.getElementById('btnManualMode');
  const btnEraseMode = document.getElementById('btnEraseMode');
  const eraseControls = document.getElementById('eraseControls');
  const eraseRadiusSlider = document.getElementById('eraseRadius');
  const eraseRadiusVal = document.getElementById('eraseRadiusVal');
  const traceStatus = document.getElementById('traceStatus');
  const btnUndo = document.getElementById('btnUndo');
  const toggleBackground = document.getElementById('toggleBackground');
  const eyeIcon = document.getElementById('eyeIcon');
  const csvFilename = document.getElementById('csvFilename');
  const exportCsvBtn = document.getElementById('exportCsvBtn');
  const exportNote = document.getElementById('exportNote');
  const btnZoomIn = document.getElementById('btnZoomIn');
  const btnZoomOut = document.getElementById('btnZoomOut');
  const zoomLevelDisplay = document.getElementById('zoomLevel');
  const resolutionNote = document.getElementById('resolutionNote');
  const modeStatus = document.getElementById('modeStatus');
  const cursorReadout = document.getElementById('cursorReadout');

  const btnGeneratePython = document.getElementById('btnGeneratePython');
  const pythonModal = document.getElementById('pythonModal');
  const pythonCodeBlock = document.getElementById('pythonCodeBlock');
  const closePythonModal = document.getElementById('closePythonModal');
  const copyPythonBtn = document.getElementById('copyPythonBtn');
  const previewDialog = document.getElementById('previewDialog');

  const getActiveDataset = () =>
    state.datasets.find(ds => ds.id === state.activeDatasetId);

  /** Assemble the numeric calibration the core expects from the form. */
  function currentCalibration() {
    return {
      ...state.calibration,
      valX1: valX1.value, valX2: valX2.value,
      valY1: valY1.value, valY2: valY2.value,
      logX: isLogX.checked, logY: isLogY.checked
    };
  }

  // --- 3. Zoom ---
  function applyZoom() {
    if (!state.image) return;
    canvas.style.maxWidth = 'none';
    canvas.style.maxHeight = 'none';
    canvas.style.width = `${state.image.width * state.zoomLevel}px`;
    if (zoomLevelDisplay) {
      zoomLevelDisplay.innerText = `${Math.round(state.zoomLevel * 100)}%`;
    }
  }

  btnZoomIn.addEventListener('click', () => {
    state.zoomLevel = Math.min(state.zoomLevel + 0.25, 5);
    applyZoom();
  });
  btnZoomOut.addEventListener('click', () => {
    state.zoomLevel = Math.max(state.zoomLevel - 0.25, 0.25);
    applyZoom();
  });

  // Ctrl/Cmd + wheel zooms the figure. The modifier is required so plain
  // scrolling still pans a large image rather than surprising the user.
  const canvasContainer = document.getElementById('canvasContainer');
  canvasContainer.addEventListener('wheel', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const step = e.deltaY < 0 ? 0.1 : -0.1;
    state.zoomLevel = Math.min(5, Math.max(0.25, state.zoomLevel + step));
    applyZoom();
  }, { passive: false });

  // --- 4. Image intake: the shared file loader ---
  ['dragenter', 'dragover'].forEach(evt => uploadZone.addEventListener(evt, (e) => {
    e.preventDefault();
    uploadZone.classList.add('is-over');
  }));
  uploadZone.addEventListener('dragleave', (e) => {
    if (!uploadZone.contains(e.relatedTarget)) uploadZone.classList.remove('is-over');
  });
  uploadZone.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadZone.classList.remove('is-over');
    if (e.dataTransfer.files.length) readImageFile(e.dataTransfer.files[0]);
  });
  uploadZone.addEventListener('click', (e) => {
    if (!e.target.closest('button')) fileInput.click();
  });
  chooseFileBtn.addEventListener('click', () => fileInput.click());
  changeImageBtn.addEventListener('click', () => fileInput.click());
  loadSampleBtn.addEventListener('click', () => loadImage(drawSampleFigure(), 'sample_figure.png'));

  fileInput.addEventListener('change', (e) => {
    if (e.target.files[0]) readImageFile(e.target.files[0]);
    fileInput.value = '';
  });

  function readImageFile(file) {
    if (!file.type.startsWith('image/')) {
      showToast('Choose a PNG, JPEG or WebP image of the plot.', 'error');
      return;
    }
    const reader = new FileReader();
    reader.onload = (ev) => loadImage(ev.target.result, file.name);
    reader.onerror = () => showToast('Could not read that file.', 'error');
    reader.readAsDataURL(file);
  }

  function loadImage(src, name) {
    const img = new Image();
    img.onload = () => {
      state.image = img;
      canvas.width = img.width;
      canvas.height = img.height;
      // A new figure starts a new digitisation: its pixels mean something else.
      state.calibration = { pxX1: null, pxX2: null, pxY1: null, pxY2: null };
      [valX1, valX2, valY1, valY2].forEach(el => { el.value = ''; });
      state.datasets = [{ id: 'ds_1', name: 'Series 1', color: PALETTE[0], points: [] }];
      state.activeDatasetId = 'ds_1';
      datasetCounter = 1;
      exportNote.textContent = '';
      document.getElementById('fileName').textContent = name;
      document.getElementById('imageMeta').textContent = `${img.width} × ${img.height} px`;
      openWorkspace();
      // Measured once the workspace is showing; a hidden panel has no width.
      state.zoomLevel = fitZoom(img);
      setMode('idle');
      applyZoom();
      renderDatasetUI();
      syncCalibration();
      renderViewport();
    };
    img.onerror = () => showToast('That file could not be opened as an image.', 'error');
    img.src = src;
  }

  /** Start at a zoom that shows the whole figure in the canvas panel. */
  function fitZoom(img) {
    const box = canvasContainer.getBoundingClientRect();
    const w = (box.width || 800) - 32;
    return Math.min(1, Math.max(0.25, w / img.width));
  }

  /**
   * Swap the loader for the workspace. The head shrinks to one line, the
   * workspace keeps its viewport-high shell (.stk-shell), and the page scrolls
   * so the workspace fills the screen under the site header.
   */
  function openWorkspace() {
    main.classList.add('is-loaded');
    uploadZone.classList.add('hidden');
    workspace.classList.remove('hidden');
    workspace.classList.add('flex');
    const nav = document.querySelector('nav');
    const top = workspace.getBoundingClientRect().top + window.scrollY - (nav ? nav.offsetHeight : 0) - 12;
    window.scrollTo(0, Math.max(0, top));
  }

  // --- 5. Calibration and mode ---
  const CALIB_BUTTONS = {
    btnCalibX1: 'pxX1', btnCalibX2: 'pxX2',
    btnCalibY1: 'pxY1', btnCalibY2: 'pxY2'
  };

  // Each mode button is a toggle: pressing the one already on returns to
  // idle, and so does Esc, so there is always a way out of a mode.
  Object.entries(CALIB_BUTTONS).forEach(([id, key]) => {
    const btn = document.getElementById(id);
    btn.addEventListener('click', () => {
      setMode(state.mode === `calib:${key}` ? 'idle' : `calib:${key}`, btn);
    });
  });

  btnManualMode.addEventListener('click', () => {
    if (state.mode === 'digitize') { setMode('idle'); return; }
    if (!requireCalibration()) return;
    setMode('digitize', btnManualMode);
  });

  btnEraseMode.addEventListener('click', () => {
    setMode(state.mode === 'erase' ? 'idle' : 'erase', btnEraseMode);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (pythonModal.classList.contains('open')) { closePython(); return; }
    if (state.mode !== 'idle') setMode('idle');
  });

  eraseRadiusSlider.addEventListener('input', (e) => {
    state.eraseRadius = parseInt(e.target.value, 10) || 10;
    eraseRadiusVal.innerText = state.eraseRadius;
    renderViewport();
  });

  const MODE_TEXT = {
    'calib:pxX1': 'Click the figure where X1 is, then type its value.',
    'calib:pxX2': 'Click the figure where X2 is, then type its value.',
    'calib:pxY1': 'Click the figure where Y1 is, then type its value.',
    'calib:pxY2': 'Click the figure where Y2 is, then type its value.',
    erase: 'Drag over points to erase them. Esc stops.'
  };

  function updateModeStatus() {
    let text = MODE_TEXT[state.mode];
    if (state.mode === 'idle') {
      const calibrated = validateCalibrationForm(currentCalibration()).valid;
      const points = state.datasets.some(ds => ds.points.length);
      text = !calibrated
        ? 'Start by calibrating: press Set X1, then click that spot on the figure.'
        : points
          ? 'Add more points, erase stray ones, or export.'
          : 'Press Add points, then click or drag along a curve.';
    } else if (state.mode === 'digitize') {
      const ds = getActiveDataset();
      text = `Click or drag along the curve to add points to ${ds ? ds.name : 'the series'}. Esc stops.`;
    }
    modeStatus.textContent = text || '';
    modeStatus.classList.toggle('is-active', state.mode !== 'idle');
  }

  /**
   * Switch mode and show it: the button for the current mode is pressed
   * (aria-pressed, styled in plot-digitizer.css) and every other one is not.
   * Idle presses none.
   */
  function setMode(newMode, activeBtn) {
    state.mode = newMode;
    const pressed = newMode === 'idle' ? null : activeBtn;
    document.querySelectorAll('[data-modebtn]').forEach(b =>
      b.setAttribute('aria-pressed', String(b === pressed)));
    if (newMode === 'idle' && loupe) {
      loupe.classList.add('hidden');
      canvas.classList.remove('loupe-active');
    }
    eraseControls.classList.toggle('hidden', newMode !== 'erase');
    eraseControls.classList.toggle('flex', newMode === 'erase');
    canvas.style.cursor = newMode === 'idle' ? 'default' : 'crosshair';
    updateModeStatus();
    renderViewport();
    // On a narrow screen the steps sit below the figure: bring it back into
    // view, since the next click has to land on it.
    if (newMode !== 'idle') {
      const r = canvas.getBoundingClientRect();
      const nav = document.querySelector('nav');
      if (r.top < (nav ? nav.offsetHeight : 0) || r.bottom > window.innerHeight) {
        canvasContainer.scrollIntoView({ block: 'center' });
      }
    }
  }

  /** Validate the calibration through the core and report any problem. */
  function requireCalibration() {
    const r = validateCalibrationForm(currentCalibration());
    if (!r.valid) {
      showToast(r.errors.join(' '), 'error');
      return false;
    }
    return true;
  }

  /**
   * Where the cursor sits in data units, shown under the calibration once it
   * is valid, so a gridline of known value can confirm it before tracing.
   * The line stays in place between hovers, so the panel does not jump.
   */
  const shortValue = v => String(Number(v.toPrecision(4)));
  function updateReadout(p) {
    const check = validateCalibrationForm(currentCalibration());
    cursorReadout.hidden = !check.valid;
    if (!check.valid) return;
    const d = p ? toDataCoordinates(p.x, p.y, check.calibration) : null;
    cursorReadout.textContent = d
      ? `Cursor at x = ${shortValue(d.x)}, y = ${shortValue(d.y)}`
      : 'Hover over the figure to read a position here.';
  }

  /**
   * Show which reference points are set, and once all four points and values
   * make a valid calibration, say so along with the data-space size of one
   * pixel: a digitised value is no more precise than that, whatever the
   * number of decimals in the export.
   */
  function syncCalibration() {
    Object.entries(CALIB_BUTTONS).forEach(([id, key]) => {
      document.getElementById(id).classList.toggle('is-set', state.calibration[key] !== null);
    });
    const r = validateCalibrationForm(currentCalibration());
    updateReadout(null);
    if (!r.valid) {
      calibStatus.textContent = '';
      resolutionNote.classList.add('hidden');
      updateModeStatus();
      return;
    }
    calibStatus.textContent = 'Axes calibrated.';
    updateModeStatus();
    const notes = [...(r.warnings || [])];
    const res = pixelResolution(r.calibration);
    if (res) {
      notes.push(`One pixel ≈ ${formatValue(res.dx)} in x and ${formatValue(res.dy)} in y; ` +
                 'digitised values are no more precise than this.');
    }
    resolutionNote.textContent = notes.join(' ');
    resolutionNote.classList.toggle('hidden', notes.length === 0);
  }
  [valX1, valX2, valY1, valY2, isLogX, isLogY].forEach(el => el.addEventListener('input', syncCalibration));

  // --- 6. Datasets ---
  btnAddDataset.addEventListener('click', () => {
    datasetCounter++;
    const id = `ds_${datasetCounter}`;
    state.datasets.push({
      id,
      name: `Series ${datasetCounter}`,
      color: PALETTE[(datasetCounter - 1) % PALETTE.length],
      points: []
    });
    state.activeDatasetId = id;
    renderDatasetUI();
    updateModeStatus();
    renderViewport();
  });

  /** One row per series: pick it, recolour it, rename it, see its count. */
  function renderDatasetUI() {
    datasetList.innerHTML = '';

    state.datasets.forEach(ds => {
      const active = ds.id === state.activeDatasetId;
      const row = document.createElement('div');
      row.className = 'pd-series' + (active ? ' is-active' : '');
      row.setAttribute('role', 'radio');
      row.setAttribute('aria-checked', String(active));
      row.tabIndex = active ? 0 : -1;

      const colour = document.createElement('input');
      colour.type = 'color';
      colour.value = ds.color;
      colour.className = 'pd-series-colour';
      colour.setAttribute('aria-label', `Colour of ${ds.name}`);
      colour.addEventListener('click', e => e.stopPropagation());
      colour.addEventListener('input', e => { ds.color = e.target.value; renderViewport(); });

      const name = document.createElement('input');
      name.type = 'text';
      name.value = ds.name;
      name.className = 'pd-series-name';
      name.setAttribute('aria-label', 'Series name');
      name.addEventListener('click', e => e.stopPropagation());
      name.addEventListener('input', e => { ds.name = e.target.value; updateModeStatus(); });

      const count = document.createElement('span');
      count.className = 'pd-series-count';
      count.textContent = `${ds.points.length} pt${ds.points.length === 1 ? '' : 's'}`;

      row.append(colour, name, count);
      const select = () => {
        state.activeDatasetId = ds.id;
        renderDatasetUI();
        updateModeStatus();
        renderViewport();
      };
      row.addEventListener('click', select);
      row.addEventListener('keydown', e => {
        if (e.target !== row) return;
        if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); select(); }
      });
      datasetList.appendChild(row);
    });

    const total = state.datasets.reduce((n, ds) => n + ds.points.length, 0);
    const withPoints = state.datasets.filter(ds => ds.points.length).length;
    traceStatus.textContent = total
      ? `${total} point${total === 1 ? '' : 's'} in ${withPoints} series.`
      : '';
    if (state.mode === 'idle') updateModeStatus();
  }

  btnUndo.addEventListener('click', () => {
    const ds = getActiveDataset();
    if (ds && ds.points.length) {
      ds.points.pop();
      renderDatasetUI();
      renderViewport();
    }
  });

  toggleBackground.addEventListener('click', () => {
    state.showBackground = !state.showBackground;
    toggleBackground.setAttribute('aria-pressed', String(state.showBackground));
    eyeIcon.className = state.showBackground ? 'fa-solid fa-eye' : 'fa-solid fa-eye-slash';
    renderViewport();
  });

  // --- 7. Pointer handling ---
  function canvasCoords(e) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (canvas.width / rect.width),
      y: (e.clientY - rect.top) * (canvas.height / rect.height)
    };
  }

  // Dragging in Add points mode lays down a trail, one point every 8 px of
  // movement, so a curve can be traced in one stroke.
  const TRACE_SPACING = 8;

  canvas.addEventListener('mousemove', (e) => {
    const p = canvasCoords(e);
    state.mouseX = p.x;
    state.mouseY = p.y;
    updateReadout(p);

    if (state.isDragging && state.mode === 'erase') applyErase(p.x, p.y);
    if (state.isDragging && state.mode === 'digitize' && state.lastTracePoint) {
      const d = Math.hypot(p.x - state.lastTracePoint.x, p.y - state.lastTracePoint.y);
      const ds = getActiveDataset();
      if (d >= TRACE_SPACING && ds) {
        ds.points.push({ pxX: p.x, pxY: p.y });
        state.lastTracePoint = { x: p.x, y: p.y };
        renderDatasetUI();
      }
    }
    updateLoupe(e);
    renderViewport();
  });

  canvas.addEventListener('mousedown', (e) => {
    const p = canvasCoords(e);
    state.isDragging = true;

    if (state.mode.startsWith('calib:')) {
      const key = state.mode.split(':')[1];
      state.calibration[key] = (key === 'pxX1' || key === 'pxX2') ? p.x : p.y;
      const valueInput = { pxX1: valX1, pxX2: valX2, pxY1: valY1, pxY2: valY2 }[key];
      setMode('idle', null);
      syncCalibration();
      valueInput.focus();
      return;
    }

    if (state.mode === 'digitize') {
      const ds = getActiveDataset();
      if (ds) {
        ds.points.push({ pxX: p.x, pxY: p.y });
        state.lastTracePoint = { x: p.x, y: p.y };
        renderDatasetUI();
      }
      return;
    }

    if (state.mode === 'erase') applyErase(p.x, p.y);
  });

  window.addEventListener('mouseup', () => {
    state.isDragging = false;
    state.lastTracePoint = null;
  });

  canvas.addEventListener('mouseleave', () => {
    state.lastTracePoint = null;
    if (loupe) loupe.classList.add('hidden');
    updateReadout(null);
  });

  function applyErase(px, py) {
    const ds = getActiveDataset();
    if (!ds) return;
    const r = coreErasePoints(ds.points, px, py, state.eraseRadius);
    if (r.removed > 0) {
      ds.points = r.points;
      renderDatasetUI();
      renderViewport();
    }
  }

  // --- 8. Canvas rendering ---
  function renderViewport() {
    if (!state.image) return;

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (state.showBackground) ctx.drawImage(state.image, 0, 0);

    const drawBadge = (x, y, text, bg) => {
      ctx.font = 'bold 12px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = bg;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x - 16, y - 10, 32, 20, 4);
      else ctx.rect(x - 16, y - 10, 32, 20);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.fillText(text, x, y);
    };

    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);

    const marks = [
      ['pxX1', '#ef4444', 'X1', 20, true],
      ['pxX2', '#b91c1c', 'X2', 45, true],
      ['pxY1', '#3b82f6', 'Y1', 25, false],
      ['pxY2', '#1d4ed8', 'Y2', 65, false]
    ];

    for (const [key, colour, label, offset, vertical] of marks) {
      const v = state.calibration[key];
      if (v === null || v === undefined) continue;
      ctx.strokeStyle = colour;
      ctx.beginPath();
      if (vertical) {
        ctx.moveTo(v, 0);
        ctx.lineTo(v, canvas.height);
      } else {
        ctx.moveTo(0, v);
        ctx.lineTo(canvas.width, v);
      }
      ctx.stroke();
      if (vertical) drawBadge(v, offset, label, colour);
      else drawBadge(offset, v, label, colour);
    }
    ctx.setLineDash([]);

    for (const ds of state.datasets) {
      if (ds.points.length === 0) continue;
      ctx.strokeStyle = ds.color;
      ctx.fillStyle = ds.color;
      ctx.lineWidth = 2;

      const ordered = sortPoints(ds.points);
      ctx.beginPath();
      ctx.moveTo(ordered[0].pxX, ordered[0].pxY);
      for (let i = 1; i < ordered.length; i++) {
        ctx.lineTo(ordered[i].pxX, ordered[i].pxY);
      }
      ctx.stroke();

      for (const pt of ds.points) {
        ctx.beginPath();
        ctx.arc(pt.pxX, pt.pxY, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    if (state.mode !== 'idle') {
      ctx.lineWidth = 1;
      if (state.mode === 'erase') {
        ctx.strokeStyle = 'rgba(239, 68, 68, 0.4)';
        ctx.beginPath();
        ctx.arc(state.mouseX, state.mouseY, state.eraseRadius, 0, Math.PI * 2);
        ctx.stroke();
        ctx.strokeStyle = '#ef4444';
      } else {
        ctx.strokeStyle = state.mode === 'digitize'
          ? ((getActiveDataset() || {}).color || '#f59e0b')
          : '#f59e0b';
      }
      ctx.beginPath();
      ctx.moveTo(state.mouseX, 0);
      ctx.lineTo(state.mouseX, canvas.height);
      ctx.moveTo(0, state.mouseY);
      ctx.lineTo(canvas.width, state.mouseY);
      ctx.stroke();
    }
  }

  function updateLoupe(evt) {
    if (!loupe || !loupeCtx) return;
    if (state.mode === 'idle') {
      loupe.classList.add('hidden');
      canvas.classList.remove('loupe-active');
      return;
    }
    loupe.classList.remove('hidden');
    canvas.classList.add('loupe-active');

    const zoom = 6;
    const size = loupe.width;
    const half = size / (2 * zoom);

    loupeCtx.imageSmoothingEnabled = false;
    loupeCtx.clearRect(0, 0, size, size);
    loupeCtx.drawImage(
      canvas,
      state.mouseX - half, state.mouseY - half, half * 2, half * 2,
      0, 0, size, size
    );
    loupeCtx.strokeStyle = '#ef4444';
    loupeCtx.lineWidth = 1;
    loupeCtx.beginPath();
    loupeCtx.moveTo(size / 2, 0);
    loupeCtx.lineTo(size / 2, size);
    loupeCtx.moveTo(0, size / 2);
    loupeCtx.lineTo(size, size / 2);
    loupeCtx.stroke();

    // The loupe is position: fixed, so viewport coordinates place it.
    if (evt && evt.clientX !== undefined) {
      loupe.style.left = `${evt.clientX + 20}px`;
      loupe.style.top = `${evt.clientY + 20}px`;
    }
  }

  // --- 9. Export ---
  /** Digitise every dataset through the core, ready for export. */
  function digitisedDatasets() {
    const check = validateCalibrationForm(currentCalibration());
    if (!check.valid) return null;

    return state.datasets.map(ds => ({
      ...ds,
      points: ds.points
        .map(pt => {
          const d = toDataCoordinates(pt.pxX, pt.pxY, check.calibration);
          return d ? { ...pt, logicalX: d.x, logicalY: d.y } : null;
        })
        .filter(Boolean)
    }));
  }

  exportCsvBtn.addEventListener('click', () => {
    if (!requireCalibration()) return;
    const datasets = digitisedDatasets();
    if (!datasets) return;
    const total = datasets.reduce((n, ds) => n + ds.points.length, 0);
    if (!total) {
      showToast('Add some points in step 3 first.', 'error');
      return;
    }

    const csv = generateCSV(datasets);
    const name = (csvFilename.value.trim() || 'extracted_data') + '.csv';
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    exportNote.textContent = `Saved ${name}: ${total} point${total === 1 ? '' : 's'}.`;
  });

  // --- 10. Preview and Python export ---
  // The preview draws in a dialog on this page with the site's own copy of
  // Plotly, loaded the first time it is needed; nothing is fetched from
  // another host and no popup is opened.
  let plotlyLoading = null;
  function loadPlotly() {
    if (window.Plotly) return Promise.resolve();
    if (!plotlyLoading) {
      plotlyLoading = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'js/dependencies/plotly.min.js';
        s.onload = resolve;
        s.onerror = () => { plotlyLoading = null; reject(new Error('plotly')); };
        document.head.appendChild(s);
      });
    }
    return plotlyLoading;
  }

  const btnPreviewPlot = document.getElementById('btnPreviewPlot');
  btnPreviewPlot.addEventListener('click', async () => {
    if (!requireCalibration()) return;

    const sets = (digitisedDatasets() || []).filter(ds => ds.points.length > 0);
    if (sets.length === 0) {
      showToast('Add some points in step 3 before previewing.', 'error');
      return;
    }

    const get = (id, fb) => {
      const el = document.getElementById(id);
      return el ? (el.value || fb) : fb;
    };
    const checked = (id) => {
      const el = document.getElementById(id);
      return el ? el.checked : false;
    };

    try {
      await loadPlotly();
    } catch {
      showToast('The plotting library did not load, so the preview cannot be drawn.', 'error');
      return;
    }

    const isDark = document.documentElement.classList.contains('dark');
    const showGrid = checked('pyShowGrid');
    const grid = isDark ? '#334155' : '#e2e8f0';

    const traces = sets.map(ds => ({
      name: ds.name,
      x: sortPoints(ds.points).map(p => p.logicalX),
      y: sortPoints(ds.points).map(p => p.logicalY),
      mode: 'lines+markers',
      line: { color: ds.color },
      marker: { color: ds.color, size: 5 }
    }));

    const layout = {
      plot_bgcolor: 'transparent',
      paper_bgcolor: 'transparent',
      font: { family: 'Inter, system-ui, sans-serif', color: isDark ? '#cbd5e1' : '#334155' },
      xaxis: {
        title: get('pyXLabel', 'X'),
        type: isLogX.checked ? 'log' : 'linear',
        showgrid: showGrid, gridcolor: grid, zerolinecolor: grid
      },
      yaxis: {
        title: get('pyYLabel', 'Y'),
        type: isLogY.checked ? 'log' : 'linear',
        showgrid: showGrid, gridcolor: grid, zerolinecolor: grid
      },
      margin: { t: 40, r: 20, b: 60, l: 70 },
      showlegend: true,
      legend: { orientation: 'h', yanchor: 'bottom', y: 1.02, xanchor: 'left', x: 0 }
    };

    previewDialog.showModal();
    Plotly.react('previewPlot', traces, layout, {
      responsive: true, displaylogo: false,
      modeBarButtonsToRemove: ['lasso2d', 'select2d'],
      toImageButtonOptions: { format: 'png', filename: 'digitized_preview', scale: 2 }
    });
  });

  document.getElementById('closePreview').addEventListener('click', () => previewDialog.close());
  previewDialog.addEventListener('click', (e) => { if (e.target === previewDialog) previewDialog.close(); });

  btnGeneratePython.addEventListener('click', () => {
    if (!requireCalibration()) return;
    pythonCodeBlock.textContent = buildPythonScript();
    pythonModal.classList.add('open');
    copyPythonBtn.focus();
  });

  function buildPythonScript() {
    const get = (id, fallback) => {
      const el = document.getElementById(id);
      return el ? (el.value || fallback) : fallback;
    };
    const checked = (id) => {
      const el = document.getElementById(id);
      return el ? el.checked : false;
    };

    const xLab = get('pyXLabel', 'X');
    const yLab = get('pyYLabel', 'Y');
    const fW = get('pyFigWidth', 8);
    const fH = get('pyFigHeight', 6);
    const layout = get('pyPlotLayout', 'single');
    const showGrid = checked('pyShowGrid');
    const filename = (csvFilename.value.trim() || 'extracted_data') + '.csv';

    const active = state.datasets.filter(ds => ds.points.length > 0);

    let c = 'import pandas as pd\nimport matplotlib.pyplot as plt\n\n';
    c += "# --- 1. Environment configuration ---\n";
    c += "plt.rcParams['axes.labelsize'] = 14\n";
    c += "plt.rcParams['xtick.labelsize'] = 12\n";
    c += "plt.rcParams['ytick.labelsize'] = 12\n";
    c += "plt.rcParams['legend.fontsize'] = 12\n";
    c += "plt.rcParams['legend.frameon'] = False\n\n";
    c += '# --- 2. Data ingestion ---\n';
    c += 'try:\n';
    c += `    df = pd.read_csv('${pythonString(filename)}', skipinitialspace=True)\n`;
    c += 'except FileNotFoundError:\n';
    c += `    print("Error: ${pythonString(filename)} not found in the working directory.")\n`;
    c += '    exit()\n\n';
    c += '# --- 3. Rendering ---\n';

    if (layout === 'subplots' && active.length > 0) {
      c += `fig, axes = plt.subplots(nrows=${active.length}, ncols=1, ` +
           `figsize=(${fW}, ${fH}), sharex=True)\n`;
      c += `if ${active.length} == 1: axes = [axes]\n\n`;

      active.forEach((ds, i) => {
        const v = pythonIdentifier(ds.id);
        c += `subset_${v} = df[df['Dataset'] == '${pythonString(ds.name)}']\n`;
        c += `axes[${i}].plot(subset_${v}['X'], subset_${v}['Y'], ` +
             `label='${pythonString(ds.name)}', color='${pythonString(ds.color)}', linewidth=2)\n`;
        if (isLogX.checked) c += `axes[${i}].set_xscale('log')\n`;
        if (isLogY.checked) c += `axes[${i}].set_yscale('log')\n`;
        if (showGrid) c += `axes[${i}].grid(True, linestyle='--', alpha=0.6)\n`;
        c += `axes[${i}].legend(loc='best')\n\n`;
      });
      c += `axes[-1].set_xlabel('${pythonString(xLab)}')\n`;
      c += `fig.text(0.04, 0.5, '${pythonString(yLab)}', va='center', rotation='vertical')\n`;
    } else {
      c += `fig, ax = plt.subplots(figsize=(${fW}, ${fH}))\n\n`;
      for (const ds of active) {
        const v = pythonIdentifier(ds.id);
        c += `subset_${v} = df[df['Dataset'] == '${pythonString(ds.name)}']\n`;
        c += `ax.plot(subset_${v}['X'], subset_${v}['Y'], ` +
             `label='${pythonString(ds.name)}', color='${pythonString(ds.color)}', linewidth=2)\n`;
      }
      c += '\n';
      if (isLogX.checked) c += "ax.set_xscale('log')\n";
      if (isLogY.checked) c += "ax.set_yscale('log')\n";
      if (showGrid) c += "ax.grid(True, linestyle='--', alpha=0.6)\n";
      c += `ax.set_xlabel('${pythonString(xLab)}')\n`;
      c += `ax.set_ylabel('${pythonString(yLab)}')\n`;
      c += "ax.legend(loc='best')\n";
      c += "ax.spines['top'].set_visible(False)\nax.spines['right'].set_visible(False)\n";
    }

    c += '\nfig.tight_layout()\n';
    // The transparent-background checkbox only matters at save time, so it is
    // applied here rather than to the figure itself.
    const bgTrans = checked('pyBgTrans');
    c += `fig.savefig('digitized_plot.png', dpi=300, bbox_inches='tight'` +
         `${bgTrans ? ', transparent=True' : ''})\nplt.show()\n`;
    return c;
  }


  function closePython() {
    pythonModal.classList.remove('open');
    btnGeneratePython.focus();
  }
  closePythonModal.addEventListener('click', closePython);
  pythonModal.addEventListener('click', (e) => {
    if (e.target === pythonModal) closePython();
  });
  copyPythonBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(pythonCodeBlock.textContent)
      .then(() => showToast('Copied the matplotlib script.', 'success'))
      .catch(() => showToast('Could not reach the clipboard. Select the code and copy it.', 'error'));
  });

  // --- 11. Initial render ---
  renderDatasetUI();
  updateModeStatus();

  /**
   * Styled notification, matching the other tools.
   *
   * This replaces the native `alert()` this file used to call: a blocking
   * browser dialog interrupts the work and looks nothing like the rest of the
   * app, which matters most here because calibration warnings fire while the
   * user is mid-click on the figure.
   */
  function showToast(msg, type) {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    const colors = type === 'success'
      ? 'bg-emerald-50 text-emerald-800 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-300 dark:border-emerald-800'
      : type === 'error'
        ? 'bg-red-50 text-red-800 border-red-200 dark:bg-red-950 dark:text-red-300 dark:border-red-800'
        : 'bg-blue-50 text-blue-800 border-blue-200 dark:bg-slate-900 dark:text-blue-200 dark:border-blue-800';
    toast.className =
      `px-4 py-3 rounded-xl border shadow-lg toast-enter text-sm font-medium transition-all max-w-md ${colors}`;
    toast.innerText = msg;
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 300);
    }, 4000);
  }

});
