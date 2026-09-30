/**
 * @module core/pdf
 *
 * A small PDF writer with no dependencies, so a figure drawn in the browser
 * can be saved as a PDF without a library or a network request.
 *
 * Two ways in:
 *
 *   pdfFromSvg(svgText, { widthIn, heightIn })   vector: the SVG's rectangles,
 *       paths, lines, circles and text become PDF drawing operators. Written
 *       for the SVG that Plotly exports (translate/rotate transforms, clip
 *       paths, opacity, dashes, arcs in marker paths, <tspan> runs for
 *       superscripts and subscripts) and for hand-written SVG of that kind.
 *       Text is set in the standard PDF fonts (Helvetica, Times, Courier and
 *       Symbol for Greek letters and maths signs), chosen from each text's
 *       font-family; they need no embedding, and every PDF reader has them.
 *       Anchored text (middle, end) is placed with the metrics of the PDF
 *       font, so a centred label stays centred even though the typeface
 *       differs from the one on screen. The few characters a figure label
 *       needs that no standard font has are made from ones they do have
 *       (∓, ħ, ℓ, and Unicode superscripts and subscripts such as ⁻¹ and ₂),
 *       because a stand-in letter would change what the label says.
 *
 *   pdfFromJpeg(bytes, { widthIn, heightIn })
 *       raster: one JPEG image filling the page (DCTDecode, the JPEG bytes
 *       are stored as they are; the size and colour channels come from the
 *       JPEG's own header).
 *
 * Page sizes are given in inches and written in points (72 per inch). The
 * SVG's own coordinates are scaled to fill the page, so an SVG drawn at 96
 * pixels per inch maps one CSS pixel to 0.75 pt.
 *
 * Checked by rasterising Plotly's own SVG exports with Poppler and comparing
 * them with Plotly's PNGs of the same figures (tests/pdf.test.js).
 *
 * Not supported, and skipped without error: gradients, patterns, masks,
 * filters, <image>, <use>, markers on paths, text on a path, stroked or
 * decorated (underlined) text, and CSS in <style> sheets (only style
 * attributes and presentation attributes are read). Group opacity is passed
 * down to each shape, so overlapping shapes inside a translucent group show
 * through one another where a browser would flatten the group first.
 */

export const POINTS_PER_INCH = 72;
export const PIXELS_PER_INCH = 96;

/* ---------------------------------------------------------------------------
   Font metrics
   ---------------------------------------------------------------------------
   Advance widths (1/1000 em) of the standard fonts for WinAnsiEncoding codes
   32 to 255, from Adobe's AFM files, two base-36 digits per code. Courier is
   600 throughout; the oblique Helvetica cuts share the upright widths.
--------------------------------------------------------------------------- */

const WIDTHS_B36 = {
  'Helvetica': '7q7q9vfgfgopij5b9999atg87q997q7qfgfgfgfgfgfgfgfgfgfg7q7qg8g8g8fgs7ijijk2k2ijgzlmk27qdwijfgn5k2lmijlmk2ijgzk2ijq8ijijgz7q7q7qd1fg99fgfgdwfgfg7qfgfg6666dw66n5fgfgfgfg99dw7qfgdwk2dwdwdw9a789ag800fg0066fg99rsfgfg99rsij99rs00gz0000666699999qfgrs99rsdw99q800dwij7q99fgfgfgfg78fg99khaafgg899kh99b4g8999999fgex7q9999a5fgn6n6n6gzijijijijijijrsk2ijijijij7q7q7q7qk2k2lmlmlmlmlmg8lmk2k2k2k2ijijgzfgfgfgfgfgfgopdwfgfgfgfg7q7q7q7qfgfgfgfgfgfgfgg8gzfgfgfgfgdwfgdw',
  'Helvetica-Bold': '7q99d6fgfgopk26m9999atg87q997q7qfgfgfgfgfgfgfgfgfgfg9999g8g8g8gzr3k2k2k2k2ijgzlmk27qfgk2gzn5k2lmijlmk2ijgzk2ijq8ijijgz997q99g8fg99fggzfggzfg99gzgz7q7qfg7qopgzgzgzgzatfg99gzfglmfgfgdwat7satg800fg007qfgdwrsfgfg99rsij99rs00gz00007q7qdwdw9qfgrs99rsfg99q800dwij7q99fgfgfgfg7sfg99khaafgg899kh99b4g8999999gzfg7q9999a5fgn6n6n6gzk2k2k2k2k2k2rsk2ijijijij7q7q7q7qk2k2lmlmlmlmlmg8lmk2k2k2k2ijijgzfgfgfgfgfgfgopfgfgfgfgfg7q7q7q7qgzgzgzgzgzgzgzg8gzgzgzgzgzfggzfg',
  'Times-Roman': '6y99bcdwdwn5lm509999dwfo6y996y7qdwdwdwdwdwdwdwdwdwdw7q7qfofofoccplk2ijijk2gzfgk2k299atk2gzopk2k2fgk2ijfggzk2k2q8k2k2gz997q99d1dw99ccdwccdwcc99dwdw7q7qdw7qlmdwdwdwdw99at7qdwdwk2dwdwccdc5kdcf100dw0099dwccrsdwdw99rsfg99op00gz00009999cccc9qdwrs99r8at99k200cck26y99dwdwdwdw5kdw99l47odwfo99l499b4fo8c8c99dwcl6y998c8mdwkukukucck2k2k2k2k2k2opijgzgzgzgz99999999k2k2k2k2k2k2k2fok2k2k2k2k2k2fgdwccccccccccccijcccccccccc7q7q7q7qdwdwdwdwdwdwdwfodwdwdwdwdwdwdwdw',
  'Times-Bold': '6y99ffdwdwrsn57q9999dwfu6y996y7qdwdwdwdwdwdwdwdwdwdw9999fufufudwpuk2ijk2k2ijgzlmlmatdwlmijq8k2lmgzlmk2fgijk2k2rsk2k2ij997q99g5dw99dwfgccfgcc99dwfg7q99fg7qn5fgdwfgfgccat99fgdwk2dwdwccay64ayeg00dw0099dwdwrsdwdw99rsfg99rs00ij00009999dwdw9qdwrs99rsat99k200cck26y99dwdwdwdw64dw99kr8cdwfu99kr99b4fu8c8c99fgf06y998c96dwkukukudwk2k2k2k2k2k2rsk2ijijijijatatatatk2k2lmlmlmlmlmfulmk2k2k2k2k2gzfgdwdwdwdwdwdwk2cccccccccc7q7q7q7qdwfgdwdwdwdwdwfudwfgfgfgfgdwfgdw',
  'Times-Italic': '6y99bodwdwn5lm5y9999dwir6y996y7qdwdwdwdwdwdwdwdwdwdw9999iririrdwpkgzgzijk2gzgzk2k299ccijfgn5ijk2gzk2gzdwfgk2gzn5gzfgfgat7qatbqdw99dwdwccdwcc7qdwdw7q7qcc7qk2dwdwdwdwatat7qdwccijccccatb47nb4f100dw0099dwfgopdwdw99rsdw99q800fg00009999fgfg9qdwop99r8at99ij00atfg6yatdwdwdwdw7ndw99l47odwir99l499b4ir8c8c99dwej6y998c8mdwkukukudwgzgzgzgzgzgzopijgzgzgzgz99999999k2ijk2k2k2k2k2irk2k2k2k2k2fggzdwdwdwdwdwdwdwijcccccccccc7q7q7q7qdwdwdwdwdwdwdwirdwdwdwdwdwccdwcc',
  'Times-BoldItalic': '6yatffdwdwn5lm7q9999dwfu6y996y7qdwdwdwdwdwdwdwdwdwdw9999fufufudwn4ijijijk2ijijk2lmatdwijgzopk2k2gzk2ijfggzk2ijopijgzgz997q99fudw99dwdwccdwcc99dwfg7q7qdw7qlmfgdwdwdwatat7qfgccijdwccat9o649ofu00dw0099dwdwrsdwdw99rsfg99q800gz00009999dwdw9qdwrs99rsat99k200atgz6yatdwdwdwdw64dw99kr7edwgu99kr99b4fu8c8c99g0dw6y998c8cdwkukukudwijijijijijijq8ijijijijijatatatatk2k2k2k2k2k2k2fuk2k2k2k2k2gzgzdwdwdwdwdwdwdwk2cccccccccc7q7q7q7qdwfgdwdwdwdwdwfudwfgfgfgfgccdwcc'
};

