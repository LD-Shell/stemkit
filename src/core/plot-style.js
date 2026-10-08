/**
 * @module core/plot-style
 *
 * One description of how a fitted plot looks, read by both renderers: the
 * Plotly preview on the page and the matplotlib script the page writes. The
 * preview changes as the user tweaks it, and the script draws the same
 * figure, so every field here must mean the same thing to both.
 *
 * Sizes are in inches and points, as matplotlib has them; the preview scales
 * them to pixels at 96 per inch.
 */

export const MARKERS = Object.freeze(['o', 's', '^', 'v', 'D', 'x', '+', '.', 'none']);
export const LINE_STYLES = Object.freeze(['solid', 'dashed', 'dotted', 'dashdot']);
export const FONT_FAMILIES = Object.freeze(['sans-serif', 'serif', 'monospace']);
export const LEGEND_POSITIONS = Object.freeze([
  'best', 'upper right', 'upper left', 'lower left', 'lower right',
  'center left', 'center right', 'lower center', 'upper center', 'center', 'outside right'
]);
export const TICK_MODES = Object.freeze(['auto', 'step', 'count', 'list']);
export const TICK_DIRECTIONS = Object.freeze(['out', 'in', 'inout']);
export const EXPORT_FORMATS = Object.freeze(['pdf', 'png', 'svg']);
export const GRID_AXES = Object.freeze(['both', 'x', 'y']);
/** The units a figure's size can be typed in; it is kept in inches. px are at the figure's dpi. */
export const SIZE_UNITS = Object.freeze(['in', 'cm', 'mm', 'px']);

function axisTicks() {
  return {
    mode: 'auto',        // auto | step (every `step`) | count (about `count`) | list (`values`)
    step: null,
    count: null,
    values: [],          // numbers, used when mode is 'list'
    labels: [],          // optional text for each value in `values`
    minor: false,        // minor ticks between the major ones
    direction: 'out',
    length: 3.5,         // points
    width: 0.8,          // points
    format: '',          // '' (automatic), a printf format such as '%.2f', or 'sci'
    mirror: false        // tick marks on the opposite side too
  };
}

/** The style a new plot starts from. */
export function defaultPlotStyle() {
  return {
    width: 6.4,          // inches
    height: 4.8,         // inches
    dpi: 300,            // for PNG export
    sizeUnit: 'in',      // how the style panel shows width and height: in | cm | mm | px
    fontFamily: 'sans-serif',
    fontSize: 11,        // points: axis labels; ticks are 1 pt smaller, the title 1 pt larger
    titleSize: null,     // points; null: fontSize + 1
    tickSize: null,      // points, the tick labels; null: fontSize - 1 (at least 1)
    title: '',
    xLabel: 'x',
    yLabel: 'y',
    xScale: 'linear',    // linear | log
    yScale: 'linear',
    xLim: [null, null],  // null: automatic
    yLim: [null, null],
    xTicks: axisTicks(),
    yTicks: axisTicks(),
    grid: { show: false, minor: false, color: '#b0b0b0', alpha: 0.5, style: 'solid', width: 0.6, axis: 'both' },   // axis: both | x (vertical lines) | y
    data: { show: true, marker: 'o', size: 6, color: '#1f5c96', edgeColor: '#1f5c96', edgeWidth: 1, alpha: 1, label: 'Data', errorBars: true, errorWidth: 1, capSize: 0 },
    fit: { show: true, color: '#d9480f', width: 2, style: 'solid', label: 'Fit', samples: 400 },
    band: { show: false, color: '#d9480f', alpha: 0.18, level: 0.95, label: '' },   // '' labels it "<level>% confidence band"
    residuals: { show: false, heightRatio: 0.3 },   // the residual panel's height relative to the main panel
    legend: { show: true, position: 'best', frame: true, fontSize: 10 },
    spines: { top: true, right: true, width: 0.8 },
    background: '#ffffff',
    foreground: '#1a1a1a',   // text, tick marks and spines
    export: { format: 'pdf', filename: 'fit', transparent: false, tight: true }   // tight fits the saved page to what is drawn, so it differs a little from width x height
  };
}

const isColour = (c) => typeof c === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(c.trim());
const num = (v, lo, hi, fallback) => {
  const n = Number(v);
  if (v === null || v === '' || !Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
};
const pick = (v, allowed, fallback) => (allowed.includes(v) ? v : fallback);
/* A font size of its own, or null to follow fontSize. */
const optionalSize = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Math.min(60, Math.max(4, Number(v))));

/** The size in points of the title and of the tick labels, as a style or a figure sets them. */
export function textSizes(s) {
  const base = Number(s.fontSize) || 11;
  return {
    title: s.titleSize === null || s.titleSize === undefined ? base + 1 : s.titleSize,
    tick: s.tickSize === null || s.tickSize === undefined ? Math.max(1, base - 1) : s.tickSize
  };
}
const limit = (pair) => {
  const a = Array.isArray(pair) ? pair : [null, null];
  const f = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  return [f(a[0]), f(a[1])];
};

