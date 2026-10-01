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
 * marker to read its values.
 */
import { mountFigure } from './figure-plot.js';
import { formatSize } from '../src/core/figure.js';
import {
  readTable, builderFigure, pythonFiles, seriesNote, houseStyle, exampleCsv, EXAMPLE_LABELS,
  sourceId, columnName, slug, DRAW_MODES
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
  example: $('pbExample'), tryExample: $('pbTryExample'), reset: $('pbReset')
};
const narrow = window.matchMedia('(max-width: 1023.98px)');

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */

const state = { files: [], series: [] };
let nextSeries = 1;

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
  let note = `Runs with Python 3, numpy and matplotlib 3.6 or later (3.11 or later to match the preview): ${code(`python ${fig.export.filename}.py`)}. `
    + `It saves ${code(`${fig.export.filename}.${fig.export.format}`)}`;
  note += read.length ? `, reading ${read.map((f) => code(f.name)).join(' and ')} from the same folder.` : '.';
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
    note: pythonNote
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
  const title = plot.getStyle().title || '';
  if (slug(title) !== lastSlug) redraw();
  syncCards();
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
  const f = plot.figure();
  const has = !!(f && info);
  ui.logXWrap.hidden = !has;
  ui.logYWrap.hidden = !has;
  ui.hint.hidden = !has;
  if (has) {
    ui.logX.checked = f.xScale === 'log';
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
  const s = { id: `s${nextSeries++}`, fileId, x: cols.x, y: cols.y, y2: null, draw: 'line', yerr: null, xerr: null, panel: 0, ...o };
  state.series.push(s);
  return s;
}

function addFile(name, text, { example = false, id, size = 0 } = {}) {
  const table = readTable(text);
  if (!table.ok) { toast(`${name}: ${table.error}`, 'danger'); return null; }
  const taken = new Set(state.files.map((f) => f.source).filter(Boolean));
  const f = {
    id: id || `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name, size, example, table,
    source: example ? null : sourceId(name, taken),
    labels: example ? EXAMPLE_LABELS : null
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
  if (state.files.some((f) => f.example)) { toast('The example is already loaded.'); return; }
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

const DRAW_NAMES = { line: 'Line', points: 'Points', both: 'Both', band: 'Band' };

function options(list, current) {
  return list.map(([v, l]) => `<option value="${esc(v)}"${String(v) === String(current) ? ' selected' : ''}>${esc(l)}</option>`).join('');
}

function seriesCard(s, k) {
  const f = fileById(s.fileId);
  const t = f.table;
  const cols = t.headers.map((_, i) => [i, columnName(t.headers, i)]);
  const none = [['', 'None'], ...cols];
  const n = s.id;
  const band = s.draw === 'band';
  const multiFile = state.files.length > 1;
  const panels = Math.min(4, state.series.length);
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
    <div class="stk-field"><span class="stk-label-sm" id="${n}-draw-l">Draw</span>
      <div class="stk-seg stk-seg-fill" role="group" aria-labelledby="${n}-draw-l" data-f="draw">
        ${DRAW_MODES.map((d) => `<button type="button" data-value="${d}" aria-pressed="${s.draw === d}">${DRAW_NAMES[d]}</button>`).join('')}
      </div>
    </div>
    <div class="pb-grid2">
      <div class="stk-field"><label for="${n}-x">X column</label><select id="${n}-x" class="stk-select stk-select-sm" data-f="x">${options(cols, s.x)}</select></div>
      <div class="stk-field"><label for="${n}-y">${band ? 'From (lower)' : 'Y column'}</label><select id="${n}-y" class="stk-select stk-select-sm" data-f="y">${options(cols, s.y)}</select></div>
      ${band
        ? `<div class="stk-field"><label for="${n}-y2">To (upper)</label><select id="${n}-y2" class="stk-select stk-select-sm" data-f="y2">${options(cols, Number.isInteger(s.y2) ? s.y2 : s.y)}</select></div>`
        : `<div class="stk-field"><label for="${n}-yerr">Y error</label><select id="${n}-yerr" class="stk-select stk-select-sm" data-f="yerr">${options(none, Number.isInteger(s.yerr) ? s.yerr : '')}</select></div>
           <div class="stk-field"><label for="${n}-xerr">X error</label><select id="${n}-xerr" class="stk-select stk-select-sm" data-f="xerr">${options(none, Number.isInteger(s.xerr) ? s.xerr : '')}</select></div>`}
      ${panels > 1 ? `<div class="stk-field"><label for="${n}-panel">Panel</label><select id="${n}-panel" class="stk-select stk-select-sm" data-f="panel">${options(Array.from({ length: panels }, (_, i) => [i, i === 0 ? '1 (top)' : String(i + 1)]), Math.min(s.panel || 0, panels - 1))}</select></div>` : ''}
    </div>
    <p class="pb-card-note" data-note aria-live="polite"></p>`;
  return card;
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
  syncTabs();
  syncCards();
}

/* What the cards show that comes from the drawing: colour, name, notes. */
function syncCards() {
  const f = plot && plot.figure();
  const drawn = new Map();
  if (f) f.panels.forEach((p) => p.series.forEach((q) => drawn.set(q.id, q)));
  const style = plot ? plot.getStyle() : {};
  const scales = f ? { xLog: f.xScale === 'log' } : {};
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
    let yLog = false;
    if (f) {
      const panels = [...new Set(state.series.map((x) => Math.max(0, x.panel || 0)))].sort((a, b) => a - b);
      const p = f.panels[panels.indexOf(Math.max(0, s.panel || 0))];
      yLog = !!(p && p.yScale === 'log');
    }
    const msg = seriesNote(fileById(s.fileId), s, { ...scales, yLog });
    if (note.textContent !== msg) note.textContent = msg;
  });
}

