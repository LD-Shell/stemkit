/**
 * The Outlier Detector's figure and script (src/core/outliers-figure.js).
 *
 * When Python with numpy, scipy and matplotlib is installed, the scripts are
 * run: reading the CSV or holding the values, they must flag the rows
 * outliers.js flags, draw the rule's lines where the page draws them, report
 * Grubbs' test as the page does, and leave matplotlib with the preview's axis
 * limits (js/figure-plot.js).
 */
import { describe, test, expect, beforeAll } from '@jest/globals';
import './setup.js';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectOutliers, grubbsTest, extractNumericColumn } from '../src/core/outliers.js';
import { outlierFigure, outlierScript, outlierLines } from '../src/core/outliers-figure.js';
import { normaliseFigure, applyStyle } from '../src/core/figure.js';
import { buildFigure } from '../js/figure-plot.js';

const PYTHON = (() => {
  try {
    return spawnSync('python3', ['-c', 'import numpy, scipy, matplotlib'], { encoding: 'utf8', timeout: 60000 }).status === 0;
  } catch {
    return false;
  }
})();
const withPython = PYTHON ? test : test.skip;

const INSPECT = String.raw`

# --- test only: report what was computed and drawn ---
import json as _json
fig.canvas.draw()
_leg = ax.get_legend()
print('@@OUT@@' + _json.dumps({
    'rows': [int(r) for r in row], 'values': value.tolist(),
    'flagged': [int(r) for r in row[flagged]],
    'lower': float(lower), 'upper': float(upper),
    'centre': float(centre) if 'centre' in globals() else None,
    'grubbs': [float(G), float(critical), float(grubbs_p)] if 'G' in globals() else None,
    'xlim': [float(v) for v in ax.get_xlim()], 'ylim': [float(v) for v in ax.get_ylim()],
    'legend': [t.get_text() for t in _leg.get_texts()] if _leg else None,
}))
`;

function run(script, files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'stemkit-od-'));
  writeFileSync(join(dir, 'outliers.py'), script + INSPECT);
  Object.entries(files).forEach(([name, text]) => writeFileSync(join(dir, name), text));
  return new Promise((resolve) => {
    const child = spawn('python3', ['outliers.py'], { cwd: dir, env: { ...process.env, MPLBACKEND: 'Agg' } });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => {
      const line = stdout.split('\n').find((l) => l.startsWith('@@OUT@@'));
      rmSync(dir, { recursive: true, force: true });
      resolve({ code, stdout, stderr, out: line ? JSON.parse(line.slice(7)) : null });
    });
  });
}

// The page's example: fifteen readings near 80, one far too high and one far too low.
const EXAMPLE = [78, 80, 79, 81, 77, 80, 79, 82, 78, 250, 80, 79, 3, 81, 79];

// A file as a person might have one, with the cells the page skips: text, blanks,
// true/false, a number too large for Papa Parse to read as one, a blank line.
const CSV_TEXT = [
  'id;site ; level',
  '1;A;4.1', '2;B;3.9', '3;A;n/a', '4;B;4.4', '', '5;A;-0.5e1', '6;B;4.0', '7;A;', '8;B;true',
  '9;A;4.2', '10;B;12.5', '11;A;3.8', '12;B;9007199254740993', '13;A;4.05', '14;B; 4.3 ', '15;A;.5'
].join('\n') + '\n';

/* The rows as Papa Parse gives them to the page (header, dynamic typing, blank lines skipped). */
function papaRows(text) {
  const lines = text.split('\n').filter((l) => l !== '');
  const head = lines[0].split(';');
  const num = (c) => (/^\s*-?(\d+\.?|\.\d+|\d+\.\d+)([eE][-+]?\d+)?\s*$/.test(c) && Math.abs(parseFloat(c)) < 2 ** 53 ? parseFloat(c) : c);
  return lines.slice(1).map((l) => Object.fromEntries(l.split(';').map((c, i) => [head[i], c === 'true' ? true : num(c)])));
}

function make(spec, style = {}) {
  const drawn = normaliseFigure(applyStyle(outlierFigure(spec), style));
  return { spec, drawn, script: outlierScript(drawn, spec) };
}

const embedded = (method, threshold) => ({
  values: EXAMPLE, rows: EXAMPLE.map((_, i) => i + 1), method, threshold, column: 'measurement', source: 'embed'
});
const fromFile = (method, threshold) => {
  const { values, indexMap } = extractNumericColumn(papaRows(CSV_TEXT), ' level');
  return { values, rows: indexMap.map((i) => i + 1), method, threshold, column: ' level', file: { name: 'levels.csv', delimiter: ';' }, source: 'files' };
};

