/**
 * Fit plot: the Curve Fitter's figure, a thin layer over js/figure-plot.js.
 *
 * The Curve Fitter keeps its own style object (src/core/plot-style.js), in
 * which the data, the fitted curve, the confidence band and the residual
 * panel each have a group of settings. fitFigure() turns a fit and that style
 * into the figure description every plotting page uses (src/core/figure.js):
 * one panel with the band, the curve and the points (with their error bars),
 * and below it, when asked for, a residual panel sharing the x axis. The
 * shared renderer then draws it as matplotlib will (see the header of
 * js/figure-plot.js for what that means), and src/core/fit-python.js writes
 * the matching script with the shared generator.
 *
 * Exported API (unchanged for the page):
 *   fitFigure(model, style) -> a figure description
 *   buildFitFigure(model, style, options) -> { data, layout, info }   (no DOM needed)
 *   renderFitPlot(el, model, style, options) -> Promise<info>
 *   destroyFitPlot(el)
 *   exportFitPlot(el, style, options) -> Promise<{ filename, format, bytes, widthIn, heightIn, … }>
 *   createStylePanel(host, style, onChange, options) -> { get, set, setContext, destroy, element }
 *   fitCurveGrid(x, style) -> the x values the fitted curve is drawn at
 *   STYLE_PRESETS, and the ports (axisTicks, the locators and formatters,
 *   pyPercent, textToHtml) for tests
 *
 * model = { x, y, sigma?, curve?: {x, y}, band?: {x, lower, upper},
 *           residuals?: {x?, r}, multivariate?: {observed, predicted} }
 * The curve and band are expected at fitCurveGrid(x, style), as the script
 * samples them, so recompute them when fit.samples, the x limits or the x
 * scale change.
 */

import { defaultPlotStyle, normalisePlotStyle } from '../src/core/plot-style.js';
import { symbolToLatex } from '../src/core/expression.js';
import {
  buildFigure, renderFigure, destroyFigure, exportFigure, stylePanelKit, deepMerge, fmtNum,
  MARKER_NAMES, LINE_NAMES, LEGEND_NAMES
} from './figure-plot.js';

export {
  PX_PER_IN, FONT_STACKS, plotlyDash, rgba, textToHtml, textBox, measureHtml, printfFormat, pyPercent,
  scalarFormat, logFormat, maxNLocator, multipleLocator, logLocator, autoMinorLocator, axisTicks, pngWithDpi
} from './figure-plot.js';

const toNum = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));
const numbers = (a) => Array.from(a || [], toNum);
const clone = (o) => JSON.parse(JSON.stringify(o));

/* The data limits of a set of arrays: [min, max] of the finite values
   (positive values only on a log axis), or null. */