function normaliseTicks(t, d) {
  const src = t && typeof t === 'object' ? t : {};
  const values = Array.isArray(src.values) ? src.values.map(Number).filter(Number.isFinite) : [];
  return {
    mode: pick(src.mode, TICK_MODES, d.mode),
    step: src.step === null || src.step === undefined || src.step === '' ? null : num(src.step, 1e-300, 1e300, null),
    count: src.count === null || src.count === undefined || src.count === '' ? null : Math.round(num(src.count, 2, 50, 5)),
    values,
    labels: Array.isArray(src.labels) ? src.labels.slice(0, values.length).map(String) : [],
    minor: !!src.minor,
    direction: pick(src.direction, TICK_DIRECTIONS, d.direction),
    length: num(src.length, 0, 20, d.length),
    width: num(src.width, 0, 5, d.width),
    format: typeof src.format === 'string' ? src.format.trim() : '',
    mirror: !!src.mirror
  };
}

/**
 * A complete, valid style from a partial or hand-edited one: unknown values
 * fall back to the defaults, numbers are kept in range.
 *
 * @param {object} [style]
 * @returns {ReturnType<typeof defaultPlotStyle>}
 */
export function normalisePlotStyle(style = {}) {
  const d = defaultPlotStyle();
  const s = style && typeof style === 'object' ? style : {};
  const sub = (key) => (s[key] && typeof s[key] === 'object' ? s[key] : {});
  const colour = (v, fallback) => (isColour(v) ? v.trim() : fallback);
  const text = (v, fallback) => (typeof v === 'string' ? v : fallback);
  return {
    width: num(s.width, 1, 30, d.width),
    height: num(s.height, 1, 30, d.height),
    dpi: Math.round(num(s.dpi, 50, 1200, d.dpi)),
    sizeUnit: pick(s.sizeUnit, SIZE_UNITS, d.sizeUnit),
    fontFamily: pick(s.fontFamily, FONT_FAMILIES, d.fontFamily),
    fontSize: num(s.fontSize, 4, 40, d.fontSize),
    titleSize: optionalSize(s.titleSize),
    tickSize: optionalSize(s.tickSize),
    title: text(s.title, d.title),
    xLabel: text(s.xLabel, d.xLabel),
    yLabel: text(s.yLabel, d.yLabel),
    xScale: pick(s.xScale, ['linear', 'log'], d.xScale),
    yScale: pick(s.yScale, ['linear', 'log'], d.yScale),
    xLim: limit(s.xLim),
    yLim: limit(s.yLim),
    xTicks: normaliseTicks(s.xTicks, d.xTicks),
    yTicks: normaliseTicks(s.yTicks, d.yTicks),
    grid: {
      show: sub('grid').show === undefined ? d.grid.show : !!sub('grid').show,
      minor: !!sub('grid').minor,
      color: colour(sub('grid').color, d.grid.color),
      alpha: num(sub('grid').alpha, 0, 1, d.grid.alpha),
      style: pick(sub('grid').style, LINE_STYLES, d.grid.style),
      width: num(sub('grid').width, 0.1, 5, d.grid.width),
      axis: pick(sub('grid').axis, GRID_AXES, d.grid.axis)
    },
    data: {
      show: sub('data').show === undefined ? d.data.show : !!sub('data').show,
      marker: pick(sub('data').marker, MARKERS, d.data.marker),
      size: num(sub('data').size, 0, 30, d.data.size),
      color: colour(sub('data').color, d.data.color),
      edgeColor: colour(sub('data').edgeColor, colour(sub('data').color, d.data.edgeColor)),
      edgeWidth: num(sub('data').edgeWidth, 0, 5, d.data.edgeWidth),
      alpha: num(sub('data').alpha, 0, 1, d.data.alpha),
      label: text(sub('data').label, d.data.label),
      errorBars: sub('data').errorBars === undefined ? d.data.errorBars : !!sub('data').errorBars,
      errorWidth: num(sub('data').errorWidth, 0.1, 5, d.data.errorWidth),
      capSize: num(sub('data').capSize, 0, 20, d.data.capSize)
    },
    fit: {
      show: sub('fit').show === undefined ? d.fit.show : !!sub('fit').show,
      color: colour(sub('fit').color, d.fit.color),
      width: num(sub('fit').width, 0.1, 10, d.fit.width),
      style: pick(sub('fit').style, LINE_STYLES, d.fit.style),
      label: text(sub('fit').label, d.fit.label),
      samples: Math.round(num(sub('fit').samples, 20, 5000, d.fit.samples))
    },
    band: {
      show: !!sub('band').show,
      color: colour(sub('band').color, colour(sub('fit').color, d.band.color)),
      alpha: num(sub('band').alpha, 0, 1, d.band.alpha),
      level: num(sub('band').level, 0.5, 0.999, d.band.level),
      label: text(sub('band').label, d.band.label)
    },
    residuals: {
      show: !!sub('residuals').show,
      heightRatio: num(sub('residuals').heightRatio, 0.15, 0.6, d.residuals.heightRatio)
    },
    legend: {
      show: sub('legend').show === undefined ? d.legend.show : !!sub('legend').show,
      position: pick(sub('legend').position, LEGEND_POSITIONS, d.legend.position),
      frame: sub('legend').frame === undefined ? d.legend.frame : !!sub('legend').frame,
      fontSize: num(sub('legend').fontSize, 4, 40, d.legend.fontSize)
    },
    spines: {
      top: sub('spines').top === undefined ? d.spines.top : !!sub('spines').top,
      right: sub('spines').right === undefined ? d.spines.right : !!sub('spines').right,
      width: num(sub('spines').width, 0, 5, d.spines.width)
    },
    background: colour(s.background, d.background),
    foreground: colour(s.foreground, d.foreground),
    export: {
      format: pick(sub('export').format, EXPORT_FORMATS, d.export.format),
      filename: (text(sub('export').filename, d.export.filename).replace(/[^\w.-]+/g, '_') || d.export.filename),
      transparent: !!sub('export').transparent,
      tight: sub('export').tight === undefined ? d.export.tight : !!sub('export').tight
    }
  };
}

