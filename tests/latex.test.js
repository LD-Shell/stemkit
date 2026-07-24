import { describe, test, expect } from '@jest/globals';
import {
  escapeLatex, parseTableData, detectDelimiter, splitLine,
  buildColumnSpec, generateLatexTable, generateMarkdownTable,
  padMatrix, transposeMatrix, formatCell,
  generateMatrix, stripZeroWidth
} from '../src/core/latex.js';

const MATRIX = [
  ['Sample', 'Energy', 'Error'],
  ['A', '-1.23', '0.05'],
  ['B', '-4.56', '0.07']
];

describe('escapeLatex', () => {
  test('escapes the simple special characters', () => {
    expect(escapeLatex('50% & rising')).toBe('50\\% \\& rising');
    expect(escapeLatex('a_b')).toBe('a\\_b');
    expect(escapeLatex('$100')).toBe('\\$100');
    expect(escapeLatex('#1')).toBe('\\#1');
  });

  test('escapes braces', () => {
    expect(escapeLatex('{x}')).toBe('\\{x\\}');
  });

  test('maps tilde and caret to their text macros', () => {
    expect(escapeLatex('~')).toBe('\\textasciitilde{}');
    expect(escapeLatex('^')).toBe('\\textasciicircum{}');
  });

  test('maps a backslash to textbackslash, not to a line break', () => {
    expect(escapeLatex('\\')).toBe('\\textbackslash{}');
  });

  test('does not re-escape braces introduced by its own replacements', () => {
    // A two-pass implementation yields the broken \textbackslash\{\} here.
    expect(escapeLatex('C:\\path')).toBe('C:\\textbackslash{}path');
    expect(escapeLatex('a\\b{c}')).toBe('a\\textbackslash{}b\\{c\\}');
  });

  test('leaves ordinary text untouched', () => {
    expect(escapeLatex('Hello world 123')).toBe('Hello world 123');
  });

  test('handles null, undefined and numbers', () => {
    expect(escapeLatex(null)).toBe('');
    expect(escapeLatex(undefined)).toBe('');
    expect(escapeLatex(42)).toBe('42');
  });
});

describe('detectDelimiter', () => {
  test('prefers a tab when present', () => {
    expect(detectDelimiter('a\tb,c')).toBe('\t');
  });

  test('picks the most frequent candidate', () => {
    expect(detectDelimiter('a,b,c')).toBe(',');
    expect(detectDelimiter('a;b;c')).toBe(';');
    expect(detectDelimiter('a|b|c')).toBe('|');
  });

  test('defaults to a comma when nothing is found', () => {
    expect(detectDelimiter('abc')).toBe(',');
    expect(detectDelimiter(null)).toBe(',');
  });
});

describe('splitLine', () => {
  test('splits on the delimiter', () => {
    expect(splitLine('a,b,c', ',')).toEqual(['a', 'b', 'c']);
  });

  test('respects quoted fields containing the delimiter', () => {
    expect(splitLine('a,"b,c",d', ',')).toEqual(['a', 'b,c', 'd']);
  });

  test('handles the doubled-quote escape', () => {
    expect(splitLine('a,"say ""hi""",b', ',')).toEqual(['a', 'say "hi"', 'b']);
  });

  test('trims surrounding whitespace', () => {
    expect(splitLine(' a , b ', ',')).toEqual(['a', 'b']);
  });

  test('preserves empty fields', () => {
    expect(splitLine('a,,c', ',')).toEqual(['a', '', 'c']);
  });
});

describe('parseTableData', () => {
  test('parses into a matrix of rows', () => {
    const m = parseTableData('a,b\n1,2\n3,4');
    expect(m).toHaveLength(3);
    expect(m[1]).toEqual(['1', '2']);
  });

  test('skips blank lines', () => {
    expect(parseTableData('a,b\n\n1,2')).toHaveLength(2);
  });

  test('handles CRLF endings', () => {
    expect(parseTableData('a,b\r\n1,2')).toHaveLength(2);
  });

  test('returns an empty matrix for blank input', () => {
    expect(parseTableData('')).toEqual([]);
    expect(parseTableData(null)).toEqual([]);
  });
});

