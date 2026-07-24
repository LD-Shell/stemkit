/**
 * Plot Digitizer | UI layer.
 *
 * Pixel-to-data mapping, calibration validation, point management, CSV
 * generation, and Python escaping live in @stemkit/core. This file handles
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
  const uploadZone = document.getElementById('uploadZone');
  const fileInput = document.getElementById('fileInput');
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

  const datasetList = document.getElementById('datasetList');
  const btnAddDataset = document.getElementById('btnAddDataset');
  const btnManualMode = document.getElementById('btnManualMode');
  const btnEraseMode = document.getElementById('btnEraseMode');
  const eraseControls = document.getElementById('eraseControls');
  const eraseRadiusSlider = document.getElementById('eraseRadius');
  const eraseRadiusVal = document.getElementById('eraseRadiusVal');
  const btnUndo = document.getElementById('btnUndo');
  const toggleBackground = document.getElementById('toggleBackground');
  const eyeIcon = document.getElementById('eyeIcon');
  const csvFilename = document.getElementById('csvFilename');
  const exportCsvBtn = document.getElementById('exportCsvBtn');
  const btnZoomIn = document.getElementById('btnZoomIn');
  const btnZoomOut = document.getElementById('btnZoomOut');
  const zoomLevelDisplay = document.getElementById('zoomLevel');
  const resolutionNote = document.getElementById('resolutionNote');

  const btnGeneratePython = document.getElementById('btnGeneratePython');
  const pythonModal = document.getElementById('pythonModal');
  const pythonCodeBlock = document.getElementById('pythonCodeBlock');
  const closePythonModal = document.getElementById('closePythonModal');
  const copyPythonBtn = document.getElementById('copyPythonBtn');

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
    canvas.style.width = `${state.image.width * state.zoomLevel}px`;
    if (zoomLevelDisplay) {
      zoomLevelDisplay.innerText = `${Math.round(state.zoomLevel * 100)}%`;
    }
  }

  if (btnZoomIn) btnZoomIn.addEventListener('click', () => {
    state.zoomLevel = Math.min(state.zoomLevel + 0.25, 5);
    applyZoom();
  });
  if (btnZoomOut) btnZoomOut.addEventListener('click', () => {
    state.zoomLevel = Math.max(state.zoomLevel - 0.25, 0.5);
    applyZoom();
  });

  // Ctrl/Cmd + wheel zooms the figure. The modifier is required so plain
  // scrolling still pans a large image rather than surprising the user.
  const canvasContainer = document.getElementById('canvasContainer');
  if (canvasContainer) canvasContainer.addEventListener('wheel', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const step = e.deltaY < 0 ? 0.1 : -0.1;
    state.zoomLevel = Math.min(5, Math.max(0.5, state.zoomLevel + step));
    applyZoom();
  }, { passive: false });

  document.querySelectorAll('.accordion-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const expanded = btn.getAttribute('aria-expanded') === 'true';
      btn.setAttribute('aria-expanded', !expanded);
      const target = document.getElementById(btn.getAttribute('data-target'));
      if (target) target.classList.toggle('expanded');
    });
  });

  // --- 4. Image intake ---
  uploadZone.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file || !file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const img = new Image();
      img.onload = () => {
        state.image = img;
        canvas.width = img.width;
        canvas.height = img.height;
        uploadZone.classList.add('hidden');
        workspace.classList.remove('hidden');
        workspace.classList.add('flex');
        applyZoom();
        renderViewport();
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
  });

  // --- 5. Calibration and mode ---
  const CALIB_BUTTONS = {
    btnCalibX1: 'pxX1', btnCalibX2: 'pxX2',
    btnCalibY1: 'pxY1', btnCalibY2: 'pxY2'
  };

  Object.entries(CALIB_BUTTONS).forEach(([id, key]) => {
    const btn = document.getElementById(id);
    if (btn) btn.addEventListener('click', () => setMode(`calib:${key}`, btn));
  });

  if (btnManualMode) btnManualMode.addEventListener('click', () => {
    if (!requireCalibration()) return;
    setMode('digitize', btnManualMode);
  });

  if (btnEraseMode) btnEraseMode.addEventListener('click', () => {
    setMode(state.mode === 'erase' ? 'idle' : 'erase', btnEraseMode);
  });

  if (eraseRadiusSlider) eraseRadiusSlider.addEventListener('input', (e) => {
    state.eraseRadius = parseInt(e.target.value, 10) || 10;
    if (eraseRadiusVal) eraseRadiusVal.innerText = state.eraseRadius;
    renderViewport();
  });

  function setMode(newMode, activeBtn) {
    state.mode = newMode;
    document.querySelectorAll('[data-modebtn]').forEach(b =>
      b.classList.toggle('active', b === activeBtn));
    if (eraseControls) {
      eraseControls.classList.toggle('hidden', newMode !== 'erase');
    }
    canvas.style.cursor = newMode === 'idle' ? 'default' : 'crosshair';
    renderViewport();
  }

  /** Validate the calibration through the core and report any problem. */
  function requireCalibration() {
    const r = validateCalibrationForm(currentCalibration());
    if (!r.valid) {
      showToast(r.errors.join(' '), 'error');
      return false;
    }
    if (r.warnings.length && resolutionNote) {
      resolutionNote.textContent = r.warnings.join(' ');
      resolutionNote.classList.remove('hidden');
    }
    updateResolutionNote(r.calibration);
    return true;
  }

  /**
   * Report the data-space uncertainty of a one-pixel click error.
   *
   * The precision of a digitised point is set by the resolution of the figure,
   * not by the number of decimals the export happens to print, so this is
   * shown rather than left implicit.
   */
  function updateResolutionNote(calibration) {
    if (!resolutionNote) return;
    const res = pixelResolution(calibration);
    if (!res) return;
    resolutionNote.textContent =
      `One pixel ≈ ${formatValue(res.dx)} in x, ${formatValue(res.dy)} in y. ` +
      `Digitised values are no more precise than this.`;
    resolutionNote.classList.remove('hidden');
  }

  // --- 6. Datasets ---
  if (btnAddDataset) btnAddDataset.addEventListener('click', () => {
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
    renderViewport();
  });

  function renderDatasetUI() {
    if (!datasetList) return;
    datasetList.innerHTML = '';

    state.datasets.forEach(ds => {
      const active = ds.id === state.activeDatasetId;
      const row = document.createElement('div');
      row.className =
        'flex items-center gap-2 p-2 rounded-lg border cursor-pointer transition-colors ' +
        (active
          ? 'bg-indigo-50 dark:bg-indigo-900/20 border-indigo-300 dark:border-indigo-700'
          : 'border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800');

      const swatch = document.createElement('span');
      swatch.className = 'w-3 h-3 rounded-full shrink-0';
      swatch.style.backgroundColor = ds.color;

      const name = document.createElement('input');
      name.type = 'text';
      name.value = ds.name;
      name.className = 'flex-1 bg-transparent text-xs font-bold outline-none';
      name.addEventListener('click', e => e.stopPropagation());
      name.addEventListener('input', e => { ds.name = e.target.value; });

      const count = document.createElement('span');
      count.className = 'text-[10px] text-slate-400 font-mono';
      count.textContent = `${ds.points.length} pts`;

      row.append(swatch, name, count);
      row.addEventListener('click', () => {
        state.activeDatasetId = ds.id;
        renderDatasetUI();
        renderViewport();
      });
      datasetList.appendChild(row);
    });
  }

  if (btnUndo) btnUndo.addEventListener('click', () => {
    const ds = getActiveDataset();
    if (ds && ds.points.length) {
      ds.points.pop();
      renderDatasetUI();
      renderViewport();
    }
  });

  if (toggleBackground) toggleBackground.addEventListener('click', () => {
    state.showBackground = !state.showBackground;
    if (eyeIcon) {
      eyeIcon.className = state.showBackground
        ? 'fa-solid fa-eye' : 'fa-solid fa-eye-slash';
    }
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

  canvas.addEventListener('mousemove', (e) => {
    const p = canvasCoords(e);
    state.mouseX = p.x;
    state.mouseY = p.y;

    if (state.isDragging && state.mode === 'erase') {
      applyErase(p.x, p.y);
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
      setMode('idle', null);
      const check = validateCalibrationForm(currentCalibration());
      if (check.valid) updateResolutionNote(check.calibration);
      return;
    }

    if (state.mode === 'digitize') {
      const ds = getActiveDataset();
      if (ds) {
        ds.points.push({ pxX: p.x, pxY: p.y });
        renderDatasetUI();
      }
      return;
    }

    if (state.mode === 'erase') applyErase(p.x, p.y);
  });

  canvas.addEventListener('mouseup', () => {
    state.isDragging = false;
    state.lastTracePoint = null;
  });

  canvas.addEventListener('mouseleave', () => {
    state.isDragging = false;
    state.lastTracePoint = null;
    if (loupe) loupe.classList.add('hidden');
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

  if (exportCsvBtn) exportCsvBtn.addEventListener('click', () => {
    if (!requireCalibration()) return;
    const datasets = digitisedDatasets();
    if (!datasets) return;

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
  });

  // --- 10. Python export ---
  const btnPreviewPlot = document.getElementById('btnPreviewPlot');
  if (btnPreviewPlot) btnPreviewPlot.addEventListener('click', () => {
    if (!requireCalibration()) return;

    const sets = (digitisedDatasets() || []).filter(ds => ds.points.length > 0);
    if (sets.length === 0) {
      showToast('Add some points before previewing.', 'error');
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

    const isDark = document.documentElement.classList.contains('dark');
    const fW = Number(get('pyFigWidth', 8)) * 100;
    const showGrid = checked('pyShowGrid');
    const transparent = checked('pyBgTrans');

    const traces = sets.map(ds => ({
      name: ds.name,
      x: ds.points.map(p => p.logicalX),
      y: ds.points.map(p => p.logicalY),
      mode: 'lines+markers',
      marker: { color: ds.color }
    }));

    const layout = {
      plot_bgcolor: isDark ? '#1e293b' : (transparent ? 'transparent' : '#ffffff'),
      paper_bgcolor: 'transparent',
      font: { color: isDark ? '#cbd5e1' : '#334155' },
      xaxis: {
        title: get('pyXLabel', 'X'),
        type: isLogX && isLogX.checked ? 'log' : 'linear',
        showgrid: showGrid, gridcolor: isDark ? '#334155' : '#e2e8f0'
      },
      yaxis: {
        title: get('pyYLabel', 'Y'),
        type: isLogY && isLogY.checked ? 'log' : 'linear',
        showgrid: showGrid, gridcolor: isDark ? '#334155' : '#e2e8f0'
      },
      margin: { t: 40, r: 40, b: 60, l: 60 },
      showlegend: true
    };

    // Rendered in a popup so the digitising canvas keeps its state.
    const win = window.open('', '_blank');
    if (!win) {
      showToast('Popup blocked, allow popups for this site to see the preview.', 'error');
      return;
    }
    win.document.write(
      '<!DOCTYPE html><html' + (isDark ? ' class="dark"' : '') + '><head>' +
      '<title>Plot Preview | STEMKit</title>' +
      '<script src="https://cdn.plot.ly/plotly-2.32.0.min.js"><\/script>' +
      '<style>body{margin:0;padding:20px;font-family:sans-serif;background:' +
      (isDark ? '#0f172a' : '#f8fafc') + ';color:' + (isDark ? '#f1f5f9' : '#0f172a') +
      '}.container{max-width:' + (fW + 40) + 'px;margin:0 auto;background:' +
      (isDark ? '#1e293b' : '#fff') + ';padding:20px;border-radius:12px;' +
      'border:1px solid ' + (isDark ? '#334155' : '#e2e8f0') + '}</style></head><body>' +
      '<div class="container"><h2 style="margin-top:0">Interactive Render Preview</h2>' +
      '<div id="plot"></div></div><script>' +
      'Plotly.newPlot("plot",' + JSON.stringify(traces) + ',' + JSON.stringify(layout) + ');' +
      '<\/script></body></html>'
    );
    win.document.close();
  });

  if (btnGeneratePython) btnGeneratePython.addEventListener('click', () => {
    if (!requireCalibration()) return;
    pythonCodeBlock.textContent = buildPythonScript();
    pythonModal.classList.add('open');
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

  if (closePythonModal) closePythonModal.addEventListener('click', () =>
    pythonModal.classList.remove('open'));
  if (pythonModal) pythonModal.addEventListener('click', (e) => {
    if (e.target === pythonModal) pythonModal.classList.remove('open');
  });
  if (copyPythonBtn) copyPythonBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(pythonCodeBlock.textContent);
  });

  // --- 11. Initial render ---
  renderDatasetUI();

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
      ? 'bg-emerald-50 text-emerald-800 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-400'
      : type === 'error'
        ? 'bg-red-50 text-red-800 border-red-200 dark:bg-red-900/30 dark:text-red-400'
        : 'bg-indigo-50 text-indigo-800 border-indigo-200 dark:bg-indigo-900/30 dark:text-indigo-400';
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
