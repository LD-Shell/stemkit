/**
 * Fit plot: the live preview of a fitted curve, the panel that styles it, and
 * the export of the figure.
 *
 * One style object (src/core/plot-style.js) drives both this preview and the
 * matplotlib script the page writes (src/core/fit-python.js), so the preview
 * draws what matplotlib will draw. The decisions
 * matplotlib makes on its own are made here the same way:
 *
 *   - axis ranges: the data limits of everything drawn, plus matplotlib's 5%
 *     margins (in log units on a log axis), then the user's limits;
 *   - tick positions: AutoLocator, MaxNLocator, MultipleLocator, LogLocator,
 *     FixedLocator, AutoMinorLocator and the minor LogLocator, ported line by
 *     line from matplotlib 3.6, including the number of ticks that fits the
 *     axis length;
 *   - tick labels: ScalarFormatter (significant digits, offset and ×10ⁿ),
 *     LogFormatterSciNotation, FormatStrFormatter (Python % formatting) and
 *     FixedFormatter;
 *   - layout: constrained layout's pads around the drawing, the axis label,
 *     tick label and title pads, and the height ratio of the residual panel;
 *   - the "best" legend position, by matplotlib's own overlap count.
 *
 * The figure is drawn at its true size, 96 px per inch, and scaled with a
 * CSS transform to fit the page, so the preview is the exported figure in
 * miniature; with export.tight on it is the tight page the script saves.
 *
 * Plotly only paints. Its axes are invisible and serve to place the traces;
 * spines, tick marks and grid lines are drawn as shapes, and every piece of
 * text as an annotation placed by its baseline, so each lands where
 * matplotlib puts it (tick directions in, out and across included).
 *
 * Text: labels and titles follow matplotlib's rule that maths is written
 * between dollar signs. Inside $…$ the common TeX is shown with Unicode and
 * HTML: Greek letters and symbols (\tau, \mu, \pm, \times, \AA …), ^ and _
 * with or without braces, \mathrm, \mathbf, \mathit, \text, \frac{a}{b}
 * (shown as a/b), \sqrt{x} (as √x) and spacing commands. Letters are set in
 * italic as mathtext does. Stacked fractions, big operators with limits,
 * accents and matrices are not drawn as matplotlib draws them; an unknown
 * command is shown as typed. Each of these is listed in info.notes.
 *
 * Exported API:
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
import { pdfFromSvg, pdfFromJpeg } from '../src/core/pdf.js';
import { symbolToLatex } from '../src/core/expression.js';

/* ------------------------------------------------------------------ *
 * Units and matplotlib's defaults
 * ------------------------------------------------------------------ */

export const PX_PER_IN = 96;
const PX_PER_PT = 96 / 72;
const px = (pt) => pt * PX_PER_PT;

/* matplotlib rcParams the script leaves at their defaults. */
const RC = {
  margin: 0.05,          // axes.xmargin / axes.ymargin
  pad: 3.5,              // xtick.major.pad, points
  labelpad: 4,           // axes.labelpad
  titlepad: 6,           // axes.titlepad
  layoutPad: 3,          // figure.constrained_layout.w_pad / h_pad (0.04167 in)
  offsetPad: 3,          // Axis.OFFSETTEXTPAD
  tightPad: 0.1,         // savefig.pad_inches
  legend: {              // legend.* (in font-size units)
    borderpad: 0.4, labelspacing: 0.5, handlelength: 2, handleheight: 0.7,
    handletextpad: 0.8, borderaxespad: 0.5, framealpha: 0.8, edgecolor: '#cccccc'
  }
};

/* The font lists the script gives matplotlib, the browser's usual faces first. */
export const FONT_STACKS = {
  'sans-serif': 'Arial, Helvetica, "Liberation Sans", "DejaVu Sans", sans-serif',
  serif: '"Times New Roman", Times, "Nimbus Roman", "Liberation Serif", "DejaVu Serif", serif',
  monospace: '"Courier New", Courier, "Nimbus Mono PS", "Liberation Mono", "DejaVu Sans Mono", monospace'
};

/* matplotlib's dash patterns, in multiples of the line width (lines.scale_dashes). */
const DASHES = { dashed: [3.7, 1.6], dotted: [1, 1.65], dashdot: [6.4, 1.6, 1, 1.6] };

/** A Plotly dash for a matplotlib line style at a width in points. */
export function plotlyDash(style, widthPt) {
  const d = DASHES[style];
  if (!d) return 'solid';
  const w = Math.max(widthPt, 0.1);
  return d.map((v) => `${round(px(v * w), 2)}px`).join(',');
}