describe('buildColumnSpec', () => {
  test('repeats the alignment character per column', () => {
    expect(buildColumnSpec(3, 'l', 'plain')).toBe('lll');
    expect(buildColumnSpec(2, 'c', 'plain')).toBe('cc');
  });

  test('adds vertical rules for the grid style', () => {
    expect(buildColumnSpec(2, 'r', 'grid')).toBe('|r|r|');
  });

  test('suppresses outer padding for booktabs', () => {
    expect(buildColumnSpec(2, 'l', 'booktabs')).toBe('@{}ll@{}');
  });

  test('handles a zero column count', () => {
    expect(buildColumnSpec(0, 'l', 'plain')).toBe('');
  });
});

describe('generateLatexTable', () => {
  test('emits a complete table environment', () => {
    const t = generateLatexTable(MATRIX);
    expect(t).toContain('\\begin{table}[htbp]');
    expect(t).toContain('\\begin{tabular}');
    expect(t).toContain('\\end{tabular}');
    expect(t).toContain('\\end{table}');
  });

  test('uses booktabs rules by default', () => {
    const t = generateLatexTable(MATRIX);
    expect(t).toContain('\\toprule');
    expect(t).toContain('\\midrule');
    expect(t).toContain('\\bottomrule');
  });

  test('notes the required package for booktabs', () => {
    expect(generateLatexTable(MATRIX)).toContain('% Requires: \\usepackage{booktabs}');
  });

  test('notes the rotating package for a sideways table', () => {
    const t = generateLatexTable(MATRIX, { environment: 'sidewaystable' });
    expect(t).toContain('\\usepackage{rotating}');
    expect(t).toContain('\\begin{sidewaystable}');
  });

  test('uses hline rules for the grid style', () => {
    const t = generateLatexTable(MATRIX, { style: 'grid' });
    expect(t).toContain('\\hline');
    expect(t).not.toContain('\\toprule');
  });

  test('separates cells with ampersands and ends rows with a double backslash', () => {
    const t = generateLatexTable(MATRIX);
    expect(t).toContain('Sample & Energy & Error \\\\');
  });

  test('includes a caption and label when supplied', () => {
    const t = generateLatexTable(MATRIX, { caption: 'My table', label: 'tab:x' });
    expect(t).toContain('\\caption{My table}');
    expect(t).toContain('\\label{tab:x}');
  });

  test('omits caption and label when absent', () => {
    const t = generateLatexTable(MATRIX);
    expect(t).not.toContain('\\caption');
    expect(t).not.toContain('\\label');
  });

  test('escapes special characters inside cells', () => {
    const t = generateLatexTable([['a&b'], ['50%']]);
    expect(t).toContain('a\\&b');
    expect(t).toContain('50\\%');
  });

  test('escapes the caption too', () => {
    expect(generateLatexTable(MATRIX, { caption: '100% pure' })).toContain('100\\% pure');
  });

  test('can omit the header row treatment', () => {
    const t = generateLatexTable(MATRIX, { headerRow: false });
    expect(t).not.toContain('\\midrule');
  });

  test('honours the requested alignment', () => {
    expect(generateLatexTable(MATRIX, { align: 'c', style: 'plain' }))
      .toContain('\\begin{tabular}{ccc}');
  });

  test('returns an empty string for an empty matrix', () => {
    expect(generateLatexTable([])).toBe('');
    expect(generateLatexTable(null)).toBe('');
  });
});

describe('generateMarkdownTable', () => {
  test('emits a header and separator row', () => {
    const md = generateMarkdownTable(MATRIX);
    const lines = md.split('\n');
    expect(lines[0]).toContain('Sample');
    expect(lines[1]).toContain('---');
    // Header + separator + two data rows.
    expect(lines).toHaveLength(4);
  });

  test('encodes the requested alignment', () => {
    expect(generateMarkdownTable(MATRIX, { align: 'c' })).toContain(':---:');
    expect(generateMarkdownTable(MATRIX, { align: 'r' })).toContain('---:');
  });

  test('escapes pipe characters in cells', () => {
    expect(generateMarkdownTable([['a|b']])).toContain('a\\|b');
  });

  test('returns an empty string for an empty matrix', () => {
    expect(generateMarkdownTable([])).toBe('');
  });
});

