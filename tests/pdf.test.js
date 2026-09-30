import { describe, test, expect } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  PdfDocument, pdfFromSvg, pdfFromJpeg, jpegInfo, pdfNumber, encodeText, textWidth, standardFontFor,
  parseTransform, parsePath, parseColour, parseXml, STANDARD_FONTS
} from '../src/core/pdf.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(here, 'fixtures', 'pdf');
const fixture = (name) => fs.readFileSync(path.join(FIX, name), 'utf8');

const HAVE_PDFTOPPM = spawnSync('pdftoppm', ['-v'], { encoding: 'utf8' }).status === 0;
const DATE = new Date(Date.UTC(2026, 0, 2, 3, 4, 5));

/* ------------------------------------------------------------------ *
 * A small PDF reader, strict about the parts the writer must get right
 * ------------------------------------------------------------------ */

const latin1 = (bytes) => Buffer.from(bytes).toString('latin1');

/**
 * Parse the file through its cross-reference table, as a reader does, and
 * fail on anything a reader would have to repair.
 */
function readPdf(bytes) {
  const s = latin1(bytes);
  expect(s.startsWith('%PDF-1.4\n')).toBe(true);
  expect(s.endsWith('%%EOF\n')).toBe(true);
  const sx = s.match(/startxref\n(\d+)\n%%EOF\n$/);
  expect(sx).not.toBeNull();
  const xrefAt = Number(sx[1]);
  expect(s.slice(xrefAt, xrefAt + 5)).toBe('xref\n');
  const head = s.slice(xrefAt).match(/^xref\n0 (\d+)\n/);
  const count = Number(head[1]);
  const table = s.slice(xrefAt + head[0].length, xrefAt + head[0].length + count * 20);
  // Every entry is exactly 20 bytes: 10 digits, space, 5 digits, space, type, space, LF.
  expect(table.length).toBe(count * 20);
  expect(table.slice(0, 20)).toBe('0000000000 65535 f \n');
  const objects = new Map();
  for (let n = 1; n < count; n++) {
    const e = table.slice(n * 20, n * 20 + 20);
    expect(e).toMatch(/^\d{10} 00000 n \n$/);
    const off = Number(e.slice(0, 10));
    expect(s.startsWith(`${n} 0 obj\n`, off)).toBe(true);
    const end = s.indexOf('endobj', off);
    objects.set(n, { offset: off, body: s.slice(off + `${n} 0 obj\n`.length, end) });
  }
  const trailer = s.slice(xrefAt + head[0].length + count * 20);
  expect(trailer.startsWith('trailer\n')).toBe(true);
  expect(trailer).toContain(`/Size ${count}`);
  const ref = (key, dict) => Number(dict.match(new RegExp(`/${key} (\\d+) 0 R`))[1]);
  const root = objects.get(ref('Root', trailer)).body;
  expect(root).toContain('/Type /Catalog');
  const pages = objects.get(ref('Pages', root)).body;
  expect(pages).toContain('/Count 1');
  const pageNum = Number(pages.match(/\/Kids \[(\d+) 0 R\]/)[1]);
  const page = objects.get(pageNum).body;
  const stream = (n) => {
    const o = objects.get(n);
    const len = Number(o.body.match(/\/Length (\d+)/)[1]);
    const start = o.offset + `${n} 0 obj\n`.length + o.body.indexOf('stream\n') + 'stream\n'.length;
    // /Length must end the data exactly where "endstream" begins.
    expect(s.slice(start + len, start + len + 11)).toBe('\nendstream\n');
    return s.slice(start, start + len);
  };
  const content = stream(ref('Contents', page));
  const mediaBox = page.match(/\/MediaBox \[([^\]]*)\]/)[1].split(' ').map(Number);
  const info = objects.get(ref('Info', trailer)).body;
  return { s, objects, page, content, mediaBox, info, stream, count };
}

/* Fonts named in the page resources, as { F1: 'Helvetica', … }. */
function fontsOf(pdf) {
  const out = {};
  const res = pdf.page.match(/\/Font << ([^>]*) >>/);
  if (!res) return out;
  for (const [, name, n] of res[1].matchAll(/\/(\w+) (\d+) 0 R/g)) {
    out[name] = pdf.objects.get(Number(n)).body.match(/\/BaseFont \/([\w-]+)/)[1];
  }
  return out;
}

/* Text-showing operations as { font, size, string, tm }. */
function textRuns(pdf) {
  const fonts = fontsOf(pdf);
  const runs = [];
  const re = /BT \/(\w+) ([\d.]+) Tf (1 0 [-\d.]+ -?1 [-\d.]+ [-\d.]+) Tm (\((?:\\.|[^\\)])*\)) Tj ET/g;
  for (const [, f, size, tm, str] of pdf.content.matchAll(re)) runs.push({ font: fonts[f], size: Number(size), tm: tm.split(' ').map(Number), string: str });
  return runs;
}

