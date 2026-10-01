/**
 * The Error Bar Generator's figure and script (src/core/error-bars-figure.js).
 *
 * The script is run when Python with numpy, scipy and matplotlib is
 * installed: the group statistics, the Welch tests with Holm's correction and
 * the brackets it computes itself must be the page's (error-bars.js), and the
 * axis limits matplotlib picks must be the preview's (js/figure-plot.js).
 */
import { describe, test, expect, beforeAll } from '@jest/globals';
import './setup.js';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeGroups, pairwiseComparisons } from '../src/core/error-bars.js';
import {
  errorBarFigure, errorBarScript, errorBarBrackets, significanceLabel, ERROR_BAR_BRACKET_SPACING
} from '../src/core/error-bars-figure.js';
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
_b = globals().get('brackets', [])
print('@@OUT@@' + _json.dumps({
    'xlim': [float(v) for v in ax.get_xlim()], 'ylim': [float(v) for v in ax.get_ylim()],
    'n': [int(v) for v in n], 'means': means.tolist(), 'sds': sds.tolist(), 'sems': sems.tolist(),
    't': t_crit.tolist(), 'ci': ci_half.tolist(),
    'pairs': [{'i': int(q['i']), 'j': int(q['j']), 't': float(q['t']), 'df': float(q['df']),
               'p': float(q['p']), 'p_holm': float(q['p_holm'])} for q in pairs],
    'brackets': [[int(a), int(b), float(y), t] for a, b, y, t in _b],
    'texts': [t.get_text() for t in ax.texts],
    'xticklabels': [t.get_text() for t in ax.get_xticklabels()],
    'ylabel': ax.get_ylabel(),
}))
`;

function run(script) {
  const dir = mkdtempSync(join(tmpdir(), 'stemkit-eb-'));
  writeFileSync(join(dir, 'error_bars.py'), script + INSPECT);
  return new Promise((resolve) => {
    const child = spawn('python3', ['error_bars.py'], { cwd: dir, env: { ...process.env, MPLBACKEND: 'Agg' } });
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

const table = (text) => text.trim().split('\n').map((line) => line.split(',').map((c) => {
  const v = Number(c);
  return c.trim() !== '' && Number.isFinite(v) ? v : c;
}));

// The page's examples, and a group of one.
const DATA = {
  basic: table('Label,Rep1,Rep2,Rep3,Rep4\nControl,4.5,4.2,4.8,4.6\nLow Dose,6.1,6.5,6.2,6.3\nHigh Dose,8.3,8.1,8.9,8.5\nSingle,5'),
  overlap: table('Group,M1,M2,M3,M4\nAlpha,10.2,9.1,11.5,8.8\nBeta,10.8,9.6,12.1,9.4\nGamma,11.1,10.2,12.4,9.9'),
  many: table('Sample,Trial1,Trial2,Trial3\npH 4,2.1,2.3,2.0\npH 5,3.4,3.6,3.5\npH 6,5.8,6.0,5.9\npH 7,8.2,8.5,8.1\npH 8,6.1,5.9,6.3\npH 9,3.2,3.0,3.4'),
  negative: table('Region,Q1,Q2,Q3,Q4\nNorth,-2.5,-1.8,-3.1,-2.2\nEquator,0.5,-0.3,1.1,-0.8\nSouth,3.2,2.8,3.6,3.0'),
  ragged: table('Condition,V1,V2,V3,V4,V5\nBaseline,12.1,12.4,11.9\nStress,18.2,17.9,18.5,18.1,18.3\nRecovery,14.0,14.3')
};

const CASES = {
  basic: { data: 'basic', mode: 'ci', display: 'bars', points: true, compare: 'significant', labels: 'stars' },
  overlapAll: { data: 'overlap', mode: 'sd', display: 'means', points: true, compare: 'all', labels: 'p', level: 0.99 },
  many: { data: 'many', mode: 'sem', display: 'bars', points: false, compare: 'all', labels: 'stars' },
  negative: { data: 'negative', mode: 'ci', display: 'bars', points: true, compare: 'significant', labels: 'stars', level: 0.9 },
  ragged: { data: 'ragged', mode: 'sd', display: 'means', points: false, compare: 'none', labels: 'stars' }
};

function make(c, style = {}) {
  const level = c.level || 0.95;
  const { results } = computeGroups(DATA[c.data], { level });
  const opts = { mode: c.mode, level, display: c.display, points: c.points, compare: c.compare, labels: c.labels };
  const desc = errorBarFigure(results, opts);
  const drawn = normaliseFigure(applyStyle(desc, style));
  return { results, desc, drawn, script: errorBarScript(drawn, { groups: results, ...opts }) };
}

const close = (a, b, rel = 1e-9) => Math.abs(a - b) <= rel * Math.max(1, Math.abs(a), Math.abs(b));

function previewRanges(drawn) {
  const layout = buildFigure(drawn, { normalised: true }).layout;
  return [layout.xaxis.range, layout.yaxis.range];
}

describe('significanceLabel', () => {
  test('stars at 0.05, 0.01 and 0.001, or the p-value', () => {
    expect([0.2, 0.05, 0.049, 0.0099, 0.00099].map((p) => significanceLabel(p))).toEqual(['n.s.', 'n.s.', '*', '**', '***']);
    expect(significanceLabel(0.0421, 'p')).toBe('p = 0.042');
    expect(significanceLabel(0.0004, 'p')).toBe('p < 0.001');
  });
});

describe('errorBarFigure', () => {
  test('a series for each group, the replicates, and a bracket for each separated pair', () => {
    const { desc, results } = make(CASES.basic);
    const [panel] = desc.panels;
    expect(desc.xCategories).toEqual(['Control', 'Low Dose', 'High Dose', 'Single']);
    expect(panel.yLabel).toBe('Mean ± 95% CI');
    const bars = panel.series.filter((s) => s.kind === 'bar');
    expect(bars.map((s) => s.y.values[0])).toEqual(results.map((r) => r.mean));
    expect(bars.map((s) => s.group)).toEqual([false, false, false, false]);
    // A group of one has no error bar at all.
    expect(bars[3].yerr).toBeUndefined();
    expect(bars[0].yerr.values[0]).toBe(results[0].ci);
    const pts = panel.series.find((s) => s.id === 'replicates');
    expect(pts.y.values).toEqual(results.flatMap((r) => r.values));
    const brackets = panel.series.filter((s) => s.kind === 'bracket');
    expect(brackets.map((b) => [b.x1, b.x2, b.text])).toEqual([[0, 1, '***'], [1, 2, '***'], [0, 2, '***']]);
  });

  test('means as points, drawn over the replicates', () => {
    const { desc } = make(CASES.overlapAll);
    const kinds = desc.panels[0].series.map((s) => s.kind);
    expect(kinds.slice(0, 4)).toEqual(['scatter', 'errorbar', 'errorbar', 'errorbar']);
    expect(desc.panels[0].yLabel).toBe('Mean ± SD');
  });

  test('no groups, no figure', () => {
    expect(errorBarFigure([])).toBeNull();
    expect(errorBarFigure(null)).toBeNull();
  });
});

describe('errorBarBrackets', () => {
  test('stacked brackets never share a level over the same groups, and clear the data under them', () => {
    const { results } = computeGroups(DATA.many);
    const groups = results.map((r) => ({ key: r.key, n: r.n, mean: r.mean, error: r.sem, values: r.values }));
    const cmp = pairwiseComparisons(results);
    const { brackets, height } = errorBarBrackets(groups, cmp, { compare: 'all' });
    expect(brackets).toHaveLength(15);
    const tops = groups.map((g) => Math.max(0, g.mean + g.error));
    const span = Math.max(...tops);
    for (const b of brackets) {
      for (let k = b.i; k <= b.j; k++) expect(b.y).toBeGreaterThanOrEqual(tops[k] + ERROR_BAR_BRACKET_SPACING.gap * span - 1e-12);
    }
    for (const a of brackets) {
      for (const b of brackets) {
        if (a === b || a.j < b.i || b.j < a.i) continue;
        expect(Math.abs(a.y - b.y)).toBeGreaterThanOrEqual(ERROR_BAR_BRACKET_SPACING.step * span - 1e-12);
      }
    }
    expect(height).toBeCloseTo(ERROR_BAR_BRACKET_SPACING.height * span, 12);
  });

  test('only the separated pairs unless all are asked for; none for none', () => {
    const { results } = computeGroups(DATA.overlap);
    const groups = results.map((r) => ({ key: r.key, n: r.n, mean: r.mean, error: r.ci, values: r.values }));
    const cmp = pairwiseComparisons(results);
    expect(errorBarBrackets(groups, cmp, { compare: 'significant' }).brackets).toEqual([]);
    expect(errorBarBrackets(groups, cmp, { compare: 'all' }).brackets.map((b) => b.text)).toEqual(['n.s.', 'n.s.', 'n.s.']);
    expect(errorBarBrackets(groups, cmp, { compare: 'none' }).brackets).toEqual([]);
  });
});

describe('errorBarScript', () => {
  test('embeds the replicates, recomputes, and keeps names out of the code', () => {
    const { script } = make(CASES.basic);
    expect(script).toContain("'Control': [4.5, 4.2, 4.8, 4.6],");
    expect(script).toContain('stats.ttest_ind(a, b, equal_var=False)');
    expect(script).toContain('ax.bar(0, means[0]');
    expect(script).toContain('for x1, x2, y, text in brackets:');
    expect(script.indexOf('for x1, x2, y, text in brackets:')).toBeLessThan(script.indexOf('\n# Axes\n'));
    const odd = computeGroups([['a\nimport os', 1, 2], ["it's", 3, 4]], { hasHeader: false }).results;
    const code = errorBarScript(normaliseFigure(errorBarFigure(odd)), { groups: odd });
    expect(code).not.toMatch(/^import os/m);
    expect(code).toContain("'it\\'s': [3, 4],");
  });

  test('is the same for the same figure', () => {
    expect(make(CASES.many).script).toBe(make(CASES.many).script);
  });
});

const runs = {};
beforeAll(async () => {
  if (!PYTHON) return;
  await Promise.all(Object.entries(CASES).map(async ([name, c]) => {
    const m = make(c);
    runs[name] = { ...m, r: await run(m.script) };
  }));
}, 180000);

describe('the script, run', () => {
  withPython('runs without errors or warnings', () => {
    for (const [name, { r }] of Object.entries(runs)) expect([name, r.code, r.stderr]).toEqual([name, 0, '']);
  });

  withPython('computes the page\'s group statistics', () => {
    for (const { results, r } of Object.values(runs)) {
      const o = r.out;
      results.forEach((g, k) => {
        expect(o.n[k]).toBe(g.n);
        expect(close(o.means[k], g.mean, 1e-13)).toBe(true);
        expect(close(o.sds[k], g.sd, 1e-12)).toBe(true);
        expect(close(o.sems[k], g.sem, 1e-12)).toBe(true);
        // jStat's inverse t, which the page uses, agrees with SciPy's to about 5e-9.
        expect(close(o.t[k], g.t, 2e-8)).toBe(true);
        expect(close(o.ci[k], g.ci, 2e-8)).toBe(true);
      });
    }
  });

  withPython('computes the page\'s Welch tests and Holm\'s correction', () => {
    for (const { results, r } of Object.values(runs)) {
      const want = pairwiseComparisons(results);
      expect(r.out.pairs).toHaveLength(want.length);
      want.forEach((w, k) => {
        const got = r.out.pairs[k];
        expect([results[got.i].key, results[got.j].key]).toEqual([w.a, w.b]);
        expect(close(got.t, w.t, 1e-12)).toBe(true);
        expect(close(got.df, w.df, 1e-12)).toBe(true);
        expect(close(got.p, w.p, 1e-8)).toBe(true);
        expect(close(got.p_holm, w.pAdjusted, 1e-8)).toBe(true);
      });
    }
  });

  withPython('places the page\'s brackets, with its labels', () => {
    for (const { desc, r } of Object.values(runs)) {
      const want = desc.panels[0].series.filter((s) => s.kind === 'bracket');
      expect(r.out.brackets.map(([i, j, , t]) => [i, j, t])).toEqual(want.map((b) => [b.x1, b.x2, b.text]));
      r.out.brackets.forEach(([, , y], k) => expect(close(y, want[k].y, 2e-8)).toBe(true));
      expect(r.out.texts).toEqual(want.map((b) => b.text));
    }
  });

  withPython('matplotlib\'s axis limits are the preview\'s', () => {
    for (const [name, { drawn, r }] of Object.entries(runs)) {
      const [x, y] = previewRanges(drawn);
      // The limits follow the brackets, placed from intervals good to 5e-9 (above).
      const ok = [...r.out.xlim.map((v, k) => close(v, x[k])), ...r.out.ylim.map((v, k) => close(v, y[k], 2e-8))].every(Boolean);
      if (!ok) throw new Error(`${name}: matplotlib x ${r.out.xlim} y ${r.out.ylim}, preview x ${x} y ${y}`);
      expect(r.out.xticklabels).toEqual(drawn.xCategories);
      expect(r.out.ylabel).toBe(drawn.panels[0].yLabel);
    }
  });

  withPython('the person\'s style reaches the script', async () => {
    const { script } = make(CASES.basic, {
      yLabel: 'ignored', panels: [{ yLabel: 'Activity (U)', yLim: [0, 12] }],
      series: { 'group:Control': { color: '#000000' }, 'pair:Control|Low Dose': { color: '#d64545', fontSize: 14 } }
    });
    expect(script).toContain("ax.set_ylabel('Activity (U)')");
    expect(script).toContain("color='#000000'");
    expect(script).toContain('fontsize=14');
    const r = await run(script);
    expect([r.code, r.stderr]).toEqual([0, '']);
    expect(r.out.ylim).toEqual([0, 12]);
  }, 60000); // matplotlib takes seconds to start, more under coverage
});