function round(v, digits = 3) {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

/** '#rgb' or '#rrggbb' with an alpha as rgba(). */
export function rgba(hex, alpha = 1) {
  let h = String(hex || '#000000').trim().replace(/^#/, '');
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  const n = parseInt(h.slice(0, 6), 16) || 0;
  const a = Math.min(1, Math.max(0, Number(alpha)));
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${round(a, 4)})`;
}

/* matplotlib markers as Plotly symbols. Sizes are matched by the extent
   matplotlib gives each marker: a circle's diameter, a square's side, the
   diamond's corner to corner, the cross's arm span; Plotly's triangle has a
   different shape, so it is matched by area. */
const MARKER_MAP = {
  o: { symbol: 'circle', k: 1 },
  s: { symbol: 'square', k: 1 },
  '^': { symbol: 'triangle-up', k: 1.0746 },
  v: { symbol: 'triangle-down', k: 1.0746 },
  D: { symbol: 'diamond', k: Math.SQRT2 / 1.3 },
  x: { symbol: 'x-thin', k: 1, line: true },
  '+': { symbol: 'cross-thin', k: 1 / 1.4, line: true },
  '.': { symbol: 'circle', k: 0.5 },
  none: null
};

/* ------------------------------------------------------------------ *
 * Maths text: $…$ as Unicode and Plotly's HTML subset
 * ------------------------------------------------------------------ */

const GREEK = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ϵ', varepsilon: 'ε', zeta: 'ζ', eta: 'η',
  theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π',
  varpi: 'ϖ', rho: 'ρ', varrho: 'ϱ', sigma: 'σ', varsigma: 'ς', tau: 'τ', upsilon: 'υ', phi: 'ϕ',
  varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω'
};
const GREEK_UPPER = {
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Upsilon: 'Υ',
  Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω'
};
const SYMBOLS = {
  times: '×', cdot: '·', pm: '±', mp: '∓', div: '÷', leq: '≤', le: '≤', geq: '≥', ge: '≥', neq: '≠',
  ne: '≠', approx: '≈', sim: '∼', simeq: '≃', equiv: '≡', propto: '∝', infty: '∞', partial: '∂',
  nabla: '∇', degree: '°', circ: '∘', AA: 'Å', hbar: 'ħ', ell: 'ℓ', langle: '⟨', rangle: '⟩',
  rightarrow: '→', to: '→', leftarrow: '←', leftrightarrow: '↔', Rightarrow: '⇒', uparrow: '↑',
  downarrow: '↓', sum: '∑', prod: '∏', int: '∫', prime: '′', ll: '≪', gg: '≫', cdots: '⋯',
  ldots: '…', dots: '…', star: '⋆', ast: '∗', perp: '⊥', parallel: '∥', in: '∈', notin: '∉',
  subset: '⊂', supset: '⊃', cup: '∪', cap: '∩', emptyset: '∅', forall: '∀', exists: '∃',
  angle: '∠', wedge: '∧', vee: '∨', neg: '¬', dagger: '†', percent: '%', '%': '%', '$': '$',
  '{': '{', '}': '}', '_': '_', '#': '#', '&': '&', lbrace: '{', rbrace: '}', vert: '|', '|': '‖',
  backslash: '\\', lvert: '|', rvert: '|', Vert: '‖', ohm: 'Ω', micro: 'µ'
};
const SPACES = { ',': ' ', ':': ' ', ';': ' ', ' ': ' ', quad: ' ', qquad: '  ', '!': '', enspace: ' ', thinspace: ' ' };
const FUNCTIONS = new Set(['sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'sinh', 'cosh', 'tanh', 'arcsin', 'arccos',
  'arctan', 'exp', 'ln', 'log', 'lg', 'max', 'min', 'sup', 'inf', 'lim', 'det', 'deg', 'arg', 'dim', 'ker', 'Pr', 'gcd']);
const IGNORED = new Set(['left', 'right', 'big', 'Big', 'bigg', 'Bigg', 'displaystyle', 'mathdefault', 'limits', 'nolimits']);

const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Split text at the dollar signs matplotlib treats as maths: an even number
 * of unescaped $, as matplotlib's is_math_text has it; otherwise all plain.
 */
function mathSegments(text) {
  const s = String(text ?? '');
  const count = (s.match(/\$/g) || []).length - (s.match(/\\\$/g) || []).length;
  if (!(count > 0 && count % 2 === 0)) return [{ math: false, text: s }];
  const out = [];
  let cur = '';
  let math = false;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '$') { cur += math ? '\\$' : '$'; i++; continue; }
    if (s[i] === '$') { out.push({ math, text: cur }); cur = ''; math = !math; continue; }
    cur += s[i];
  }
  out.push({ math, text: cur });
  return out.filter((p) => p.text !== '' || p.math);
}

/* A tiny TeX reader for mathtext: tokens, groups, scripts. */
function mathToHtml(src, notes) {
  let i = 0;
  const s = src;
  const peek = () => s[i];
  const readCommand = () => {
    // at '\'
    i++;
    if (i >= s.length) return '\\';
    if (/[a-zA-Z]/.test(s[i])) {
      let j = i;
      while (j < s.length && /[a-zA-Z]/.test(s[j])) j++;
      const name = s.slice(i, j);
      i = j;
      return name;
    }
    return s[i++];
  };
  const skipSpace = () => { while (i < s.length && /\s/.test(s[i])) i++; };

  // Reads one "atom" (a group or a single token) and returns HTML.
  const atom = (style) => {
    skipSpace();
    if (i >= s.length) return '';
    const c = peek();
    if (c === '{') {
      i++;
      const html = seq(style, '}');
      if (s[i] === '}') i++;
      return html;
    }
    if (c === '\\') return command(readCommand(), style);
    i++;
    return glyph(c, style);
  };

  const wrapStyle = (text, style) => {
    if (!text) return '';
    let t = text;
    if (style.italic) t = `<i>${t}</i>`;
    if (style.bold) t = `<b>${t}</b>`;
    return t;
  };

  const glyph = (c, style) => {
    if (/[a-zA-Z]/.test(c)) return wrapStyle(escapeHtml(c), { ...style, italic: style.font === 'it' });
    if (c === '-') return wrapStyle('−', { ...style, italic: false });
    if (c === '*') return wrapStyle('∗', { ...style, italic: false });
    if (c === "'") return wrapStyle('′', { ...style, italic: false });
    if (c === '~') return ' ';
    if (/\s/.test(c)) return '';
    return wrapStyle(escapeHtml(c), { ...style, italic: false });
  };

  const argument = (style) => {
    skipSpace();
    if (s[i] === '{') { i++; const h = seq(style, '}'); if (s[i] === '}') i++; return h; }
    return atom(style);
  };

  const command = (name, style) => {
    if (Object.hasOwn(GREEK, name)) return wrapStyle(GREEK[name], { ...style, italic: style.font === 'it' });
    if (Object.hasOwn(GREEK_UPPER, name)) return wrapStyle(GREEK_UPPER[name], { ...style, italic: false });
    if (Object.hasOwn(SYMBOLS, name)) return wrapStyle(escapeHtml(SYMBOLS[name]), { ...style, italic: false });
    if (Object.hasOwn(SPACES, name)) return SPACES[name];
    if (FUNCTIONS.has(name)) return wrapStyle(name, { ...style, italic: false });
    if (IGNORED.has(name)) return '';
    switch (name) {
      case 'mathrm': case 'text': case 'textrm': case 'rm': case 'mathsf': case 'textsf': case 'operatorname': case 'mathregular':
        return name === 'rm' ? seqStyle({ ...style, font: 'rm' }) : argument({ ...style, font: 'rm' });
      case 'mathit': case 'textit': case 'it':
        return name === 'it' ? seqStyle({ ...style, font: 'it' }) : argument({ ...style, font: 'it' });
      case 'mathbf': case 'textbf': case 'bf': case 'boldsymbol':
        return name === 'bf' ? seqStyle({ ...style, bold: true, font: 'rm' }) : argument({ ...style, bold: true, font: name === 'boldsymbol' ? style.font : 'rm' });
      case 'mathtt': case 'texttt': case 'mathcal': case 'mathbb': case 'mathfrak': case 'mathscr':
        return argument({ ...style, font: 'rm' });
      case 'frac': case 'dfrac': case 'tfrac': {
        const a = argument(style); const b = argument(style);
        return `${a}/${b}`;
      }
      case 'sqrt': {
        skipSpace();
        if (s[i] === '[') { const e = s.indexOf(']', i); i = e < 0 ? s.length : e + 1; }
        return `√${argument(style)}`;
      }
      case 'overline': case 'bar': case 'hat': case 'tilde': case 'vec': case 'dot': case 'ddot': case 'widehat': case 'widetilde': case 'underline':
        return argument(style);
      default:
        if (notes && !notes.includes(name)) notes.push(name);
        return wrapStyle(escapeHtml('\\' + name), { ...style, italic: false });
    }
  };

  // \rm-style switches apply to the rest of the current group.
  let switchStyle = null;
  const seqStyle = (style) => { switchStyle = style; return ''; };

  const seq = (style, end) => {
    let out = '';
    let cur = style;
    while (i < s.length && s[i] !== end) {
      const before = switchStyle;
      let piece;
      skipSpace();
      if (i >= s.length || s[i] === end) break;
      const c = s[i];
      if (c === '^' || c === '_') {
        i++;
        const inner = atom({ ...cur });
        piece = c === '^' ? `<sup>${inner}</sup>` : `<sub>${inner}</sub>`;
      } else {
        piece = atom(cur);
      }
      if (switchStyle && switchStyle !== before) { cur = switchStyle; }
      out += piece;
    }
    switchStyle = null;
    return out;
  };

  return seq({ font: 'it', bold: false, italic: false }, undefined);
}

/**
 * Title, label or tick text in Plotly's HTML: plain parts escaped, $…$
 * parts converted from TeX.
 *
 * @param {string} text
 * @param {string[]} [unknown] - receives TeX commands that are not known here
 * @returns {string}
 */
export function textToHtml(text, unknown) {
  return mathSegments(text).map((p) => (p.math ? mathToHtml(p.text, unknown) : escapeHtml(p.text))).join('');
}

/* Whether matplotlib sets the text with mathtext (it has a $…$ pair). */
const isMathText = (text) => mathSegments(text).some((p) => p.math);

/* ------------------------------------------------------------------ *
 * Text boxes
 * ------------------------------------------------------------------ */

/* Share of the font size by family, for when there is no browser to ask
   (tests in Node): the line box of the font and matplotlib's "lp" box. */
const FALLBACK_METRICS = {
  'sans-serif': { top: 0.905, bottom: 0.212, lp: [0.73, 0.21], char: 0.55 },
  serif: { top: 0.891, bottom: 0.216, lp: [0.685, 0.22], char: 0.5 },
  monospace: { top: 0.833, bottom: 0.3, lp: [0.6, 0.18], char: 0.6 }
};
const ZWSP = '​';
const unescapeHtml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/*
 * Plotly HTML as runs of text, each with its size (a share of the font
 * size), its baseline shift in font sizes (up positive) and its style.
 * `shift` is where mathtext puts a script, for matplotlib's box: raised by
 * 0.7 x-heights, lowered by 0.3 (sup1 and sub1 of its font constants), in
 * the size of the text the script is attached to. (Plotly draws them a
 * little further out: 0.6 and 0.3 of the 70% size.)
 */
function htmlRuns(html, xHeight = 0.53) {
  const runs = [];
  const shifts = [];
  let italic = 0; let bold = 0; let shift = 0;
  for (const part of String(html).split(/(<\/?(?:sup|sub|i|b)>)/)) {
    if (!part) continue;
    const tag = part.match(/^<(\/?)(sup|sub|i|b)>$/);
    if (tag) {
      const [, close, name] = tag;
      if (name === 'i') italic += close ? -1 : 1;
      else if (name === 'b') bold += close ? -1 : 1;
      else if (!close) { const d = (name === 'sup' ? 0.7 : -0.3) * xHeight * 0.7 ** shifts.length; shifts.push(d); shift += d; }
      else if (shifts.length) shift -= shifts.pop();
      continue;
    }
    runs.push({ text: unescapeHtml(part), scale: 0.7 ** shifts.length, shift, italic: italic > 0, bold: bold > 0 });
  }
  return runs;
}

/* The SVG Plotly writes for its HTML, for measuring it the way Plotly does. */
function plotlySvgText(html) {
  const stack = [];
  return String(html).split(/(<\/?(?:sup|sub|i|b)>)/).map((part) => {
    const tag = part.match(/^<(\/?)(sup|sub|i|b)>$/);
    if (!tag) return part;
    const [, close, name] = tag;
    if (!close) {
      stack.push(name);
      if (name === 'i') return '<tspan style="font-style:italic">';
      if (name === 'b') return '<tspan style="font-weight:bold">';
      return `${ZWSP}<tspan style="font-size:70%" dy="${name === 'sup' ? '-0.6em' : '0.3em'}">`;
    }
    stack.pop();
    if (name === 'sup') return `</tspan><tspan dy="0.42em">${ZWSP}</tspan>`;
    if (name === 'sub') return `</tspan><tspan dy="-0.21em">${ZWSP}</tspan>`;
    return '</tspan>';
  }).join('') + '</tspan>'.repeat(stack.length);
}

let measureCtx = null;
let measureText = null;
const boxCache = new Map();
const lpCache = new Map();

function browserTools() {
  if (measureCtx === null) {
    measureCtx = false;
    try {
      if (typeof document !== 'undefined' && document.body) {
        measureCtx = document.createElement('canvas').getContext('2d') || false;
        const NS = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(NS, 'svg');
        svg.setAttribute('aria-hidden', 'true');
        svg.setAttribute('width', '1');
        svg.setAttribute('height', '1');
        svg.style.cssText = 'position:absolute;left:-10000px;top:-10000px;overflow:visible;pointer-events:none';
        measureText = document.createElementNS(NS, 'text');
        svg.appendChild(measureText);
        document.body.appendChild(svg);
      }
    } catch { measureCtx = false; }
  }
  return measureCtx ? { ctx: measureCtx, text: measureText } : null;
}

const canvasFont = (family, sizePx, italic, bold) => `${italic ? 'italic ' : ''}${bold ? 'bold ' : ''}${sizePx}px ${FONT_STACKS[family]}`;

/* matplotlib's minimum line box: the ink of "l" above the baseline and of
   "p" below, and the x-height, as shares of the font size (measured large
   for precision). */
function lpMetrics(family) {
  if (lpCache.has(family)) return lpCache.get(family);
  let lp = [...(FALLBACK_METRICS[family] || FALLBACK_METRICS['sans-serif']).lp, 0.53];
  const tools = browserTools();
  if (tools) {
    tools.ctx.font = canvasFont(family, 200, false, false);
    const l = tools.ctx.measureText('l');
    const p = tools.ctx.measureText('p');
    const x = tools.ctx.measureText('x');
    if (l.actualBoundingBoxAscent > 0) lp = [l.actualBoundingBoxAscent / 200, p.actualBoundingBoxDescent / 200, x.actualBoundingBoxAscent / 200];
  }
  lpCache.set(family, lp);
  return lp;
}

/**
 * The size of a piece of Plotly HTML text at a size in px.
 *
 *   width            the advance width
 *   top, height      the box Plotly measures for the SVG text, from the
 *                    baseline (top is negative); Plotly places annotations by it
 *   ascent, descent  matplotlib's box for aligning plain text: the ink of the
 *                    text, or of "lp" where that reaches further
 *   ink              [ascent, descent] of the ink alone, and lp, that of "lp",
 *                    from which mathTextBox builds mathtext's box
 *
 * @param {string} html
 * @param {number} sizePx
 * @param {string} family - a key of FONT_STACKS
 */
export function textBox(html, sizePx, family) {
  const key = `${family}|${sizePx}|${html}`;
  if (boxCache.has(key)) return boxCache.get(key);
  const fb = FALLBACK_METRICS[family] || FALLBACK_METRICS['sans-serif'];
  const [lpA, lpD, xHeight] = lpMetrics(family);
  const runs = htmlRuns(html, xHeight);
  let inkA = -Infinity;
  let inkD = -Infinity;
  let width = 0;
  let top = -fb.top * sizePx;
  let height = (fb.top + fb.bottom) * sizePx;
  const tools = browserTools();
  if (tools) {
    const { ctx, text } = tools;
    for (const r of runs) {
      if (!r.text) continue;
      ctx.font = canvasFont(family, 200, r.italic, r.bold);
      const m = ctx.measureText(r.text);
      const k = (sizePx * r.scale) / 200;
      if (m.actualBoundingBoxAscent + m.actualBoundingBoxDescent > 0) {
        inkA = Math.max(inkA, m.actualBoundingBoxAscent * k + r.shift * sizePx);
        inkD = Math.max(inkD, m.actualBoundingBoxDescent * k - r.shift * sizePx);
      }
    }
    text.setAttribute('style', `font-family: ${FONT_STACKS[family]}; font-size: ${sizePx}px; white-space: pre`);
    text.innerHTML = plotlySvgText(html);
    const b = text.getBBox();
    width = b.width;
    if (b.height > 0) { top = b.y; height = b.height; }
  } else {
    let up = fb.top * sizePx; let down = fb.bottom * sizePx;
    for (const r of runs) {
      width += [...r.text.replace(/​/g, '')].length * sizePx * r.scale * fb.char;
      up = Math.max(up, fb.top * sizePx * r.scale + r.shift * sizePx);
      down = Math.max(down, fb.bottom * sizePx * r.scale - r.shift * sizePx);
      inkA = Math.max(inkA, lpA * sizePx * r.scale + r.shift * sizePx);
      inkD = Math.max(inkD, 0 - r.shift * sizePx);
    }
    top = -up; height = up + down;
  }
  if (!Number.isFinite(inkA)) { inkA = 0; inkD = 0; }
  const lp = [lpA * sizePx, lpD * sizePx];
  const box = { width, top, height, ascent: Math.max(lp[0], inkA), descent: Math.max(lp[1], inkD), ink: [inkA, inkD], lp };
  if (boxCache.size > 4000) boxCache.clear();
  boxCache.set(key, box);
  return box;
}

/** Size of Plotly HTML text in px as the browser boxes it: width, ascent, descent, height. */
export function measureHtml(html, sizePx, family) {
  const b = textBox(html, sizePx, family);
  return { width: b.width, ascent: -b.top, descent: b.height + b.top, height: b.height };
}

/* ------------------------------------------------------------------ *
 * Numbers as Python and matplotlib print them
 * ------------------------------------------------------------------ */

/* Python's divmod for floats (floor division, remainder with the divisor's sign). */
function pyDivmod(x, y) {
  let mod = x % y;
  let div = (x - mod) / y;
  if (mod) {
    if ((y < 0) !== (mod < 0)) { mod += y; div -= 1; }
  } else {
    mod = y < 0 ? -0 : 0;
  }
  let fdiv;
  if (div) {
    fdiv = Math.floor(div);
    if (div - fdiv > 0.5) fdiv += 1;
  } else {
    fdiv = 0;
  }
  return [fdiv, mod];
}
const pyFloorDiv = (x, y) => pyDivmod(x, y)[0];

/* numpy.round: round half to even at `decimals` digits. */
function npRound(x, decimals) {
  const f = 10 ** decimals;
  const y = x * f;
  let r = Math.round(y);
  if (Math.abs(y % 1) === 0.5) r = 2 * Math.round(y / 2);
  return r / f;
}

/* Fixed-point text of |x| rounded half to even, as Python's '%.Nf' does. */
function fixedHalfEven(ax, prec) {
  // From 1e21 up toFixed writes an exponent; such a double is a whole number,
  // which BigInt writes out in full as Python does.
  if (ax >= 1e21) return BigInt(ax).toString() + (prec > 0 ? '.' + '0'.repeat(prec) : '');
  const t = ax.toFixed(prec);
  // A tie exists only when the exact binary value ends in 5 at digit prec+1.
  const exact = ax.toFixed(Math.min(100, prec + 60));
  const tail = exact.slice(exact.indexOf('.') + 1 + prec);
  if (/^50*$/.test(tail)) {
    const down = (Math.floor(ax * 10 ** prec) / 10 ** prec);
    const downText = down.toFixed(prec);
    const lastDigit = Number(downText.replace('.', '').slice(-1));
    return lastDigit % 2 === 0 ? downText : t;
  }
  return t;
}

function pad2Exponent(s) {
  return s.replace(/e([+-])(\d)$/, 'e$10$2');
}

/** One printf conversion applied to x the way Python's % operator does. */
function pyConvert(x, flags, width, prec, conv) {
  const neg = x < 0 || Object.is(x, -0);
  const ax = Math.abs(x);
  let body;
  const alt = flags.includes('#');
  if (!Number.isFinite(x)) {
    body = Number.isNaN(x) ? 'nan' : 'inf';
    if (/[A-Z]/.test(conv)) body = body.toUpperCase();
  } else {
    switch (conv) {
      case 'd': case 'i': case 'u':
        body = ax >= 1e21 ? BigInt(Math.trunc(ax)).toString() : String(Math.trunc(ax));
        break;
      case 'x': case 'X': case 'o':
        body = Math.trunc(ax).toString(conv === 'o' ? 8 : 16);
        if (conv === 'X') body = body.toUpperCase();
        if (alt) body = (conv === 'o' ? '0o' : conv === 'x' ? '0x' : '0X') + body;
        break;
      case 'f': case 'F':
        body = fixedHalfEven(ax, prec ?? 6);
        if (alt && !body.includes('.')) body += '.';
        break;
      case 'e': case 'E':
        body = pad2Exponent(ax.toExponential(prec ?? 6));
        if (conv === 'E') body = body.toUpperCase();
        break;
      case 'g': case 'G': {
        let p = prec ?? 6;
        if (p === 0) p = 1;
        if (ax === 0) { body = alt ? (0).toFixed(p - 1) : '0'; break; }
        const exp = Number(ax.toExponential(p - 1).split('e')[1]);
        if (exp >= -4 && exp < p) {
          body = fixedHalfEven(ax, p - 1 - exp);
          if (!alt && body.includes('.')) body = body.replace(/\.?0+$/, '');
        } else {
          body = ax.toExponential(p - 1);
          if (!alt) body = body.replace(/\.?0+e/, 'e');
          body = pad2Exponent(body);
        }
        if (conv === 'G') body = body.toUpperCase();
        break;
      }
      default:
        body = String(ax);
    }
  }
  let sign = neg && (body !== '0' || conv !== 'd') && !(Number.isNaN(x)) ? '-' : flags.includes('+') ? '+' : flags.includes(' ') ? ' ' : '';
  if (neg && /^[0.]+$/.test(body.replace(/e.*$/i, '')) && /[dxXo]/.test(conv)) sign = flags.includes('+') ? '+' : '';
  let out = sign + body;
  if (width && out.length < width) {
    if (flags.includes('-')) out = out.padEnd(width, ' ');
    else if (flags.includes('0') && Number.isFinite(x)) out = sign + body.padStart(width - sign.length, '0');
    else out = out.padStart(width, ' ');
  }
  return out;
}

const PRINTF_CONVERSION = /%([-+ 0#]*)(\d*)(?:\.(\d+))?([diouxXeEfFgG])/g;

/** A printf format with exactly one conversion (as FormatStrFormatter needs), or null. */
export function printfFormat(format) {
  if (!format || format === 'sci') return null;
  const rest = String(format).replace(/%%/g, '');
  const conversions = rest.match(PRINTF_CONVERSION) || [];
  if (conversions.length !== 1) return null;
  if (rest.replace(PRINTF_CONVERSION, '').includes('%')) return null;
  return format;
}

/** `fmt % x` as Python writes it. */
export function pyPercent(fmt, x) {
  return String(fmt).replace(/%%|%([-+ 0#]*)(\d*)(?:\.(\d+))?([diouxXeEfFgG])/g, (m, flags, width, prec, conv) => {
    if (m === '%%') return '%';
    return pyConvert(Number(x), flags || '', width ? Number(width) : 0, prec === undefined ? null : Number(prec), conv);
  });
}

const MINUS = '−';
const fixMinus = (s) => s.replace(/-/g, MINUS);

/* Python's round(x, 10) for the offset text. */
function pyRound(x, nd) {
  return npRound(x, nd);
}

/**
 * matplotlib's ScalarFormatter: labels for tick values, with the offset
 * and order of magnitude it moves to the end of the axis.
 *
 * @param {number[]} locs - every location the locator returned
 * @param {[number, number]} view - the axis limits
 * @param {{sci?: boolean}} [opts] - sci: useMathText with powerlimits (0, 0)
 * @returns {{labels: string[], offset: string}} labels as Plotly HTML
 */
export function scalarFormat(locs, view, opts = {}) {
  const sci = !!opts.sci;
  const powerlimits = sci ? [0, 0] : [-5, 6];
  if (!locs.length) return { labels: [], offset: '' };
  const [vmin, vmax] = view[0] <= view[1] ? view : [view[1], view[0]];
  const visible = locs.filter((v) => vmin <= v && v <= vmax);

  // _compute_offset
  let offset = 0;
  if (visible.length) {
    const lmin = Math.min(...visible); const lmax = Math.max(...visible);
    if (!(lmin === lmax || (lmin <= 0 && 0 <= lmax))) {
      const [absMin, absMax] = [Math.abs(lmin), Math.abs(lmax)].sort((a, b) => a - b);
      const sign = lmin < 0 ? -1 : 1;
      const ceilOom = Math.ceil(Math.log10(absMax));
      let oom = null;
      // Python's // on floats, not Math.floor of the quotient: 1 // 0.1 is 9.
      const fd = (a, o) => pyFloorDiv(a, 10 ** o);
      for (let o = ceilOom; o > ceilOom - 400; o--) {
        if (fd(absMin, o) !== fd(absMax, o)) { oom = o + 1; break; }
      }
      if (oom === null) oom = ceilOom;
      if ((absMax - absMin) / 10 ** oom <= 1e-2) {
        for (let o = ceilOom; o > ceilOom - 400; o--) {
          if (fd(absMax, o) - fd(absMin, o) > 1) { oom = o + 1; break; }
        }
      }
      const n = 4 - 1; // axes.formatter.offset_threshold
      offset = fd(absMax, oom) >= 10 ** n ? sign * fd(absMax, oom) * 10 ** oom : 0;
    }
  }

  // _set_order_of_magnitude
  let oomMag = 0;
  if (visible.length) {
    let oom;
    if (offset) {
      oom = Math.floor(Math.log10(vmax - vmin));
    } else {
      const val = Math.max(...visible.map(Math.abs));
      oom = val === 0 ? 0 : Math.floor(Math.log10(val));
    }
    if (oom <= powerlimits[0]) oomMag = oom;
    else if (oom >= powerlimits[1]) oomMag = oom;
    else oomMag = 0;
  }

  // _set_format
  let _locs = locs.length < 2 ? [...locs, vmin, vmax] : locs;
  let scaled = _locs.map((v) => (v - offset) / 10 ** oomMag);
  let range = Math.max(...scaled) - Math.min(...scaled);
  if (range === 0) range = Math.max(...scaled.map(Math.abs));
  if (range === 0) range = 1;
  if (locs.length < 2) scaled = scaled.slice(0, -2);
  const rangeOom = Math.floor(Math.log10(range));
  let sigfigs = Math.max(0, 3 - rangeOom);
  const thresh = 1e-3 * 10 ** rangeOom;
  while (sigfigs >= 0) {
    const err = Math.max(...scaled.map((v) => Math.abs(v - npRound(v, sigfigs))));
    if (err < thresh) sigfigs -= 1;
    else break;
  }
  sigfigs += 1;
  const fmt = `%1.${sigfigs}f`;

  const labels = locs.map((x) => {
    let xp = (x - offset) / 10 ** oomMag;
    if (Math.abs(xp) < 1e-8) xp = 0;
    return fixMinus(pyPercent(fmt, xp));
  });

  // get_offset
  let offsetText = '';
  if (visible.length && (oomMag || offset)) {
    let offsetStr = '';
    let sciStr = '';
    if (offset) {
      offsetStr = formatData(offset, sci);
      if (offset > 0) offsetStr = '+' + offsetStr;
    }
    if (oomMag) sciStr = sci ? formatData(10 ** oomMag, true) : `1e${oomMag}`;
    if (sci) {
      if (sciStr) sciStr = '×' + sciStr;
      offsetText = sciStr + offsetStr;
    } else {
      offsetText = sciStr + offsetStr;
    }
    offsetText = fixMinus(offsetText);
  }
  return { labels, offset: offsetText };
}

/* ScalarFormatter.format_data, used for the offset text. */
function formatData(value, mathText) {
  const e = Math.floor(Math.log10(Math.abs(value)));
  const s = pyRound(value / 10 ** e, 10);
  const exponent = String(e);
  const significand = s % 1 === 0 ? String(Math.trunc(s)) : pyPercent('%1.10g', s);
  if (e === 0) return significand;
  if (mathText) {
    const exp = `10<sup>${exponent}</sup>`;
    return s === 1 ? exp : `${significand}×${exp}`;
  }
  return `${significand}e${exponent}`;
}

/* matplotlib's _is_close_to_int: math.isclose(x, round(x)), a relative tolerance of 1e-9. */
const isCloseToInt = (x) => {
  const r = Math.round(x);
  return Math.abs(x - r) <= 1e-9 * Math.max(Math.abs(x), Math.abs(r));
};

/**
 * matplotlib's LogFormatterSciNotation labels for base 10.
 *
 * @param {number[]} locs
 * @param {[number, number]} view
 * @returns {string[]} Plotly HTML, '' for an unlabelled tick
 */
export function logFormat(locs, view) {
  const [a, b] = view[0] <= view[1] ? view : [view[1], view[0]];
  let sublabels;
  if (a <= 0) sublabels = new Set([1]);
  else {
    const numdec = Math.abs(Math.log10(b) - Math.log10(a));
    if (numdec > 1) sublabels = new Set([1]);
    else if (numdec > 0.4) sublabels = new Set([1, 2, 3, 4, 6, 10]);
    else sublabels = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  }
  return locs.map((x0) => {
    if (x0 === 0) return '0';
    const sign = x0 < 0 ? MINUS : '';
    const x = Math.abs(x0);
    let fx = Math.log(x) / Math.log(10);
    const isDecade = isCloseToInt(fx);
    const exponent = isDecade ? Math.round(fx) : Math.floor(fx);
    const coeff = Math.round(10 ** (fx - exponent));
    if (isDecade) fx = Math.round(fx);
    if (!sublabels.has(coeff)) return '';
    if (!isDecade) {
      let c = 10 ** (fx - Math.floor(fx));
      if (isCloseToInt(c)) c = Math.round(c);
      return `${sign}${fixMinus(pyPercent('%g', c))}×10<sup>${fixMinus(String(Math.floor(fx)))}</sup>`;
    }
    return `${sign}10<sup>${fixMinus(String(fx))}</sup>`;
  });
}

/* ------------------------------------------------------------------ *
 * Tick locators, from matplotlib.ticker
 * ------------------------------------------------------------------ */

const AUTO_STEPS = [1, 2, 2.5, 5, 10];
const MAXN_STEPS = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
const MAXTICKS = 1000;

/* mtransforms.nonsingular */
function nonsingular(vmin, vmax, expander = 0.001, tiny = 1e-15) {
  if (!Number.isFinite(vmin) || !Number.isFinite(vmax)) return [-expander, expander];
  let swapped = false;
  if (vmax < vmin) { [vmin, vmax] = [vmax, vmin]; swapped = true; }
  const maxabs = Math.max(Math.abs(vmin), Math.abs(vmax));
  if (maxabs < (1e6 / tiny) * 2.2250738585072014e-308) {
    vmin = -expander; vmax = expander;
  } else if (vmax - vmin <= maxabs * tiny) {
    if (vmax === 0 && vmin === 0) { vmin = -expander; vmax = expander; } else { vmin -= expander * Math.abs(vmin); vmax += expander * Math.abs(vmax); }
  }
  void swapped;
  return [vmin, vmax];
}

function scaleRange(vmin, vmax, n = 1, threshold = 100) {
  const dv = Math.abs(vmax - vmin);
  const meanv = (vmax + vmin) / 2;
  let offset = 0;
  if (!(Math.abs(meanv) / dv < threshold)) offset = Math.sign(meanv) * 10 ** Math.floor(Math.log10(Math.abs(meanv)));
  const scale = 10 ** Math.floor(Math.log10(dv / n));
  return [scale, offset];
}

function edgeInteger(step, offset) {
  const off = Math.abs(offset);
  const closeto = (ms, edge) => {
    let tol;
    if (off > 0) {
      const digits = Math.log10(off / step);
      tol = Math.min(0.4999, Math.max(1e-10, 10 ** (digits - 12)));
    } else tol = 1e-10;
    return Math.abs(ms - edge) < tol;
  };
  return {
    step,
    le(x) { const [d, m] = pyDivmod(x, step); return closeto(m / step, 1) ? d + 1 : d; },
    ge(x) { const [d, m] = pyDivmod(x, step); return closeto(m / step, 0) ? d : d + 1; }
  };
}

/** MaxNLocator.tick_values (AutoLocator is MaxNLocator with AUTO_STEPS). */
export function maxNLocator(vmin, vmax, nbins, steps = MAXN_STEPS, minN = 2) {
  [vmin, vmax] = nonsingular(vmin, vmax, 1e-13, 1e-14);
  const [scale, offset] = scaleRange(vmin, vmax, nbins);
  const _vmin = vmin - offset;
  const _vmax = vmax - offset;
  const ext = [...steps.slice(0, -1).map((s) => 0.1 * s), ...steps, 10 * steps[1]].map((s) => s * scale);
  const raw = (_vmax - _vmin) / nbins;
  let istep = ext.findIndex((s) => s >= raw);
  if (istep < 0) istep = ext.length - 1;
  let ticks = [];
  for (let k = istep; k >= 0; k--) {
    const step = ext[k];
    const bestVmin = pyFloorDiv(_vmin, step) * step;
    const edge = edgeInteger(step, offset);
    const low = edge.le(_vmin - bestVmin);
    const high = edge.ge(_vmax - bestVmin);
    ticks = [];
    for (let n = low; n <= high && ticks.length <= MAXTICKS; n++) ticks.push(n * step + bestVmin);
    const shown = ticks.filter((t) => t <= _vmax && t >= _vmin).length;
    if (shown >= minN) break;
  }
  return ticks.map((t) => t + offset);
}

/** MultipleLocator.tick_values */
export function multipleLocator(vmin, vmax, base) {
  if (vmax < vmin) [vmin, vmax] = [vmax, vmin];
  const edge = edgeInteger(base, 0);
  const start = edge.ge(vmin) * base;
  const n = pyFloorDiv(vmax - start + 0.001 * base, base);
  const out = [];
  if (!(n + 3 <= MAXTICKS * 50)) return { locs: [], tooMany: n + 3 };
  for (let k = 0; k < n + 3; k++) out.push(start - base + k * base);
  return { locs: out, tooMany: out.length > MAXTICKS ? out.length : 0 };
}

/** LogLocator.tick_values, matplotlib 3.6. subs: [1] (major), 'auto' (minor). */
export function logLocator(vmin, vmax, { base = 10, subs = [1], numticks = 9 } = {}) {
  if (vmax < vmin) [vmin, vmax] = [vmax, vmin];
  if (!(vmin > 0)) return [];
  const lb = Math.log(base);
  const logVmin = Math.log(vmin) / lb;
  const logVmax = Math.log(vmax) / lb;
  const numdec = Math.floor(logVmax) - Math.ceil(logVmin);
  let sub = subs;
  if (typeof subs === 'string') {
    if (numdec > 10 || base < 3) {
      if (subs === 'auto') return [];
      sub = [1];
    } else {
      sub = [];
      for (let v = subs === 'auto' ? 2 : 1; v < base; v++) sub.push(v);
    }
  }
  let stride = Math.floor((numdec + 1) / numticks) + 1;
  if (stride >= numdec) stride = Math.max(1, numdec - 1);
  const haveSubs = sub.length > 1 || (sub.length === 1 && sub[0] !== 1);
  const decades = [];
  for (let d = Math.floor(logVmin) - stride; d < Math.ceil(logVmax) + 2 * stride; d += stride) decades.push(d);
  let locs;
  if (haveSubs) {
    locs = stride === 1 ? decades.flatMap((d) => sub.map((s) => s * base ** d)) : [];
  } else {
    locs = decades.map((d) => base ** d);
  }
  if (sub.length > 1 && stride === 1 && locs.filter((t) => vmin <= t && t <= vmax).length <= 1) {
    return maxNLocator(vmin, vmax, 9, AUTO_STEPS);
  }
  return locs;
}

/** AutoMinorLocator for a linear axis. */
export function autoMinorLocator(majorLocs, view) {
  if (majorLocs.length < 2) return [];
  const majorstep = majorLocs[1] - majorLocs[0];
  if (!(majorstep > 0) && !(majorstep < 0)) return [];
  const m = 10 ** (((Math.log10(Math.abs(majorstep)) % 1) + 1) % 1);
  const ndivs = [1, 2.5, 5, 10].some((v) => Math.abs(m - v) <= 1e-8 + 1e-5 * v) ? 5 : 4;
  const minorstep = majorstep / ndivs;
  let [vmin, vmax] = view;
  if (vmin > vmax) [vmin, vmax] = [vmax, vmin];
  const t0 = majorLocs[0];
  const tmin = (pyFloorDiv(vmin - t0, minorstep) + 1) * minorstep;
  const tmax = (pyFloorDiv(vmax - t0, minorstep) + 1) * minorstep;
  const out = [];
  const n = Math.ceil((tmax - tmin) / minorstep);
  if (n > MAXTICKS * 5) return [];
  // np.arange fills start + k*delta with delta = (start + step) - start.
  const delta = (tmin + minorstep) - tmin;
  for (let k = 0; k < n; k++) out.push(tmin + k * delta + t0);
  return out;
}

/* Axis._update_ticks keeps ticks inside the view, with a relative tolerance
   in display space. */
function inView(v, view, log) {
  const f = log ? Math.log10 : (x) => x;
  if (log && !(v > 0)) return false;
  let a = f(view[0]); let b = f(view[1]);
  if (a > b) [a, b] = [b, a];
  const tol = (b - a) * 1e-10;
  const t = f(v);
  return a - tol <= t && t <= b + tol;
}

/* Axis.get_minorticklocs drops a minor tick within 1e-5 of the view (in
   scale units) of any major location. */
function dropOverlaps(minor, major, view, log) {
  const f = log ? (v) => (v > 0 ? Math.log10(v) : -1000) : (v) => v;
  const tol = Math.abs(f(view[1]) - f(view[0])) * 1e-5;
  const fm = major.map(f);
  return minor.filter((m) => { const t = f(m); return !fm.some((M) => Math.abs(M - t) <= tol); });
}

/**
 * The ticks of one axis, as the script's locators and formatters give them.
 *
 * Minor ticks exist on a log axis always (matplotlib's default minor
 * locator) and on a linear axis when `minorLocated`; whether they get marks
 * is the caller's business. On a short log axis matplotlib labels some minor
 * ticks, unless the script chose the major ticks or their format, in which
 * case it sets a NullFormatter for them; `minor[i].text` carries those labels.
 *
 * @param {object} a
 * @param {[number, number]} a.view   - the axis limits (data units)
 * @param {boolean} a.log
 * @param {object} a.ticks            - the style's xTicks / yTicks
 * @param {number} a.tickSpace        - Axis.get_tick_space(): the number of ticks that fit
 * @param {boolean} a.minorLocated    - the script sets a minor locator (minor ticks or minor grid)
 * @param {boolean} [a.plain]         - ignore the tick settings (the residual panel's y axis)
 * @returns {{major: {v: number, text: string, math: boolean}[], minor: {v: number, text: string, math: boolean}[],
 *   offset: string, offsetMath: boolean, notes: string[], tex: string[], formatted: boolean}}
 *   ticks inside the view only; labels as Plotly HTML, `math` where matplotlib sets
 *   them with mathtext; `tex` lists TeX commands the labels use that are not known here
 */
export function axisTicks({ view, log, ticks: T, tickSpace, minorLocated, plain = false }) {
  const notes = [];
  const tex = [];
  const n = Math.min(9, Math.max(1, tickSpace));
  const nLog = Math.min(9, Math.max(2, tickSpace));
  const [lo, hi] = view[0] <= view[1] ? view : [view[1], view[0]];
  let locs;
  let customLocator = false;
  const mode = plain ? 'auto' : T.mode;
  if (mode === 'step' && T.step) {
    customLocator = true;
    if (log) locs = logLocator(lo, hi, { base: T.step === 1 ? 10 : 10 ** T.step, numticks: 1000 });
    else {
      const r = multipleLocator(lo, hi, T.step);
      locs = r.locs;
      if (r.tooMany) {
        // matplotlib only warns, then draws them all; a browser cannot label
        // that many, so the preview falls back to the automatic ticks.
        notes.push(`A step of ${T.step} puts about ${r.tooMany} ticks on the axis. matplotlib draws them all (after a warning); the preview shows the automatic ticks instead.`);
        locs = maxNLocator(lo, hi, n, AUTO_STEPS);
      }
    }
  } else if (mode === 'count' && T.count) {
    customLocator = true;
    locs = log ? logLocator(lo, hi, { numticks: T.count }) : maxNLocator(lo, hi, T.count, MAXN_STEPS);
  } else if (mode === 'list' && T.values.length) {
    customLocator = true;
    locs = T.values.slice();
  } else {
    locs = log ? logLocator(lo, hi, { numticks: nLog }) : maxNLocator(lo, hi, n, AUTO_STEPS);
  }

  // Formatter
  const fmt = plain ? '' : T.format;
  const labelled = !plain && mode === 'list' && T.values.length && T.labels.some((t) => t !== '');
  let labels;
  let offset = '';
  let customFormatter = false;
  // Which labels matplotlib sets with mathtext: the log formatters', the
  // scientific ScalarFormatter's (useMathText) and any typed with $…$.
  let math = () => false;
  let offsetMath = false;
  if (labelled) {
    labels = T.values.map((v, i) => (i < T.labels.length ? textToHtml(T.labels[i], tex) : escapeHtml(String(Number(Number(v).toPrecision(12))))));
    math = (i) => i < T.labels.length && isMathText(T.labels[i]);
    customFormatter = true;
  } else if (fmt === 'sci') {
    customFormatter = true;
    math = () => true;
    if (log) labels = logFormat(locs, [lo, hi]);
    else { ({ labels, offset } = scalarFormat(locs, [lo, hi], { sci: true })); offsetMath = true; }
  } else if (fmt && printfFormat(fmt)) {
    customFormatter = true;
    labels = locs.map((v) => escapeHtml(pyPercent(fmt, v)));
  } else {
    if (fmt) notes.push(`The tick format "${fmt}" is not a printf format such as %.2f, so matplotlib chooses the labels.`);
    if (log) { labels = logFormat(locs, [lo, hi]); math = () => true; }
    else ({ labels, offset } = scalarFormat(locs, [lo, hi]));
  }

  const major = [];
  locs.forEach((v, i) => { if (inView(v, [lo, hi], log)) major.push({ v, text: labels[i] ?? '', math: math(i) }); });

  let minorLocs = [];
  if (log) minorLocs = logLocator(lo, hi, { subs: 'auto', numticks: nLog });
  else if (minorLocated) minorLocs = autoMinorLocator(locs, [lo, hi]);
  minorLocs = dropOverlaps(minorLocs, locs, [lo, hi], log);
  const minorLabels = log && !(customLocator || customFormatter) ? logFormat(minorLocs, [lo, hi]) : null;
  const minor = [];
  minorLocs.forEach((v, i) => { if (inView(v, [lo, hi], log)) minor.push({ v, text: minorLabels ? minorLabels[i] : '', math: !!minorLabels }); });
  return { major, minor, offset, offsetMath, notes, tex, formatted: customFormatter };
}

/* ------------------------------------------------------------------ *
 * Autoscaling, as Axes.autoscale_view does it
 * ------------------------------------------------------------------ */

/* The data limits of a set of arrays: [min, max] of the finite values
   (positive values only on a log axis), or null. */
function dataLimits(arrays, log) {
  let lo = Infinity; let hi = -Infinity;
  for (const arr of arrays) {
    if (!arr) continue;
    for (const raw of arr) {
      const v = Number(raw);
      if (!Number.isFinite(v) || (log && !(v > 0))) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  return lo <= hi ? [lo, hi] : null;
}

/* The autoscaled interval: nonsingular, then 5% margins (in log units on a log axis). */
function autoscale(lim, log) {
  if (!lim) return log ? [1, 10] : [0, 1];
  let [a, b] = lim;
  if (log) {
    if (a === b) {
      a = 10 ** Math.ceil(Math.log10(a) - 1);
      b = 10 ** Math.floor(Math.log10(b) + 1);
      if (a >= lim[0]) a /= 10;
      if (b <= lim[1]) b *= 10;
    }
    const la = Math.log10(a); const lb = Math.log10(b);
    const d = (lb - la) * RC.margin;
    return [10 ** (la - d), 10 ** (lb + d)];
  }
  [a, b] = nonsingular(a, b, 0.05);
  const d = (b - a) * RC.margin;
  return [a - d, b + d];
}

/* The view: the autoscaled interval with the user's limits put in. */
function viewLimits(lim, userLim, log) {
  const auto = autoscale(lim, log);
  const use = (v) => v !== null && v !== undefined && Number.isFinite(v) && !(log && v <= 0);
  let a = use(userLim[0]) ? userLim[0] : auto[0];
  let b = use(userLim[1]) ? userLim[1] : auto[1];
  if (a === b) {
    if (log) { a /= 10; b *= 10; } else [a, b] = nonsingular(a, b, 0.05);
  }
  return [a, b];
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

/* ------------------------------------------------------------------ *
 * The scene: what is drawn and where, in figure pixels (y down)
 * ------------------------------------------------------------------ */

const DIR_OUT = { out: 1, inout: 0.5, in: 0 };
const DIR_IN = { out: 0, inout: 0.5, in: 1 };
const TICK_PAD = { major: 3.5, minor: 3.4 };   // xtick.major.pad, xtick.minor.pad (points)
/* Legend.codes 1 to 10, the order in which "best" tries them. */
const LEGEND_TRIALS = ['upper right', 'upper left', 'lower left', 'lower right', 'right',
  'center left', 'center right', 'lower center', 'upper center', 'center'];

const toNum = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));
const numbers = (a) => Array.from(a || [], toNum);
/* A value in scale units. matplotlib's LogTransform puts values that are not
   positive 1000 decades down, off any axis. */
const tscale = (log, v) => (log ? (v > 0 ? Math.log10(v) : -1000) : v);

/* The tick marks of one axis as the script sets them (points), with the pad
   between mark and label, for the major and the minor ticks. */
function tickMarks(T) {
  const major = { dir: T.direction, len: T.length, width: T.width };
  const minor = T.minor
    ? { dir: T.direction, len: round(T.length * 4 / 7), width: round(T.width * 0.75) }
    : { dir: 'out', len: 0, width: 0.6 };   // the script sets their length to 0
  major.pad = TICK_PAD.major + major.len * DIR_OUT[major.dir];
  minor.pad = TICK_PAD.minor + minor.len * DIR_OUT[minor.dir];
  return { major, minor };
}

function union(boxes) {
  let l = Infinity; let t = Infinity; let r = -Infinity; let b = -Infinity;
  for (const x of boxes) {
    if (!x) continue;
    l = Math.min(l, x.l); t = Math.min(t, x.t); r = Math.max(r, x.r); b = Math.max(b, x.b);
  }
  return { l, t, r, b };
}
const overlaps = (a, b) => Math.max(a.l, b.l) <= Math.min(a.r, b.r) && Math.max(a.t, b.t) <= Math.min(a.b, b.b);
/* Axes.get_tightbbox leaves out extra artists with an empty box. */
const solid = (x) => x.r - x.l > 0 && x.b - x.t > 0;

/*
 * mathtext's box, for text with $…$ (matplotlib then sets the whole string
 * with mathtext): the ink, one device pixel of padding and a pixel of
 * rounding each side (so 2 px at the renderer's dpi, which is the PNG's dpi,
 * or 72 for PDF and SVG), and never less than plain text's "lp" box.
 */
function mathTextBox(m, pad) {
  if (!pad) return m;
  return { ...m, ascent: Math.max(m.lp[0], m.ink[0] + pad), descent: Math.max(m.lp[1], m.ink[1] + pad) };
}

/*
 * A piece of text placed as matplotlib places it: `y` is the baseline (for
 * rotated text, `x` is the baseline and `y` the middle of the text). The box
 * is matplotlib's: advance width by the "lp"-based ascent and descent.
 */
function placeText(html, size, family, { x, y, ha = 'left', rot = 0 }, mathPad = 0) {
  const m = mathTextBox(textBox(html, size, family), mathPad);
  const f = ha === 'center' ? 0.5 : ha === 'right' ? 1 : 0;
  const box = rot
    ? { l: x - m.ascent, r: x + m.descent, t: y - m.width / 2, b: y + m.width / 2 }
    : { l: x - f * m.width, r: x - f * m.width + m.width, t: y - m.ascent, b: y + m.descent };
  return { html, size, x, y, ha, rot, m, box, lbox: box };
}

/*
 * One axes dressed for a trial position `box`: its ticks for that size, and
 * the tick labels, offset texts, axis labels and title where matplotlib puts
 * them, with the spines' boxes (tick marks included) that constrained layout
 * and the tight bounding box count.
 */
function dressAxes(P, ax, box) {
  const { s, family } = P;
  const aw = box.r - box.l;
  const ah = box.b - box.t;
  const xv = P.xView;
  const yv = ax.residual ? P.rView : P.yView;
  const ylog = ax.residual ? false : P.yLog;
  const x0 = tscale(P.xLog, xv[0]); const xs = aw / (tscale(P.xLog, xv[1]) - x0);
  const y0 = tscale(ylog, yv[0]); const ys = ah / (tscale(ylog, yv[1]) - y0);
  const X = (v) => box.l + (tscale(P.xLog, v) - x0) * xs;
  const Y = (v) => box.b - (tscale(ylog, v) - y0) * ys;
  const tickPt = Math.max(1, s.fontSize - 1);
  // Axis.get_tick_space: the axis length over 3 (x) or 2 (y) label heights.
  const xt = axisTicks({ view: xv, log: P.xLog, ticks: s.xTicks, tickSpace: Math.floor(aw / PX_PER_PT / (3 * tickPt)), minorLocated: P.xMinor });
  const yt = axisTicks({ view: yv, log: ylog, ticks: s.yTicks, tickSpace: Math.floor(ah / PX_PER_PT / (2 * tickPt)), minorLocated: P.yMinor, plain: ax.residual });
  const mx = P.xMarks; const my = P.yMarks;
  const items = [];

  // How far the drawn tick marks reach out of and into the axes.
  const reach = (t, m, dir) => Math.max(
    t.major.length ? px(m.major.len) * dir[m.major.dir] : 0,
    t.minor.length ? px(m.minor.len) * dir[m.minor.dir] : 0);
  const outX = reach(xt, mx, DIR_OUT); const inX = reach(xt, mx, DIR_IN);
  const outY = reach(yt, my, DIR_OUT); const inY = reach(yt, my, DIR_IN);

  const pad = (math) => (math ? P.mathPad : 0);
  const measure = (html, size, math) => mathTextBox(textBox(html, size, family), pad(math));
  const xLabels = [];
  if (ax.bottom) {
    const each = [...xt.major.map((t) => [t, mx.major]), ...xt.minor.map((t) => [t, mx.minor])];
    for (const [t, mk] of each) {
      if (!t.text) continue;
      const m = measure(t.text, P.tickPx, t.math);
      if (!(m.width > 0)) continue;
      const it = placeText(t.text, P.tickPx, family, { x: X(t.v), y: box.b + px(mk.pad) + m.ascent, ha: 'center' }, pad(t.math));
      items.push(it); xLabels.push(it);
    }
  }
  const yLabels = [];
  for (const [t, mk] of [...yt.major.map((t) => [t, my.major]), ...yt.minor.map((t) => [t, my.minor])]) {
    if (!t.text) continue;
    const m = measure(t.text, P.tickPx, t.math);
    if (!(m.width > 0)) continue;
    // va='center_baseline': halfway between baseline and ascent at the tick.
    const it = placeText(t.text, P.tickPx, family, { x: box.l - px(mk.pad), y: Y(t.v) + m.ascent / 2, ha: 'right' }, pad(t.math));
    items.push(it); yLabels.push(it);
  }

  const spines = [
    { l: box.l, r: box.r, t: box.b - inX, b: box.b + outX },
    { l: box.l - outY, r: box.l + inY, t: box.t, b: box.b }
  ];
  if (s.spines.top) spines.push(s.xTicks.mirror ? { l: box.l, r: box.r, t: box.t - outX, b: box.t + outX } : { l: box.l, r: box.r, t: box.t, b: box.t });
  if (s.spines.right) spines.push(s.yTicks.mirror ? { l: box.r - inY, r: box.r + outY, t: box.t, b: box.b } : { l: box.r, r: box.r, t: box.t, b: box.b });

  if (ax.bottom && xt.offset) {
    const m = measure(xt.offset, P.tickPx, xt.offsetMath);
    const top = (xLabels.length ? Math.max(...xLabels.map((i) => i.box.b)) : box.b) + px(RC.offsetPad);
    items.push(placeText(xt.offset, P.tickPx, family, { x: box.r, y: top + m.ascent, ha: 'right' }, pad(xt.offsetMath)));
  }
  let yOffset = null;
  if (yt.offset) {
    yOffset = placeText(yt.offset, P.tickPx, family, { x: box.l, y: box.t - px(RC.offsetPad), ha: 'left' }, pad(yt.offsetMath));
    items.push(yOffset);
  }
  // Axis labels: clear of the tick labels and of the tick marks, by labelpad.
  // Constrained layout counts only their depth, not their length.
  if (ax.bottom && P.xLabel) {
    const m = measure(P.xLabel, P.labelPx, P.math.xLabel);
    const top = Math.max(box.b + outX, ...xLabels.map((i) => i.box.b)) + px(RC.labelpad);
    const it = placeText(P.xLabel, P.labelPx, family, { x: (box.l + box.r) / 2, y: top + m.ascent, ha: 'center' }, pad(P.math.xLabel));
    it.lbox = { ...it.box, l: it.x - 0.5, r: it.x + 0.5 };
    items.push(it);
  }
  const yLabel = ax.residual ? P.residualLabel : P.yLabel;
  const yMath = !ax.residual && P.math.yLabel;
  if (yLabel) {
    const m = measure(yLabel, P.labelPx, yMath);
    const right = Math.min(box.l - outY, ...yLabels.map((i) => i.box.l)) - px(RC.labelpad);
    const it = placeText(yLabel, P.labelPx, family, { x: right - m.descent, y: (box.t + box.b) / 2, ha: 'center', rot: 90 }, pad(yMath));
    it.lbox = { ...it.box, t: it.y - 0.5, b: it.y + 0.5 };
    items.push(it);
  }
  if (!ax.residual && P.title) {
    let it = placeText(P.title, P.titlePx, family, { x: (box.l + box.r) / 2, y: box.t - px(RC.titlepad), ha: 'center' }, pad(P.math.title));
    // The title moves up when it would run into the y offset text.
    if (yOffset && overlaps(yOffset.box, it.box)) {
      it = placeText(P.title, P.titlePx, family, { x: it.x, y: yOffset.box.t - px(RC.titlepad), ha: 'center' }, pad(P.math.title));
    }
    it.lbox = { ...it.box, l: it.x - 0.5, r: it.x + 0.5 };
    items.push(it);
  }
  return { ax, box, X, Y, xt, yt, items, spines };
}

/* The initial axes positions of plt.subplots (figure.subplot.* rcParams),
   where constrained layout starts from. */
function initialBoxes(P) {
  const { W, H } = P;
  const l = 0.125 * W; const r = 0.9 * W; const top = 0.12 * H; const bottom = 0.89 * H;
  if (P.axes.length === 1) return [{ l, r, t: top, b: bottom }];
  const ratio = P.axes[1].ratio;
  const cell = (bottom - top) / (2 + 0.2);
  const norm = (cell * 2) / (1 + ratio);
  const h0 = norm; const h1 = norm * ratio;
  return [{ l, r, t: top, b: top + h0 }, { l, r, t: top + h0 + 0.2 * cell, b: top + h0 + 0.2 * cell + h1 }];
}

/* The legend box beside the axes for "outside right": its upper left corner
   at (1.02, 1) in axes coordinates. */
function outsideLegend(P, box) {
  if (!P.legend || P.s.legend.position !== 'outside right') return null;
  const l = box.r + 0.02 * (box.r - box.l);
  return { l, t: box.t, r: l + P.legend.width, b: box.t + P.legend.height };
}

/*
 * One pass of constrained layout: the margin each side of each axes needs
 * for its decorations, plus w_pad/h_pad (3 pt), then the axes that fill what
 * is left, the residual panel at its height ratio. Returns null when the
 * axes would collapse, as matplotlib then leaves them where they were.
 */
function solveLayout(P, dressed) {
  const { W, H } = P;
  const pad = px(RC.layoutPad);
  // Between the panels: hspace (2% of the figure) shared by the two rows,
  // when that is more than h_pad.
  const between = Math.max(pad, (0.02 / 2 / dressed.length) * H);
  let L = 0; let R = 0;
  const rows = dressed.map((d, i) => {
    const extra = [];
    if (i === 0) extra.push(outsideLegend(P, d.box));
    const e = union([d.box, ...d.items.map((it) => it.lbox), ...d.spines.filter(solid), ...extra]);
    L = Math.max(L, d.box.l - e.l);
    R = Math.max(R, e.r - d.box.r);
    return {
      top: d.box.t - e.t + (i === 0 ? pad : between),
      bottom: e.b - d.box.b + (i === dressed.length - 1 ? pad : between)
    };
  });
  L += pad; R += pad;
  const avail = H - rows.reduce((a, r) => a + r.top + r.bottom, 0);
  const ratios = P.axes.map((a) => a.ratio);
  if (!(avail > 0) || !(W - L - R > 0)) return null;
  const unit = avail / ratios.reduce((a, b) => a + b, 0);
  let y = 0;
  return rows.map((r, i) => {
    y += r.top;
    const t = y;
    y += unit * ratios[i];
    const b = y;
    y += r.bottom;
    return { l: L, r: W - R, t, b };
  });
}

/* ------------------------------------------------------------------ *
 * Legend
 * ------------------------------------------------------------------ */

/* The legend's entries and its size: Legend._init_legend_box with the rc
   defaults (borderpad 0.4, labelspacing 0.5, handlelength 2, handleheight
   0.7, handletextpad 0.8, all in font sizes). */
function legendBox(P, entries) {
  if (!entries.length) return null;
  const fs = P.legendPx;
  const k = RC.legend;
  const rows = entries.map((e) => {
    const m = mathTextBox(textBox(e.html, fs, P.family), e.math ? P.mathPad : 0);
    // HPacker(align='baseline') of the handle box (0.7 fs tall, standing on
    // the baseline) and the text.
    return { ...e, m, up: Math.max(k.handleheight * fs, m.ascent), down: Math.max(0, m.descent) };
  });
  const width = 2 * k.borderpad * fs + k.handlelength * fs + k.handletextpad * fs + Math.max(...rows.map((r) => r.m.width));
  const height = 2 * k.borderpad * fs + rows.reduce((a, r) => a + r.up + r.down, 0) + (rows.length - 1) * k.labelspacing * fs;
  return { rows, width, height };
}

/* The legend's box for a location inside the axes (Legend._get_anchored_bbox). */
function anchoredLegend(loc, lg, box, fs) {
  const inset = RC.legend.borderaxespad * fs;
  const c = { l: box.l + inset, r: box.r - inset, t: box.t + inset, b: box.b - inset };
  const cx = (c.l + c.r) / 2; const cy = (c.t + c.b) / 2;
  const h = { 'upper right': 'r', 'upper left': 'l', 'lower left': 'l', 'lower right': 'r', right: 'r', 'center left': 'l', 'center right': 'r', 'lower center': 'c', 'upper center': 'c', center: 'c' }[loc];
  const v = { 'upper right': 't', 'upper left': 't', 'lower left': 'b', 'lower right': 'b', right: 'c', 'center left': 'c', 'center right': 'c', 'lower center': 'b', 'upper center': 't', center: 'c' }[loc];
  const l = h === 'l' ? c.l : h === 'r' ? c.r - lg.width : cx - lg.width / 2;
  const t = v === 't' ? c.t : v === 'b' ? c.b - lg.height : cy - lg.height / 2;
  return { l, t, r: l + lg.width, b: t + lg.height };
}

/* Path.intersects_bbox(filled=False): does any segment of the polyline cross
   or lie in the box. The separating-axis test of matplotlib's _path.h; NaN
   points are skipped, which joins the pieces either side, as there. */
function pathHitsBox(xs, ys, box) {
  const cx = (box.l + box.r) / 2; const cy = (box.t + box.b) / 2;
  const w = box.r - box.l; const h = box.b - box.t;
  let x1 = NaN; let y1 = NaN;
  for (let i = 0; i < xs.length; i++) {
    const x2 = xs[i]; const y2 = ys[i];
    if (!Number.isFinite(x2) || !Number.isFinite(y2)) continue;
    if (!Number.isFinite(x1)) {
      if (2 * Math.abs(x2 - cx) <= w && 2 * Math.abs(y2 - cy) <= h) return true;
    } else if (Math.abs(x1 + x2 - 2 * cx) < w + Math.abs(x1 - x2)
      && Math.abs(y1 + y2 - 2 * cy) < h + Math.abs(y1 - y2)
      && 2 * Math.abs((x1 - cx) * (y1 - y2) - (y1 - cy) * (x1 - x2)) < w * Math.abs(y1 - y2) + h * Math.abs(x1 - x2)) {
      return true;
    }
    x1 = x2; y1 = y2;
  }
  return false;
}

/* Legend._find_best_position: of the ten locations, the first with the
   fewest line vertices inside plus lines crossing it. */
function bestLegend(lg, box, fs, lines) {
  let best = null;
  for (const loc of LEGEND_TRIALS) {
    const b = anchoredLegend(loc, lg, box, fs);
    let badness = 0;
    for (const { xs, ys } of lines) {
      for (let i = 0; i < xs.length; i++) {
        if (b.l < xs[i] && xs[i] < b.r && b.t < ys[i] && ys[i] < b.b) badness++;
      }
      if (pathHitsBox(xs, ys, b)) badness++;
    }
    if (badness === 0) return { loc, box: b };
    if (!best || badness < best.badness) best = { loc, box: b, badness };
  }
  return best;
}

/* ------------------------------------------------------------------ *
 * The figure for Plotly
 * ------------------------------------------------------------------ */

/* Plotly's marker outlines (its symbol definitions), so that the legend's
   markers, drawn as shapes, have the plot's form. r is half the Plotly size. */
function markerOutline(symbol, cx, cy, r) {
  const rt = (r * 2) / Math.sqrt(3); const r2 = r / 2;
  switch (symbol) {
    case 'square': return [{ pts: [[cx + r, cy + r], [cx - r, cy + r], [cx - r, cy - r], [cx + r, cy - r]], closed: true }];
    case 'triangle-up': return [{ pts: [[cx - rt, cy + r2], [cx + rt, cy + r2], [cx, cy - r]], closed: true }];
    case 'triangle-down': return [{ pts: [[cx - rt, cy - r2], [cx + rt, cy - r2], [cx, cy + r]], closed: true }];
    case 'diamond': { const d = r * 1.3; return [{ pts: [[cx + d, cy], [cx, cy + d], [cx - d, cy], [cx, cy - d]], closed: true }]; }
    case 'x-thin': return [{ pts: [[cx + r, cy + r], [cx - r, cy - r]] }, { pts: [[cx + r, cy - r], [cx - r, cy + r]] }];
    case 'cross-thin': { const c = r * 1.4; return [{ pts: [[cx, cy + c], [cx, cy - c]] }, { pts: [[cx + c, cy], [cx - c, cy]] }]; }
    default: return null;   // circle: a circle shape
  }
}

/* A spine outline for the sides drawn, left and bottom always. Open ends
   reach half the line width further, as matplotlib's projecting caps do. */
function spinePath(box, top, right, half) {
  const TL = [box.l, box.t]; const BL = [box.l, box.b]; const BR = [box.r, box.b]; const TR = [box.r, box.t];
  if (top && right) return { pts: [TL, BL, BR, TR], closed: true };
  const pts = top ? [TR, TL, BL, BR] : right ? [TL, BL, BR, TR] : [TL, BL, BR];
  const extend = (p, q) => {   // p moved away from q by half
    const dx = p[0] - q[0]; const dy = p[1] - q[1]; const d = Math.hypot(dx, dy) || 1;
    return [p[0] + (dx / d) * half, p[1] + (dy / d) * half];
  };
  pts[0] = extend(pts[0], pts[1]);
  pts[pts.length - 1] = extend(pts[pts.length - 1], pts[pts.length - 2]);
  return { pts };
}

/* The ways the preview's TeX differs from mathtext, for the notes. */
function texNotes(texts, unknown) {
  const notes = [];
  const maths = texts.flatMap((t) => mathSegments(t).filter((p) => p.math).map((p) => p.text)).join(' ');
  if (/\\[dt]?frac\b/.test(maths)) notes.push('Fractions are shown on one line (a/b); matplotlib stacks them.');
  if (/\\sqrt\b/.test(maths)) notes.push('Roots are shown as √x without the bar matplotlib draws over x.');
  if (/\\(?:hat|bar|tilde|vec|dot|ddot|overline|widehat|widetilde|underline)\b/.test(maths)) notes.push('Accents such as \\hat and \\bar are not shown; matplotlib draws them.');
  if (unknown.length) {
    const list = [...new Set(unknown)].map((c) => `\\${c}`).join(', ');
    notes.push(`The preview shows ${list} as typed. matplotlib's mathtext draws it if it knows the command, and stops with an error if not.`);
  }
  return notes;
}