describe('matrix helpers', () => {
  test('padMatrix squares off ragged rows', () => {
    const p = padMatrix([['a', 'b', 'c'], ['d']]);
    expect(p[1]).toEqual(['d', '', '']);
  });

  test('transpose swaps rows and columns', () => {
    const t = transposeMatrix([['a', 'b'], ['c', 'd']]);
    expect(t).toEqual([['a', 'c'], ['b', 'd']]);
  });

  test('transpose pads ragged input first', () => {
    const t = transposeMatrix([['a', 'b'], ['c']]);
    expect(t).toEqual([['a', 'c'], ['b', '']]);
  });

  test('transposing twice is the identity', () => {
    const m = [['a', 'b'], ['c', 'd']];
    expect(transposeMatrix(transposeMatrix(m))).toEqual(m);
  });

  test('helpers handle empty input', () => {
    expect(padMatrix([])).toEqual([]);
    expect(transposeMatrix([])).toEqual([]);
  });
});

describe('formatCell', () => {
  test('formats to a fixed number of decimals', () => {
    expect(formatCell(3.14159, { decimals: 2 })).toBe('3.14');
  });

  test('passes numbers through unchanged by default', () => {
    expect(formatCell(42)).toBe('42');
  });

  test('renders scientific notation as LaTeX maths', () => {
    const s = formatCell(1.23e-5, { scientific: true, decimals: 2 });
    expect(s).toContain('\\times 10^{-5}');
    expect(s.startsWith('$')).toBe(true);
  });

  test('returns an empty string for missing values', () => {
    expect(formatCell(null)).toBe('');
    expect(formatCell('')).toBe('');
  });

  test('passes non-numeric text through unchanged', () => {
    expect(formatCell('N/A')).toBe('N/A');
  });
});

describe('generateMatrix', () => {
  test('builds a matrix environment with subscripted placeholders', () => {
    const m = generateMatrix(2, 2, 'pmatrix');
    expect(m).toContain('\\begin{pmatrix}');
    expect(m).toContain('x_{11} & x_{12}');
    expect(m).toContain('\\end{pmatrix}');
  });

  test('separates rows but does not trail a separator', () => {
    // A trailing \\ renders as a spurious empty row.
    const m = generateMatrix(2, 2);
    expect(m).toContain('x_{11} & x_{12} \\\\');
    expect(m.trimEnd().endsWith('\\end{pmatrix}')).toBe(true);
    expect(m).not.toContain('x_{22} \\\\');
  });

  test('honours the requested environment', () => {
    expect(generateMatrix(1, 1, 'bmatrix')).toContain('\\begin{bmatrix}');
  });

  test('accepts a custom placeholder symbol', () => {
    expect(generateMatrix(1, 1, 'pmatrix', { symbol: 'a' })).toContain('a_{11}');
  });

  test('clamps degenerate dimensions to at least one', () => {
    expect(generateMatrix(0, 0)).toContain('x_{11}');
    expect(generateMatrix(-3, 2)).toContain('x_{11}');
  });
});

describe('stripZeroWidth', () => {
  test('removes the zero-width space MathLive inserts', () => {
    expect(stripZeroWidth('a\u200Bb')).toBe('ab');
  });

  test('removes other invisible anchors', () => {
    expect(stripZeroWidth('a\u200Cb\u200Dc\uFEFFd')).toBe('abcd');
  });

  test('leaves ordinary text unchanged', () => {
    expect(stripZeroWidth('\\frac{a}{b}')).toBe('\\frac{a}{b}');
  });

  test('handles null input', () => {
    expect(stripZeroWidth(null)).toBe('');
  });
});
