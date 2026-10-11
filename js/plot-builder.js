/*
 * Plot Builder: columns from CSV files in, a publication figure out.
 *
 * The page keeps the files and the series (which file and columns each one
 * plots, and how); src/core/plot-builder.js reads the files as the script
 * will and turns the series into a figure description; the shared plot area
 * (mountFigure in js/figure-plot.js) draws it at its saved size, holds the
 * Style panel in the Style tab, saves PDF, PNG and SVG, and writes the
 * matplotlib script into the Python panel under the plot, reading each CSV
 * by its column names (or with the numbers in the script).
 *
 * The look the person sets is the Style panel's, laid over the description,
 * so new files and series keep it. Its house-style part (size, fonts, frame,
 * ticks, grid, legend, export) is kept for the next visit; titles, labels,
 * limits and each series' look belong to this figure and are not.
 *
 * On top of the shared preview the page adds its own pointer tools: drag
 * across a panel to zoom (the limits go into the style, so the exports and
 * the script show the same), double-click to fit again, and point at a
 * marker to read its values. They work in every panel of a grid and in an
 * inset, where a drag sets what the inset shows.
 *
 * The Layout section under the series sets where the panels go: the rows and
 * columns of the grid, which panels share their axes, and the insets (kept
 * with the files and series); the gap between panels and their letters are
 * look, kept in the style for as long as the figure is on the page. They are
 * not part of the look kept for the next visit, which is the house style.
 */
import { mountFigure } from './figure-plot.js';
import { formatSize, WHISKER_RULES, isStack } from '../src/core/figure.js';
import {
  readTable, builderFigure, pythonFiles, seriesNote, houseStyle, exampleCsv, EXAMPLE_LABELS,
  sourceId, columnName, slug, DRAW_MODES, CHART_KINDS, suggestColumns, DEFAULT_BINS, DEFAULT_BINS_2D, DEFAULT_LEVELS, axisChoices,
  histogramOptions, LEVELS, EXAMPLES, builderExample, builderLayout, builderPanels, MAX_GRID_ROWS, MAX_GRID_COLS, MAX_INSETS
} from '../src/core/plot-builder.js';

const STYLE_KEY = 'stemkit.plot-builder.style';
const TAB_KEY = 'stemkit.plot-builder.tab';
const MAX_BYTES = 50e6;

const $ = (id) => document.getElementById(id);
const ui = {
  workspace: $('pbWorkspace'), rail: $('pbRail'),
  tabs: Array.from(document.querySelectorAll('.pb-tab')),
  tabDataInfo: $('pbTabDataInfo'), tabSeriesInfo: $('pbTabSeriesInfo'),
  fileInput: $('pbFile'), openFiles: $('pbOpenFiles'), drop: $('pbDrop'), files: $('pbFiles'),
  addSeries: $('pbAddSeries'), seriesEmpty: $('pbSeriesEmpty'), seriesList: $('pbSeriesList'),
  styleHost: $('pbStyleHost'), stylePane: $('pbStyle'),
  plot: $('pbPlot'), size: $('pbSize'), figure: $('pbFigure'), notes: $('pbPlotNotes'), hint: $('pbHint'),
  logX: $('pbLogX'), logXWrap: $('pbLogXWrap'), logY: $('pbLogY'), logYWrap: $('pbLogYWrap'),
  python: $('pbPython'), toasts: $('pbToasts'),
  example: $('pbExample'), tryExample: $('pbTryExample'), reset: $('pbReset'),
  examples: $('pbExamples'), examplesPanel: $('pbExamplesPanel'), examplesList: $('pbExamplesList'),
  examplesConfirm: $('pbExamplesConfirm'), examplesAsk: $('pbExamplesAsk'), examplesYes: $('pbExamplesYes'), examplesNo: $('pbExamplesNo'),
  layout: $('pbLayout'), layoutSum: $('pbLayoutSum'), rows: $('pbRows'), cols: $('pbCols'), shareX: $('pbShareX'), shareY: $('pbShareY'),
  gapH: $('pbGapH'), gapW: $('pbGapW'), gapWField: $('pbGapWField'), letters: $('pbLetters'), letterStyle: $('pbLetterStyle'),
  letterStyleField: $('pbLetterStyleField'), letterPlace: $('pbLetterPlace'), letterPlaceField: $('pbLetterPlaceField'),
  addInset: $('pbAddInset'), insets: $('pbInsets')
};
const narrow = window.matchMedia('(max-width: 1023.98px)');

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */

const emptyLayout = () => ({ rows: 1, cols: 1, sharex: null, sharey: 'none', insets: [] });
const state = { files: [], series: [], layout: emptyLayout() };
let nextSeries = 1;
let nextInset = 1;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fileById = (id) => state.files.find((f) => f.id === id);
const seriesById = (id) => state.series.find((s) => s.id === id);
const plural = (n, word) => `${n.toLocaleString('en-GB')} ${word}${n === 1 ? '' : 's'}`;
const short = (v, d = 4) => (Number.isFinite(v) ? String(Number(v.toPrecision(d))) : String(v));

function toast(message, kind = '') {
  const t = document.createElement('div');
  t.className = 'stk-toast' + (kind ? ` stk-toast-${kind}` : '');
  t.setAttribute('role', kind === 'danger' ? 'alert' : 'status');
  const icon = kind === 'danger' ? 'fa-circle-exclamation' : kind === 'ok' ? 'fa-circle-check' : kind === 'warn' ? 'fa-triangle-exclamation' : 'fa-circle-info';
  t.innerHTML = `<i class="fa-solid ${icon}" aria-hidden="true"></i><span></span>`;
  t.querySelector('span').textContent = message;
  ui.toasts.appendChild(t);
  setTimeout(() => t.remove(), kind === 'danger' || kind === 'warn' ? 6000 : 3600);
}

/* ------------------------------------------------------------------ *
 * The person's look
 * ------------------------------------------------------------------ */

function storedStyle() {
  try { return JSON.parse(localStorage.getItem(STYLE_KEY) || '{}') || {}; } catch (e) { return {}; }
}
function saveStyle(style) {
  try { localStorage.setItem(STYLE_KEY, JSON.stringify(houseStyle(style))); } catch (e) { /* storage blocked */ }
}

/* ------------------------------------------------------------------ *
 * The plot area
 * ------------------------------------------------------------------ */

const pyFiles = {};
let plot = null;
/* Where the script reads the data: what the person chose, but "Data in the
   script" while every file in use is an example, whose numbers are always
   written into it. */
let chosenSource = 'files';
function syncScriptSource() {
  if (!plot || !plot.setPythonSource) return;
  const used = new Set(state.series.map((s) => s.fileId));
  const files = state.files.filter((f) => used.has(f.id));
  plot.setPythonSource(files.length && files.every((f) => f.example) ? 'embed' : chosenSource);
}

function headHeight() {
  const nav = document.querySelector('body > nav');
  return nav ? Math.round(nav.getBoundingClientRect().height) : 0;
}

/*
 * How large the preview may be: beside the rail, the whole figure fits under
 * the site header; stacked on a narrow screen, where it stays in view above
 * the inputs, it takes at most about a third of the screen's height.
 */
function previewMaxScale() {
  const f = plot && plot.figure();
  const tall = (f ? f.height : 2.6) * 96;
  const head = ui.plot.querySelector('.fg-h');
  const room = narrow.matches
    ? Math.min(window.innerHeight * 0.36, 22 * 16)
    : window.innerHeight - headHeight() - (head ? head.getBoundingClientRect().height : 56) - 40;
  return Math.max(0.2, Math.min(2, room / tall));
}

function pythonNote(fig, source) {
  const used = new Set(state.series.map((s) => s.fileId));
  const files = state.files.filter((f) => used.has(f.id));
  const read = source === 'files' ? files.filter((f) => !f.example) : [];
  const code = (t) => `<code>${esc(t)}</code>`;
  // A confidence interval (a box plot's mean, bars of means) takes Student's t from scipy.
  const scipy = fig.panels.some((p) => p.series.some((q) => q.show && ((q.kind === 'box' && q.mean) || (q.replicates && q.replicates.error === 'ci'))));
  let note = `Runs with Python 3, numpy${scipy ? ', scipy' : ''} and matplotlib 3.6 or later (3.11 or later to match the preview): ${code(`python ${fig.export.filename}.py`)}. `
    + `It saves ${code(`${fig.export.filename}.${fig.export.format}`)}`;
  note += read.length ? `, reading ${read.map((f) => code(f.name)).join(' and ')} from the same folder.` : '.';
  if (state.series.some((s) => ['heatmap', 'contour', 'hist2d'].includes(s.chart))) note += ' The grid of a heatmap, contour or 2D histogram is in the script as numbers.';
  if (source === 'files' && files.some((f) => f.example)) note += ' The example’s numbers are in the script.';
  if (source === 'files' && read.some((f) => f.table.readable.some((r) => !r))) note += ' A column whose name is repeated in its file is written into the script.';
  if (source === 'embed') {
    const cells = files.reduce((n, f) => n + f.table.rows * f.table.headers.length, 0);
    if (cells > 50000) note += ` With every number in it the script is large; <strong>Read the CSV files</strong> keeps it short.`;
  }
  return note;
}

function exported(r, err, format) {
  if (err) { toast(`The ${format.toUpperCase()} could not be made: ${err && err.message ? err.message : err}`, 'danger'); return; }
  const f = plot.figure();
  const unit = (f && f.sizeUnit) || 'in';
  const dpi = f ? f.dpi : 300;
  const px = r.pixelWidth && unit !== 'px' ? `, ${r.pixelWidth} × ${r.pixelHeight} px` : '';
  toast(`Saved ${r.filename} (${formatSize(r.widthIn, unit, dpi).split(' ')[0]} × ${formatSize(r.heightIn, unit, dpi)}${px}).`, 'ok');
}

