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
 *   createStylePanel(host, style, onChange, options) -> { get, set, setContext, showSeries, destroy, element }
 *     (the figure panel every plotting page has, editing the plot style)
 *   foldFigureStyle(style, change) -> the plot style with a figure panel's change in it
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
import { buildFigure, renderFigure, destroyFigure, exportFigure, createFigureStylePanel, deepMerge } from './figure-plot.js';

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
    width: s.width, height: s.height, dpi: s.dpi, sizeUnit: s.sizeUnit, fontFamily: s.fontFamily, fontSize: s.fontSize, title: s.title,
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
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/* The figure's keys a plot style keeps under the same name. */
const FIGURE_KEYS = ['width', 'height', 'dpi', 'sizeUnit', 'fontFamily', 'fontSize', 'titleSize', 'tickSize', 'title',
  'background', 'foreground', 'legend', 'grid', 'spines', 'export', 'xLabel', 'xScale', 'xLim', 'xTicks'];
/* A series' look in the figure, and where the plot style keeps it. */
const SERIES_KEYS = {
  data: { show: 'data.show', label: 'data.label', marker: 'data.marker', size: 'data.size', color: 'data.color', edgeColor: 'data.edgeColor',
    edgeWidth: 'data.edgeWidth', alpha: 'data.alpha', errorWidth: 'data.errorWidth', capSize: 'data.capSize' },
  fit: { show: 'fit.show', label: 'fit.label', color: 'fit.color', lineWidth: 'fit.width', lineStyle: 'fit.style' },
  band: { show: 'band.show', label: 'band.label', color: 'band.color', alpha: 'band.alpha' }
};

/**
 * Fold a change the figure panel makes (a partial figure style, see
 * applyStyle in src/core/figure.js) into a plot style: the figure's keys as
 * they are, the main panel's y axis, and the data, fit and band series.
 *
 * @param {object} style - a plot style
 * @param {object} change - a partial figure style
 * @returns {object} the normalised plot style
 */
export function foldFigureStyle(style, change) {
  const s = normalisePlotStyle(style);
  const c = isObject(change) ? change : {};
  const merge = (a, b) => (isObject(b) ? deepMerge(isObject(a) ? a : {}, b) : b);
  for (const k of FIGURE_KEYS) if (c[k] !== undefined) s[k] = merge(s[k], c[k]);
  const main = Array.isArray(c.panels) && isObject(c.panels[0]) ? c.panels[0] : null;
  if (main) for (const k of ['yLabel', 'yScale', 'yLim', 'yTicks']) if (main[k] !== undefined) s[k] = merge(s[k], main[k]);
  for (const [id, map] of Object.entries(SERIES_KEYS)) {
    const o = isObject(c.series) ? c.series[id] : null;
    if (!isObject(o)) continue;
    for (const [k, path] of Object.entries(map)) if (o[k] !== undefined) setPath(s, path, o[k]);
  }
  return normalisePlotStyle(s);
}

/*
 * The description the panel edits: the fit figure's look with no data, the
 * data, fit and band always there (with their Show switches), and the
 * residual panel while it is on.
 */
function panelFigure(s, ctx) {
  const main = [
    { id: 'data', kind: 'errorbar', show: s.data.show, label: s.data.label, marker: s.data.marker, size: s.data.size, color: s.data.color,
      edgeColor: s.data.edgeColor, edgeWidth: s.data.edgeWidth, alpha: s.data.alpha, errorWidth: s.data.errorWidth, capSize: s.data.capSize },
    { id: 'fit', kind: 'line', show: s.fit.show, label: s.fit.label, color: s.fit.color, lineWidth: s.fit.width, lineStyle: s.fit.style }
  ];
  if (!ctx.multivariate) main.push({ id: 'band', kind: 'band', show: s.band.show, label: s.band.label, color: s.band.color, alpha: s.band.alpha });
  const panels = [{ id: 'main', yLabel: s.yLabel, yScale: s.yScale, yLim: s.yLim, yTicks: s.yTicks, series: main }];
  if (s.residuals.show) panels.push({ id: 'residuals', ratio: s.residuals.heightRatio, yLabel: 'Residual', series: [] });
  const f = { panels };
  for (const k of FIGURE_KEYS) f[k] = clone(s[k]);
  return f;
}

