import { describe, test, expect } from '@jest/globals';
import {
  COLOR_PALETTE,
  extractQuoted,
  parseMetadataLine,
  parseDataLine,
  resolveHeaders,
  parseXvg,
  extractColumn,
  extractSeries,
  defaultActiveColumns,
  columnStats,
  generateSampleXvg,
  pythonLiteral,
  generateMatplotlibCode
} from '../src/core/xvg-parser.js';

const SAMPLE_XVG = `# This file was created by gmx rms
# Command line:
#   gmx rms -s md.tpr -f md.xtc -o rmsd.xvg
@    title "RMSD & Radius of Gyration"
@    xaxis  label "Time (ps)"
@    yaxis  label "nm"
@ s0 legend "Backbone RMSD"
@ s1 legend "Rg"
0.0000000    0.1200000    1.8500000
10.000000    0.1350000    1.8600000
20.000000    0.1420000    1.8550000
`;

describe('extractQuoted', () => {
  test('returns the first quoted substring', () => {
    expect(extractQuoted('@ title "RMSD"')).toBe('RMSD');
  });

  test('returns an empty string for an empty quoted pair', () => {
    expect(extractQuoted('@ title ""')).toBe('');
  });

  test('returns null when no quotes are present', () => {
    expect(extractQuoted('@ title RMSD')).toBeNull();
  });

  test('returns null for an unterminated quote', () => {
    expect(extractQuoted('@ title "RMSD')).toBeNull();
  });

  test('handles non-string input without throwing', () => {
    expect(extractQuoted(null)).toBeNull();
    expect(extractQuoted(undefined)).toBeNull();
    expect(extractQuoted(42)).toBeNull();
  });
});

describe('parseMetadataLine', () => {
  const freshMeta = () => ({
    title: null, xAxisLabel: null, yAxisLabel: null, legends: {}
  });

  test('parses a title directive', () => {
    const meta = freshMeta();
    expect(parseMetadataLine('@    title "My Run"', meta)).toBe(true);
    expect(meta.title).toBe('My Run');
  });

  test('parses axis labels with irregular internal whitespace', () => {
    const meta = freshMeta();
    parseMetadataLine('@    xaxis  label "Time (ps)"', meta);
    parseMetadataLine('@ yaxis label "Energy (kJ/mol)"', meta);
    expect(meta.xAxisLabel).toBe('Time (ps)');
    expect(meta.yAxisLabel).toBe('Energy (kJ/mol)');
  });

  test('parses series legends into a zero-based legend map', () => {
    const meta = freshMeta();
    parseMetadataLine('@ s0 legend "Backbone RMSD"', meta);
    parseMetadataLine('@ s1 legend "Rg"', meta);
    expect(meta.legends).toEqual({ 0: 'Backbone RMSD', 1: 'Rg' });
  });

  test('parses double-digit series indices', () => {
    const meta = freshMeta();
    parseMetadataLine('@ s12 legend "Chain M"', meta);
    expect(meta.legends[12]).toBe('Chain M');
  });

  test('does not confuse a legend directive with an axis label', () => {
    const meta = freshMeta();
    parseMetadataLine('@ s0 legend "Time (ps)"', meta);
    expect(meta.xAxisLabel).toBeNull();
    expect(meta.legends[0]).toBe('Time (ps)');
  });

  test('ignores unrecognised directives and non-directive lines', () => {
    const meta = freshMeta();
    expect(parseMetadataLine('@ TYPE xy', meta)).toBe(false);
    expect(parseMetadataLine('0.0 1.0', meta)).toBe(false);
    expect(parseMetadataLine('# a comment', meta)).toBe(false);
    expect(meta).toEqual(freshMeta());
  });
});