const WIDTH_ALIAS = {
  'Helvetica-Oblique': 'Helvetica',
  'Helvetica-BoldOblique': 'Helvetica-Bold'
};

/** The fourteen fonts every PDF reader carries; nothing needs embedding. */
export const STANDARD_FONTS = Object.freeze([
  'Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique',
  'Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic',
  'Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique',
  'Symbol', 'ZapfDingbats'
]);

const widthCache = new Map();
function widthTable(font) {
  const key = WIDTH_ALIAS[font] || font;
  if (widthCache.has(key)) return widthCache.get(key);
  const src = WIDTHS_B36[key];
  let table = null;
  if (src) {
    table = new Uint16Array(224);
    for (let i = 0; i < 224; i++) table[i] = parseInt(src.substr(i * 2, 2), 36);
  }
  widthCache.set(key, table);
  return table;
}

/* Symbol font: Unicode character -> [code, width]. Greek letters and the
   signs a figure label is likely to hold. */
const SYMBOL = {
  'α': [97, 631], 'β': [98, 549], 'γ': [103, 411], 'δ': [100, 494], 'ε': [101, 439], 'ϵ': [101, 439],
  'ζ': [122, 494], 'η': [104, 603], 'θ': [113, 521], 'ϑ': [74, 631], 'ι': [105, 329], 'κ': [107, 549],
  'λ': [108, 549], 'μ': [109, 576], 'ν': [110, 521], 'ξ': [120, 493], 'ο': [111, 549], 'π': [112, 549],
  'ϖ': [118, 713], 'ρ': [114, 549], 'ϱ': [114, 549], 'σ': [115, 603], 'ς': [86, 439], 'τ': [116, 439],
  'υ': [117, 576], 'φ': [102, 521], 'ϕ': [106, 603], 'χ': [99, 549], 'ψ': [121, 686], 'ω': [119, 686],
  'Γ': [71, 603], 'Δ': [68, 612], 'Θ': [81, 741], 'Λ': [76, 686], 'Ξ': [88, 645], 'Π': [80, 768],
  'Σ': [83, 592], 'Υ': [85, 690], 'Φ': [70, 763], 'Ψ': [89, 795], 'Ω': [87, 768],
  '−': [45, 549], '∞': [165, 713], '≤': [163, 549], '≥': [179, 549], '≠': [185, 549], '≈': [187, 549],
  '∂': [182, 494], '∇': [209, 713], '∑': [229, 713], '∏': [213, 823], '∫': [242, 274], '√': [214, 549],
  '⋅': [215, 250], '∙': [215, 250], '∘': [176, 400], '→': [174, 987], '←': [172, 987], '↑': [173, 603],
  '↓': [175, 603], '↔': [171, 1042], '⇒': [222, 987], '∝': [181, 713], '∈': [206, 713], '∉': [207, 713],
  '∩': [199, 768], '∪': [200, 768], '⊂': [204, 713], '⊃': [201, 713], '∅': [198, 823], '∠': [208, 768],
  '′': [162, 247], '″': [178, 411], '∼': [126, 549], '≃': [64, 549], '≅': [64, 549], '≡': [186, 549],
  '⊥': [94, 658], '⟂': [94, 658], '∧': [217, 603], '∨': [218, 603], '∀': [34, 713], '∃': [36, 549],
  '⟨': [225, 329], '⟩': [241, 329], '∗': [42, 500], '⋯': [188, 1000],
  // Capitals that look Latin, so that a pasted Greek word keeps its letters.
  'Α': [65, 722], 'Β': [66, 667], 'Ε': [69, 611], 'Ζ': [90, 611], 'Η': [72, 722], 'Ι': [73, 333],
  'Κ': [75, 722], 'Μ': [77, 889], 'Ν': [78, 722], 'Ο': [79, 722], 'Ρ': [82, 556], 'Τ': [84, 611], 'Χ': [67, 722]
};

/* Symbol advance widths by code, for runs rebuilt from codes. */
const SYMBOL_WIDTH = new Map(Object.values(SYMBOL).map(([code, w]) => [code, w]));
SYMBOL_WIDTH.set(177, 549); // plusminus, used for ∓

/* Characters outside WinAnsi that have a close stand-in inside it. The
   spaces are the thin, en, em and narrow no-break spaces. */
const WINANSI_STANDIN = {
  '≪': '«', '≫': '»', '‖': '||', '∥': '||', '⋆': '*',
  '\u2009': ' ', '\u2002': ' ', '\u2003': ' ', '\u202f': ' '
};

/* Characters no standard font has, made from one that it does have, so that
   a label keeps its meaning: ∓ is Symbol's ± turned upside down, ħ is h with
   a bar drawn across it, and ℓ is an italic l. */
const FLIP_HEIGHT = 0.65; // Symbol's ± stands 0 to 645/1000 em
const BAR_HEIGHT = 0.6;   // the bar of ħ, em above the baseline
const MADE = {
  '∓': { font: 'Symbol', code: 177, flip: true },
  'ħ': { char: 'h', bar: true },
  'ℓ': { char: 'l', italic: true }
};

/* Unicode superscript and subscript characters (⁻¹, ₂, ⁿ …) are drawn as
   their plain character at 60% size, raised or lowered. The sizes match the
   fonts' own ¹ ² ³ (digits at 60%, their foot at 0.28 em), which WinAnsi has
   and which are left as they are, so that "s⁻¹" and "m³" look alike. */
const SUPERSCRIPT = { scale: 0.6, rise: 0.28 };
const SUBSCRIPT = { scale: 0.6, rise: -0.15 };
function scriptOf(u) {
  if ((u >= 0x2070 && u <= 0x207f) || (u >= 0x2b0 && u <= 0x2b8) || (u >= 0x1d2c && u <= 0x1d61) || (u >= 0x1d9b && u <= 0x1dbf)) return SUPERSCRIPT;
  if ((u >= 0x2080 && u <= 0x209c) || (u >= 0x1d62 && u <= 0x1d6a)) return SUBSCRIPT;
  return null;
}

/* The italic cut of a standard font. */
function italicOf(font) {
  if (font.startsWith('Times')) return font.includes('Bold') ? 'Times-BoldItalic' : 'Times-Italic';
  if (font.startsWith('Helvetica') || font.startsWith('Courier')) {
    const family = font.split('-')[0];
    return font.includes('Bold') ? `${family}-BoldOblique` : `${family}-Oblique`;
  }
  return font;
}

/* WinAnsi codes 0x80-0x9F. */
const CP1252_HIGH = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87,
  0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91,
  0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98,
  0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f
};

function winAnsiCode(ch) {
  const u = ch.codePointAt(0);
  if ((u >= 0x20 && u <= 0x7e) || (u >= 0xa0 && u <= 0xff)) return u;
  return CP1252_HIGH[u] ?? -1;
}

/**
 * The standard font for a CSS font-family list, weight and style: the first
 * family that names a sans, serif or monospaced face decides.
 *
 * @param {string} [family]
 * @param {boolean} [bold]
 * @param {boolean} [italic]
 * @returns {string} a base font name from STANDARD_FONTS
 */
