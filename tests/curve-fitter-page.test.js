/**
 * The pure helpers behind the Curve Fitter page (js/curve-fitter.js): reading
 * pasted tables, naming columns, matching them to the equation's names, the
 * presets, and how numbers are reported. The page itself is checked in a
 * browser; these are the parts that decide what it shows.
 */

import { describe, test, expect } from '@jest/globals';
import {
  PRESETS, SAMPLES, ROW_NUMBER, parseTable, columnIdentifier, mapColumns, presetEquation,
  substitute, highlightPython, roundToError, fmt, resolveRoles
} from '../js/curve-fitter.js';
import { parseEquation, classify, toText, compile } from '../src/core/expression.js';
import { fitModel } from '../src/core/nonlinear-fit.js';

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

describe('resolveRoles', () => {
  const cols = names => names.map(name => ({ name, label: name, values: [1, 2, 3] }));

  test('a guessed name that is not a column gives way to one that is', () => {
    const hill = resolveRoles(parseEquation('v = Vmax*S^n/(K^n + S^n)'), cols(['S', 'v']));
    expect(hill.independent).toEqual(['S']);
    expect(hill.parameters).toEqual(['Vmax', 'n', 'K']);
    const line = resolveRoles(parseEquation('y = a*d + c'), cols(['d', 'y']));
    expect(line.independent).toEqual(['d']);
  });

  test('a whole word is the variable before a single letter', () => {
    const r = resolveRoles(parseEquation('signal = A*exp(-time/tau) + c'), cols(['time', 'signal']));
    expect(r.independent).toEqual(['time']);
    expect(r.parameters).toEqual(['A', 'tau', 'c']);
  });

  test('a guess that is a column stays, and an uncertainty column is not a variable', () => {
    const r = resolveRoles(parseEquation('y = A*exp(-(x - mu)^2/(2*sigma^2))'), cols(['x', 'y', 'sigma']));
    expect(r.independent).toEqual(['x']);
    expect(r.parameters).toEqual(['A', 'mu', 'sigma']);
  });

  test('f(x) = names the variable, whatever the columns are called', () => {
    const r = resolveRoles(parseEquation('y(c) = a*c + d'), cols(['d', 'y']));
    expect(r.independent).toEqual(['c']);
    expect(r.guessed).toBe(false);
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

/*
 * The fits the page shows first must read as fits: no parameter reported as
 * run away, no curve reported as no better than the data's mean. What the
 * samples do warn of is that two of their parameters are strongly correlated
 * (the prefactor and the activation energy, the saturation current and the
 * ideality factor), which is true of those equations.
 */
describe('the samples and presets fit without a warning about the fit', () => {
  const DOUBT = /has run away|no better than a horizontal line|cannot be told apart|cannot be determined|did not settle|without settling|finished at its/;
  const CORRELATED = /^'\w+' and '\w+' are strongly correlated/;
  const specFor = (text, table, extra = {}) => {
    const eq = parseEquation(text);
    const roles = resolveRoles(eq, table.columns);
    const map = mapColumns(roles.independent, roles.dependent, table.columns);
    const bounds = extra.bounds || {};
    const fixed = extra.fixed || {};
    return {
      ast: eq.ast,
      independent: roles.independent,
      parameters: [...roles.parameters, ...Object.keys(fixed).filter(n => !roles.parameters.includes(n))].map(name => (
        Object.hasOwn(fixed, name) ? { name, initial: fixed[name], fixed: true } : { name, ...(bounds[name] || {}) })),
      columns: Object.fromEntries(roles.independent.map(v => [v, table.columns[map.columns[v]].values])),
      y: table.columns[map.columns[roles.dependent]].values,
      sigma: map.sigma === null ? undefined : table.columns[map.sigma].values,
      absoluteSigma: map.sigma !== null && !!extra.absoluteSigma
    };
  };

  test.each(SAMPLES.map(s => [s.label, s]))('sample: %s', (label, sample) => {
    const fit = fitModel(specFor(sample.equation, parseTable(sample.make()), sample));
    expect(fit.ok).toBe(true);
    expect(fit.converged).toBe(true);
    expect(fit.message).toMatch(/^Converged after \d+ iterations?\.$/);
    expect(fit.r2).toBeGreaterThan(0.99);
    expect(fit.warnings.filter(w => !CORRELATED.test(w))).toEqual([]);
    expect(fit.warnings.length).toBe(['arrhenius', 'diode'].includes(sample.id) ? 1 : 0);
  });

  /* A value for each preset's parameters, to make data the preset suits. */
  const TRUTH = {
    line: { m: 1.7, c: -0.4 }, quadratic: { a: 0.3, b: -1.2, c: 2 }, cubic: { a: 0.05, b: -0.4, c: 1, d: 2 },
    decay: { A: 3, tau: 1.6, y0: 0.5 }, growth: { A: 0.8, k: 0.35 }, double: { A1: 3, tau1: 0.5, A2: 1.5, tau2: 4, y0: 0.2 },
    power: { A: 2, n: 1.6 }, log: { a: 1, b: 2.5 }, gauss: { A: 5, mu: 4.2, sigma: 0.9, y0: 1 }, lorentz: { A: 5, x0: 4.2, w: 0.8, y0: 1 },
    pvoigt: { A: 5, x0: 4.2, w: 0.8, eta: 0.4, y0: 1 }, logistic: { L: 10, k: 1.4, x0: 4 }, mm: { Vmax: 40, Km: 1.5 }, hill: { Vmax: 40, K: 2.5, n: 2.2 },
    arrhenius: { A: 4e9, Ea: 65000 }, sine: { A: 2, P: 2.3, phi: 0.5, y0: 1 }, damped: { A: 2.5, tau: 3, P: 1.3, phi: 0.4, y0: 0.2 }
  };
  const range = (a, b, n) => Array.from({ length: n }, (_, i) => a + ((b - a) * i) / (n - 1));

  test.each(PRESETS.map(p => [p.label, p]))('preset: %s, on data it suits', (label, preset) => {
    const { text, x } = presetEquation(preset);
    const truth = { ...TRUTH[preset.id], ...(preset.fixed || {}) };
    const names = [x, ...Object.keys(truth)];
    const f = compile(parseEquation(text).ast, names);
    const xs = preset.id === 'arrhenius' ? range(290, 380, 12) : ['power', 'log', 'mm', 'hill'].includes(preset.id) ? range(0.25, 8, 40) : range(0, 8, 60);
    const clean = xs.map(v => f(Float64Array.from([v, ...Object.values(truth)])));
    const spread = Math.max(...clean) - Math.min(...clean);
    // Scatter of 2% of the curve's range, the same on every run.
    const ys = clean.map((v, i) => v + 0.02 * spread * Math.sin(12.9898 * (i + 1)) * Math.cos(78.233 * (i + 1)));
    const table = { columns: [{ name: x, label: x, values: xs }, { name: 'y_', label: '', values: ys }] };
    const fit = fitModel(specFor(text, table, preset));
    expect(fit.ok).toBe(true);
    expect(fit.converged).toBe(true);
    expect(fit.r2).toBeGreaterThan(0.98);
    expect(fit.warnings.filter(w => DOUBT.test(w))).toEqual([]);
    expect(fit.message).toMatch(/^Converged after \d+ iterations?\.$/);
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