plot = mountFigure(ui.plot, {
  style: storedStyle(),
  styleHost: ui.styleHost,
  onStyleChange: (style) => { saveStyle(style); afterStyle(); },
  maxScale: previewMaxScale,
  label: 'The figure, as it will be saved',
  onExport: exported,
  onDraw: afterDraw,
  python: {
    host: ui.python,
    title: 'Python script',
    sources: [{ id: 'files', label: 'Read the CSV files' }, { id: 'embed', label: 'Data in the script' }],
    files: pyFiles,
    header: ['Figure from the STEMKit Plot Builder (https://stemkit.net/plot-builder.html)'],
    note: pythonNote,
    onSourceChange: (id) => { chosenSource = id; }
  }
});

// The Style button shows the Style tab, which holds the style panel.
ui.plot.addEventListener('click', (e) => {
  if (!e.target.closest('[data-fg-style]')) return;
  e.stopPropagation();
  selectTab('style', { reveal: true });
  const first = ui.styleHost.querySelector('summary, button, input, select');
  if (first) first.focus({ preventScroll: true });
}, true);

/* The figure for the files and series as they are now. */
let lastSlug = null;
function redraw() {
  for (const k of Object.keys(pyFiles)) delete pyFiles[k];
  Object.assign(pyFiles, pythonFiles(state));
  const title = plot.getStyle().title || '';
  lastSlug = slug(title);
  const desc = builderFigure(state, { title });
  return plot.update(desc);
}

/* The person's look changed in the Style panel. */
function afterStyle() {
  if (axesFromStyle()) return;
  const title = plot.getStyle().title || '';
  if (slug(title) !== lastSlug) redraw();
  syncCards();
}

/*
 * The axes a series stands on belong to its card: one moved to a second
 * axis in the Style panel moves there on its card, so that the axis takes
 * its label from the series, and the style keeps no copy.
 */
function axesFromStyle() {
  const style = plot.getStyle();
  let moved = false;
  for (const [id, own] of Object.entries(style.series || {})) {
    const s = seriesById(id);
    if (!own || (own.xAxis === undefined && own.yAxis === undefined)) continue;
    if (s) {
      if (own.xAxis !== undefined) s.xAxis = own.xAxis === 'top' ? 'top' : 'bottom';
      if (own.yAxis !== undefined) s.yAxis = own.yAxis === 'right' ? 'right' : 'left';
    }
    delete own.xAxis; delete own.yAxis;
    if (!Object.keys(own).length) delete style.series[id];
    moved = true;
  }
  if (!moved) return false;
  plot.setStyle(style);
  saveStyle(plot.getStyle());
  renderSeries();
  redraw();
  return true;
}

/* Change the look from the page (the header's switches, zooming, a series card). */
function setStyle(next) {
  plot.setStyle(next);
  saveStyle(plot.getStyle());
  afterStyle();
}

/* ------------------------------------------------------------------ *
 * After each drawing: the size, the notes, the switches, the cards
 * ------------------------------------------------------------------ */

function afterDraw(info) {
  syncScriptSource();
  const f = plot.figure();
  const has = !!(f && info);
  ui.logXWrap.hidden = !has;
  ui.logYWrap.hidden = !has;
  ui.hint.hidden = !has;
  if (has) {
    ui.logX.checked = f.panels.every((p) => p.xScale === 'log');
    ui.logY.checked = f.panels.every((p) => p.yScale === 'log');
    showSize(f, info);
    const pw = Math.floor(info.widthIn * f.dpi + 1e-6);
    const ph = Math.floor(info.heightIn * f.dpi + 1e-6);
    if (pw > 16384 || ph > 16384 || pw * ph > 16384 * 16384 / 2) {
      const p = document.createElement('p');
      p.textContent = `At ${f.dpi} dpi the PNG would be ${pw} × ${ph} pixels, more than a browser can draw. Lower the resolution or the size; PDF and SVG are not affected.`;
      ui.notes.appendChild(p);
      ui.notes.hidden = false;
    }
  }
  syncCards();
  syncLayout();
}

/* The size of the saved figure in its unit, its pixels at the PNG's resolution, and how large the preview shows it. */
function showSize(f, info) {
  if (!info || !Number.isFinite(info.widthIn)) return;
  const pw = Math.floor(info.widthIn * f.dpi + 1e-6);
  const ph = Math.floor(info.heightIn * f.dpi + 1e-6);
  const unit = f.sizeUnit || 'in';
  let text = `${pw} × ${ph} px at ${f.dpi} dpi`;
  if (unit !== 'px') text = `${formatSize(info.widthIn, unit, f.dpi).split(' ')[0]} × ${formatSize(info.heightIn, unit, f.dpi)} · ${text}`;
  ui.size.textContent = text;
  if (Number.isFinite(info.scale)) {
    const s = document.createElement('span');
    s.className = 'pb-scale';
    s.textContent = ` · shown at ${Math.round(info.scale * 100)}%`;
    ui.size.appendChild(s);
  }
  ui.size.title = 'The size of the saved figure, and its pixels as a PNG';
}

if ('ResizeObserver' in window) {
  new ResizeObserver(() => requestAnimationFrame(() => {
    const f = plot.figure();
    if (f) showSize(f, plot.info());
  })).observe(ui.figure);
  // How tall the plot is, for the fields scrolled into view under it when it is pinned.
  new ResizeObserver(() => ui.workspace.style.setProperty('--pb-plot-h', `${Math.round(ui.plot.getBoundingClientRect().height)}px`)).observe(ui.plot);
}
let lastHeight = window.innerHeight;
let resizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    ui.workspace.style.setProperty('--pb-head', `${headHeight()}px`);
    if (Math.abs(window.innerHeight - lastHeight) > 40 && plot.figure()) { lastHeight = window.innerHeight; redraw(); }
  }, 200);
});
ui.workspace.style.setProperty('--pb-head', `${headHeight()}px`);

/* The header's switches: log scales, for the x axis and every panel's y. */
ui.logX.addEventListener('change', () => {
  const next = plot.getStyle();
  next.xScale = ui.logX.checked ? 'log' : 'linear';
  // A scale set for one panel's x axis in the Style panel gives way to the switch.
  if (next.panels) next.panels = next.panels.map((p) => { const o = { ...(p || {}) }; delete o.xScale; return o; });
  setStyle(next);
});
ui.logY.addEventListener('change', () => {
  const f = plot.figure();
  if (!f) return;
  const next = plot.getStyle();
  next.panels = f.panels.map((_, i) => ({ ...((next.panels || [])[i] || {}), yScale: ui.logY.checked ? 'log' : 'linear' }));
  setStyle(next);
});

/* ------------------------------------------------------------------ *
 * Tabs
 * ------------------------------------------------------------------ */