describe('parseDataLine', () => {
  test('parses whitespace-delimited numbers', () => {
    expect(parseDataLine('0.0  1.5  -2.25')).toEqual([0.0, 1.5, -2.25]);
  });

  test('parses comma-delimited numbers', () => {
    expect(parseDataLine('1,2,3')).toEqual([1, 2, 3]);
  });

  test('parses tab-delimited numbers', () => {
    expect(parseDataLine('1\t2\t3')).toEqual([1, 2, 3]);
  });

  test('parses scientific notation exactly', () => {
    expect(parseDataLine('1.234e-05  -6.7E+3')).toEqual([1.234e-5, -6700]);
  });

  test('collapses runs of repeated separators', () => {
    expect(parseDataLine('   1.0     2.0   ')).toEqual([1, 2]);
  });

  test('rejects rows containing any non-numeric token', () => {
    expect(parseDataLine('1.0  abc  3.0')).toBeNull();
  });

  test('rejects NaN and Infinity tokens rather than admitting them', () => {
    expect(parseDataLine('1.0 NaN')).toBeNull();
    expect(parseDataLine('1.0 Infinity')).toBeNull();
    expect(parseDataLine('1.0 -Infinity')).toBeNull();
  });

  test('returns null for blank input', () => {
    expect(parseDataLine('')).toBeNull();
    expect(parseDataLine('    ')).toBeNull();
  });

  test('handles non-string input without throwing', () => {
    expect(parseDataLine(null)).toBeNull();
  });
});

describe('resolveHeaders', () => {
  test('assigns the x-axis label to column 0 and legends to the rest', () => {
    const headers = resolveHeaders(3, { 0: 'RMSD', 1: 'Rg' }, 'Time (ps)');
    expect(headers).toEqual(['Time (ps)', 'RMSD', 'Rg']);
  });

  test('falls back to positional names when legends are absent', () => {
    expect(resolveHeaders(3, {}, 'Time')).toEqual(['Time', 'Dataset 1', 'Dataset 2']);
  });

  test('fills only the gaps when legends are partial', () => {
    expect(resolveHeaders(4, { 1: 'Rg' }, 'Time'))
      .toEqual(['Time', 'Dataset 1', 'Rg', 'Dataset 3']);
  });

  test('returns an empty array for a zero-column matrix', () => {
    expect(resolveHeaders(0, {}, 'Time')).toEqual([]);
  });
});