const CASES = {
  zscore: embedded('zscore', 3),
  modzscore: embedded('modzscore', 3.5),
  iqr: embedded('iqr', 1.5),
  zscoreFile: fromFile('zscore', 2),
  modzscoreFile: fromFile('modzscore', 3.5),
  iqrFile: fromFile('iqr', 1.5),
  // More than half the values equal: the MAD is 0 and the mean absolute deviation stands in.
  fallback: { values: [5, 5, 5, 5, 5, 5, 7, 5, 30, 5], rows: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], method: 'modzscore', threshold: 3.5, column: 'x', source: 'embed' },
  // The middle half of the values equal: the IQR is 0 and every other value is outside the fences.
  iqrZero: { values: [5, 5, 5, 5, 5, 5, 5, 5.0001, 4.9999, 7], rows: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], method: 'iqr', threshold: 1.5, column: 'x', source: 'embed' }
};

// Every value the same, where numpy's SD is 1.5e-17 and not 0. Run apart from the
// cases above: a figure of one value has no axis limits to compare.
const CONSTANT = Array(6).fill(0.1);
const constant = (method, threshold) => ({ values: CONSTANT, rows: [1, 2, 3, 4, 5, 6], method, threshold, column: 'x', source: 'embed' });

const close = (a, b, rel = 1e-9) => Math.abs(a - b) <= rel * Math.max(1, Math.abs(a), Math.abs(b));

describe('outlierLines', () => {
  test('the Z-score: the mean and the mean ± k SD', () => {
    const l = outlierLines([1, 2, 3, 4, 5], 'zscore', 2);
    expect(l.centre).toBe(3);
    expect(l.upper).toBeCloseTo(3 + 2 * Math.sqrt(2.5), 12);
    expect(l.ruleName).toBe('Mean ± 2 SD');
  });
  test('the modified Z-score: where 0.6745 (x - median) / MAD reaches ±k', () => {
    const l = outlierLines(EXAMPLE, 'modzscore', 3.5);
    const flagged = detectOutliers(EXAMPLE, 'modzscore', 3.5).indices.map((i) => EXAMPLE[i]);
    for (const v of EXAMPLE) expect(v < l.lower || v > l.upper).toBe(flagged.includes(v));
  });
  test("Tukey's fences, and no centre line", () => {
    const l = outlierLines(EXAMPLE, 'iqr', 1.5);
    const r = detectOutliers(EXAMPLE, 'iqr', 1.5);
    expect([l.lower, l.upper, l.centre]).toEqual([r.lower, r.upper, null]);
  });
  test('a constant sample: the Z-score lines meet on the mean, whatever rounding leaves of the SD', () => {
    const l = outlierLines(CONSTANT, 'zscore', 3);
    expect(l.lower).toBe(l.centre);
    expect(l.upper).toBe(l.centre);
    expect(l.centre).toBeCloseTo(0.1, 15);
  });
});

describe('outlierFigure', () => {
  test('the values against their rows, the flagged ones apart, and the rule\'s lines', () => {
    const { drawn } = make(CASES.zscore);
    const byId = Object.fromEntries(drawn.panels[0].series.map((s) => [s.id, s]));
    expect(byId.flagged_points.x).toEqual([10]);
    expect(byId.flagged_points.y).toEqual([250]);
    expect(byId.kept.x).toHaveLength(14);
    expect(byId.threshold_hi.x).toEqual([1, 15]);
    expect(byId.threshold_lo.legend).toBe(false);
    expect(drawn.xLabel).toBe('Row');
    expect(drawn.panels[0].yLabel).toBe('measurement');
  });
  test('with the lines off, and with nothing flagged', () => {
    const { drawn } = make({ ...CASES.zscore, lines: false, threshold: 5 });
    const byId = Object.fromEntries(drawn.panels[0].series.map((s) => [s.id, s]));
    expect(byId.threshold_hi.show).toBe(false);
    expect(byId.flagged_points.show).toBe(false);
  });
  test('no values, no figure', () => {
    expect(outlierFigure({ values: [] })).toBeNull();
  });
});

