/**
 * The pure helpers behind the Curve Fitter page (js/curve-fitter.js): reading
 * pasted tables, naming columns, matching them to the equation's names, the
 * presets, and how numbers are reported. The page itself is checked in a
 * browser; these are the parts that decide what it shows.
 */

import { describe, test, expect } from '@jest/globals';
import {
  PRESETS, ROW_NUMBER, parseTable, columnIdentifier, mapColumns, presetEquation,
  substitute, highlightPython, roundToError, fmt
} from '../js/curve-fitter.js';
import { parseEquation, classify, toText } from '../src/core/expression.js';

describe('parseTable', () => {
  test('semicolons with decimal commas and a header with units', () => {
    const t = parseTable('Time (s);Signal (mV)\n0;1,5\n1;2,25\n2;x\n\n3;4');
    expect(t.header).toBe(true);
    expect(t.delimiter).toBe(';');
    expect(t.decimalComma).toBe(true);
    expect(t.columns.map(c => c.name)).toEqual(['time', 'signal']);
    expect(t.columns.map(c => c.label)).toEqual(['Time (s)', 'Signal (mV)']);
    expect(t.columns[1].values).toEqual([1.5, 2.25, NaN, 4]);
    expect(t.rows).toBe(4);
    expect(t.issues).toEqual([{ line: 4, reason: '"x" in column 2 is not a number' }]);
  });

  test('tabs, commas and runs of spaces; no header gives c1, c2, …', () => {
    for (const text of ['1\t2\n3\t4\n5\t6', '1,2\n3,4\n5,6', '1   2\n3 4\n  5  6']) {
      const t = parseTable(text);
      expect(t.header).toBe(false);
      expect(t.columns.map(c => c.name)).toEqual(['c1', 'c2']);
      expect(t.columns.map(c => c.values)).toEqual([[1, 3, 5], [2, 4, 6]]);
    }
  });

  test('a comment line naming every column is the header; missing values stay missing', () => {
    const t = parseTable('# made by a logger\n# t y sigma\n0 1 0.1\n1 NaN 0.1\n2 3 n/a');
    expect(t.columns.map(c => c.name)).toEqual(['t', 'y', 'sigma']);
    expect(t.columns[1].values).toEqual([1, NaN, 3]);
    expect(t.columns[2].values).toEqual([0.1, 0.1, NaN]);
  });

  test('commas as delimiters keep points as decimal points', () => {
    const t = parseTable('x,y\n0.5,1.25\n1.5,2.75');
    expect(t.decimalComma).toBe(false);
    expect(t.columns[1].values).toEqual([1.25, 2.75]);
  });
});

describe('columnIdentifier', () => {
  test('units are dropped, long names lower-cased, one letter kept as it is', () => {
    expect(columnIdentifier('Time (s)', 0)).toBe('time');
    expect(columnIdentifier('T (K)', 0)).toBe('T');
    expect(columnIdentifier('', 2)).toBe('c3');
  });

  test('a name already taken gets a number', () => {
    const taken = new Set();
    const a = columnIdentifier('Signal', 0, taken);
    const b = columnIdentifier('Signal', 1, taken);
    expect(a).toBe('signal');
    expect(b).not.toBe(a);
    expect(taken.has(a) && taken.has(b)).toBe(true);
  });

  test('a function name is never given to a column', () => {
    const name = columnIdentifier('exp', 0);
    expect(name).not.toBe('exp');
    expect(parseEquation(`y = a*${name}`).ok).toBe(true);
  });
});

describe('mapColumns', () => {
  const columns = [{ name: 'time', label: 'Time (s)' }, { name: 'signal', label: 'Signal' }, { name: 'err', label: 'error' }];

  test('by name and by position, the uncertainty only by name', () => {
    const m = mapColumns(['t'], 'y', columns);
    expect(m.columns.t).toBe(0);
    expect(m.columns.y).toBe(1);
    expect(m.sigma).toBe(2);
    const bare = mapColumns(['t'], 'y', columns.slice(0, 2).concat({ name: 'c3', label: '' }));
    expect(bare.sigma).toBeNull();
  });

  test('a choice wins, and the row number is a choice', () => {
    const m = mapColumns(['t'], 'y', columns, { t: ROW_NUMBER, y: 2, sigma: null });
    expect(m.columns.t).toBe(ROW_NUMBER);
    expect(m.columns.y).toBe(2);
    expect(m.sigma).toBeNull();
  });
});

describe('presets', () => {
  test.each(PRESETS.map(p => [p.id, p]))('%s parses, in its own names and in the data\'s', (id, preset) => {
    for (const names of [{}, { x: 'time', y: 'signal' }]) {
      const { text, x, y } = presetEquation(preset, names);
      const eq = parseEquation(text);
      expect(eq.ok).toBe(true);
      expect(eq.dependent).toBe(y);
      const roles = classify(eq, { independent: [x] });
      expect(roles.unknownFunctions).toEqual([]);
      expect(roles.parameters.length).toBeGreaterThan(0);
      expect(roles.parameters).not.toContain(x);
    }
  });
});

describe('substitute', () => {
  test('values replace names, and adding a negative reads as a subtraction', () => {
    const eq = parseEquation('y = a + b*x');
    expect(toText(substitute(eq.ast, { a: 1.5, b: -2 }))).toBe('1.5 - 2*x');
  });
});

describe('highlightPython', () => {
  test('every character is kept, and HTML in the script is escaped', () => {
    const code = 'x = "a<b"  # c & d\nimport numpy as np\ny = 1.5e-3 * x';
    const html = highlightPython(code);
    const text = html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
    expect(text).toBe(code);
    expect(html).not.toMatch(/"a<b"/);
    expect(html).toContain('<span class="tok-k">import</span>');
  });
});

describe('roundToError', () => {
  test.each([
    [3.16544, 0.026, '3.165', '0.026', 0],
    [1.68507, 0.0345, '1.685', '0.035', 0],
    [0.410206, 0.016, '0.410', '0.016', 0],
    [99.96, 0.97, '99.96', '0.97', 0],
    [12345.6, 234, '12350', '230', 0],
    [-0.00123, 0.0004, '-0.00123', '0.00040', 0],
    [-0.004, 0.02, '-0.004', '0.020', 0],
    [1.23456e-7, 3.4e-9, '1.235', '0.034', -7],
    [6.02e23, 1.2e21, '6.020', '0.012', 23]
  ])('%d ± %d', (v, se, value, error, exponent) => {
    expect(roundToError(v, se)).toMatchObject({ value, error, exponent });
  });

  test('a value that rounds to zero has no minus sign', () => {
    expect(roundToError(-0.0004, 0.02).value).toBe('0.000');
  });
});

test('fmt keeps six significant figures and switches to exponents at the extremes', () => {
  expect(fmt(3.14159265)).toBe('3.14159');
  expect(fmt(1.5e-7)).toBe('1.5e-7');
  expect(fmt(Infinity)).toBe('∞');
  expect(fmt(NaN)).toBe('n/a');
});