describe('parseXvg', () => {
  test('parses metadata, headers, and the numeric matrix', () => {
    const r = parseXvg(SAMPLE_XVG);
    expect(r.title).toBe('RMSD & Radius of Gyration');
    expect(r.xAxisLabel).toBe('Time (ps)');
    expect(r.yAxisLabel).toBe('nm');
    expect(r.headers).toEqual(['Time (ps)', 'Backbone RMSD', 'Rg']);
    expect(r.colCount).toBe(3);
    expect(r.rowCount).toBe(3);
    expect(r.matrix[0]).toEqual([0, 0.12, 1.85]);
    expect(r.matrix[2]).toEqual([20, 0.142, 1.855]);
  });

  test('preserves full double precision, not the printed decimal string', () => {
    const r = parseXvg('0.1 0.2\n');
    expect(r.matrix[0][0] + r.matrix[0][1]).toBeCloseTo(0.30000000000000004, 20);
  });

  test('excludes # comment lines from the data matrix', () => {
    const r = parseXvg(SAMPLE_XVG);
    expect(r.matrix).toHaveLength(3);
    expect(r.skippedLines).toBe(0);
  });

  test('handles CRLF and bare-CR line endings', () => {
    expect(parseXvg('1 2\r\n3 4\r\n').rowCount).toBe(2);
    expect(parseXvg('1 2\r3 4\r').rowCount).toBe(2);
  });

  test('ignores the Grace "&" set separator', () => {
    const r = parseXvg('1 2\n&\n3 4\n');
    expect(r.rowCount).toBe(2);
    expect(r.skippedLines).toBe(0);
  });

  test('counts malformed data lines without discarding valid ones', () => {
    const r = parseXvg('1 2\ncorrupt row\n3 4\n');
    expect(r.rowCount).toBe(2);
    expect(r.skippedLines).toBe(1);
  });

  test('reports colCount as the widest row for ragged input', () => {
    const r = parseXvg('1 2\n3 4 5\n');
    expect(r.colCount).toBe(3);
    expect(r.matrix[0]).toHaveLength(2);
  });

  test('returns a safe empty result for empty or whitespace-only input', () => {
    for (const input of ['', '   \n\n  ']) {
      const r = parseXvg(input);
      expect(r.matrix).toEqual([]);
      expect(r.headers).toEqual([]);
      expect(r.rowCount).toBe(0);
      expect(r.colCount).toBe(0);
    }
  });

  test('returns a safe empty result for a metadata-only file', () => {
    const r = parseXvg('@ title "Empty"\n@ xaxis label "t"\n');
    expect(r.title).toBe('Empty');
    expect(r.rowCount).toBe(0);
    expect(r.headers).toEqual([]);
  });

  test('applies the fallback title when no @title directive exists', () => {
    expect(parseXvg('1 2\n').title).toBe('Log Data');
    expect(parseXvg('1 2\n', { fallbackTitle: 'run.xvg' }).title).toBe('run.xvg');
  });

  test('defaults axis labels when directives are missing', () => {
    const r = parseXvg('1 2\n');
    expect(r.xAxisLabel).toBe('X');
    expect(r.yAxisLabel).toBe('Y');
  });

  test('parses a PLUMED-style COLVAR header without treating it as data', () => {
    const colvar = [
      '#! FIELDS time d1 restraint.bias',
      '#! SET min_d1 0.0',
      '0.000000 0.523000 0.000000',
      '1.000000 0.541000 0.012000'
    ].join('\n');
    const r = parseXvg(colvar);
    expect(r.rowCount).toBe(2);
    expect(r.colCount).toBe(3);
    expect(r.matrix[1]).toEqual([1, 0.541, 0.012]);
  });

  test('handles non-string input without throwing', () => {
    expect(parseXvg(undefined).rowCount).toBe(0);
    expect(parseXvg(null).rowCount).toBe(0);
  });

  test('parses a large trajectory without loss of records', () => {
    let big = '@ title "Long run"\n';
    for (let i = 0; i < 50000; i++) big += `${i} ${i * 2} ${i * 3}\n`;
    const r = parseXvg(big);
    expect(r.rowCount).toBe(50000);
    expect(r.matrix[49999]).toEqual([49999, 99998, 149997]);
  });
});

describe('extractColumn', () => {
  const matrix = [[1, 2, 3], [4, 5, 6]];

  test('extracts the requested column', () => {
    expect(extractColumn(matrix, 1)).toEqual([2, 5]);
  });

  test('yields undefined for out-of-range indices', () => {
    expect(extractColumn(matrix, 9)).toEqual([undefined, undefined]);
  });

  test('yields undefined for missing cells in ragged rows', () => {
    expect(extractColumn([[1, 2], [3]], 1)).toEqual([2, undefined]);
  });

  test('rejects invalid indices and non-array input', () => {
    expect(extractColumn(matrix, -1)).toEqual([]);
    expect(extractColumn(matrix, 1.5)).toEqual([]);
    expect(extractColumn(null, 0)).toEqual([]);
  });
});

describe('extractSeries', () => {
  test('returns paired finite coordinates', () => {
    const { x, y } = extractSeries([[0, 1], [1, 2], [2, 3]], 0, 1);
    expect(x).toEqual([0, 1, 2]);
    expect(y).toEqual([1, 2, 3]);
  });

  test('drops records with a missing coordinate and keeps pairing intact', () => {
    const { x, y } = extractSeries([[0, 1], [1], [2, 3]], 0, 1);
    expect(x).toEqual([0, 2]);
    expect(y).toEqual([1, 3]);
    expect(x).toHaveLength(y.length);
  });

  test('returns empty arrays when a column does not exist', () => {
    expect(extractSeries([[0, 1]], 0, 7)).toEqual({ x: [], y: [] });
  });

  test('handles non-array input without throwing', () => {
    expect(extractSeries(null, 0, 1)).toEqual({ x: [], y: [] });
  });
});