export function standardFontFor(family = '', bold = false, italic = false) {
  let kind = 'sans';
  for (const raw of String(family).split(',')) {
    const f = raw.trim().replace(/^['"]|['"]$/g, '').toLowerCase();
    if (!f) continue;
    if (/mono|courier|consolas|menlo/.test(f)) { kind = 'mono'; break; }
    if (f === 'serif' || /times|georgia|garamond|cambria|palatino|dejavu serif|computer modern|stix|serif$/.test(f) && !/sans/.test(f)) { kind = 'serif'; break; }
    if (/sans|arial|helvetica|verdana|inter|system-ui|segoe|roboto/.test(f)) { kind = 'sans'; break; }
  }
  if (kind === 'serif') return bold ? (italic ? 'Times-BoldItalic' : 'Times-Bold') : (italic ? 'Times-Italic' : 'Times-Roman');
  if (kind === 'mono') return bold ? (italic ? 'Courier-BoldOblique' : 'Courier-Bold') : (italic ? 'Courier-Oblique' : 'Courier');
  return bold ? (italic ? 'Helvetica-BoldOblique' : 'Helvetica-Bold') : (italic ? 'Helvetica-Oblique' : 'Helvetica');
}

/**
 * Split text into runs a standard font can show: WinAnsi characters in
 * `font`, Greek letters and maths signs in Symbol. Unicode superscripts and
 * subscripts become small raised or lowered runs, and ∓, ħ and ℓ are made
 * from glyphs the fonts have (see MADE). Other characters neither font can
 * show are replaced by a close stand-in, their unaccented letter, or "?";
 * zero-width characters and combining accents are dropped.
 *
 * A run may carry drawing instructions besides its glyphs: `scale` (of the
 * font size) and `rise` (baseline shift, em of the full size, up positive)
 * for scripts, `flip` to turn the glyphs upside down within their height,
 * and `bar` to strike a short bar through the ascender.
 *
 * @param {string} text
 * @param {string} font base font name
 * @returns {{font: string, codes: number[], width: number, scale?: number, rise?: number, flip?: boolean, bar?: boolean}[]}
 *   width in 1/1000 em of the full font size
 */
export function encodeText(text, font) {
  const runs = [];
  const push = (f, code, w, extra) => {
    const last = runs[runs.length - 1];
    const same = last && last.font === f && last.scale === extra?.scale && last.rise === extra?.rise && !last.flip && !last.bar && !extra?.flip && !extra?.bar;
    if (same) { last.codes.push(code); last.width += w; return; }
    const run = { font: f, codes: [code], width: w };
    if (extra) for (const k of Object.keys(extra)) if (extra[k] !== undefined) run[k] = extra[k];
    runs.push(run);
  };
  for (const ch of String(text)) {
    const u = ch.codePointAt(0);
    if (u === 0x200b || u === 0x200c || u === 0x200d || u === 0xfeff || (u >= 0x300 && u <= 0x36f) || u === 0x20d7) continue;
    let code = winAnsiCode(ch);
    if (code >= 0) { push(font, code, glyphWidth(font, code)); continue; }
    if (SYMBOL[ch]) { push('Symbol', SYMBOL[ch][0], SYMBOL[ch][1]); continue; }
    const made = MADE[ch];
    if (made) {
      if (made.font) push(made.font, made.code, glyphWidth(made.font, made.code), { flip: made.flip });
      else {
        const f = made.italic ? italicOf(font) : font;
        const c = winAnsiCode(made.char);
        push(f, c, glyphWidth(f, c), { bar: made.bar });
      }
      continue;
    }
    const script = scriptOf(u);
    if (script) {
      for (const r of encodeText(ch.normalize('NFKD'), font)) {
        for (const c of r.codes) push(r.font, c, glyphWidth(r.font, c) * script.scale, script);
      }
      continue;
    }
    let alt = WINANSI_STANDIN[ch];
    if (alt === undefined) {
      const base = ch.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
      alt = base && base !== ch && [...base].every((c) => winAnsiCode(c) >= 0) ? base : '?';
    }
    for (const c of alt) { code = winAnsiCode(c); push(font, code, glyphWidth(font, code)); }
  }
  return runs;
}

function glyphWidth(font, code) {
  if (font === 'Symbol') return SYMBOL_WIDTH.get(code) ?? 549;
  if (font.startsWith('Courier')) return 600;
  const t = widthTable(font);
  if (!t || code < 32 || code > 255) return 556;
  return t[code - 32] || 556;
}

/**
 * Advance width of `text` set in a standard font.
 *
 * @param {string} text
 * @param {string} font base font name
 * @param {number} size font size, in any unit
 * @returns {number} width in the same unit as `size`
 */
export function textWidth(text, font, size) {
  return encodeText(text, font).reduce((w, r) => w + r.width, 0) * size / 1000;
}

/* ---------------------------------------------------------------------------
   Bytes and PDF syntax
--------------------------------------------------------------------------- */

function latin1(s) {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); b[i] = c < 256 ? c : 63; }
  return b;
}

/**
 * A number as PDF writes it: no exponent (PDF has none), no "-0", and at
 * most `decimals` decimals. Three, a thousandth of a point, is plenty for
 * coordinates; matrices get six, because a scale factor's rounding error is
 * multiplied by every coordinate it scales.
 *
 * @param {number} n
 * @param {number} [decimals=3]
 * @returns {string}
 */
export function pdfNumber(n, decimals = 3) {
  if (!Number.isFinite(n)) return '0';
  const v = Math.max(-1e7, Math.min(1e7, n));
  let s = v.toFixed(Math.min(10, Math.max(1, decimals | 0))).replace(/\.?0+$/, '');
  if (s === '-0' || s === '' || s === '-') s = '0';
  return s;
}

/** Bytes as a PDF literal string. */
function literal(codes) {
  let s = '(';
  for (const c of codes) {
    if (c === 0x28 || c === 0x29 || c === 0x5c) s += '\\' + String.fromCharCode(c);
    else if (c < 32 || c > 126) s += '\\' + c.toString(8).padStart(3, '0');
    else s += String.fromCharCode(c);
  }
  return s + ')';
}

/** A text string for the document information dictionary. */
function infoString(text) {
  const s = String(text);
  if (/^[\x20-\x7e]*$/.test(s)) return literal([...s].map((c) => c.charCodeAt(0)));
  let hex = 'FEFF';
  for (let i = 0; i < s.length; i++) hex += s.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase();
  return '<' + hex + '>';
}

function pdfDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

/**
 * One-page PDF document. Coordinates are PDF points with the origin at the
 * bottom left, as PDF has them; `pdfFromSvg` sets up its own flip.
 */
export class PdfDocument {
  /**
   * @param {object} opts
   * @param {number} opts.width  page width in points
   * @param {number} opts.height page height in points
   * @param {string} [opts.title]
   * @param {string} [opts.producer]
   * @param {Date}   [opts.date]
   */
  constructor({ width, height, title = '', producer = 'STEMKit', date = new Date() } = {}) {
    if (!(width > 0) || !(height > 0)) throw new Error('PdfDocument: page width and height must be positive');
    this.width = width;
    this.height = height;
    this.title = title;
    this.producer = producer;
    this.date = date;
    this.ops = [];
    this.fonts = new Map();   // base font -> resource name
    this.states = new Map();  // "ca/CA" -> resource name
    this.images = [];         // { name, bytes, width, height, filter, colorSpace }
  }

  /** Resource name for a standard font, e.g. "F1". */
  font(baseFont) {
    if (!STANDARD_FONTS.includes(baseFont)) throw new Error(`PdfDocument: ${baseFont} is not a standard font`);
    if (!this.fonts.has(baseFont)) this.fonts.set(baseFont, 'F' + (this.fonts.size + 1));
    return this.fonts.get(baseFont);
  }

  /** Resource name of a graphics state with these fill and stroke opacities. */
  alpha(fill = 1, stroke = 1) {
    const key = `${pdfNumber(fill)}/${pdfNumber(stroke)}`;
    if (!this.states.has(key)) this.states.set(key, 'GS' + (this.states.size + 1));
    return this.states.get(key);
  }

  /**
   * Resource name for a JPEG (DCTDecode) image. `inverted` marks a CMYK
   * JPEG from Adobe software, whose values are stored inverted.
   */
  jpeg(bytes, width, height, colorSpace = 'DeviceRGB', inverted = false) {
    const name = 'Im' + (this.images.length + 1);
    this.images.push({ name, bytes, width, height, filter: 'DCTDecode', colorSpace, inverted });
    return name;
  }

  /** Append content-stream operators. */
  draw(ops) {
    if (ops) this.ops.push(ops);
    return this;
  }