describe('outlierScript', () => {
  test('reads the column from the file, or holds the values', () => {
    expect(make(CASES.zscoreFile).script).toContain("row, value = read_column('levels.csv', ' level', delimiter=';')");
    const held = make(CASES.zscore).script;
    expect(held).not.toContain('read_column');
    expect(held).toMatch(/^row = np\.array\(\[1, 2, 3/m);
    // An example has no file: its values are held even when the file is asked for.
    expect(make({ ...CASES.zscore, source: 'files' }).script).toContain('# The example has no file to read');
  });
});

const runs = {};
beforeAll(async () => {
  if (!PYTHON) return;
  await Promise.all(Object.entries(CASES).map(async ([name, spec]) => {
    const m = make(spec);
    runs[name] = { ...m, r: await run(m.script, { 'levels.csv': CSV_TEXT }) };
  }));
}, 180000);

describe('the script, run', () => {
  withPython('runs without errors or warnings', () => {
    for (const [name, { r }] of Object.entries(runs)) expect([name, r.code, r.stderr]).toEqual([name, 0, '']);
  });

  withPython('reads the numbers and rows the page read', () => {
    for (const name of ['zscoreFile', 'modzscoreFile', 'iqrFile']) {
      const { spec, r } = runs[name];
      expect(r.out.rows).toEqual(spec.rows);
      expect(r.out.values).toEqual(spec.values);
    }
  });

  withPython('flags the rows the page flags, and draws the lines where the page does', () => {
    for (const [name, { spec, r }] of Object.entries(runs)) {
      const want = detectOutliers(spec.values, spec.method, spec.threshold).indices.map((i) => spec.rows[i]);
      expect([name, r.out.flagged]).toEqual([name, want]);
      const lines = outlierLines(spec.values, spec.method, spec.threshold);
      expect(close(r.out.lower, lines.lower, 1e-12) && close(r.out.upper, lines.upper, 1e-12)).toBe(true);
      if (lines.centre !== null) expect(close(r.out.centre, lines.centre, 1e-12)).toBe(true);
    }
  });

  withPython('says when the spread a rule divides by is zero', () => {
    expect(runs.fallback.r.stdout).toContain('More than half the values are equal, so the MAD is 0');
    expect(runs.iqrZero.r.stdout).toContain('The middle half of the values are equal, so the IQR is 0');
    expect(runs.iqrZero.r.out.flagged).toEqual([8, 9, 10]);
    for (const name of ['zscore', 'modzscore', 'iqr']) expect(runs[name].r.stdout).not.toMatch(/is 0/);
  });

  withPython('a constant sample: nothing flagged, no Grubbs test, and the script says why', async () => {
    for (const [method, threshold, says] of [['zscore', 1, 'the SD is 0'], ['modzscore', 2, 'the MAD is 0'], ['iqr', 0.5, 'the IQR is 0']]) {
      const spec = constant(method, threshold);
      const r = await run(make(spec).script);
      expect([method, r.code, r.stderr]).toEqual([method, 0, '']);
      expect(detectOutliers(spec.values, method, threshold).indices).toEqual([]);
      expect(r.out.flagged).toEqual([]);
      expect(r.out.lower).toBe(r.out.upper);
      expect(grubbsTest(spec.values, 0.05)).toBeNull();
      expect(r.out.grubbs).toBeNull();
      expect(r.stdout).toContain(says);
    }
  }, 120000);

  withPython("reports the page's Grubbs' test", () => {
    for (const { spec, r } of Object.values(runs)) {
      const g = grubbsTest(spec.values, 0.05);
      expect(close(r.out.grubbs[0], g.G, 1e-12)).toBe(true);
      // jStat's inverse t and its 1 - cdf tail agree with SciPy's to about 1e-8.
      expect(close(r.out.grubbs[1], g.critical, 1e-8)).toBe(true);
      expect(Math.abs(r.out.grubbs[2] - g.p)).toBeLessThan(1e-8);
    }
  });

  withPython("matplotlib's axis limits are the preview's", () => {
    for (const [name, { drawn, r }] of Object.entries(runs)) {
      const layout = buildFigure(drawn, { normalised: true }).layout;
      const [x, y] = [layout.xaxis.range, layout.yaxis.range];
      const ok = [...r.out.xlim.map((v, k) => close(v, x[k])), ...r.out.ylim.map((v, k) => close(v, y[k]))].every(Boolean);
      if (!ok) throw new Error(`${name}: matplotlib x ${r.out.xlim} y ${r.out.ylim}, preview x ${x} y ${y}`);
    }
    expect(runs.zscore.r.out.legend).toEqual(['Mean', 'Mean ± 3 SD', 'Values', 'Outliers']);
    expect(runs.iqr.r.out.legend).toEqual(['Fences at 1.5 × IQR', 'Values', 'Outliers']);
  });
});