/**
 * The figure as Plotly data and layout, laid out as matplotlib lays out the
 * script's figure. Needs no DOM (text is then measured from font averages).
 *
 * @param {object} model
 * @param {number[]} model.x, model.y          - the data (single independent variable)
 * @param {number[]} [model.sigma]             - standard uncertainty of each y
 * @param {{x: number[], y: number[]}} [model.curve]  - the fitted curve, at fitCurveGrid(x, style)
 * @param {{x: number[], lower: number[], upper: number[]}} [model.band]  - the confidence band
 * @param {{x?: number[], r: number[]}} [model.residuals]  - observed minus fitted; x defaults to
 *   the data's x (or, multivariate, the predictions)
 * @param {{observed: number[], predicted: number[]}} [model.multivariate]  - several
 *   independent variables: observed against predicted replaces x, y and the curve
 * @param {object} style - a plot style (normalised here)
 * @param {object} [options]
 * @param {boolean} [options.tight]        - crop to the drawing as bbox_inches='tight' does
 *   (default: style.export.tight)
 * @param {boolean} [options.transparent]  - no figure background (for export)
 * @returns {{data: object[], layout: object, info: {widthIn: number, heightIn: number,
 *   widthPx: number, heightPx: number, figureWidthIn: number, figureHeightIn: number,
 *   tight: boolean, legend: string|null, axes: {l: number, t: number, r: number, b: number}[],
 *   notes: string[]}}} `legend` is the location used (what "best" chose); `axes` are
 *   the panels' boxes on the page in px
 */