/** How much of the figure height the main panel takes: matplotlib's default subplot, 0.11 to 0.88. */
const MAIN_PANEL_SHARE = 0.77;

/**
 * Whether the confidence band a fit plot asks for can be seen, and if not, why.
 *
 * The band is drawn whenever it can be, but two cases leave it switched on
 * with nothing to see:
 *
 *   - `undetermined`: the parameters' covariance could not be worked out
 *     (two of them cannot be told apart, as in `y = a*b*x`), so the band is
 *     NaN wherever the curve depends on them. A point where every gradient is
 *     zero (x = 0 there) still comes out finite, with zero width, and draws
 *     nothing on its own.
 *   - `hidden`: even at its widest the band is thinner than the fit line, so
 *     the line covers it. The panel height is estimated from the figure's
 *     height (the main panel's share of it, less the residual panel's), so a
 *     band right at the threshold may show a sliver either way. Not judged on
 *     a log y axis.
 *
 * `off` means no band is asked for or none applies (several independent
 * variables, no fit yet); `shown` means it is drawn and wider than the line.
 *
 * @param {{y?: ArrayLike<number>, curve?: {y: ArrayLike<number>}, band?: {lower: ArrayLike<number>, upper: ArrayLike<number>}, multivariate?: object}|null} model
 *   what the plot draws, as fit-plot's figure takes it
 * @param {object} style  a plot style (normalised here)
 * @param {{covariance?: number[][]}|null} [fit]  the fit, for its covariance
 * @returns {{status: 'off'|'shown'|'undetermined'|'hidden', message: string}}
 */
export function bandVisibility(model, style, fit = null) {
  const s = normalisePlotStyle(style);
  const off = { status: 'off', message: '' };
  if (!s.band.show || !model || model.multivariate || !model.band || !model.curve) return off;
  const lower = Array.from(model.band.lower || []);
  const upper = Array.from(model.band.upper || []);
  if (!lower.length) return off;
  const finite = [];
  for (let i = 0; i < lower.length; i++) {
    if (Number.isFinite(lower[i]) && Number.isFinite(upper[i])) finite.push(i);
  }
  const cov = fit && fit.covariance;
  const covBad = Array.isArray(cov) && cov.some(row => Array.from(row).some(v => !Number.isFinite(v)));
  if (!finite.length || (covBad && finite.length < lower.length)) {
    return {
      status: 'undetermined',
      message: 'Band not drawn: the parameters are not independent, so their uncertainties, and the band, cannot be worked out.'
    };
  }
  const shown = { status: 'shown', message: '' };
  if (s.yScale === 'log') return shown;
  let widest = 0;
  let lo = Infinity;
  let hi = -Infinity;
  const take = v => { if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; } };
  for (const i of finite) { widest = Math.max(widest, upper[i] - lower[i]); take(lower[i]); take(upper[i]); }
  Array.from(model.y || []).forEach(take);
  Array.from(model.curve.y || []).forEach(take);
  if (Number.isFinite(s.yLim[0])) lo = s.yLim[0];
  if (Number.isFinite(s.yLim[1])) hi = s.yLim[1];
  const range = hi - lo;
  if (!(range > 0)) return shown;
  const share = s.residuals.show ? 1 / (1 + s.residuals.heightRatio) : 1;
  const panelPt = s.height * 72 * MAIN_PANEL_SHARE * share;
  if ((widest / range) * panelPt >= s.fit.width) return shown;
  const pct = String(Number((s.band.level * 100).toPrecision(4)));
  return {
    status: 'hidden',
    message: `Band is narrower than the line: the ${pct}% band is hidden behind the fitted curve because the fit is very tight.`
  };
}
