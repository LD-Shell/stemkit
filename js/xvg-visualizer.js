/**
 * XVG Visualizer | UI layer.
 *
 * Reading the file, the figure's description and its matplotlib script live
 * in the core (src/core/xvg-parser.js). The plot area, the style panel, the
 * exports and the Python panel are the site's shared figure (mountFigure in
 * js/figure-plot.js), as on the Curve Fitter. This file wires the page: the
 * file, the columns, the running mean and the switches.
 */
import {
  parseXvg,
  defaultActiveColumns,
  generateSampleXvg,
  xvgFigure,
  xvgFigureScript,
  xvgColors,
  graceToPlain,
  averageWindow
} from '../src/core/xvg-parser.js';
import { mountFigure } from './figure-plot.js';

const STYLE_KEY = 'stemkit.xvg-visualizer.figure';
const VIEW_KEY = 'stemkit.xvg-visualizer.view';
// Past this many numbers the script reads the file even when asked to hold
// them: a script with every number of a long trajectory is megabytes long.
const EMBED_LIMIT = 60000;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const load = (key) => { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { return null; } };
const save = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* storage blocked */ } };

document.addEventListener('DOMContentLoaded', () => {

  /* ------------------------------------------------------------------ *
   * State
   * ------------------------------------------------------------------ */
  const saved = load(VIEW_KEY) || {};
  const state = {
    parsed: null,
    fileName: '',
    xIndex: 0,
    active: new Set(),
    lower: new Set(),
    markers: !!saved.markers,
    average: !!saved.average,
    window: Number.isInteger(saved.window) && saved.window >= 2 ? saved.window : 10,
    raw: saved.raw !== false,
    logY: false
  };
  const saveView = () => save(VIEW_KEY, { markers: state.markers, average: state.average, window: state.window, raw: state.raw });

  const $ = (id) => document.getElementById(id);
  const ui = {
    main: $('main'),
    uploadWrap: $('uploadWrap'),
    uploadZone: $('uploadZone'),
    fileInput: $('fileInput'),
    chooseFile: $('chooseFileBtn'),
    sample: $('loadSampleXvg'),
    workspace: $('workspace'),
    rail: $('xvRail'),
    fileName: $('xvFileName'),
    fileStats: $('fileStats'),
    openAnother: $('btnOpenAnother'),
    close: $('btnCloseWorkspace'),
    tabs: Array.from(document.querySelectorAll('.xv-tab')),
    tabDataInfo: $('xvTabDataInfo'),
    xSelect: $('xColSelect'),
    seriesList: $('yColContainer'),
    toggleAll: $('btnToggleAll'),
    average: $('xvAverage'),
    averageOpts: $('xvAverageOpts'),
    window: $('xvWindow'),
    raw: $('xvRaw'),
    styleHost: $('xvStyleHost'),
    plot: $('xvPlot'),
    emptyTitle: $('xvEmptyTitle'),
    emptyText: $('xvEmptyText'),
    markers: $('plotMarkers'),
    logY: $('plotLogY'),
    python: $('xvPython')
  };
  const narrow = window.matchMedia('(max-width: 1023.98px)');

  /* ------------------------------------------------------------------ *
   * The plot area: the shared figure
   * ------------------------------------------------------------------ */
  const headHeight = () => {
    const nav = document.querySelector('nav');
    return nav ? nav.getBoundingClientRect().height : 0;
  };
  const syncHead = () => ui.workspace.style.setProperty('--xv-head', `${Math.round(headHeight())}px`);

  /* Beside the rail the whole figure fits under the site header, so it stays
     in view while the settings change; stacked, it may be as wide as the page. */
  function previewMaxScale() {
    if (narrow.matches) return 2;
    const f = plot && plot.figure();
    const tall = (f ? f.height : 4.8) * 96;
    const room = window.innerHeight - headHeight() - 96;
    return Math.max(0.3, Math.min(2, room / tall));
  }

  let embedRefused = false;
  const valuesInScript = (fig) => {
    let n = 0;
    const cols = new Set();
    fig.panels.forEach((p) => p.series.forEach((q) => {
      if (!q.show || !q.refs) return;
      for (const k of ['x', 'y']) if (q.refs[k] && q.refs[k].source === 'xvg') cols.add(q.refs[k].column);
    }));
    n = cols.size * (state.parsed ? state.parsed.rowCount : 0);
    return n;
  };

  function scriptFor(fig, source) {
    embedRefused = source === 'embed' && valuesInScript(fig) > EMBED_LIMIT;
    return xvgFigureScript(fig, state.parsed, { source: embedRefused ? 'files' : source, filename: state.fileName || 'your_file.xvg' });
  }

  function scriptNote(fig, source) {
    const py = `${fig.export.filename}.py`;
    const out = `${fig.export.filename}.${fig.export.format}`;
    const needs = `Runs with Python 3, numpy and matplotlib 3.6 or later: <code>python ${esc(py)}</code>. `;
    const reads = `It reads <code>${esc(state.fileName)}</code> from the same folder and saves <code>${esc(out)}</code>.`;
    if (source === 'embed' && embedRefused) {
      const rows = state.parsed ? state.parsed.rowCount.toLocaleString('en-GB') : '';
      return `${needs}This file has ${rows} rows, too many numbers to hold in the script, so it reads the file instead. ${reads}`;
    }
    if (source === 'embed') return `${needs}It holds the numbers it draws and saves <code>${esc(out)}</code>.`;
    return needs + reads;
  }

  const plot = mountFigure(ui.plot, {
    style: load(STYLE_KEY) || {},
    styleHost: ui.styleHost,
    onStyle: () => selectTab('style', { focus: true, reveal: true }),
    onStyleChange: (style) => {
      save(STYLE_KEY, style);
      state.logY = allLog(style);
      ui.logY.checked = state.logY;
      // A colour or a background the person picks moves the swatches, and the
      // running mean follows its series' colour.
      if (JSON.stringify(currentColors()) !== lastColors) redraw();
    },
    maxScale: previewMaxScale,
    label: 'The plot of the chosen columns, as the saved figure will look',
    python: {
      host: ui.python,
      sources: [{ id: 'files', label: 'Read the file' }, { id: 'embed', label: 'Data in the script' }],
      script: scriptFor,
      note: scriptNote
    }
  });
  state.logY = allLog(plot.getStyle());
  ui.logY.checked = state.logY;

  /* ------------------------------------------------------------------ *
   * The switches in the plot's header
   * ------------------------------------------------------------------ */
  ui.markers.checked = state.markers;
  ui.markers.addEventListener('change', () => { state.markers = ui.markers.checked; saveView(); redraw(); });

  /* Log y is the person's style for every panel's y axis, so the style
     panel and this switch always agree. */
  function panelCount() {
    const f = plot.figure();
    return f ? f.panels.length : 1;
  }
  function allLog(style) {
    const panels = (style && style.panels) || [];
    const n = Math.max(1, panelCount());
    for (let i = 0; i < n; i++) if (!panels[i] || panels[i].yScale !== 'log') return false;
    return true;
  }
  function applyLog(on, n = panelCount()) {
    const style = plot.getStyle();
    const panels = Array.isArray(style.panels) ? style.panels.slice() : [];
    for (let i = 0; i < Math.max(n, panels.length); i++) {
      const p = { ...(panels[i] || {}) };
      if (on) p.yScale = 'log'; else delete p.yScale;
      panels[i] = p;
    }
    style.panels = panels;
    plot.setStyle(style);
    save(STYLE_KEY, plot.getStyle());
  }
  ui.logY.addEventListener('change', () => { state.logY = ui.logY.checked; applyLog(state.logY); });

  /* ------------------------------------------------------------------ *
   * Tabs: Data and Style
   * ------------------------------------------------------------------ */
  function selectTab(name, { focus = false, reveal = false } = {}) {
    ui.tabs.forEach((t) => {
      const on = t.dataset.tab === name;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      $(t.getAttribute('aria-controls')).hidden = !on;
      if (on && focus) t.focus({ preventScroll: true });
    });
    if (reveal && narrow.matches) ui.rail.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
  ui.tabs.forEach((t, i) => {
    t.addEventListener('click', () => selectTab(t.dataset.tab));
    t.addEventListener('keydown', (e) => {
      const n = ui.tabs.length;
      const to = { ArrowRight: i + 1, ArrowLeft: i - 1 + n, Home: 0, End: n - 1 }[e.key];
      if (to === undefined) return;
      e.preventDefault();
      selectTab(ui.tabs[to % n].dataset.tab, { focus: true });
    });
  });

  /* ------------------------------------------------------------------ *
   * The file
   * ------------------------------------------------------------------ */
  ['dragenter', 'dragover'].forEach((evt) => ui.uploadZone.addEventListener(evt, (e) => {
    e.preventDefault();
    ui.uploadZone.classList.add('is-over');
  }));
  ui.uploadZone.addEventListener('dragleave', (e) => {
    if (!ui.uploadZone.contains(e.relatedTarget)) ui.uploadZone.classList.remove('is-over');
  });
  ui.uploadZone.addEventListener('drop', (e) => {
    e.preventDefault();
    ui.uploadZone.classList.remove('is-over');
    if (e.dataTransfer.files.length > 0) readFile(e.dataTransfer.files[0]);
  });
  ui.uploadZone.addEventListener('click', (e) => {
    if (!e.target.closest('button')) ui.fileInput.click();
  });
  ui.chooseFile.addEventListener('click', () => ui.fileInput.click());
  ui.openAnother.addEventListener('click', () => ui.fileInput.click());
  ui.fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) readFile(e.target.files[0]);
    ui.fileInput.value = '';
  });
  // A file dropped on the open workspace replaces the one in it.
  ['dragover', 'drop'].forEach((evt) => ui.workspace.addEventListener(evt, (e) => {
    if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
    e.preventDefault();
    if (evt === 'drop' && e.dataTransfer.files.length > 0) readFile(e.dataTransfer.files[0]);
  }));

  // A synthetic GROMACS RMSD and radius-of-gyration .xvg made by the core.
  ui.sample.addEventListener('click', () => {
    openWorkspace();
    loadText(generateSampleXvg({ seed: Date.now() >>> 0 }), 'sample_rmsd.xvg');
  });

  ui.close.addEventListener('click', () => {
    state.parsed = null;
    state.fileName = '';
    plot.update(null);
    ui.workspace.hidden = true;
    ui.uploadWrap.hidden = false;
    ui.main.classList.remove('is-loaded');
    window.scrollTo(0, 0);
    ui.chooseFile.focus();
  });

  /* Swap the loader for the workspace. */
  function openWorkspace() {
    const opening = ui.workspace.hidden;
    ui.main.classList.add('is-loaded');
    ui.uploadWrap.hidden = true;
    ui.workspace.hidden = false;
    syncHead();
    // From the loader, the page starts again at the top: the one-line head,
    // then the workspace. A file dropped on the open workspace keeps the place.
    if (opening) window.scrollTo(0, 0);
  }

  function readFile(file) {
    openWorkspace();
    ui.fileName.textContent = file.name;
    ui.fileStats.textContent = 'Reading the file…';
    ui.workspace.setAttribute('aria-busy', 'true');
    const reader = new FileReader();
    reader.onload = (e) => loadText(e.target.result, file.name);
    reader.onerror = () => {
      ui.workspace.removeAttribute('aria-busy');
      ui.fileStats.textContent = `${file.name} could not be read.`;
    };
    reader.readAsText(file);
  }

  function loadText(text, filename) {
    // Parsing a long trajectory takes a moment: let the page say so first.
    ui.workspace.setAttribute('aria-busy', 'true');
    setTimeout(() => {
      const parsed = parseXvg(text, { fallbackTitle: filename });
      ui.workspace.removeAttribute('aria-busy');
      state.parsed = parsed;
      state.fileName = filename;
      state.xIndex = 0;
      state.active = new Set(defaultActiveColumns(parsed.colCount));
      state.active.delete(0);
      state.lower = new Set();
      // Labels the person typed belong to the last file; the rest of their look stays.
      plot.setStyle(withoutText(plot.getStyle()));
      save(STYLE_KEY, plot.getStyle());

      ui.fileName.textContent = filename;
      ui.fileName.title = filename;
      if (parsed.rowCount === 0) {
        ui.fileStats.textContent = 'No rows of numbers to plot.';
        ui.xSelect.innerHTML = '';
        ui.seriesList.innerHTML = '';
        state.parsed = null;
        redraw();
        return;
      }
      const skipped = parsed.skippedLines > 0
        ? `, ${parsed.skippedLines.toLocaleString('en-GB')} line${parsed.skippedLines === 1 ? '' : 's'} skipped` : '';
      ui.fileStats.textContent = `${parsed.rowCount.toLocaleString('en-GB')} rows, ${parsed.colCount} columns${skipped}`;
      ui.window.max = String(parsed.rowCount);
      buildControls();
      redraw();
    }, 20);
  }

  /* The style without the text the person typed for the last file. */
  function withoutText(style) {
    const s = JSON.parse(JSON.stringify(style || {}));
    delete s.title;
    delete s.xLabel;
    if (s.legend) delete s.legend.title;
    if (Array.isArray(s.panels)) s.panels.forEach((p) => { if (p) delete p.yLabel; });
    if (s.series) Object.values(s.series).forEach((q) => { if (q) delete q.label; });
    return s;
  }

  /* ------------------------------------------------------------------ *
   * Columns
   * ------------------------------------------------------------------ */
  const colName = (i) => graceToPlain((state.parsed && state.parsed.headers[i]) || `Column ${i}`);

  function buildControls() {
    const p = state.parsed;
    ui.xSelect.innerHTML = '';
    for (let i = 0; i < p.colCount; i++) {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = `${colName(i)} (column ${i})`;
      ui.xSelect.appendChild(opt);
    }
    ui.xSelect.value = String(state.xIndex);
    renderSeriesList();
  }

  ui.xSelect.addEventListener('change', () => {
    state.xIndex = parseInt(ui.xSelect.value, 10) || 0;
    // The x column cannot also be a series against itself.
    state.active.delete(state.xIndex);
    state.lower.delete(state.xIndex);
    renderSeriesList();
    redraw();
  });

  /** One row per column except the x column: tick to plot, and the lower-panel switch. */
  function renderSeriesList() {
    const p = state.parsed;
    ui.seriesList.innerHTML = '';
    if (!p) return;
    for (let i = 0; i < p.colCount; i++) {
      if (i === state.xIndex) continue;
      const row = document.createElement('div');
      row.className = 'xv-series';
      row.dataset.col = String(i);
      row.innerHTML = `
        <label class="xv-series-main">
          <input type="checkbox" value="${i}">
          <span class="xv-swatch" aria-hidden="true"></span>
          <span class="xv-series-name" title="${esc(colName(i))}">${esc(colName(i))}</span>
          <span class="xv-colno">col ${i}</span>
        </label>
        <button type="button" class="xv-axis-btn" aria-pressed="false" title="Draw this series in a second panel, under the others">Lower panel</button>`;
      const box = row.querySelector('input');
      const lowerBtn = row.querySelector('.xv-axis-btn');
      lowerBtn.setAttribute('aria-label', `Draw ${colName(i)} in the lower panel`);
      box.addEventListener('change', () => {
        if (box.checked) state.active.add(i);
        else { state.active.delete(i); state.lower.delete(i); }
        syncSeriesList();
        redraw();
      });
      lowerBtn.addEventListener('click', () => {
        if (state.lower.has(i)) state.lower.delete(i); else state.lower.add(i);
        syncSeriesList();
        redraw();
      });
      ui.seriesList.appendChild(row);
    }
    syncSeriesList();
  }

  function syncSeriesList() {
    const colors = currentColors();
    ui.seriesList.querySelectorAll('.xv-series').forEach((row) => {
      const i = Number(row.dataset.col);
      const on = state.active.has(i);
      row.classList.toggle('is-on', on);
      row.querySelector('input').checked = on;
      row.querySelector('.xv-swatch').style.backgroundColor = colors[i] || 'transparent';
      const btn = row.querySelector('.xv-axis-btn');
      btn.hidden = !on;
      btn.setAttribute('aria-pressed', String(state.lower.has(i)));
    });
    const ids = selectable();
    ui.toggleAll.textContent = ids.length && ids.every((i) => state.active.has(i)) ? 'Clear all' : 'Select all';
    ui.tabDataInfo.textContent = state.parsed ? String(state.active.size) : '';
    ui.tabDataInfo.title = `${state.active.size} series plotted`;
  }

  const selectable = () => {
    const out = [];
    for (let i = 0; i < (state.parsed ? state.parsed.colCount : 0); i++) if (i !== state.xIndex) out.push(i);
    return out;
  };

  // Select all / Clear all changes the state once and draws once.
  ui.toggleAll.addEventListener('click', () => {
    const ids = selectable();
    if (ids.length && ids.every((i) => state.active.has(i))) { state.active.clear(); state.lower.clear(); } else ids.forEach((i) => state.active.add(i));
    syncSeriesList();
    redraw();
  });

  /* ------------------------------------------------------------------ *
   * Running mean
   * ------------------------------------------------------------------ */
  ui.average.checked = state.average;
  ui.window.value = String(state.window);
  ui.raw.checked = state.raw;
  ui.averageOpts.hidden = !state.average;
  ui.average.addEventListener('change', () => {
    state.average = ui.average.checked;
    ui.averageOpts.hidden = !state.average;
    saveView();
    redraw();
  });
  let windowTimer = null;
  ui.window.addEventListener('input', () => {
    clearTimeout(windowTimer);
    windowTimer = setTimeout(() => {
      const n = Math.round(Number(ui.window.value));
      if (!(n >= 2)) return;
      state.window = n;
      saveView();
      redraw();
    }, 200);
  });
  ui.window.addEventListener('change', () => {
    const rows = state.parsed ? state.parsed.rowCount : Infinity;
    const n = Math.min(Math.max(2, Math.round(Number(ui.window.value)) || 2), Math.max(2, rows));
    ui.window.value = String(n);
    state.window = n;
    saveView();
    redraw();
  });
  ui.raw.addEventListener('change', () => { state.raw = ui.raw.checked; saveView(); redraw(); });

  /* ------------------------------------------------------------------ *
   * Drawing
   * ------------------------------------------------------------------ */
  /* Each column's colour: the person's, else the cycle's for the figure's background. */
  function currentColors() {
    const p = state.parsed;
    if (!p) return {};
    const style = plot.getStyle();
    const colors = xvgColors(p.colCount, state.xIndex, style.background || '#ffffff');
    const own = style.series || {};
    for (const i of Object.keys(colors)) {
      const c = own[`col${i}`] && own[`col${i}`].color;
      if (typeof c === 'string' && c) colors[i] = c;
    }
    return colors;
  }
  let lastColors = '';

  function redraw() {
    const p = state.parsed;
    const colors = currentColors();
    lastColors = JSON.stringify(colors);
    syncSeriesList();
    const series = [...state.active].sort((a, b) => a - b);
    const fig = p ? xvgFigure(p, {
      xIndex: state.xIndex,
      series,
      lower: [...state.lower],
      markers: state.markers,
      average: state.average ? state.window : 0,
      raw: state.raw,
      colors,
      filename: state.fileName
    }) : null;
    if (!fig) {
      ui.emptyTitle.textContent = p ? 'Tick a series to plot it' : 'This file has no rows of numbers';
      ui.emptyText.textContent = p ? 'Choose the columns under Data, on the left.' : 'Open another file: an .xvg, or a table of numbers in columns.';
    }
    const before = panelCount();
    const after = fig ? fig.panels.length : before;
    // A new panel takes the log scale the switch shows.
    if (fig && after !== before && state.logY) {
      plot.update(fig);
      applyLog(true, after);
      return;
    }
    plot.update(fig);
    if (state.average && p) {
      const w = averageWindow(state.window, p.rowCount);
      if (w !== state.window && String(w) !== ui.window.value) ui.window.value = String(w);
    }
  }

  window.addEventListener('resize', () => { if (!ui.workspace.hidden) syncHead(); });
});