export function buildFitFigure(model, style, options = {}) {
  const s = normalisePlotStyle(style);
  const m = model || {};
  const family = s.fontFamily;
  const notes = [];
  const unknownTex = [];
  const html = (t) => textToHtml(t, unknownTex);
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
  const lower = errorBars ? dy.map((v, i) => v - sig[i]) : null;
  const upper = errorBars ? dy.map((v, i) => v + sig[i]) : null;
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
    const both = [...dx, ...dy].filter((v) => Number.isFinite(v) && (!(xLog || yLog) || v > 0));
    if (both.length) {
      const lo = s.xLim[0] !== null && !(xLog && s.xLim[0] <= 0) ? s.xLim[0] : Math.min(...both);
      const hi = s.xLim[1] !== null ? s.xLim[1] : Math.max(...both);
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

  /* Limits: autoscaled over everything drawn, the x axis shared by both panels */
  const xArrays = []; const yArrays = []; const rxArrays = []; const ryArrays = [[0]];
  if (band) { xArrays.push(band.x); yArrays.push(band.lower, band.upper); }
  if (showCurve) { xArrays.push(curve.x); yArrays.push(curve.y); }
  if (diag) { xArrays.push(diag); yArrays.push(diag); }
  if (showData) { xArrays.push(dx); yArrays.push(dy); if (errorBars) yArrays.push(lower, upper); }
  if (res && pointsDrawn) {
    rxArrays.push(res.x); ryArrays.push(res.r);
    if (errorBars) ryArrays.push(res.r.map((v, i) => v - sig[i]), res.r.map((v, i) => v + sig[i]));
  }
  const xView = viewLimits(dataLimits([...xArrays, ...rxArrays], xLog), s.xLim, xLog);
  const yView = viewLimits(dataLimits(yArrays, yLog), s.yLim, yLog);
  const rView = viewLimits(dataLimits(ryArrays, false), [null, null], false);

  /* Legend entries: data, fit, band */
  const pct = String(Number((s.band.level * 100).toPrecision(4)));
  const entries = [];
  const entry = (kind, text) => entries.push({ kind, html: html(text), math: isMathText(text) });
  if (showData && s.data.label) entry('data', s.data.label);
  if ((showCurve || diag) && s.fit.label) entry('fit', s.fit.label);
  if (band) entry('band', s.band.label || `${pct}% confidence band`);

  const P = {
    s, family, W: s.width * PX_PER_IN, H: s.height * PX_PER_IN,
    xView, yView, rView, xLog, yLog,
    xMinor: s.xTicks.minor || (s.grid.show && s.grid.minor),
    yMinor: s.yTicks.minor || (s.grid.show && s.grid.minor),
    xMarks: tickMarks(s.xTicks), yMarks: tickMarks(s.yTicks),
    tickPx: px(Math.max(1, s.fontSize - 1)), labelPx: px(s.fontSize), titlePx: px(s.fontSize + 1), legendPx: px(s.legend.fontSize),
    xLabel: html(s.xLabel), yLabel: html(s.yLabel), title: html(s.title), residualLabel: 'Residual',
    math: { xLabel: isMathText(s.xLabel), yLabel: isMathText(s.yLabel), title: isMathText(s.title) },
    // mathtext pads its box by device pixels of the renderer: the PNG's
    // dpi, or 72 for the vector formats.
    mathPad: 2 * PX_PER_IN / (s.export.format === 'png' ? s.dpi : 72),
    axes: res
      ? [{ residual: false, bottom: false, ratio: 1 }, { residual: true, bottom: true, ratio: s.residuals.heightRatio }]
      : [{ residual: false, bottom: true, ratio: 1 }]
  };
  P.legend = s.legend.show ? legendBox(P, entries) : null;

  /* Layout: two passes of constrained layout, then the drawing's own ticks */
  let boxes = initialBoxes(P);
  for (let pass = 0; pass < 2; pass++) {
    const next = solveLayout(P, P.axes.map((ax, i) => dressAxes(P, ax, boxes[i])));
    if (!next) {
      notes.push('At this size the labels and ticks leave no room for the axes, so matplotlib keeps its default layout, as the preview does. Make the figure larger or the text smaller.');
      break;
    }
    boxes = next;
  }
  const dressed = P.axes.map((ax, i) => dressAxes(P, ax, boxes[i]));
  const main = dressed[0];

  let legend = null;
  if (P.legend) {
    const pos = s.legend.position;
    if (pos === 'outside right') legend = { loc: pos, box: outsideLegend(P, main.box) };
    else if (pos === 'best') {
      const line = (xs, ys) => ({ xs: xs.map(main.X), ys: ys.map(main.Y) });
      const lines = [];
      if (showCurve) lines.push(line(curve.x, curve.y));
      if (diag) lines.push(line(diag, diag));
      if (s.data.show && markerOn && n) lines.push(line(dx, dy));
      if (s.data.show && errorBars && s.data.capSize > 0) lines.push(line(dx, lower), line(dx, upper));
      legend = bestLegend(P.legend, main.box, P.legendPx, lines);
    } else legend = { loc: pos, box: anchoredLegend(pos, P.legend, main.box, P.legendPx) };
  }

  /* The saved page: the figure, or with bbox_inches='tight' what is drawn plus 0.1 in */
  const tight = options.tight ?? s.export.tight;
  let ox = 0; let oy = 0; let Wout = P.W; let Hout = P.H;
  if (tight) {
    const full = union([...dressed.flatMap((d) => [d.box, ...d.items.map((it) => it.box), ...d.spines.filter(solid)]), legend && legend.box]);
    const pad = RC.tightPad * PX_PER_IN;
    ox = pad - full.l; oy = pad - full.t;
    Wout = full.r - full.l + 2 * pad; Hout = full.b - full.t + 2 * pad;
  }
  const fx = (x) => (x + ox) / Wout;
  const fy = (y) => 1 - (y + oy) / Hout;
  const c = (v) => String(Math.round(v * 1e7) / 1e7);
  const path = (polys) => polys.map(({ pts, closed }) => 'M' + pts.map(([x, y]) => `${c(fx(x))},${c(fy(y))}`).join('L') + (closed ? 'Z' : '')).join('');
  const fg = s.foreground;
  const below = []; const above = []; const annotations = [];
  const shape = (list, polys, line, extra = {}) => {
    if (polys.length) list.push({ type: 'path', xref: 'paper', yref: 'paper', path: path(polys), line, fillcolor: 'rgba(0,0,0,0)', ...extra });
  };

  /* Grid: below everything, as set_axisbelow(True) has it */
  if (s.grid.show) {
    const colour = rgba(s.grid.color, s.grid.alpha);
    const lines = (d, xs, ys) => [
      ...xs.map((t) => ({ pts: [[d.X(t.v), d.box.b], [d.X(t.v), d.box.t]] })),
      ...ys.map((t) => ({ pts: [[d.box.l, d.Y(t.v)], [d.box.r, d.Y(t.v)]] }))
    ];
    const minorWidth = round(s.grid.width / 2);
    for (const d of dressed) {
      shape(below, lines(d, d.xt.major, d.yt.major), { color: colour, width: px(s.grid.width), dash: plotlyDash(s.grid.style, s.grid.width) }, { layer: 'below' });
      if (s.grid.minor) shape(below, lines(d, d.xt.minor, d.yt.minor), { color: colour, width: px(minorWidth), dash: plotlyDash(s.grid.style, minorWidth) }, { layer: 'below' });
    }
  }

  /* Frame and tick marks */
  for (const d of dressed) {
    if (s.spines.width > 0) {
      shape(above, [spinePath(d.box, s.spines.top, s.spines.right, px(s.spines.width) / 2)], { color: fg, width: px(s.spines.width) }, { layer: 'above' });
    }
    for (const [axis, T, marks] of [['x', s.xTicks, P.xMarks], ['y', s.yTicks, P.yMarks]]) {
      for (const [list, mk] of [[d[`${axis}t`].major, marks.major], [d[`${axis}t`].minor, marks.minor]]) {
        if (!(mk.len > 0 && mk.width > 0) || !list.length) continue;
        const L = px(mk.len); const o = L * DIR_OUT[mk.dir]; const i = L * DIR_IN[mk.dir];
        const segs = [];
        for (const t of list) {
          if (axis === 'x') {
            const x = d.X(t.v);
            segs.push({ pts: [[x, d.box.b - i], [x, d.box.b + o]] });
            if (T.mirror) segs.push({ pts: [[x, d.box.t + i], [x, d.box.t - o]] });
          } else {
            const y = d.Y(t.v);
            segs.push({ pts: [[d.box.l + i, y], [d.box.l - o, y]] });
            if (T.mirror) segs.push({ pts: [[d.box.r - i, y], [d.box.r + o, y]] });
          }
        }
        shape(above, segs, { color: fg, width: px(mk.width) }, { layer: 'above' });
      }
    }
  }

  /* Text */
  const annotate = (it, size = it.size) => {
    const b = it.m;
    const ow = Math.round(b.width); const oh = Math.round(b.height);
    let cx; let cy;
    if (it.rot) {
      // Plotly rotates about the box centre: put the centre where the
      // rotated baseline lands on it.x.
      cx = it.x + b.top + oh / 2;
      cy = it.y;
    } else {
      const left = it.ha === 'center' ? it.x - b.width / 2 : it.ha === 'right' ? it.x - b.width : it.x;
      cx = left + ow / 2;
      cy = it.y + b.top + oh / 2;
    }
    annotations.push({
      xref: 'paper', yref: 'paper', x: fx(cx), y: fy(cy), xanchor: 'center', yanchor: 'middle',
      text: it.html, showarrow: false, borderpad: 0, borderwidth: 0, textangle: it.rot ? -90 : 0,
      font: { family: FONT_STACKS[family], size, color: fg }, captureevents: false
    });
  };
  dressed.forEach((d) => d.items.forEach((it) => annotate(it)));

  /* Legend: frame, handles and labels, above everything */
  if (legend) {
    const fs = P.legendPx;
    const k = RC.legend;
    const b = legend.box;
    if (s.legend.frame) {
      // FancyBboxPatch, round with rounding_size 0.2 font sizes: quadratic corners.
      const r = Math.min(0.2 * fs, (b.r - b.l) / 2, (b.b - b.t) / 2);
      const P2 = ([x, y]) => `${c(fx(x))},${c(fy(y))}`;
      const d = `M${P2([b.l + r, b.b])}L${P2([b.r - r, b.b])}Q${P2([b.r, b.b])},${P2([b.r, b.b - r])}`
        + `L${P2([b.r, b.t + r])}Q${P2([b.r, b.t])},${P2([b.r - r, b.t])}L${P2([b.l + r, b.t])}`
        + `Q${P2([b.l, b.t])},${P2([b.l, b.t + r])}L${P2([b.l, b.b - r])}Q${P2([b.l, b.b])},${P2([b.l + r, b.b])}Z`;
      above.push({
        type: 'path', xref: 'paper', yref: 'paper', path: d, layer: 'above',
        // The script sets legend.facecolor to the background, as here.
        fillcolor: rgba(s.background, RC.legend.framealpha),
        line: { color: rgba(RC.legend.edgecolor, RC.legend.framealpha), width: px(1) }
      });
    }
    let y = b.t + k.borderpad * fs;
    const hx = b.l + k.borderpad * fs;
    for (const row of P.legend.rows) {
      const base = y + row.up;
      const cy = base - (k.handleheight * fs) / 2;
      const hc = hx + (k.handlelength * fs) / 2;
      if (row.kind === 'data') {
        if (errorBars) {
          const e = 0.5 * fs;   // HandlerErrorbar: half a font size either side
          const line = { color: rgba(s.data.color, s.data.alpha), width: px(s.data.errorWidth) };
          shape(above, [{ pts: [[hc, cy + e], [hc, cy - e]] }], line, { layer: 'above' });
          if (s.data.capSize > 0) {
            const w = px(s.data.capSize);
            shape(above, [{ pts: [[hc - w, cy + e], [hc + w, cy + e]] }, { pts: [[hc - w, cy - e], [hc + w, cy - e]] }], line, { layer: 'above' });
          }
        }
        if (markerOn) above.push(...legendMarker(s, hc, cy, fx, fy, path));
      } else if (row.kind === 'fit') {
        shape(above, [{ pts: [[hx, cy], [hx + k.handlelength * fs, cy]] }],
          { color: s.fit.color, width: px(s.fit.width), dash: plotlyDash(s.fit.style, s.fit.width) }, { layer: 'above' });
      } else {
        above.push({
          type: 'rect', xref: 'paper', yref: 'paper', layer: 'above',
          x0: fx(hx), x1: fx(hx + k.handlelength * fs), y0: fy(base), y1: fy(base - k.handleheight * fs),
          fillcolor: rgba(s.band.color, s.band.alpha), line: { width: 0, color: 'rgba(0,0,0,0)' }
        });
      }
      annotate({ html: row.html, size: fs, x: hx + (k.handlelength + k.handletextpad) * fs, y: base, ha: 'left', rot: 0, m: row.m });
      y = base + row.down + k.labelspacing * fs;
    }
  }

  /* Traces: band, fit, data; below them the residual panel's */
  const data = [];
  const fitLine = { color: s.fit.color, width: px(s.fit.width), dash: plotlyDash(s.fit.style, s.fit.width) };
  const lineTrace = (x, y, xa, ya, line) => ({ type: 'scatter', mode: 'lines', x, y, xaxis: xa, yaxis: ya, line, hoverinfo: 'skip', showlegend: false });
  if (band) {
    data.push({
      ...lineTrace([...band.x, ...band.x.slice().reverse()], [...band.upper, ...band.lower.slice().reverse()], 'x', 'y', { width: 0, color: 'rgba(0,0,0,0)' }),
      fill: 'toself', fillcolor: rgba(s.band.color, s.band.alpha)
    });
  }
  if (showCurve) data.push(lineTrace(curve.x, curve.y, 'x', 'y', fitLine));
  if (diag) data.push(lineTrace(diag, diag, 'x', 'y', fitLine));
  const points = (x, y, xa, ya, logY, view) => {
    const t = { type: 'scatter', mode: 'markers', x, y, xaxis: xa, yaxis: ya, hoverinfo: 'skip', showlegend: false, cliponaxis: true };
    if (markerOn) {
      const mk = MARKER_MAP[s.data.marker];
      // Alpha on the face and the edge colours, not on the marker as a whole:
      // matplotlib draws both translucent, so the edge's inner half shows
      // darker over the face.
      t.marker = {
        symbol: mk.symbol, size: mk.k * px(s.data.size),
        color: rgba(mk.line ? s.data.edgeColor : s.data.color, s.data.alpha),
        line: { color: rgba(s.data.edgeColor, s.data.alpha), width: px(s.data.edgeWidth) }
      };
      // Plotly strokes a line-only marker at 1 px at least; matplotlib draws nothing.
      if (mk.line && !(s.data.edgeWidth > 0)) t.marker.opacity = 0;
    } else {
      t.marker = { size: 0, opacity: 0 };
    }
    if (errorBars) {
      // On a log axis a bar reaching zero or below is drawn to the bottom
      // edge, as matplotlib clips it; Plotly would drop the whole bar.
      const floor = Math.min(view[0], view[1]) / 1e3;
      t.error_y = {
        type: 'data', symmetric: false, visible: true,
        array: y.map((v, i) => sig[i]),
        arrayminus: y.map((v, i) => (logY && !(v - sig[i] > 0) ? v - floor : sig[i])),
        color: rgba(s.data.color, s.data.alpha), thickness: px(s.data.errorWidth), width: px(s.data.capSize)
      };
    }
    return t;
  };
  if (showData) data.push(points(dx, dy, 'x', 'y', yLog, yView));
  if (res) {
    data.push(lineTrace(xView.slice(), [0, 0], 'x2', 'y2', fitLine));
    if (pointsDrawn && res.x.length) data.push(points(res.x, res.r, 'x2', 'y2', false, rView));
  }

  /* Axes: only their scale, range and place; Plotly draws none of their parts */
  const range = (v, log) => (log ? v.map((q) => Math.log10(q)) : v.slice());
  const axis = (dom, v, log, anchor) => ({ domain: dom, range: range(v, log), type: log ? 'log' : 'linear', autorange: false, visible: false, fixedrange: true, anchor });
  const layout = {
    width: Wout, height: Hout, autosize: false,
    margin: { l: 0, r: 0, t: 0, b: 0, pad: 0 },
    paper_bgcolor: options.transparent ? 'rgba(0,0,0,0)' : s.background,
    plot_bgcolor: 'rgba(0,0,0,0)',
    showlegend: false, hovermode: false, dragmode: false,
    font: { family: FONT_STACKS[family], color: fg, size: P.labelPx },
    xaxis: axis([fx(main.box.l), fx(main.box.r)], xView, xLog, 'y'),
    yaxis: axis([fy(main.box.b), fy(main.box.t)], yView, yLog, 'x'),
    shapes: [...below, ...above],
    annotations
  };
  if (res) {
    const r = dressed[1].box;
    layout.xaxis2 = axis([fx(r.l), fx(r.r)], xView, xLog, 'y2');
    layout.yaxis2 = axis([fy(r.b), fy(r.t)], rView, false, 'x2');
  }

  /* What the preview cannot show as matplotlib will */
  for (const d of dressed) notes.push(...d.xt.notes, ...d.yt.notes), unknownTex.push(...d.xt.tex, ...d.yt.tex);
  notes.push(...texNotes([s.title, s.xLabel, s.yLabel, s.data.label, s.fit.label, s.band.label,
    ...s.xTicks.labels, ...s.yTicks.labels], unknownTex));
  if (showData && (s.data.marker === '^' || s.data.marker === 'v')) {
    notes.push('Plotly\'s triangles are a little wider and flatter than matplotlib\'s; the preview matches their area.');
  }

  return {
    data,
    layout,
    info: {
      widthIn: Wout / PX_PER_IN, heightIn: Hout / PX_PER_IN, widthPx: Wout, heightPx: Hout,
      figureWidthIn: s.width, figureHeightIn: s.height, tight: !!tight,
      legend: legend ? legend.loc : null,
      axes: dressed.map((d) => ({ l: d.box.l + ox, t: d.box.t + oy, r: d.box.r + ox, b: d.box.b + oy })),
      legendBox: legend ? { l: legend.box.l + ox, t: legend.box.t + oy, r: legend.box.r + ox, b: legend.box.b + oy } : null,
      notes: [...new Set(notes)]
    }
  };
}

/* The data marker in the legend, as shapes in the plot's marker form. */
function legendMarker(s, cx, cy, fx, fy, path) {
  const mk = MARKER_MAP[s.data.marker];
  if (!mk) return [];
  const r = (mk.k * px(s.data.size)) / 2;
  const edge = { color: rgba(s.data.edgeColor, s.data.alpha), width: px(s.data.edgeWidth) };
  const face = rgba(s.data.color, s.data.alpha);
  const base = { xref: 'paper', yref: 'paper', layer: 'above' };
  if (mk.line) {
    if (!(s.data.edgeWidth > 0)) return [];
    return [{ ...base, type: 'path', path: path(markerOutline(mk.symbol, cx, cy, r)), fillcolor: 'rgba(0,0,0,0)', line: edge }];
  }
  const outline = markerOutline(mk.symbol, cx, cy, r);
  if (!outline) {
    return [{ ...base, type: 'circle', x0: fx(cx - r), x1: fx(cx + r), y0: fy(cy + r), y1: fy(cy - r), fillcolor: face, line: edge }];
  }
  return [{ ...base, type: 'path', path: path(outline), fillcolor: face, line: edge }];
}

/* ------------------------------------------------------------------ *
 * Preview
 * ------------------------------------------------------------------ */

const PLOTLY_CONFIG = { staticPlot: true, displayModeBar: false, responsive: false, showTips: false };
const states = new WeakMap();

function plotly() {
  const P = typeof globalThis !== 'undefined' ? globalThis.Plotly : undefined;
  if (!P) throw new Error('Plotly is not loaded.');
  return P;
}

/* Scale the true-size figure to the container's width. */
function fitStage(st) {
  const info = st.info;
  if (!info) return;
  const avail = st.stage.clientWidth;
  const scale = avail > 0 ? Math.min(st.options.maxScale ?? 2, avail / info.widthPx) : 1;
  st.scale = scale;
  info.scale = scale;
  st.figure.style.width = `${info.widthPx}px`;
  st.figure.style.height = `${info.heightPx}px`;
  st.figure.style.transform = `scale(${scale})`;
  st.figure.style.setProperty('--fp-scale', String(scale));
  st.figure.style.left = `${Math.max(0, (avail - info.widthPx * scale) / 2)}px`;
  st.stage.style.height = `${info.heightPx * scale}px`;
}

async function drawPreview(st, job) {
  const fig = buildFitFigure(job.model, job.style, job.options);
  st.model = job.model; st.style = job.style; st.options = job.options;
  await plotly().react(st.figure, fig.data, fig.layout, PLOTLY_CONFIG);
  st.info = fig.info;
  fitStage(st);
  return fig.info;
}

/**
 * Draw the figure into `el` at its true size (96 px per inch), scaled with a
 * CSS transform to fit el's width. Calls made while a drawing is under way
 * are merged: the last one wins and every caller gets its result.
 *
 * @param {HTMLElement} el
 * @param {object} model - see buildFitFigure
 * @param {object} style
 * @param {object} [options]
 * @param {boolean} [options.responsive=true] - refit the scale when el is resized
 * @param {number} [options.maxScale=2]       - largest enlargement of a small figure
 * @param {boolean} [options.tight]            - as buildFitFigure (default: style.export.tight)
 * @returns {Promise<object>} buildFitFigure's info, plus `scale`, the CSS scale now applied
 */
export function renderFitPlot(el, model, style, options = {}) {
  let st = states.get(el);
  if (!st) {
    const stage = document.createElement('div');
    stage.className = 'fp-stage';
    const figure = document.createElement('div');
    figure.className = 'fp-figure';
    figure.setAttribute('role', 'img');
    stage.appendChild(figure);
    el.appendChild(stage);
    st = { el, stage, figure, info: null, latest: null, running: null, options };
    states.set(el, st);
    if (options.responsive !== false && typeof ResizeObserver !== 'undefined') {
      st.observer = new ResizeObserver(() => fitStage(st));
      st.observer.observe(el);
    }
  }
  st.options = options;
  st.latest = { model, style, options };
  if (!st.running) {
    st.running = (async () => {
      let info = st.info;
      try {
        while (st.latest) {
          const job = st.latest;
          st.latest = null;
          info = await drawPreview(st, job);
        }
      } finally {
        st.running = null;
      }
      return info;
    })();
  }
  return st.running;
}

/** Stop observing and remove the preview from `el`. */
export function destroyFitPlot(el) {
  const st = states.get(el);
  if (!st) return;
  if (st.observer) st.observer.disconnect();
  try { plotly().purge(st.figure); } catch { /* already gone */ }
  st.stage.remove();
  states.delete(el);
}

/* ------------------------------------------------------------------ *
 * Export
 * ------------------------------------------------------------------ */

const MIME = { pdf: 'application/pdf', png: 'image/png', svg: 'image/svg+xml' };
const MAX_CANVAS_SIDE = 16384;
const MAX_CANVAS_AREA = 16384 * 16384 / 2;

function dataUrlBytes(url) {
  const comma = url.indexOf(',');
  const head = url.slice(0, comma);
  const body = url.slice(comma + 1);
  if (/;base64/.test(head)) {
    const bin = atob(body);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new TextEncoder().encode(decodeURIComponent(body));
}

const svgText = (url) => (url.startsWith('data:') ? new TextDecoder().decode(dataUrlBytes(url)) : url);

let crcTable = null;
function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * A PNG with its resolution recorded (a pHYs chunk after IHDR), so that it
 * opens at its size in inches, as matplotlib's does.
 */
export function pngWithDpi(png, dpi) {
  const ppm = Math.round(dpi / 0.0254);
  const chunk = new Uint8Array(21);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, 9);
  chunk.set([0x70, 0x48, 0x59, 0x73], 4);   // pHYs
  view.setUint32(8, ppm); view.setUint32(12, ppm); chunk[16] = 1;   // per metre
  view.setUint32(17, crc32(chunk.subarray(4, 17)));
  // Drop any pHYs already there, then put ours straight after IHDR.
  const parts = [png.subarray(0, 33), chunk];
  let i = 33;
  while (i + 8 <= png.length) {
    const len = new DataView(png.buffer, png.byteOffset + i, 4).getUint32(0);
    const type = String.fromCharCode(...png.subarray(i + 4, i + 8));
    const end = i + 12 + len;
    if (type !== 'pHYs') parts.push(png.subarray(i, end));
    i = end;
  }
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/* Plotly's SVG measured in points, as matplotlib writes it, so it opens at
   its size in inches; the drawing keeps its pixel coordinates. */
function svgWithSize(svg, widthIn, heightIn, widthPx, heightPx) {
  return svg.replace(/<svg\b[^>]*>/, (tag) => {
    let t = tag.replace(/\swidth="[^"]*"/, '').replace(/\sheight="[^"]*"/, '');
    if (!/\sviewBox=/.test(t)) t = t.replace(/^<svg/, `<svg viewBox="0 0 ${widthPx} ${heightPx}"`);
    return t.replace(/^<svg/, `<svg width="${round(widthIn * 72, 3)}pt" height="${round(heightIn * 72, 3)}pt"`);
  });
}

function download(bytes, filename, mime) {
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/**
 * Save the figure drawn in `el` (by renderFitPlot) in the style's export
 * format, at its exact size, and download it.
 *
 *   PNG  Plotly.toImage at dpi/96 times the true size, transparent when the
 *        style says so, with the resolution recorded in the file
 *   SVG  Plotly's SVG, measured in points
 *   PDF  vector, from Plotly's SVG through pdfFromSvg; if that fails, a JPEG
 *        page through pdfFromJpeg
 *
 * @param {HTMLElement} el
 * @param {object} [style] - defaults to the style last drawn
 * @param {{download?: boolean}} [options] - download: false returns the bytes only
 * @returns {Promise<{filename: string, format: string, bytes: Uint8Array, widthIn: number,
 *   heightIn: number, pixelWidth?: number, pixelHeight?: number, raster?: boolean}>}
 */
export async function exportFitPlot(el, style, options = {}) {
  const st = states.get(el);
  if (!st || !st.model) throw new Error('Draw the plot before saving it.');
  const s = normalisePlotStyle(style ?? st.style);
  const P = plotly();
  const format = s.export.format;
  const filename = `${s.export.filename}.${format}`;
  const fig = buildFitFigure(st.model, s, { ...st.options, transparent: s.export.transparent });
  const { widthIn, heightIn, widthPx, heightPx } = fig.info;
  const figure = { data: fig.data, layout: fig.layout, config: PLOTLY_CONFIG };
  const result = { filename, format, widthIn, heightIn };
  if (format === 'png') {
    const pw = Math.floor(widthIn * s.dpi + 1e-6);
    const ph = Math.floor(heightIn * s.dpi + 1e-6);
    if (pw > MAX_CANVAS_SIDE || ph > MAX_CANVAS_SIDE || pw * ph > MAX_CANVAS_AREA) {
      throw new Error(`At ${s.dpi} dpi the PNG would be ${pw} × ${ph} pixels, more than a browser can draw. Lower the DPI or the size.`);
    }
    const url = await P.toImage(figure, { format: 'png', width: widthPx, height: heightPx, scale: (s.dpi / PX_PER_IN) * (1 + 1e-9) });
    result.bytes = pngWithDpi(dataUrlBytes(url), s.dpi);
    result.pixelWidth = pw; result.pixelHeight = ph;
  } else {
    const svg = svgText(await P.toImage(figure, { format: 'svg', width: widthPx, height: heightPx }));
    if (format === 'svg') {
      result.bytes = new TextEncoder().encode(svgWithSize(svg, widthIn, heightIn, widthPx, heightPx));
    } else {
      try {
        result.bytes = pdfFromSvg(svg, { widthIn, heightIn });
      } catch (err) {
        // The vector route failed on something in the SVG: a picture of the
        // page instead, on an opaque background (JPEG has no transparency).
        const opaque = buildFitFigure(st.model, s, { ...st.options, transparent: false });
        const dpi = Math.min(s.dpi, 300);
        const url = await P.toImage({ data: opaque.data, layout: opaque.layout, config: PLOTLY_CONFIG },
          { format: 'jpeg', width: widthPx, height: heightPx, scale: dpi / PX_PER_IN });
        const pixelWidth = Math.floor(widthIn * dpi + 1e-6);
        const pixelHeight = Math.floor(heightIn * dpi + 1e-6);
        result.bytes = pdfFromJpeg(dataUrlBytes(url), { widthIn, heightIn, pixelWidth, pixelHeight });
        result.raster = true;
        result.error = err && err.message ? err.message : String(err);
      }
    }
  }
  if (options.download !== false) download(result.bytes, filename, MIME[format]);
  return result;
}

/* ------------------------------------------------------------------ *
 * Style panel
 * ------------------------------------------------------------------ */

const SIZE_PRESETS = [
  { id: 'single', label: 'Single column, 3.5 × 2.6 in', width: 3.5, height: 2.6 },
  { id: 'double', label: 'Double column, 7 × 4 in', width: 7, height: 4 },
  { id: 'slide', label: 'Slide, 10 × 5.6 in', width: 10, height: 5.6 },
  { id: 'default', label: 'Default, 6.4 × 4.8 in', width: 6.4, height: 4.8 }
];

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

const MARKER_NAMES = [['o', 'Circle'], ['s', 'Square'], ['^', 'Triangle, up'], ['v', 'Triangle, down'], ['D', 'Diamond'],
  ['x', 'Cross (×)'], ['+', 'Plus (+)'], ['.', 'Point'], ['none', 'None']];
const LINE_NAMES = [['solid', 'Solid'], ['dashed', 'Dashed'], ['dotted', 'Dotted'], ['dashdot', 'Dash-dot']];
const FONT_NAMES = [['sans-serif', 'Sans-serif (Arial)'], ['serif', 'Serif (Times)'], ['monospace', 'Monospace (Courier)']];
const LEGEND_NAMES = [['best', 'Best (least overlap)'], ['upper right', 'Upper right'], ['upper left', 'Upper left'],
  ['lower left', 'Lower left'], ['lower right', 'Lower right'], ['center left', 'Centre left'], ['center right', 'Centre right'],
  ['lower center', 'Lower centre'], ['upper center', 'Upper centre'], ['center', 'Centre'], ['outside right', 'Outside, right']];
const DIRECTION_NAMES = [['out', 'Outward'], ['in', 'Inward'], ['inout', 'Across the axis']];
const MODE_NAMES = [['auto', 'Automatic'], ['step', 'Every …'], ['count', 'About … ticks'], ['list', 'At listed values']];
const FORMAT_NAMES = [['', 'Automatic'], ['sci', 'Scientific, ×10ⁿ'], ['%.0f', 'Whole numbers'], ['%.1f', '1 decimal place'],
  ['%.2f', '2 decimal places'], ['%.3f', '3 decimal places'], ['%g', 'Shortest (%g)'], ['custom', 'Custom (printf)']];

const clone = (o) => JSON.parse(JSON.stringify(o));
const getPath = (o, path) => path.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
function setPath(o, path, v) {
  const keys = path.split('.');
  const last = keys.pop();
  keys.reduce((a, k) => a[k], o)[last] = v;
}
function deepMerge(base, over) {
  const out = clone(base);
  for (const [k, v] of Object.entries(over)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(out[k] || {}, v) : v;
  }
  return out;
}
const fmtNum = (v) => (v === null || v === undefined || !Number.isFinite(v) ? '' : String(Number(v.toPrecision(12))));
const hex6 = (c) => {
  const h = String(c || '').trim();
  return /^#[0-9a-f]{3}$/i.test(h) ? '#' + [...h.slice(1)].map((q) => q + q).join('').toLowerCase() : h.toLowerCase();
};
let panelCount = 0;

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c) node.append(c);
  return node;
}

/**
 * The panel that edits a plot style: grouped controls for the figure, text,
 * axes and ticks, data, fit line, band, residuals, legend, grid, frame and
 * export, with size presets, three look presets and a reset.
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
  const prefix = `fp${++panelCount}`;
  let draft = normalisePlotStyle(style);
  let ctx = { multivariate: false, hasSigma: true, independent: 'x', dependent: 'y' };
  // The automatic labels of the last context. Before any context, only the
  // style's own defaults ('x' and 'y') count as automatic: labels the panel
  // starts with may have been typed (restored from an earlier visit).
  const styleDefaults = defaultPlotStyle();
  let defaultLabels = { x: styleDefaults.xLabel, y: styleDefaults.yLabel };
  const controls = [];
  const timers = new Map();
  const cleanups = [];
  let axisShown = 'x';
  const idOf = (path) => `${prefix}-${path.replace(/[^\w]+/g, '-')}`;

  const emit = () => {
    draft = normalisePlotStyle(draft);
    refresh();
    if (typeof onChange === 'function') onChange(clone(draft));
  };
  const commit = (path, value) => { setPath(draft, path, value); emit(); };
  const later = (key, fn) => {
    clearTimeout(timers.get(key));
    timers.set(key, setTimeout(() => { timers.delete(key); fn(); }, 150));
  };
  const listen = (node, type, fn) => { node.addEventListener(type, fn); cleanups.push(() => node.removeEventListener(type, fn)); };
  const hintEl = (id, text) => (text ? el('p', { class: 'stk-hint fp-hint', id }, text) : null);

  /* Field factories. Each registers how to show the style's value. */
  function field(path, label, control, { hint, span, unit } = {}) {
    const hid = hint ? `${idOf(path)}-hint` : null;
    if (hid) control.setAttribute('aria-describedby', hid);
    const body = unit ? el('div', { class: 'fp-unit' }, control, el('span', { 'aria-hidden': 'true', text: unit })) : control;
    return el('div', { class: `stk-field fp-field${span ? ' fp-span' : ''}`, 'data-path': path },
      el('label', { for: control.id, text: label }), body, hintEl(hid, hint));
  }
  function number(path, label, { min, max, step = 'any', unit, nullable = false, placeholder, hint, span, scale = 1 } = {}) {
    const input = el('input', { class: 'stk-input stk-input-sm', type: 'number', id: idOf(path), inputmode: 'decimal', min, max, step, placeholder });
    const read = () => {
      const t = input.value.trim();
      if (t === '') return nullable ? null : undefined;
      const v = Number(t);
      return Number.isFinite(v) ? v / scale : undefined;
    };
    const apply = () => { const v = read(); if (v !== undefined) commit(path, v); };
    listen(input, 'input', () => later(path, apply));
    listen(input, 'change', () => { clearTimeout(timers.get(path)); apply(); show(); });
    const show = () => {
      if (document.activeElement === input && timers.has(path)) return;
      const v = getPath(draft, path);
      input.value = v === null ? '' : fmtNum(v * scale);
    };
    controls.push({ show });
    return field(path, label, input, { hint, span, unit });
  }
  function text(path, label, { placeholder, hint, span = true, mono = false } = {}) {
    const input = el('input', { class: `stk-input stk-input-sm${mono ? ' stk-mono' : ''}`, type: 'text', id: idOf(path), placeholder, spellcheck: 'false', autocomplete: 'off' });
    listen(input, 'input', () => { if (path === 'xLabel' || path === 'yLabel') touched[path] = true; later(path, () => commit(path, input.value)); });
    listen(input, 'change', () => { clearTimeout(timers.get(path)); timers.delete(path); commit(path, input.value); });
    controls.push({ show: () => { if (!(document.activeElement === input && timers.has(path))) input.value = getPath(draft, path) ?? ''; } });
    return field(path, label, input, { hint, span });
  }
  function select(path, label, choices, { hint, span } = {}) {
    const input = el('select', { class: 'stk-select stk-select-sm', id: idOf(path) },
      choices.map(([v, t]) => el('option', { value: v, text: t })));
    listen(input, 'change', () => commit(path, input.value));
    controls.push({ show: () => { input.value = String(getPath(draft, path)); } });
    return field(path, label, input, { hint, span });
  }
  function check(path, label, { hint } = {}) {
    const input = el('input', { type: 'checkbox', id: idOf(path) });
    const hid = hint ? `${idOf(path)}-hint` : null;
    if (hid) input.setAttribute('aria-describedby', hid);
    listen(input, 'change', () => commit(path, input.checked));
    controls.push({ show: () => { input.checked = !!getPath(draft, path); } });
    return el('div', { class: 'fp-check', 'data-path': path },
      el('label', { class: 'stk-check', for: input.id }, input, el('span', { text: label })), hintEl(hid, hint));
  }
  function colour(path, label) {
    const id = idOf(path);
    const picker = el('input', { type: 'color', class: 'fp-swatch', id: `${id}-picker`, 'aria-label': `${label}, colour picker` });
    const code = el('input', { type: 'text', class: 'stk-input stk-input-sm stk-mono', id, maxlength: '7', spellcheck: 'false', autocomplete: 'off', 'aria-label': `${label}, hex code` });
    listen(picker, 'input', () => { code.value = picker.value; commit(path, picker.value); });
    listen(code, 'input', () => {
      const v = code.value.trim();
      const ok = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v);
      code.classList.toggle('is-invalid', !ok && v !== '');
      if (ok) commit(path, hex6(v.startsWith('#') ? v : `#${v}`));
    });
    listen(code, 'change', () => { code.classList.remove('is-invalid'); show(); });
    const show = () => {
      const v = hex6(getPath(draft, path));
      picker.value = v;
      if (document.activeElement !== code) code.value = v;
    };
    controls.push({ show });
    return el('div', { class: 'stk-field fp-field', 'data-path': path },
      el('label', { for: id, text: label }), el('div', { class: 'fp-colour' }, picker, code));
  }
  function range(path, label, { min, max, step, format = (v) => v.toFixed(2), span } = {}) {
    const input = el('input', { type: 'range', class: 'stk-range', id: idOf(path), min, max, step });
    const out = el('output', { for: input.id, class: 'fp-range-value' });
    listen(input, 'input', () => { out.textContent = format(Number(input.value)); commit(path, Number(input.value)); });
    controls.push({ show: () => { const v = getPath(draft, path); input.value = v; out.textContent = format(v); } });
    return el('div', { class: `stk-field fp-field${span ? ' fp-span' : ''}`, 'data-path': path },
      el('label', { for: input.id, text: label }), el('div', { class: 'fp-range' }, input, out));
  }
  function segmented(path, label, choices) {
    const gid = idOf(path);
    const buttons = choices.map(([v, t]) => el('button', { type: 'button', 'data-value': v, text: t, 'aria-pressed': 'false' }));
    const group = el('div', { class: 'stk-seg stk-seg-fill fp-seg', role: 'group', 'aria-labelledby': `${gid}-label` }, buttons);
    buttons.forEach((b) => listen(b, 'click', () => commit(path, b.dataset.value)));
    controls.push({ show: () => buttons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === String(getPath(draft, path))))) });
    return el('div', { class: 'stk-field fp-field fp-span', 'data-path': path }, el('span', { class: 'stk-label-sm', id: `${gid}-label`, text: label }), group);
  }
  const grid = (...items) => el('div', { class: 'fp-grid' }, items);
  const checks = (...items) => el('div', { class: 'fp-checks' }, items);
  const sub = (title) => el('p', { class: 'fp-sub', text: title });

  /* Figure size presets */
  function sizePreset() {
    const input = el('select', { class: 'stk-select stk-select-sm', id: `${prefix}-size` },
      el('option', { value: '', text: 'Custom' }), SIZE_PRESETS.map((q) => el('option', { value: q.id, text: q.label })));
    listen(input, 'change', () => {
      const q = SIZE_PRESETS.find((p) => p.id === input.value);
      if (q) { draft.width = q.width; draft.height = q.height; emit(); }
    });
    controls.push({ show: () => { const q = SIZE_PRESETS.find((p) => p.width === draft.width && p.height === draft.height); input.value = q ? q.id : ''; } });
    return field('size', 'Size', input, { span: true });
  }

  /* One axis: scale, limits and everything about its ticks */
  function axisFields(k) {
    const T = `${k}Ticks`;
    const lists = (which) => {
      const path = `${T}.${which}`;
      const input = el('input', { class: 'stk-input stk-input-sm', type: 'text', id: idOf(path), spellcheck: 'false', autocomplete: 'off',
        placeholder: which === 'values' ? '0, 0.5, 1' : '0, ½, 1' });
      const readList = () => {
        if (which === 'values') {
          const vals = input.value.split(/[,;\s]+/).filter(Boolean).map(Number).filter(Number.isFinite);
          draft[T].values = vals;
          draft[T].labels = draft[T].labels.slice(0, vals.length);
        } else {
          draft[T].labels = input.value.trim() === '' ? [] : input.value.split(',').map((q) => q.trim());
        }
        emit();
      };
      listen(input, 'input', () => later(path, readList));
      listen(input, 'change', () => { clearTimeout(timers.get(path)); timers.delete(path); readList(); });
      controls.push({ show: () => { if (!(document.activeElement === input && timers.has(path))) input.value = (which === 'values' ? draft[T].values.map(fmtNum) : draft[T].labels).join(', '); } });
      return field(path, which === 'values' ? 'Tick values' : 'Tick labels', input, {
        span: true,
        hint: which === 'values' ? 'Numbers, separated by commas.' : 'Optional, one per value, separated by commas; $…$ for maths, such as $\\pi/2$.'
      });
    };
    // The label format: a choice of common formats, or a printf format of one's own.
    const fmtPath = `${T}.format`;
    const fmtSelect = el('select', { class: 'stk-select stk-select-sm', id: idOf(fmtPath) }, FORMAT_NAMES.map(([v, t]) => el('option', { value: v, text: t })));
    const fmtCustom = el('input', { class: 'stk-input stk-input-sm stk-mono', type: 'text', id: `${idOf(fmtPath)}-custom`, placeholder: '%.2e', spellcheck: 'false', autocomplete: 'off', 'aria-label': `${k} tick label format, printf` });
    let customFormat = false;
    listen(fmtSelect, 'change', () => {
      customFormat = fmtSelect.value === 'custom';
      if (customFormat) { fmtCustom.hidden = false; fmtCustom.focus(); if (fmtCustom.value) commit(fmtPath, fmtCustom.value); else refresh(); } else commit(fmtPath, fmtSelect.value);
    });
    listen(fmtCustom, 'input', () => later(fmtPath, () => commit(fmtPath, fmtCustom.value)));
    listen(fmtCustom, 'change', () => { clearTimeout(timers.get(fmtPath)); timers.delete(fmtPath); commit(fmtPath, fmtCustom.value); });
    controls.push({
      show: () => {
        const f = draft[T].format;
        const known = FORMAT_NAMES.some(([v]) => v === f && v !== 'custom');
        if (!known) customFormat = true;
        fmtSelect.value = customFormat ? 'custom' : f;
        fmtCustom.hidden = !customFormat;
        if (document.activeElement !== fmtCustom) fmtCustom.value = customFormat ? f : fmtCustom.value;
        const bad = customFormat && f !== '' && !printfFormat(f);
        fmtCustom.classList.toggle('is-invalid', bad);
        fmtHint.hidden = !customFormat;
      }
    });
    const fmtHint = hintEl(`${idOf(fmtPath)}-hint`, 'A printf format with one number in it, such as %.1f or %.0e.');
    const fmtField = el('div', { class: 'stk-field fp-field fp-span', 'data-path': fmtPath },
      el('label', { for: fmtSelect.id, text: 'Label format' }), el('div', { class: 'fp-inline' }, fmtSelect, fmtCustom), fmtHint);
    fmtCustom.setAttribute('aria-describedby', fmtHint.id);

    return el('div', { class: 'fp-axis', 'data-axis': k },
      grid(
        segmented(`${k}Scale`, 'Scale', [['linear', 'Linear'], ['log', 'Logarithmic']]),
        number(`${k}Lim.0`, 'Minimum', { nullable: true, placeholder: 'Auto' }),
        number(`${k}Lim.1`, 'Maximum', { nullable: true, placeholder: 'Auto' }),
        el('p', { class: 'stk-hint fp-hint fp-span', text: 'Leave empty for matplotlib\'s choice.' })
      ),
      sub('Ticks'),
      grid(
        select(`${T}.mode`, 'Place ticks', MODE_NAMES, { span: true }),
        number(`${T}.step`, 'Every', { min: 0, nullable: true, placeholder: 'e.g. 0.5', span: true, hint: k === 'x' ? 'On a log axis, in decades.' : 'On a log axis, in decades.' }),
        number(`${T}.count`, 'About this many', { min: 2, max: 50, step: 1, nullable: true, placeholder: '5', span: true }),
        lists('values'),
        lists('labels'),
        fmtField,
        select(`${T}.direction`, 'Direction', DIRECTION_NAMES, { span: true }),
        number(`${T}.length`, 'Length', { min: 0, max: 20, step: 0.5, unit: 'pt' }),
        number(`${T}.width`, 'Width', { min: 0, max: 5, step: 0.1, unit: 'pt' })
      ),
      checks(
        check(`${T}.minor`, 'Minor ticks'),
        check(`${T}.mirror`, `Marks on the ${k === 'x' ? 'top' : 'right'} too`)
      )
    );
  }

  /* Groups */
  const groups = {};
  const summaries = {};
  function group(key, title, ...body) {
    const summary = el('span', { class: 'fp-sum' });
    summaries[key] = summary;
    const open = (options.open || ['figure']).includes(key);
    const d = el('details', { class: 'stk-disclosure fp-group', 'data-group': key, open },
      el('summary', {}, el('span', { class: 'fp-group-t', text: title }), summary),
      el('div', { class: 'fp-group-b' }, body));
    groups[key] = d;
    return d;
  }

  const axisTabs = el('div', { class: 'stk-seg stk-seg-fill fp-axis-switch', role: 'tablist', 'aria-label': 'Axis' },
    ['x', 'y'].map((k) => el('button', { type: 'button', role: 'tab', id: `${prefix}-tab-${k}`, 'data-axis': k, 'aria-selected': String(k === 'x'), 'aria-controls': `${prefix}-axis-${k}`, text: `${k} axis` })));
  const axisPanels = ['x', 'y'].map((k) => {
    const p = axisFields(k);
    p.id = `${prefix}-axis-${k}`;
    p.setAttribute('role', 'tabpanel');
    p.setAttribute('aria-labelledby', `${prefix}-tab-${k}`);
    return p;
  });
  axisTabs.querySelectorAll('button').forEach((b) => {
    listen(b, 'click', () => { axisShown = b.dataset.axis; refresh(); });
    listen(b, 'keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      axisShown = axisShown === 'x' ? 'y' : 'x';
      refresh();
      axisTabs.querySelector(`[data-axis="${axisShown}"]`).focus();
      e.preventDefault();
    });
  });

  const bandNote = el('p', { class: 'stk-hint fp-note', text: 'With several independent variables there is no single curve, so no band.' });
  const sigmaNote = el('p', { class: 'stk-hint fp-note', text: 'Error bars need a column of uncertainties.' });
  const presetButtons = Object.keys(STYLE_PRESETS).map((k) => el('button', { type: 'button', class: 'stk-btn stk-btn-sm', 'data-preset': k, text: k[0].toUpperCase() + k.slice(1) }));
  const resetButton = el('button', { type: 'button', class: 'stk-btn stk-btn-sm stk-btn-ghost fp-reset', text: 'Reset to defaults' });

  const root = el('div', { class: 'fp-panel' },
    el('div', { class: 'fp-top' },
      el('div', { class: 'fp-top-row' }, el('span', { class: 'fp-presets-t', id: `${prefix}-presets`, text: 'Start from a preset' }), resetButton),
      el('div', { class: 'fp-presets', role: 'group', 'aria-labelledby': `${prefix}-presets` }, presetButtons)),
    group('figure', 'Figure',
      grid(
        sizePreset(),
        number('width', 'Width', { min: 1, max: 30, step: 0.1, unit: 'in' }),
        number('height', 'Height', { min: 1, max: 30, step: 0.1, unit: 'in' }),
        select('fontFamily', 'Font', FONT_NAMES),
        number('fontSize', 'Font size', { min: 4, max: 40, step: 0.5, unit: 'pt', hint: 'Axis labels; ticks are 1 pt smaller, the title 1 pt larger.', span: false }),
        colour('background', 'Background'),
        colour('foreground', 'Text and lines')
      )),
    group('text', 'Title and labels',
      grid(
        text('title', 'Title', { placeholder: 'None' }),
        text('xLabel', 'x-axis label'),
        text('yLabel', 'y-axis label'),
        el('p', { class: 'stk-hint fp-hint fp-span', text: 'Put maths between $ signs, as matplotlib does: $\\tau$ / ms, $x^2$, $E_a$.' })
      )),
    group('axes', 'Axes and ticks', axisTabs, ...axisPanels),
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
    group('legend', 'Legend',
      checks(check('legend.show', 'Show the legend'), check('legend.frame', 'Frame')),
      grid(
        select('legend.position', 'Position', LEGEND_NAMES, { span: true }),
        number('legend.fontSize', 'Font size', { min: 4, max: 40, step: 0.5, unit: 'pt' })
      )),
    group('grid', 'Grid',
      checks(check('grid.show', 'Grid lines'), check('grid.minor', 'At minor ticks too')),
      grid(
        colour('grid.color', 'Colour'),
        range('grid.alpha', 'Opacity', { min: 0, max: 1, step: 0.05 }),
        select('grid.style', 'Style', LINE_NAMES),
        number('grid.width', 'Width', { min: 0.1, max: 5, step: 0.1, unit: 'pt' })
      )),
    group('frame', 'Frame',
      checks(check('spines.top', 'Top'), check('spines.right', 'Right')),
      grid(number('spines.width', 'Line width', { min: 0, max: 5, step: 0.1, unit: 'pt' })),
      el('p', { class: 'stk-hint fp-hint', text: 'The left and bottom lines are always drawn.' })),
    group('export', 'Export',
      grid(
        segmented('export.format', 'Format', [['pdf', 'PDF'], ['png', 'PNG'], ['svg', 'SVG']]),
        text('export.filename', 'File name', { mono: true }),
        number('dpi', 'Resolution', { min: 50, max: 1200, step: 1, unit: 'dpi', span: true })
      ),
      checks(
        check('export.transparent', 'Transparent background'),
        check('export.tight', 'Fit the page to the drawing', { hint: 'Trims the page to what is drawn plus 0.1 in, as bbox_inches=\'tight\' does, so the saved size is a little larger or smaller than the width and height set above.' })
      ))
  );

  presetButtons.forEach((b) => listen(b, 'click', () => {
    draft = normalisePlotStyle(deepMerge(draft, STYLE_PRESETS[b.dataset.preset]));
    emit();
  }));
  listen(resetButton, 'click', () => {
    draft = defaultPlotStyle();
    touched = {};
    applyContextLabels(true);
    emit();
  });

  let touched = {};
  function contextLabels() {
    const dep = ctx.dependent || 'y';
    const math = (n) => `$${symbolToLatex(String(n)) || n}$`;
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

  function summaryText() {
    const s = draft;
    const on = (b) => (b ? 'On' : 'Off');
    const marker = (MARKER_NAMES.find(([v]) => v === s.data.marker) || [])[1] || '';
    return {
      figure: `${fmtNum(s.width)} × ${fmtNum(s.height)} in, ${fmtNum(s.fontSize)} pt`,
      text: s.title ? 'Title set' : '',
      axes: `${s.xScale === 'log' ? 'Log' : 'Linear'} × ${s.yScale === 'log' ? 'log' : 'linear'}`,
      data: s.data.show ? `${marker}, ${fmtNum(s.data.size)} pt` : 'Hidden',
      fit: s.fit.show ? (LINE_NAMES.find(([v]) => v === s.fit.style) || [])[1] : 'Hidden',
      band: ctx.multivariate ? 'None' : on(s.band.show),
      residuals: on(s.residuals.show),
      legend: s.legend.show ? (LEGEND_NAMES.find(([v]) => v === s.legend.position) || [])[1] : 'Hidden',
      grid: on(s.grid.show),
      frame: s.spines.top && s.spines.right ? 'Box' : s.spines.top || s.spines.right ? 'Three sides' : 'Two sides',
      export: `${s.export.format.toUpperCase()}${s.export.format === 'png' ? `, ${s.dpi} dpi` : ''}`
    };
  }

  const visible = (sel, on) => root.querySelectorAll(sel).forEach((n) => { n.hidden = !on; });
  function refresh() {
    controls.forEach((c) => c.show());
    for (const k of ['x', 'y']) {
      const T = draft[`${k}Ticks`];
      visible(`[data-path="${k}Ticks.step"]`, T.mode === 'step');
      visible(`[data-path="${k}Ticks.count"]`, T.mode === 'count');
      visible(`[data-path="${k}Ticks.values"], [data-path="${k}Ticks.labels"]`, T.mode === 'list');
    }
    axisPanels.forEach((p) => { p.hidden = p.dataset.axis !== axisShown; });
    axisTabs.querySelectorAll('button').forEach((b) => {
      const sel = b.dataset.axis === axisShown;
      b.setAttribute('aria-selected', String(sel));
      b.tabIndex = sel ? 0 : -1;
    });
    visible('.fp-errorbars', ctx.hasSigma !== false);
    sigmaNote.hidden = ctx.hasSigma !== false;
    visible('.fp-band', !ctx.multivariate);
    bandNote.hidden = !ctx.multivariate;
    visible('[data-path="dpi"]', draft.export.format === 'png');
    const sums = summaryText();
    for (const [k, node] of Object.entries(summaries)) node.textContent = sums[k] || '';
  }

  host.appendChild(root);
  if (options.context) {
    ctx = { ...ctx, ...options.context };
    applyContextLabels(false);
  }
  refresh();

  return {
    element: root,
    get: () => clone(normalisePlotStyle(draft)),
    set(next) {
      draft = normalisePlotStyle(next);
      refresh();
    },
    setContext(next = {}) {
      ctx = { ...ctx, ...next };
      const changed = applyContextLabels(false);
      refresh();
      if (changed) emit();
    },
    destroy() {
      timers.forEach((t) => clearTimeout(t));
      timers.clear();
      cleanups.forEach((f) => f());
      root.remove();
    }
  };
}
