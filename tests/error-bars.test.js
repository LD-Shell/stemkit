import { describe, test, expect } from '@jest/globals';
import '../tests/setup.js';
import {
  mean, sd, median, quantile,
  summariseGroup, detectHeaderRow, groupRows, computeGroups,
  currentError, errorLabel, niceTicks, axisRange,
  resultsToCSV, pairwiseComparisons, nonOverlappingPairs
} from '../src/core/error-bars.js';

/* Reference values from scipy.stats; Holm correction computed independently. */

const A = [5.1, 5.3, 4.9, 5.2, 5.0];
const B = [7.2, 7.5, 7.1, 7.3, 7.4];
const C = [5.2, 5.4, 5.0, 5.1, 5.3];

describe('descriptive helpers', () => {
  test('mean matches numpy', () => {
    expect(mean(A)).toBeCloseTo(5.1, 12);
  });

  test('sd uses the n-1 denominator', () => {
    expect(sd(A)).toBeCloseTo(0.15811388300841883, 12);
  });

  test('sd of a single observation is zero, not NaN', () => {
    expect(sd([5])).toBe(0);
  });

  test('median handles odd and even counts', () => {
    expect(median(A)).toBeCloseTo(5.1, 12);
    expect(median([1, 2, 3, 4])).toBeCloseTo(2.5, 12);
  });

  test('quantile matches numpy linear interpolation', () => {
    expect(quantile(A, 0.25)).toBeCloseTo(5.0, 12);
    expect(quantile(A, 0.75)).toBeCloseTo(5.2, 12);
  });

  test('quantile endpoints are the extremes', () => {
    expect(quantile(A, 0)).toBeCloseTo(4.9, 12);
    expect(quantile(A, 1)).toBeCloseTo(5.3, 12);
  });

  test('helpers return NaN for empty or invalid input', () => {
    expect(Number.isNaN(mean([]))).toBe(true);
    expect(Number.isNaN(quantile(A, 1.5))).toBe(true);
    expect(Number.isNaN(median(null))).toBe(true);
  });

  test('median and quantile do not mutate their input', () => {
    const v = [3, 1, 2];
    median(v);
    quantile(v, 0.5);
    expect(v).toEqual([3, 1, 2]);
  });
});

describe('summariseGroup', () => {
  test('reports mean, sd and sem matching scipy', () => {
    const s = summariseGroup('A', A);
    expect(s.mean).toBeCloseTo(5.1, 12);
    expect(s.sd).toBeCloseTo(0.15811388300841883, 12);
    expect(s.sem).toBeCloseTo(0.07071067811865468, 12);
  });

  test('the confidence interval uses the t quantile', () => {
    const s = summariseGroup('A', A, 0.95);
    expect(s.t).toBeCloseTo(2.7764451051977934, 7);
    expect(s.ci).toBeCloseTo(0.1963243161477555, 7);
  });

  test('SEM is smaller than SD for n greater than one', () => {
    const s = summariseGroup('A', A);
    expect(s.sem).toBeLessThan(s.sd);
    expect(s.sem).toBeCloseTo(s.sd / Math.sqrt(s.n), 12);
  });

  test('a wider confidence level gives a wider interval', () => {
    expect(summariseGroup('A', A, 0.99).ci)
      .toBeGreaterThan(summariseGroup('A', A, 0.95).ci);
  });

  test('a single observation has no dispersion and no interval', () => {
    const s = summariseGroup('A', [5]);
    expect(s.n).toBe(1);
    expect(s.sd).toBe(0);
    expect(s.t).toBe(0);
    expect(s.ci).toBe(0);
  });

  test('reports quartiles, IQR and coefficient of variation', () => {
    const s = summariseGroup('A', A);
    expect(s.q1).toBeCloseTo(5.0, 12);
    expect(s.q3).toBeCloseTo(5.2, 12);
    expect(s.iqr).toBeCloseTo(0.2, 12);
    expect(s.cv).toBeCloseTo(3.1003, 3);
  });

  test('coefficient of variation is zero when the mean is zero', () => {
    expect(summariseGroup('Z', [-1, 0, 1]).cv).toBe(0);
  });

  test('returns null for empty input', () => {
    expect(summariseGroup('A', [])).toBeNull();
    expect(summariseGroup('A', null)).toBeNull();
  });
});

describe('detectHeaderRow', () => {
  test('detects a text header above numeric data', () => {
    expect(detectHeaderRow([['Group', 'R1', 'R2'], ['A', 1, 2]])).toBe(true);
  });

  test('does not treat numeric first rows as a header', () => {
    expect(detectHeaderRow([['A', 1, 2], ['B', 3, 4]])).toBe(false);
  });

  test('requires at least two rows', () => {
    expect(detectHeaderRow([['Group', 'R1']])).toBe(false);
    expect(detectHeaderRow([])).toBe(false);
  });
});