const svgDoc = (body, w = 200, h = 100) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`;
const convert = (body, w, h, opts = {}) => readPdf(pdfFromSvg(svgDoc(body, w, h), { date: DATE, ...opts }));

/* ------------------------------------------------------------------ *
 * Numbers and strings
 * ------------------------------------------------------------------ */

describe('pdfNumber', () => {
  test('plain decimals, trimmed, no exponent and no negative zero', () => {
    expect(pdfNumber(0)).toBe('0');
    expect(pdfNumber(100)).toBe('100');
    expect(pdfNumber(-2.5)).toBe('-2.5');
    expect(pdfNumber(0.1 + 0.2)).toBe('0.3');
    expect(pdfNumber(1.23456)).toBe('1.235');
    expect(pdfNumber(-0.0001)).toBe('0');
    expect(pdfNumber(-0)).toBe('0');
    expect(pdfNumber(1e-9)).toBe('0');
    expect(pdfNumber(1e25)).toBe('10000000');
    expect(pdfNumber(-1e25)).toBe('-10000000');
    expect(pdfNumber(NaN)).toBe('0');
    expect(pdfNumber(Infinity)).toBe('0');
    for (const v of [1e-7, 123456.789, -98765.4321, 5e6]) expect(pdfNumber(v)).not.toMatch(/e/i);
  });

  test('more decimals on request', () => {
    expect(pdfNumber(0.7071067811, 6)).toBe('0.707107');
    expect(pdfNumber(0.75, 6)).toBe('0.75');
    expect(pdfNumber(-0.0000001, 6)).toBe('0');
  });
});

describe('encodeText', () => {
  test('WinAnsi characters stay in the text font, with AFM widths', () => {
    const [r] = encodeText('Hello', 'Helvetica');
    expect(r.font).toBe('Helvetica');
    expect(r.codes).toEqual([72, 101, 108, 108, 111]);
    expect(r.width).toBe(722 + 556 + 222 + 222 + 556);
    expect(textWidth('Hello', 'Helvetica', 10)).toBeCloseTo(22.78, 10);
    expect(textWidth('iii', 'Courier', 10)).toBeCloseTo(18, 10);
    expect(encodeText('é±×µÅ°²€’', 'Times-Roman')[0].codes).toEqual([233, 177, 215, 181, 197, 176, 178, 128, 146]);
  });

  test('Greek letters and maths signs go to Symbol', () => {
    const runs = encodeText('τ = 5 μs − 1', 'Helvetica');
    expect(runs.map((r) => r.font)).toEqual(['Symbol', 'Helvetica', 'Symbol', 'Helvetica', 'Symbol', 'Helvetica']);
    expect(runs[0]).toEqual({ font: 'Symbol', codes: [116], width: 439 });
    expect(runs[2].codes).toEqual([109]);
    expect(runs[4].codes).toEqual([45]);
    expect(encodeText('ΑΩ', 'Helvetica')[0].codes).toEqual([65, 87]);
  });

  test('characters no font has are made, stood in for, or shown as ?', () => {
    const mp = encodeText('∓', 'Helvetica')[0];
    expect(mp).toMatchObject({ font: 'Symbol', codes: [177], flip: true });
    expect(encodeText('ħ', 'Helvetica')[0]).toMatchObject({ font: 'Helvetica', codes: [104], bar: true });
    expect(encodeText('ℓ', 'Times-Roman')[0]).toMatchObject({ font: 'Times-Italic', codes: [108] });
    expect(encodeText('ℓ', 'Helvetica-Bold')[0].font).toBe('Helvetica-BoldOblique');
    expect(encodeText('a∥b', 'Helvetica')[0].codes).toEqual([97, 124, 124, 98]);
    expect(encodeText('ő', 'Helvetica')[0].codes).toEqual([111]);   // unaccented
    expect(encodeText('水', 'Helvetica')[0].codes).toEqual([63]);   // no stand-in
    expect(encodeText('a​b́', 'Helvetica')[0].codes).toEqual([97, 98]);
    expect(encodeText('a b', 'Helvetica')[0].codes).toEqual([97, 32, 98]);
  });

  test('Unicode superscripts and subscripts become small shifted runs', () => {
    const runs = encodeText('s⁻¹ H₂O m³', 'Helvetica');
    const sup = runs.find((r) => r.font === 'Symbol');
    expect(sup).toMatchObject({ codes: [45], scale: 0.6, rise: 0.28 });
    expect(sup.width).toBeCloseTo(549 * 0.6, 10);
    // ¹ and ³ are WinAnsi glyphs already drawn as superscripts.
    expect(runs.some((r) => r.codes.includes(185) && !r.scale)).toBe(true);
    expect(runs.some((r) => r.codes.includes(179) && !r.scale)).toBe(true);
    const sub = runs.find((r) => r.rise < 0);
    expect(sub).toMatchObject({ font: 'Helvetica', codes: [50], scale: 0.6, rise: -0.15 });
    expect(encodeText('xⁿ', 'Times-Roman')[1]).toMatchObject({ codes: [110], scale: 0.6 });
  });
});

describe('standardFontFor', () => {
  test('font stacks map to the standard families', () => {
    expect(standardFontFor('Arial, Helvetica, "Liberation Sans", "DejaVu Sans", sans-serif')).toBe('Helvetica');
    expect(standardFontFor('"Times New Roman", Times, "Nimbus Roman", serif')).toBe('Times-Roman');
    expect(standardFontFor('"Courier New", Courier, "DejaVu Sans Mono", monospace')).toBe('Courier');
    expect(standardFontFor('"Open Sans", verdana, arial, sans-serif')).toBe('Helvetica');
    expect(standardFontFor('serif', true, true)).toBe('Times-BoldItalic');
    expect(standardFontFor('monospace', false, true)).toBe('Courier-Oblique');
    expect(standardFontFor('Unknown Face', true)).toBe('Helvetica-Bold');
    expect(standardFontFor('')).toBe('Helvetica');
  });
});

/* ------------------------------------------------------------------ *
 * SVG pieces
 * ------------------------------------------------------------------ */

describe('parseTransform', () => {
  const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  const close = (a, b) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 9));

  test('single transforms', () => {
    expect(parseTransform('translate(10,20)')).toEqual([1, 0, 0, 1, 10, 20]);
    expect(parseTransform('translate(10)')).toEqual([1, 0, 0, 1, 10, 0]);
    expect(parseTransform('scale(2)')).toEqual([2, 0, 0, 2, 0, 0]);
    expect(parseTransform('scale(2 3)')).toEqual([2, 0, 0, 3, 0, 0]);
    expect(parseTransform('matrix(1 2 3 4 5 6)')).toEqual([1, 2, 3, 4, 5, 6]);
    close(parseTransform('rotate(90)'), [0, 1, -1, 0, 0, 0]);
    close(apply(parseTransform('skewX(45)'), 0, 1), [1, 1]);
    close(apply(parseTransform('skewY(45)'), 1, 0), [1, 1]);
  });

  test('rotate about a point keeps the point fixed (Plotly y titles)', () => {
    const m = parseTransform('rotate(-90,42,164.1)');
    close(apply(m, 42, 164.1), [42, 164.1]);
    close(apply(m, 52, 164.1), [42, 154.1]);
  });

  test('a list applies right to left, as SVG does', () => {
    const m = parseTransform('translate(100, 0) scale(2) rotate(90)');
    close(apply(m, 1, 0), [100, 2]);
    expect(parseTransform('translate(1e1,-2.5e-1)')).toEqual([1, 0, 0, 1, 10, -0.25]);
  });

  test('empty or unknown gives null', () => {
    expect(parseTransform('')).toBeNull();
    expect(parseTransform(undefined)).toBeNull();
    expect(parseTransform('wobble(3)')).toBeNull();
  });
});

describe('parsePath', () => {
  test('absolute and relative lines, implicit line-tos, H and V', () => {
    expect(parsePath('M10,20L30,40')).toEqual([['M', 10, 20], ['L', 30, 40]]);
    expect(parsePath('m10 20 5 5 l-5 0')).toEqual([['M', 10, 20], ['L', 15, 25], ['L', 10, 25]]);
    expect(parsePath('M5,0h30v6h-30Z')).toEqual([['M', 5, 0], ['L', 35, 0], ['L', 35, 6], ['L', 5, 6], ['Z']]);
    expect(parsePath('M1 1H4V8')).toEqual([['M', 1, 1], ['L', 4, 1], ['L', 4, 8]]);
  });

  test('closepath returns to the subpath start for a relative move', () => {
    expect(parsePath('M10 10 l5 0 z m1 1')).toEqual([['M', 10, 10], ['L', 15, 10], ['Z'], ['M', 11, 11]]);
  });

  test('number syntax: exponents, signs as separators, run-together decimals', () => {
    expect(parsePath('M1e1-2.5L.5.5')).toEqual([['M', 10, -2.5], ['L', 0.5, 0.5]]);
    expect(parsePath('M0,0L1.5.25')).toEqual([['M', 0, 0], ['L', 1.5, 0.25]]);
  });

  test('curves: C, S reflects, Q becomes an exact cubic, T reflects', () => {
    expect(parsePath('M0 0C1 1 2 1 3 0S5 -1 6 0')).toEqual([['M', 0, 0], ['C', 1, 1, 2, 1, 3, 0], ['C', 4, -1, 5, -1, 6, 0]]);
    const q = parsePath('M0 0Q3 3 6 0');
    expect(q[1][0]).toBe('C');
    [2, 2, 4, 2, 6, 0].forEach((v, i) => expect(q[1][i + 1]).toBeCloseTo(v, 12));
    const t = parsePath('M0 0Q3 3 6 0T12 0');
    [8, -2, 10, -2, 12, 0].forEach((v, i) => expect(t[2][i + 1]).toBeCloseTo(v, 12));
  });

  test('arcs become cubics through the right points', () => {
    // Plotly's circle marker: two half circles of radius 4.5.
    const segs = parsePath('M4.5,0A4.5,4.5 0 1,1 0,-4.5A4.5,4.5 0 0,1 4.5,0Z');
    expect(segs.filter((s) => s[0] === 'C').length).toBe(4);
    for (const s of segs.filter((x) => x[0] === 'C')) expect(Math.hypot(s[5], s[6])).toBeCloseTo(4.5, 9);
    // Midpoint of a quarter circle lies on the circle (cubic error < 0.03%).
    const [, c] = parsePath('M10 0A10 10 0 0 1 0 10');
    const mx = 0.125 * 10 + 0.375 * c[1] + 0.375 * c[3] + 0.125 * c[5];
    const my = 0.125 * 0 + 0.375 * c[2] + 0.375 * c[4] + 0.125 * c[6];
    expect(Math.abs(Math.hypot(mx, my) - 10)).toBeLessThan(10 * 3e-4);
    expect(c.slice(5)).toEqual([0, 10]);
  });

  test('arc flags written together, relative arcs, degenerate arcs', () => {
    expect(parsePath('M0 0a5 5 0 0110 0').slice(-1)[0].slice(5)).toEqual([10, 0]);
    expect(parsePath('M0 0a5 5 0 1 1 10 0').slice(-1)[0].slice(5)).toEqual([10, 0]);
    expect(parsePath('M0 0A0 5 0 0 1 10 0')).toEqual([['M', 0, 0], ['L', 10, 0]]);
    expect(parsePath('M3 3A5 5 0 0 1 3 3')).toEqual([['M', 3, 3]]);
    // Radii too small for the endpoints are scaled up: a half circle.
    const half = parsePath('M0 0A1 1 0 0 1 10 0');
    const tops = half.filter((s) => s[0] === 'C').map((s) => s[6]);
    expect(Math.min(...tops)).toBeCloseTo(-5, 9);
  });

  test('garbage does not throw', () => {
    expect(parsePath('')).toEqual([]);
    expect(parsePath(undefined)).toEqual([]);
    expect(() => parsePath('M 1 L L Z 4 4 x y')).not.toThrow();
  });
});

describe('parseColour', () => {
  test('the forms Plotly and hand-written SVG use', () => {
    expect(parseColour('#f00')).toEqual({ r: 1, g: 0, b: 0, a: 1 });
    expect(parseColour('#00ff0080')).toEqual({ r: 0, g: 1, b: 0, a: 128 / 255 });
    expect(parseColour('rgb(255, 128, 0)')).toEqual({ r: 1, g: 128 / 255, b: 0, a: 1 });
    expect(parseColour('rgba(31, 119, 180, 0.25)').a).toBe(0.25);
    expect(parseColour('rgb(100% 0% 0% / 50%)')).toEqual({ r: 1, g: 0, b: 0, a: 0.5 });
    const h = parseColour('hsl(120, 100%, 25%)');
    expect([h.r, h.g, h.b]).toEqual([0, 0.5, 0]);
    const hsla = parseColour('hsla(0, 70%, 40%, 0.5)');
    expect(hsla.r * 255).toBeCloseTo(173.4, 6);   // Plotly wrote hsl(0, 70%, 40%) as rgb(173, 31, 31)
    expect(hsla.a).toBe(0.5);
    expect(parseColour('rgb(300, -5, x)')).toEqual({ r: 1, g: 0, b: 0, a: 1 });
    expect(parseColour('Grey')).toEqual({ r: 128 / 255, g: 128 / 255, b: 128 / 255, a: 1 });
  });

  test('none, transparent and unknown draw nothing', () => {
    for (const v of ['none', 'transparent', '', undefined, null, 'url(#grad)', 'currentColor']) expect(parseColour(v)).toBeNull();
  });
});

describe('parseXml', () => {
  test('elements, attributes, entities, comments and CDATA', () => {
    const root = parseXml('<?xml version="1.0"?><!-- c --><svg a="1 &lt; 2" b=\'x > y\'><g/><text>A &amp; B &#x3c4; &#177;<![CDATA[<raw>]]></text></svg>');
    expect(root.name).toBe('svg');
    expect(root.attrs).toEqual({ a: '1 < 2', b: 'x > y' });
    expect(root.children.map((c) => c.name)).toEqual(['g', 'text']);
    expect(root.children[1].children.map((c) => c.text).join('')).toBe('A & B τ ±<raw>');
  });
});

/* ------------------------------------------------------------------ *
 * The file
 * ------------------------------------------------------------------ */

describe('PdfDocument', () => {
  test('a well-formed file: offsets, lengths, trailer, fonts, states', () => {
    const doc = new PdfDocument({ width: 200, height: 100, title: 'Fit (τ) \\ test', date: DATE });
    const f = doc.font('Helvetica');
    expect(doc.font('Helvetica')).toBe(f);
    expect(doc.font('Symbol')).toBe('F2');
    const gs = doc.alpha(0.5, 1);
    expect(doc.alpha(0.5, 1)).toBe(gs);
    doc.draw(`q /${gs} gs 1 0 0 rg 10 10 50 50 re f Q`);
    doc.draw(`BT /${f} 12 Tf 10 80 Td (a\\(b\\)) Tj ET`);
    const pdf = readPdf(doc.toBytes());
    expect(pdf.mediaBox).toEqual([0, 0, 200, 100]);
    expect(pdf.content).toContain('(a\\(b\\)) Tj');
    const bodies = [...pdf.objects.values()].map((o) => o.body);
    expect(bodies).toContain('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\n');
    expect(bodies).toContain('<< /Type /Font /Subtype /Type1 /BaseFont /Symbol >>\n');
    expect(bodies).toContain('<< /Type /ExtGState /ca 0.5 /CA 1 >>\n');
    // Non-ASCII title as UTF-16BE with a byte-order mark.
    expect(pdf.info).toContain('/Title <FEFF0046006900740020002803C400290020005C00200074006500730074>');
    expect(pdf.info).toContain('/CreationDate (D:20260102030405Z)');
    expect(pdf.s.slice(9, 15)).toBe('%\xe2\xe3\xcf\xd3\n');
  });

  test('an ASCII title is a literal string with its specials escaped', () => {
    const pdf = readPdf(new PdfDocument({ width: 10, height: 10, title: 'a (b) \\c', date: DATE }).toBytes());
    expect(pdf.info).toContain('/Title (a \\(b\\) \\\\c)');
  });

  test('refuses a fake font or an empty page', () => {
    expect(() => new PdfDocument({ width: 10, height: 10 }).font('Arial')).toThrow(/standard font/);
    expect(() => new PdfDocument({ width: 0, height: 10 })).toThrow(/positive/);
    expect(STANDARD_FONTS).toHaveLength(14);
  });
});

describe('pdfFromSvg: page and drawing', () => {
  test('MediaBox is the page size in points; the SVG is scaled to fill it', () => {
    const pdf = convert('<rect x="0" y="0" width="200" height="100" fill="#fff"/>', 480, 360, { widthIn: 5, heightIn: 3.75 });
    expect(pdf.mediaBox).toEqual([0, 0, 360, 270]);
    // viewBox 480×360 onto 360×270 pt, with y turned to point down.
    expect(pdf.content.split('\n')[1]).toBe('0.75 0 0 -0.75 0 270 cm');
    const scaled = convert('<rect width="10" height="10"/>', 620, 440, { widthIn: 3.5, heightIn: 2.5 });
    expect(scaled.content.split('\n')[1]).toBe('0.406452 0 0 -0.409091 0 180 cm');
  });

  test('without a size the page follows the SVG at 96 px per inch', () => {
    const pdf = readPdf(pdfFromSvg('<svg width="480" height="192"><rect width="1" height="1"/></svg>'));
    expect(pdf.mediaBox).toEqual([0, 0, 360, 144]);
    const vb = readPdf(pdfFromSvg('<svg viewBox="10 20 96 48"><rect width="1" height="1"/></svg>'));
    expect(vb.mediaBox).toEqual([0, 0, 72, 36]);
    expect(vb.content.split('\n')[1]).toBe('0.75 0 0 -0.75 -7.5 51 cm');
  });

  test('not an SVG, or an SVG with no size, throws', () => {
    expect(() => pdfFromSvg('<html></html>')).toThrow(/not an SVG/);
    expect(() => pdfFromSvg('<svg><rect/></svg>')).toThrow(/no size/);
  });

  test('fills, strokes, dashes, caps and joins', () => {
    const pdf = convert('<rect x="10" y="20" width="30" height="40" style="fill: rgb(255, 0, 0); stroke: #0000ff; stroke-width: 2px; stroke-dasharray: 3px, 1px, 2px; stroke-linecap: round; stroke-linejoin: bevel"/>');
    expect(pdf.content).toContain('q 1 0 0 rg 0 0 1 RG 2 w 1 J 2 j 4 M [3 1 2 3 1 2] 0 d 10 20 m 40 20 l 40 60 l 10 60 l h B Q');
    const line = convert('<line x1="0" y1="5" x2="100" y2="5" stroke="black"/>');
    expect(line.content).toContain('0 5 m 100 5 l S Q');
    // A zero-area path is only stroked, even with a fill set.
    const tick = convert('<path d="M0,0v5" style="fill: red; stroke: black"/>');
    expect(tick.content).toMatch(/0 0 m 0 5 l S Q/);
    const evenOdd = convert('<path d="M0 0H10V10H0Z M2 2H8V8H2Z" fill-rule="evenodd"/>');
    expect(evenOdd.content).toContain('h f* Q');
  });

  test('opacity: fill, stroke and group opacity become one graphics state', () => {
    const pdf = convert('<g style="opacity: 0.5"><rect width="10" height="10" style="fill: rgba(0, 0, 255, 0.5); stroke: #000; stroke-opacity: 0.8"/></g>');
    expect(pdf.content).toContain('/GS1 gs');
    const gsBody = [...pdf.objects.values()].map((o) => o.body).find((b) => b.startsWith('<< /Type /ExtGState'));
    expect(gsBody).toBe('<< /Type /ExtGState /ca 0.25 /CA 0.4 >>\n');
    const hidden = convert('<rect width="10" height="10" style="fill: red; fill-opacity: 0"/><rect width="5" height="5" fill="red" visibility="hidden"/><g display="none"><rect width="5" height="5"/></g>');
    expect(hidden.content).not.toMatch(/ f\b/);
  });

  test('text colour and opacity stay inside their q … Q', () => {
    const pdf = convert('<text x="10" y="20" style="fill: rgb(0, 0, 0); fill-opacity: 0.3">faint</text><rect x="10" y="40" width="50" height="30" style="fill: rgb(255, 0, 0)"/>');
    const lines = pdf.content.split('\n');
    const text = lines.find((l) => l.includes('Tj'));
    expect(text.startsWith('q /GS1 gs ')).toBe(true);
    expect(text.endsWith(' ET Q')).toBe(true);
  });

  test('clip paths: userSpaceOnUse, after the element transform, with or without a page address', () => {
    const body = '<defs><clipPath id="c1"><rect width="50" height="40"/></clipPath></defs>'
      + '<g transform="translate(10,20)" clip-path="url(#c1)"><rect x="-5" y="-5" width="100" height="100" fill="red"/></g>'
      + '<g clip-path="url(\'http://127.0.0.1/page.html#c1\')"><circle cx="5" cy="5" r="2"/></g>'
      + '<g clip-path="url(#missing)"><rect width="1" height="1"/></g>';
    const pdf = convert(body);
    const lines = pdf.content.split('\n');
    const at = lines.indexOf('1 0 0 1 10 20 cm');
    expect(at).toBeGreaterThan(0);
    expect(lines[at + 1]).toBe('0 0 m 50 0 l 50 40 l 0 40 l h W n');
    expect(lines.filter((l) => l.endsWith(' W n'))).toHaveLength(2);
    // The clip lives inside the group's q … Q.
    expect(lines[at - 1]).toBe('q');
    expect(lines[at + 3]).toBe('Q');
    const empty = convert('<clipPath id="e"></clipPath><g clip-path="url(#e)"><rect width="9" height="9"/></g>');
    expect(empty.content).toContain('0 0 m 0 0 l h W n');
  });

  test('nested transforms are written as cm, rotations to six decimals', () => {
    const pdf = convert('<g transform="translate(5,6)"><path transform="rotate(30)" d="M0 0H10" stroke="#000"/></g>');
    const lines = pdf.content.split('\n');
    expect(lines).toContain('1 0 0 1 5 6 cm');
    expect(lines).toContain('0.866025 0.5 -0.5 0.866025 0 0 cm');
  });

  test('rounded rectangles, circles, ellipses, polygons', () => {
    const pdf = convert('<rect width="20" height="10" rx="3" fill="#000"/><circle cx="50" cy="50" r="5" fill="#000"/><ellipse cx="80" cy="50" rx="10" ry="4" fill="#000"/><polygon points="0,0 10,0 5,8" fill="#000"/><polyline points="0 0 5 5 10 0" stroke="#000" fill="none"/>');
    const paints = pdf.content.split('\n').filter((l) => /^q .* (f|S|B) Q$/.test(l));
    expect(paints).toHaveLength(5);
    expect(paints[0]).toMatch(/^q 0 0 0 rg 3 0 m 17 0 l .* c .* h f Q$/);
    expect(paints[3]).toBe('q 0 0 0 rg 0 0 m 10 0 l 5 8 l h f Q');
  });
});

describe('pdfFromSvg: text', () => {
  const style = 'font-family: Arial, sans-serif; font-size: 12px; fill: rgb(68, 68, 68); white-space: pre;';

  test('escapes ( ) \\ and writes non-ASCII WinAnsi as octal', () => {
    const pdf = convert(`<text x="10" y="20" style="${style}">f(x) = a\\b é</text>`);
    const [run] = textRuns(pdf);
    expect(run.string).toBe('(f\\(x\\) = a\\\\b \\351)');
    expect(run.font).toBe('Helvetica');
    expect(run.size).toBe(12);
    expect(run.tm).toEqual([1, 0, 0, -1, 10, 20]);
  });

  test('text-anchor middle and end use the PDF font widths', () => {
    const w = textWidth('Time (s)', 'Helvetica', 12);
    const pdf = convert(`<text x="100" y="50" text-anchor="middle" style="${style}">Time (s)</text><text x="100" y="70" text-anchor="end" style="${style}">Time (s)</text>`);
    const [mid, end] = textRuns(pdf);
    expect(mid.tm[4]).toBeCloseTo(100 - w / 2, 3);
    expect(end.tm[4]).toBeCloseTo(100 - w, 3);
  });

  test('Greek in Symbol, and each font once in the resources', () => {
    const pdf = convert(`<text x="0" y="20" style="${style}">τ = 4 μs, σ ± 1</text><text x="0" y="40" style="font-family: 'Times New Roman', serif; font-size: 10px; font-weight: bold">B</text><text x="0" y="60" style="font-family: monospace; font-style: italic">m</text>`);
    const fonts = fontsOf(pdf);
    expect(Object.values(fonts).sort()).toEqual(['Courier-Oblique', 'Helvetica', 'Symbol', 'Times-Bold']);
    const runs = textRuns(pdf);
    expect(runs.filter((r) => r.font === 'Symbol').map((r) => r.string)).toEqual(['(t)', '(m)', '(s)']);
    expect(runs.find((r) => r.string === '(s, )')).toBeDefined();
    expect(runs.find((r) => r.string === '( \\261 1)')).toBeDefined();
  });

  test('Plotly superscripts: a 70% tspan with dy in its own em', () => {
    const pdf = convert(`<text x="10" y="50" style="${style}">10​<tspan style="font-size:70%" dy="-0.6em">−5</tspan><tspan dy="0.42em">​</tspan> m</text>`);
    const runs = textRuns(pdf);
    const minus = runs.find((r) => r.font === 'Symbol');
    expect(minus.size).toBeCloseTo(8.4, 3);
    expect(minus.tm[5]).toBeCloseTo(50 - 0.6 * 8.4, 3);
    expect(minus.tm[4]).toBeCloseTo(10 + textWidth('10', 'Helvetica', 12), 3);
    const after = runs[runs.length - 1];
    expect(after.string).toBe('( m)');
    expect(after.tm[5]).toBeCloseTo(50 - 0.6 * 8.4 + 0.42 * 12, 3);
  });

  test('multi-line annotations: each line tspan restarts at its x', () => {
    const pdf = convert(`<text x="50" y="20" text-anchor="middle" style="${style}"><tspan class="line" dy="0em" x="50" y="20">wide line</tspan><tspan class="line" dy="1.3em" x="50" y="20">b</tspan></text>`);
    const [a, b] = textRuns(pdf);
    expect(a.tm[4]).toBeCloseTo(50 - textWidth('wide line', 'Helvetica', 12) / 2, 3);
    expect(b.tm[4]).toBeCloseTo(50 - textWidth('b', 'Helvetica', 12) / 2, 3);
    expect(b.tm[5]).toBeCloseTo(20 + 1.3 * 12, 3);
  });

  test('a link inside a label is drawn and counted in the centring', () => {
    const pdf = convert(`<text x="100" y="20" text-anchor="middle" style="${style}">see <a xlink:href="https://example.org" style="cursor:pointer">here</a></text>`);
    const runs = textRuns(pdf);
    expect(runs.map((r) => r.string)).toEqual(['(see )', '(here)']);
    expect(runs[0].tm[4]).toBeCloseTo(100 - textWidth('see here', 'Helvetica', 12) / 2, 3);
  });

  test('a rotated y label keeps its rotate(-90, x, y)', () => {
    const pdf = convert(`<text transform="rotate(-90,42,60)" x="42" y="60" text-anchor="middle" style="${style}">Signal</text>`, 200, 100);
    expect(pdf.content).toMatch(/q\n0 -1 1 0 -18 102 cm\nq .* Tj ET Q\nQ/);
  });

  test('made characters: ∓ turned over, ħ with its bar, ℓ in italic, ⁻¹ small and raised', () => {
    const pdf = convert(`<text x="10" y="50" style="${style}">∓ħℓs⁻¹</text>`);
    const lines = pdf.content.split('\n');
    const mp = lines.find((l) => l.includes('(\\261) Tj'));
    expect(mp).toMatch(/ 1 0 0 1 10 42\.2 Tm /);          // d = +1, raised by 0.65 em
    const hbar = lines.find((l) => l.includes('(h) Tj'));
    expect(hbar).toMatch(/ET [-\d.]+ [-\d.]+ [-\d.]+ [-\d.]+ re f Q$/);
    const runs = textRuns(pdf);
    expect(runs.find((r) => r.string === '(l)').font).toBe('Helvetica-Oblique');
    const minus = runs.find((r) => r.font === 'Symbol' && r.string === '(-)');
    expect(minus.size).toBeCloseTo(7.2, 3);
    expect(minus.tm[5]).toBeCloseTo(50 - 0.28 * 12, 3);
  });

  test('italic Greek is slanted; bold and italic tspans pick their fonts', () => {
    const pdf = convert(`<text x="0" y="20" style="${style}"><tspan style="font-style:italic">τ</tspan> <tspan style="font-weight:bold">B</tspan></text>`);
    const runs = textRuns(pdf);
    expect(runs[0]).toMatchObject({ font: 'Symbol' });
    expect(runs[0].tm[2]).toBeCloseTo(0.21, 3);
    expect(runs.find((r) => r.string === '(B)').font).toBe('Helvetica-Bold');
  });
});

describe('pdfFromJpeg', () => {
  const jpg = new Uint8Array(fs.readFileSync(path.join(FIX, 'small.jpg')));

  test('reads the size from the JPEG header', () => {
    expect(jpegInfo(jpg)).toEqual({ width: 64, height: 48, components: 3, adobe: false });
    expect(jpegInfo(new Uint8Array([1, 2, 3, 4]))).toBeNull();
  });

  test('stores the JPEG bytes unchanged in a page of the requested size', () => {
    const pdf = readPdf(pdfFromJpeg(jpg, { widthIn: 2, heightIn: 1.5, pixelWidth: 640, pixelHeight: 480, date: DATE }));
    expect(pdf.mediaBox).toEqual([0, 0, 144, 108]);
    expect(pdf.content).toBe('q 144 0 0 108 0 0 cm /Im1 Do Q\n');
    const [n] = [...pdf.objects].find(([, o]) => o.body.includes('/Subtype /Image'));
    const dict = pdf.objects.get(n).body;
    // The header wins over the pixel size passed in, which was wrong here.
    expect(dict).toContain('/Width 64 /Height 48 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode');
    expect(Buffer.from(pdf.stream(n), 'latin1').equals(Buffer.from(jpg))).toBe(true);
  });

  test('grey and Adobe CMYK JPEGs get their colour space', () => {
    const header = (components, adobe) => new Uint8Array([
      0xff, 0xd8,
      ...(adobe ? [0xff, 0xee, 0x00, 0x0e, 0x41, 0x64, 0x6f, 0x62, 0x65, 0, 100, 0, 0, 0, 0, 2] : []),
      0xff, 0xc0, 0x00, 8 + 3 * components, 8, 0, 10, 0, 20, components, ...new Array(3 * components).fill(1),
      0xff, 0xd9
    ]);
    expect(jpegInfo(header(1, false))).toEqual({ width: 20, height: 10, components: 1, adobe: false });
    const grey = readPdf(pdfFromJpeg(header(1, false), { widthIn: 1, heightIn: 1 }));
    expect(grey.s).toContain('/ColorSpace /DeviceGray');
    const cmyk = readPdf(pdfFromJpeg(header(4, true), {}));
    expect(cmyk.s).toContain('/ColorSpace /DeviceCMYK /BitsPerComponent 8 /Decode [1 0 1 0 1 0 1 0]');
    expect(cmyk.mediaBox).toEqual([0, 0, 15, 7.5]);
  });

  test('refuses bytes that are not a JPEG', () => {
    expect(() => pdfFromJpeg(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { widthIn: 1, heightIn: 1 })).toThrow(/not a JPEG/);
  });
});

/* ------------------------------------------------------------------ *
 * Real Plotly exports
 * ------------------------------------------------------------------ *
 * Plotly.toImage(gd, { format: 'svg' }) from plotly.js 2.27 in Chrome:
 *   markers    every marker symbol, open variants, x and y error bars, grid,
 *              minor ticks, legend with a frame, τ₁ and 10³ in labels
 *   lines      six dash styles, a tonexty band in rgba, log axes, serif font,
 *              transparent background
 *   residuals  two subplots sharing x, monospace font, <b>/<i> title, an
 *              annotation with an arrow and a frame, rotated y titles
 *   bars       bars with outside labels, a spline, shapes, -45° tick labels
 *   extras     Unicode sub/superscripts, ∓ ħ ℓ, a link, power-of-ten ticks,
 *              trace opacity, tozeroy fill, & and < in a legend
 */

const FIXTURES = {
  markers: { size: [620, 440], fonts: ['Helvetica', 'Symbol'], minTexts: 21, minPaints: 150 },
  lines: { size: [560, 400], fonts: ['Symbol', 'Times-Roman'], minTexts: 57, minPaints: 100 },
  residuals: { size: [480, 460], fonts: ['Courier', 'Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Symbol', 'Times-Roman'], minTexts: 21, minPaints: 120 },
  bars: { size: [420, 340], fonts: ['Helvetica', 'Symbol'], minTexts: 18, minPaints: 20 },
  extras: { size: [500, 380], fonts: ['Helvetica', 'Helvetica-Oblique', 'Symbol'], minTexts: 30, minPaints: 30 }
};

describe('Plotly SVG fixtures', () => {
  for (const [name, want] of Object.entries(FIXTURES)) {
    test(`${name} converts into a well-formed PDF`, () => {
      const svg = fixture(`plotly-${name}.svg`);
      const [w, h] = want.size;
      const pdf = readPdf(pdfFromSvg(svg, { widthIn: w / 96, heightIn: h / 96, title: name, date: DATE }));
      expect(pdf.mediaBox).toEqual([0, 0, w * 0.75, h * 0.75]);
      expect(Object.values(fontsOf(pdf)).sort()).toEqual(want.fonts);
      const shown = pdf.content.match(/ Tj /g) || [];
      expect(shown.length).toBeGreaterThanOrEqual(want.minTexts);
      const paints = pdf.content.split('\n').filter((l) => /^q .* (f\*?|S|B\*?) Q$/.test(l));
      expect(paints.length).toBeGreaterThanOrEqual(want.minPaints);
      // Every character in these figures has a glyph: no "?" stand-ins.
      expect(pdf.content).not.toMatch(/\([^)]*\?[^)]*\) Tj/);
      // Balanced graphics states, and no text object left open.
      expect((pdf.content.match(/(^|\s)q(?=\s)/g) || []).length).toBe((pdf.content.match(/(^|\s)Q(?=\s|$)/g) || []).length);
      expect((pdf.content.match(/\bBT\b/g) || []).length).toBe((pdf.content.match(/\bET\b/g) || []).length);
    });
  }

  test('the markers figure draws every marker shape and the clip of the plot area', () => {
    const pdf = readPdf(pdfFromSvg(fixture('plotly-markers.svg'), { widthIn: 620 / 96, heightIn: 440 / 96 }));
    const svg = fixture('plotly-markers.svg');
    const points = (svg.match(/<path class="point"/g) || []).length;
    expect(points).toBe(16 * 4);
    expect(pdf.content).toContain('0 0 m 530 0 l 530 330 l 0 330 l h W n');
  });
});

/* ------------------------------------------------------------------ *
 * Rasterised with Poppler, where it is installed
 * ------------------------------------------------------------------ */

function rasterise(pdfBytes, dpi) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stemkit-pdf-'));
  try {
    fs.writeFileSync(path.join(dir, 'in.pdf'), pdfBytes);
    const r = spawnSync('pdftoppm', ['-r', String(dpi), '-singlefile', path.join(dir, 'in.pdf'), path.join(dir, 'out')], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    const ppm = fs.readFileSync(path.join(dir, 'out.ppm'));
    const head = ppm.toString('latin1', 0, 64).match(/^P6\s+(\d+)\s+(\d+)\s+255\s/);
    const width = Number(head[1]);
    const height = Number(head[2]);
    const data = ppm.subarray(head[0].length);
    return { width, height, at: (x, y) => [...data.subarray((y * width + x) * 3, (y * width + x) * 3 + 3)] };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const near = (got, want, tol = 3) => want.every((v, i) => Math.abs(got[i] - v) <= tol);

(HAVE_PDFTOPPM ? describe : describe.skip)('rasterised with Poppler (pdftoppm)', () => {
  test('the markers figure matches Plotly’s PNG at chosen pixels', () => {
    // At 96 dpi one PDF pixel is one CSS pixel of the figure. The expected
    // colours were read from Plotly.toImage(…, { format: 'png' }).
    const img = rasterise(pdfFromSvg(fixture('plotly-markers.svg'), { widthIn: 620 / 96, heightIn: 440 / 96 }), 96);
    expect([img.width, img.height]).toEqual([620, 440]);
    expect(img.at(5, 5)).toEqual([255, 255, 255]);          // paper
    expect(near(img.at(590, 70), [244, 246, 249])).toBe(true);  // plot background
    expect(near(img.at(575, 365), [244, 246, 249])).toBe(true);
    expect(near(img.at(233, 332), [173, 31, 31])).toBe(true);   // a circle marker at (2, 1.6)
    expect(near(img.at(175, 215), [253, 253, 254])).toBe(true); // legend, white at 80% over the plot
  });

  test('translucent text does not fade the shape drawn after it', () => {
    const img = rasterise(pdfFromSvg(svgDoc('<text x="10" y="20" style="fill: rgb(0,0,0); fill-opacity: 0.3; font-size: 16px">faint</text><rect x="10" y="40" width="50" height="30" style="fill: rgb(255, 0, 0)"/>', 96, 96)), 72);
    expect(img.at(30, 40)).toEqual([255, 0, 0]);
  });

  test('a clip path cuts a shape at its edge', () => {
    const img = rasterise(pdfFromSvg(svgDoc('<clipPath id="c"><rect x="20" y="20" width="40" height="40"/></clipPath><rect width="96" height="96" fill="#0000ff" clip-path="url(#c)"/>', 96, 96)), 96);
    expect(img.at(40, 40)).toEqual([0, 0, 255]);
    expect(img.at(10, 40)).toEqual([255, 255, 255]);
    expect(img.at(70, 40)).toEqual([255, 255, 255]);
  });

  test('∓ is ± turned over: its bar is at the top', () => {
    // Ink width of the top and bottom rows of the glyph's box: the bar is
    // the wide end, the tip of the vertical stroke the narrow one.
    const ends = (ch) => {
      const img = rasterise(pdfFromSvg(svgDoc(`<text x="10" y="80" style="font-size: 80px">${ch}</text>`, 96, 96)), 96);
      const ink = (y) => { let n = 0; for (let x = 0; x < 96; x++) if (img.at(x, y)[0] < 128) n++; return n; };
      const rows = [];
      for (let y = 0; y < 96; y++) if (ink(y)) rows.push(y);
      const band = (ys) => ys.reduce((n, y) => n + ink(y), 0);
      return { top: band(rows.slice(0, 3)), bottom: band(rows.slice(-3)), height: rows.length };
    };
    const pm = ends('±');
    const mp = ends('∓');
    expect(pm.height).toBeGreaterThan(40);
    expect(Math.abs(mp.height - pm.height)).toBeLessThan(4);  // same band, turned over
    expect(pm.bottom).toBeGreaterThan(2 * pm.top);
    expect(mp.top).toBeGreaterThan(2 * mp.bottom);
  });
});