describe('defaultActiveColumns', () => {
  test('selects every data column for narrow files', () => {
    expect(defaultActiveColumns(3)).toEqual([1, 2]);
    expect(defaultActiveColumns(4)).toEqual([1, 2, 3]);
  });

  test('caps the selection at two series for wide files', () => {
    expect(defaultActiveColumns(9)).toEqual([1, 2]);
  });

  test('never selects the abscissa column', () => {
    expect(defaultActiveColumns(9)).not.toContain(0);
  });

  test('returns nothing when there is no ordinate to plot', () => {
    expect(defaultActiveColumns(1)).toEqual([]);
    expect(defaultActiveColumns(0)).toEqual([]);
    expect(defaultActiveColumns(NaN)).toEqual([]);
  });
});

describe('columnStats', () => {
  test('computes n, min, max, and mean', () => {
    const s = columnStats([2, 4, 4, 4, 5, 5, 7, 9]);
    expect(s.n).toBe(8);
    expect(s.min).toBe(2);
    expect(s.max).toBe(9);
    expect(s.mean).toBeCloseTo(5, 12);
  });

  test('uses the Bessel-corrected (n-1) standard deviation', () => {
    // Population sd of this set is 2; the sample sd is sqrt(32/7).
    const s = columnStats([2, 4, 4, 4, 5, 5, 7, 9]);
    expect(s.std).toBeCloseTo(Math.sqrt(32 / 7), 12);
    expect(s.std).not.toBeCloseTo(2, 6);
  });

  test('reports zero dispersion for a single observation', () => {
    expect(columnStats([42])).toEqual({ n: 1, min: 42, max: 42, mean: 42, std: 0 });
  });

  test('reports zero dispersion for a constant column', () => {
    expect(columnStats([3, 3, 3]).std).toBeCloseTo(0, 12);
  });

  test('remains accurate for values with a large offset', () => {
    const s = columnStats([1e9 + 4, 1e9 + 7, 1e9 + 13, 1e9 + 16]);
    expect(s.mean).toBeCloseTo(1e9 + 10, 6);
    expect(s.std).toBeCloseTo(Math.sqrt(30), 6);
  });

  test('excludes non-finite entries from the computation', () => {
    const s = columnStats([1, undefined, 2, NaN, 3, Infinity]);
    expect(s.n).toBe(3);
    expect(s.mean).toBeCloseTo(2, 12);
  });

  test('returns null when no finite values remain', () => {
    expect(columnStats([])).toBeNull();
    expect(columnStats([NaN, undefined])).toBeNull();
    expect(columnStats(null)).toBeNull();
  });

  test('handles negative values', () => {
    const s = columnStats([-5, -3, -1]);
    expect(s.min).toBe(-5);
    expect(s.max).toBe(-1);
    expect(s.mean).toBeCloseTo(-3, 12);
  });
});

describe('generateSampleXvg', () => {
  test('produces a document that round-trips through the parser', () => {
    const r = parseXvg(generateSampleXvg());
    expect(r.title).toBe('RMSD & Radius of Gyration');
    expect(r.headers).toEqual(['Time (ps)', 'Backbone RMSD', 'Rg']);
    expect(r.colCount).toBe(3);
    expect(r.rowCount).toBe(101);
    expect(r.skippedLines).toBe(0);
  });

  test('is deterministic for a fixed seed', () => {
    expect(generateSampleXvg({ seed: 7 })).toBe(generateSampleXvg({ seed: 7 }));
  });

  test('produces different noise for different seeds', () => {
    expect(generateSampleXvg({ seed: 1 })).not.toBe(generateSampleXvg({ seed: 2 }));
  });

  test('honours the requested time range and step', () => {
    const r = parseXvg(generateSampleXvg({ tMax: 100, dt: 25 }));
    expect(r.rowCount).toBe(5);
    expect(extractColumn(r.matrix, 0)).toEqual([0, 25, 50, 75, 100]);
  });

  test('generates physically plausible RMSD and Rg values', () => {
    const r = parseXvg(generateSampleXvg());
    const rmsd = columnStats(extractColumn(r.matrix, 1));
    const rg = columnStats(extractColumn(r.matrix, 2));
    expect(rmsd.min).toBeGreaterThan(0);
    expect(rmsd.max).toBeLessThan(0.25);
    expect(rg.mean).toBeGreaterThan(1.7);
    expect(rg.mean).toBeLessThan(2.0);
  });
});