describe('groupRows', () => {
  test('groups by the first-column label', () => {
    const { groups } = groupRows([['A', 1, 2], ['B', 3, 4]]);
    expect(groups.get('A')).toEqual([1, 2]);
    expect(groups.get('B')).toEqual([3, 4]);
  });

  test('pools replicates spread across several rows', () => {
    const { groups } = groupRows([['A', 1], ['A', 2], ['A', 3]]);
    expect(groups.get('A')).toEqual([1, 2, 3]);
  });

  test('skips rows without a label or without numbers', () => {
    const { groups, skipped } = groupRows([['A', 1], ['', 2], ['B', 'x']]);
    expect(groups.size).toBe(1);
    expect(skipped).toBe(2);
  });

  test('ignores non-numeric cells within a row', () => {
    const { groups } = groupRows([['A', 1, 'bad', 3]]);
    expect(groups.get('A')).toEqual([1, 3]);
  });
});

describe('computeGroups', () => {
  const table = [['Group', 'R1', 'R2', 'R3'], ['A', 5.1, 5.3, 4.9], ['B', 7.2, 7.5, 7.1]];

  test('detects the header and summarises each group', () => {
    const r = computeGroups(table);
    expect(r.headerDetected).toBe(true);
    expect(r.results).toHaveLength(2);
    expect(r.results[0].key).toBe('A');
  });

  test('honours an explicit header override', () => {
    // Forcing header-off makes the header line a data row, but its cells are
    // all text, so it is skipped for having no numeric values rather than
    // becoming a bogus group.
    const r = computeGroups(table, { hasHeader: false });
    expect(r.headerDetected).toBe(false);
    expect(r.results).toHaveLength(2);
    expect(r.skipped).toBe(1);
  });

  test('an override can rescue data whose first row looks like a header', () => {
    const noHeader = [['2020', 1.1, 1.2], ['2021', 2.1, 2.2]];
    expect(computeGroups(noHeader, { hasHeader: false }).results).toHaveLength(2);
  });

  test('passes the confidence level through', () => {
    const r = computeGroups(table, { level: 0.99 });
    expect(r.results[0].level).toBe(0.99);
  });

  test('returns an empty result for no input', () => {
    expect(computeGroups([]).results).toEqual([]);
    expect(computeGroups(null).results).toEqual([]);
  });
});

describe('error selection and labelling', () => {
  const s = summariseGroup('A', A);

  test('selects the requested error measure', () => {
    expect(currentError(s, 'sd')).toBeCloseTo(s.sd, 12);
    expect(currentError(s, 'sem')).toBeCloseTo(s.sem, 12);
    expect(currentError(s, 'ci')).toBeCloseTo(s.ci, 12);
  });

  test('returns NaN for an unknown mode', () => {
    expect(Number.isNaN(currentError(s, 'bogus'))).toBe(true);
    expect(Number.isNaN(currentError(null, 'sd'))).toBe(true);
  });

  test('labels always name the measure', () => {
    expect(errorLabel('sd')).toBe('SD');
    expect(errorLabel('sem')).toBe('SEM');
    expect(errorLabel('ci', 0.95)).toBe('95% CI');
    expect(errorLabel('ci', 0.99)).toBe('99% CI');
  });
});

describe('niceTicks', () => {
  test('produces round intervals across a decade', () => {
    expect(niceTicks(0, 10, 5)).toEqual([0, 2, 4, 6, 8, 10]);
  });

  test('produces round intervals below one', () => {
    expect(niceTicks(0, 1, 4)).toEqual([0, 0.25, 0.5, 0.75, 1]);
  });

  test('spans the requested range', () => {
    const t = niceTicks(3, 27, 5);
    expect(t[0]).toBeLessThanOrEqual(3);
    expect(t[t.length - 1]).toBeGreaterThanOrEqual(27);
  });

  test('handles a reversed range', () => {
    expect(niceTicks(10, 0, 5)).toEqual(niceTicks(0, 10, 5));
  });

  test('handles a degenerate range', () => {
    expect(niceTicks(5, 5)).toEqual([5]);
    expect(niceTicks(NaN, 5)).toEqual([]);
  });

  test('does not accumulate floating-point drift', () => {
    const t = niceTicks(0, 1, 10);
    for (const v of t) {
      expect(Math.abs(v * 100 - Math.round(v * 100))).toBeLessThan(1e-9);
    }
  });
});

describe('axisRange', () => {
  test('spans every bar plus its error', () => {
    const results = [summariseGroup('A', A), summariseGroup('B', B)];
    const r = axisRange(results, 'sd');
    expect(r.max).toBeGreaterThan(7.4);
    expect(r.min).toBeLessThanOrEqual(0);
  });

  test('can exclude zero', () => {
    const results = [summariseGroup('A', A)];
    const r = axisRange(results, 'sd', { includeZero: false });
    expect(r.min).toBeGreaterThan(0);
  });

  test('handles empty input', () => {
    expect(axisRange([], 'sd')).toEqual({ min: 0, max: 1 });
  });
});

