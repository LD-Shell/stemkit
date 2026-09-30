/**
 * Figure plot: the live preview of any figure a page describes, the panel
 * that styles it, its export, and the plot area every page shares.
 *
 * One description (src/core/figure.js) drives both this preview and the
 * matplotlib script the page writes (src/core/figure-python.js), so the
 * preview draws what matplotlib will draw. The decisions matplotlib makes on
 * its own are made here the same way:
 *
 *   - axis ranges: the data limits of everything drawn, plus matplotlib's 5%
 *     margins (in log units on a log axis), held at the sticky edges bars,
 *     histograms, images, contours and box plots set, then the user's limits;
 *   - tick positions: AutoLocator, MaxNLocator, MultipleLocator, LogLocator,
 *     FixedLocator, AutoMinorLocator and the minor LogLocator, ported line by
 *     line from matplotlib 3.6, including the number of ticks that fits the
 *     axis length;
 *   - tick labels: ScalarFormatter (significant digits, offset and ×10ⁿ),
 *     LogFormatterSciNotation, FormatStrFormatter (Python % formatting) and
 *     FixedFormatter;
 *   - layout: constrained layout's pads around the drawing, the axis label,
 *     tick label and title pads, the panels at their height ratios, and the
 *     colour bars placed and sized as Figure.colorbar and constrained layout
 *     place them (5% of the panel's width away, 1/20 as wide as tall);
 *   - contour levels (MaxNLocator over the data, trimmed as ContourSet does),
 *     colormap lookups value for value, box-plot statistics, histogram bins;
 *   - the "best" legend position, by matplotlib's own overlap count.
 *
 * The figure is drawn at its true size, 96 px per inch, and scaled with a
 * CSS transform to fit the page, so the preview is the exported figure in
 * miniature; with export.tight on it is the tight page the script saves.
 *
 * Plotly only paints. Its axes are invisible and serve to place the traces;
 * spines, tick marks, grid lines and colour bars are drawn as shapes, and
 * every piece of text as an annotation placed by its baseline, so each lands
 * where matplotlib puts it (tick directions in, out and across included).
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
 *   buildFigure(figure, options) -> { data, layout, info }   (no DOM needed)
 *   renderFigure(el, figure, options) -> Promise<info>
 *   destroyFigure(el)
 *   exportFigure(figure, options) -> Promise<{ filename, format, bytes, widthIn, heightIn, … }>
 *   createFigureStylePanel(host, figure, style, onChange, options) -> { get, set, setFigure, destroy, element }
 *   mountFigure(host, options) -> { update, setStyle, getStyle, export, openStyle({ series }), closeStyle,
 *                                   setToggle, info, figure, script, destroy, element }
 *   stylePanelKit(bind), for panels of a page's own (the Curve Fitter's)
 *   and the ports (axisTicks, the locators and formatters, pyPercent,
 *   textToHtml) for tests and for js/fit-plot.js
 */

import { pdfFromSvg, pdfFromJpeg } from '../src/core/pdf.js';
import { EXPORT_FORMATS, textSizes } from '../src/core/plot-style.js';
import {
  normaliseFigure, applyStyle, cleanStyle, lookOnly, colormapColors, colormapIndex, jitterOffsets, COLORMAPS, LOOK_KEYS,
  COLOR_CYCLE, COLOR_CYCLE_DARK, unitsPerInch, formatSize
} from '../src/core/figure.js';
import { figureScript, pyStr } from '../src/core/figure-python.js';

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
    handletextpad: 0.8, borderaxespad: 0.5, framealpha: 0.8, edgecolor: '#cccccc', columnspacing: 2
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
/* mathtext puts a fifth of an 'm' (about a sixth of an em, U+2006) either
   side of binary operators, relations and arrows; a binary operator at the
   start, or after '{' or an opening bracket, stays unspaced (a sign). */
const BINARY = new Set(['pm', 'mp', 'times', 'div', 'cdot', 'ast', 'star', 'circ', 'cup', 'cap', 'wedge', 'vee', 'dagger']);
const RELATIONS = new Set(['leq', 'le', 'geq', 'ge', 'neq', 'ne', 'approx', 'sim', 'simeq', 'equiv', 'propto', 'll', 'gg', 'perp',
  'parallel', 'in', 'notin', 'subset', 'supset', 'rightarrow', 'to', 'leftarrow', 'leftrightarrow', 'Rightarrow', 'uparrow', 'downarrow']);
