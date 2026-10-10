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

/*
 * What matplotlib sets aside around a set of axes, in points, and the size of
 * its text in font sizes. Constrained layout, which the figure is laid out
 * with, takes these off the figure and gives the axes the rest, so the room
 * the decorations take does not shrink with the figure.
 */
const AROUND = Object.freeze({
  pad: 3,          // figure.constrained_layout.h_pad and w_pad (0.04167 in), at each edge
  tickPad: 3.5,    // xtick.major.pad: from the tick marks to their labels
  labelPad: 4,     // axes.labelpad: from the tick labels to the axis label
  titlePad: 6,     // axes.titlepad
  line: 0.94,      // a line of text, which is at least as tall as "lp"
  ascent: 0.73,    // the part of it above the baseline, where a title stands
  digit: 0.55      // the width of a digit
});

const PT_PER_IN = 72;

/*
 * The size of the main panel in points when the plot itself is not there to
 * be measured: the figure less its decorations, which for the figure this
 * style describes are the tick marks and their labels, the axis labels, a
 * title when there is one, and with a residual panel the gap above it (its
 * tick marks and two pads) and its share of the height. The tick labels of
 * the y axis are taken as three digits wide. For the default style that is
 * 0.894 of the figure's height, 0.666 with the residual panel; text that is
 * larger, a title or a smaller figure leave less.
 */
function estimatedPanel(s) {
  const sizes = textSizes(s);
  const outside = (t) => (t.direction === 'out' ? t.length : t.direction === 'inout' ? t.length / 2 : 0);
  const label = (text) => (String(text).trim() ? AROUND.labelPad + AROUND.line * s.fontSize : 0);
  let down = 2 * AROUND.pad + outside(s.xTicks) + AROUND.tickPad + AROUND.line * sizes.tick + label(s.xLabel);
  if (s.title.trim()) down += AROUND.titlePad + AROUND.ascent * sizes.title;
  if (s.residuals.show) down += outside(s.xTicks) + 2 * AROUND.pad;
  const across = 2 * AROUND.pad + outside(s.yTicks) + AROUND.tickPad + 3 * AROUND.digit * sizes.tick + label(s.yLabel);
  return {
    width: s.width * PT_PER_IN - across,
    height: (s.height * PT_PER_IN - down) / (s.residuals.show ? 1 + s.residuals.heightRatio : 1)
  };
}

/*
 * The limits matplotlib gives an axis, in the axis's own coordinates (decades
 * on a log axis): the span of what is drawn and a 5% margin at each end, or
 * the limit that is set. Null when nothing can be drawn.
 */