  /** The finished file. */
  toBytes() {
    const objects = [];          // index + 1 = object number
    const add = (body) => { objects.push(body); return objects.length; };
    const catalog = add(null);
    const pages = add(null);
    const page = add(null);
    const content = latin1(this.ops.join('\n') + '\n');
    const contents = add({ dict: `<< /Length ${content.length} >>`, stream: content });
    const info = add(`<< /Producer ${infoString(this.producer)}${this.title ? ` /Title ${infoString(this.title)}` : ''} /CreationDate ${infoString(pdfDate(this.date))} >>`);

    const fontRefs = [];
    for (const [base, name] of this.fonts) {
      const encoding = base === 'Symbol' || base === 'ZapfDingbats' ? '' : ' /Encoding /WinAnsiEncoding';
      fontRefs.push(`/${name} ${add(`<< /Type /Font /Subtype /Type1 /BaseFont /${base}${encoding} >>`)} 0 R`);
    }
    const stateRefs = [];
    for (const [key, name] of this.states) {
      const [ca, CA] = key.split('/');
      stateRefs.push(`/${name} ${add(`<< /Type /ExtGState /ca ${ca} /CA ${CA} >>`)} 0 R`);
    }
    const imageRefs = [];
    for (const im of this.images) {
      const decode = im.inverted ? ' /Decode [1 0 1 0 1 0 1 0]' : '';
      const n = add({ dict: `<< /Type /XObject /Subtype /Image /Width ${im.width} /Height ${im.height} /ColorSpace /${im.colorSpace} /BitsPerComponent 8${decode} /Filter /${im.filter} /Length ${im.bytes.length} >>`, stream: im.bytes });
      imageRefs.push(`/${im.name} ${n} 0 R`);
    }

    let resources = '<< /ProcSet [/PDF /Text /ImageB /ImageC]';
    if (fontRefs.length) resources += ` /Font << ${fontRefs.join(' ')} >>`;
    if (stateRefs.length) resources += ` /ExtGState << ${stateRefs.join(' ')} >>`;
    if (imageRefs.length) resources += ` /XObject << ${imageRefs.join(' ')} >>`;
    resources += ' >>';

    objects[catalog - 1] = `<< /Type /Catalog /Pages ${pages} 0 R >>`;
    objects[pages - 1] = `<< /Type /Pages /Kids [${page} 0 R] /Count 1 >>`;
    objects[page - 1] = `<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 ${pdfNumber(this.width)} ${pdfNumber(this.height)}] /Resources ${resources} /Contents ${contents} 0 R >>`;

    const chunks = [];
    let length = 0;
    const put = (x) => { const b = typeof x === 'string' ? latin1(x) : x; chunks.push(b); length += b.length; };
    put('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');
    const offsets = [];
    objects.forEach((body, i) => {
      offsets.push(length);
      put(`${i + 1} 0 obj\n`);
      if (typeof body === 'string') put(body + '\n');
      else { put(body.dict + '\nstream\n'); put(body.stream); put('\nendstream\n'); }
      put('endobj\n');
    });
    const xref = length;
    let table = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const off of offsets) table += `${String(off).padStart(10, '0')} 00000 n \n`;
    put(table);
    put(`trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

    const out = new Uint8Array(length);
    let at = 0;
    for (const c of chunks) { out.set(c, at); at += c.length; }
    return out;
  }
}

/* ---------------------------------------------------------------------------
   Raster
--------------------------------------------------------------------------- */

/**
 * Size and colour channels of a JPEG, read from its start-of-frame marker.
 * A PDF reader draws the image with the size the PDF states, not the size
 * inside the JPEG, so the two must agree.
 *
 * @param {Uint8Array} bytes
 * @returns {{width: number, height: number, components: number, adobe: boolean}|null}
 *   null when the bytes are not a JPEG or have no frame header
 */
export function jpegInfo(bytes) {
  if (!bytes || bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let adobe = false;
  let i = 2;
  while (i + 3 < bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1];
    if (marker === 0xff) { i++; continue; }                          // fill byte
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; } // no length
    if (marker === 0xd9 || marker === 0xda) return null;             // image data before any frame
    const length = (bytes[i + 2] << 8) | bytes[i + 3];
    // APP14 "Adobe": a CMYK JPEG from Adobe software stores inverted values.
    if (marker === 0xee && String.fromCharCode(...bytes.subarray(i + 4, i + 9)) === 'Adobe') adobe = true;
    // SOF0-SOF15, except DHT (C4), JPG (C8) and DAC (CC), which share the range.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (i + 9 >= bytes.length) return null;
      return { height: (bytes[i + 5] << 8) | bytes[i + 6], width: (bytes[i + 7] << 8) | bytes[i + 8], components: bytes[i + 9], adobe };
    }
    i += 2 + length;
  }
  return null;
}

/**
 * A PDF holding one JPEG that fills the page. The JPEG's own header gives
 * its pixel size and colour channels (grey, RGB or CMYK); `pixelWidth` and
 * `pixelHeight` are used only if the header cannot be read.
 *
 * @param {Uint8Array} jpegBytes
 * @param {object} opts
 * @param {number} [opts.widthIn]  page width in inches (default: the pixel width at 96 per inch)
 * @param {number} [opts.heightIn] page height in inches (default: likewise)
 * @param {number} [opts.pixelWidth]  the JPEG's width in pixels
 * @param {number} [opts.pixelHeight] the JPEG's height in pixels
 * @param {string} [opts.title]
 * @param {Date}   [opts.date]
 * @returns {Uint8Array}
 */
export function pdfFromJpeg(jpegBytes, { widthIn, heightIn, pixelWidth, pixelHeight, title = '', date } = {}) {
  const bytes = jpegBytes instanceof Uint8Array ? jpegBytes : new Uint8Array(jpegBytes);
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('pdfFromJpeg: the bytes are not a JPEG');
  const info = jpegInfo(bytes);
  const pw = info ? info.width : Math.round(pixelWidth);
  const ph = info ? info.height : Math.round(pixelHeight);
  if (!(pw > 0) || !(ph > 0)) throw new Error('pdfFromJpeg: the JPEG has no size; pass pixelWidth and pixelHeight');
  const W = (widthIn || pw / PIXELS_PER_INCH) * POINTS_PER_INCH;
  const H = (heightIn || ph / PIXELS_PER_INCH) * POINTS_PER_INCH;
  const doc = new PdfDocument({ width: W, height: H, title, date });
  const components = info ? info.components : 3;
  const space = components === 1 ? 'DeviceGray' : components === 4 ? 'DeviceCMYK' : 'DeviceRGB';
  const im = doc.jpeg(bytes, pw, ph, space, components === 4 && info.adobe);
  doc.draw(`q ${pdfNumber(W)} 0 0 ${pdfNumber(H)} 0 0 cm /${im} Do Q`);
  return doc.toBytes();
}

/* ---------------------------------------------------------------------------
   XML
--------------------------------------------------------------------------- */

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', times: '×', minus: '−', middot: '·', deg: '°', micro: 'µ', plusmn: '±' };

function decodeEntities(s) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return NAMED_ENTITIES[e.toLowerCase()] ?? m;
  });
}

/**
 * A minimal XML parser, enough for SVG: elements, attributes, text,
 * comments, CDATA and entities. No namespaces or DTDs.
 *
 * @param {string} src
 * @returns {{name: string, attrs: object, children: Array}} the root element
 */
export function parseXml(src) {
  const top = { name: '#document', attrs: {}, children: [] };
  const stack = [top];
  let i = 0;
  const n = src.length;
  const text = (t) => { if (t) stack[stack.length - 1].children.push({ text: decodeEntities(t) }); };
  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt < 0) { text(src.slice(i)); break; }
    if (lt > i) text(src.slice(i, lt));
    if (src.startsWith('<!--', lt)) { const e = src.indexOf('-->', lt + 4); i = e < 0 ? n : e + 3; continue; }
    if (src.startsWith('<![CDATA[', lt)) {
      const e = src.indexOf(']]>', lt + 9);
      stack[stack.length - 1].children.push({ text: src.slice(lt + 9, e < 0 ? n : e) });
      i = e < 0 ? n : e + 3;
      continue;
    }
    if (src[lt + 1] === '?' || src[lt + 1] === '!') { const e = src.indexOf('>', lt); i = e < 0 ? n : e + 1; continue; }
    if (src[lt + 1] === '/') {
      const e = src.indexOf('>', lt);
      if (stack.length > 1) stack.pop();
      i = e < 0 ? n : e + 1;
      continue;
    }
    let j = lt + 1;
    while (j < n && !/[\s/>]/.test(src[j])) j++;
    const el = { name: src.slice(lt + 1, j), attrs: {}, children: [] };
    let selfClose = false;
    while (j < n) {
      while (j < n && /\s/.test(src[j])) j++;
      if (src[j] === '/') { selfClose = true; j++; continue; }
      if (src[j] === '>') { j++; break; }
      let k = j;
      while (k < n && !/[\s=/>]/.test(src[k])) k++;
      const name = src.slice(j, k);
      j = k;
      while (j < n && /\s/.test(src[j])) j++;
      let value = '';
      if (src[j] === '=') {
        j++;
        while (j < n && /\s/.test(src[j])) j++;
        const q = src[j];
        if (q === '"' || q === "'") {
          const e = src.indexOf(q, j + 1);
          value = src.slice(j + 1, e < 0 ? n : e);
          j = e < 0 ? n : e + 1;
        } else {
          let e = j;
          while (e < n && !/[\s>]/.test(src[e])) e++;
          value = src.slice(j, e);
          j = e;
        }
      }
      if (name) el.attrs[name] = decodeEntities(value);
      if (k === j && !name) j++; // guard against a stray character
    }
    stack[stack.length - 1].children.push(el);
    if (!selfClose) stack.push(el);
    i = j;
  }
  return top.children.find((c) => c.name) || top;
}

/* ---------------------------------------------------------------------------
   Geometry
--------------------------------------------------------------------------- */

const IDENTITY = [1, 0, 0, 1, 0, 0];

/** m1 then m2: a point is transformed by m2 first, then m1 (SVG order). */
function multiply(m1, m2) {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5]
  ];
}

/**
 * An SVG transform attribute as a matrix [a b c d e f], or null.
 * @param {string} [s]
 */
export function parseTransform(s) {
  if (!s || !String(s).trim()) return null;
  let m = IDENTITY;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let hit = false;
  for (let t; (t = re.exec(s));) {
    hit = true;
    const a = (t[2].match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) || []).map(Number);
    let x = IDENTITY;
    switch (t[1]) {
      case 'matrix': if (a.length === 6) x = a; break;
      case 'translate': x = [1, 0, 0, 1, a[0] || 0, a[1] || 0]; break;
      case 'scale': x = [a[0] ?? 1, 0, 0, a[1] ?? a[0] ?? 1, 0, 0]; break;
      case 'rotate': {
        const r = (a[0] || 0) * Math.PI / 180;
        const c = Math.cos(r); const sn = Math.sin(r);
        x = [c, sn, -sn, c, 0, 0];
        if (a.length >= 3) x = multiply(multiply([1, 0, 0, 1, a[1], a[2]], x), [1, 0, 0, 1, -a[1], -a[2]]);
        break;
      }
      case 'skewX': x = [1, 0, Math.tan((a[0] || 0) * Math.PI / 180), 1, 0, 0]; break;
      case 'skewY': x = [1, Math.tan((a[0] || 0) * Math.PI / 180), 0, 1, 0, 0]; break;
    }
    m = multiply(m, x);
  }
  return hit ? m : null;
}

/**
 * SVG path data as absolute segments: ['M', x, y], ['L', x, y],
 * ['C', x1, y1, x2, y2, x, y] and ['Z']. H, V, S, Q, T and A are converted.
 *
 * @param {string} d
 * @returns {Array<Array>}
 */
export function parsePath(d) {
  const tokens = String(d || '').match(/[a-df-z]|[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) || [];
  const out = [];
  let i = 0;
  let cmd = '';
  let x = 0; let y = 0; let sx = 0; let sy = 0;
  let lastCtrl = null; let lastQ = null;
  const isCmd = (t) => /^[a-df-z]$/i.test(t);
  const next = () => Number(tokens[i++]);
  // Arc flags may be written without separators ("a5 5 0 011 1").
  const flag = () => {
    const t = tokens[i];
    if (t === '0' || t === '1') { i++; return Number(t); }
    if (/^[01]/.test(t)) { tokens[i] = t.slice(1); return Number(t[0]); }
    i++;
    return Number(t) ? 1 : 0;
  };
  while (i < tokens.length) {
    if (isCmd(tokens[i])) cmd = tokens[i++];
    else if (!cmd) { i++; continue; }
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    const ox = rel ? x : 0; const oy = rel ? y : 0;
    if (C === 'Z') {
      out.push(['Z']); x = sx; y = sy; lastCtrl = lastQ = null;
      cmd = ''; // numbers after Z are an error; they are skipped
      continue;
    }
    if (i >= tokens.length || isCmd(tokens[i])) continue;
    switch (C) {
      case 'M': {
        x = ox + next(); y = oy + next(); sx = x; sy = y;
        out.push(['M', x, y]);
        cmd = rel ? 'l' : 'L';
        lastCtrl = lastQ = null;
        break;
      }
      case 'L': x = ox + next(); y = oy + next(); out.push(['L', x, y]); lastCtrl = lastQ = null; break;
      case 'H': x = ox + next(); out.push(['L', x, y]); lastCtrl = lastQ = null; break;
      case 'V': y = oy + next(); out.push(['L', x, y]); lastCtrl = lastQ = null; break;
      case 'C': {
        const x1 = ox + next(); const y1 = oy + next(); const x2 = ox + next(); const y2 = oy + next();
        x = ox + next(); y = oy + next();
        out.push(['C', x1, y1, x2, y2, x, y]); lastCtrl = [x2, y2]; lastQ = null;
        break;
      }
      case 'S': {
        const x1 = lastCtrl ? 2 * x - lastCtrl[0] : x; const y1 = lastCtrl ? 2 * y - lastCtrl[1] : y;
        const x2 = ox + next(); const y2 = oy + next();
        x = ox + next(); y = oy + next();
        out.push(['C', x1, y1, x2, y2, x, y]); lastCtrl = [x2, y2]; lastQ = null;
        break;
      }
      case 'Q': case 'T': {
        let qx; let qy;
        if (C === 'Q') { qx = ox + next(); qy = oy + next(); } else { qx = lastQ ? 2 * x - lastQ[0] : x; qy = lastQ ? 2 * y - lastQ[1] : y; }
        const ex = ox + next(); const ey = oy + next();
        out.push(['C', x + 2 / 3 * (qx - x), y + 2 / 3 * (qy - y), ex + 2 / 3 * (qx - ex), ey + 2 / 3 * (qy - ey), ex, ey]);
        x = ex; y = ey; lastQ = [qx, qy]; lastCtrl = null;
        break;
      }
      case 'A': {
        const rx = next(); const ry = next(); const rot = next();
        const large = flag(); const sweep = flag();
        const ex = ox + next(); const ey = oy + next();
        for (const seg of arcToCurves(x, y, rx, ry, rot, large, sweep, ex, ey)) out.push(seg);
        x = ex; y = ey; lastCtrl = lastQ = null;
        break;
      }
      default: i++;
    }
  }
  return out;
}

/* SVG elliptical arc (endpoint form) as cubic Béziers, per the SVG 1.1
   implementation notes, F.6.5 and F.6.6. */
function arcToCurves(x1, y1, rx, ry, angle, large, sweep, x2, y2) {
  if (x1 === x2 && y1 === y2) return [];
  rx = Math.abs(rx); ry = Math.abs(ry);
  if (!rx || !ry) return [['L', x2, y2]];
  const phi = angle * Math.PI / 180;
  const cos = Math.cos(phi); const sin = Math.sin(phi);
  const dx = (x1 - x2) / 2; const dy = (y1 - y2) / 2;
  const x1p = cos * dx + sin * dy; const y1p = -sin * dx + cos * dy;
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) { const s = Math.sqrt(lambda); rx *= s; ry *= s; }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  let coef = Math.sqrt(Math.max(0, num / den));
  if (large === sweep) coef = -coef;
  const cxp = coef * (rx * y1p) / ry; const cyp = -coef * (ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const ang = (ux, uy, vx, vy) => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    return a;
  };
  const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  else if (sweep && dt < 0) dt += 2 * Math.PI;
  const n = Math.max(1, Math.ceil(Math.abs(dt) / (Math.PI / 2) - 1e-9));
  const step = dt / n;
  const k = 4 / 3 * Math.tan(step / 4);
  const pt = (t) => [cx + rx * Math.cos(t) * cos - ry * Math.sin(t) * sin, cy + rx * Math.cos(t) * sin + ry * Math.sin(t) * cos];
  const der = (t) => [-rx * Math.sin(t) * cos - ry * Math.cos(t) * sin, -rx * Math.sin(t) * sin + ry * Math.cos(t) * cos];
  const segs = [];
  for (let s = 0; s < n; s++) {
    const a = t1 + s * step; const b = a + step;
    const p0 = pt(a); const p3 = s === n - 1 ? [x2, y2] : pt(b);
    const d0 = der(a); const d3 = der(b);
    segs.push(['C', p0[0] + k * d0[0], p0[1] + k * d0[1], p3[0] - k * d3[0], p3[1] - k * d3[1], p3[0], p3[1]]);
  }
  return segs;
}

function segmentsToOps(segs) {
  const f = pdfNumber;
  const ops = [];
  for (const s of segs) {
    if (s[0] === 'M') ops.push(`${f(s[1])} ${f(s[2])} m`);
    else if (s[0] === 'L') ops.push(`${f(s[1])} ${f(s[2])} l`);
    else if (s[0] === 'C') ops.push(`${f(s[1])} ${f(s[2])} ${f(s[3])} ${f(s[4])} ${f(s[5])} ${f(s[6])} c`);
    else ops.push('h');
  }
  return ops.join(' ');
}

/* Encloses any area? Zero-area paths (a tick, a grid line) are only
   stroked: a PDF reader may paint a hairline for a filled zero-area path. */
function hasArea(segs) {
  let pts = [];
  let total = 0;
  const flush = () => {
    if (pts.length > 2) {
      let a = 0;
      for (let i = 0; i < pts.length; i++) {
        const [x1, y1] = pts[i]; const [x2, y2] = pts[(i + 1) % pts.length];
        a += x1 * y2 - x2 * y1;
      }
      total += Math.abs(a);
    }
    pts = [];
  };
  for (const s of segs) {
    if (s[0] === 'M') { flush(); pts.push([s[1], s[2]]); }
    else if (s[0] === 'L') pts.push([s[1], s[2]]);
    else if (s[0] === 'C') pts.push([s[1], s[2]], [s[3], s[4]], [s[5], s[6]]);
    else { const start = pts[0]; flush(); if (start) pts.push(start); }
  }
  flush();
  return total > 1e-6;
}

/* ---------------------------------------------------------------------------
   SVG styles
--------------------------------------------------------------------------- */

const NAMED_COLOURS = {
  black: [0, 0, 0], white: [255, 255, 255], red: [255, 0, 0], green: [0, 128, 0], blue: [0, 0, 255],
  gray: [128, 128, 128], grey: [128, 128, 128], silver: [192, 192, 192], orange: [255, 165, 0],
  yellow: [255, 255, 0], purple: [128, 0, 128], navy: [0, 0, 128], teal: [0, 128, 128], maroon: [128, 0, 0]
};

/** A CSS colour as {r, g, b, a} (0-1), or null for none. */
export function parseColour(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim().toLowerCase();
  if (!s || s === 'none' || s === 'transparent') return null;
  let m = s.match(/^#([0-9a-f]{3,8})$/);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
    const r = parseInt(h.slice(0, 2), 16); const g = parseInt(h.slice(2, 4), 16); const b = parseInt(h.slice(4, 6), 16);
    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    return { r: r / 255, g: g / 255, b: b / 255, a };
  }
  m = s.match(/^rgba?\(([^)]*)\)$/);
  if (m) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean);
    // A channel is 0-255 or a percentage; alpha is 0-1 or a percentage.
    const part = (x, full, missing) => {
      const v = x === undefined ? NaN : x.endsWith('%') ? parseFloat(x) / 100 : parseFloat(x) / full;
      return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : missing;
    };
    return { r: part(p[0], 255, 0), g: part(p[1], 255, 0), b: part(p[2], 255, 0), a: part(p[3], 1, 1) };
  }
  m = s.match(/^hsla?\(([^)]*)\)$/);
  if (m) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean);
    const h = ((parseFloat(p[0]) % 360) + 360) % 360 / 60;
    const sat = clamp01(parseFloat(p[1]) / 100); const l = clamp01(parseFloat(p[2]) / 100);
    const a = p[3] === undefined ? 1 : p[3].endsWith('%') ? parseFloat(p[3]) / 100 : parseFloat(p[3]);
    const c = (1 - Math.abs(2 * l - 1)) * sat; const x = c * (1 - Math.abs((h % 2) - 1)); const o = l - c / 2;
    const [r, g, b] = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x] : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x];
    return { r: r + o, g: g + o, b: b + o, a: Number.isFinite(a) ? clamp01(a) : 1 };
  }
  if (NAMED_COLOURS[s]) { const [r, g, b] = NAMED_COLOURS[s]; return { r: r / 255, g: g / 255, b: b / 255, a: 1 }; }
  return null;
}

function parseStyleAttr(s) {
  const out = {};
  if (!s) return out;
  for (const part of String(s).split(';')) {
    const c = part.indexOf(':');
    if (c < 0) continue;
    const k = part.slice(0, c).trim().toLowerCase();
    const v = part.slice(c + 1).trim().replace(/\s*!important$/, '');
    if (k) out[k] = v;
  }
  return out;
}

const INHERITED = ['fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-opacity', 'stroke-width', 'stroke-dasharray',
  'stroke-dashoffset', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'font-family', 'font-size',
  'font-weight', 'font-style', 'text-anchor', 'visibility', 'white-space'];
const OWN = ['opacity', 'display', 'clip-path', 'transform'];

const DEFAULT_STYLE = {
  fill: '#000', 'fill-opacity': '1', 'fill-rule': 'nonzero', stroke: 'none', 'stroke-opacity': '1',
  'stroke-width': '1', 'stroke-dasharray': 'none', 'stroke-dashoffset': '0', 'stroke-linecap': 'butt',
  'stroke-linejoin': 'miter', 'stroke-miterlimit': '4', 'font-family': 'sans-serif', 'font-size': '16px',
  'font-weight': 'normal', 'font-style': 'normal', 'text-anchor': 'start', visibility: 'visible', 'white-space': 'normal'
};

function lengthPx(v, fontSize = 16) {
  const s = String(v).trim();
  const n = parseFloat(s);
  if (!Number.isFinite(n)) return 0;
  if (s.endsWith('em')) return n * fontSize;
  if (s.endsWith('pt')) return n * 96 / 72;
  if (s.endsWith('in')) return n * 96;
  if (s.endsWith('mm')) return n * 96 / 25.4;
  if (s.endsWith('cm')) return n * 96 / 2.54;
  return n;
}

function resolveStyle(el, parent) {
  const own = parseStyleAttr(el.attrs.style);
  const st = { ...parent, opacity: 1, display: 'inline', 'clip-path': 'none' };
  for (const k of [...INHERITED, ...OWN]) {
    const v = own[k] ?? el.attrs[k];
    if (v === undefined || v === 'inherit' || k === 'transform') continue;
    if (k === 'font-size') {
      const s = String(v).trim();
      const base = parent._fontPx || 16;
      st._fontPx = s.endsWith('%') ? base * parseFloat(s) / 100 : s.endsWith('em') ? base * parseFloat(s) : lengthPx(s, base) || base;
      st['font-size'] = v;
      continue;
    }
    st[k] = v;
  }
  if (st._fontPx === undefined) st._fontPx = 16;
  st._opacity = (parent._opacity ?? 1) * clamp01(parseFloat(st.opacity));
  return st;
}

const clamp01 = (v) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1);

function isBold(w) {
  const s = String(w).trim().toLowerCase();
  return s === 'bold' || s === 'bolder' || (Number(s) >= 600);
}

/* ---------------------------------------------------------------------------
   SVG -> PDF
--------------------------------------------------------------------------- */

const SKIP = new Set(['defs', 'clipPath', 'clippath', 'mask', 'pattern', 'linearGradient', 'radialGradient', 'filter',
  'marker', 'symbol', 'style', 'script', 'title', 'desc', 'metadata', 'image', 'use', 'foreignObject', 'textPath']);

function collectById(node, map = new Map()) {
  if (!node || !node.name) return map;
  if (node.attrs.id) map.set(node.attrs.id, node);
  for (const c of node.children) collectById(c, map);
  return map;
}

function localName(el) { return el.name.replace(/^.*:/, ''); }

function shapeSegments(el) {
  const a = el.attrs;
  const n = (k, d = 0) => { const v = parseFloat(a[k]); return Number.isFinite(v) ? v : d; };
  switch (localName(el)) {
    case 'path': return parsePath(a.d);
    case 'rect': {
      const x = n('x'); const y = n('y'); const w = n('width'); const h = n('height');
      if (!(w > 0) || !(h > 0)) return [];
      let rx = Math.min(n('rx', n('ry')), w / 2); let ry = Math.min(n('ry', n('rx')), h / 2);
      if (!(rx > 0) || !(ry > 0)) return [['M', x, y], ['L', x + w, y], ['L', x + w, y + h], ['L', x, y + h], ['Z']];
      rx = Math.max(0, rx); ry = Math.max(0, ry);
      return parsePath(`M${x + rx},${y}H${x + w - rx}A${rx},${ry} 0 0 1 ${x + w},${y + ry}V${y + h - ry}A${rx},${ry} 0 0 1 ${x + w - rx},${y + h}H${x + rx}A${rx},${ry} 0 0 1 ${x},${y + h - ry}V${y + ry}A${rx},${ry} 0 0 1 ${x + rx},${y}Z`);
    }
    case 'line': return [['M', n('x1'), n('y1')], ['L', n('x2'), n('y2')]];
    case 'polyline': case 'polygon': {
      const p = (String(a.points || '').match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) || []).map(Number);
      const segs = [];
      for (let i = 0; i + 1 < p.length; i += 2) segs.push([i ? 'L' : 'M', p[i], p[i + 1]]);
      if (localName(el) === 'polygon' && segs.length) segs.push(['Z']);
      return segs;
    }
    case 'circle': case 'ellipse': {
      const cx = n('cx'); const cy = n('cy');
      const rx = localName(el) === 'circle' ? n('r') : n('rx'); const ry = localName(el) === 'circle' ? n('r') : n('ry');
      if (!(rx > 0) || !(ry > 0)) return [];
      return parsePath(`M${cx + rx},${cy}A${rx},${ry} 0 1 1 ${cx - rx},${cy}A${rx},${ry} 0 1 1 ${cx + rx},${cy}Z`);
    }
    default: return [];
  }
}

function colourOps(c, stroke) {
  const f = (v) => pdfNumber(Math.round(v * 1000) / 1000);
  return `${f(c.r)} ${f(c.g)} ${f(c.b)} ${stroke ? 'RG' : 'rg'}`;
}

function dashOps(st) {
  const d = String(st['stroke-dasharray'] || 'none').trim();
  if (!d || d === 'none') return '[] 0 d';
  let arr = d.split(/[\s,]+/).map((x) => lengthPx(x)).filter((x) => Number.isFinite(x) && x >= 0);
  if (!arr.length || arr.every((x) => x === 0)) return '[] 0 d';
  if (arr.length % 2) arr = arr.concat(arr);
  return `[${arr.map((v) => pdfNumber(v)).join(' ')}] ${pdfNumber(lengthPx(st['stroke-dashoffset'] || 0))} d`;
}

const CAP = { butt: 0, round: 1, square: 2 };
const JOIN = { miter: 0, round: 1, bevel: 2, 'miter-clip': 0, arcs: 0 };

class SvgToPdf {
  constructor(doc, root) {
    this.doc = doc;
    this.ids = collectById(root);
    this.out = [];
  }

  clipOps(el) {
    const ref = String(el.attrs['clip-path'] || parseStyleAttr(el.attrs.style)['clip-path'] || '');
    // Plotly writes url(#id), or url(<page address>#id) when the page has a
    // <base> element; only the id matters here.
    const m = ref.match(/url\(\s*['"]?[^#'")]*#([^'")\s]+)['"]?\s*\)/);
    if (!m) return '';
    const cp = this.ids.get(m[1]);
    if (!cp) return '';
    const parts = [];
    const cpm = parseTransform(cp.attrs.transform);
    for (const child of cp.children) {
      if (!child.name) continue;
      const segs = shapeSegments(child);
      if (!segs.length) continue;
      const cm = parseTransform(child.attrs.transform);
      const mm = cpm && cm ? multiply(cpm, cm) : cpm || cm;
      parts.push(mm ? segmentsToOps(transformSegments(segs, mm)) : segmentsToOps(segs));
    }
    // An empty clip path hides everything it applies to.
    return parts.length ? `${parts.join(' ')} W n` : '0 0 m 0 0 l h W n';
  }

  paint(segs, st) {
    if (!segs.length) return;
    const fill = parseColour(st.fill);
    const stroke = parseColour(st.stroke);
    const fa = fill ? fill.a * clamp01(parseFloat(st['fill-opacity'])) * st._opacity : 0;
    const sw = lengthPx(st['stroke-width'], st._fontPx);
    const sa = stroke ? stroke.a * clamp01(parseFloat(st['stroke-opacity'])) * st._opacity : 0;
    const doFill = fill && fa > 0.001 && hasArea(segs);
    const doStroke = stroke && sa > 0.001 && sw > 0;
    if (!doFill && !doStroke) return;
    const ops = ['q'];
    if ((doFill && fa < 0.999) || (doStroke && sa < 0.999)) ops.push(`/${this.doc.alpha(doFill ? fa : 1, doStroke ? sa : 1)} gs`);
    if (doFill) ops.push(colourOps(fill, false));
    if (doStroke) {
      ops.push(colourOps(stroke, true));
      ops.push(`${pdfNumber(sw)} w ${CAP[st['stroke-linecap']] ?? 0} J ${JOIN[st['stroke-linejoin']] ?? 0} j ${pdfNumber(Math.max(1, parseFloat(st['stroke-miterlimit']) || 4))} M ${dashOps(st)}`);
    }
    ops.push(segmentsToOps(segs));
    const evenOdd = String(st['fill-rule']).trim() === 'evenodd';
    ops.push(doFill && doStroke ? (evenOdd ? 'B*' : 'B') : doFill ? (evenOdd ? 'f*' : 'f') : 'S');
    ops.push('Q');
    this.out.push(ops.join(' '));
  }

  text(el, st) {
    // Flatten the text element into moves and glyph runs, then lay each
    // chunk (a run of text that starts at an absolute position) out with the
    // PDF font's metrics, so text-anchor is honoured in the PDF typeface.
    const items = [];
    const walk = (node, s, isRoot) => {
      const a = node.attrs;
      const fs = s._fontPx;
      const first = (v) => { const p = String(v).trim().split(/[\s,]+/)[0]; return lengthPx(p, fs); };
      if (a.x !== undefined || a.y !== undefined) {
        items.push({ move: 'abs', x: a.x !== undefined ? first(a.x) : null, y: a.y !== undefined ? first(a.y) : null, anchor: s['text-anchor'] });
      } else if (isRoot) {
        items.push({ move: 'abs', x: 0, y: 0, anchor: s['text-anchor'] });
      }
      if (a.dx !== undefined || a.dy !== undefined) items.push({ move: 'rel', dx: a.dx !== undefined ? first(a.dx) : 0, dy: a.dy !== undefined ? first(a.dy) : 0 });
      for (const c of node.children) {
        if (c.text !== undefined) {
          let t = c.text;
          if (!/pre/.test(String(s['white-space']))) t = t.replace(/[\t\n\r ]+/g, ' ');
          if (t) items.push({ text: t, style: s });
        } else if (c.name && (localName(c) === 'tspan' || localName(c) === 'a')) {
          // Plotly writes a link in a label as <a> holding the text.
          const cs = resolveStyle(c, s);
          if (cs.display === 'none') continue;
          walk(c, cs, false);
        }
      }
    };
    walk(el, st, true);
    if (!items.some((it) => it.text)) return;

    // Chunks.
    const chunks = [];
    let cur = null;
    for (const it of items) {
      if (it.move === 'abs') { cur = { x: it.x, y: it.y, anchor: it.anchor || st['text-anchor'], parts: [] }; chunks.push(cur); continue; }
      if (!cur) { cur = { x: 0, y: 0, anchor: st['text-anchor'], parts: [] }; chunks.push(cur); }
      cur.parts.push(it);
    }
    let penX = 0; let penY = 0;
    for (const ch of chunks) {
      if (ch.x !== null && ch.x !== undefined) penX = ch.x;
      if (ch.y !== null && ch.y !== undefined) penY = ch.y;
      // Measure.
      const runs = [];
      let width = 0;
      for (const p of ch.parts) {
        if (p.move === 'rel') { runs.push(p); width += p.dx; continue; }
        const s = p.style;
        const base = standardFontFor(s['font-family'], isBold(s['font-weight']), /italic|oblique/.test(String(s['font-style'])));
        for (const r of encodeText(p.text, base)) {
          const w = r.width * s._fontPx / 1000;
          runs.push({ ...r, w, size: s._fontPx, style: s, italic: /italic|oblique/.test(String(s['font-style'])) });
          width += w;
        }
      }
      const anchor = String(ch.anchor || 'start').trim();
      let x = penX - (anchor === 'middle' ? width / 2 : anchor === 'end' ? width : 0);
      let y = penY;
      for (const r of runs) {
        if (r.move === 'rel') { x += r.dx; y += r.dy; continue; }
        const fill = parseColour(r.style.fill);
        const alpha = fill ? fill.a * clamp01(parseFloat(r.style['fill-opacity'])) * r.style._opacity : 0;
        if (fill && alpha > 0.001 && r.style.visibility !== 'hidden') this.glyphs(r, x, y, fill, alpha);
        x += r.w;
      }
      penX = x; penY = y;
    }
  }

  /* One run of glyphs with its baseline starting at (x, y), in SVG units.
     The run is wrapped in q … Q so that its colour and opacity do not carry
     over to whatever is drawn next. */
  glyphs(r, x, y, fill, alpha) {
    const f = pdfNumber;
    const size = r.size * (r.scale || 1);
    const base = y - (r.rise || 0) * r.size;
    // Symbol has no italic; slant it as the text font's italic is slanted.
    const skew = r.italic && r.font === 'Symbol' ? 0.21 : 0;
    const ops = ['q'];
    if (alpha < 0.999) ops.push(`/${this.doc.alpha(alpha, 1)} gs`);
    ops.push(colourOps(fill, false), 'BT', `/${this.doc.font(r.font)} ${f(size)} Tf`);
    // The CTM has y pointing down, so an upright glyph needs d = -1. A
    // flipped run keeps d = +1 and moves up by the glyph height, so that
    // it turns over within the band an upright glyph would fill.
    if (r.flip) ops.push(`1 0 ${f(-skew)} 1 ${f(x)} ${f(base - FLIP_HEIGHT * size)} Tm`);
    else ops.push(`1 0 ${f(skew)} -1 ${f(x)} ${f(base)} Tm`);
    ops.push(`${literal(r.codes)} Tj`, 'ET');
    if (r.bar) {
      // The bar of ħ: across the ascender, between x-height and cap height.
      const t = (/Bold/.test(r.font) ? 0.09 : 0.06) * size;
      const lean = /Oblique|Italic/.test(r.font) ? 0.21 * BAR_HEIGHT * size : 0;
      const x1 = x + 0.1 * r.w + lean;
      ops.push(`${f(x1)} ${f(base - BAR_HEIGHT * size - t / 2)} ${f(0.55 * r.w)} ${f(t)} re f`);
    }
    ops.push('Q');
    this.out.push(ops.join(' '));
  }

  node(el, parentStyle) {
    if (!el || !el.name) return;
    const name = localName(el);
    if (SKIP.has(name)) return;
    const st = resolveStyle(el, parentStyle);
    if (String(st.display).trim() === 'none') return;
    let m = parseTransform(el.attrs.transform);
    if (name === 'svg' && el !== this.root) {
      const x = parseFloat(el.attrs.x) || 0; const y = parseFloat(el.attrs.y) || 0;
      if (x || y) m = m ? multiply([1, 0, 0, 1, x, y], m) : [1, 0, 0, 1, x, y];
    }
    const clip = this.clipOps(el);
    const wrap = !!(m || clip);
    if (wrap) {
      this.out.push('q');
      if (m) this.out.push(`${m.map((v) => pdfNumber(v, 6)).join(' ')} cm`);
      if (clip) this.out.push(clip);
    }
    if (name === 'text') {
      this.text(el, st);
    } else if (name === 'g' || name === 'svg' || name === 'a' || name === 'switch') {
      for (const c of el.children) this.node(c, st);
    } else if (st.visibility !== 'hidden' && st.visibility !== 'collapse') {
      this.paint(shapeSegments(el), st);
    }
    if (wrap) this.out.push('Q');
  }

  run(root, pageW, pageH) {
    this.root = root;
    const vb = String(root.attrs.viewBox || '').trim().split(/[\s,]+/).map(Number);
    const w = lengthPx(root.attrs.width || (vb.length === 4 ? vb[2] : pageW / 0.75));
    const h = lengthPx(root.attrs.height || (vb.length === 4 ? vb[3] : pageH / 0.75));
    const [vx, vy, vw, vh] = vb.length === 4 && vb[2] > 0 && vb[3] > 0 ? vb : [0, 0, w, h];
    const sx = pageW / vw; const sy = pageH / vh;
    this.out.push('q');
    this.out.push(`${[sx, 0, 0, -sy, -vx * sx, pageH + vy * sy].map((v) => pdfNumber(v, 6)).join(' ')} cm`);
    const base = { ...DEFAULT_STYLE, _fontPx: 16, _opacity: 1 };
    const st = resolveStyle(root, base);
    for (const c of root.children) this.node(c, st);
    this.out.push('Q');
    return this.out.join('\n');
  }
}

function transformSegments(segs, m) {
  const tp = (x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  return segs.map((s) => {
    if (s[0] === 'Z') return s;
    if (s[0] === 'C') return ['C', ...tp(s[1], s[2]), ...tp(s[3], s[4]), ...tp(s[5], s[6])];
    return [s[0], ...tp(s[1], s[2])];
  });
}

/**
 * A vector PDF of an SVG drawing, one page, the SVG scaled to fill it.
 *
 * @param {string} svgText
 * @param {object} [opts]
 * @param {number} [opts.widthIn]  page width in inches (default: the SVG's width at 96 px per inch)
 * @param {number} [opts.heightIn] page height in inches (default: likewise)
 * @param {string} [opts.title]
 * @param {Date}   [opts.date]
 * @returns {Uint8Array}
 */
export function pdfFromSvg(svgText, { widthIn, heightIn, title = '', date } = {}) {
  const root = parseXml(String(svgText));
  if (!root || localName(root) !== 'svg') throw new Error('pdfFromSvg: not an SVG document');
  const vb = String(root.attrs.viewBox || '').trim().split(/[\s,]+/).map(Number);
  const wPx = lengthPx(root.attrs.width || vb[2] || 0);
  const hPx = lengthPx(root.attrs.height || vb[3] || 0);
  const W = (widthIn || wPx / PIXELS_PER_INCH) * POINTS_PER_INCH;
  const H = (heightIn || hPx / PIXELS_PER_INCH) * POINTS_PER_INCH;
  if (!(W > 0) || !(H > 0)) throw new Error('pdfFromSvg: the SVG has no size');
  const doc = new PdfDocument({ width: W, height: H, title, date });
  doc.draw(new SvgToPdf(doc, root).run(root, W, H));
  return doc.toBytes();
}
