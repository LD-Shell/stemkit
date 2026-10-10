import { describe, test, expect } from '@jest/globals';
import '../tests/setup.js';
import {
  mean, sd, median, quantile,
  summariseGroup, readCell, detectHeaderRow, groupRows, computeGroups,
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

  test('a group of equal values has no spread, whatever rounding leaves of its SD', () => {
    // sd() of six copies of 0.1 is 1.5e-17 (their mean is 0.09999999999999999).
    for (const v of [0.1, 0.7, 4.35]) {
      const s = summariseGroup('A', Array(6).fill(v));
      expect([s.sd, s.sem, s.ci, s.cv]).toEqual([0, 0, 0, 0]);
    }
  });

  test('returns null for empty input', () => {
    expect(summariseGroup('A', [])).toBeNull();
    expect(summariseGroup('A', null)).toBeNull();
  });
});

describe('readCell', () => {
  test('reads numbers, and strings that are numbers', () => {
    // Papa Parse's dynamicTyping leaves these three as strings.
    expect(readCell('+5')).toEqual({ kind: 'number', value: 5 });
    expect(readCell('1e16')).toEqual({ kind: 'number', value: 1e16 });
    expect(readCell(' -2.5E-3 ')).toEqual({ kind: 'number', value: -0.0025 });
    expect(readCell(4.2)).toEqual({ kind: 'number', value: 4.2 });
    expect(readCell('.5').value).toBe(0.5);
    expect(readCell('5.').value).toBe(5);
  });

  test('a number too large to hold is not a number', () => {
    expect(readCell('1e400').kind).toBe('infinite');
    expect(readCell('-1e400').kind).toBe('infinite');
    expect(readCell(Infinity).kind).toBe('infinite');
  });

  test('digits with a comma are told apart from other text', () => {
    for (const c of ['6,1', '-0,5', '1,234', '1.234,56', '1,5e3']) expect([c, readCell(c).kind]).toEqual([c, 'comma']);
    for (const c of ['n/a', 'a,b', ',', 'true', '0x10', 'Infinity', 'NaN', '1e', '--5', '5 6']) {
      expect([c, readCell(c).kind]).toEqual([c, 'text']);
    }
    expect(readCell(true).kind).toBe('text');
    expect(readCell(NaN).kind).toBe('text');
  });

  test('an empty cell is blank', () => {
    for (const c of [null, undefined, '', '   ']) expect(readCell(c).kind).toBe('blank');
  });

  test('a very long cell is classified at once', () => {
    const started = Date.now();
    expect(readCell('1,' + '1'.repeat(200000) + 'x').kind).toBe('text');
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('detectHeaderRow', () => {
  test('detects a text header above numeric data', () => {
    expect(detectHeaderRow([['Group', 'R1', 'R2'], ['A', 1, 2]])).toBe(true);
  });

  test('does not treat numeric first rows as a header', () => {
    expect(detectHeaderRow([['A', 1, 2], ['B', 3, 4]])).toBe(false);
  });

  test('a first row of numbers written as text is data', () => {
    expect(detectHeaderRow([['A', '+5', '1e16'], ['B', 1, 2]])).toBe(false);
  });

  test('a first row of decimal commas is kept as data, to be reported', () => {
    expect(detectHeaderRow([['A', '6,1', '6,3'], ['B', 7.1, 7.2]])).toBe(false);
    expect(detectHeaderRow([['Label', 'R1', 'R2'], ['A', '6,1', '6,3']])).toBe(true);
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

  test('leaves non-numeric cells out of a row, and counts them with an example', () => {
    const { groups, unread } = groupRows([['A', 1, 'bad', 3], ['B', 'n/a', 2, null, '']]);
    expect(groups.get('A')).toEqual([1, 3]);
    expect(groups.get('B')).toEqual([2]);
    expect(unread.total).toBe(2);
    expect(unread.text).toEqual({ count: 2, example: 'bad' });
    expect(unread.comma.count + unread.infinite.count).toBe(0);
  });

  test('reads +5 and 1e16, and reports 1e400 and a decimal comma as not read', () => {
    // The row as Papa Parse hands it over with dynamicTyping: all four are strings.
    const { groups, skipped, unread } = groupRows([['A', '+5', '1e16', '1e400', '6,1'], ['B', 1, 2, '7,25', 4]]);
    expect(groups.get('A')).toEqual([5, 1e16]);
    expect(groups.get('B')).toEqual([1, 2, 4]);
    expect(skipped).toBe(0);
    expect(unread.total).toBe(3);
    expect(unread.comma).toEqual({ count: 2, example: '6,1' });
    expect(unread.infinite).toEqual({ count: 1, example: '1e400' });
    expect(unread.text.count).toBe(0);
  });

  test('a table of decimal commas gives no groups and says why', () => {
    const { groups, skipped, unread } = groupRows([['A', '6,1', '6,3'], ['B', '7,1', '7,2']]);
    expect(groups.size).toBe(0);
    expect(skipped).toBe(2);
    expect(unread.comma).toEqual({ count: 4, example: '6,1' });
  });

  test('counts nothing when every cell is a number or empty', () => {
    expect(groupRows([['A', 1, 2, null], ['', 'stray', 3]]).unread.total).toBe(0);
  });

  test('a long table of one value a row is pooled in order, and the rows are left as they were', () => {
    const rows = Array.from({ length: 300000 }, (_, i) => [i % 2 ? 'B' : 'A', i]);
    const first = rows[0].slice();
    const { groups, skipped } = groupRows(rows);
    expect(skipped).toBe(0);
    expect(groups.get('A')).toHaveLength(150000);
    expect(groups.get('A').slice(0, 3)).toEqual([0, 2, 4]);
    expect(groups.get('B')[149999]).toBe(299999);
    expect(rows[0]).toEqual(first);
  });
});

describe('a group too large to pass as arguments', () => {
  // Math.min(...values) throws "Maximum call stack size exceeded" somewhere past 100,000 values.
  const values = Array.from({ length: 400000 }, (_, i) => Math.sin(i) * 100 + (i === 123456 ? 500 : 0));

  test('summariseGroup finds its smallest and largest value', () => {
    const r = summariseGroup('big', values);
    expect(r.n).toBe(400000);
    expect(r.max).toBeCloseTo(Math.sin(123456) * 100 + 500, 9);
    expect(r.min).toBe(values.reduce((a, b) => Math.min(a, b), Infinity));
    expect(r.min).toBeLessThan(-99.99);
  });

  test('computeGroups summarises it from one-value rows', () => {
    const r = computeGroups(values.map(v => ['big', v]), { hasHeader: false });
    expect(r.results).toHaveLength(1);
    expect(r.results[0].n).toBe(400000);
    expect(r.results[0].max).toBeGreaterThan(400);
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
    // A first group whose readings are all text is taken for a header and
    // dropped without a word; with the override it is a row of data again,
    // counted as skipped, and its cells are counted as not read.
    const rows = [['Blank', 'n.d.', 'n.d.'], ['A', 1.1, 1.2], ['B', 2.1, 2.2]];
    const auto = computeGroups(rows);
    expect([auto.headerDetected, auto.skipped, auto.unread.total]).toEqual([true, 0, 0]);
    const forced = computeGroups(rows, { hasHeader: false });
    expect([forced.headerDetected, forced.skipped]).toEqual([false, 1]);
    expect(forced.unread.text).toEqual({ count: 2, example: 'n.d.' });
    expect(forced.results.map(r => r.key)).toEqual(['A', 'B']);
  });

  test('an override can rescue a header made of numbers', () => {
    // Column names that are numbers (doses, years) are not taken for a header,
    // so they become a group of their own until the header is forced.
    const rows = [['Dose', 10, 20], ['A', 1.1, 1.2], ['B', 2.1, 2.2]];
    expect(computeGroups(rows).results.map(r => r.key)).toEqual(['Dose', 'A', 'B']);
    expect(computeGroups(rows, { hasHeader: true }).results.map(r => r.key)).toEqual(['A', 'B']);
  });

  test('reports the cells that were not read', () => {
    const r = computeGroups([['Label', 'R1', 'R2'], ['A', '6,1', 6.3], ['B', 7.1, 'n/a']]);
    expect(r.headerDetected).toBe(true);
    expect(r.unread.total).toBe(2);
    expect(r.unread.comma.example).toBe('6,1');
    expect(r.unread.text.example).toBe('n/a');
    expect(computeGroups([]).unread.total).toBe(0);
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

  test('leaves spread cells empty for a single replicate', () => {
    const row = resultsToCSV([summariseGroup('S', [5])]).trim().split('\n')[1];
    // Group, n, Mean, SD, SEM, t, CI, Median, Q1, Q3, IQR, CV%, Min, Max
    expect(row).toBe('"S",1,5,,,,,5,5,5,0,,5,5');
  });

  test('writes spread cells for two or more replicates', () => {
    const s = summariseGroup('A', A);
    const cells = resultsToCSV([s]).trim().split('\n')[1].split(',');
    expect(cells.slice(3, 7).map(Number)).toEqual([s.sd, s.sem, s.t, s.ci]);
    expect(Number(cells[11])).toBe(s.cv);
  });

  test('leaves CV empty when the mean is zero', () => {
    const cells = resultsToCSV([summariseGroup('Z', [-1, 0, 1])]).trim().split('\n')[1].split(',');
    expect(cells[11]).toBe('');
    expect(Number(cells[3])).toBe(1);
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

  test('significance is judged at the alpha it is given', () => {
    // scipy.stats.ttest_ind([4.5, 4.2, 4.8, 4.6], [5.3, 4.9, 5.5, 5.0], equal_var=False).pvalue
    const pair = [{ key: 'A', values: [4.5, 4.2, 4.8, 4.6] }, { key: 'B', values: [5.3, 4.9, 5.5, 5.0] }];
    const p = 0.013095909113683742;
    expect(pairwiseComparisons(pair)[0].pAdjusted).toBeCloseTo(p, 9);
    expect(pairwiseComparisons(pair)[0].significant).toBe(true);
    expect(pairwiseComparisons(pair, { alpha: 0.1 })[0].significant).toBe(true);
    expect(pairwiseComparisons(pair, { alpha: 0.01 })[0].significant).toBe(false);
  });

  test('two groups of equal values are not tested, whatever rounding leaves of their SDs', () => {
    // Six copies of 0.1 against six of 0.7 gave t = -1.2e16 and p = 2.9e-82.
    const same = (key, v) => ({ key, values: Array(6).fill(v) });
    expect(pairwiseComparisons([same('A', 0.1), same('B', 0.7)])).toEqual([]);
    expect(pairwiseComparisons([same('A', 0.5), same('B', 0.25)])).toEqual([]);
  });

  test('a group of equal values is tested against one with spread, with a variance of 0', () => {
    // t = (0.1 - mean(B)) / (sd(B) / sqrt(5)) on df = 4: a one-sample test of B against 0.1.
    // scipy.stats.ttest_1samp([0.5, 0.6, 0.7, 0.65, 0.55], 0.1): t = 14.142135623730953, p = 0.0001451281706131975
    const r = pairwiseComparisons([{ key: 'A', values: Array(6).fill(0.1) }, { key: 'B', values: [0.5, 0.6, 0.7, 0.65, 0.55] }]);
    expect(r).toHaveLength(1);
    expect(r[0].t).toBeCloseTo(-14.142135623730953, 9);
    expect(r[0].df).toBeCloseTo(4, 12);
    expect(r[0].p).toBeCloseTo(0.0001451281706131975, 9);
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