function estimatedView(arrays, limits, log) {
  const at = (v) => (log ? Math.log10(v) : v);
  let lo = Infinity;
  let hi = -Infinity;
  for (const arr of arrays) {
    for (const raw of arr || []) {
      const v = Number(raw);
      if (raw === null || !Number.isFinite(v) || (log && !(v > 0))) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  if (!(lo <= hi)) return null;
  const margin = 0.05 * (at(hi) - at(lo));
  const set = (v) => v !== null && Number.isFinite(v) && !(log && v <= 0);
  return [set(limits[0]) ? at(limits[0]) : at(lo) - margin, set(limits[1]) ? at(limits[1]) : at(hi) + margin];
}

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
 *   - `hidden`: nowhere does the band reach past the fit line drawn over it.
 *     The line covers what lies within half its width of the curve, measured
 *     across the curve, so where the curve climbs the band may be taller than
 *     the line is wide and still be covered: its height is taken across the
 *     curve as it slopes on the page. Not judged on a log y axis.
 *
 * `off` means no band is asked for or none applies (several independent
 * variables, no fit yet); `shown` means it is drawn and wider than the line.
 *
 * How large the band comes out depends on the panel it is drawn in. A page
 * that has drawn the plot passes the panel as `plot`; without it the panel's
 * size is worked out from the style, as matplotlib's constrained layout
 * leaves it once the tick labels, axis labels and title have their room, and
 * its limits from what the plot draws with matplotlib's 5% margins, so a band
 * right at the threshold may then show a sliver either way.
 *
 * @param {{x?: ArrayLike<number>, y?: ArrayLike<number>, sigma?: ArrayLike<number>, curve?: {x?: ArrayLike<number>, y: ArrayLike<number>}, band?: {x?: ArrayLike<number>, lower: ArrayLike<number>, upper: ArrayLike<number>}, multivariate?: object}|null} model
 *   what the plot draws, as fit-plot's figure takes it
 * @param {object} style  a plot style (normalised here)
 * @param {{covariance?: number[][]}|null} [fit]  the fit, for its covariance
 * @param {{width?: number, height?: number, xView?: number[], yView?: number[]}|null} [plot]
 *   the main panel as drawn: the width and height of its axes in points, and
 *   the limits of its x and y axes. Any of them left out is estimated.
 * @returns {{status: 'off'|'shown'|'undetermined'|'hidden', message: string}}
 */
export function bandVisibility(model, style, fit = null, plot = null) {
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

  /* The panel: its size in points and the limits of its axes */
  const given = plot && typeof plot === 'object' ? plot : {};
  const size = estimatedPanel(s);
  const positive = (v, fallback) => (Number.isFinite(v) && v > 0 ? v : fallback);
  const xLog = s.xScale === 'log';
  const along = (v) => (xLog ? Math.log10(v) : v);
  const view = (v, log) => (Array.isArray(v) && v.length === 2 && v.every(q => Number.isFinite(q) && !(log && q <= 0))
    ? [log ? Math.log10(v[0]) : v[0], log ? Math.log10(v[1]) : v[1]] : null);
  const curveX = Array.from(model.curve.x || []);
  const curveY = Array.from(model.curve.y || []);
  const bandX = Array.from(model.band.x || []);
  // What the axes are scaled to: the points when they are drawn, with their
  // error bars, the curve and the band.
  const sigma = s.data.errorBars && model.sigma ? Array.from(model.sigma, Number) : null;
  const bars = !!sigma && sigma.some(v => v > 0);
  const points = s.data.show && (s.data.marker !== 'none' || bars);
  const dataX = points ? Array.from(model.x || []) : [];
  const dataY = points ? Array.from(model.y || []) : [];
  const barEnds = bars && points ? [dataY.map((v, i) => v - sigma[i]), dataY.map((v, i) => Number(v) + sigma[i])] : [];
  const drawnCurve = s.fit.show ? [curveX, curveY] : [[], []];
  const xView = view(given.xView, xLog) || estimatedView([dataX, drawnCurve[0], bandX], s.xLim, xLog);
  const yView = view(given.yView, false) || estimatedView([dataY, ...barEnds, drawnCurve[1], lower, upper], s.yLim, false);
  const perY = yView && Math.abs(yView[1] - yView[0]) > 0 ? positive(given.height, size.height) / Math.abs(yView[1] - yView[0]) : NaN;
  if (!(perY > 0) || !Number.isFinite(perY)) return shown;
  const perX = xView && Math.abs(xView[1] - xView[0]) > 0 ? positive(given.width, size.width) / Math.abs(xView[1] - xView[0]) : NaN;

  /* The band's height across the curve, at its widest, in points */
  const xs = bandX.length === lower.length ? bandX : curveX;
  const sloped = perX > 0 && Number.isFinite(perX) && xs.length === lower.length && curveY.length === lower.length;
  const across = (i) => {
    if (!sloped) return 1;
    const a = Math.max(i - 1, 0);
    const b = Math.min(i + 1, lower.length - 1);
    const run = (along(xs[b]) - along(xs[a])) * perX;
    const rise = (curveY[b] - curveY[a]) * perY;
    const length = Math.hypot(run, rise);
    return Number.isFinite(length) && length > 0 ? Math.abs(run) / length : 1;
  };
  let widest = 0;
  for (const i of finite) widest = Math.max(widest, (upper[i] - lower[i]) * perY * across(i));
  if (widest >= s.fit.width) return shown;
  const pct = String(Number((s.band.level * 100).toPrecision(4)));
  return {
    status: 'hidden',
    message: `Band is narrower than the line: the ${pct}% band is hidden behind the fitted curve because the fit is very tight.`
  };
}