const MATH_SPACE = '\u2006';

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

  // A binary operator or relation with mathtext's spacing, unless it is a
  // sign: the first thing in the maths, or after '{' or an opening bracket.
  const spaced = (html, start, binary) => {
    const before = s.slice(0, start).replace(/\s+$/, '');
    if (binary && (before === '' || /(?:[{([<]|\\\{|\\langle|\\lfloor|\\lceil)$/.test(before))) return html;
    return html ? MATH_SPACE + html + MATH_SPACE : html;
  };

  // Reads one "atom" (a group or a single token) and returns HTML.
  const atom = (style) => {
    skipSpace();
    if (i >= s.length) return '';
    const start = i;
    const c = peek();
    if (c === '{') {
      i++;
      const html = seq(style, '}');
      if (s[i] === '}') i++;
      return html;
    }
    if (c === '\\') return command(readCommand(), style, start);
    i++;
    return glyph(c, style, start);
  };

  const wrapStyle = (text, style) => {
    if (!text) return '';
    let t = text;
    if (style.italic) t = `<i>${t}</i>`;
    if (style.bold) t = `<b>${t}</b>`;
    return t;
  };

  const glyph = (c, style, start) => {
    if (/[a-zA-Z]/.test(c)) return wrapStyle(escapeHtml(c), { ...style, italic: style.font === 'it' });
    if (c === '-') return spaced(wrapStyle('−', { ...style, italic: false }), start, true);
    if (c === '+') return spaced(wrapStyle('+', { ...style, italic: false }), start, true);
    if (c === '*') return spaced(wrapStyle('∗', { ...style, italic: false }), start, true);
    if (c === '=' || c === '<' || c === '>' || c === ':') return spaced(wrapStyle(escapeHtml(c), { ...style, italic: false }), start, false);
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

  const command = (name, style, start) => {
    if (Object.hasOwn(GREEK, name)) return wrapStyle(GREEK[name], { ...style, italic: style.font === 'it' });
    if (Object.hasOwn(GREEK_UPPER, name)) return wrapStyle(GREEK_UPPER[name], { ...style, italic: false });
    if (Object.hasOwn(SYMBOLS, name)) {
      const html = wrapStyle(escapeHtml(SYMBOLS[name]), { ...style, italic: false });
      return BINARY.has(name) || RELATIONS.has(name) ? spaced(html, start, BINARY.has(name)) : html;
    }
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
    return s === 1 ? exp : `${significand}${MATH_SPACE}×${MATH_SPACE}${exp}`;
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
      return `${sign}${fixMinus(pyPercent('%g', c))}${MATH_SPACE}×${MATH_SPACE}10<sup>${fixMinus(String(Math.floor(fx)))}</sup>`;
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

/*
 * The data limits of a log axis, as autoscale_view and LogLocator.nonsingular
 * make them: the smallest and largest value of every panel sharing the axis
 * (zero and below included), then, if the smallest is not positive, the
 * smallest positive value of the axes that owns the locator (`own`, the top
 * panel), not of all the panels.
 */
function logDataLimits(arrays, own) {
  const all = dataLimits(arrays, false);
  if (!all || !(all[1] > 0)) return null;
  let [lo] = all;
  if (!(lo > 0)) {
    const mine = dataLimits(own, true);
    lo = mine ? mine[0] : 1e-300;
  }
  return lo <= all[1] ? [lo, all[1]] : dataLimits(arrays, true);
}

/*
 * The autoscaled interval: nonsingular, then 5% margins (in log units on a
 * log axis), held back at any sticky edge the margin would cross. Bars stop
 * at their base, images and contours at their edges, box plots half a place
 * beyond the outer boxes.
 */
function autoscale(lim, log, stickies = []) {
  if (!lim) return log ? [1, 10] : [0, 1];
  let [a, b] = lim;
  if (log) {
    if (a === b) {
      a = 10 ** Math.ceil(Math.log10(a) - 1);
      b = 10 ** Math.floor(Math.log10(b) + 1);
      if (a >= lim[0]) a /= 10;
      if (b <= lim[1]) b *= 10;
    }
  } else {
    [a, b] = nonsingular(a, b, 0.05);
  }
  const st = stickies.filter((v) => Number.isFinite(v) && (!log || v > 0)).sort((p, q) => p - q);
  let lowStop = null; let highStop = null;
  if (st.length) {
    const tol = 1e-5 * Math.max(Math.abs(a), Math.abs(b), Math.abs(b - a));
    for (const v of st) if (v < a + tol) lowStop = v;
    for (let i = st.length - 1; i >= 0; i--) if (st[i] > b - tol) highStop = st[i];
  }
  let lo; let hi;
  if (log) {
    const la = Math.log10(a); const lb = Math.log10(b);
    const d = (lb - la) * RC.margin;
    lo = 10 ** (la - d); hi = 10 ** (lb + d);
  } else {
    const d = (b - a) * RC.margin;
    lo = a - d; hi = b + d;
  }
  if (lowStop !== null) lo = Math.max(lo, lowStop);
  if (highStop !== null) hi = Math.min(hi, highStop);
  return [lo, hi];
}

/* The view: the autoscaled interval with the user's limits put in. */
function viewLimits(lim, userLim, log, stickies) {
  const auto = autoscale(lim, log, stickies);
  const use = (v) => v !== null && v !== undefined && Number.isFinite(v) && !(log && v <= 0);
  let a = use(userLim[0]) ? userLim[0] : auto[0];
  let b = use(userLim[1]) ? userLim[1] : auto[1];
  if (a === b) {
    if (log) { a /= 10; b *= 10; } else [a, b] = nonsingular(a, b, 0.05);
  }
  return [a, b];
}

/* ------------------------------------------------------------------ *
 * What each kind of series puts on the axes
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
const finite = (a) => a.filter(Number.isFinite);
const minOf = (a, start = Infinity) => { let m = start; for (const v of a) if (v < m) m = v; return m; };
const maxOf = (a, start = -Infinity) => { let m = start; for (const v of a) if (v > m) m = v; return m; };
/* push(...items) for arrays of any length. */
const append = (target, items) => { for (const v of items) target.push(v); return target; };

/* Cell edges from centres, as pcolormesh's 'nearest' shading makes them. */
function cellEdges(c) {
  const n = c.length;
  if (n === 0) return [];
  if (n === 1) return [c[0] - 0.5, c[0] + 0.5];
  const out = new Array(n + 1);
  out[0] = c[0] - (c[1] - c[0]) / 2;
  for (let i = 1; i < n; i++) out[i] = c[i - 1] + (c[i] - c[i - 1]) / 2;
  out[n] = c[n - 1] + (c[n - 1] - c[n - 2]) / 2;
  return out;
}

/* The finite range of a z grid. */
function gridRange(z) {
  let lo = Infinity; let hi = -Infinity;
  for (const row of z) for (const v of row) { if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; } }
  return lo <= hi ? [lo, hi] : null;
}

/*
 * matplotlib's contour levels: MaxNLocator(N + 1, min_n_ticks=1) over the
 * data, trimmed to one level beyond the data each side (ContourSet._autolev);
 * the colours come from the levels (lines) or the middles of the bands
 * (filled), on a scale from the lowest level to the highest unless vmin and
 * vmax are set.
 */
function contourLevels(s) {
  const r = gridRange(s.z);
  if (!r) return null;
  const [zmin, zmax] = r;
  let levels;
  if (Array.isArray(s.levels)) {
    levels = s.levels.slice();
  } else {
    const lev = maxNLocator(zmin, zmax, s.levels + 1, MAXN_STEPS, 1);
    let i0 = 0; let i1 = lev.length;
    const under = []; lev.forEach((v, i) => { if (v < zmin) under.push(i); });
    if (under.length) i0 = under[under.length - 1];
    const over = lev.findIndex((v) => v > zmax);
    if (over >= 0) i1 = over + 1;
    if (i1 - i0 < 3) { i0 = 0; i1 = lev.length; }
    levels = lev.slice(i0, i1);
  }
  if (!s.filled && !levels.some((v) => v > zmin && v < zmax)) levels = [zmin];
  if (s.filled && levels.length < 2) return null;
  const values = s.filled ? levels.slice(0, -1).map((v, i) => 0.5 * (v + levels[i + 1])) : levels.slice();
  const vmin = s.vmin ?? Math.min(...levels);
  const vmax = s.vmax ?? Math.max(...levels);
  return { levels, values, vmin, vmax, zmin, zmax };
}

/* The colour scale of a heatmap: the data's range unless set. */
function heatmapRange(s) {
  const r = gridRange(s.z) || [0, 1];
  return [s.vmin ?? r[0], s.vmax ?? r[1]];
}

/*
 * The data limits and sticky edges a series adds, as its matplotlib artist
 * does: `x` and `y` are lists of arrays, `sx` and `sy` sticky values.
 */
function seriesExtent(s) {
  const e = { x: [], y: [], sx: [], sy: [] };
  if (!s.show) return e;
  switch (s.kind) {
    case 'line': case 'scatter':
      e.x.push(s.x); e.y.push(s.y);
      break;
    case 'errorbar': {
      const drawn = s.marker !== 'none' || s.lineStyle !== 'none';
      if (drawn || (!s.yerr && !s.xerr)) { e.x.push(s.x); e.y.push(s.y); }
      if (s.yerr) {
        e.x.push(s.x);
        e.y.push(s.y.map((v, i) => v - (s.yerr[0][i] ?? NaN)), s.y.map((v, i) => v + (s.yerr[1][i] ?? NaN)));
      }
      if (s.xerr) {
        e.y.push(s.y);
        e.x.push(s.x.map((v, i) => v - (s.xerr[0][i] ?? NaN)), s.x.map((v, i) => v + (s.xerr[1][i] ?? NaN)));
      }
      break;
    }
    case 'band':
      e.x.push(s.x); e.y.push(s.lower, s.upper);
      break;
    case 'bar': {
      const half = s.barWidth / 2;
      e.x.push(s.x.map((v) => v + s.offset - half), s.x.map((v) => v + s.offset + half));
      e.y.push(s.y.map(() => s.bottom), s.y.map((v) => v + s.bottom));
      if (s.yerr) e.y.push(s.y.map((v, i) => v + s.bottom - (s.yerr[0][i] ?? NaN)), s.y.map((v, i) => v + s.bottom + (s.yerr[1][i] ?? NaN)));
      e.sy.push(s.bottom);
      break;
    }
    case 'histogram':
      if (s.edges.length > 1) {
        e.x.push(s.edges); e.y.push([0], s.counts);
        e.sy.push(0);
      }
      break;
    case 'box': {
      const cw = s.width / 2;
      for (const g of s.groups) {
        if (!g.stats) continue;
        const p = g.position; const st = g.stats;
        e.x.push([p - cw / 2, p + cw / 2, p - s.width / 2, p + s.width / 2]);
        e.y.push([st.whislo, st.whishi, st.q1, st.q3]);
        if (s.fliers) e.y.push(st.fliers);
        if (s.points) { e.x.push(jitterOffsets(g.values.length, s.jitter * s.width).map((o) => p + o)); e.y.push(g.values); }
        if (s.mean) { e.x.push([p + s.meanOffset]); e.y.push([st.mean, st.ciLow, st.ciHigh]); }
      }
      if (s.managed) {
        const ps = s.groups.filter((g) => g.stats).map((g) => g.position);
        if (ps.length) {
          e.x.push([Math.min(...ps) - 0.5, Math.max(...ps) + 0.5]);
          ps.forEach((p) => e.sx.push(p - 0.5, p + 0.5));
        }
      }
      break;
    }
    case 'heatmap': {
      const ex = cellEdges(finite(s.x)); const ey = cellEdges(finite(s.y));
      if (ex.length && ey.length) {
        e.x.push(ex); e.y.push(ey);
        e.sx.push(minOf(ex), maxOf(ex)); e.sy.push(minOf(ey), maxOf(ey));
      }
      break;
    }
    case 'contour': {
      const fx = finite(s.x); const fy = finite(s.y);
      if (fx.length && fy.length) {
        e.x.push([minOf(fx), maxOf(fx)]); e.y.push([minOf(fy), maxOf(fy)]);
        e.sx.push(minOf(fx), maxOf(fx)); e.sy.push(minOf(fy), maxOf(fy));
      }
      break;
    }
    case 'hline': e.y.push([s.y]); break;
    case 'vline': e.x.push([s.x]); break;
    case 'axline': e.x.push(s.points.map((p) => p[0])); e.y.push(s.points.map((p) => p[1])); break;
    case 'bracket': e.x.push([s.x1, s.x2]); e.y.push([s.y, s.y + s.height]); break;
    default: break;
  }
  return e;
}

/* ------------------------------------------------------------------ *
 * The scene: what is drawn and where, in figure pixels (y down)
 * ------------------------------------------------------------------ */

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

/* The ticks of the shared x axis: the categories, when there are any. */
function xTickSpec(s) {
  if (!s.xCategories) return s.xTicks;
  return { ...s.xTicks, mode: 'list', values: s.xCategories.map((_, i) => i), labels: s.xCategories.slice(), minor: false, format: '' };
}

/*
 * One panel dressed for a trial position `box`: its ticks for that size, and
 * the tick labels, offset texts, axis labels and title where matplotlib puts
 * them, with the spines' boxes (tick marks included) that constrained layout
 * and the tight bounding box count.
 */
function dressAxes(P, pn, box) {
  const { family } = P;
  const aw = box.r - box.l;
  const ah = box.b - box.t;
  const xv = P.xView;
  const yv = pn.yView;
  const ylog = pn.yLog;
  const x0 = tscale(P.xLog, xv[0]); const xs = aw / (tscale(P.xLog, xv[1]) - x0);
  const y0 = tscale(ylog, yv[0]); const ys = ah / (tscale(ylog, yv[1]) - y0);
  const X = (v) => box.l + (tscale(P.xLog, v) - x0) * xs;
  const Y = (v) => box.b - (tscale(ylog, v) - y0) * ys;
  const tickPt = P.tickPt;
  // Axis.get_tick_space: the axis length over 3 (x) or 2 (y) label heights.
  const xt = axisTicks({ view: xv, log: P.xLog, ticks: P.xTicks, tickSpace: Math.floor(aw / PX_PER_PT / (3 * tickPt)), minorLocated: P.xMinor });
  const yt = axisTicks({ view: yv, log: ylog, ticks: pn.yTicks, tickSpace: Math.floor(ah / PX_PER_PT / (2 * tickPt)), minorLocated: pn.yMinor });
  const mx = P.xMarks; const my = pn.yMarks;
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
  if (pn.bottom) {
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
  if (P.s.spines.top) spines.push(P.xTicks.mirror ? { l: box.l, r: box.r, t: box.t - outX, b: box.t + outX } : { l: box.l, r: box.r, t: box.t, b: box.t });
  if (P.s.spines.right) spines.push(pn.yTicks.mirror ? { l: box.r - inY, r: box.r + outY, t: box.t, b: box.b } : { l: box.r, r: box.r, t: box.t, b: box.b });

  if (pn.bottom && xt.offset) {
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
  if (pn.bottom && P.xLabel) {
    const m = measure(P.xLabel, P.labelPx, P.math.xLabel);
    const top = Math.max(box.b + outX, ...xLabels.map((i) => i.box.b)) + px(RC.labelpad);
    const it = placeText(P.xLabel, P.labelPx, family, { x: (box.l + box.r) / 2, y: top + m.ascent, ha: 'center' }, pad(P.math.xLabel));
    it.lbox = { ...it.box, l: it.x - 0.5, r: it.x + 0.5 };
    items.push(it);
  }
  if (pn.yLabel) {
    const m = measure(pn.yLabel, P.labelPx, pn.yMath);
    const right = Math.min(box.l - outY, ...yLabels.map((i) => i.box.l)) - px(RC.labelpad);
    const it = placeText(pn.yLabel, P.labelPx, family, { x: right - m.descent, y: (box.t + box.b) / 2, ha: 'center', rot: 90 }, pad(pn.yMath));
    it.lbox = { ...it.box, t: it.y - 0.5, b: it.y + 0.5 };
    items.push(it);
  }
  if (pn.top && P.title) {
    let it = placeText(P.title, P.titlePx, family, { x: (box.l + box.r) / 2, y: box.t - px(RC.titlepad), ha: 'center' }, pad(P.math.title));
    // The title moves up when it would run into the y offset text.
    if (yOffset && overlaps(yOffset.box, it.box)) {
      it = placeText(P.title, P.titlePx, family, { x: it.x, y: yOffset.box.t - px(RC.titlepad), ha: 'center' }, pad(P.math.title));
    }
    it.lbox = { ...it.box, l: it.x - 0.5, r: it.x + 0.5 };
    items.push(it);
  }
  // Notes placed on the axes (text, and the text of brackets): not clipped,
  // so they count for the layout as matplotlib's do.
  for (const t of pn.texts) {
    const at = t.coords === 'axes'
      ? { x: box.l + t.x * aw, y: box.b - t.y * ah }
      : { x: X(t.x), y: Y(t.y) };
    if (!Number.isFinite(at.x) || !Number.isFinite(at.y)) continue;
    const m = measure(t.html, t.size, t.math);
    let base = at.y;
    if (t.rot) {
      // Rotated a quarter turn: the alignment is along the text's own axes.
      const it = placeText(t.html, t.size, family, { x: at.x, y: at.y, ha: 'center', rot: 90 }, pad(t.math));
      it.note = t;
      items.push(it);
      continue;
    }
    if (t.va === 'top') base = at.y + m.ascent;
    else if (t.va === 'bottom') base = at.y - m.descent;
    else if (t.va === 'center') base = at.y + (m.ascent - m.descent) / 2;
    const it = placeText(t.html, t.size, family, { x: at.x, y: base, ha: t.ha }, pad(t.math));
    it.note = t;
    items.push(it);
  }
  return { pn, box, X, Y, xt, yt, items, spines };
}

/*
 * A colour bar beside its panel: its ticks for that length, the tick labels
 * and the label to its right, as matplotlib's vertical Colorbar has them.
 */
function dressColorbar(P, cb, box) {
  const { family } = P;
  const ah = box.b - box.t;
  const v = cb.view;
  // Where a value sits along the bar: in proportion, or, for the levels of
  // filled contours, each band the same length (matplotlib's uniform spacing).
  const at = cb.fixed ? uniformSpacing(cb.fixed) : (val) => (val - v[0]) / (v[1] - v[0]);
  const Y = (val) => box.b - at(val) * ah;
  const tickPt = P.tickPt;
  const T = { ...cb.ticks, minor: false, mirror: false };
  const tickSpace = Math.floor(ah / PX_PER_PT / (2 * tickPt));
  let yt;
  if (cb.fixed) {
    // FixedLocator(levels, nbins=10): every step-th level, starting where the
    // level nearest zero falls.
    const locs = cb.fixed;
    const step = Math.max(Math.ceil(locs.length / 10), 1);
    let ticks = locs.filter((_, i) => i % step === 0);
    for (let i = 1; i < step; i++) {
      const alt = locs.filter((_, k) => k % step === i);
      if (alt.length && Math.min(...alt.map(Math.abs)) < Math.min(...ticks.map(Math.abs))) ticks = alt;
    }
    yt = axisTicks({ view: v, log: false, ticks: { ...T, mode: 'list', values: ticks, labels: [], format: '' }, tickSpace, minorLocated: false });
    // A FixedLocator keeps the ScalarFormatter: label as scalars.
    const { labels, offset } = scalarFormat(ticks, v);
    yt.major = ticks.map((val, i) => ({ v: val, text: labels[i], math: false })).filter((t) => inView(t.v, v, false));
    yt.offset = offset;
    yt.offsetMath = false;
  } else {
    yt = axisTicks({ view: v, log: false, ticks: { ...T, mode: 'auto', format: '' }, tickSpace, minorLocated: false });
  }
  const mk = tickMarks(T).major;
  const out = yt.major.length ? px(mk.len) * DIR_OUT[mk.dir] : 0;
  const items = [];
  const pad = (math) => (math ? P.mathPad : 0);
  const labels = [];
  for (const t of yt.major) {
    if (!t.text) continue;
    const m = mathTextBox(textBox(t.text, P.tickPx, family), pad(t.math));
    if (!(m.width > 0)) continue;
    const it = placeText(t.text, P.tickPx, family, { x: box.r + px(mk.pad), y: Y(t.v) + m.ascent / 2, ha: 'left' }, pad(t.math));
    items.push(it); labels.push(it);
  }
  if (yt.offset) {
    items.push(placeText(yt.offset, P.tickPx, family, { x: box.r, y: box.t - px(RC.offsetPad), ha: 'right' }, pad(yt.offsetMath)));
  }
  if (cb.label) {
    const m = mathTextBox(textBox(cb.label, P.labelPx, family), pad(cb.math));
    const left = Math.max(box.r + out, ...labels.map((i) => i.box.r)) + px(RC.labelpad);
    const it = placeText(cb.label, P.labelPx, family, { x: left + m.ascent, y: (box.t + box.b) / 2, ha: 'center', rot: 90 }, pad(cb.math));
    it.lbox = { ...it.box, t: it.y - 0.5, b: it.y + 0.5 };
    items.push(it);
  }
  const spines = [{ l: box.l, r: box.r + out, t: box.t, b: box.b }];
  return { cb, box, Y, yt, mk, items, spines };
}

/* Colorbar._forward_boundaries: the boundaries evenly spaced from 0 to 1,
   linear between them. */
function uniformSpacing(b) {
  const n = b.length - 1;
  return (v) => {
    if (!(n > 0)) return 0;
    if (v <= b[0]) return 0;
    if (v >= b[n]) return 1;
    let k = 0;
    while (k < n - 1 && v > b[k + 1]) k++;
    return (k + (v - b[k]) / (b[k + 1] - b[k])) / n;
  };
}

/* The colour bar's box inside the space it is given (pbcb): set_box_aspect(20),
   anchored at the left and centred in height. */
function colorbarBox(l, t, w, h) {
  const bw = Math.min(w, h / 20);
  const bh = Math.min(h, bw * 20);
  const top = t + (h - bh) / 2;
  return { l, r: l + bw, t: top, b: top + bh, space: { l, t, w, h } };
}

/* The initial axes positions of plt.subplots (figure.subplot.* rcParams),
   where constrained layout starts from; a colour bar takes the right fifth
   of its panel, as Figure.colorbar's make_axes does. */
function initialBoxes(P) {
  const { W, H } = P;
  const l = 0.125 * W; const r = 0.9 * W; const top = 0.12 * H; const bottom = 0.89 * H;
  const n = P.panels.length;
  const ratios = P.panels.map((p) => p.ratio);
  const cell = (bottom - top) / (n + 0.2 * (n - 1));
  const norm = (cell * n) / ratios.reduce((a, b) => a + b, 0);
  let y = top;
  const boxes = []; const cbs = [];
  P.panels.forEach((pn, i) => {
    const h = norm * ratios[i];
    const b = { l, r, t: y, b: y + h };
    if (pn.colorbar) {
      const w = r - l;
      boxes.push({ ...b, r: l + 0.8 * w });
      cbs.push(colorbarBox(l + 0.85 * w, y, 0.15 * w, h));
    } else {
      boxes.push(b);
      cbs.push(null);
    }
    y += h + 0.2 * cell;
  });
  return { boxes, cbs };
}

/* The legend box beside the axes for "outside right": its upper left corner
   at (1.02, 1) in axes coordinates. */
function outsideLegend(pn, box) {
  if (!pn.legend || pn.legendPos !== 'outside right') return null;
  const l = box.r + 0.02 * (box.r - box.l);
  return { l, t: box.t, r: l + pn.legend.width, b: box.t + pn.legend.height };
}

/*
 * One pass of constrained layout: the margin each side of each panel needs
 * for its decorations, plus w_pad/h_pad (3 pt) and the colour bars, then the
 * panels that fill what is left at their height ratios. Returns null when the
 * axes would collapse, as matplotlib then leaves them where they were.
 */
function solveLayout(P, dressed, bars, cbPad) {
  const { W, H } = P;
  const pad = px(RC.layoutPad);
  const n = dressed.length;
  // Between the panels: hspace (2% of the figure) shared by the rows, when
  // that is more than h_pad.
  const between = Math.max(pad, (0.02 / 2 / n) * H);
  let L = 0; let R = 0; let RCB = pad;
  const rows = dressed.map((d, i) => {
    const extra = [outsideLegend(d.pn, d.box)];
    const e = union([d.box, ...d.items.map((it) => it.lbox), ...d.spines.filter(solid), ...extra]);
    L = Math.max(L, d.box.l - e.l);
    R = Math.max(R, e.r - d.box.r);
    let top = d.box.t - e.t; let bottom = e.b - d.box.b;
    const cb = bars[i];
    if (cb) {
      const c = union([cb.box, ...cb.items.map((it) => it.lbox), ...cb.spines]);
      RCB = Math.max(RCB, pad + (c.r - c.l) + cbPad);
      // A colour bar taller than its panel's drawing widens the margins.
      top = Math.max(top, d.box.t - c.t);
      bottom = Math.max(bottom, c.b - d.box.b);
    }
    return { top: top + (i === 0 ? pad : between), bottom: bottom + (i === n - 1 ? pad : between) };
  });
  L += pad;
  const avail = H - rows.reduce((a, r) => a + r.top + r.bottom, 0);
  const ratios = P.panels.map((p) => p.ratio);
  if (!(avail > 0) || !(W - L - R - RCB > 0)) return null;
  const unit = avail / ratios.reduce((a, b) => a + b, 0);
  let y = 0;
  const boxes = rows.map((r, i) => {
    y += r.top;
    const t = y;
    y += unit * ratios[i];
    const b = y;
    y += r.bottom;
    return { l: L, r: W - R - RCB, t, b };
  });
  // The colour bars: right of the decorations, by 5% of the panel's width.
  const cbs = boxes.map((b, i) => {
    if (!P.panels[i].colorbar) return null;
    const w = b.r - b.l;
    return colorbarBox(W - RCB + 0.05 * w, b.t, 0.15 * w, b.b - b.t);
  });
  return { boxes, cbs, innerWidth: boxes.length ? boxes[0].r - boxes[0].l : 0 };
}

/* ------------------------------------------------------------------ *
 * Legend
 * ------------------------------------------------------------------ */

/* The legend's entries and its size: Legend._init_legend_box with the rc
   defaults (borderpad 0.4, labelspacing 0.5, handlelength 2, handleheight
   0.7, handletextpad 0.8, columnspacing 2, all in font sizes), in columns
   filled one after another as numpy's array_split fills them, and the title
   above in the figure's font size. */
function legendBox(P, entries, title, ncols) {
  if (!entries.length) return null;
  const fs = P.legendPx;
  const k = RC.legend;
  const rows = entries.map((e) => {
    const m = mathTextBox(textBox(e.html, fs, P.family), e.math ? P.mathPad : 0);
    // HPacker(align='baseline') of the handle box (0.7 fs tall, standing on
    // the baseline) and the text.
    return { ...e, m, up: Math.max(k.handleheight * fs, m.ascent), down: Math.max(0, m.descent) };
  });
  const nc = Math.max(1, Math.min(ncols || 1, rows.length));
  const cols = [];
  const base = Math.floor(rows.length / nc); const extra = rows.length % nc;
  let at = 0;
  for (let c = 0; c < nc; c++) {
    const size = base + (c < extra ? 1 : 0);
    cols.push(rows.slice(at, at + size));
    at += size;
  }
  const colW = cols.map((col) => k.handlelength * fs + k.handletextpad * fs + Math.max(...col.map((r) => r.m.width)));
  const colH = cols.map((col) => col.reduce((a, r) => a + r.up + r.down, 0) + (col.length - 1) * k.labelspacing * fs);
  const entriesWidth = colW.reduce((a, b) => a + b, 0) + (nc - 1) * k.columnspacing * fs;
  let width = entriesWidth;
  let height = Math.max(...colH);
  let head = null;
  if (title) {
    const m = mathTextBox(textBox(title.html, P.labelPx, P.family), title.math ? P.mathPad : 0);
    head = { ...title, m };
    width = Math.max(width, m.width);
    height += m.ascent + m.descent + k.labelspacing * fs;
  }
  return { rows, cols, colW, head, entriesWidth, width: width + 2 * k.borderpad * fs, height: height + 2 * k.borderpad * fs };
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
   fewest line vertices inside, lines crossing it and patches under it. */
function bestLegend(lg, box, fs, { lines, boxes }) {
  let best = null;
  const tried = [];
  // On dense data hundreds of points sit on the legend's edge, and a pixel of
  // font metrics tips the count: past 20 000 points a location within 0.2%
  // of the fewest counts as a tie, and the first in matplotlib's order wins.
  let vertices = 0;
  for (const { xs } of lines) vertices += xs.length;
  const margin = vertices > 20000 ? 0.002 * vertices : 0;
  for (const loc of LEGEND_TRIALS) {
    const b = anchoredLegend(loc, lg, box, fs);
    let badness = 0;
    for (const { xs, ys } of lines) {
      for (let i = 0; i < xs.length; i++) {
        if (b.l < xs[i] && xs[i] < b.r && b.t < ys[i] && ys[i] < b.b) badness++;
      }
      if (pathHitsBox(xs, ys, b)) badness++;
    }
    for (const r of boxes) {
      if (!(r.r <= b.l || r.l >= b.r || r.b <= b.t || r.t >= b.b)) badness++;
    }
    if (badness === 0) return { loc, box: b };
    tried.push({ loc, box: b, badness });
    if (!best || badness < best.badness) best = { loc, box: b, badness };
  }
  if (margin > 0) return tried.find((t) => t.badness <= best.badness + margin) || best;
  return best;
}

/*
 * The lines and patches of a panel as the "best" legend weighs them
 * (Legend._auto_legend_data): every Line2D's vertices and path, and the box
 * of every Rectangle and Patch. Collections (bands, images, contours) count
 * only by an offset matplotlib puts at the figure's corner, so not at all.
 */
function legendObstacles(d, series) {
  const lines = []; const boxes = [];
  const line = (xs, ys) => lines.push({ xs: xs.map(d.X), ys: ys.map(d.Y) });
  const rect = (x0, x1, y0, y1) => {
    const a = d.X(x0); const b = d.X(x1); const c = d.Y(y0); const e = d.Y(y1);
    boxes.push({ l: Math.min(a, b), r: Math.max(a, b), t: Math.min(c, e), b: Math.max(c, e) });
  };
  const box = d.box;
  for (const s of series) {
    if (!s.show) continue;
    switch (s.kind) {
      case 'line': case 'scatter': line(s.x, s.y); break;
      case 'errorbar':
        if (s.marker !== 'none' || s.lineStyle !== 'none') line(s.x, s.y);
        if (s.capSize > 0 && s.yerr) {
          line(s.x, s.y.map((v, i) => v - s.yerr[0][i]));
          line(s.x, s.y.map((v, i) => v + s.yerr[1][i]));
        }
        if (s.capSize > 0 && s.xerr) {
          line(s.x.map((v, i) => v - s.xerr[0][i]), s.y);
          line(s.x.map((v, i) => v + s.xerr[1][i]), s.y);
        }
        break;
      case 'bar': {
        const h = s.barWidth / 2;
        s.x.forEach((x, i) => { if (Number.isFinite(x) && Number.isFinite(s.y[i])) rect(x + s.offset - h, x + s.offset + h, s.bottom, s.bottom + s.y[i]); });
        if (s.yerr && s.capSize > 0) {
          const xs = s.x.map((v) => v + s.offset);
          line(xs, s.y.map((v, i) => v + s.bottom - s.yerr[0][i]));
          line(xs, s.y.map((v, i) => v + s.bottom + s.yerr[1][i]));
        }
        break;
      }
      case 'histogram':
        if (s.edges.length > 1) {
          if (s.histtype === 'bar') s.counts.forEach((c, i) => rect(s.edges[i], s.edges[i + 1], 0, c));
          else rect(s.edges[0], s.edges[s.edges.length - 1], minOf(s.counts, 0), maxOf(s.counts, 0));
        }
        break;
      case 'box':
        for (const g of s.groups) {
          if (!g.stats) continue;
          const p = g.position; const st = g.stats; const w = s.width / 2; const cw = s.width / 4;
          line([p, p], [st.q1, st.whislo]); line([p, p], [st.q3, st.whishi]);
          line([p - cw, p + cw], [st.whislo, st.whislo]); line([p - cw, p + cw], [st.whishi, st.whishi]);
          rect(p - w, p + w, st.q1, st.q3);
          line([p - w, p + w], [st.med, st.med]);
          if (s.fliers) line(st.fliers.map(() => p), st.fliers);
          if (s.points) line(jitterOffsets(g.values.length, s.jitter * s.width).map((o) => p + o), g.values);
          if (s.mean) line([p + s.meanOffset], [st.mean]);
        }
        break;
      case 'hline': { const y = d.Y(s.y); lines.push({ xs: [box.l, box.r], ys: [y, y] }); break; }
      case 'vline': { const x = d.X(s.x); lines.push({ xs: [x, x], ys: [box.b, box.t] }); break; }
      case 'axline': { const seg = axlineSegment(s, d); if (seg) lines.push({ xs: [d.X(seg[0][0]), d.X(seg[1][0])], ys: [d.Y(seg[0][1]), d.Y(seg[1][1])] }); break; }
      case 'bracket': line([s.x1, s.x1, s.x2, s.x2], [s.y, s.y + s.height, s.y + s.height, s.y]); break;
      default: break;
    }
  }
  return { lines, boxes };
}

/* Where an axline meets the edges of the view, in data units: straight in
   scale units (log units on a log axis), as matplotlib's _AxLine draws it. */
function axlineSegment(s, d) {
  const xl = d.pn.P.xLog; const yl = d.pn.yLog;
  const f = (log, v) => (log ? Math.log10(v) : v);
  const g = (log, v) => (log ? 10 ** v : v);
  const [a, b] = s.points;
  if (!a.every(Number.isFinite)) return null;
  const x0 = f(xl, a[0]); const y0 = f(yl, a[1]);
  let slope;
  if (b) {
    const x1 = f(xl, b[0]); const y1 = f(yl, b[1]);
    if (x1 === x0 && y1 === y0) return null;
    if (x1 === x0) {
      const v = d.pn.yView;
      return [[a[0], v[0]], [a[0], v[1]]];
    }
    slope = (y1 - y0) / (x1 - x0);
  } else {
    slope = s.slope;
    if (!Number.isFinite(slope)) return null;
  }
  const xv = d.pn.P.xView.map((v) => f(xl, v));
  const yv = d.pn.yView.map((v) => f(yl, v));
  // The line across the whole view, then clipped to it (as the axes clip it).
  const pts = [];
  for (const X of xv) { const Y = y0 + slope * (X - x0); if (Y >= Math.min(...yv) - 1e-12 && Y <= Math.max(...yv) + 1e-12) pts.push([X, Y]); }
  if (slope !== 0) for (const Y of yv) { const X = x0 + (Y - y0) / slope; if (X > Math.min(...xv) && X < Math.max(...xv)) pts.push([X, Y]); }
  if (pts.length < 2) return null;
  pts.sort((p, q) => p[0] - q[0]);
  return [[g(xl, pts[0][0]), g(yl, pts[0][1])], [g(xl, pts[pts.length - 1][0]), g(yl, pts[pts.length - 1][1])]];
}

/* ------------------------------------------------------------------ *
 * Drawing helpers
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

/* A stepped Plotly colorscale that gives band k exactly colour k. */
function steppedScale(colours) {
  const n = colours.length;
  const out = [];
  colours.forEach((c, k) => {
    out.push([k / n, c]);
    out.push([k === n - 1 ? 1 : (k + 1) / n - 1e-9, c]);
  });
  return out;
}

/*
 * Markers past a few thousand: each drawn once per pixel of the render
 * target (`scale` device px per figure px), which draws the same picture;
 * the script keeps every point. A marker lands in the pixel its centre falls
 * in; one of the same series already there hides it. Error bars take part in
 * the match, so a marker is dropped only where its bars fall on the same
 * pixels too. Markers off the axes by more than their size are never seen.
 * With a `budget` (the preview's), a cloud too dense for it is matched on a
 * coarser grid instead, a cell of a few device pixels; exports have none.
 * Returns the indices to draw, or null to draw them all.
 */
export function thinMarkers(xs, ys, d, { scale = 2, sizePt = 6, errors = null, threshold = 4000, budget = Infinity } = {}) {
  const n = Math.min(xs.length, ys.length);
  if (n <= threshold) return null;
  let keep = markersOnce(xs, ys, d, scale, sizePt, errors, n);
  // Past the budget (the preview's), the grid coarsens until the markers fit:
  // centres move by at most a cell, in a cloud already solid with markers.
  for (let sc = scale, k = 0; keep.length > budget && k < 6; k++) {
    sc /= Math.max(1.1, Math.sqrt(keep.length / budget));
    keep = markersOnce(xs, ys, d, sc, sizePt, errors, n);
  }
  return keep;
}

function markersOnce(xs, ys, d, scale, sizePt, errors, n) {
  const box = d.box;
  const m = Math.ceil(px(sizePt) * scale) + 1;
  const gw = Math.ceil((box.r - box.l) * scale) + 2 * m + 1;
  const gh = Math.ceil((box.b - box.t) * scale) + 2 * m + 1;
  const grid = errors ? null : new Uint8Array(gw * gh);
  const seen = errors ? new Set() : null;
  const keep = [];
  const q = (v) => Math.floor(v * scale);
  for (let i = 0; i < n; i++) {
    const X = d.X(xs[i]); const Y = d.Y(ys[i]);
    if (!Number.isFinite(X) || !Number.isFinite(Y)) continue;
    const cx = Math.floor((X - box.l) * scale) + m; const cy = Math.floor((Y - box.t) * scale) + m;
    if (errors) {
      // The bars' lengths in device pixels (a bar is drawn from the marker's centre).
      let key = `${cx},${cy}`;
      if (errors.y) key += `,${q(Y - d.Y(ys[i] + errors.y[1][i]))},${q(d.Y(ys[i] - errors.y[0][i]) - Y)}`;
      if (errors.x) key += `,${q(X - d.X(xs[i] - errors.x[0][i]))},${q(d.X(xs[i] + errors.x[1][i]) - X)}`;
      if (seen.has(key)) continue;
      seen.add(key);
    } else {
      if (cx < 0 || cy < 0 || cx >= gw || cy >= gh) continue;
      const c = cy * gw + cx;
      if (grid[c]) continue;
      grid[c] = 1;
    }
    keep.push(i);
  }
  return keep;
}

/*
 * Lines longer than the preview can show point by point are cut to the
 * lowest and highest value in each pixel column, which draws the same line;
 * the script keeps every point.
 */
function thinLine(x, y, widthPx, view, log) {
  const n = Math.min(x.length, y.length);
  if (n <= 4 * widthPx || n < 4000) return { x, y };
  const x0 = tscale(log, view[0]); const k = widthPx / (tscale(log, view[1]) - x0);
  const ox = []; const oy = [];
  let col = null; let lo = -1; let hi = -1; let first = -1; let last = -1;
  const flush = () => {
    if (first < 0) return;
    const idx = [...new Set([first, lo, hi, last])].sort((a, b) => a - b);
    idx.forEach((i) => { ox.push(x[i]); oy.push(y[i]); });
  };
  for (let i = 0; i < n; i++) {
    const xi = x[i]; const yi = y[i];
    if (!Number.isFinite(xi) || !Number.isFinite(yi)) { flush(); ox.push(null); oy.push(null); first = -1; col = null; continue; }
    const c = Math.floor((tscale(log, xi) - x0) * k);
    if (c !== col) { flush(); col = c; first = lo = hi = last = i; continue; }
    if (yi < y[lo]) lo = i;
    if (yi > y[hi]) hi = i;
    last = i;
  }
  flush();
  return { x: ox, y: oy };
}

/* ------------------------------------------------------------------ *
 * The figure for Plotly
 * ------------------------------------------------------------------ */

const LEGEND_KINDS = new Set(['line', 'scatter', 'errorbar', 'band', 'bar', 'histogram', 'hline', 'vline', 'axline']);
const axisRef = (i, k) => (i === 0 ? k : `${k}${i + 1}`);

/*
 * A marker as Plotly draws it. Alpha goes on the face and the edge colours,
 * not on the marker as a whole: matplotlib draws both translucent, so the
 * edge's inner half shows darker over the face.
 */
function plotlyMarker(marker, sizePt, face, edge, edgeWidth, alpha) {
  const mk = MARKER_MAP[marker];
  if (!mk) return { size: 0, opacity: 0 };
  const out = {
    symbol: mk.symbol, size: mk.k * px(sizePt),
    color: rgba(mk.line ? edge : face, alpha),
    line: { color: rgba(edge, alpha), width: px(edgeWidth) }
  };
  // Plotly strokes a line-only marker at 1 px at least; matplotlib draws nothing.
  if (mk.line && !(edgeWidth > 0)) out.opacity = 0;
  return out;
}

/* Error bars on one side. On a log axis a bar reaching zero or below is drawn
   to the bottom edge, as matplotlib clips it; Plotly would drop the whole bar. */
function errorBars(values, err, { color, width, cap, log, view }) {
  const floor = Math.min(view[0], view[1]) / 1e3;
  return {
    type: 'data', symmetric: false, visible: true,
    array: values.map((v, i) => err[1][i]),
    arrayminus: values.map((v, i) => (log && !(v - err[0][i] > 0) ? v - floor : err[0][i])),
    color, thickness: px(width), width: px(cap)
  };
}

/* Rectangles as one filled Plotly path: corners in order, a gap between. */
function rects(list) {
  const x = []; const y = [];
  for (const [x0, x1, y0, y1] of list) {
    if (![x0, x1, y0, y1].every(Number.isFinite)) continue;
    if (x.length) { x.push(null); y.push(null); }
    x.push(x0, x1, x1, x0, x0); y.push(y0, y0, y1, y1, y0);
  }
  return { x, y };
}

/* Runs of points where every array has a number, for fill_between. */
function finiteRuns(n, keep, ...arrays) {
  const runs = []; let cur = null;
  for (let i = 0; i < n; i++) {
    if (keep(i) && arrays.every((a) => Number.isFinite(a[i]))) { if (!cur) { cur = []; runs.push(cur); } cur.push(i); } else cur = null;
  }
  return runs;
}

/**
 * The figure as Plotly data and layout, laid out as matplotlib lays out the
 * script's figure. Needs no DOM (text is then measured from font averages).
 *
 * @param {object} figure - a figure description (see src/core/figure.js),
 *   normalised here
 * @param {object} [options]
 * @param {boolean} [options.tight]        - crop to the drawing as bbox_inches='tight' does
 *   (default: figure.export.tight)
 * @param {boolean} [options.transparent]  - no figure background (for export)
 * @param {boolean} [options.vector]       - heatmaps as vector cells (for SVG and PDF export)
 *   instead of Plotly's raster heatmap
 * @param {boolean} [options.normalised]   - the figure is already normalised
 * @param {number} [options.pixelWidth]    - the width lines are thinned to, in device pixels
 * @returns {{data: object[], layout: object, info: {widthIn: number, heightIn: number,
 *   widthPx: number, heightPx: number, figureWidthIn: number, figureHeightIn: number,
 *   tight: boolean, legend: string|null, legends: (string|null)[], axes: {l: number, t: number, r: number, b: number}[],
 *   colorbars: ({l: number, t: number, r: number, b: number}|null)[], notes: string[]}}}
 *   `legend` is the location the first legend took (what "best" chose); `axes` are
 *   the panels' boxes on the page in px
 */
export function buildFigure(figure, options = {}) {
  const s = options.normalised ? figure : normaliseFigure(figure);
  const family = s.fontFamily;
  const notes = [];
  const unknownTex = [];
  const html = (t) => textToHtml(t, unknownTex);
  const xLog = s.xScale === 'log';
  const texts = [s.title, s.xLabel, ...(s.xCategories || []), ...s.xTicks.labels];

  /* Panels: what each draws, its limits, legend entries and colour bar */
  const xArrays = []; const xSticky = [];
  const panels = s.panels.map((p, i) => {
    const yLog = p.yScale === 'log';
    const series = p.series.filter((q) => q.show);
    series.forEach((q) => { if (q.kind === 'box') q.managed = !!s.xCategories; });
    const yArrays = []; const ySticky = []; const xOwn = [];
    for (const q of series) {
      const e = seriesExtent(q);
      xArrays.push(...e.x); xSticky.push(...e.sx); xOwn.push(...e.x);
      yArrays.push(...e.y); ySticky.push(...e.sy);
    }
    texts.push(p.yLabel, ...p.yTicks.labels);
    // The legend: labelled series, in the order asked for.
    const labelled = series.filter((q) => LEGEND_KINDS.has(q.kind) && q.legend && q.label);
    const rank = (q) => { const k = p.legend.order.indexOf(q.id); return k < 0 ? p.legend.order.length + labelled.indexOf(q) : k; };
    const entries = labelled.slice().sort((a, b) => rank(a) - rank(b))
      .map((q) => ({ series: q, html: html(q.label), math: isMathText(q.label) }));
    texts.push(...labelled.map((q) => q.label));
    // The colour bar: the first image or filled contour that asks for one.
    let colorbar = null;
    const cbSeries = series.find((q) => (q.kind === 'heatmap' || (q.kind === 'contour' && q.filled)) && q.colorbar.show);
    if (cbSeries) {
      const lut = colormapColors(cbSeries.colormap);
      if (cbSeries.kind === 'heatmap') {
        const view = heatmapRange(cbSeries);
        if (view[0] !== view[1]) {
          const bands = lut.map((c, k) => ({ lo: view[0] + (k / 256) * (view[1] - view[0]), hi: view[0] + ((k + 1) / 256) * (view[1] - view[0]), color: c }));
          colorbar = { series: cbSeries, view, fixed: null, bands };
        }
      } else {
        const lv = contourLevels(cbSeries);
        if (lv) {
          const bands = lv.values.map((v, k) => ({ lo: lv.levels[k], hi: lv.levels[k + 1], color: lut[colormapIndex(v, lv.vmin, lv.vmax)] }));
          colorbar = { series: cbSeries, view: [lv.levels[0], lv.levels[lv.levels.length - 1]], fixed: lv.levels, bands };
        }
      }
      if (colorbar) {
        colorbar.label = html(cbSeries.colorbar.label);
        colorbar.math = isMathText(cbSeries.colorbar.label);
        colorbar.ticks = p.yTicks;
        texts.push(cbSeries.colorbar.label);
      }
    }
    // Notes on the axes: text series and the labels of brackets.
    const notesOn = [];
    for (const q of series) {
      if (q.kind === 'text' && q.text) {
        notesOn.push({ html: html(q.text), math: isMathText(q.text), size: px(q.fontSize), x: q.x, y: q.y, coords: q.coords, ha: q.ha, va: q.va, rot: q.rotation, color: q.color });
        texts.push(q.text);
      } else if (q.kind === 'bracket' && q.text) {
        notesOn.push({ html: html(q.text), math: isMathText(q.text), size: px(q.fontSize), x: (q.x1 + q.x2) / 2, y: q.y + q.height, coords: 'data', ha: 'center', va: 'bottom', rot: 0, color: q.color });
        texts.push(q.text);
      }
    }
    const minorLocated = p.yTicks.minor || (s.grid.show && s.grid.minor && s.grid.axis !== 'x');
    return {
      index: i, id: p.id, ratio: p.ratio, series, yLog, yArrays, ySticky, xOwn, yLim: p.yLim,
      yTicks: p.yTicks, yMarks: tickMarks(p.yTicks), yMinor: minorLocated,
      yLabel: html(p.yLabel), yMath: isMathText(p.yLabel), top: i === 0, bottom: i === s.panels.length - 1,
      entries, legendShow: p.legend.show === null ? s.legend.show : p.legend.show,
      legendPos: p.legend.position || s.legend.position, colorbar, texts: notesOn
    };
  });

  /* Limits: autoscaled over everything drawn, the x axis shared by all panels */
  const xView = viewLimits(xLog ? logDataLimits(xArrays, panels.length ? panels[0].xOwn : []) : dataLimits(xArrays, false), s.xLim, xLog, xSticky);
  for (const pn of panels) pn.yView = viewLimits(pn.yLog ? logDataLimits(pn.yArrays, pn.yArrays) : dataLimits(pn.yArrays, false), pn.yLim, pn.yLog, pn.ySticky);

  const xTicks = xTickSpec(s);
  const P = {
    s, family, W: s.width * PX_PER_IN, H: s.height * PX_PER_IN,
    xView, xLog, xTicks,
    xMinor: xTicks.minor || (s.grid.show && s.grid.minor && s.grid.axis !== 'y' && !s.xCategories),
    xMarks: tickMarks(xTicks),
    tickPt: textSizes(s).tick, tickPx: px(textSizes(s).tick), labelPx: px(s.fontSize), titlePx: px(textSizes(s).title), legendPx: px(s.legend.fontSize),
    xLabel: html(s.xLabel), title: html(s.title),
    math: { xLabel: isMathText(s.xLabel), title: isMathText(s.title) },
    // mathtext pads its box by device pixels of the renderer: the PNG's
    // dpi, or 72 for the vector formats.
    mathPad: 2 * PX_PER_IN / (s.export.format === 'png' ? s.dpi : 72),
    panels
  };
  for (const pn of panels) {
    pn.P = P;
    const title = s.legend.title && pn.top ? { html: html(s.legend.title), math: isMathText(s.legend.title) } : null;
    pn.legend = pn.legendShow ? legendBox(P, pn.entries, title, s.legend.columns) : null;
  }
  if (s.legend.title) texts.push(s.legend.title);

  /* Layout: two passes of constrained layout, then the drawing's own ticks */
  let { boxes, cbs } = initialBoxes(P);
  let cbPad = 0;
  for (let pass = 0; pass < 2; pass++) {
    const dressed = panels.map((pn, i) => dressAxes(P, pn, boxes[i]));
    const bars = panels.map((pn, i) => (pn.colorbar ? dressColorbar(P, pn.colorbar, cbs[i]) : null));
    const next = solveLayout(P, dressed, bars, cbPad);
    if (!next) {
      notes.push('At this size the labels and ticks leave no room for the axes, so matplotlib keeps its default layout, as the preview does. Make the figure larger or the text smaller.');
      break;
    }
    ({ boxes, cbs } = next);
    cbPad = 0.05 * next.innerWidth;
  }
  const dressed = panels.map((pn, i) => dressAxes(P, pn, boxes[i]));
  const bars = panels.map((pn, i) => (pn.colorbar ? dressColorbar(P, pn.colorbar, cbs[i]) : null));

  /* Legends */
  const legends = dressed.map((d) => {
    const pn = d.pn;
    if (!pn.legend) return null;
    const pos = pn.legendPos;
    if (pos === 'outside right') return { loc: pos, box: outsideLegend(pn, d.box) };
    if (pos === 'best') return bestLegend(pn.legend, d.box, P.legendPx, legendObstacles(d, pn.series));
    return { loc: pos, box: anchoredLegend(pos, pn.legend, d.box, P.legendPx) };
  });

  /* The saved page: the figure, or with bbox_inches='tight' what is drawn plus 0.1 in */
  const tight = options.tight ?? s.export.tight;
  let ox = 0; let oy = 0; let Wout = P.W; let Hout = P.H;
  if (tight) {
    const full = union([
      ...dressed.flatMap((d) => [d.box, ...d.items.map((it) => it.box), ...d.spines.filter(solid)]),
      ...bars.flatMap((b) => (b ? [b.box, ...b.items.map((it) => it.box), ...b.spines] : [])),
      ...legends.map((l) => l && l.box)
    ]);
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
    // grid.axis: lines at the x ticks (vertical), the y ticks, or both.
    const onX = s.grid.axis !== 'y'; const onY = s.grid.axis !== 'x';
    const lines = (d, xs, ys) => [
      ...(onX ? xs : []).map((t) => ({ pts: [[d.X(t.v), d.box.b], [d.X(t.v), d.box.t]] })),
      ...(onY ? ys : []).map((t) => ({ pts: [[d.box.l, d.Y(t.v)], [d.box.r, d.Y(t.v)]] }))
    ];
    const minorWidth = round(s.grid.width / 2);
    for (const d of dressed) {
      shape(below, lines(d, d.xt.major, d.yt.major), { color: colour, width: px(s.grid.width), dash: plotlyDash(s.grid.style, s.grid.width) }, { layer: 'below' });
      if (s.grid.minor) shape(below, lines(d, d.xt.minor, d.yt.minor), { color: colour, width: px(minorWidth), dash: plotlyDash(s.grid.style, minorWidth) }, { layer: 'below' });
    }
  }

  /* Heatmaps drawn as vector cells, for export: one path per colour. Cells
     overlap by `seam` (a device pixel or more), or the background shows
     through where two anti-aliased edges meet. */
  const seam = options.seam ?? 1;
  if (options.vector) {
    for (const d of dressed) {
      for (const q of d.pn.series) {
        if (q.kind !== 'heatmap') continue;
        const [vmin, vmax] = heatmapRange(q);
        const lut = colormapColors(q.colormap);
        const ex = cellEdges(q.x).map(d.X); const ey = cellEdges(q.y).map(d.Y);
        const groups = new Map();
        // The colour index of every cell (-1: not drawn), rows along y.
        const idx = q.z.map((row, j) => row.map((v, i) => (Number.isFinite(ex[i]) && Number.isFinite(ex[i + 1])
          && Number.isFinite(ey[j]) && Number.isFinite(ey[j + 1]) ? colormapIndex(v, vmin, vmax) : -1)));
        // Opaque cells reach a hair into their neighbours, so that no seam of
        // background shows between them. A path's fill is even-odd, so cells
        // that overlap must not share one: runs in a row never touch (the next
        // cell is of another colour), and alternate rows go in separate paths.
        const o = q.alpha < 1 ? 0 : seam;
        const toward = (a, b, by) => (b >= a ? b + by : b - by);
        idx.forEach((row, j) => {
          let i = 0;
          while (i < row.length) {
            const k = row[i];
            let i1 = i + 1;
            while (i1 < row.length && row[i1] === k) i1++;
            if (k >= 0) {
              const next = idx[j + 1];
              const right = i1 < row.length && row[i1] >= 0 ? o : 0;
              let below = next ? o : 0;
              if (next) for (let c = i; c < i1; c++) if (next[c] < 0) { below = 0; break; }
              const x0 = ex[i]; const x1 = toward(ex[i], ex[i1], right);
              const y0 = ey[j]; const y1 = toward(ey[j], ey[j + 1], below);
              const l = Math.max(d.box.l, Math.min(x0, x1)); const r = Math.min(d.box.r, Math.max(x0, x1));
              const t = Math.max(d.box.t, Math.min(y0, y1)); const b = Math.min(d.box.b, Math.max(y0, y1));
              if (r > l && b > t) {
                const key = `${k}:${j % 2}`;
                if (!groups.has(key)) groups.set(key, []);
                groups.get(key).push({ pts: [[l, b], [r, b], [r, t], [l, t]], closed: true });
              }
            }
            i = i1;
          }
        });
        for (const [key, polys] of groups) {
          below.push({ type: 'path', xref: 'paper', yref: 'paper', layer: 'below', path: path(polys), fillcolor: rgba(lut[Number(key.split(':')[0])], q.alpha), line: { width: 0, color: 'rgba(0,0,0,0)' } });
        }
      }
    }
  }

  /* Frame and tick marks */
  for (const d of dressed) {
    if (s.spines.width > 0) {
      shape(above, [spinePath(d.box, s.spines.top, s.spines.right, px(s.spines.width) / 2)], { color: fg, width: px(s.spines.width) }, { layer: 'above' });
    }
    for (const [axis, T, marks] of [['x', P.xTicks, P.xMarks], ['y', d.pn.yTicks, d.pn.yMarks]]) {
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

  /* Colour bars: the colours, the outline, the tick marks */
  for (const b of bars) {
    if (!b) continue;
    const { box } = b;
    const byColour = new Map();
    // Neighbouring bands of one colour as one; each reaches a hair into the
    // next, which is of another colour, so no seam shows.
    const bands = [];
    for (const band of b.cb.bands) {
      const last = bands[bands.length - 1];
      if (last && last.color === band.color) last.hi = band.hi; else bands.push({ ...band });
    }
    const o = b.cb.series.alpha < 1 ? 0 : seam;
    bands.forEach((band, k) => {
      const ya = b.Y(band.lo); const yb = b.Y(band.hi);
      const reach = k < bands.length - 1 ? o : 0;
      const t = Math.max(box.t, Math.min(ya, yb) - reach); const bt = Math.min(box.b, Math.max(ya, yb));
      if (!(bt > t)) return;
      if (!byColour.has(band.color)) byColour.set(band.color, []);
      byColour.get(band.color).push({ pts: [[box.l, bt], [box.r, bt], [box.r, t], [box.l, t]], closed: true });
    });
    for (const [col, polys] of byColour) {
      above.push({ type: 'path', xref: 'paper', yref: 'paper', layer: 'above', path: path(polys), fillcolor: rgba(col, b.cb.series.alpha), line: { width: 0, color: 'rgba(0,0,0,0)' } });
    }
    if (s.spines.width > 0) shape(above, [{ pts: [[box.l, box.t], [box.l, box.b], [box.r, box.b], [box.r, box.t]], closed: true }], { color: fg, width: px(s.spines.width) }, { layer: 'above' });
    const mk = b.mk;
    if (mk.len > 0 && mk.width > 0 && b.yt.major.length) {
      const L = px(mk.len); const o = L * DIR_OUT[mk.dir]; const i = L * DIR_IN[mk.dir];
      shape(above, b.yt.major.map((t) => ({ pts: [[box.r - i, b.Y(t.v)], [box.r + o, b.Y(t.v)]] })), { color: fg, width: px(mk.width) }, { layer: 'above' });
    }
  }

  /* Text */
  const annotate = (it, size = it.size, color = fg) => {
    const bx = it.m;
    const ow = Math.round(bx.width); const oh = Math.round(bx.height);
    let cx; let cy;
    if (it.rot) {
      // Plotly rotates about the box centre: put the centre where the
      // rotated baseline lands on it.x.
      cx = it.x + bx.top + oh / 2;
      cy = it.y;
    } else {
      const left = it.ha === 'center' ? it.x - bx.width / 2 : it.ha === 'right' ? it.x - bx.width : it.x;
      cx = left + ow / 2;
      cy = it.y + bx.top + oh / 2;
    }
    annotations.push({
      xref: 'paper', yref: 'paper', x: fx(cx), y: fy(cy), xanchor: 'center', yanchor: 'middle',
      text: it.html, showarrow: false, borderpad: 0, borderwidth: 0, textangle: it.rot ? -90 : 0,
      font: { family: FONT_STACKS[family], size, color }, captureevents: false
    });
  };
  dressed.forEach((d) => d.items.forEach((it) => annotate(it, it.size, it.note ? it.note.color : fg)));
  bars.forEach((b) => { if (b) b.items.forEach((it) => annotate(it)); });

  /* Legends: frame, handles and labels, above everything */
  const layouts = legends.map(() => null);
  legends.forEach((legend, li) => {
    if (!legend) return;
    const lg = panels[li].legend;
    const fs = P.legendPx;
    const k = RC.legend;
    const b = legend.box;
    if (s.legend.frame) {
      // FancyBboxPatch, round with rounding_size 0.2 font sizes: quadratic corners.
      const r = Math.min(0.2 * fs, (b.r - b.l) / 2, (b.b - b.t) / 2);
      const P2 = ([x, y]) => `${c(fx(x))},${c(fy(y))}`;
      const dd = `M${P2([b.l + r, b.b])}L${P2([b.r - r, b.b])}Q${P2([b.r, b.b])},${P2([b.r, b.b - r])}`
        + `L${P2([b.r, b.t + r])}Q${P2([b.r, b.t])},${P2([b.r - r, b.t])}L${P2([b.l + r, b.t])}`
        + `Q${P2([b.l, b.t])},${P2([b.l, b.t + r])}L${P2([b.l, b.b - r])}Q${P2([b.l, b.b])},${P2([b.l + r, b.b])}Z`;
      above.push({
        type: 'path', xref: 'paper', yref: 'paper', path: dd, layer: 'above',
        // The script sets legend.facecolor to the background, as here.
        fillcolor: rgba(s.background, RC.legend.framealpha),
        line: { color: rgba(RC.legend.edgecolor, RC.legend.framealpha), width: px(1) }
      });
    }
    let top = b.t + k.borderpad * fs;
    if (lg.head) {
      const base = top + lg.head.m.ascent;
      annotate({ html: lg.head.html, size: P.labelPx, x: (b.l + b.r) / 2, y: base, ha: 'center', rot: 0, m: lg.head.m });
      top = base + lg.head.m.descent + k.labelspacing * fs;
    }
    // VPacker(align='center'): under a wider title the entries are centred.
    let left = b.l + k.borderpad * fs + (b.r - b.l - 2 * k.borderpad * fs - lg.entriesWidth) / 2;
    layouts[li] = { box: { ...b }, entries: { l: left, r: left + lg.entriesWidth } };
    lg.cols.forEach((col, ci) => {
      let y = top;
      const hx = left;
      for (const row of col) {
        const base = y + row.up;
        const cy = base - (k.handleheight * fs) / 2;
        above.push(...legendHandle(row.series, { hx, cy, base, fs, fx, fy, path, shape: (polys, line) => { const o = []; shape(o, polys, line, { layer: 'above' }); return o; } }));
        annotate({ html: row.html, size: fs, x: hx + (k.handlelength + k.handletextpad) * fs, y: base, ha: 'left', rot: 0, m: row.m });
        y = base + row.down + k.labelspacing * fs;
      }
      left += lg.colW[ci] + k.columnspacing * fs;
    });
  });

  /* Traces, panel by panel, in the order given */
  const data = [];
  dressed.forEach((d, i) => {
    const xa = axisRef(i, 'x'); const ya = axisRef(i, 'y');
    for (const q of d.pn.series) data.push(...seriesTraces(q, d, xa, ya, P, options));
  });

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
    shapes: [...below, ...above],
    annotations
  };
  dressed.forEach((d, i) => {
    const r = d.box;
    layout[i === 0 ? 'xaxis' : `xaxis${i + 1}`] = axis([fx(r.l), fx(r.r)], xView, xLog, axisRef(i, 'y'));
    layout[i === 0 ? 'yaxis' : `yaxis${i + 1}`] = axis([fy(r.b), fy(r.t)], d.pn.yView, d.pn.yLog, axisRef(i, 'x'));
  });
  // The shapes and annotations above leave the layout's key order as the
  // single-panel figure has always had it.
  const ordered = { width: layout.width, height: layout.height, autosize: false, margin: layout.margin, paper_bgcolor: layout.paper_bgcolor,
    plot_bgcolor: layout.plot_bgcolor, showlegend: false, hovermode: false, dragmode: false, font: layout.font };
  for (const k of Object.keys(layout)) if (!(k in ordered) && k !== 'shapes' && k !== 'annotations') ordered[k] = layout[k];
  ordered.shapes = layout.shapes;
  ordered.annotations = layout.annotations;

  /* What the preview cannot show as matplotlib will */
  for (const d of dressed) notes.push(...d.xt.notes, ...d.yt.notes), unknownTex.push(...d.xt.tex, ...d.yt.tex);
  notes.push(...texNotes(texts, unknownTex));
  const allSeries = panels.flatMap((pn) => pn.series);
  if (allSeries.some((q) => ['scatter', 'errorbar', 'line', 'box'].includes(q.kind) && (q.marker === '^' || q.marker === 'v'))) {
    notes.push('Plotly\'s triangles are a little wider and flatter than matplotlib\'s; the preview matches their area.');
  }
  if (allSeries.some((q) => q.kind === 'contour' && q.z.some((row) => row.some((v) => !Number.isFinite(v))))) {
    notes.push('Where the grid has gaps, the preview trims the contours a little differently from matplotlib.');
  }
  if (xLog && allSeries.some((q) => q.kind === 'heatmap')) {
    notes.push('On a log x axis the preview places heatmap cells approximately; the saved figure places them as matplotlib does.');
  }

  return {
    data,
    layout: ordered,
    info: {
      widthIn: Wout / PX_PER_IN, heightIn: Hout / PX_PER_IN, widthPx: Wout, heightPx: Hout,
      figureWidthIn: s.width, figureHeightIn: s.height, tight: !!tight,
      legend: legends.find(Boolean) ? legends.find(Boolean).loc : null,
      legends: legends.map((l) => (l ? l.loc : null)),
      axes: dressed.map((d) => ({ l: d.box.l + ox, t: d.box.t + oy, r: d.box.r + ox, b: d.box.b + oy })),
      legendBox: legends.find(Boolean) ? (({ l, t, r, b }) => ({ l: l + ox, t: t + oy, r: r + ox, b: b + oy }))(legends.find(Boolean).box) : null,
      // Each legend's box and the span of its entries, on the page in px.
      legendLayouts: layouts.map((g) => (g ? { box: { l: g.box.l + ox, t: g.box.t + oy, r: g.box.r + ox, b: g.box.b + oy }, entries: { l: g.entries.l + ox, r: g.entries.r + ox } } : null)),
      colorbars: bars.map((b) => (b ? { l: b.box.l + ox, t: b.box.t + oy, r: b.box.r + ox, b: b.box.b + oy } : null)),
      notes: [...new Set(notes)]
    }
  };
}

/*
 * One series as Plotly traces on its panel's axes (xa, ya), in the drawing
 * order matplotlib gives the artists the script makes for it.
 */
function seriesTraces(q, d, xa, ya, P, options) {
  const out = [];
  const pn = d.pn;
  const base = { xaxis: xa, yaxis: ya, hoverinfo: 'skip', showlegend: false };
  const lineTrace = (x, y, line, extra = {}) => ({ type: 'scatter', mode: 'lines', x, y, xaxis: xa, yaxis: ya, line, hoverinfo: 'skip', showlegend: false, ...extra });
  const lineOf = (color, width, style, alpha = 1) => ({ color: alpha === 1 ? color : rgba(color, alpha), width: px(width), dash: plotlyDash(style, width) });
  const widthPx = options.pixelWidth || (d.box.r - d.box.l) * 2;
  // Device px per figure px of what the markers are drawn for.
  const markerScale = options.markerScale || 2;
  const markerBudget = options.markerBudget || Infinity;
  const pick = (arr, keep) => (keep ? keep.map((i) => arr[i]) : arr);
  switch (q.kind) {
    case 'line': {
      const t = thinLine(q.x, q.y, widthPx, P.xView, P.xLog);
      const tr = lineTrace(t.x, t.y, lineOf(q.color, q.lineWidth, q.lineStyle, q.alpha));
      if (q.step) tr.line.shape = { pre: 'vh', mid: 'hvh', post: 'hv' }[q.step];
      if (!(q.lineWidth > 0) || q.lineStyle === 'none') tr.line.width = 0;
      const keep = q.marker !== 'none' ? thinMarkers(q.x, q.y, d, { scale: markerScale, sizePt: q.size, budget: markerBudget }) : null;
      if (q.marker !== 'none' && !keep && t.x === q.x) {
        tr.mode = 'lines+markers';
        tr.marker = plotlyMarker(q.marker, q.size, q.color, q.color, 1, q.alpha);
        tr.cliponaxis = true;
      }
      out.push(tr);
      // A long line with markers: the thinned line, then its markers once per pixel.
      if (q.marker !== 'none' && (keep || t.x !== q.x)) {
        out.push({ type: 'scatter', mode: 'markers', x: pick(q.x, keep), y: pick(q.y, keep), ...base, cliponaxis: true,
          marker: plotlyMarker(q.marker, q.size, q.color, q.color, 1, q.alpha) });
      }
      break;
    }
    case 'scatter': case 'errorbar': {
      const errs = q.kind === 'errorbar' && (q.yerr || q.xerr) ? { y: q.yerr, x: q.xerr } : null;
      const keep = thinMarkers(q.x, q.y, d, { scale: markerScale, sizePt: q.size, errors: errs, budget: markerBudget });
      const joined = q.kind === 'errorbar' && q.lineStyle !== 'none';
      // A long joined series: its line thinned as any line is, the points once per pixel.
      if (keep && joined) {
        const t = thinLine(q.x, q.y, widthPx, P.xView, P.xLog);
        out.push(lineTrace(t.x, t.y, lineOf(q.color, q.lineWidth, q.lineStyle, q.alpha)));
      }
      const xs = pick(q.x, keep); const ys = pick(q.y, keep);
      const t = { type: 'scatter', mode: 'markers', x: xs, y: ys, ...base, cliponaxis: true };
      t.marker = q.marker === 'none' ? { size: 0, opacity: 0 } : plotlyMarker(q.marker, q.size, q.color, q.edgeColor, q.edgeWidth, q.alpha);
      if (q.kind === 'errorbar') {
        const opts = { color: rgba(q.color, q.alpha), width: q.errorWidth, cap: q.capSize };
        const sub = (e) => (e && keep ? [pick(e[0], keep), pick(e[1], keep)] : e);
        if (q.yerr) t.error_y = errorBars(ys, sub(q.yerr), { ...opts, log: pn.yLog, view: pn.yView });
        if (q.xerr) t.error_x = errorBars(xs, sub(q.xerr), { ...opts, log: P.xLog, view: P.xView });
        if (joined && !keep) {
          t.mode = 'lines+markers';
          t.line = lineOf(q.color, q.lineWidth, q.lineStyle, q.alpha);
        }
      }
      out.push(t);
      break;
    }
    case 'band': {
      const n = Math.min(q.x.length, q.lower.length, q.upper.length);
      const runs = finiteRuns(n, (i) => !P.xLog || q.x[i] > 0, q.x, q.lower, q.upper);
      const x = []; const y = [];
      runs.forEach((r, k) => {
        if (k) { x.push(null); y.push(null); }
        for (const i of r) { x.push(q.x[i]); y.push(q.upper[i]); }
        for (let k = r.length - 1; k >= 0; k--) { x.push(q.x[r[k]]); y.push(q.lower[r[k]]); }
      });
      if (x.length) {
        const line = q.edgeWidth > 0 ? { width: px(q.edgeWidth), color: rgba(q.color, q.alpha) } : { width: 0, color: 'rgba(0,0,0,0)' };
        out.push({ ...lineTrace(x, y, line), fill: 'toself', fillcolor: rgba(q.color, q.alpha) });
      }
      break;
    }
    case 'bar': {
      const h = q.barWidth / 2;
      const r = rects(q.x.map((x, i) => [x + q.offset - h, x + q.offset + h, q.bottom, q.bottom + q.y[i]]));
      const line = q.edgeWidth > 0 ? { width: px(q.edgeWidth), color: rgba(q.edgeColor, q.alpha) } : { width: 0, color: 'rgba(0,0,0,0)' };
      out.push({ ...lineTrace(r.x, r.y, line), fill: 'toself', fillcolor: rgba(q.color, q.alpha) });
      if (q.yerr) {
        const ys = q.y.map((v) => v + q.bottom);
        out.push({ type: 'scatter', mode: 'markers', x: q.x.map((v) => v + q.offset), y: ys, ...base, cliponaxis: true, marker: { size: 0, opacity: 0 },
          error_y: errorBars(ys, q.yerr, { color: q.errorColor, width: q.errorWidth, cap: q.capSize, log: pn.yLog, view: pn.yView }) });
      }
      break;
    }
    case 'histogram': {
      const e = q.edges; const k = q.counts;
      if (e.length < 2) break;
      if (q.histtype === 'bar') {
        const r = rects(k.map((v, i) => [e[i], e[i + 1], 0, v]));
        const line = q.edgeWidth > 0 ? { width: px(q.edgeWidth), color: rgba(q.edgeColor, q.alpha) } : { width: 0, color: 'rgba(0,0,0,0)' };
        out.push({ ...lineTrace(r.x, r.y, line), fill: 'toself', fillcolor: rgba(q.color, q.alpha) });
        break;
      }
      // StepPatch's outline: up from the baseline, across each bin, back down.
      const x = [e[0]]; const y = [0];
      k.forEach((v, i) => { x.push(e[i], e[i + 1]); y.push(v, v); });
      x.push(e[e.length - 1]); y.push(0);
      if (q.histtype === 'step') {
        out.push(lineTrace(x, y, lineOf(q.edgeColor, q.edgeWidth, 'solid', q.alpha)));
      } else {
        const line = q.edgeWidth > 0 ? { width: px(q.edgeWidth), color: rgba(q.edgeColor, q.alpha) } : { width: 0, color: 'rgba(0,0,0,0)' };
        out.push({ ...lineTrace([...x, e[0]], [...y, 0], line), fill: 'toself', fillcolor: rgba(q.color, q.alpha) });
      }
      break;
    }
    case 'box': {
      const w = q.width / 2; const cw = q.width / 4;
      const groups = q.groups.filter((g) => g.stats);
      const boxes = rects(groups.map((g) => [g.position - w, g.position + w, g.stats.q1, g.stats.q3]));
      out.push({ ...lineTrace(boxes.x, boxes.y, { width: px(q.lineWidth), color: q.color }), fill: 'toself', fillcolor: rgba(q.color, q.faceAlpha) });
      const wx = []; const wy = [];
      for (const g of groups) {
        const p = g.position; const st = g.stats;
        wx.push(p, p, null, p, p, null, p - cw, p + cw, null, p - cw, p + cw, null);
        wy.push(st.q1, st.whislo, null, st.q3, st.whishi, null, st.whislo, st.whislo, null, st.whishi, st.whishi, null);
      }
      out.push(lineTrace(wx, wy, { width: px(q.lineWidth), color: q.color }));
      const mx = []; const my = [];
      for (const g of groups) { mx.push(g.position - w, g.position + w, null); my.push(g.stats.med, g.stats.med, null); }
      out.push(lineTrace(mx, my, { width: px(q.lineWidth), color: q.medianColor }));
      if (q.fliers) {
        const fxs = groups.flatMap((g) => g.stats.fliers.map(() => g.position));
        const fys = groups.flatMap((g) => g.stats.fliers);
        if (fxs.length) {
          const m = plotlyMarker(q.marker, q.pointSize + 2, q.color, q.color, 1, 1);
          m.color = 'rgba(0,0,0,0)';
          const keep = thinMarkers(fxs, fys, d, { scale: markerScale, sizePt: q.pointSize + 2, budget: markerBudget });
          out.push({ type: 'scatter', mode: 'markers', x: pick(fxs, keep), y: pick(fys, keep), ...base, cliponaxis: true, marker: m });
        }
      }
      if (q.points) {
        const pxs = groups.flatMap((g) => jitterOffsets(g.values.length, q.jitter * q.width).map((o) => g.position + o));
        const pys = groups.flatMap((g) => g.values);
        const keep = thinMarkers(pxs, pys, d, { scale: markerScale, sizePt: q.pointSize, budget: markerBudget });
        out.push({ type: 'scatter', mode: 'markers', x: pick(pxs, keep), y: pick(pys, keep), ...base, cliponaxis: true, marker: plotlyMarker(q.marker, q.pointSize, q.color, q.color, 0, 0.6) });
      }
      if (q.mean) {
        const ms = groups.filter((g) => Number.isFinite(g.stats.mean));
        const t = { type: 'scatter', mode: 'markers', x: ms.map((g) => g.position + q.meanOffset), y: ms.map((g) => g.stats.mean), ...base, cliponaxis: true,
          marker: plotlyMarker('D', q.pointSize + 1, P.s.background, P.s.foreground, 1, 1) };
        const lo = ms.map((g) => (Number.isFinite(g.stats.ciLow) ? g.stats.mean - g.stats.ciLow : 0));
        const hi = ms.map((g) => (Number.isFinite(g.stats.ciHigh) ? g.stats.ciHigh - g.stats.mean : 0));
        t.error_y = errorBars(t.y, [lo, hi], { color: P.s.foreground, width: q.lineWidth, cap: 0, log: pn.yLog, view: pn.yView });
        out.push(t);
      }
      break;
    }
    case 'heatmap': {
      if (options.vector) break;   // drawn as shapes
      const [vmin, vmax] = heatmapRange(q);
      out.push({ type: 'heatmap', x: q.x, y: q.y, z: q.z, xaxis: xa, yaxis: ya, zmin: vmin, zmax: vmax === vmin ? vmin + 1 : vmax,
        colorscale: steppedScale(colormapColors(q.colormap)), showscale: false, zsmooth: false, hoverinfo: 'skip', opacity: q.alpha });
      break;
    }
    case 'contour': {
      const lv = contourLevels(q);
      if (!lv) break;
      const L = lv.levels;
      // The grid in level-index units (level k at k), so that bands of any
      // spacing are drawn with Plotly's evenly spaced contours.
      const idx = (v) => {
        if (!Number.isFinite(v)) return null;
        if (L.length === 1) return v - L[0];
        if (q.filled && (v < L[0] || v > L[L.length - 1])) return null;
        let k = 0;
        while (k < L.length - 2 && v > L[k + 1]) k++;
        return k + (v - L[k]) / (L[k + 1] - L[k]);
      };
      const z = q.z.map((row) => row.map(idx));
      const lut = colormapColors(q.colormap);
      if (q.filled) {
        const colours = lv.values.map((v) => lut[colormapIndex(v, lv.vmin, lv.vmax)]);
        const line = q.lineWidth > 0 ? { smoothing: 0, width: px(q.lineWidth), color: rgba(q.colors || P.s.foreground, q.alpha) } : { smoothing: 0, width: 0 };
        out.push({ type: 'contour', x: q.x, y: q.y, z, xaxis: xa, yaxis: ya, zmin: 0, zmax: colours.length, autocontour: false,
          contours: { start: 0, end: colours.length, size: 1, coloring: 'fill', showlines: q.lineWidth > 0 },
          colorscale: steppedScale(colours), showscale: false, hoverinfo: 'skip', opacity: q.alpha, line, connectgaps: false });
      } else {
        const line = { smoothing: 0, width: px(q.lineWidth), dash: plotlyDash(q.lineStyle, q.lineWidth) };
        const tr = { type: 'contour', x: q.x, y: q.y, z, xaxis: xa, yaxis: ya, autocontour: false, showscale: false, hoverinfo: 'skip', opacity: q.alpha, connectgaps: false };
        if (L.length === 1) tr.contours = { start: 0, end: 0, size: 1, coloring: 'none' };
        else tr.contours = { start: 0, end: L.length - 1, size: 1, coloring: q.colors ? 'none' : 'lines' };
        if (q.colors) line.color = q.colors;
        else {
          const cs = L.map((v, k) => [L.length === 1 ? 0 : k / (L.length - 1), lut[colormapIndex(v, lv.vmin, lv.vmax)]]);
          if (cs.length === 1) cs.push([1, cs[0][1]]);
          tr.colorscale = cs; tr.zmin = 0; tr.zmax = Math.max(1, L.length - 1);
        }
        tr.line = line;
        out.push(tr);
      }
      break;
    }
    case 'hline':
      out.push(lineTrace(P.xView.slice(), [q.y, q.y], lineOf(q.color, q.lineWidth, q.lineStyle, q.alpha)));
      break;
    case 'vline':
      out.push(lineTrace([q.x, q.x], pn.yView.slice(), lineOf(q.color, q.lineWidth, q.lineStyle, q.alpha)));
      break;
    case 'axline': {
      const seg = axlineSegment(q, d);
      if (seg) out.push(lineTrace([seg[0][0], seg[1][0]], [seg[0][1], seg[1][1]], lineOf(q.color, q.lineWidth, q.lineStyle, q.alpha)));
      break;
    }
    case 'bracket':
      out.push(lineTrace([q.x1, q.x1, q.x2, q.x2], [q.y, q.y + q.height, q.y + q.height, q.y], lineOf(q.color, q.lineWidth, 'solid', q.alpha), { cliponaxis: false }));
      break;
    default:
      break;
  }
  return out;
}

/*
 * A series' handle in the legend, as matplotlib's legend handlers draw it:
 * a line across (lines), the marker in the middle (markers), the bar with its
 * caps (error bars), a filled box (bands, bars, filled histograms).
 */
function legendHandle(q, { hx, cy, base, fs, fx, fy, path, shape }) {
  const k = RC.legend;
  const hl = k.handlelength * fs;
  const hc = hx + hl / 2;
  const out = [];
  const markerAt = (marker, sizePt, face, edge, edgeWidth, alpha) => out.push(...legendMarker({ marker, size: sizePt, face, edge, edgeWidth, alpha }, hc, cy, fx, fy, path));
  const across = (color, width, style, alpha = 1) => out.push(...shape([{ pts: [[hx, cy], [hx + hl, cy]] }],
    { color: alpha === 1 ? color : rgba(color, alpha), width: px(width), dash: plotlyDash(style, width) }));
  const box = (face, alpha, edge, edgeWidth) => out.push({
    type: 'rect', xref: 'paper', yref: 'paper', layer: 'above',
    x0: fx(hx), x1: fx(hx + hl), y0: fy(base), y1: fy(base - k.handleheight * fs),
    fillcolor: rgba(face, alpha), line: edgeWidth > 0 ? { width: px(edgeWidth), color: rgba(edge, alpha) } : { width: 0, color: 'rgba(0,0,0,0)' }
  });
  switch (q.kind) {
    case 'line':
      if (q.lineWidth > 0 && q.lineStyle !== 'none') across(q.color, q.lineWidth, q.lineStyle, q.alpha);
      if (q.marker !== 'none') markerAt(q.marker, q.size, q.color, q.color, 1, q.alpha);
      break;
    case 'scatter':
      markerAt(q.marker, q.size, q.color, q.edgeColor, q.edgeWidth, q.alpha);
      break;
    case 'errorbar': {
      if (q.lineStyle !== 'none') across(q.color, q.lineWidth, q.lineStyle, q.alpha);
      const e = 0.5 * fs;   // HandlerErrorbar: half a font size either side
      const line = { color: rgba(q.color, q.alpha), width: px(q.errorWidth) };
      if (q.xerr) {
        out.push(...shape([{ pts: [[hc - e, cy], [hc + e, cy]] }], line));
        if (q.capSize > 0) { const w = px(q.capSize); out.push(...shape([{ pts: [[hc - e, cy - w], [hc - e, cy + w]] }, { pts: [[hc + e, cy - w], [hc + e, cy + w]] }], line)); }
      }
      if (q.yerr) {
        out.push(...shape([{ pts: [[hc, cy + e], [hc, cy - e]] }], line));
        if (q.capSize > 0) {
          const w = px(q.capSize);
          out.push(...shape([{ pts: [[hc - w, cy + e], [hc + w, cy + e]] }, { pts: [[hc - w, cy - e], [hc + w, cy - e]] }], line));
        }
      }
      if (q.marker !== 'none') markerAt(q.marker, q.size, q.color, q.edgeColor, q.edgeWidth, q.alpha);
      break;
    }
    case 'band': box(q.color, q.alpha, q.color, q.edgeWidth); break;
    case 'bar': box(q.color, q.alpha, q.edgeColor, q.edgeWidth); break;
    case 'histogram':
      if (q.histtype === 'step') across(q.edgeColor, q.edgeWidth, 'solid', q.alpha);
      else box(q.color, q.alpha, q.edgeColor, q.edgeWidth);
      break;
    case 'hline': case 'vline': case 'axline': across(q.color, q.lineWidth, q.lineStyle, q.alpha); break;
    default: break;
  }
  return out;
}

/* A marker in the legend, as shapes in the plot's marker form. */
function legendMarker(m, cx, cy, fx, fy, path) {
  const mk = MARKER_MAP[m.marker];
  if (!mk) return [];
  const r = (mk.k * px(m.size)) / 2;
  const edge = { color: rgba(m.edge, m.alpha), width: px(m.edgeWidth) };
  const face = rgba(m.face, m.alpha);
  const base = { xref: 'paper', yref: 'paper', layer: 'above' };
  if (mk.line) {
    if (!(m.edgeWidth > 0)) return [];
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
  const max = typeof st.options.maxScale === 'function' ? st.options.maxScale() : st.options.maxScale;
  const scale = avail > 0 ? Math.min(max ?? 2, avail / info.widthPx) : 1;
  st.scale = scale;
  info.scale = scale;
  st.figure.style.width = `${info.widthPx}px`;
  st.figure.style.height = `${info.heightPx}px`;
  st.figure.style.transform = `scale(${scale})`;
  st.figure.style.setProperty('--fp-scale', String(scale));
  st.figure.style.left = `${Math.max(0, (avail - info.widthPx * scale) / 2)}px`;
  st.stage.style.height = `${info.heightPx * scale}px`;
}

/* Device px per figure px the preview is shown at: its CSS scale (the one
   fitStage will give it) times the screen's pixel ratio. */
function previewResolution(st, figure) {
  const avail = st.stage.clientWidth;
  const max = typeof st.options.maxScale === 'function' ? st.options.maxScale() : st.options.maxScale;
  const widthPx = (figure.width || 6.4) * PX_PER_IN;
  const scale = avail > 0 ? Math.min(max ?? 2, avail / widthPx) : 1;
  const dpr = typeof window !== 'undefined' && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
  return Math.max(0.25, scale * dpr);
}

async function drawPreview(st, job) {
  // The preview draws at most about 20 000 markers a series: past that
  // Plotly's SVG takes seconds a redraw.
  const fig = buildFigure(job.figure, { markerScale: previewResolution(st, job.figure), markerBudget: 20000, ...job.options, normalised: true });
  st.figureDesc = job.figure; st.options = job.options;
  await plotly().react(st.figure, fig.data, fig.layout, PLOTLY_CONFIG);
  st.info = fig.info;
  fitStage(st);
  return fig.info;
}

/**
 * Draw a figure into `el` at its true size (96 px per inch), scaled with a
 * CSS transform to fit el's width. Calls made while a drawing is under way
 * are merged: the last one wins and every caller gets its result.
 *
 * @param {HTMLElement} el
 * @param {object} figure - a figure description (normalised here)
 * @param {object} [options]
 * @param {boolean} [options.responsive=true]        - refit the scale when el is resized
 * @param {number|() => number} [options.maxScale=2] - largest enlargement of a small figure
 * @param {boolean} [options.tight]                   - as buildFigure (default: figure.export.tight)
 * @param {string} [options.label]                    - what the figure shows, for screen readers
 * @returns {Promise<object>} buildFigure's info, plus `scale`, the CSS scale now applied
 */
export function renderFigure(el, figure, options = {}) {
  let st = states.get(el);
  if (!st) {
    const stage = document.createElement('div');
    stage.className = 'fp-stage';
    const fig = document.createElement('div');
    fig.className = 'fp-figure';
    fig.setAttribute('role', 'img');
    stage.appendChild(fig);
    el.appendChild(stage);
    st = { el, stage, figure: fig, info: null, latest: null, running: null, options };
    states.set(el, st);
    if (options.responsive !== false && typeof ResizeObserver !== 'undefined') {
      st.observer = new ResizeObserver(() => fitStage(st));
      st.observer.observe(el);
    }
  }
  if (options.label) st.figure.setAttribute('aria-label', options.label);
  st.options = options;
  st.latest = { figure: normaliseFigure(figure), options };
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
export function destroyFigure(el) {
  const st = states.get(el);
  if (!st) return;
  if (st.observer) st.observer.disconnect();
  try { plotly().purge(st.figure); } catch { /* already gone */ }
  st.stage.remove();
  states.delete(el);
}

/** The normalised figure last drawn in `el`, or null. */
export function drawnFigure(el) {
  const st = states.get(el);
  return st && st.figureDesc ? st.figureDesc : null;
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

/** Save bytes as a file the browser downloads. */
export function download(bytes, filename, mime) {
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
 * Save a figure at its exact size, in its export format (or `format`), and
 * download it. Heatmaps are drawn as vector cells, so that PDF and SVG hold
 * them as matplotlib's do and PNG has sharp cell edges.
 *
 *   PNG  Plotly.toImage at dpi/96 times the true size, transparent when the
 *        figure says so, with the resolution recorded in the file
 *   SVG  Plotly's SVG, measured in points
 *   PDF  vector, from Plotly's SVG through pdfFromSvg; if that fails, a JPEG
 *        page through pdfFromJpeg
 *
 * @param {object} figure - a figure description
 * @param {{format?: string, download?: boolean, tight?: boolean}} [options] - download: false
 *   returns the bytes only
 * @returns {Promise<{filename: string, format: string, bytes: Uint8Array, widthIn: number,
 *   heightIn: number, pixelWidth?: number, pixelHeight?: number, raster?: boolean}>}
 */
export async function exportFigure(figure, options = {}) {
  const f = normaliseFigure(figure);
  const s = f;
  const P = plotly();
  const format = EXPORT_FORMATS.includes(options.format) ? options.format : s.export.format;
  f.export.format = format;
  const filename = `${s.export.filename}.${format}`;
  // Cells of a heatmap overlap by a device pixel: at the PNG's dpi, or at
  // 96 dpi, a screen at 100%, for the vector formats.
  const base = { normalised: true, vector: true, tight: options.tight, seam: format === 'png' ? 1.05 * PX_PER_IN / s.dpi : 1 };
  const fig = buildFigure(f, { ...base, transparent: s.export.transparent, pixelWidth: s.width * (format === 'png' ? s.dpi : 300),
    // Markers once per device pixel: of the PNG, or of a 600 dpi rendering of the vector page.
    markerScale: (format === 'png' ? s.dpi : 600) / PX_PER_IN });
  const { widthIn, heightIn, widthPx, heightPx } = fig.info;
  const plot = { data: fig.data, layout: fig.layout, config: PLOTLY_CONFIG };
  const result = { filename, format, widthIn, heightIn };
  if (format === 'png') {
    const pw = Math.floor(widthIn * s.dpi + 1e-6);
    const ph = Math.floor(heightIn * s.dpi + 1e-6);
    if (pw > MAX_CANVAS_SIDE || ph > MAX_CANVAS_SIDE || pw * ph > MAX_CANVAS_AREA) {
      throw new Error(`At ${s.dpi} dpi the PNG would be ${pw} × ${ph} pixels, more than a browser can draw. Lower the DPI or the size.`);
    }
    const url = await P.toImage(plot, { format: 'png', width: widthPx, height: heightPx, scale: (s.dpi / PX_PER_IN) * (1 + 1e-9) });
    result.bytes = pngWithDpi(dataUrlBytes(url), s.dpi);
    result.pixelWidth = pw; result.pixelHeight = ph;
  } else {
    const svg = svgText(await P.toImage(plot, { format: 'svg', width: widthPx, height: heightPx }));
    if (format === 'svg') {
      result.bytes = new TextEncoder().encode(svgWithSize(svg, widthIn, heightIn, widthPx, heightPx));
    } else {
      try {
        result.bytes = pdfFromSvg(svg, { widthIn, heightIn });
      } catch (err) {
        // The vector route failed on something in the SVG: a picture of the
        // page instead, on an opaque background (JPEG has no transparency).
        const opaque = buildFigure(f, { ...base, transparent: false });
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

export const SIZE_PRESETS = [
  { id: 'single', label: 'Single column, 3.5 × 2.6 in', width: 3.5, height: 2.6 },
  { id: 'double', label: 'Double column, 7 × 4 in', width: 7, height: 4 },
  { id: 'slide', label: 'Slide, 10 × 5.6 in', width: 10, height: 5.6 },
  { id: 'default', label: 'Default, 6.4 × 4.8 in', width: 6.4, height: 4.8 }
];

/* The figure panel's sizes: the same, and a square. */
export const FIGURE_SIZE_PRESETS = [
  ...SIZE_PRESETS.slice(0, 3),
  { id: 'square', label: 'Square, 4 × 4 in', width: 4, height: 4 },
  SIZE_PRESETS[3]
];

/* Presets change the look only: text, limits, tick positions, colours of
   the data and the export settings stay as they are. `series` is what each
   series takes (for the kinds it applies to). Dark also moves the series
   that have a colour of the light cycle to the same hue stepped for a dark
   background. */
const both = (t) => ({ xTicks: t, yTicks: t });
export const FIGURE_PRESETS = Object.freeze({
  publication: {
    figure: {
      width: 3.5, height: 2.6, fontSize: 8,
      ...both({ direction: 'in', length: 3, width: 0.6, minor: true, mirror: true }),
      spines: { top: true, right: true, width: 0.6 },
      grid: { show: false },
      legend: { fontSize: 7, frame: false }
    },
    series: { lineWidth: 1.2, size: 4, edgeWidth: 0.5, errorWidth: 0.6, capSize: 1.5, pointSize: 3 }
  },
  presentation: {
    figure: {
      width: 10, height: 5.6, fontSize: 18,
      ...both({ direction: 'out', length: 7, width: 1.5, minor: false, mirror: false }),
      spines: { top: false, right: false, width: 1.5 },
      grid: { show: true, minor: false, alpha: 0.35, width: 1, style: 'solid' },
      legend: { fontSize: 16, frame: false }
    },
    series: { lineWidth: 3.5, size: 9, edgeWidth: 1.5, errorWidth: 2, capSize: 0, pointSize: 7 }
  },
  minimal: {
    figure: {
      ...both({ direction: 'out', minor: false, mirror: false }),
      spines: { top: false, right: false },
      grid: { show: false },
      legend: { frame: false }
    },
    series: {}
  },
  dark: {
    figure: { background: '#0f172a', foreground: '#e2e8f0', grid: { color: '#64748b' } },
    series: {},
    darkCycle: true
  }
});

export const MARKER_NAMES = [['o', 'Circle'], ['s', 'Square'], ['^', 'Triangle, up'], ['v', 'Triangle, down'], ['D', 'Diamond'],
  ['x', 'Cross (×)'], ['+', 'Plus (+)'], ['.', 'Point'], ['none', 'None']];
export const LINE_NAMES = [['solid', 'Solid'], ['dashed', 'Dashed'], ['dotted', 'Dotted'], ['dashdot', 'Dash-dot']];
const FONT_NAMES = [['sans-serif', 'Sans-serif (Arial)'], ['serif', 'Serif (Times)'], ['monospace', 'Monospace (Courier)']];
export const LEGEND_NAMES = [['best', 'Best (least overlap)'], ['upper right', 'Upper right'], ['upper left', 'Upper left'],
  ['lower left', 'Lower left'], ['lower right', 'Lower right'], ['center left', 'Centre left'], ['center right', 'Centre right'],
  ['lower center', 'Lower centre'], ['upper center', 'Upper centre'], ['center', 'Centre'], ['outside right', 'Outside, right']];
const DIRECTION_NAMES = [['out', 'Outward'], ['in', 'Inward'], ['inout', 'Across the axis']];
const MODE_NAMES = [['auto', 'Automatic'], ['step', 'Every …'], ['count', 'About … ticks'], ['list', 'At listed values']];
const FORMAT_NAMES = [['', 'Automatic'], ['sci', 'Scientific, ×10ⁿ'], ['%.0f', 'Whole numbers'], ['%.1f', '1 decimal place'],
  ['%.2f', '2 decimal places'], ['%.3f', '3 decimal places'], ['%g', 'Shortest (%g)'], ['custom', 'Custom (printf)']];
const HISTTYPE_NAMES = [['stepfilled', 'Filled'], ['step', 'Outline'], ['bar', 'Bars']];
const KIND_NAMES = { line: 'Line', scatter: 'Points', errorbar: 'Points with error bars', band: 'Band', bar: 'Bars', histogram: 'Histogram',
  box: 'Box plot', heatmap: 'Heatmap', contour: 'Contours', hline: 'Horizontal line', vline: 'Vertical line', axline: 'Line', text: 'Text', bracket: 'Bracket' };

const clone = (o) => JSON.parse(JSON.stringify(o));
const getPath = (o, path) => path.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
function setPath(o, path, v) {
  const keys = path.split('.');
  const last = keys.pop();
  keys.reduce((a, k) => a[k], o)[last] = v;
}
/* Set a path, making the objects and arrays on the way (arrays copied from
   `like`, so that setting one end of a limit keeps the other). */
function putPath(o, path, v, like) {
  const keys = path.split('.');
  const last = keys.pop();
  let cur = o; let ref = like;
  for (const k of keys) {
    ref = ref == null ? ref : ref[k];
    if (cur[k] == null || typeof cur[k] !== 'object') cur[k] = Array.isArray(ref) ? clone(ref) : (/^\d+$/.test(k) ? {} : {});
    cur = cur[k];
  }
  cur[last] = v;
}
export function deepMerge(base, over) {
  const out = clone(base);
  for (const [k, v] of Object.entries(over)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(out[k] || {}, v) : v;
  }
  return out;
}
export const fmtNum = (v) => (v === null || v === undefined || !Number.isFinite(v) ? '' : String(Number(v.toPrecision(12))));
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
 * The parts every style panel is made of, bound to one object through
 * `read(path)` and `commit(path, value)`: fields for numbers, text, lists,
 * checkboxes, colours, ranges and segmented choices, the axis section (scale,
 * limits and ticks), groups, and the presets row. Each field registers how to
 * show its value; `refresh()` shows them all.
 *
 * Typed text and numbers are committed after 150 ms of quiet, everything
 * else at once.
 *
 * @param {{read: (path: string) => any, commit: (path: string, value: any) => void,
 *   batch: (fn: () => void) => void, open?: string[]}} bind - batch runs several
 *   writes and commits once (for the tick lists)
 */
export function stylePanelKit(bind) {
  const prefix = `fp${++panelCount}`;
  const controls = [];
  const timers = new Map();
  const cleanups = [];
  const idOf = (path) => `${prefix}-${path.replace(/[^\w]+/g, '-')}`;
  const { read, commit } = bind;
  const later = (key, fn) => {
    clearTimeout(timers.get(key));
    timers.set(key, setTimeout(() => { timers.delete(key); fn(); }, 150));
  };
  const listen = (node, type, fn) => { node.addEventListener(type, fn); cleanups.push(() => node.removeEventListener(type, fn)); };
  const hintEl = (id, text) => (text ? el('p', { class: 'stk-hint fp-hint', id }, text) : null);

  function field(path, label, control, { hint, span, unit } = {}) {
    const hid = hint ? `${idOf(path)}-hint` : null;
    if (hid) control.setAttribute('aria-describedby', hid);
    let body = control;
    if (unit) {
      // A unit that follows the figure (a function) is shown afresh each time.
      const tag = el('span', { 'aria-hidden': 'true', text: typeof unit === 'function' ? unit() : unit });
      if (typeof unit === 'function') controls.push({ show: () => { tag.textContent = unit(); } });
      body = el('div', { class: 'fp-unit' }, control, tag);
    }
    return el('div', { class: `stk-field fp-field${span ? ' fp-span' : ''}`, 'data-path': path },
      el('label', { for: control.id, text: label }), body, hintEl(hid, hint));
  }
  function number(path, label, { min, max, step = 'any', unit, nullable = false, placeholder, hint, span, scale = 1, limits, digits } = {}) {
    const input = el('input', { class: 'stk-input stk-input-sm', type: 'number', id: idOf(path), inputmode: 'decimal', min, max, step, placeholder });
    // The scale may follow the figure (a size typed in mm, say): a function.
    const k = () => (typeof scale === 'function' ? scale() : scale);
    const value = () => {
      const t = input.value.trim();
      if (t === '') return nullable ? null : undefined;
      const v = Number(t);
      return Number.isFinite(v) ? v / k() : undefined;
    };
    const apply = () => { const v = value(); if (v !== undefined) commit(path, v); };
    listen(input, 'input', () => later(path, apply));
    listen(input, 'change', () => { clearTimeout(timers.get(path)); apply(); show(); });
    const show = () => {
      if (limits) for (const [a, v] of Object.entries(limits())) input.setAttribute(a, v);
      if (document.activeElement === input && timers.has(path)) return;
      const v = read(path);
      const d = typeof digits === 'function' ? digits() : digits;
      input.value = v === null || v === undefined ? '' : d === undefined || d === null ? fmtNum(v * k()) : String(Number((v * k()).toFixed(d)));
    };
    controls.push({ show });
    return field(path, label, input, { hint, span, unit });
  }
  function text(path, label, { placeholder, hint, span = true, mono = false, onInput } = {}) {
    const input = el('input', { class: `stk-input stk-input-sm${mono ? ' stk-mono' : ''}`, type: 'text', id: idOf(path), placeholder, spellcheck: 'false', autocomplete: 'off' });
    listen(input, 'input', () => { if (onInput) onInput(); later(path, () => commit(path, input.value)); });
    listen(input, 'change', () => { clearTimeout(timers.get(path)); timers.delete(path); commit(path, input.value); });
    controls.push({ show: () => { if (!(document.activeElement === input && timers.has(path))) input.value = read(path) ?? ''; } });
    return field(path, label, input, { hint, span });
  }
  function select(path, label, choices, { hint, span } = {}) {
    const input = el('select', { class: 'stk-select stk-select-sm', id: idOf(path) },
      choices.map(([v, t]) => el('option', { value: v, text: t })));
    listen(input, 'change', () => commit(path, input.value));
    controls.push({ show: () => { input.value = String(read(path)); } });
    return field(path, label, input, { hint, span });
  }
  function check(path, label, { hint } = {}) {
    const input = el('input', { type: 'checkbox', id: idOf(path) });
    const hid = hint ? `${idOf(path)}-hint` : null;
    if (hid) input.setAttribute('aria-describedby', hid);
    listen(input, 'change', () => commit(path, input.checked));
    controls.push({ show: () => { input.checked = !!read(path); } });
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
      const v = hex6(read(path));
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
    controls.push({ show: () => { const v = Number(read(path)); input.value = Number.isFinite(v) ? v : ''; out.textContent = Number.isFinite(v) ? format(v) : ''; } });
    return el('div', { class: `stk-field fp-field${span ? ' fp-span' : ''}`, 'data-path': path },
      el('label', { for: input.id, text: label }), el('div', { class: 'fp-range' }, input, out));
  }
  function segmented(path, label, choices) {
    const gid = idOf(path);
    const buttons = choices.map(([v, t]) => el('button', { type: 'button', 'data-value': v, text: t, 'aria-pressed': 'false' }));
    const group = el('div', { class: 'stk-seg stk-seg-fill fp-seg', role: 'group', 'aria-labelledby': `${gid}-label` }, buttons);
    buttons.forEach((b) => listen(b, 'click', () => commit(path, b.dataset.value)));
    controls.push({ show: () => buttons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === String(read(path))))) });
    return el('div', { class: 'stk-field fp-field fp-span', 'data-path': path }, el('span', { class: 'stk-label-sm', id: `${gid}-label`, text: label }), group);
  }
  const grid = (...items) => el('div', { class: 'fp-grid' }, items);
  const checks = (...items) => el('div', { class: 'fp-checks' }, items);
  const sub = (title) => el('p', { class: 'fp-sub', text: title });

  /* Figure size presets */
  function sizePreset(list = SIZE_PRESETS) {
    const input = el('select', { class: 'stk-select stk-select-sm', id: `${prefix}-size` },
      el('option', { value: '', text: 'Custom' }), list.map((q) => el('option', { value: q.id, text: q.label })));
    listen(input, 'change', () => {
      const q = list.find((p) => p.id === input.value);
      if (q) bind.batch(() => { bind.put('width', q.width); bind.put('height', q.height); });
    });
    controls.push({ show: () => { const q = list.find((p) => Math.abs(p.width - read('width')) < 1e-9 && Math.abs(p.height - read('height')) < 1e-9); input.value = q ? q.id : ''; } });
    return field('size', 'Size', input, { span: true });
  }

  /*
   * One axis: scale, limits and everything about its ticks. `k` names it
   * ('x', 'y', or a panel's key) and the paths are `${base}Scale`,
   * `${base}Lim` and `${base}Ticks`.
   */
  function axisFields(k, base, { far = k === 'x' ? 'top' : 'right', categorical = false } = {}) {
    const T = `${base}Ticks`;
    const lists = (which) => {
      const path = `${T}.${which}`;
      const input = el('input', { class: 'stk-input stk-input-sm', type: 'text', id: idOf(path), spellcheck: 'false', autocomplete: 'off',
        placeholder: which === 'values' ? '0, 0.5, 1' : '0, ½, 1' });
      const readList = () => {
        bind.batch(() => {
          if (which === 'values') {
            const vals = input.value.split(/[,;\s]+/).filter(Boolean).map(Number).filter(Number.isFinite);
            bind.put(`${T}.values`, vals);
            bind.put(`${T}.labels`, (read(`${T}.labels`) || []).slice(0, vals.length));
          } else {
            bind.put(`${T}.labels`, input.value.trim() === '' ? [] : input.value.split(',').map((q) => q.trim()));
          }
        });
      };
      listen(input, 'input', () => later(path, readList));
      listen(input, 'change', () => { clearTimeout(timers.get(path)); timers.delete(path); readList(); });
      controls.push({ show: () => { if (!(document.activeElement === input && timers.has(path))) input.value = (which === 'values' ? (read(`${T}.values`) || []).map(fmtNum) : (read(`${T}.labels`) || [])).join(', '); } });
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
    const fmtHint = hintEl(`${idOf(fmtPath)}-hint`, 'A printf format with one number in it, such as %.1f or %.0e.');
    listen(fmtSelect, 'change', () => {
      customFormat = fmtSelect.value === 'custom';
      if (customFormat) { fmtCustom.hidden = false; fmtCustom.focus(); if (fmtCustom.value) commit(fmtPath, fmtCustom.value); else refresh(); } else commit(fmtPath, fmtSelect.value);
    });
    listen(fmtCustom, 'input', () => later(fmtPath, () => commit(fmtPath, fmtCustom.value)));
    listen(fmtCustom, 'change', () => { clearTimeout(timers.get(fmtPath)); timers.delete(fmtPath); commit(fmtPath, fmtCustom.value); });
    controls.push({
      show: () => {
        const f = read(fmtPath) || '';
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
    const fmtField = el('div', { class: 'stk-field fp-field fp-span', 'data-path': fmtPath },
      el('label', { for: fmtSelect.id, text: 'Label format' }), el('div', { class: 'fp-inline' }, fmtSelect, fmtCustom), fmtHint);
    fmtCustom.setAttribute('aria-describedby', fmtHint.id);

    const panel = el('div', { class: 'fp-axis', 'data-axis': k },
      grid(
        categorical ? null : segmented(`${base}Scale`, 'Scale', [['linear', 'Linear'], ['log', 'Logarithmic']]),
        number(`${base}Lim.0`, 'Minimum', { nullable: true, placeholder: 'Auto' }),
        number(`${base}Lim.1`, 'Maximum', { nullable: true, placeholder: 'Auto' }),
        el('p', { class: 'stk-hint fp-hint fp-span', text: categorical ? 'The groups sit at 0, 1, 2 …; leave empty for matplotlib\'s choice.' : 'Leave empty for matplotlib\'s choice.' })
      ),
      sub('Ticks'),
      grid(
        categorical ? null : select(`${T}.mode`, 'Place ticks', MODE_NAMES, { span: true }),
        categorical ? null : number(`${T}.step`, 'Every', { min: 0, nullable: true, placeholder: 'e.g. 0.5', span: true, hint: 'On a log axis, in decades.' }),
        categorical ? null : number(`${T}.count`, 'About this many', { min: 2, max: 50, step: 1, nullable: true, placeholder: '5', span: true }),
        categorical ? null : lists('values'),
        categorical ? null : lists('labels'),
        categorical ? null : fmtField,
        select(`${T}.direction`, 'Direction', DIRECTION_NAMES, { span: true }),
        number(`${T}.length`, 'Length', { min: 0, max: 20, step: 0.5, unit: 'pt' }),
        number(`${T}.width`, 'Width', { min: 0, max: 5, step: 0.1, unit: 'pt' })
      ),
      checks(
        categorical ? null : check(`${T}.minor`, 'Minor ticks'),
        check(`${T}.mirror`, `Marks on the ${far} too`)
      )
    );
    const showModes = () => {
      const mode = read(`${T}.mode`);
      panel.querySelectorAll(`[data-path="${T}.step"]`).forEach((n) => { n.hidden = mode !== 'step'; });
      panel.querySelectorAll(`[data-path="${T}.count"]`).forEach((n) => { n.hidden = mode !== 'count'; });
      panel.querySelectorAll(`[data-path="${T}.values"], [data-path="${T}.labels"]`).forEach((n) => { n.hidden = mode !== 'list'; });
    };
    controls.push({ show: showModes });
    return panel;
  }

  /* Tabs choosing one axis at a time: [{key, label, panel}] */
  function axisTabs(tabs) {
    let shown = tabs[0].key;
    const list = el('div', { class: 'stk-seg stk-seg-fill fp-axis-switch', role: 'tablist', 'aria-label': 'Axis' },
      tabs.map((t) => el('button', { type: 'button', role: 'tab', id: `${prefix}-tab-${t.key}`, 'data-axis': t.key, 'aria-selected': String(t.key === shown), 'aria-controls': `${prefix}-axis-${t.key}`, text: t.label })));
    tabs.forEach((t) => {
      t.panel.id = `${prefix}-axis-${t.key}`;
      t.panel.setAttribute('role', 'tabpanel');
      t.panel.setAttribute('aria-labelledby', `${prefix}-tab-${t.key}`);
    });
    const show = () => {
      tabs.forEach((t) => { t.panel.hidden = t.key !== shown; });
      list.querySelectorAll('button').forEach((b) => {
        const sel = b.dataset.axis === shown;
        b.setAttribute('aria-selected', String(sel));
        b.tabIndex = sel ? 0 : -1;
      });
    };
    list.querySelectorAll('button').forEach((b) => {
      listen(b, 'click', () => { shown = b.dataset.axis; show(); });
      listen(b, 'keydown', (e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        const i = tabs.findIndex((t) => t.key === shown);
        shown = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length].key;
        show();
        list.querySelector(`[data-axis="${shown}"]`).focus();
        e.preventDefault();
      });
    });
    controls.push({ show });
    return [list, ...tabs.map((t) => t.panel)];
  }

  /* Groups */
  const summaries = {};
  const groups = {};
  function group(key, title, ...body) {
    const summary = el('span', { class: 'fp-sum' });
    summaries[key] = summary;
    const open = (bind.open || ['figure']).includes(key);
    const d = el('details', { class: 'stk-disclosure fp-group', 'data-group': key, open },
      el('summary', {}, el('span', { class: 'fp-group-t', text: title }), summary),
      el('div', { class: 'fp-group-b' }, body));
    groups[key] = d;
    return d;
  }

  /* The top row: presets and a reset */
  function top(presetKeys) {
    const presetButtons = presetKeys.map((k) => el('button', { type: 'button', class: 'stk-btn stk-btn-sm', 'data-preset': k, text: k[0].toUpperCase() + k.slice(1) }));
    const resetButton = el('button', { type: 'button', class: 'stk-btn stk-btn-sm stk-btn-ghost fp-reset', text: 'Reset to defaults' });
    const node = el('div', { class: 'fp-top' },
      el('div', { class: 'fp-top-row' }, el('span', { class: 'fp-presets-t', id: `${prefix}-presets`, text: 'Start from a preset' }), resetButton),
      el('div', { class: 'fp-presets', role: 'group', 'aria-labelledby': `${prefix}-presets` }, presetButtons));
    return { node, presetButtons, resetButton };
  }

  /* The groups every figure has, in the Curve Fitter's order: figure, text,
     axes first; legend, grid, frame and export last. */
  /* A size typed in the unit the figure keeps (sizeUnit), stored in inches. */
  const unitOf = () => read('sizeUnit') || 'in';
  const perInch = () => unitsPerInch(unitOf(), read('dpi'));
  // Shown to a sensible precision in the unit: whole pixels, hundredths of a mm.
  const sizeDigits = () => ({ px: 0, mm: 2, cm: 3 }[unitOf()] ?? null);
  const sizeLimits = () => {
    const u = unitOf(); const kk = perInch();
    return { min: fmtNum(1 * kk), max: fmtNum(30 * kk), step: u === 'mm' || u === 'px' ? 1 : 0.1 };
  };
  const common = {
    figure: (opts = {}) => group('figure', 'Figure',
      grid(
        sizePreset(opts.sizes),
        opts.units ? segmented('sizeUnit', 'Size in', [['in', 'in'], ['cm', 'cm'], ['mm', 'mm'], ['px', 'px']]) : null,
        opts.units
          ? number('width', 'Width', { scale: perInch, unit: unitOf, limits: sizeLimits, digits: sizeDigits })
          : number('width', 'Width', { min: 1, max: 30, step: 0.1, unit: 'in' }),
        opts.units
          ? number('height', 'Height', { scale: perInch, unit: unitOf, limits: sizeLimits, digits: sizeDigits })
          : number('height', 'Height', { min: 1, max: 30, step: 0.1, unit: 'in' }),
        opts.units ? el('p', { class: 'stk-hint fp-hint fp-span', 'data-hint': 'px', text: 'Pixels at the PNG resolution set under Export.' }) : null,
        select('fontFamily', 'Font', FONT_NAMES),
        number('fontSize', 'Font size', { min: 4, max: 40, step: 0.5, unit: 'pt', hint: opts.textSizes ? 'Axis labels; ticks, title and legend follow unless set.' : 'Axis labels; ticks are 1 pt smaller, the title 1 pt larger.', span: false }),
        opts.textSizes ? number('titleSize', 'Title size', { min: 4, max: 60, step: 0.5, unit: 'pt', nullable: true, placeholder: 'Auto' }) : null,
        opts.textSizes ? number('tickSize', 'Tick labels', { min: 4, max: 60, step: 0.5, unit: 'pt', nullable: true, placeholder: 'Auto' }) : null,
        colour('background', 'Background'),
        colour('foreground', 'Text and lines')
      )),
    legend: (extra = []) => group('legend', 'Legend',
      checks(check('legend.show', 'Show the legend'), check('legend.frame', 'Frame')),
      grid(
        select('legend.position', 'Position', LEGEND_NAMES, { span: true }),
        number('legend.fontSize', 'Font size', { min: 4, max: 40, step: 0.5, unit: 'pt' }),
        ...extra
      )),
    grid: (opts = {}) => group('grid', 'Grid',
      checks(check('grid.show', 'Grid lines'), check('grid.minor', 'At minor ticks too')),
      grid(
        opts.axis ? select('grid.axis', 'Lines', [['both', 'At both axes\u2019 ticks'], ['x', 'At the x ticks (vertical)'], ['y', 'At the y ticks (horizontal)']], { span: true }) : null,
        colour('grid.color', 'Colour'),
        range('grid.alpha', 'Opacity', { min: 0, max: 1, step: 0.05 }),
        select('grid.style', 'Style', LINE_NAMES),
        number('grid.width', 'Width', { min: 0.1, max: 5, step: 0.1, unit: 'pt' })
      )),
    frame: () => group('frame', 'Frame',
      checks(check('spines.top', 'Top'), check('spines.right', 'Right')),
      grid(number('spines.width', 'Line width', { min: 0, max: 5, step: 0.1, unit: 'pt' })),
      el('p', { class: 'stk-hint fp-hint', text: 'The left and bottom lines are always drawn.' })),
    export: (opts = {}) => group('export', 'Export',
      grid(
        segmented('export.format', 'Format', [['pdf', 'PDF'], ['png', 'PNG'], ['svg', 'SVG']]),
        text('export.filename', 'File name', { mono: true }),
        // The header's PNG button uses it whatever the format chosen here, so
        // a page may keep it in view (dpiAlways).
        opts.dpiAlways
          ? number('dpi', 'PNG resolution', { min: 50, max: 1200, step: 1, unit: 'dpi', span: true })
          : number('dpi', 'Resolution', { min: 50, max: 1200, step: 1, unit: 'dpi', span: true })
      ),
      checks(
        check('export.transparent', 'Transparent background'),
        check('export.tight', 'Fit the page to the drawing', { hint: 'Trims the page to what is drawn plus 0.1 in, as bbox_inches=\'tight\' does, so the saved size is a little larger or smaller than the width and height set above.' })
      ))
  };

  /* Summaries shared by both panels */
  function commonSummaries() {
    const on = (b) => (b ? 'On' : 'Off');
    const u = read('sizeUnit') || 'in';
    const size = u === 'in' ? `${fmtNum(read('width'))} × ${fmtNum(read('height'))} in`
      : `${formatSize(read('width'), u, read('dpi')).split(' ')[0]} × ${formatSize(read('height'), u, read('dpi'))}`;
    return {
      figure: `${size}, ${fmtNum(read('fontSize'))} pt`,
      text: read('title') ? 'Title set' : '',
      legend: read('legend.show') ? (LEGEND_NAMES.find(([v]) => v === read('legend.position')) || [])[1] : 'Hidden',
      grid: on(read('grid.show')),
      frame: read('spines.top') && read('spines.right') ? 'Box' : read('spines.top') || read('spines.right') ? 'Three sides' : 'Two sides',
      export: `${String(read('export.format')).toUpperCase()}${read('export.format') === 'png' ? `, ${read('dpi')} dpi` : ''}`
    };
  }

  let root = null;
  const extraRefresh = [];
  function refresh() {
    controls.forEach((c) => c.show());
    if (root && !bind.dpiAlways) root.querySelectorAll('[data-path="dpi"]').forEach((n) => { n.hidden = read('export.format') !== 'png'; });
    if (root) root.querySelectorAll('[data-hint="px"]').forEach((n) => { n.hidden = read('sizeUnit') !== 'px'; });
    extraRefresh.forEach((f) => f());
  }

  return {
    prefix, el, idOf, listen, later, timers, cleanups, controls, summaries, groups,
    field, number, text, select, check, colour, range, segmented, grid, checks, sub, hintEl,
    sizePreset, axisFields, axisTabs, group, top, common, commonSummaries, refresh,
    onRefresh: (f) => extraRefresh.push(f),
    setRoot: (r) => { root = r; },
    destroy() {
      timers.forEach((t) => clearTimeout(t));
      timers.clear();
      cleanups.forEach((f) => f());
    }
  };
}

/* The fields of a series, by kind. */
function seriesFields(kit, q, path) {
  const { number, text, select, check, colour, range, grid, checks } = kit;
  const p = (k) => `${path}.${k}`;
  const out = [];
  const topChecks = [check(p('show'), 'Show')];
  if (LEGEND_KINDS.has(q.kind)) topChecks.push(check(p('legend'), 'In the legend'));
  out.push(checks(...topChecks));
  const f = [];
  if (LEGEND_KINDS.has(q.kind)) f.push(text(p('label'), 'Legend label', { placeholder: 'None: not in the legend' }));
  switch (q.kind) {
    case 'line':
      f.push(colour(p('color'), 'Colour'), number(p('lineWidth'), 'Width', { min: 0, max: 20, step: 0.1, unit: 'pt' }),
        select(p('lineStyle'), 'Style', LINE_NAMES), select(p('marker'), 'Marker', MARKER_NAMES),
        number(p('size'), 'Marker size', { min: 0, max: 40, step: 0.5, unit: 'pt' }), range(p('alpha'), 'Opacity', { min: 0, max: 1, step: 0.05 }));
      break;
    case 'scatter': case 'errorbar':
      f.push(select(p('marker'), 'Marker', q.kind === 'scatter' ? MARKER_NAMES.filter(([v]) => v !== 'none') : MARKER_NAMES),
        number(p('size'), 'Size', { min: 0, max: 40, step: 0.5, unit: 'pt' }), colour(p('color'), 'Fill'), colour(p('edgeColor'), 'Edge'),
        number(p('edgeWidth'), 'Edge width', { min: 0, max: 10, step: 0.1, unit: 'pt' }), range(p('alpha'), 'Opacity', { min: 0, max: 1, step: 0.05 }));
      if (q.kind === 'errorbar') {
        f.push(number(p('errorWidth'), 'Error bar width', { min: 0.1, max: 10, step: 0.1, unit: 'pt' }),
          number(p('capSize'), 'Cap size', { min: 0, max: 20, step: 0.5, unit: 'pt' }));
        // Points the page joins with a line: its style and width too.
        if (q.lineStyle && q.lineStyle !== 'none') {
          f.push(select(p('lineStyle'), 'Joining line', [['none', 'None'], ...LINE_NAMES]),
            number(p('lineWidth'), 'Line width', { min: 0, max: 20, step: 0.1, unit: 'pt' }));
        }
      }
      break;
    case 'band':
      f.push(colour(p('color'), 'Colour'), range(p('alpha'), 'Opacity', { min: 0, max: 1, step: 0.02 }));
      break;
    case 'bar':
      f.push(colour(p('color'), 'Fill'), colour(p('edgeColor'), 'Edge'), number(p('edgeWidth'), 'Edge width', { min: 0, max: 10, step: 0.1, unit: 'pt' }),
        range(p('alpha'), 'Opacity', { min: 0, max: 1, step: 0.05 }), range(p('width'), 'Bar width', { min: 0.1, max: 1, step: 0.05 }),
        number(p('capSize'), 'Cap size', { min: 0, max: 20, step: 0.5, unit: 'pt' }));
      break;
    case 'histogram':
      f.push(select(p('histtype'), 'Drawn as', HISTTYPE_NAMES), colour(p('color'), 'Fill'), colour(p('edgeColor'), 'Edge'),
        number(p('edgeWidth'), 'Edge width', { min: 0, max: 10, step: 0.1, unit: 'pt' }), range(p('alpha'), 'Opacity', { min: 0, max: 1, step: 0.05 }));
      break;
    case 'box':
      f.push(colour(p('color'), 'Colour'), colour(p('medianColor'), 'Median'), range(p('faceAlpha'), 'Fill opacity', { min: 0, max: 1, step: 0.05 }),
        number(p('lineWidth'), 'Line width', { min: 0, max: 10, step: 0.1, unit: 'pt' }), range(p('width'), 'Box width', { min: 0.1, max: 1, step: 0.05 }),
        number(p('pointSize'), 'Point size', { min: 0, max: 30, step: 0.5, unit: 'pt' }));
      out.push(checks(check(p('points'), 'Points'), check(p('mean'), 'Mean and interval'), check(p('fliers'), 'Outliers')));
      break;
    case 'heatmap': case 'contour':
      f.push(select(p('colormap'), 'Colour map', COLORMAPS.map((c) => [c, c])));
      if (q.kind === 'contour') {
        if (!Array.isArray(q.levels)) f.push(number(p('levels'), 'Levels', { min: 1, max: 100, step: 1, hint: 'About this many; matplotlib picks round values.' }));
        if (!q.filled) f.push(number(p('lineWidth'), 'Line width', { min: 0, max: 10, step: 0.1, unit: 'pt' }));
      }
      f.push(number(p('vmin'), 'Colour from', { nullable: true, placeholder: 'Auto' }), number(p('vmax'), 'Colour to', { nullable: true, placeholder: 'Auto' }));
      if (q.colorbar && (q.kind === 'heatmap' || q.filled)) out.push(checks(check(p('colorbar.show'), 'Colour bar')));
      break;
    case 'hline': case 'vline': case 'axline':
      f.push(colour(p('color'), 'Colour'), number(p('lineWidth'), 'Width', { min: 0, max: 20, step: 0.1, unit: 'pt' }), select(p('lineStyle'), 'Style', LINE_NAMES));
      break;
    case 'text': case 'bracket':
      f.push(colour(p('color'), 'Colour'), number(p('fontSize'), 'Font size', { min: 4, max: 60, step: 0.5, unit: 'pt' }));
      break;
    default: break;
  }
  out.push(grid(...f));
  return out;
}

/* The look of a normalised figure as the figure panel edits it. */
function lookOfFigure(f, keyOf = (id) => id) {
  const look = {};
  for (const k of LOOK_KEYS.figure) look[k] = clone(f[k]);
  look.panels = f.panels.map((p) => {
    const o = {};
    for (const k of LOOK_KEYS.panel) o[k] = clone(p[k]);
    return o;
  });
  look.series = {};
  for (const p of f.panels) {
    for (const q of p.series) {
      const o = {};
      for (const k of LOOK_KEYS.series) if (q[k] !== undefined) o[k] = clone(q[k]);
      look.series[keyOf(q.id)] = o;
    }
  }
  return look;
}

/**
 * The panel that styles any figure: the Curve Fitter's groups, in its order
 * (figure, title and labels, axes and ticks, then a section for each series
 * in place of its data, fit and band, then legend, grid, frame and export),
 * with the size presets, three look presets and a reset.
 *
 * The panel edits the person's style, a partial object laid over the page's
 * description (see applyStyle in src/core/figure.js): every change calls
 * `onChange` with the whole of it.
 *
 * @param {HTMLElement} host
 * @param {object} figure - the page's description, for the panels and series to offer
 * @param {object} style  - the person's style so far
 * @param {(style: object) => void} onChange
 * @param {{open?: string[]}} [options] - groups open at the start (default ['figure'])
 * @returns {{get: () => object, set: (style: object) => void, setFigure: (figure: object) => void,
 *   showSeries: (id: string) => boolean, destroy: () => void, element: HTMLElement}}
 */
export function createFigureStylePanel(host, figure, style, onChange, options = {}) {
  let desc = figure || {};
  let overrides = cleanStyle(style);
  let look = null;
  // Series are addressed in the panel's paths by a key of their own (s0, s1 …):
  // a page's id may hold dots or spaces, which a dotted path cannot.
  let keys = new Map(); let ids = new Map();
  const keyOf = (id) => keys.get(id);
  const resolve = () => {
    const f = normaliseFigure(applyStyle(lookOnly(desc), overrides));
    keys = new Map(); ids = new Map();
    f.panels.flatMap((p) => p.series).forEach((q, i) => { keys.set(q.id, `s${i}`); ids.set(`s${i}`, q.id); });
    look = lookOfFigure(f, keyOf);
  };
  resolve();
  let batching = false;
  const emit = () => {
    resolve();
    kit.refresh();
    if (typeof onChange === 'function') onChange(clone(overrides));
  };
  const bind = {
    open: options.open,
    dpiAlways: true,
    read: (path) => getPath(look, path),
    put: (path, value) => {
      const parts = path.split('.');
      if (parts[0] === 'series' && ids.has(parts[1])) {
        const id = ids.get(parts[1]);
        if (!overrides.series || typeof overrides.series !== 'object') overrides.series = {};
        if (!overrides.series[id] || typeof overrides.series[id] !== 'object') overrides.series[id] = {};
        putPath(overrides.series[id], parts.slice(2).join('.'), value, look.series[parts[1]]);
      } else {
        putPath(overrides, path, value, look);
      }
      putPath(look, path, value, look);
    },
    commit: (path, value) => { bind.put(path, value); if (!batching) emit(); },
    batch: (fn) => { batching = true; try { fn(); } finally { batching = false; } emit(); }
  };
  const kit = stylePanelKit(bind);
  const { el: h, group, grid, text, number, select, checks, check, common } = kit;
  const root = h('div', { class: 'fp-panel' });
  kit.setRoot(root);

  let seriesShown = null;
  let pickSeries = () => false;
  function build() {
    root.textContent = '';
    const f = normaliseFigure(applyStyle(lookOnly(desc), overrides));
    const top = kit.top(Object.keys(FIGURE_PRESETS));
    top.node.querySelector('.fp-presets').classList.add('fp-presets-4');
    // Title and labels: the figure's, each panel's y label, each colour bar's.
    const labelFields = [text('title', 'Title', { placeholder: 'None' }), text('xLabel', 'x-axis label')];
    f.panels.forEach((p, i) => {
      const name = f.panels.length > 1 ? `y-axis label, ${p.name || `panel ${i + 1}`}` : 'y-axis label';
      labelFields.push(text(`panels.${i}.yLabel`, name));
      p.series.filter((q) => q.colorbar && q.colorbar.show !== undefined && (q.kind === 'heatmap' || q.filled)).forEach((q) => {
        labelFields.push(text(`series.${keyOf(q.id)}.colorbar.label`, f.panels.length > 1 ? `Colour bar label, ${p.name || `panel ${i + 1}`}` : 'Colour bar label'));
      });
    });
    labelFields.push(h('p', { class: 'stk-hint fp-hint fp-span', text: 'Put maths between $ signs, as matplotlib does: $\\tau$ / ms, $x^2$, $E_a$.' }));
    // Axes: x, then a y for each panel.
    const tabs = [{ key: 'x', label: 'x axis', panel: kit.axisFields('x', 'x', { categorical: !!f.xCategories }) }];
    f.panels.forEach((p, i) => {
      tabs.push({ key: `y${i}`, label: f.panels.length > 1 ? `y, ${p.name || i + 1}` : 'y axis', panel: kit.axisFields(`y${i}`, `panels.${i}.y`, { far: 'right' }) });
    });
    // Series: one at a time.
    const all = f.panels.flatMap((p) => p.series.map((q) => ({ q, p })));
    const named = (q) => q.label || (q.kind === 'text' || q.kind === 'bracket' ? `${KIND_NAMES[q.kind]}: ${q.text}` : KIND_NAMES[q.kind]);
    if (!all.some((a) => a.q.id === seriesShown)) seriesShown = all.length ? all[0].q.id : null;
    const seriesBody = [];
    if (all.length > 1) {
      const pick = h('select', { class: 'stk-select stk-select-sm', id: `${kit.prefix}-series` },
        all.map(({ q, p }) => h('option', { value: q.id, text: f.panels.length > 1 ? `${named(q)} (${p.name || `panel ${f.panels.indexOf(p) + 1}`})` : named(q) })));
      pick.value = seriesShown;
      kit.listen(pick, 'change', () => { seriesShown = pick.value; showSeries(); });
      seriesBody.push(kit.field('series', 'Series', pick, { span: true }));
    }
    const sections = all.map(({ q }) => {
      const node = h('div', { class: 'fp-series', 'data-series': q.id }, seriesFields(kit, q, `series.${keyOf(q.id)}`));
      return node;
    });
    const showSeries = () => sections.forEach((n) => { n.hidden = n.dataset.series !== seriesShown; });
    pickSeries = (id) => {
      if (!all.some((a) => a.q.id === id)) return false;
      seriesShown = id;
      const select = root.querySelector(`#${kit.prefix}-series`);
      if (select) select.value = id;
      showSeries();
      return true;
    };
    seriesBody.push(...sections);
    const legendExtra = [text('legend.title', 'Title', { placeholder: 'None' }), number('legend.columns', 'Columns', { min: 1, max: 10, step: 1 })];
    root.append(...[
      top.node,
      common.figure({ units: true, textSizes: true, sizes: FIGURE_SIZE_PRESETS }),
      group('text', 'Title and labels', grid(...labelFields)),
      group('axes', 'Axes and ticks', ...kit.axisTabs(tabs)),
      all.length ? group('series', all.length > 1 ? 'Series' : named(all[0].q), ...seriesBody) : null,
      f.panels.length > 1 ? group('panels', 'Panels', grid(...f.panels.map((p, i) => kit.range(`panels.${i}.ratio`, `Height, ${p.name || `panel ${i + 1}`}`, { min: 0.2, max: 3, step: 0.05, format: (v) => `${Math.round(v * 100)}%` })))) : null,
      common.legend(legendExtra),
      common.grid({ axis: true }),
      common.frame(),
      common.export({ dpiAlways: true })
    ].filter(Boolean));
    showSeries();
    top.presetButtons.forEach((b) => kit.listen(b, 'click', () => {
      const preset = FIGURE_PRESETS[b.dataset.preset];
      overrides = deepMerge(overrides, preset.figure);
      // Tick looks go to every panel's y axis too.
      const yt = preset.figure.yTicks;
      if (yt) overrides.panels = f.panels.map((_, i) => deepMerge((overrides.panels || [])[i] || {}, { yTicks: yt }));
      const ser = { ...(overrides.series || {}) };
      for (const { q } of all) {
        const o = {};
        for (const [k, v] of Object.entries(preset.series)) {
          const applies = k === 'size' ? ['scatter', 'errorbar', 'line'].includes(q.kind) : q[k] !== undefined;
          if (applies) o[k] = v;
        }
        // A colour of the light cycle becomes the same hue for a dark ground.
        if (preset.darkCycle) {
          for (const key of ['color', 'edgeColor']) {
            const k = COLOR_CYCLE.indexOf(q[key]);
            if (k >= 0) o[key] = COLOR_CYCLE_DARK[k];
          }
        }
        if (Object.keys(o).length) ser[q.id] = { ...(ser[q.id] || {}), ...o };
      }
      overrides.series = ser;
      emit();
    }));
    kit.listen(top.resetButton, 'click', () => { overrides = {}; emit(); });
  }
  kit.onRefresh(() => {
    const sums = kit.commonSummaries();
    sums.axes = `${look.xScale === 'log' ? 'Log' : 'Linear'} × ${look.panels.map((p) => (p.yScale === 'log' ? 'log' : 'linear')).join(', ')}`;
    const n = Object.keys(look.series).length;
    sums.series = n > 1 ? `${n} series` : '';
    sums.panels = `${look.panels.length} panels`;
    for (const [k, node] of Object.entries(kit.summaries)) node.textContent = sums[k] || '';
  });
  build();
  host.appendChild(root);
  kit.refresh();

  return {
    element: root,
    get: () => clone(overrides),
    set(next) {
      overrides = cleanStyle(next);
      resolve();
      kit.refresh();
    },
    /** Open the Series group on one series; false if there is no such series. */
    showSeries(id) {
      if (!pickSeries(String(id))) return false;
      const g = kit.groups.series;
      if (g) {
        g.open = true;
        if (g.scrollIntoView) g.scrollIntoView({ block: 'nearest' });
        const first = g.querySelector('.fp-series:not([hidden]) input, .fp-series:not([hidden]) select');
        if (first) first.focus({ preventScroll: true });
      }
      return true;
    },
    setFigure(next) {
      const before = JSON.stringify(lookShape(desc));
      desc = next || {};
      resolve();
      // Rebuild when the panels or series changed; otherwise only show.
      if (JSON.stringify(lookShape(desc)) !== before) {
        kit.controls.length = 0;
        build();
      }
      kit.refresh();
    },
    destroy() {
      kit.destroy();
      root.remove();
    }
  };
}

/* What the panel's fields depend on: the panels, and each series' id and kind. */
function lookShape(desc) {
  const f = normaliseFigure(lookOnly(desc));
  return { cat: !!f.xCategories, panels: f.panels.map((p) => ({ name: p.name, series: p.series.map((q) => [q.id, q.kind, q.filled, q.label, q.text]) })) };
}

/* ------------------------------------------------------------------ *
 * The plot area every page shares
 * ------------------------------------------------------------------ */

let mountCount = 0;

/**
 * The standard plot area: a header with the title, the size of the saved
 * figure, the page's own quick toggles, a Style button and PDF, PNG and SVG;
 * the preview at the true size, scaled to fit; what the preview cannot show;
 * the style panel (in a host the page gives, or a drawer of its own); and the
 * Python panel (js/python-panel.js) with the matplotlib script that draws the
 * same figure.
 *
 * The page describes what to draw (src/core/figure.js) and calls update()
 * whenever its data change. The look the person sets is kept apart, as a
 * partial style laid over the page's description, so it survives new data:
 * getStyle() returns it for the page to store, setStyle() restores it.
 *
 * @param {HTMLElement} host - the component fills it
 * @param {object} [options]
 * @param {string} [options.title='Plot']       - the header's title
 * @param {string} [options.titleId]            - id for the title (for aria-labelledby)
 * @param {boolean} [options.framed=true]       - a card of its own; false inside a page's panel
 * @param {object} [options.figure]             - the first description to draw
 * @param {object} [options.style]              - the person's stored style
 * @param {(style: object) => void} [options.onStyleChange] - to store the style
 * @param {HTMLElement|null} [options.styleHost] - where the style panel goes; without it a drawer
 * @param {string|((figure: object) => string)} [options.styleTitle] - the style drawer's title
 *   (default 'Style: <title>'); a function is asked again on each update()
 * @param {{side?: 'left'|'right'}} [options.styleDrawer] - the drawer's side on a wide screen (right;
 *   left for a page whose figure sits on the right); on a phone it is a sheet from the bottom
 * @param {boolean} [options.stylePanel=true]   - false: the page styles the figure itself and
 *   passes complete descriptions (the Curve Fitter)
 * @param {(what: {series?: string}) => void} [options.onStyle] - what the Style button and openStyle do
 *   (default: show the panel, on one series when openStyle({ series: id }) names it)
 * @param {{id: string, label: string, checked?: boolean, hidden?: boolean,
 *   onChange: (checked: boolean) => void}[]} [options.toggles] - quick switches in the header
 * @param {{icon?: string, title?: string, text?: string, action?: {label: string, icon?: string,
 *   id?: string, onClick: () => void}}} [options.empty] - what the stage says before there is a figure
 * @param {number|(() => number)} [options.maxScale=2] - largest enlargement of the preview
 * @param {string} [options.label]              - what the figure shows, for screen readers
 * @param {string} [options.styleButtonId]      - id for the Style button
 * @param {(result: object|null, error: Error|null, format: string) => void} [options.onExport]
 * @param {(info: object) => void} [options.onDraw]
 * @param {object|false} [options.python]       - the Python panel (js/python-panel.js):
 *   { host, title?, filename? (pinned: the badge keeps it), initialFilename? (shown until there is a
 *   figure, whose export name then wins), headingLevel?, sources?: [{id, label}] (use the ids 'embed' and
 *   'files'), source?, onSourceChange?, note? (text, or (figure, source) => html),
 *   files?, header?, imports?, prelude? (passed to figureScript), script? ((figure, source) =>
 *   string, to write the script another way), create? (a createPythonPanel to use instead) }
 * @returns {{update: (figure: object|null) => Promise<object|null>, setStyle: (style: object) => void,
 *   getStyle: () => object, export: (format: string) => Promise<object>,
 *   openStyle: (what?: {series?: string}) => void, setTitle: (text: string) => void,
 *   closeStyle: () => void, setToggle: (id: string, state: object) => void, info: () => object|null,
 *   figure: () => object|null, element: HTMLElement, destroy: () => void}}
 */
export function mountFigure(host, options = {}) {
  const n = ++mountCount;
  const ids = { title: options.titleId || `fg${n}-title`, notes: `fg${n}-notes` };
  const managed = options.stylePanel !== false;
  let desc = options.figure || null;
  let style = cleanStyle(options.style || {});
  let lastInfo = null;
  let resolved = null;
  let panel = null;
  let drawer = null;
  let python = null;
  let pySource = options.python ? (options.python.source || (options.python.sources && options.python.sources[0] ? options.python.sources[0].id : 'embed')) : null;
  let destroyed = false;
  const cleanups = [];
  const listen = (node, type, fn) => { node.addEventListener(type, fn); cleanups.push(() => node.removeEventListener(type, fn)); };
  const h = el;

  host.classList.add('fg');
  if (options.framed !== false && !host.querySelector(':scope > .fg-h')) host.classList.add('fg-card');

  /*
   * The parts: taken from the host when the page wrote them in its HTML (so
   * the header and the empty stage show before any script has run), made
   * here otherwise.
   */
  const found = (sel) => host.querySelector(sel);
  const adopted = !!found(':scope > .fg-h');
  const toggles = new Map();
  let header; let size; let styleBtn; let exportBtns; let empty; let figureEl; let stage; let notes;
  if (adopted) {
    header = found(':scope > .fg-h');
    size = found('.fg-size');
    styleBtn = found('[data-fg-style]');
    exportBtns = Array.from(host.querySelectorAll('.fg-export [data-export]'));
    stage = found('.fg-stage');
    empty = found('.fg-empty');
    figureEl = found('.fg-figure');
    notes = found('.fg-notes');
    host.querySelectorAll('.fg-toggle input').forEach((input) => toggles.set(input.id, { input, label: input.closest('.fg-toggle') }));
  } else {
    size = h('span', { class: 'fg-size stk-tnum', title: 'The size of the saved figure' });
    const toggleNodes = (options.toggles || []).map((t) => {
      const input = h('input', { type: 'checkbox', id: t.id || null });
      input.checked = !!t.checked;
      listen(input, 'change', () => t.onChange && t.onChange(input.checked));
      const label = h('label', { class: 'fg-toggle', id: t.wrapId || null }, input, ' ', h('span', { text: t.label }));
      label.hidden = !!t.hidden;
      toggles.set(t.id, { input, label });
      return label;
    });
    styleBtn = h('button', { type: 'button', class: 'stk-btn stk-btn-sm stk-btn-ghost', id: options.styleButtonId || null, 'data-fg-style': '',
      'aria-haspopup': managed && !options.styleHost && !options.onStyle ? 'dialog' : null },
      h('i', { class: 'fa-solid fa-sliders', 'aria-hidden': 'true' }), ' Style');
    exportBtns = ['pdf', 'png', 'svg'].map((f, i) => h('button', { type: 'button', class: 'stk-btn stk-btn-sm', 'data-export': f, disabled: true },
      i === 0 ? h('i', { class: 'fa-solid fa-download', 'aria-hidden': 'true' }) : null, i === 0 ? ' PDF' : f.toUpperCase()));
    header = h('div', { class: 'fg-h' },
      h('h2', { class: 'fg-t', id: ids.title, text: options.title || 'Plot' }),
      size,
      h('div', { class: 'fg-actions' }, ...toggleNodes, styleBtn,
        h('div', { class: 'fg-export', role: 'group', 'aria-label': 'Export the figure' }, ...exportBtns)));
    const e = options.empty || {};
    const emptyAction = e.action
      ? h('button', { type: 'button', class: 'stk-btn stk-btn-sm', id: e.action.id || null },
        e.action.icon ? h('i', { class: `fa-solid ${e.action.icon}`, 'aria-hidden': 'true' }) : null, e.action.icon ? ' ' : null, e.action.label)
      : null;
    if (emptyAction) listen(emptyAction, 'click', () => e.action.onClick && e.action.onClick());
    empty = h('div', { class: 'fg-empty' },
      h('i', { class: `fa-solid ${e.icon || 'fa-chart-line'}`, 'aria-hidden': 'true' }),
      h('p', { class: 'fg-empty-title', text: e.title || 'The figure will appear here' }),
      e.text ? h('p', { class: 'fg-empty-text', text: e.text }) : null,
      emptyAction);
    figureEl = h('div', { class: 'fg-figure' });
    figureEl.hidden = true;
    stage = h('div', { class: 'fg-stage' }, empty, figureEl);
    notes = h('div', { class: 'fg-notes', id: ids.notes });
    notes.hidden = true;
    host.append(header, stage, notes);
  }
  exportBtns.forEach((b) => listen(b, 'click', () => exportAs(b.dataset.export, b)));
  const status = h('p', { class: 'sr-only', role: 'status', 'aria-live': 'polite' });
  host.append(status);
  if (options.label) figureEl.setAttribute('aria-label', options.label);

  /* Style */
  function openStyle(what = {}) {
    const series = what && typeof what === 'object' && !(typeof Event !== 'undefined' && what instanceof Event) ? what.series : undefined;
    if (typeof options.onStyle === 'function') { options.onStyle(series !== undefined ? { series } : {}); return; }
    if (!managed) return;
    if (options.styleHost) {
      if (series !== undefined && panel && panel.showSeries(series)) return;
      const first = options.styleHost.querySelector('details, button, input, select');
      if (options.styleHost.scrollIntoView) options.styleHost.scrollIntoView({ block: 'nearest' });
      if (first) first.focus({ preventScroll: true });
      return;
    }
    ensureDrawer();
    if (!drawer.open) drawer.show();
    if (series !== undefined && panel && panel.showSeries(series)) return;
    // On a phone the panel is a sheet over the lower part of the screen: the
    // figure goes to the top, where it stays in view while it changes.
    if (typeof matchMedia === 'function' && matchMedia('(max-width: 639.98px)').matches && stage.scrollIntoView) stage.scrollIntoView({ block: 'start' });
    const close = drawer.querySelector('.fg-drawer-close');
    if (close) close.focus();
  }
  function closeStyle() {
    if (drawer && drawer.open) { drawer.close(); if (styleBtn) styleBtn.focus(); }
  }
  function ensurePanel(target) {
    if (panel || !managed) return;
    panel = createFigureStylePanel(target, desc || {}, style, (next) => {
      style = next;
      if (typeof options.onStyleChange === 'function') options.onStyleChange(clone(style));
      draw();
    });
  }
  /* The drawer's title: which figure it styles, on a page with several. */
  let drawerTitle = null;
  let headerTitle = options.title || '';
  function styleTitleText() {
    const t = typeof options.styleTitle === 'function' ? options.styleTitle(resolved || desc) : options.styleTitle;
    if (typeof t === 'string' && t.trim()) return t;
    return headerTitle ? `Style: ${headerTitle}` : 'Style';
  }
  const showStyleTitle = () => { if (drawerTitle) drawerTitle.textContent = styleTitleText(); };
  function ensureDrawer() {
    if (drawer) return;
    const body = h('div', { class: 'fg-drawer-b' });
    const title = h('h2', { class: 'fg-drawer-t', id: `fg${n}-style`, text: styleTitleText() });
    drawerTitle = title;
    const close = h('button', { type: 'button', class: 'stk-btn stk-btn-sm stk-btn-ghost stk-btn-icon fg-drawer-close', 'aria-label': 'Close the style panel' },
      h('i', { class: 'fa-solid fa-xmark', 'aria-hidden': 'true' }));
    const side = options.styleDrawer && options.styleDrawer.side === 'left' ? ' fg-drawer-left' : '';
    drawer = h('dialog', { class: `fg-drawer${side}`, 'aria-labelledby': title.id },
      h('div', { class: 'fg-drawer-h' }, title, close), body);
    listen(close, 'click', closeStyle);
    listen(drawer, 'keydown', (ev) => { if (ev.key === 'Escape') { ev.preventDefault(); closeStyle(); } });
    document.body.appendChild(drawer);
    ensurePanel(body);
  }
  if (styleBtn) listen(styleBtn, 'click', () => openStyle());
  if (managed && options.styleHost) ensurePanel(options.styleHost);

  /* The saved size in the figure's unit: 6.52 × 4.92 in, 85 × 64 mm. */
  const sizeText = (w, hIn) => {
    const u = resolved && resolved.sizeUnit ? resolved.sizeUnit : 'in';
    if (u === 'in') return `${fmtIn(w)} × ${fmtIn(hIn)} in`;
    return `${formatSize(w, u, resolved.dpi).split(' ')[0]} × ${formatSize(hIn, u, resolved.dpi)}`;
  };

  /* Drawing */
  const resolve = () => (desc ? normaliseFigure(managed ? applyStyle(desc, style) : desc) : null);
  let drawing = Promise.resolve(null);
  function draw() {
    if (destroyed) return drawing;
    resolved = resolve();
    const has = !!resolved;
    empty.hidden = has;
    figureEl.hidden = !has;
    exportBtns.forEach((b) => { b.disabled = !has; });
    if (!has) {
      stage.classList.remove('is-drawn');
      notes.hidden = true;
      if (size) size.textContent = '';
      renderPython();
      return (drawing = Promise.resolve(null));
    }
    drawing = renderFigure(figureEl, resolved, { maxScale: options.maxScale, label: options.label }).then((info) => {
      lastInfo = info;
      stage.classList.add('is-drawn');
      if (info && Number.isFinite(info.widthIn) && size) size.textContent = sizeText(info.widthIn, info.heightIn);
      const list = info && Array.isArray(info.notes) ? info.notes : [];
      notes.textContent = '';
      list.forEach((t) => notes.appendChild(h('p', { text: t })));
      notes.hidden = !list.length;
      if (typeof options.onDraw === 'function') options.onDraw(info);
      return info;
    }).catch((err) => {
      notes.textContent = '';
      notes.appendChild(h('p', { text: `The plot could not be drawn: ${err && err.message ? err.message : String(err)}` }));
      notes.hidden = false;
      return null;
    });
    renderPython();
    return drawing;
  }

  async function exportAs(format, btn) {
    if (!resolved) return null;
    if (btn) btn.disabled = true;
    try {
      const r = await exportFigure(resolved, { format });
      status.textContent = `Saved ${r.filename} (${sizeText(r.widthIn, r.heightIn)}).`;
      if (typeof options.onExport === 'function') options.onExport(r, null, format);
      return r;
    } catch (err) {
      const why = err && err.message ? err.message : String(err);
      status.textContent = `The ${format.toUpperCase()} could not be made: ${why}`;
      if (typeof options.onExport === 'function') options.onExport(null, err, format);
      else if (!btn) throw err;
      else {
        notes.appendChild(h('p', { text: `The ${format.toUpperCase()} could not be made: ${why}` }));
        notes.hidden = false;
      }
      return null;
    } finally {
      if (btn) btn.disabled = !resolved;
    }
  }

  /* Python */
  const py = options.python && options.python.host ? options.python : null;
  let pyTimer = null;
  const esc = (t) => String(t).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  function scriptFor(fig) {
    if (typeof py.script === 'function') return py.script(fig, pySource);
    return figureScript(fig, { data: pySource === 'files' ? 'files' : 'embed', files: py.files, header: py.header, prelude: py.prelude, imports: py.imports });
  }
  /* The note under the script: what it needs, what it saves, what it reads. */
  function noteFor(fig, code, filename) {
    if (typeof py.note === 'function') return py.note(fig, pySource);
    if (typeof py.note === 'string') return py.note;
    const scipy = /\bfrom scipy\b|\bimport scipy\b/.test(code);
    const read = pySource === 'files' && py.files ? Object.values(py.files).map((f) => f.file).filter((f) => code.includes(pyStr(f))) : [];
    return `Runs with Python 3, numpy${scipy ? ', scipy' : ''} and matplotlib 3.6 or later: <code>python ${esc(filename)}</code>. `
      + `It saves <code>${esc(fig.export.filename)}.${esc(fig.export.format)}</code>`
      + (read.length ? `, reading ${read.map((f) => `<code>${esc(f)}</code>`).join(' and ')} from the same folder.` : '.');
  }
  let lastScriptLength = 0;
  function renderPython() {
    if (!py || !python) return;
    clearTimeout(pyTimer);
    // A script of megabytes (a large data set embedded) waits for the edits
    // to settle before it is written and shown again.
    pyTimer = setTimeout(() => {
      if (!resolved) { python.setCode(''); python.setNote(''); return; }
      const filename = py.filename || `${resolved.export.filename}.py`;
      try {
        const code = scriptFor(resolved);
        lastScriptLength = code.length;
        python.setCode(code);
        python.setFilename(filename);
        python.setNote(noteFor(resolved, code, filename));
      } catch (err) {
        python.setCode(`# The script could not be written: ${err && err.message ? err.message : err}`);
      }
    }, lastScriptLength > 2e6 ? 800 : 120);
  }
  if (py) {
    const make = typeof py.create === 'function' ? Promise.resolve({ createPythonPanel: py.create }) : import('./python-panel.js');
    make.then((mod) => {
      if (destroyed) return;
      python = mod.createPythonPanel(py.host, {
        title: py.title || 'Python script',
        filename: py.filename || (resolved ? `${resolved.export.filename}.py` : py.initialFilename || 'figure.py'),
        sources: py.sources,
        headingLevel: py.headingLevel,
        empty: py.empty || '# The script appears here once there is a figure to draw.',
        onSourceChange: (id) => { pySource = id; renderPython(); if (py.onSourceChange) py.onSourceChange(id); }
      });
      if (pySource && python.setSource) python.setSource(pySource);
      renderPython();
    }).catch(() => {
      py.host.appendChild(h('p', { class: 'fg-py-missing', text: 'The Python script could not load. Reload the page to try again.' }));
    });
  }

  if (desc) draw();

  return {
    element: host,
    update(figure) {
      desc = figure || null;
      if (panel && desc) panel.setFigure(desc);
      const drawn = draw();
      showStyleTitle();
      return drawn;
    },
    /** A new title for the header (and so for the style drawer's). */
    setTitle(text) {
      headerTitle = String(text ?? '');
      const t = header && header.querySelector('.fg-t');
      if (t) t.textContent = headerTitle || 'Plot';
      showStyleTitle();
    },
    setStyle(next) {
      style = cleanStyle(next || {});
      if (panel) panel.set(style);
      return draw();
    },
    getStyle: () => clone(style),
    export: (format) => exportAs(EXPORT_FORMATS.includes(format) ? format : (resolved ? resolved.export.format : 'pdf')),
    openStyle,
    closeStyle,
    setToggle(id, state = {}) {
      const t = toggles.get(id);
      if (!t) return;
      if (state.checked !== undefined) t.input.checked = !!state.checked;
      if (state.hidden !== undefined) t.label.hidden = !!state.hidden;
      if (state.disabled !== undefined) t.input.disabled = !!state.disabled;
    },
    info: () => lastInfo,
    figure: () => resolved,
    script: () => (py && resolved ? scriptFor(resolved) : figureScript(resolved || normaliseFigure({}))),
    destroy() {
      destroyed = true;
      clearTimeout(pyTimer);
      cleanups.forEach((f) => f());
      destroyFigure(figureEl);
      if (panel) panel.destroy();
      if (drawer) drawer.remove();
      if (python && python.destroy) python.destroy();
      status.remove();
      if (!adopted) { host.classList.remove('fg', 'fg-card'); header.remove(); stage.remove(); notes.remove(); }
    }
  };
}

const fmtIn = (v) => String(Number(Number(v).toPrecision(3)));