function dataLimits(arrays, log) {
  let lo = Infinity; let hi = -Infinity;
  for (const arr of arrays) {
    for (const raw of arr || []) {
      const v = Number(raw);
      if (!Number.isFinite(v) || (log && !(v > 0))) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  return lo <= hi ? [lo, hi] : null;
}

/**
 * The x values the fitted curve is drawn at, as the script samples it:
 * `fit.samples` points across the data, or from an x limit that is set,
 * evenly spaced (in log x on a log axis).
 *
 * @param {ArrayLike<number>} x - the data's x values
 * @param {object} style
 * @returns {number[]}
 */
export function fitCurveGrid(x, style) {
  const s = normalisePlotStyle(style);
  const log = s.xScale === 'log';
  const lim = dataLimits([Array.from(x || [])], log);
  if (!lim) return [];
  const use = (v) => v !== null && !(log && v <= 0);
  const lo = use(s.xLim[0]) ? s.xLim[0] : lim[0];
  const hi = use(s.xLim[1]) ? s.xLim[1] : lim[1];
  const n = s.fit.samples;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0 : i / (n - 1);
    out[i] = log ? 10 ** (Math.log10(lo) + t * (Math.log10(hi) - Math.log10(lo))) : lo + t * (hi - lo);
  }
  out[0] = lo;
  out[n - 1] = hi;
  return out;
}

/**
 * A fit and its style as a figure description: the band, the curve and the
 * points, in that drawing order, the legend listing points, curve and band;
 * below, the residuals about a zero line in the curve's style. With several
 * independent variables the points are the observations against the model's
 * predictions and the diagonal takes the curve's place.
 *
 * @param {object} model - see the header
 * @param {object} style - a plot style (normalised here)
 * @returns {object} a figure description (src/core/figure.js)
 */
export function fitFigure(model, style) {
  const s = normalisePlotStyle(style);
  const m = model || {};
  const multi = !!(m.multivariate && m.multivariate.observed);
  const xLog = s.xScale === 'log';
  const yLog = s.yScale === 'log';

  /* What is drawn */
  const dx = multi ? numbers(m.multivariate.predicted) : numbers(m.x);
  const dy = multi ? numbers(m.multivariate.observed) : numbers(m.y);
  const n = Math.min(dx.length, dy.length);
  dx.length = n; dy.length = n;
  const sig = m.sigma ? numbers(m.sigma).slice(0, n) : null;
  const hasSigma = !!sig && sig.some((v) => v > 0);
  const markerOn = s.data.marker !== 'none';
  const errorBars = s.data.errorBars && hasSigma;
  const pointsDrawn = markerOn || errorBars;
  const showData = s.data.show && pointsDrawn && n > 0;
  const curve = !multi && m.curve ? { x: numbers(m.curve.x), y: numbers(m.curve.y) } : null;
  const showCurve = !multi && s.fit.show && !!curve && curve.x.length > 0;
  let band = null;
  if (!multi && s.band.show && m.band) {
    const bx = numbers(m.band.x); const lo = numbers(m.band.lower); const hi = numbers(m.band.upper);
    const keep = bx.map((v, i) => Number.isFinite(v) && Number.isFinite(lo[i]) && Number.isFinite(hi[i]) && !(xLog && v <= 0));
    band = { x: bx.filter((_, i) => keep[i]), lower: lo.filter((_, i) => keep[i]), upper: hi.filter((_, i) => keep[i]) };
    if (!band.x.length) band = null;
  }
  let diag = null;
  if (multi && s.fit.show) {
    const bothAxes = [...dx, ...dy].filter((v) => Number.isFinite(v) && (!(xLog || yLog) || v > 0));
    if (bothAxes.length) {
      let least = Infinity; let most = -Infinity;
      for (const v of bothAxes) { if (v < least) least = v; if (v > most) most = v; }
      const lo = s.xLim[0] !== null && !(xLog && s.xLim[0] <= 0) ? s.xLim[0] : least;
      const hi = s.xLim[1] !== null ? s.xLim[1] : most;
      const k = s.fit.samples;
      diag = Array.from({ length: k }, (_, i) => {
        const t = k === 1 ? 0 : i / (k - 1);
        return xLog ? 10 ** (Math.log10(lo) + t * (Math.log10(hi) - Math.log10(lo))) : lo + t * (hi - lo);
      });
    }
  }
  let res = null;
  if (s.residuals.show) {
    if (m.residuals && m.residuals.r) {
      res = { x: numbers(m.residuals.x ?? (multi ? m.multivariate.predicted : m.x)), r: numbers(m.residuals.r) };
    } else if (multi) {
      res = { x: dx, r: dy.map((v, i) => v - dx[i]) };
    } else {
      res = { x: [], r: [] };
    }
  }

  /* As series */
  const points = (id, x, y, label, zorder) => {
    const look = { marker: s.data.marker, size: s.data.size, color: s.data.color, edgeColor: s.data.edgeColor,
      edgeWidth: s.data.edgeWidth, alpha: s.data.alpha, label, zorder };
    return errorBars
      ? { id, kind: 'errorbar', x, y, yerr: sig, errorWidth: s.data.errorWidth, capSize: s.data.capSize, ...look }
      : { id, kind: 'scatter', x, y, ...look };
  };
  const fitLook = { color: s.fit.color, lineWidth: s.fit.width, lineStyle: s.fit.style };
  const main = [];
  if (band) {
    const pct = String(Number((s.band.level * 100).toPrecision(4)));
    main.push({ id: 'band', kind: 'band', x: band.x, lower: band.lower, upper: band.upper, color: s.band.color, alpha: s.band.alpha,
      label: s.band.label || `${pct}% confidence band`, zorder: 1 });
  }
  if (showCurve) main.push({ id: 'fit', kind: 'line', x: curve.x, y: curve.y, ...fitLook, label: s.fit.label, zorder: 2 });
  if (diag) main.push({ id: 'fit', kind: 'line', x: diag, y: diag, ...fitLook, label: s.fit.label, zorder: 2 });
  if (showData) main.push(points('data', dx, dy, s.data.label, 3));
  const panels = [{ id: 'main', yLabel: s.yLabel, yScale: s.yScale, yLim: s.yLim, yTicks: s.yTicks, legend: { order: ['data', 'fit', 'band'] }, series: main }];
  if (res) {
    const lower = [{ id: 'zero', kind: 'hline', y: 0, ...fitLook, legend: false, zorder: 2 }];
    if (pointsDrawn && res.x.length) lower.push(points('residuals', res.x, res.r, '', 3));
    panels.push({
      id: 'residuals', ratio: s.residuals.heightRatio, yLabel: 'Residual', yScale: 'linear', yLim: [null, null],
      // The residual axis takes the tick marks' look, not the chosen ticks.
      yTicks: { ...s.yTicks, mode: 'auto', step: null, count: null, values: [], labels: [], format: '' },
      series: lower
    });
  }
  return {
    width: s.width, height: s.height, dpi: s.dpi, fontFamily: s.fontFamily, fontSize: s.fontSize, title: s.title,
    titleSize: s.titleSize, tickSize: s.tickSize,
    background: s.background, foreground: s.foreground, legend: s.legend, grid: s.grid, spines: s.spines, export: s.export,
    xLabel: s.xLabel, xScale: s.xScale, xLim: s.xLim, xTicks: s.xTicks,
    panels
  };
}

/**
 * The figure as Plotly data and layout, laid out as matplotlib lays out the
 * script's figure. Needs no DOM (text is then measured from font averages).
 *
 * @param {object} model - see the header
 * @param {object} style - a plot style (normalised here)
 * @param {object} [options] - as buildFigure: tight, transparent
 * @returns {{data: object[], layout: object, info: object}} see buildFigure
 */
export function buildFitFigure(model, style, options = {}) {
  return buildFigure(fitFigure(model, style), options);
}

/* ------------------------------------------------------------------ *
 * Preview and export
 * ------------------------------------------------------------------ */

const drawn = new WeakMap();

/**
 * Draw the figure into `el` at its true size (96 px per inch), scaled with a
 * CSS transform to fit el's width. Calls made while a drawing is under way
 * are merged: the last one wins and every caller gets its result.
 *
 * @param {HTMLElement} el
 * @param {object} model - see the header
 * @param {object} style
 * @param {object} [options] - as renderFigure: responsive, maxScale, tight
 * @returns {Promise<object>} buildFitFigure's info, plus `scale`, the CSS scale now applied
 */
export function renderFitPlot(el, model, style, options = {}) {
  drawn.set(el, { model, style, options });
  return renderFigure(el, fitFigure(model, style), options);
}

/** Stop observing and remove the preview from `el`. */
export function destroyFitPlot(el) {
  drawn.delete(el);
  destroyFigure(el);
}

/**
 * Save the figure drawn in `el` (by renderFitPlot) in the style's export
 * format, at its exact size, and download it (see exportFigure).
 *
 * @param {HTMLElement} el
 * @param {object} [style] - defaults to the style last drawn
 * @param {{download?: boolean}} [options] - download: false returns the bytes only
 * @returns {Promise<{filename: string, format: string, bytes: Uint8Array, widthIn: number,
 *   heightIn: number, pixelWidth?: number, pixelHeight?: number, raster?: boolean}>}
 */
export async function exportFitPlot(el, style, options = {}) {
  const st = drawn.get(el);
  if (!st || !st.model) throw new Error('Draw the plot before saving it.');
  const s = normalisePlotStyle(style ?? st.style);
  return exportFigure(fitFigure(st.model, s), { ...options, tight: st.options.tight, format: s.export.format });
}

/* ------------------------------------------------------------------ *
 * Style panel
 * ------------------------------------------------------------------ */

/* Presets change the look only: text, limits, tick positions, colours of
   the data and the export settings stay as they are. */
const both = (t) => ({ xTicks: t, yTicks: t });
export const STYLE_PRESETS = Object.freeze({
  publication: {
    width: 3.5, height: 2.6, fontSize: 8,
    ...both({ direction: 'in', length: 3, width: 0.6, minor: true, mirror: true }),
    spines: { top: true, right: true, width: 0.6 },
    grid: { show: false },
    data: { size: 4, edgeWidth: 0.5, errorWidth: 0.6, capSize: 1.5 },
    fit: { width: 1.2 },
    legend: { fontSize: 7, frame: false }
  },
  presentation: {
    width: 10, height: 5.6, fontSize: 18,
    ...both({ direction: 'out', length: 7, width: 1.5, minor: false, mirror: false }),
    spines: { top: false, right: false, width: 1.5 },
    grid: { show: true, minor: false, alpha: 0.35, width: 1, style: 'solid' },
    data: { size: 9, edgeWidth: 1.5, errorWidth: 2, capSize: 0 },
    fit: { width: 3.5 },
    legend: { fontSize: 16, frame: false }
  },
  minimal: {
    ...both({ direction: 'out', minor: false, mirror: false }),
    spines: { top: false, right: false },
    grid: { show: false },
    legend: { frame: false }
  }
});

const getPath = (o, path) => path.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
function setPath(o, path, v) {
  const keys = path.split('.');
  const last = keys.pop();
  keys.reduce((a, k) => a[k], o)[last] = v;
}

/**
 * The panel that edits the Curve Fitter's plot style: the shared groups for
 * the figure, text, axes and ticks, legend, grid, frame and export, with the
 * fit's own for the data, fit line, band and residuals between them, size
 * presets, three look presets and a reset.
 *
 * Every change calls `onChange` with the whole normalised style: at once for
 * colours, lists and checkboxes, after 150 ms of quiet for typed text and
 * numbers.
 *
 * @param {HTMLElement} host
 * @param {object} style
 * @param {(style: object) => void} onChange
 * @param {object} [options]
 * @param {object} [options.context]   - as setContext
 * @param {string[]} [options.open]    - groups open at the start (default ['figure'])
 * @returns {{get: () => object, set: (style: object) => void,
 *   setContext: (ctx: {multivariate?: boolean, hasSigma?: boolean, independent?: string|string[], dependent?: string}) => void,
 *   destroy: () => void, element: HTMLElement}}
 */
export function createStylePanel(host, style, onChange, options = {}) {
  let draft = normalisePlotStyle(style);
  let ctx = { multivariate: false, hasSigma: true, independent: 'x', dependent: 'y' };
  // The automatic labels of the last context. Before any context, only the
  // style's own defaults ('x' and 'y') count as automatic: labels the panel
  // starts with may have been typed (restored from an earlier visit).
  const styleDefaults = defaultPlotStyle();
  let defaultLabels = { x: styleDefaults.xLabel, y: styleDefaults.yLabel };
  let touched = {};
  let batching = false;
  const emit = () => {
    draft = normalisePlotStyle(draft);
    kit.refresh();
    if (typeof onChange === 'function') onChange(clone(draft));
  };
  const kit = stylePanelKit({
    open: options.open,
    read: (path) => getPath(draft, path),
    put: (path, value) => setPath(draft, path, value),
    commit: (path, value) => { setPath(draft, path, value); if (!batching) emit(); },
    batch: (fn) => { batching = true; try { fn(); } finally { batching = false; } emit(); }
  });
  const { el, group, grid, checks, check, number, text, select, colour, range, sub, common } = kit;

  const axisTabs = kit.axisTabs(['x', 'y'].map((k) => ({ key: k, label: `${k} axis`, panel: kit.axisFields(k, k) })));
  const bandNote = el('p', { class: 'stk-hint fp-note', text: 'With several independent variables there is no single curve, so no band.' });
  const sigmaNote = el('p', { class: 'stk-hint fp-note', text: 'Error bars need a column of uncertainties.' });
  const top = kit.top(Object.keys(STYLE_PRESETS));
  const labelText = (path, label) => text(path, label, { onInput: () => { touched[path] = true; } });

  const root = el('div', { class: 'fp-panel' },
    top.node,
    common.figure(),
    group('text', 'Title and labels',
      grid(
        text('title', 'Title', { placeholder: 'None' }),
        labelText('xLabel', 'x-axis label'),
        labelText('yLabel', 'y-axis label'),
        el('p', { class: 'stk-hint fp-hint fp-span', text: 'Put maths between $ signs, as matplotlib does: $\\tau$ / ms, $x^2$, $E_a$.' })
      )),
    group('axes', 'Axes and ticks', ...axisTabs),
    group('data', 'Data points',
      checks(check('data.show', 'Show the data')),
      grid(
        select('data.marker', 'Marker', MARKER_NAMES),
        number('data.size', 'Size', { min: 0, max: 30, step: 0.5, unit: 'pt' }),
        colour('data.color', 'Fill'),
        colour('data.edgeColor', 'Edge'),
        number('data.edgeWidth', 'Edge width', { min: 0, max: 5, step: 0.1, unit: 'pt' }),
        range('data.alpha', 'Opacity', { min: 0, max: 1, step: 0.05 }),
        text('data.label', 'Legend label', { placeholder: 'None: not in the legend' })
      ),
      el('div', { class: 'fp-errorbars' },
        sub('Error bars'),
        checks(check('data.errorBars', 'Show error bars')),
        grid(
          number('data.errorWidth', 'Line width', { min: 0.1, max: 5, step: 0.1, unit: 'pt' }),
          number('data.capSize', 'Cap size', { min: 0, max: 20, step: 0.5, unit: 'pt' })
        )),
      sigmaNote),
    group('fit', 'Fit line',
      checks(check('fit.show', 'Show the fitted curve')),
      grid(
        colour('fit.color', 'Colour'),
        number('fit.width', 'Width', { min: 0.1, max: 10, step: 0.1, unit: 'pt' }),
        select('fit.style', 'Style', LINE_NAMES),
        number('fit.samples', 'Points', { min: 20, max: 5000, step: 10, hint: 'Where the curve is evaluated.' }),
        text('fit.label', 'Legend label', { placeholder: 'None: not in the legend' })
      )),
    group('band', 'Confidence band',
      el('div', { class: 'fp-band' },
        checks(check('band.show', 'Show the confidence band')),
        grid(
          number('band.level', 'Level', { min: 50, max: 99.9, step: 0.5, unit: '%', scale: 100 }),
          colour('band.color', 'Colour'),
          range('band.alpha', 'Opacity', { min: 0, max: 1, step: 0.02 }),
          text('band.label', 'Legend label', { placeholder: '95% confidence band' })
        )),
      bandNote),
    group('residuals', 'Residuals',
      checks(check('residuals.show', 'Residual panel below the plot')),
      grid(range('residuals.heightRatio', 'Panel height', { min: 0.15, max: 0.6, step: 0.05, format: (v) => `${Math.round(v * 100)}%`, span: true })),
      el('p', { class: 'stk-hint fp-hint', text: 'Its height as a share of the main panel\'s. The points are drawn even when the data above are hidden.' })),
    common.legend(),
    common.grid(),
    common.frame(),
    common.export()
  );
  kit.setRoot(root);

  top.presetButtons.forEach((b) => kit.listen(b, 'click', () => {
    draft = normalisePlotStyle(deepMerge(draft, STYLE_PRESETS[b.dataset.preset]));
    emit();
  }));
  kit.listen(top.resetButton, 'click', () => {
    draft = defaultPlotStyle();
    touched = {};
    applyContextLabels(true);
    emit();
  });

  function contextLabels() {
    const dep = ctx.dependent || 'y';
    const math = (name) => `$${symbolToLatex(String(name)) || name}$`;
    if (ctx.multivariate) return { x: `Predicted ${math(dep)}`, y: `Observed ${math(dep)}` };
    const ind = Array.isArray(ctx.independent) ? ctx.independent[0] : ctx.independent;
    return { x: math(ind || 'x'), y: math(dep) };
  }
  /* Fill the axis labels from the equation. A label is replaced only while
     it is still automatic: the last context's label, or the style's default. */
  function applyContextLabels(force) {
    const next = contextLabels();
    let changed = false;
    for (const k of ['x', 'y']) {
      const path = `${k}Label`;
      const cur = draft[path];
      const automatic = cur === defaultLabels[k] || cur === styleDefaults[path];
      const untouched = force || (!touched[path] && automatic);
      if (untouched && cur !== next[k]) { draft[path] = next[k]; changed = true; }
    }
    defaultLabels = next;
    return changed;
  }

  const visible = (sel, on) => root.querySelectorAll(sel).forEach((n) => { n.hidden = !on; });
  kit.onRefresh(() => {
    visible('.fp-errorbars', ctx.hasSigma !== false);
    sigmaNote.hidden = ctx.hasSigma !== false;
    visible('.fp-band', !ctx.multivariate);
    bandNote.hidden = !ctx.multivariate;
    const s = draft;
    const on = (b) => (b ? 'On' : 'Off');
    const marker = (MARKER_NAMES.find(([v]) => v === s.data.marker) || [])[1] || '';
    const sums = {
      ...kit.commonSummaries(),
      axes: `${s.xScale === 'log' ? 'Log' : 'Linear'} × ${s.yScale === 'log' ? 'log' : 'linear'}`,
      data: s.data.show ? `${marker}, ${fmtNum(s.data.size)} pt` : 'Hidden',
      fit: s.fit.show ? (LINE_NAMES.find(([v]) => v === s.fit.style) || [])[1] : 'Hidden',
      band: ctx.multivariate ? 'None' : on(s.band.show),
      residuals: on(s.residuals.show),
      legend: s.legend.show ? (LEGEND_NAMES.find(([v]) => v === s.legend.position) || [])[1] : 'Hidden'
    };
    for (const [k, node] of Object.entries(kit.summaries)) node.textContent = sums[k] || '';
  });

  host.appendChild(root);
  if (options.context) {
    ctx = { ...ctx, ...options.context };
    applyContextLabels(false);
  }
  kit.refresh();

  return {
    element: root,
    get: () => clone(normalisePlotStyle(draft)),
    set(next) {
      draft = normalisePlotStyle(next);
      kit.refresh();
    },
    setContext(next = {}) {
      ctx = { ...ctx, ...next };
      const changed = applyContextLabels(false);
      kit.refresh();
      if (changed) emit();
    },
    destroy() {
      kit.destroy();
      root.remove();
    }
  };
}