/**
 * The Curve Fitter's style panel: the figure panel every plotting page has
 * (createFigureStylePanel in js/figure-plot.js), editing the plot style. The
 * data points, the fit line and the confidence band are its series, with
 * the fit's own settings beside them (error bars, the points the curve is
 * drawn at, the band's level); the residual panel has a group of its own.
 *
 * Every change calls `onChange` with the whole normalised style.
 *
 * @param {HTMLElement} host
 * @param {object} style
 * @param {(style: object) => void} onChange
 * @param {object} [options]
 * @param {object} [options.context]   - as setContext
 * @param {string[]} [options.open]    - groups open at the start (default ['figure'])
 * @returns {{get: () => object, set: (style: object) => void,
 *   setContext: (ctx: {multivariate?: boolean, hasSigma?: boolean, independent?: string|string[], dependent?: string}) => void,
 *   showSeries: (id: string) => boolean, destroy: () => void, element: HTMLElement}}
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
  const changed = () => { if (typeof onChange === 'function') onChange(clone(draft)); };

  const bandText = () => `${String(Number((draft.band.level * 100).toPrecision(4)))}% confidence band`;
  const DATA = ['show', 'label', 'marker', 'size', 'color', 'edgeColor', 'edgeWidth', 'alpha'];
  const seriesOptions = (q) => {
    if (q.id === 'data') {
      return {
        name: 'Data points', fields: DATA, key: ctx.hasSigma === false ? 'no-sigma' : 'sigma',
        extra: (kit) => (ctx.hasSigma === false
          ? [kit.el('p', { class: 'stk-hint fp-note', text: 'Error bars need a column of uncertainties.' })]
          : [kit.el('div', { class: 'fp-errorbars' },
            kit.sub('Error bars'),
            kit.checks(kit.check('page.data.errorBars', 'Show error bars')),
            kit.grid(
              kit.number('page.data.errorWidth', 'Line width', { min: 0.1, max: 5, step: 0.1, unit: 'pt' }),
              kit.number('page.data.capSize', 'Cap size', { min: 0, max: 20, step: 0.5, unit: 'pt' })
            ))])
      };
    }
    if (q.id === 'fit') {
      return {
        name: 'Fit line', fields: ['show', 'label', 'color', 'lineWidth', 'lineStyle'], key: ctx.multivariate ? 'diagonal' : 'curve',
        extra: (kit) => [
          kit.number('page.fit.samples', 'Points', { min: 20, max: 5000, step: 10, hint: 'Where the curve is evaluated.' }),
          ctx.multivariate ? kit.el('p', { class: 'stk-hint fp-note', text: 'With several independent variables the line is observed = predicted, and there is no single curve, so no band.' }) : null
        ]
      };
    }
    if (q.id === 'band') {
      return {
        name: 'Confidence band', fields: ['show', 'label', 'color', 'alpha'], placeholders: { label: bandText() },
        extra: (kit) => [kit.number('page.band.level', 'Level', { min: 50, max: 99.9, step: 0.5, unit: '%', scale: 100 })]
      };
    }
    return false;
  };

  const panel = createFigureStylePanel(host, panelFigure(draft, ctx), {}, null, {
    open: options.open,
    // A change of the figure panel's: into the plot style.
    absorb(change) {
      const before = draft;
      draft = foldFigureStyle(draft, change);
      if (draft.xLabel !== before.xLabel) touched.xLabel = true;
      if (draft.yLabel !== before.yLabel) touched.yLabel = true;
      changed();
      return panelFigure(draft, ctx);
    },
    onReset() {
      draft = defaultPlotStyle();
      touched = {};
      applyContextLabels(true);
      return panelFigure(draft, ctx);
    },
    page: {
      read: (path) => getPath(draft, path),
      put: (path, value) => { setPath(draft, path, value); draft = normalisePlotStyle(draft); }
    },
    seriesOptions,
    seriesTitle: 'Data, fit and band',
    fixedPanels: ['residuals'],
    omit: ['legend.title', 'legend.columns'],
    groups: (kit) => [kit.group('residuals', 'Residuals',
      kit.checks(kit.check('page.residuals.show', 'Residual panel below the plot')),
      kit.grid(kit.range('page.residuals.heightRatio', 'Panel height', { min: 0.15, max: 0.6, step: 0.05, format: (v) => `${Math.round(v * 100)}%`, span: true })),
      kit.el('p', { class: 'stk-hint fp-hint', text: 'Its height as a share of the main panel\'s. The points are drawn even when the data above are hidden.' }))],
    summaries(sums) {
      const on = (b) => (b ? 'On' : 'Off');
      const shown = [draft.data.show && 'data', draft.fit.show && 'fit', !ctx.multivariate && draft.band.show && 'band'].filter(Boolean);
      sums.series = shown.length ? shown.join(', ').replace(/^./, (c) => c.toUpperCase()) : 'All hidden';
      sums.residuals = on(draft.residuals.show);
    }
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
    let moved = false;
    for (const k of ['x', 'y']) {
      const path = `${k}Label`;
      const cur = draft[path];
      const automatic = cur === defaultLabels[k] || cur === styleDefaults[path];
      const untouched = force || (!touched[path] && automatic);
      if (untouched && cur !== next[k]) { draft[path] = next[k]; moved = true; }
    }
    defaultLabels = next;
    return moved;
  }

  if (options.context) {
    ctx = { ...ctx, ...options.context };
    applyContextLabels(false);
    panel.setFigure(panelFigure(draft, ctx));
  }

  return {
    element: panel.element,
    get: () => clone(draft),
    set(next) {
      draft = normalisePlotStyle(next);
      panel.set({});
      panel.setFigure(panelFigure(draft, ctx));
    },
    setContext(next = {}) {
      ctx = { ...ctx, ...next };
      const moved = applyContextLabels(false);
      panel.setFigure(panelFigure(draft, ctx));
      if (moved) changed();
    },
    /** Show one series' settings (data, fit, band), or the residual group for the residuals. */
    showSeries(id) {
      if (id === 'residuals' || id === 'zero') return panel.open('residuals');
      return panel.showSeries(id);
    },
    destroy() {
      panel.destroy();
    }
  };
}
