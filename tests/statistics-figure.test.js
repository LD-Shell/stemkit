/**
 * The Statistics Calculator's figure and script (src/core/statistics-figure.js).
 *
 * When Python with numpy, scipy and matplotlib is installed, every test's
 * script is run on the page's own examples: the statistic, p-value and
 * effect size it prints must be the page's (statistics.js, itself checked
 * against SciPy in statistics.test.js), and the axis limits matplotlib picks
 * must be the preview's (js/figure-plot.js).
 */
import { describe, test, expect, beforeAll } from '@jest/globals';
import './setup.js';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  independentTTest, pairedTTest, oneSampleTTest, oneWayAnova, welchAnova, kruskalWallis,
  mannWhitneyU, wilcoxonSignedRank, oneSampleWilcoxon, pearsonCorrelation, spearmanCorrelation,
  leastSquaresLine, alignPairs
} from '../src/core/statistics.js';
import { statisticsFigure, statisticsScript, STATISTICS_TESTS } from '../src/core/statistics-figure.js';
import { normaliseFigure } from '../src/core/figure.js';
import { buildFigure } from '../js/figure-plot.js';

const PYTHON_BIN = process.env.STEMKIT_PYTHON || 'python3';
const PYTHON = (() => {
  try {
    return spawnSync(PYTHON_BIN, ['-c', 'import numpy, scipy, matplotlib'], { encoding: 'utf8', timeout: 60000 }).status === 0;
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
    'statistic': float(statistic), 'p': float(p_value), 'effect': float(effect),
    'xlim': [float(v) for v in ax.get_xlim()], 'ylim': [float(v) for v in ax.get_ylim()],
    'fit': [float(least_squares.slope), float(least_squares.intercept)] if 'least_squares' in globals() else None,
    'legend': [t.get_text() for t in _leg.get_texts()] if _leg else None,
    'xticklabels': [t.get_text() for t in ax.get_xticklabels()],
    'lines': len(ax.get_lines()),
}))
`;

function run(script) {
  const dir = mkdtempSync(join(tmpdir(), 'stemkit-stats-'));
  writeFileSync(join(dir, 'statistics.py'), script + INSPECT);
  return new Promise((resolve) => {
    const child = spawn(PYTHON_BIN, ['statistics.py'], { cwd: dir, env: { ...process.env, MPLBACKEND: 'Agg' } });
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

/* The page's examples (js/stats-calculator.js), column by column. */
const S = {
  Control: [23.1, 22.8, 24.2, 23.5, 22.9, 23.8, 24.1, 23.3, 22.6, 23.9],
  Treatment: [28.4, 29.1, 27.9, 30.2, 28.8, 29.5, 28.1, 30.7, 29.3, 28.6],
  Placebo: [5.2, 4.9, 5.5, 5.1, 4.8, 5.3, 5.0, 5.4],
  LowDose: [6.8, 7.1, 6.5, 7.3, 6.9, 7.0, 6.7, 7.2],
  HighDose: [9.1, 8.7, 9.4, 8.9, 9.2, 8.6, 9.5, 8.8],
  Before: [120, 135, 128, 142, 118, 150, 133, 127, 145, 122],
  After: [112, 128, 119, 133, 115, 139, 124, 121, 138, 116],
  Height_cm: [158, 162, 168, 171, 175, 180, 165, 177, 183, 160],
  Weight_kg: [52, 55, 61, 64, 68, 74, 58, 71, 79, 54],
  Temperature_C: [20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75],
  Rate_per_min: [0.52, 0.81, 0.77, 1.95, 2.96, 4.81, 7.30, 11.9, 17.8, 29.4, 44.1, 71.5],
  Concentration_M: [0.1012, 0.1008, 0.1015, 0.1003, 0.1011, 0.1009, 0.1017, 0.1006, 0.1013, 0.1010],
  Supplier_A: [10.2, 11.1, 9.8, 10.5, 10.9, 10.1, 10.4],
  Supplier_B: [12.5, 14.9, 9.7, 16.2, 11.8, 13.4, 15.1, 10.6, 12.9],
  Supplier_C: [11.0, 11.4, 10.8, 11.9, 11.2, 10.7],
  Site_A: [12, 15, 11, 20, 13, 12, 48, 14, 16, 12],
  Site_B: [21, 24, 19, 22, 75, 20, 23, 26, 19, 21],
  Site_C: [33, 29, 38, 31, 99, 34, 30, 36, 32, 124],
  GroupX: [1.1, 1.2, 1.0, 1.3, 1.1, 1.2, 1.0, 14.8, 1.1, 1.2],
  GroupY: [2.0, 2.1, 1.9, 2.2, 2.0, 15.5, 1.8, 2.1, 2.0, 18.2],
  // Beyond the page's examples, so that the script meets every method the rank tests use.
  WT: [1.2, 2.3, 3.1],
  KO: [4.4, 5.0, 6.2],
  Day0: [5.1, 6.3, 4.8, 7.2, 5.9, 6.6],
  Day7: [4.2, 6.9, 3.1, 5.0, 3.6, 3.4],
  Score: [3, 1, 4, 1, 5, 9, 2, 6, 5, 3, 5, 8, 9, 7, 9, 3]
};

/* The page's model and numbers for each test, as js/stats-calculator.js makes them. */
function page(testKey, names, mu0 = 0) {
  const groups = names.map((n) => S[n]);
  const groupsModel = (extra = {}) => ({ kind: 'groups', groups: names.map((n) => ({ name: n, values: S[n] })), yLabel: 'Value', xLabel: 'Column', ...extra });
  const pairedModel = () => {
    const { a, b } = alignPairs(groups[0], groups[1]);
    return { kind: 'paired', groups: [{ name: names[0], values: a }, { name: names[1], values: b }], yLabel: 'Value', xLabel: 'Measurement' };
  };
  const scatterModel = (spearman) => {
    const { a: x, b: y } = alignPairs(groups[0], groups[1]);
    return { kind: 'scatter', x, y, xLabel: names[0], yLabel: names[1], line: leastSquaresLine(x, y), spearman };
  };
  const ref = { ref: { value: mu0, label: `μ₀ = ${mu0}` }, xLabel: '' };
  switch (testKey) {
    case 'ttest_welch': case 'ttest_ind': {
      const r = independentTTest(groups[0], groups[1], { pooled: testKey === 'ttest_ind' });
      return { model: groupsModel(), want: [r.t, r.p, r.d] };
    }
    case 'mannwhitney': { const r = mannWhitneyU(groups[0], groups[1]); return { model: groupsModel(), want: [r.U, r.p, r.rankBiserial] }; }
    case 'ttest_pair': { const r = pairedTTest(groups[0], groups[1]); return { model: pairedModel(), want: [r.t, r.p, r.dz] }; }
    case 'wilcoxon': { const r = wilcoxonSignedRank(groups[0], groups[1]); return { model: pairedModel(), want: [r.W, r.p, r.effectR] }; }
    case 'anova': { const r = oneWayAnova(groups); return { model: groupsModel(), want: [r.F, r.p, r.etaSquared] }; }
    case 'welch_anova': { const r = welchAnova(groups); return { model: groupsModel(), want: [r.F, r.p, r.etaSquared] }; }
    case 'kruskal': { const r = kruskalWallis(groups); return { model: groupsModel(), want: [r.H, r.p, r.epsilonSquared] }; }
    case 'ttest_one': { const r = oneSampleTTest(groups[0], mu0); return { model: groupsModel(ref), want: [r.t, r.p, r.d] }; }
    case 'wilcoxon_one': { const r = oneSampleWilcoxon(groups[0], mu0); return { model: groupsModel(ref), want: [r.W, r.p, r.effectR] }; }
    case 'pearson': { const r = pearsonCorrelation(groups[0], groups[1]); return { model: scatterModel(false), want: [r.r, r.p, r.r2] }; }
    case 'spearman': { const r = spearmanCorrelation(groups[0], groups[1]); return { model: scatterModel(true), want: [r.rho, r.p, r.n] }; }
    default: throw new Error(testKey);
  }
}

const CASES = {
  ttest_welch: ['Control', 'Treatment'],
  ttest_ind: ['Control', 'Treatment'],
  mannwhitney: ['GroupX', 'GroupY'],
  ttest_pair: ['Before', 'After'],
  wilcoxon: ['Before', 'After'],
  anova: ['Placebo', 'LowDose', 'HighDose'],
  welch_anova: ['Supplier_A', 'Supplier_B', 'Supplier_C'],
  kruskal: ['Site_A', 'Site_B', 'Site_C'],
  ttest_one: ['Concentration_M'],
  wilcoxon_one: ['Concentration_M'],
  pearson: ['Height_cm', 'Weight_kg'],
  spearman: ['Temperature_C', 'Rate_per_min'],
  // test:method, for the rank tests' other methods.
  'mannwhitney:exact': ['WT', 'KO'],
  'wilcoxon:exact': ['Day0', 'Day7'],
  'wilcoxon_one:asymptotic': ['Score']
};

function make(key) {
  const mu0 = 0.1;
  const test = key.split(':')[0];
  const { model, want } = page(test, CASES[key], mu0);
  const drawn = normaliseFigure(statisticsFigure(model));
  return { model, want, drawn, script: statisticsScript(drawn, { test, model, mu0 }) };
}

const close = (a, b, rel) => Math.abs(a - b) <= rel * Math.max(1, Math.abs(a), Math.abs(b));

describe('statisticsFigure', () => {
  test('groups: box plots with each observation and the mean with its interval', () => {
    const { drawn } = make('anova');
    const [panel] = drawn.panels;
    expect(drawn.xCategories).toEqual(['Placebo', 'LowDose', 'HighDose']);
    const box = panel.series.find((s) => s.kind === 'box');
    expect([box.points, box.mean, box.fliers]).toEqual([true, true, false]);
    expect(box.groups.map((g) => g.values)).toEqual([S.Placebo, S.LowDose, S.HighDose]);
  });

  test('one-sample: a dashed line at the reference value, named in the legend', () => {
    const { drawn } = make('ttest_one');
    const ref = drawn.panels[0].series.find((s) => s.kind === 'hline');
    expect(ref.y).toBe(0.1);
    expect(ref.label).toBe('$\\mu_0$ = 0.1');
    expect(ref.lineStyle).toBe('dashed');
  });

  test('paired: one line joining each pair at its points\' spread', () => {
    const { drawn } = make('ttest_pair');
    const pairs = drawn.panels[0].series.find((s) => s.id === 'pairs');
    expect(pairs.kind).toBe('line');
    expect(pairs.y.slice(0, 3).map((v) => (Number.isNaN(v) ? null : v))).toEqual([120, 112, null]);
    expect(pairs.x[1] - pairs.x[0]).toBeCloseTo(1, 12);
    expect(drawn.panels[0].series.map((s) => s.kind)).toEqual(['line', 'box']);
  });

  test('scatter: the points and the least-squares line across them', () => {
    const { drawn, model } = make('pearson');
    const [pts, fit] = drawn.panels[0].series;
    expect(pts.kind).toBe('scatter');
    expect(fit.x).toEqual([158, 183]);
    expect(fit.y[0]).toBeCloseTo(model.line.intercept + model.line.slope * 158, 12);
  });

  test('nothing to plot, no figure', () => {
    expect(statisticsFigure(null)).toBeNull();
    expect(statisticsFigure({ kind: 'groups', groups: [] })).toBeNull();
    expect(statisticsFigure({ kind: 'scatter', x: [], y: [] })).toBeNull();
  });
});

describe('statisticsScript', () => {
  test('a script for every test, with the data and the test', () => {
    for (const key of Object.keys(STATISTICS_TESTS)) {
      const { script } = make(key);
      expect(script).toContain('# Test ---');
      expect(script).toMatch(/^statistic/m);
    }
    const { script } = make('ttest_welch');
    expect(script).toContain("'Control': np.array([");
    expect(script).toContain('23.1, 22.8, 24.2');
    expect(script).toContain('stats.ttest_ind(a, b, equal_var=False)');
    expect(make('pearson').script).toContain('least_squares = stats.linregress(x, y)');
  });

  test('the rank tests pass scipy the method the page used', () => {
    const cases = {
      'mannwhitney:exact': ['exact', "stats.mannwhitneyu(a, b, alternative='two-sided', method='exact')"],
      mannwhitney: ['asymptotic', "stats.mannwhitneyu(a, b, alternative='two-sided', use_continuity=False, method='asymptotic')"],
      'wilcoxon:exact': ['exact', "result = stats.wilcoxon(d, method='exact')"],
      wilcoxon: ['permutation', 'result = stats.wilcoxon(d, method=stats.PermutationMethod())'],
      wilcoxon_one: ['exact', "result = stats.wilcoxon(d, method='exact')"],
      'wilcoxon_one:asymptotic': ['asymptotic', "result = stats.wilcoxon(d, method='asymptotic')"]
    };
    const methodOf = (key) => {
      const [test] = key.split(':');
      const g = CASES[key].map((n) => S[n]);
      if (test === 'mannwhitney') return mannWhitneyU(g[0], g[1]).method;
      if (test === 'wilcoxon') return wilcoxonSignedRank(g[0], g[1]).method;
      return oneSampleWilcoxon(g[0], 0.1).method;
    };
    for (const [key, [method, call]] of Object.entries(cases)) {
      expect([key, methodOf(key)]).toEqual([key, method]);
      expect(make(key).script).toContain(call);
    }
  });

  test('keeps names out of the code', () => {
    const model = { kind: 'groups', groups: [{ name: "a'\nimport os", values: [1, 2, 3] }, { name: 'b', values: [2, 3, 5] }], yLabel: 'v' };
    const code = statisticsScript(normaliseFigure(statisticsFigure(model)), { test: 'ttest_welch', model });
    expect(code).not.toMatch(/^import os/m);
  });

  test('imports scipy once, whether or not the boxes show their means', () => {
    const { model } = make('anova');
    const fig = statisticsFigure(model);
    const withMean = statisticsScript(normaliseFigure(fig), { test: 'anova', model });
    fig.panels[0].series[0].mean = false;
    const without = statisticsScript(normaliseFigure(fig), { test: 'anova', model });
    for (const code of [withMean, without]) expect(code.match(/^from scipy import stats$/gm)).toHaveLength(1);
  });
});

const runs = {};
beforeAll(async () => {
  if (!PYTHON) return;
  await Promise.all(Object.keys(CASES).map(async (key) => {
    const m = make(key);
    runs[key] = { ...m, r: await run(m.script) };
  }));
}, 180000);

describe('the script, run', () => {
  withPython('runs without errors or warnings', () => {
    for (const [key, { r }] of Object.entries(runs)) expect([key, r.code, r.stderr]).toEqual([key, 0, '']);
  });

  withPython('prints the page\'s statistic, p-value and effect size', () => {
    for (const [key, { want, r }] of Object.entries(runs)) {
      const [stat, p, effect] = want;
      const got = [r.out.statistic, r.out.p, r.out.effect];
      // jStat's tails, which the page uses, agree with SciPy's to about 1e-9.
      const ok = close(got[0], stat, 1e-10) && close(got[1], p, 1e-8) && close(got[2], effect, 1e-10);
      if (!ok) throw new Error(`${key}: script ${got}, page ${want}`);
    }
  });

  withPython('fits the page\'s least-squares line', () => {
    for (const key of ['pearson', 'spearman']) {
      const { model, r } = runs[key];
      expect(close(r.out.fit[0], model.line.slope, 1e-12)).toBe(true);
      expect(close(r.out.fit[1], model.line.intercept, 1e-12)).toBe(true);
    }
  });

  withPython('matplotlib\'s axis limits are the preview\'s', () => {
    for (const [key, { drawn, r }] of Object.entries(runs)) {
      const layout = buildFigure(drawn, { normalised: true }).layout;
      const [x, y] = [layout.xaxis.range, layout.yaxis.range];
      const ok = [...r.out.xlim.map((v, k) => close(v, x[k], 1e-9)), ...r.out.ylim.map((v, k) => close(v, y[k], 1e-9))].every(Boolean);
      if (!ok) throw new Error(`${key}: matplotlib x ${r.out.xlim} y ${r.out.ylim}, preview x ${x} y ${y}`);
      if (drawn.xCategories) expect(r.out.xticklabels).toEqual(drawn.xCategories);
    }
  });

  withPython('the reference value and the fitted line are in the legend', () => {
    expect(runs.ttest_one.r.out.legend).toEqual(['$\\mu_0$ = 0.1']);
    expect(runs.pearson.r.out.legend).toEqual(['Least-squares line']);
    expect(runs.anova.r.out.legend).toBeNull();
  });
});