function defaultLabel(s) {
  if (typeof s.label === 'string') return s.label;
  const t = fileById(s.fileId).table;
  if (s.draw === 'band' && Number.isInteger(s.y2) && s.y2 !== s.y) return `${columnName(t.headers, s.y)} to ${columnName(t.headers, s.y2)}`;
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
  const el = e.target.closest('select[data-f]');
  if (!el) return;
  const card = el.closest('.pb-card');
  const s = seriesById(card.dataset.id);
  const key = el.dataset.f;
  const v = el.value;
  if (key === 'fileId') {
    s.fileId = v;
    const cols = firstColumns(fileById(v));
    Object.assign(s, { x: cols.x, y: cols.y, y2: null, yerr: null, xerr: null });
    delete s.label;
    renderSeries();
  } else if (key === 'yerr' || key === 'xerr') {
    s[key] = v === '' ? null : Number(v);
  } else if (key === 'panel') {
    s.panel = Number(v);
  } else {
    s[key] = Number(v);
    if (key === 'y') delete s.label;
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
    const wasBand = s.draw === 'band';
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
    if (v === 'band' || wasBand) renderSeries();
    else card.querySelectorAll('[data-f="draw"] > button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === v)));
    redraw();
    if (v === 'band' || wasBand) card.ownerDocument.querySelector(`.pb-card[data-id="${s.id}"] [data-f="draw"] > [data-value="${v}"]`)?.focus();
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
  const i = info.axes.findIndex((b) => fx >= b.l && fx <= b.r && fy >= b.t && fy <= b.b);
  return { gd, info, scale, fx, fy, panel: i, rect: r };
}

/* The mapping between data and figure pixels on panel i. */
function axesOf(gd, i) {
  const fl = gd._fullLayout;
  const xa = fl[i === 0 ? 'xaxis' : `xaxis${i + 1}`];
  const ya = fl[i === 0 ? 'yaxis' : `yaxis${i + 1}`];
  if (!xa || !ya || !xa.range || !ya.range) return null;
  const lin = (a) => ({
    log: a.type === 'log',
    toPx: (v) => {
      const t = a.type === 'log' ? Math.log10(v) : v;
      return a._offset + ((t - a.range[0]) / (a.range[1] - a.range[0])) * a._length;
    },
    toData: (p) => {
      const t = a.range[0] + ((p - a._offset) / a._length) * (a.range[1] - a.range[0]);
      return a.type === 'log' ? 10 ** t : t;
    }
  });
  const x = lin(xa);
  const yb = lin(ya);
  // Plotly's y pixels run down the page.
  const y = {
    log: yb.log,
    toPx: (v) => 2 * ya._offset + ya._length - yb.toPx(v),
    toData: (p) => yb.toData(2 * ya._offset + ya._length - p)
  };
  return { x, y };
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
  const ax = axesOf(d.gd, d.panel);
  if (!ax) return;
  const toFig = (cx, cy) => ({ fx: (cx - d.rect.left) / d.scale, fy: (cy - d.rect.top) / d.scale });
  const a = toFig(d.x0, d.y0); const b = toFig(d.last.x1, d.last.y1);
  const next = plot.getStyle();
  if (d.last.wide) {
    const lo = ax.x.toData(Math.min(a.fx, b.fx)); const hi = ax.x.toData(Math.max(a.fx, b.fx));
    const span = Math.abs(hi - lo) || 1;
    next.xLim = [tidy(lo, span), tidy(hi, span)];
  }
  if (d.last.tall) {
    const lo = ax.y.toData(Math.max(a.fy, b.fy)); const hi = ax.y.toData(Math.min(a.fy, b.fy));
    const span = Math.abs(hi - lo) || 1;
    const panels = (next.panels || []).slice();
    while (panels.length <= d.panel) panels.push({});
    panels[d.panel] = { ...(panels[d.panel] || {}), yLim: [tidy(lo, span), tidy(hi, span)] };
    next.panels = panels;
  }
  setStyle(next);
}
ui.figure.addEventListener('pointerup', endDrag);
ui.figure.addEventListener('pointercancel', (e) => { if (drag && e.pointerId === drag.id) { drag = null; zoomBox.hidden = true; } });
ui.figure.addEventListener('dblclick', () => {
  const next = plot.getStyle();
  const had = next.xLim || (next.panels || []).some((p) => p && p.yLim);
  if (!had) return;
  delete next.xLim;
  if (next.panels) next.panels = next.panels.map((p) => { const o = { ...(p || {}) }; delete o.yLim; return o; });
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
    const ax = axesOf(at.gd, at.panel);
    if (!ax) { tip.hidden = true; return; }
    const reach = 12 / at.scale;
    let best = null;
    for (const q of f.panels[at.panel].series) {
      if (!q.show || !Array.isArray(q.x) || !Array.isArray(q.y) || !['line', 'scatter', 'errorbar'].includes(q.kind)) continue;
      const n = Math.min(q.x.length, q.y.length);
      for (let i = 0; i < n; i++) {
        const xv = q.x[i]; const yv = q.y[i];
        if (!Number.isFinite(xv) || !Number.isFinite(yv) || (ax.x.log && xv <= 0) || (ax.y.log && yv <= 0)) continue;
        const dx = ax.x.toPx(xv) - at.fx;
        if (Math.abs(dx) > reach) continue;
        const dy = ax.y.toPx(yv) - at.fy;
        const d2 = dx * dx + dy * dy;
        if (d2 <= reach * reach && (!best || d2 < best.d2)) best = { d2, q, i, xv, yv };
      }
    }
    if (!best) { tip.hidden = true; return; }
    const host = ui.figure.getBoundingClientRect();
    const px = at.rect.left + ax.x.toPx(best.xv) * at.scale - host.left;
    const py = at.rect.top + ax.y.toPx(best.yv) * at.scale - host.top;
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

renderFiles();
renderSeries();
redraw();
let savedTab = null;
try { savedTab = localStorage.getItem(TAB_KEY); } catch (e) { savedTab = null; }
selectTab(savedTab === 'style' ? 'style' : 'data');