describe('pythonLiteral', () => {
  test('wraps a plain string in single quotes', () => {
    expect(pythonLiteral('Time')).toBe("'Time'");
  });

  test('escapes embedded single quotes', () => {
    expect(pythonLiteral("d'Alembert")).toBe("'d\\'Alembert'");
  });

  test('escapes backslashes before quotes so the output stays valid', () => {
    expect(pythonLiteral('C:\\runs')).toBe("'C:\\\\runs'");
  });

  test('coerces non-string input', () => {
    expect(pythonLiteral(3)).toBe("'3'");
  });
});

describe('generateMatplotlibCode', () => {
  const base = {
    headers: ['Time (ps)', 'Backbone RMSD', 'Rg'],
    xIndex: 0,
    yIndices: [1, 2],
    title: 'RMSD',
    yAxisLabel: 'nm'
  };

  test('emits an importable, self-contained script', () => {
    const code = generateMatplotlibCode(base);
    expect(code).toContain('import matplotlib.pyplot as plt');
    expect(code).toContain('import numpy as np');
    expect(code).toContain("comments=['@', '#']");
    expect(code).toContain('plt.show()');
  });

  test('emits one plot call per selected series', () => {
    const code = generateMatplotlibCode(base);
    expect(code).toContain('data[:, 1]');
    expect(code).toContain('data[:, 2]');
    expect(code.match(/ax\.plot\(/g)).toHaveLength(2);
  });

  test('respects a non-zero abscissa column', () => {
    const code = generateMatplotlibCode({ ...base, xIndex: 2, yIndices: [1] });
    expect(code).toContain('x = data[:, 2]');
  });

  test('adds a log scale only when requested', () => {
    expect(generateMatplotlibCode({ ...base, logY: true })).toContain("ax.set_yscale('log')");
    expect(generateMatplotlibCode(base)).not.toContain('set_yscale');
  });

  test('adds markers only when requested', () => {
    expect(generateMatplotlibCode({ ...base, showMarkers: true })).toContain("marker='o'");
    expect(generateMatplotlibCode(base)).not.toContain("marker='o'");
  });

  test('assigns colours from the shared palette by column index', () => {
    const code = generateMatplotlibCode(base);
    expect(code).toContain(COLOR_PALETTE[1]);
    expect(code).toContain(COLOR_PALETTE[2]);
  });

  test('escapes quotes in labels so the emitted Python stays valid', () => {
    const code = generateMatplotlibCode({
      ...base, headers: ['t', "Ala's RMSD"], yIndices: [1]
    });
    expect(code).toContain("\\'");
    expect(code).not.toMatch(/label='Ala's/);
  });

  test('returns guidance instead of code when no series is selected', () => {
    const out = generateMatplotlibCode({ ...base, yIndices: [] });
    expect(out.startsWith('#')).toBe(true);
    expect(out).not.toContain('ax.plot');
  });

  test('falls back to positional names for unlabelled columns', () => {
    const code = generateMatplotlibCode({ headers: [], xIndex: 0, yIndices: [1] });
    expect(code).toContain('Dataset 1');
  });

  test('omits the title call when no title is set', () => {
    expect(generateMatplotlibCode({ ...base, title: '' })).not.toContain('set_title');
  });
});