function selectTab(name, { focus = false, reveal = false } = {}) {
  ui.tabs.forEach((t) => {
    const on = t.dataset.tab === name;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
    $(t.getAttribute('aria-controls')).hidden = !on;
    if (on && focus) t.focus({ preventScroll: true });
  });
  try { localStorage.setItem(TAB_KEY, name); } catch (e) { /* storage blocked */ }
  if (reveal) scrollToInRail(ui.rail);
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

function syncTabs() {
  const [tabData, tabSeries] = ui.tabs;
  const hasFiles = state.files.length > 0;
  const hasSeries = state.series.length > 0;
  tabData.setAttribute('data-stk-state', hasFiles ? 'done' : 'current');
  tabSeries.setAttribute('data-stk-state', hasSeries ? 'done' : hasFiles ? 'current' : 'pending');
  ui.tabDataInfo.textContent = hasFiles ? String(state.files.length) : '';
  ui.tabDataInfo.title = hasFiles ? plural(state.files.length, 'file') : '';
  ui.tabSeriesInfo.textContent = hasSeries ? String(state.series.length) : '';
  ui.tabSeriesInfo.title = hasSeries ? `${state.series.length} series` : '';
}

/* ------------------------------------------------------------------ *
 * Files
 * ------------------------------------------------------------------ */

/* The first column of numbers for x and the next one for y. */
function firstColumns(f, avoid = new Set()) {
  const t = f.table;
  const nums = t.headers.map((_, i) => i).filter((i) => t.numeric[i]);
  const x = nums.length ? nums[0] : 0;
  const y = nums.find((i) => i !== x && !avoid.has(i)) ?? nums.find((i) => i !== x) ?? t.headers.findIndex((_, i) => i !== x);
  return { x, y: y < 0 ? x : y };
}

function newSeries(fileId, o = {}) {
  const f = fileById(fileId);
  const cols = firstColumns(f);
  const s = { id: `s${nextSeries++}`, fileId, chart: 'curve', x: cols.x, y: cols.y, y2: null, z: null, groupBy: null, draw: 'line', yerr: null, xerr: null, panel: 0, xAxis: 'bottom', yAxis: 'left', ...o };
  state.series.push(s);
  return s;
}

function addFile(name, text, { example = false, id, size = 0, labels = EXAMPLE_LABELS } = {}) {
  const table = readTable(text);
  if (!table.ok) { toast(`${name}: ${table.error}`, 'danger'); return null; }
  const taken = new Set(state.files.map((f) => f.source).filter(Boolean));
  const f = {
    id: id || `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name, size, example, table,
    source: example ? null : sourceId(name, taken),
    labels: example ? labels : null
  };
  state.files.push(f);
  return f;
}

async function addFiles(list) {
  let first = null;
  for (const file of Array.from(list || [])) {
    if (!/\.(csv|tsv|txt)$/i.test(file.name)) { toast(`Skipped ${file.name}: the builder reads .csv, .tsv and .txt tables.`, 'danger'); continue; }
    if (state.files.some((f) => !f.example && f.name === file.name && f.size === file.size)) { toast(`${file.name} is already loaded.`); continue; }
    if (file.size > MAX_BYTES) { toast(`${file.name} is over 50 MB, too large to plot in the browser.`, 'danger'); continue; }
    let text;
    try { text = await file.text(); } catch (e) { toast(`Could not read ${file.name}.`, 'danger'); continue; }
    const f = addFile(file.name, text, { size: file.size });
    if (!f) continue;
    const numeric = f.table.numeric.filter(Boolean).length;
    toast(`Loaded ${file.name}: ${plural(f.table.rows, 'row')}, ${plural(f.table.headers.length, 'column')}.`, 'ok');
    if (numeric < 2) toast(`${file.name} has fewer than two columns of numbers. Choose the columns to plot on the Series tab.`, 'warn');
    if (!state.series.length) { newSeries(f.id); first = first || f; }
  }
  ui.fileInput.value = '';
  renderFiles();
  renderSeries();
  redraw();
  if (first) selectTab('series');
}

function loadExample() {
  if (state.files.some((f) => f.example && f.name === 'growth_example.csv')) { toast('The example is already loaded.'); return; }
  // Another of the examples is on the page: this one takes its place, as they do each other's.
  if (state.files.some((f) => f.example)) { loadBuiltIn('growth'); return; }
  const f = addFile('growth_example.csv', exampleCsv(), { example: true, id: 'example' });
  if (!f) return;
  const col = (name) => f.table.headers.indexOf(name);
  newSeries(f.id, { x: col('time_h'), y: col('control_OD600'), yerr: col('control_sd'), draw: 'both', label: 'Control' });
  newSeries(f.id, { x: col('time_h'), y: col('treated_OD600'), yerr: col('treated_sd'), draw: 'both', label: 'Treated' });
  renderFiles();
  renderSeries();
  redraw();
  selectTab('series');
  toast('Loaded two bacterial growth curves with their standard deviations. Try Log y.', 'ok');
}

/*
 * One of the built-in examples (EXAMPLES in src/core/plot-builder.js) in
 * place of the files and series on the page. The house style stays as it is
 * (size, fonts, colours, frame, grid, legend, ticks, export); what belonged
 * to the figure before (title, labels, limits, scales, each series' look)
 * goes with it, so the example is drawn as it is meant to look.
 */
function loadBuiltIn(id) {
  const ex = builderExample(id);
  if (!ex) return;
  state.files = [];
  state.series = [];
  state.layout = { ...emptyLayout(), ...JSON.parse(JSON.stringify(ex.layout || {})) };
  const files = ex.files.map((f, i) => addFile(f.name, f.csv, { example: true, id: i ? `example${i + 1}` : 'example', labels: f.labels }));
  // The example's own look (a gap, letters, a legend beside the plot) goes
  // over the house style, its series found by their place.
  const ids = new Map();
  ex.series.forEach((s, k) => {
    const f = files[s.file || 0];
    if (!f) return;
    const o = { ...s };
    delete o.file;
    for (const key of ['x', 'y', 'y2', 'z', 'yerr', 'xerr', 'groupBy']) if (typeof s[key] === 'string') o[key] = f.table.headers.indexOf(s[key]);
    ids.set(`s${k + 1}`, newSeries(f.id, o).id);
  });
  const house = houseStyle(plot.getStyle());
  const own = JSON.parse(JSON.stringify(ex.style || {}));
  const style = { ...house, ...own };
  if (house.panels && own.panels) style.panels = Array.from({ length: Math.max(house.panels.length, own.panels.length) }, (_, i) => ({ ...(house.panels[i] || {}), ...(own.panels[i] || {}) }));
  if (style.series) style.series = Object.fromEntries(Object.entries(style.series).filter(([id]) => ids.has(id)).map(([id, look]) => [ids.get(id), look]));
  plot.setStyle(style);
  saveStyle(plot.getStyle());
  renderFiles();
  renderSeries();
  redraw();
  selectTab('series');
  toast(`Loaded the example “${ex.name}”. ${ex.description}`, 'ok');
}

function removeFile(id) {
  const f = fileById(id);
  if (!f) return;
  state.files = state.files.filter((x) => x.id !== id);
  const gone = state.series.filter((s) => s.fileId === id).map((s) => s.id);
  state.series = state.series.filter((s) => s.fileId !== id);
  forgetSeries(gone);
  renderFiles();
  renderSeries();
  redraw();
  toast(`Removed ${f.name}.`);
}

function renderFiles() {
  ui.files.innerHTML = state.files.map((f) => {
    const t = f.table;
    const delim = { ',': 'commas', '\t': 'tabs', ';': 'semicolons', '|': 'bars' }[t.delimiter] || 'commas';
    const warn = t.notUtf8 ? '<p class="pb-file-warn">Not UTF-8 text: the preview may be right, but the script will not read it. Save the file as UTF-8, or put the data in the script.</p>' : '';
    return `<li class="pb-file">
        <i class="fa-solid ${f.example ? 'fa-flask-vial' : 'fa-file-csv'}" aria-hidden="true"></i>
        <span class="pb-file-t"><span class="pb-file-name" title="${esc(f.name)}">${esc(f.name)}</span>
        <span class="pb-file-meta">${plural(t.rows, 'row')}, ${plural(t.headers.length, 'column')}${t.headers.length > 1 ? `, by ${delim}` : ''}</span></span>
        <button type="button" class="stk-btn stk-btn-sm stk-btn-ghost stk-btn-icon" data-remove-file="${esc(f.id)}" aria-label="Remove ${esc(f.name)}"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
        ${warn}
      </li>`;
  }).join('');
  ui.addSeries.disabled = !state.files.length;
  syncTabs();
}

ui.openFiles.addEventListener('click', () => ui.fileInput.click());
ui.fileInput.addEventListener('change', (e) => addFiles(e.target.files));
ui.drop.addEventListener('click', () => ui.fileInput.click());
['dragenter', 'dragover'].forEach((n) => ui.drop.addEventListener(n, (e) => { e.preventDefault(); ui.drop.classList.add('is-over'); }));
ui.drop.addEventListener('dragleave', (e) => { if (!ui.drop.contains(e.relatedTarget)) ui.drop.classList.remove('is-over'); });
ui.drop.addEventListener('drop', (e) => {
  e.preventDefault();
  ui.drop.classList.remove('is-over');
  if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
});
// A file dropped anywhere on the workspace is read, not opened by the browser.
ui.workspace.addEventListener('dragover', (e) => { if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) e.preventDefault(); });
ui.workspace.addEventListener('drop', (e) => {
  if (e.defaultPrevented || !e.dataTransfer || !e.dataTransfer.files.length) return;
  e.preventDefault();
  addFiles(e.dataTransfer.files);
});
ui.files.addEventListener('click', (e) => {
  const b = e.target.closest('[data-remove-file]');
  if (b) removeFile(b.dataset.removeFile);
});

/* ------------------------------------------------------------------ *
 * Series
 * ------------------------------------------------------------------ */

const DRAW_NAMES = { line: 'Line', points: 'Points', both: 'Both', step: 'Step', band: 'Band' };
const CHART_NAMES = {
  curve: 'Line, points, step or band', bar: 'Bars', 'bars-mean': 'Bars of means', hist: 'Histogram', box: 'Box plot', violin: 'Violin plot',
  heatmap: 'Heatmap', contour: 'Contour', hist2d: '2D histogram'
};
const CHART_HINTS = {
  curve: '', bar: 'One bar per row: the X column names it, or places it when it holds numbers. Bars lying flat use the bottom and left axes.',
  'bars-mean': 'One bar per name: the mean of the rows that share it, with their spread as an error bar. The script works them out from the file.',
  violin: 'The spread of the Y column\u2019s values as a smoothed density, one violin per group of the Group by column.',
  hist: 'The Y column\u2019s values, counted in bins.', box: 'The Y column\u2019s values as one box, or one box per group of the Group by column.',
  heatmap: 'The Value column over X and Y, one cell for each different X and Y.', contour: 'Lines or bands of equal Value over X and Y.',
  hist2d: 'How many rows fall in each cell of a grid over X and Y.'
};

const ORIENTATIONS = [['v', 'Upright'], ['h', 'Lying flat']];
const STACKINGS = [['none', 'Side by side'], ['stack', 'Stacked'], ['percent', 'Stacked to 100%']];
const ERROR_NAMES = [['sd', 'Standard deviation'], ['sem', 'Standard error'], ['ci', 'Confidence interval'], ['none', 'None']];
const LEVEL_NAMES = LEVELS.map((l) => [l, `${Math.round(l * 100)}%`]);
const BIN_MODE_NAMES = [['number', 'A number of bins'], ['rule', 'A rule'], ['edges', 'Edges I type']];
const BIN_RULE_NAMES = [['auto', 'Automatic'], ['fd', 'Freedman–Diaconis'], ['sturges', 'Sturges'], ['sqrt', 'Square root'],
  ['scott', 'Scott'], ['rice', 'Rice'], ['doane', 'Doane']];
const NORMALISE_NAMES = [['counts', 'Counts'], ['density', 'Density'], ['fraction', 'Fraction'], ['percent', 'Percent']];
const WHISKER_NAMES = WHISKER_RULES.map((r) => [String(r.value), r.label]);
const INTERVAL_NAMES = [['', 'Not shown'], ...LEVELS.map((l) => [l, `With its ${Math.round(l * 100)}% interval`])];
const INNER_NAMES = [['box', 'Box and median'], ['quartiles', 'Quartile lines'], ['median', 'Median line'], ['none', 'Nothing']];
const VIOLIN_SCALE_NAMES = [['width', 'Each the same width'], ['area', 'All the same area']];
const BANDWIDTH_NAMES = [['scott', 'Scott'], ['silverman', 'Silverman']];
/* What a card's fields are, by the way their value is kept. */
const TEXT_KEYS = ['orientation', 'stack', 'error', 'binsMode', 'binRule', 'normalise', 'whis', 'bandwidth', 'scale', 'inner', 'binEdges'];
const CHECK_KEYS = ['density', 'filled', 'points', 'cumulative', 'notch'];
/* Fields whose change changes which fields the card has. */
const REBUILD_KEYS = ['orientation', 'error', 'binsMode'];
/* A series' look that its card sets: the person's own choice of it in the Style panel gives way. */
const CARD_LOOK = { whis: ['whis'], notch: ['notch'], interval: ['mean', 'level'], points: ['points'], inner: ['inner'], scale: ['scale'],
  bandwidth: ['bandwidth'], cut: ['cut'] };

function numberField(n, key, label, value, min, max, step = 1) {
  return `<div class="stk-field"><label for="${n}-${key}">${label}</label><input id="${n}-${key}" type="number" inputmode="${step === 1 ? 'numeric' : 'decimal'}" class="stk-input stk-input-sm" data-f="${key}" min="${min}" max="${max}" step="${step}" value="${esc(value)}"></div>`;
}
function textField(n, key, label, value, placeholder) {
  return `<div class="stk-field pb-wide"><label for="${n}-${key}">${label}</label><input id="${n}-${key}" type="text" class="stk-input stk-input-sm" data-f="${key}" value="${esc(value)}" placeholder="${esc(placeholder)}" autocomplete="off" spellcheck="false"></div>`;
}
function checkField(n, key, label, on) {
  return `<div class="stk-field pb-check"><label class="stk-check"><input id="${n}-${key}" type="checkbox" data-f="${key}"${on ? ' checked' : ''}> ${label}</label></div>`;
}

function options(list, current) {
  return list.map(([v, l]) => `<option value="${esc(v)}"${String(v) === String(current) ? ' selected' : ''}>${esc(l)}</option>`).join('');
}

function seriesCard(s, k) {
  const f = fileById(s.fileId);
  const t = f.table;
  const cols = t.headers.map((_, i) => [i, columnName(t.headers, i)]);
  const none = [['', 'None'], ...cols];
  const n = s.id;
  const chart = CHART_KINDS.includes(s.chart) ? s.chart : 'curve';
  const band = chart === 'curve' && s.draw === 'band';
  const multiFile = state.files.length > 1;
  const places = panelChoices();
  // A second axis on top or on the right, for the charts that can stand on one.
  const axes = axisChoices(t, s);
  const sel = (key, label, list, current) => `<div class="stk-field"><label for="${n}-${key}">${label}</label><select id="${n}-${key}" class="stk-select stk-select-sm" data-f="${key}">${options(list, current)}</select></div>`;
  let body;
  if (chart === 'curve') {
    body = `${sel('x', 'X column', cols, s.x)}
      ${sel('y', band ? 'From (lower)' : 'Y column', cols, s.y)}
      ${band
        ? sel('y2', 'To (upper)', cols, Number.isInteger(s.y2) ? s.y2 : s.y)
        : s.draw === 'step' ? ''
          : `${sel('yerr', 'Y error', none, Number.isInteger(s.yerr) ? s.yerr : '')}
           ${sel('xerr', 'X error', none, Number.isInteger(s.xerr) ? s.xerr : '')}`}`;
  } else if (chart === 'bar') {
    const flat = s.orientation === 'h';
    body = `${sel('x', flat ? 'Names or Y' : 'Names or X', cols, s.x)}${sel('y', flat ? 'Length (X)' : 'Height (Y)', cols, s.y)}
      ${sel('yerr', flat ? 'X error' : 'Y error', none, Number.isInteger(s.yerr) ? s.yerr : '')}
      ${sel('orientation', 'Bars', ORIENTATIONS, flat ? 'h' : 'v')}${sel('stack', 'With other bars', STACKINGS, s.stack || 'none')}`;
  } else if (chart === 'bars-mean') {
    body = `${sel('x', 'Names', cols, s.x)}${sel('y', 'Values', cols, s.y)}
      ${sel('error', 'Error bars', ERROR_NAMES, s.error || 'sd')}${s.error === 'ci' ? sel('level', 'Level', LEVEL_NAMES, s.level || 0.95) : ''}
      ${sel('orientation', 'Bars', ORIENTATIONS, s.orientation === 'h' ? 'h' : 'v')}${checkField(n, 'points', 'Each value as a point', !!s.points)}`;
  } else if (chart === 'hist') {
    const h = histogramOptions(s);
    const mode = ['rule', 'edges'].includes(s.binsMode) ? s.binsMode : 'number';
    body = `${sel('y', 'Values', cols, s.y)}${sel('binsMode', 'Bins', BIN_MODE_NAMES, mode)}
      ${mode === 'rule' ? sel('binRule', 'Rule', BIN_RULE_NAMES, s.binRule || 'auto')
        : mode === 'edges' ? textField(n, 'binEdges', 'Edges', s.binEdges || '', '0, 1, 2, 5, 10')
          : numberField(n, 'bins', 'How many', s.bins || DEFAULT_BINS, 1, 1000)}
      ${sel('normalise', 'Bars show', NORMALISE_NAMES, h.normalise)}${checkField(n, 'cumulative', 'Cumulative', !!s.cumulative)}`;
  } else if (chart === 'box') {
    body = `${sel('y', 'Values', cols, s.y)}${sel('groupBy', 'Group by', none, Number.isInteger(s.groupBy) ? s.groupBy : '')}
      ${sel('whis', 'Whiskers reach', WHISKER_NAMES, s.whis || '1.5')}${sel('interval', 'Mean', INTERVAL_NAMES, s.interval || '')}
      ${checkField(n, 'notch', 'Notch at the median', !!s.notch)}`;
  } else if (chart === 'violin') {
    body = `${sel('y', 'Values', cols, s.y)}${sel('groupBy', 'Group by', none, Number.isInteger(s.groupBy) ? s.groupBy : '')}
      ${sel('inner', 'Inside', INNER_NAMES, s.inner || 'box')}${sel('scale', 'Widths', VIOLIN_SCALE_NAMES, s.scale || 'width')}
      ${sel('bandwidth', 'Smoothing rule', BANDWIDTH_NAMES, s.bandwidth || 'scott')}${numberField(n, 'cut', 'Extend past the data', s.cut || 0, 0, 10, 0.5)}
      ${checkField(n, 'points', 'Points', !!s.points)}`;
  } else if (chart === 'heatmap' || chart === 'contour') {
    body = `${sel('x', 'X column', cols, s.x)}${sel('y', 'Y column', cols, s.y)}${sel('z', 'Value (Z)', cols, Number.isInteger(s.z) ? s.z : s.y)}
      ${chart === 'contour' ? `${numberField(n, 'levels', 'Levels', s.levels || DEFAULT_LEVELS, 1, 100)}${checkField(n, 'filled', 'Filled', s.filled !== false)}` : ''}`;
  } else {
    body = `${sel('x', 'X column', cols, s.x)}${sel('y', 'Y column', cols, s.y)}${numberField(n, 'bins', 'Bins per side', s.bins || DEFAULT_BINS_2D, 1, 500)}`;
  }
  const card = document.createElement('div');
  card.className = 'pb-card';
  card.dataset.id = s.id;
  card.setAttribute('role', 'group');
  card.setAttribute('aria-label', `Series ${k + 1}`);
  card.innerHTML = `
    <div class="pb-card-h">
      <button type="button" class="pb-chip" data-act="style" aria-label="Colour, line and marker of series ${k + 1}" title="Colour, line and marker"><span></span></button>
      <input type="text" class="stk-input stk-input-sm" data-f="label" aria-label="Legend name of series ${k + 1}" autocomplete="off" spellcheck="false">
      <button type="button" class="stk-btn stk-btn-sm stk-btn-ghost stk-btn-icon" data-act="remove" aria-label="Remove series ${k + 1}"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
    </div>
    ${multiFile ? `<div class="stk-field"><label for="${n}-file">File</label><select id="${n}-file" class="stk-select stk-select-sm" data-f="fileId">${options(state.files.map((x) => [x.id, x.name]), s.fileId)}</select></div>` : ''}
    <div class="stk-field"><label for="${n}-chart">Chart</label>
      <select id="${n}-chart" class="stk-select stk-select-sm" data-f="chart">${options(CHART_KINDS.map((c) => [c, CHART_NAMES[c]]), chart)}</select></div>
    ${chart === 'curve' ? `<div class="stk-field"><span class="stk-label-sm" id="${n}-draw-l">Draw</span>
      <div class="stk-seg stk-seg-fill" role="group" aria-labelledby="${n}-draw-l" data-f="draw">
        ${DRAW_MODES.map((d) => `<button type="button" data-value="${d}" aria-pressed="${s.draw === d}">${DRAW_NAMES[d]}</button>`).join('')}
      </div>
    </div>` : `<p class="pb-card-hint">${esc(CHART_HINTS[chart])}</p>`}
    <div class="pb-grid2">
      ${body}
      ${axes.x ? sel('xAxis', 'X axis', [['bottom', 'Bottom'], ['top', 'Top']], s.xAxis === 'top' ? 'top' : 'bottom') : ''}
      ${axes.y ? sel('yAxis', 'Y axis', [['left', 'Left'], ['right', 'Right']], s.yAxis === 'right' ? 'right' : 'left') : ''}
      ${places.length > 1 ? `<div class="stk-field"><label for="${n}-panel">Panel</label><select id="${n}-panel" class="stk-select stk-select-sm" data-f="panel">${options(places, panelKey(s, places))}</select></div>` : ''}
    </div>
    <p class="pb-card-note" data-note aria-live="polite"></p>`;
  return card;
}

/*
 * The panels a series can go to, as the Panel menu lists them: in one
 * column, as many as there are rows or series (four at most without more
 * rows), the first on top; on a grid, every cell by its row and column;
 * then the insets.
 */
function panelChoices() {
  const lay = builderLayout(state.layout);
  const list = [];
  if (lay.cols === 1) {
    const n = Math.max(lay.rows, Math.min(4, state.series.length));
    for (let i = 0; i < n; i++) list.push([i, i === 0 ? '1 (top)' : String(i + 1)]);
  } else {
    for (let i = 0; i < lay.rows * lay.cols; i++) list.push([i, `Row ${Math.floor(i / lay.cols) + 1}, column ${(i % lay.cols) + 1}`]);
  }
  lay.insets.forEach((s, k) => list.push([s.id, `Inset ${k + 1}`]));
  return list;
}

/* The panel a series is in, as one of the menu's values. */
function panelKey(s, places = panelChoices()) {
  if (typeof s.panel === 'string') return places.some(([v]) => v === s.panel) ? s.panel : 0;
  const cells = places.filter(([v]) => typeof v === 'number').length;
  return Math.min(Math.max(0, Math.round(s.panel || 0)), cells - 1);
}

/* Where a series is drawn among the figure's panels (-1: nowhere). */
function panelIndex(s) {
  const key = typeof s.panel === 'string' && state.layout.insets.some((x) => x.id === s.panel) ? s.panel : Math.max(0, Math.round(Number(s.panel) || 0));
  return builderPanels(state).findIndex((p) => p.key === key);
}

function renderSeries() {
  const focusId = document.activeElement && document.activeElement.id;
  ui.seriesList.replaceChildren(...state.series.map((s, k) => seriesCard(s, k)));
  ui.seriesEmpty.hidden = state.series.length > 0;
  ui.seriesEmpty.innerHTML = state.files.length
    ? 'No series. <strong>Add a series</strong> to plot a column against another.'
    : 'Open a file on the <strong>Data</strong> tab, or load the example. Its first two columns of numbers are plotted at once.';
  ui.addSeries.disabled = !state.files.length;
  if (focusId && $(focusId)) $(focusId).focus();
  renderInsets();
  syncTabs();
  syncCards();
}

/* What the cards show that comes from the drawing: colour, name, notes. */
function syncCards() {
  const f = plot && plot.figure();
  const drawn = new Map();
  if (f) f.panels.forEach((p) => p.series.forEach((q) => drawn.set(q.id, q)));
  const style = plot ? plot.getStyle() : {};
  const samePanel = (a, b) => (typeof a.panel === 'string' || typeof b.panel === 'string' ? a.panel === b.panel : Math.max(0, a.panel || 0) === Math.max(0, b.panel || 0));
  ui.seriesList.querySelectorAll('.pb-card').forEach((card) => {
    const s = seriesById(card.dataset.id);
    if (!s) return;
    const q = drawn.get(s.id);
    const chip = card.querySelector('.pb-chip > span');
    if (chip) chip.style.setProperty('--pb-c', q ? q.color : '');
    const name = card.querySelector('[data-f="label"]');
    const own = style.series && style.series[s.id] && typeof style.series[s.id].label === 'string' ? style.series[s.id].label : null;
    const fallback = defaultLabel(s);
    name.placeholder = fallback;
    if (document.activeElement !== name) name.value = own ?? fallback;
    const note = card.querySelector('[data-note]');
    // The scales of the axes of its panel: the note speaks of those it stands on.
    const p = f ? f.panels[panelIndex(s)] : null;
    const panelScales = p ? { xLog: p.xScale === 'log', yLog: p.yScale === 'log', x2Log: p.x2Scale === 'log', y2Log: p.y2Scale === 'log' } : {};
    // The other stacked bars a stacked series stands with: in its panel, on its axes, lying the same way.
    const partners = state.series.filter((x) => x !== s && x.chart === 'bar' && (x.stack === 'stack' || x.stack === 'percent')
      && samePanel(x, s) && (x.orientation === 'h') === (s.orientation === 'h')
      && (s.orientation === 'h' || ((x.xAxis === 'top') === (s.xAxis === 'top') && (x.yAxis === 'right') === (s.yAxis === 'right')))).length;
    const msg = seriesNote(fileById(s.fileId), s, { ...panelScales, stackPartners: partners });
    if (note.textContent !== msg) note.textContent = msg;
    // Edges that cannot be used are marked on their field; the note says why.
    const edges = card.querySelector('[data-f="binEdges"]');
    if (edges) {
      const bad = !!histogramOptions(s).error && (s.binEdges || '').trim() !== '';
      edges.classList.toggle('is-invalid', bad);
      edges.setAttribute('aria-invalid', String(bad));
    }
  });
}

function defaultLabel(s) {
  if (typeof s.label === 'string') return s.label;
  const t = fileById(s.fileId).table;
  if ((s.chart === 'heatmap' || s.chart === 'contour') && Number.isInteger(s.z)) return columnName(t.headers, s.z);
  if (s.chart === 'hist2d') return 'Count';
  if ((!s.chart || s.chart === 'curve') && s.draw === 'band' && Number.isInteger(s.y2) && s.y2 !== s.y) return `${columnName(t.headers, s.y)} to ${columnName(t.headers, s.y2)}`;
  return columnName(t.headers, s.y);
}

/* The person's look for series that are gone is dropped with them. */
function forgetSeries(ids) {
  const style = plot.getStyle();
  if (!style.series || !ids.some((id) => style.series[id])) return;
  ids.forEach((id) => { delete style.series[id]; });
  plot.setStyle(style);
}

/* A series' look the page sets for it, without the person's choices that would contradict it. */
function dropLook(id, keys) {
  const style = plot.getStyle();
  const own = style.series && style.series[id];
  if (!own || !keys.some((k) => own[k] !== undefined)) return;
  keys.forEach((k) => { delete own[k]; });
  plot.setStyle(style);
}

let labelTimer = 0;
ui.seriesList.addEventListener('input', (e) => {
  const el = e.target.closest('[data-f="label"]');
  if (!el) return;
  const id = el.closest('.pb-card').dataset.id;
  clearTimeout(labelTimer);
  labelTimer = setTimeout(() => {
    const style = plot.getStyle();
    style.series = style.series || {};
    const own = { ...(style.series[id] || {}) };
    if (el.value.trim() === '') delete own.label; else own.label = el.value;
    if (Object.keys(own).length) style.series[id] = own; else delete style.series[id];
    setStyle(style);
  }, 150);
});
ui.seriesList.addEventListener('focusout', (e) => {
  if (e.target.matches('[data-f="label"]')) setTimeout(syncCards, 200);
});

ui.seriesList.addEventListener('change', (e) => {
  const el = e.target.closest('select[data-f], input[data-f]:not([data-f="label"])');
  if (!el) return;
  const card = el.closest('.pb-card');
  const s = seriesById(card.dataset.id);
  const key = el.dataset.f;
  const v = el.type === 'checkbox' ? el.checked : el.value;
  if (key === 'fileId') {
    s.fileId = v;
    const cols = firstColumns(fileById(v));
    Object.assign(s, { x: cols.x, y: cols.y, y2: null, z: null, groupBy: null, yerr: null, xerr: null });
    if (s.chart && s.chart !== 'curve') Object.assign(s, suggestColumns(fileById(v).table, s.chart));
    delete s.label;
    renderSeries();
  } else if (key === 'chart') {
    s.chart = v;
    Object.assign(s, { yerr: null, xerr: null, y2: null });
    if (v !== 'curve') Object.assign(s, { groupBy: null, z: null }, suggestColumns(fileById(s.fileId).table, v));
    delete s.label;
    renderSeries();
    card.ownerDocument.querySelector(`.pb-card[data-id="${s.id}"] [data-f="chart"]`)?.focus();
  } else if (key === 'yerr' || key === 'xerr' || key === 'groupBy') {
    s[key] = v === '' ? null : Number(v);
  } else if (key === 'bins' || key === 'levels') {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return;
    s[key] = key === 'levels' ? Math.min(100, Math.max(1, n)) : Math.min(s.chart === 'hist2d' ? 500 : 1000, Math.max(1, n));
    el.value = String(s[key]);
  } else if (CHECK_KEYS.includes(key)) {
    s[key] = !!v;
  } else if (key === 'cut') {
    const c = Number(v);
    if (!Number.isFinite(c)) return;
    s.cut = Math.min(10, Math.max(0, c));
    el.value = String(s.cut);
  } else if (key === 'level') {
    s.level = Number(v);
  } else if (key === 'interval') {
    s.interval = v === '' ? null : Number(v);
  } else if (TEXT_KEYS.includes(key)) {
    s[key] = v;
    if (key === 'normalise') delete s.density;
  } else if (key === 'panel') {
    s.panel = /^\d+$/.test(v) ? Number(v) : v;
    renderInsets();
  } else if (key === 'xAxis' || key === 'yAxis') {
    s[key] = v;
  } else {
    s[key] = Number(v);
    if (key === 'y') delete s.label;
    // Bars named by text cannot stand on a top axis: the card offers it or not.
    if (key === 'x' && s.chart === 'bar') { redraw(); renderSeries(); return; }
  }
  if (CARD_LOOK[key]) dropLook(s.id, CARD_LOOK[key]);
  if (REBUILD_KEYS.includes(key)) {
    redraw();
    renderSeries();
    card.ownerDocument.querySelector(`.pb-card[data-id="${s.id}"] [data-f="${key}"]`)?.focus();
    return;
  }
  redraw();
});

ui.seriesList.addEventListener('click', (e) => {
  const seg = e.target.closest('[data-f="draw"] > button');
  if (seg) {
    const card = seg.closest('.pb-card');
    const s = seriesById(card.dataset.id);
    const v = seg.dataset.value;
    if (v === s.draw) return;
    const swap = (d) => d === 'band' || d === 'step';
    const rebuild = swap(v) || swap(s.draw);
    s.draw = v;
    if (v === 'band' && !Number.isInteger(s.y2)) {
      const t = fileById(s.fileId).table;
      // The next column of numbers after the lower one, as 'lower, upper' usually stand; else any other.
      const cols = t.headers.map((_, i) => i).filter((i) => i !== s.x && i !== s.y && t.numeric[i]);
      const next = cols.find((i) => i > s.y) ?? cols[0];
      s.y2 = next ?? s.y;
    }
    // A marker or a line the person chose for another way of drawing would contradict this one.
    dropLook(s.id, v === 'line' ? ['marker'] : v === 'points' ? ['lineStyle'] : []);
    if (rebuild) renderSeries();
    else card.querySelectorAll('[data-f="draw"] > button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === v)));
    redraw();
    if (rebuild) card.ownerDocument.querySelector(`.pb-card[data-id="${s.id}"] [data-f="draw"] > [data-value="${v}"]`)?.focus();
    return;
  }
  const act = e.target.closest('[data-act]');
  if (!act) return;
  const id = act.closest('.pb-card').dataset.id;
  if (act.dataset.act === 'remove') {
    const i = state.series.findIndex((s) => s.id === id);
    state.series.splice(i, 1);
    forgetSeries([id]);
    renderSeries();
    redraw();
    const next = ui.seriesList.querySelectorAll('[data-act="remove"]')[Math.min(i, state.series.length - 1)];
    (next || ui.addSeries).focus();
  } else if (act.dataset.act === 'style') {
    openSeriesStyle(id);
  }
});

ui.addSeries.addEventListener('click', () => {
  if (!state.files.length) return;
  const last = state.series[state.series.length - 1];
  const fileId = last && fileById(last.fileId) ? last.fileId : state.files[state.files.length - 1].id;
  const f = fileById(fileId);
  const s = newSeries(fileId);
  if (last && last.fileId === fileId) {
    // Follow the last series' x and way of drawing; plot a column no series of this file plots yet.
    const t = f.table;
    const usedCols = new Set(state.series.filter((x) => x.fileId === fileId && x !== s).flatMap((x) => [x.y, x.y2, x.yerr, x.xerr]).filter(Number.isInteger));
    s.x = last.x;
    s.draw = last.draw === 'band' ? 'line' : last.draw;
    if (['bar', 'hist', 'box', 'violin', 'bars-mean'].includes(last.chart)) s.chart = last.chart;
    // Bars follow the way the last ones lie and stand together.
    if (last.chart === 'bar' || last.chart === 'bars-mean') Object.assign(s, { orientation: last.orientation, stack: last.chart === 'bar' ? last.stack : undefined });
    s.panel = last.panel || 0;
    s.y = t.headers.map((_, i) => i).find((i) => t.numeric[i] && i !== s.x && !usedCols.has(i)) ?? s.y;
  }
  renderSeries();
  redraw();
  const cards = ui.seriesList.querySelectorAll('.pb-card');
  cards[cards.length - 1].querySelector('[data-f="label"]').focus();
});

/* The Style tab, showing one series' section. */
function openSeriesStyle(id) {
  selectTab('style');
  plot.openStyle({ series: id });
  const group = ui.styleHost.querySelector('.fp-group[data-group="series"]');
  if (group) scrollToInRail(group);
}

/* Bring an element of the rail into view: in the rail's own scroll beside the plot, in the page below the pinned plot. */
function scrollToInRail(node) {
  const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'smooth' : 'auto';
  if (!narrow.matches && node === ui.rail) {
    ui.rail.scrollTo({ top: 0, behavior: smooth });
  } else if (!narrow.matches) {
    const tabs = ui.rail.querySelector('.pb-tabs');
    const top = node.getBoundingClientRect().top - ui.rail.getBoundingClientRect().top + ui.rail.scrollTop - (tabs ? tabs.offsetHeight : 0) - 8;
    ui.rail.scrollTo({ top: Math.max(0, top), behavior: smooth });
  } else {
    const pinned = getComputedStyle(ui.plot).position === 'sticky' ? ui.plot.getBoundingClientRect().height : 0;
    const top = node.getBoundingClientRect().top + window.scrollY - headHeight() - pinned - 8;
    window.scrollTo({ top: Math.max(0, top), behavior: smooth });
  }
}

/* ------------------------------------------------------------------ *
 * Layout: the grid, shared axes, the gap, panel letters, insets
 * ------------------------------------------------------------------ */

const pct = (v) => String(Math.round(v * 100));

function insetCard(at, k) {
  const n = `pb-${at.id}`;
  const lay = builderLayout(state.layout);
  // The panels an inset can stand in: the cells with a series in them.
  const cells = builderPanels(state).filter((p) => p.cell !== null).map((p) => p.cell);
  if (!cells.includes(at.parent)) cells.push(at.parent);
  const name = (c) => (lay.cols === 1 ? (c === 0 ? '1 (top)' : String(c + 1)) : `Row ${Math.floor(c / lay.cols) + 1}, column ${(c % lay.cols) + 1}`);
  const num = (key, label, value, extra = '') => `<div class="stk-field"><label for="${n}-${key}">${label}</label><input id="${n}-${key}" type="number" inputmode="decimal" class="stk-input stk-input-sm" data-i="${key}" value="${esc(value)}" ${extra}></div>`;
  const lim = (v) => (v === null || v === undefined ? '' : short(v, 6));
  const card = document.createElement('div');
  card.className = 'pb-inset';
  card.dataset.inset = at.id;
  card.setAttribute('role', 'group');
  card.setAttribute('aria-label', `Inset ${k + 1}`);
  card.innerHTML = `
    <div class="pb-inset-h"><span>Inset ${k + 1}</span>
      <button type="button" class="stk-btn stk-btn-sm stk-btn-ghost stk-btn-icon" data-i="remove" aria-label="Remove inset ${k + 1}"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button></div>
    <div class="pb-grid2">
      <div class="stk-field"><label for="${n}-parent">Inset of panel</label><select id="${n}-parent" class="stk-select stk-select-sm" data-i="parent">${options(cells.sort((a, b) => a - b).map((c) => [c, name(c)]), at.parent)}</select></div>
      <div class="stk-field pb-check"><label class="stk-check"><input id="${n}-zoom" type="checkbox" data-i="zoom"${at.zoom ? ' checked' : ''}> Mark what it enlarges</label></div>
      ${num('x', 'From the left (%)', pct(at.x), 'min="0" max="90" step="1"')}${num('y', 'From the bottom (%)', pct(at.y), 'min="0" max="90" step="1"')}
      ${num('w', 'Width (%)', pct(at.w), 'min="10" max="100" step="1"')}${num('h', 'Height (%)', pct(at.h), 'min="10" max="100" step="1"')}
      ${num('x0', 'X from', lim(at.xLim[0]), 'step="any" placeholder="Auto"')}${num('x1', 'X to', lim(at.xLim[1]), 'step="any" placeholder="Auto"')}
      ${num('y0', 'Y from', lim(at.yLim[0]), 'step="any" placeholder="Auto"')}${num('y1', 'Y to', lim(at.yLim[1]), 'step="any" placeholder="Auto"')}
    </div>
    <p class="pb-card-hint">Its series are those whose <strong>Panel</strong> is Inset ${k + 1}. Drag inside the inset to choose what it shows; double-click it to fit its data.</p>`;
  return card;
}

/* The inset cards, kept in step with the insets of the state. */
function renderInsets() {
  const focusId = document.activeElement && document.activeElement.id;
  state.layout.insets = builderLayout(state.layout).insets;
  ui.insets.replaceChildren(...state.layout.insets.map((at, k) => insetCard(at, k)));
  ui.addInset.disabled = state.layout.insets.length >= MAX_INSETS || !state.series.length;
  if (focusId && $(focusId)) $(focusId).focus();
}

/* What the Layout section shows: the grid and the shared axes of the state,
   the gap and the letters of the figure as drawn (they are in the style). */
function syncLayout() {
  const lay = builderLayout(state.layout);
  const f = plot && plot.figure();
  ui.layout.hidden = !state.series.length;
  const put = (input, v) => { if (document.activeElement !== input) input.value = v; };
  put(ui.rows, String(lay.rows));
  put(ui.cols, String(lay.cols));
  ui.shareX.value = lay.sharex;
  ui.shareY.value = lay.sharey;
  // In one column 'down a column' is 'all'; along a row means nothing there.
  ui.shareX.querySelector('[value="col"]').hidden = lay.cols === 1;
  ui.shareY.querySelector('[value="row"]').hidden = lay.cols === 1;
  ui.gapWField.hidden = lay.cols === 1;
  const gap = f ? f.panelGap : { h: null, w: null };
  put(ui.gapH, gap.h === null ? '' : short(gap.h));
  put(ui.gapW, gap.w === null ? '' : short(gap.w));
  const letters = f ? f.panelLabels : { show: false, style: '(a)', position: 'inside' };
  ui.letters.checked = letters.show;
  ui.letterStyle.value = letters.style;
  ui.letterPlace.value = letters.position;
  ui.letterStyleField.hidden = !letters.show;
  ui.letterPlaceField.hidden = !letters.show;
  const n = builderPanels(state).filter((p) => p.cell !== null).length;
  const parts = [lay.cols > 1 ? `${lay.rows} × ${lay.cols}` : plural(n, 'panel')];
  if (n > 1 && lay.sharex !== 'none' && lay.cols > 1) parts.push(lay.sharex === 'all' ? 'x shared' : 'x shared by column');
  if (n > 1 && lay.sharey !== 'none') parts.push(lay.sharey === 'all' ? 'y shared' : 'y shared by row');
  if (gap.h !== null || gap.w !== null) parts.push(`gap ${[gap.h, lay.cols > 1 ? gap.w : null].filter((v) => v !== null).map((v) => short(v)).join(' × ')} pt`);
  if (letters.show) parts.push('lettered');
  if (lay.insets.length) parts.push(plural(lay.insets.length, 'inset'));
  ui.layoutSum.textContent = parts.join(', ');
  ui.addInset.disabled = lay.insets.length >= MAX_INSETS || !state.series.length;
}

/* The grid changed: the cards' Panel menus and the insets' follow it. */
function relayout() {
  renderSeries();
  redraw();
}

ui.rows.addEventListener('change', () => {
  const n = Math.round(Number(ui.rows.value));
  state.layout.rows = Number.isFinite(n) ? Math.min(MAX_GRID_ROWS, Math.max(1, n)) : 1;
  ui.rows.value = String(state.layout.rows);
  relayout();
});
ui.cols.addEventListener('change', () => {
  const before = builderLayout(state.layout).cols;
  const n = Math.round(Number(ui.cols.value));
  const cols = Number.isFinite(n) ? Math.min(MAX_GRID_COLS, Math.max(1, n)) : 1;
  ui.cols.value = String(cols);
  if (cols === before) return;
  // Every series and inset keeps its row and, where there still is one, its column.
  const move = (cell) => Math.floor(cell / before) * cols + Math.min(cell % before, cols - 1);
  for (const s of state.series) if (typeof s.panel !== 'string') s.panel = move(Math.max(0, Math.round(s.panel || 0)));
  for (const at of state.layout.insets) at.parent = move(at.parent);
  state.layout.cols = cols;
  // Enough rows for the panels there are.
  const last = Math.max(0, ...state.series.filter((s) => typeof s.panel !== 'string').map((s) => s.panel));
  state.layout.rows = Math.min(MAX_GRID_ROWS, Math.max(builderLayout(state.layout).rows, cols > 1 ? Math.floor(last / cols) + 1 : 1));
  relayout();
});
ui.shareX.addEventListener('change', () => { state.layout.sharex = ui.shareX.value; redraw(); });
ui.shareY.addEventListener('change', () => { state.layout.sharey = ui.shareY.value; redraw(); });

/* The gap and the letters are look: they go into the style (not into the house style kept between visits). */
function setGap() {
  const read = (input) => { const t = input.value.trim(); const v = Number(t); return t === '' || !Number.isFinite(v) ? null : Math.min(144, Math.max(0, v)); };
  const next = plot.getStyle();
  const gap = { h: read(ui.gapH), w: read(ui.gapW) };
  if (gap.h === null && gap.w === null) delete next.panelGap; else next.panelGap = gap;
  setStyle(next);
}
ui.gapH.addEventListener('change', setGap);
ui.gapW.addEventListener('change', setGap);
function setLetters() {
  const next = plot.getStyle();
  next.panelLabels = { ...(next.panelLabels || {}), show: ui.letters.checked, style: ui.letterStyle.value, position: ui.letterPlace.value };
  setStyle(next);
}
ui.letters.addEventListener('change', setLetters);
ui.letterStyle.addEventListener('change', setLetters);
ui.letterPlace.addEventListener('change', setLetters);

/*
 * A new inset, in the first panel: it shows that panel's first curve again
 * (the series is added with it), enlarged over the first quarter of its x
 * range, with the box on the panel that marks it.
 */
ui.addInset.addEventListener('click', () => {
  if (state.layout.insets.length >= MAX_INSETS || !state.series.length) return;
  const cells = builderPanels(state).filter((p) => p.cell !== null);
  const parent = cells.length ? cells[0].cell : 0;
  let id = `inset${nextInset++}`;
  while (state.layout.insets.some((x) => x.id === id)) id = `inset${nextInset++}`;
  const at = { id, parent, x: 0.5, y: 0.5, w: 0.45, h: 0.42, zoom: true, xLim: [null, null], yLim: [null, null] };
  const from = state.series.find((s) => typeof s.panel !== 'string' && Math.max(0, Math.round(s.panel || 0)) === parent && (!s.chart || s.chart === 'curve'));
  if (from) {
    const t = fileById(from.fileId).table;
    const xs = t.columns[from.x] || []; const ys = t.columns[from.y] || [];
    const ok = xs.map((v, i) => i).filter((i) => Number.isFinite(xs[i]) && Number.isFinite(ys[i]));
    if (ok.length > 3) {
      const lo = Math.min(...ok.map((i) => xs[i])); const hi = Math.max(...ok.map((i) => xs[i]));
      const to = lo + (hi - lo) / 4;
      const inside = ok.filter((i) => xs[i] <= to).map((i) => ys[i]);
      if (inside.length > 1 && hi > lo) {
        const y0 = Math.min(...inside); const y1 = Math.max(...inside);
        const m = 0.05 * ((y1 - y0) || 1);
        at.xLim = [tidy(lo, to - lo), tidy(to, to - lo)];
        at.yLim = [tidy(y0 - m, y1 - y0 || 1), tidy(y1 + m, y1 - y0 || 1)];
      }
    }
    const copy = newSeries(from.fileId, { x: from.x, y: from.y, draw: from.draw === 'band' ? 'line' : from.draw, panel: id, label: '' });
    // The same curve, in the same colour.
    const f = plot.figure();
    const drawn = f ? f.panels.flatMap((p) => p.series).find((q) => q.id === from.id) : null;
    if (drawn && drawn.color) {
      const style = plot.getStyle();
      style.series = { ...(style.series || {}), [copy.id]: { color: drawn.color } };
      plot.setStyle(style);
    }
  } else at.zoom = false;
  state.layout.insets.push(at);
  ui.layout.open = true;
  relayout();
  const card = ui.insets.querySelector(`[data-inset="${id}"] select`);
  if (card) card.focus();
  toast(from ? `Added inset ${state.layout.insets.length} with a series of its own. Drag inside it to choose what it shows.` : `Added inset ${state.layout.insets.length}. Put a series in it with the Panel menu on its card.`, 'ok');
});

ui.insets.addEventListener('change', (e) => {
  const el = e.target.closest('[data-i]');
  if (!el) return;
  const at = state.layout.insets.find((x) => x.id === el.closest('.pb-inset').dataset.inset);
  if (!at) return;
  const key = el.dataset.i;
  const num = () => { const t = el.value.trim(); const v = Number(t); return t === '' || !Number.isFinite(v) ? null : v; };
  if (key === 'parent') at.parent = Number(el.value);
  else if (key === 'zoom') at.zoom = el.checked;
  else if (['x', 'y', 'w', 'h'].includes(key)) { const v = num(); if (v !== null) at[key] = v / 100; }
  else if (key === 'x0' || key === 'x1') at.xLim[key === 'x0' ? 0 : 1] = num();
  else if (key === 'y0' || key === 'y1') at.yLim[key === 'y0' ? 0 : 1] = num();
  renderInsets();
  redraw();
});
ui.insets.addEventListener('click', (e) => {
  const b = e.target.closest('[data-i="remove"]');
  if (!b) return;
  const id = b.closest('.pb-inset').dataset.inset;
  const k = state.layout.insets.findIndex((x) => x.id === id);
  if (k < 0) return;
  state.layout.insets.splice(k, 1);
  // Its series go with it.
  const gone = state.series.filter((s) => s.panel === id).map((s) => s.id);
  state.series = state.series.filter((s) => s.panel !== id);
  forgetSeries(gone);
  relayout();
  ui.addInset.focus();
  toast(`Removed the inset${gone.length ? ' and its series' : ''}.`);
});

/* ------------------------------------------------------------------ *
 * The preview: zoom by dragging, fit by double-clicking, read a point
 * ------------------------------------------------------------------ */

const zoomBox = document.createElement('div');
zoomBox.className = 'pb-zoom';
zoomBox.hidden = true;
const tip = document.createElement('div');
tip.className = 'pb-tip';
tip.hidden = true;
tip.setAttribute('aria-hidden', 'true');
ui.figure.append(zoomBox, tip);

/* Where the pointer is in the figure's own pixels, and the panel it is over. */
function locate(e) {
  const gd = ui.figure.querySelector('.fp-figure');
  const info = plot.info();
  if (!gd || !gd._fullLayout || !info || !info.axes) return null;
  const r = gd.getBoundingClientRect();
  const scale = info.scale || (r.width / info.widthPx) || 1;
  const fx = (e.clientX - r.left) / scale;
  const fy = (e.clientY - r.top) / scale;
  // An inset lies over its panel: it comes first.
  const over = (b) => fx >= b.l && fx <= b.r && fy >= b.t && fy <= b.b;
  const insets = info.insets || [];
  let i = info.axes.findIndex((b, k) => insets[k] >= 0 && over(b));
  if (i < 0) i = info.axes.findIndex(over);
  return { gd, info, scale, fx, fy, panel: i, rect: r };
}

/* The mapping between data and figure pixels on panel i: its bottom x and
   left y, and its top x and right y (null when it has none). */
function axesOf(info, i) {
  const box = info.axes && info.axes[i];
  const views = info.views && info.views[i];
  if (!box || !views) return null;
  const lin = (a, from, len) => {
    if (!a) return null;
    const t = (v) => (a.log ? Math.log10(v) : v);
    const t0 = t(a.view[0]); const t1 = t(a.view[1]);
    return {
      log: a.log,
      toPx: (v) => from + ((t(v) - t0) / (t1 - t0)) * len,
      toData: (p) => { const u = t0 + ((p - from) / len) * (t1 - t0); return a.log ? 10 ** u : u; }
    };
  };
  // y pixels run down the page.
  return {
    x: lin(views.x, box.l, box.r - box.l), y: lin(views.y, box.b, box.t - box.b),
    x2: lin(views.x2, box.l, box.r - box.l), y2: lin(views.y2, box.b, box.t - box.b)
  };
}

/* A limit rounded to the digits the zoom can resolve. */
function tidy(v, span) {
  if (!Number.isFinite(v)) return v;
  const digits = Math.min(12, Math.max(3, Math.ceil(Math.log10(Math.abs(v) / span || 1)) + 3));
  return Number(v.toPrecision(digits));
}

let drag = null;
ui.figure.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'touch' || e.button !== 0) return;
  const at = locate(e);
  if (!at || at.panel < 0) return;
  drag = { ...at, x0: e.clientX, y0: e.clientY, id: e.pointerId };
  ui.figure.setPointerCapture(e.pointerId);
  tip.hidden = true;
  e.preventDefault();
});
ui.figure.addEventListener('pointermove', (e) => {
  if (drag && e.pointerId === drag.id) {
    const host = ui.figure.getBoundingClientRect();
    const box = drag.info.axes[drag.panel];
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    const bx0 = drag.rect.left + box.l * drag.scale; const bx1 = drag.rect.left + box.r * drag.scale;
    const by0 = drag.rect.top + box.t * drag.scale; const by1 = drag.rect.top + box.b * drag.scale;
    const x1 = clamp(e.clientX, bx0, bx1); const y1 = clamp(e.clientY, by0, by1);
    const wide = Math.abs(x1 - drag.x0) > 4; const tall = Math.abs(y1 - drag.y0) > 4;
    // Along one direction only, the other axis keeps its range, as Plotly's zoom does.
    const l = wide ? Math.min(drag.x0, x1) : bx0; const r = wide ? Math.max(drag.x0, x1) : bx1;
    const t = tall ? Math.min(drag.y0, y1) : by0; const b = tall ? Math.max(drag.y0, y1) : by1;
    zoomBox.hidden = !(wide || tall);
    Object.assign(zoomBox.style, { left: `${l - host.left}px`, top: `${t - host.top}px`, width: `${r - l}px`, height: `${b - t}px` });
    drag.last = { x1, y1, wide, tall };
    return;
  }
  hover(e);
});
function endDrag(e) {
  if (!drag || e.pointerId !== drag.id) return;
  const d = drag;
  drag = null;
  zoomBox.hidden = true;
  if (!d.last || !(d.last.wide || d.last.tall)) return;
  const ax = axesOf(d.info, d.panel);
  if (!ax) return;
  const toFig = (cx, cy) => ({ fx: (cx - d.rect.left) / d.scale, fy: (cy - d.rect.top) / d.scale });
  const a = toFig(d.x0, d.y0); const b = toFig(d.last.x1, d.last.y1);
  const next = plot.getStyle();
  // The limits the box spans on an axis, smallest first.
  const limits = (m, p0, p1) => {
    const lo = m.toData(p0); const hi = m.toData(p1);
    const span = Math.abs(hi - lo) || 1;
    return [tidy(lo, span), tidy(hi, span)];
  };
  const xs = d.last.wide ? limits(ax.x, Math.min(a.fx, b.fx), Math.max(a.fx, b.fx)) : null;
  const ys = d.last.tall ? limits(ax.y, Math.max(a.fy, b.fy), Math.min(a.fy, b.fy)) : null;
  const panels = (next.panels || []).slice();
  const own = (i) => { while (panels.length <= i) panels.push({}); panels[i] = { ...(panels[i] || {}) }; return panels[i]; };
  // An inset's limits are its own, kept with it: what it shows is where it zooms.
  const f = plot.figure();
  const slot = builderPanels(state)[d.panel];
  const inset = slot && slot.inset ? state.layout.insets.find((x) => x.id === slot.inset.id) : null;
  if (inset) {
    if (xs) inset.xLim = xs;
    if (ys) inset.yLim = ys;
    const mine = own(d.panel);
    delete mine.xLim; delete mine.yLim;
  } else {
    // A shared axis is set on the first of the panels that share it; the
    // one x axis of a plain stack is the figure's.
    const share = (d.info.share && d.info.share[d.panel]) || { x: d.panel, y: d.panel };
    if (xs) { if (f && isStack(f)) next.xLim = xs; else own(share.x).xLim = xs; }
    if (ys) own(share.y).yLim = ys;
  }
  // A second axis zooms with the first: the same stretch of the panel.
  if (d.last.wide && ax.x2) own(d.panel).x2Lim = limits(ax.x2, Math.min(a.fx, b.fx), Math.max(a.fx, b.fx));
  if (d.last.tall && ax.y2) own(d.panel).y2Lim = limits(ax.y2, Math.max(a.fy, b.fy), Math.min(a.fy, b.fy));
  if (panels.some((p) => p && Object.keys(p).length)) next.panels = panels;
  if (inset) { plot.setStyle(next); saveStyle(plot.getStyle()); renderInsets(); redraw(); return; }
  setStyle(next);
}
ui.figure.addEventListener('pointerup', endDrag);
ui.figure.addEventListener('pointercancel', (e) => { if (drag && e.pointerId === drag.id) { drag = null; zoomBox.hidden = true; } });
ui.figure.addEventListener('dblclick', (e) => {
  // On an inset: the inset alone fits its data again.
  const at = locate(e);
  const slot = at && at.panel >= 0 ? builderPanels(state)[at.panel] : null;
  const inset = slot && slot.inset ? state.layout.insets.find((x) => x.id === slot.inset.id) : null;
  if (inset) {
    if (![...inset.xLim, ...inset.yLim].some((v) => v !== null)) return;
    inset.xLim = [null, null];
    inset.yLim = [null, null];
    renderInsets();
    redraw();
    toast('The inset fits its data again.');
    return;
  }
  const next = plot.getStyle();
  const had = next.xLim || (next.panels || []).some((p) => p && (p.xLim || p.yLim || p.y2Lim || p.x2Lim));
  if (!had) return;
  delete next.xLim;
  if (next.panels) next.panels = next.panels.map((p) => { const o = { ...(p || {}) }; delete o.xLim; delete o.yLim; delete o.y2Lim; delete o.x2Lim; return o; });
  setStyle(next);
  toast('The axes fit the data again.');
});
ui.figure.addEventListener('pointerleave', () => { tip.hidden = true; });

/* The value of the marker or line point nearest the pointer, within 12 screen pixels. */
let hoverFrame = 0;
function hover(e) {
  if (e.pointerType === 'touch') return;
  cancelAnimationFrame(hoverFrame);
  hoverFrame = requestAnimationFrame(() => {
    const at = locate(e);
    const f = plot.figure();
    if (!at || at.panel < 0 || !f) { tip.hidden = true; return; }
    const axes = axesOf(at.info, at.panel);
    if (!axes) { tip.hidden = true; return; }
    const reach = 12 / at.scale;
    let best = null;
    for (const q of f.panels[at.panel].series) {
      if (!q.show || !Array.isArray(q.x) || !Array.isArray(q.y) || !['line', 'scatter', 'errorbar'].includes(q.kind)) continue;
      // Each series by the axes it stands on.
      const ax = { x: (q.xAxis === 'top' && axes.x2) || axes.x, y: (q.yAxis === 'right' && axes.y2) || axes.y };
      const n = Math.min(q.x.length, q.y.length);
      for (let i = 0; i < n; i++) {
        const xv = q.x[i]; const yv = q.y[i];
        if (!Number.isFinite(xv) || !Number.isFinite(yv) || (ax.x.log && xv <= 0) || (ax.y.log && yv <= 0)) continue;
        const dx = ax.x.toPx(xv) - at.fx;
        if (Math.abs(dx) > reach) continue;
        const dy = ax.y.toPx(yv) - at.fy;
        const d2 = dx * dx + dy * dy;
        if (d2 <= reach * reach && (!best || d2 < best.d2)) best = { d2, q, i, xv, yv, ax };
      }
    }
    if (!best) { tip.hidden = true; return; }
    const host = ui.figure.getBoundingClientRect();
    const px = at.rect.left + best.ax.x.toPx(best.xv) * at.scale - host.left;
    const py = at.rect.top + best.ax.y.toPx(best.yv) * at.scale - host.top;
    const err = best.q.yerr ? ` ± ${short(best.q.yerr[1][best.i])}` : '';
    tip.innerHTML = `${best.q.label ? `<b>${esc(best.q.label)}</b><br>` : ''}${esc(short(best.xv))}, ${esc(short(best.yv))}${esc(err)}`;
    tip.style.left = `${Math.min(Math.max(px, 60), host.width - 60)}px`;
    tip.style.top = `${Math.max(py, 40)}px`;
    tip.hidden = false;
  });
}

/* ------------------------------------------------------------------ *
 * Start
 * ------------------------------------------------------------------ */

function resetAll() {
  state.files = [];
  state.series = [];
  state.layout = emptyLayout();
  try { localStorage.removeItem(STYLE_KEY); } catch (e) { /* storage blocked */ }
  plot.setStyle({});
  renderFiles();
  renderSeries();
  redraw();
  selectTab('data');
  toast('Cleared the files, the series and the plot style.');
}

ui.example.addEventListener('click', loadExample);
ui.tryExample.addEventListener('click', loadExample);
ui.reset.addEventListener('click', resetAll);

/* ------------------------------------------------------------------ *
 * More examples: a button that shows a list of them
 * ------------------------------------------------------------------ */

ui.examplesList.replaceChildren(...EXAMPLES.map((e) => {
  const li = document.createElement('li');
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'pb-example';
  b.dataset.example = e.id;
  const name = document.createElement('span');
  name.className = 'pb-example-name';
  name.textContent = e.name;
  const text = document.createElement('span');
  text.className = 'pb-example-text';
  text.textContent = e.description;
  b.append(name, text);
  li.append(b);
  return li;
}));

let exampleAsked = null;   // the example waiting for a yes, while the page holds the person's own files
const exampleItems = () => Array.from(ui.examplesList.querySelectorAll('.pb-example'));

function showExampleList() {
  exampleAsked = null;
  ui.examplesConfirm.hidden = true;
  ui.examplesList.hidden = false;
}
function openExamples({ focus = false } = {}) {
  showExampleList();
  ui.examplesPanel.hidden = false;
  ui.examples.setAttribute('aria-expanded', 'true');
  if (focus) exampleItems()[0].focus();
}
function closeExamples({ focus = false } = {}) {
  if (ui.examplesPanel.hidden) return;
  ui.examplesPanel.hidden = true;
  ui.examples.setAttribute('aria-expanded', 'false');
  showExampleList();
  if (focus) ui.examples.focus();
}
/* Load an example from the list. The person's own files are not replaced without a yes. */
function chooseExample(id) {
  const own = state.files.filter((f) => !f.example);
  if (own.length && exampleAsked !== id) {
    const ex = EXAMPLES.find((e) => e.id === id);
    exampleAsked = id;
    ui.examplesAsk.textContent = `“${ex.name}” takes the place of your ${plural(own.length, 'file')} and ${state.series.length} series. Your files stay on your machine, and the plot style stays as it is.`;
    ui.examplesList.hidden = true;
    ui.examplesConfirm.hidden = false;
    ui.examplesYes.focus();
    return;
  }
  closeExamples({ focus: true });
  loadBuiltIn(id);
}

ui.examples.addEventListener('click', () => { if (ui.examplesPanel.hidden) openExamples(); else closeExamples(); });
ui.examples.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowDown') return;
  e.preventDefault();
  openExamples({ focus: true });
});
ui.examplesList.addEventListener('click', (e) => {
  const b = e.target.closest('.pb-example');
  if (b) chooseExample(b.dataset.example);
});
ui.examplesList.addEventListener('keydown', (e) => {
  const items = exampleItems();
  const i = items.indexOf(document.activeElement);
  const to = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: items.length - 1 }[e.key];
  if (to === undefined || i < 0) return;
  e.preventDefault();
  items[(to + items.length) % items.length].focus();
});
ui.examplesYes.addEventListener('click', () => { if (exampleAsked) chooseExample(exampleAsked); });
ui.examplesNo.addEventListener('click', () => { showExampleList(); exampleItems()[0].focus(); });
ui.examples.parentElement.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || ui.examplesPanel.hidden) return;
  e.stopPropagation();
  closeExamples({ focus: true });
});
// The list closes when the focus or a click goes elsewhere.
ui.examples.parentElement.addEventListener('focusout', (e) => {
  if (e.relatedTarget && !ui.examples.parentElement.contains(e.relatedTarget)) closeExamples();
});
document.addEventListener('pointerdown', (e) => { if (!ui.examples.parentElement.contains(e.target)) closeExamples(); });

renderFiles();
renderSeries();
redraw();
let savedTab = null;
try { savedTab = localStorage.getItem(TAB_KEY); } catch (e) { savedTab = null; }
selectTab(savedTab === 'style' ? 'style' : 'data');