describe('resultsToCSV', () => {
  test('emits a header and one row per group', () => {
    const csv = resultsToCSV([summariseGroup('A', A)]);
    const lines = csv.trim().split('\n');
    expect(lines[0]).toContain('Group,n,Mean,SD,SEM');
    expect(lines).toHaveLength(2);
  });

  test('escapes quotes in group labels', () => {
    expect(resultsToCSV([summariseGroup('a"b', A)])).toContain('"a""b"');
  });

  test('handles empty input', () => {
    expect(resultsToCSV([]).trim()).toContain('Group,n,Mean');
    expect(resultsToCSV(null).trim()).toContain('Group,n,Mean');
  });
});

describe('pairwiseComparisons', () => {
  const groups = [
    { key: 'A', values: A }, { key: 'B', values: B }, { key: 'C', values: C }
  ];

  test('compares every pair', () => {
    expect(pairwiseComparisons(groups)).toHaveLength(3);
  });

  test('raw p-values match scipy Welch t-tests', () => {
    const pw = pairwiseComparisons(groups);
    const ab = pw.find(p => p.a === 'A' && p.b === 'B');
    const ac = pw.find(p => p.a === 'A' && p.b === 'C');
    expect(ab.p).toBeCloseTo(1.9239864091880955e-08, 14);
    expect(ac.p).toBeCloseTo(0.34659350708732767, 8);
  });

  test('applies a Holm-Bonferroni correction', () => {
    const pw = pairwiseComparisons(groups);
    const ab = pw.find(p => p.a === 'A' && p.b === 'B');
    expect(ab.pAdjusted).toBeCloseTo(5.7719592275642864e-08, 14);
  });

  test('the adjusted p-value is never smaller than the raw one', () => {
    for (const p of pairwiseComparisons(groups)) {
      expect(p.pAdjusted).toBeGreaterThanOrEqual(p.p - 1e-15);
    }
  });

  test('adjusted p-values are capped at one', () => {
    const weak = [
      { key: 'A', values: [1, 2, 3] },
      { key: 'B', values: [1.1, 2.1, 3.1] },
      { key: 'C', values: [0.9, 2.0, 3.05] }
    ];
    for (const p of pairwiseComparisons(weak)) {
      expect(p.pAdjusted).toBeLessThanOrEqual(1);
    }
  });

  test('flags only genuinely separated groups', () => {
    const pw = pairwiseComparisons(groups);
    expect(pw.find(p => p.a === 'A' && p.b === 'B').significant).toBe(true);
    expect(pw.find(p => p.a === 'A' && p.b === 'C').significant).toBe(false);
  });

  test('skips groups too small to compare', () => {
    expect(pairwiseComparisons([
      { key: 'A', values: [1] }, { key: 'B', values: [2] }
    ])).toEqual([]);
  });

  test('returns an empty array for fewer than two groups', () => {
    expect(pairwiseComparisons([{ key: 'A', values: A }])).toEqual([]);
    expect(pairwiseComparisons(null)).toEqual([]);
  });
});

describe('nonOverlappingPairs', () => {
  test('flags clearly separated groups', () => {
    const r = nonOverlappingPairs([
      summariseGroup('A', A), summariseGroup('B', B)
    ]);
    expect(r.separated).toHaveLength(1);
    expect(r.separated[0]).toEqual({ a: 'A', b: 'B' });
  });

  test('does not flag overlapping groups', () => {
    const r = nonOverlappingPairs([
      summariseGroup('A', A), summariseGroup('C', C)
    ]);
    expect(r.separated).toEqual([]);
    expect(r.allOverlap).toBe(true);
  });

  test('is more conservative than a formal test', () => {
    // A and C differ by a t-test at some levels, but their intervals overlap,
    // so the heuristic stays silent. This is the documented failure mode.
    const overlap = nonOverlappingPairs([
      summariseGroup('A', A), summariseGroup('C', C)
    ]);
    expect(overlap.separated).toEqual([]);
  });

  test('ignores groups with too little data for an interval', () => {
    const r = nonOverlappingPairs([
      summariseGroup('A', A), summariseGroup('Single', [5])
    ]);
    expect(r.comparable).toBe(1);
    expect(r.separated).toEqual([]);
  });

  test('compares every pair among three or more groups', () => {
    const r = nonOverlappingPairs([
      summariseGroup('A', A), summariseGroup('B', B), summariseGroup('C', C)
    ]);
    // A-B and B-C separate; A-C overlaps.
    expect(r.separated).toHaveLength(2);
  });

  test('reports nothing for fewer than two usable groups', () => {
    expect(nonOverlappingPairs([summariseGroup('A', A)]).allOverlap).toBe(false);
    expect(nonOverlappingPairs([]).separated).toEqual([]);
    expect(nonOverlappingPairs(null).separated).toEqual([]);
  });
});
