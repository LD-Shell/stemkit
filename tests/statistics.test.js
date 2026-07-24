import { describe, test, expect } from '@jest/globals';
import '../tests/setup.js';
import {
  mean, variance, sd, median, skewness, kurtosis, ranks, describe as summarise,
  tTwoSided, tCritical, fUpperTail, zTwoSided, chiSquaredUpperTail,
  dagostinoNormality, leveneTest,
  independentTTest, pairedTTest, oneWayAnova, pearsonCorrelation,
  mannWhitneyU, wilcoxonSignedRank,
  alignPairs, formatP, interpretD, interpretEta, interpretR,
  classifyFields, pivotLongToGroups
} from '../src/core/statistics.js';

/*
 * Reference values throughout are from SciPy 1.17.1 (scipy.stats), computed
 * independently of this implementation. Where SciPy and the vendored jStat
 * differ in the last few ulp the tolerance is relaxed accordingly, and the
 * reason is noted inline.
 */

const A = [23.1, 22.8, 24.2, 23.5, 22.9, 23.8, 24.1, 23.3, 22.6, 23.9];
const B = [28.4, 29.1, 27.9, 30.2, 28.8, 29.5, 28.1, 30.7, 29.3, 28.6];
const PLACEBO = [5.2, 4.9, 5.5, 5.1, 4.8, 5.3, 5.0, 5.4];
const LOWDOSE = [6.8, 7.1, 6.5, 7.3, 6.9, 7.0, 6.7, 7.2];
const HIGHDOSE = [9.1, 8.7, 9.4, 8.9, 9.2, 8.6, 9.5, 8.8];
const X1 = [1.83, 0.50, 1.62, 2.48, 1.68, 1.88, 1.55, 3.06, 1.30];
const X2 = [0.878, 0.647, 0.598, 2.05, 1.06, 1.29, 1.06, 3.14, 1.29];

describe('descriptive statistics', () => {
  test('mean matches numpy', () => {
    expect(mean(A)).toBeCloseTo(23.42, 12);
  });

  test('variance uses the n-1 denominator', () => {
    // Population variance of A is 0.2896; the sample value is 10/9 larger.
    expect(variance(A)).toBeCloseTo(0.3217777777777778, 12);
    expect(sd(A)).toBeCloseTo(0.5672545969648704, 12);
  });

  test('median averages the two central values for even n', () => {
    expect(median(A)).toBeCloseTo(23.4, 12);
    expect(median([1, 2, 3])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  test('median does not mutate its argument', () => {
    const input = [3, 1, 2];
    median(input);
    expect(input).toEqual([3, 1, 2]);
  });

  test('skewness uses the population sd, matching scipy skew(bias=False)', () => {
    // Using the sample (n-1) sd here would give -0.006393, a ~15% error.
    expect(skewness(A)).toBeCloseTo(-0.007487356809078233, 10);
  });

  test('kurtosis matches scipy kurtosis(fisher=True, bias=True)', () => {
    expect(kurtosis(A)).toBeCloseTo(-1.4003044778852913, 10);
  });

  test('skewness is zero for a symmetric sample', () => {
    expect(skewness([1, 2, 3, 4, 5])).toBeCloseTo(0, 12);
  });

  test('moments are zero for a constant sample rather than NaN', () => {
    expect(skewness([5, 5, 5, 5])).toBe(0);
    expect(kurtosis([5, 5, 5, 5])).toBe(0);
  });

  test('degenerate input returns NaN rather than throwing', () => {
    expect(Number.isNaN(mean([]))).toBe(true);
    expect(Number.isNaN(variance([1]))).toBe(true);
    expect(Number.isNaN(skewness([1, 2]))).toBe(true);
    expect(Number.isNaN(mean(null))).toBe(true);
  });

  test('describe returns a full summary', () => {
    const d = summarise(A);
    expect(d.n).toBe(10);
    expect(d.min).toBeCloseTo(22.6, 12);
    expect(d.max).toBeCloseTo(24.2, 12);
    expect(summarise([])).toBeNull();
  });
});

describe('ranks', () => {
  test('assigns sequential ranks to distinct values', () => {
    expect(ranks([10, 20, 30])).toEqual([1, 2, 3]);
  });

  test('preserves original element order', () => {
    expect(ranks([30, 10, 20])).toEqual([3, 1, 2]);
  });

  test('averages tied ranks', () => {
    // Values 10,10 occupy ranks 1 and 2 -> both receive 1.5.
    expect(ranks([10, 10, 20])).toEqual([1.5, 1.5, 3]);
    expect(ranks([5, 5, 5])).toEqual([2, 2, 2]);
  });

  test('handles a four-way tie spanning ranks 2..5', () => {
    expect(ranks([1, 7, 7, 7, 7])).toEqual([1, 3.5, 3.5, 3.5, 3.5]);
  });

  test('returns an empty array for non-array input', () => {
    expect(ranks(null)).toEqual([]);
  });
});

describe('distribution tails', () => {
  test('two-sided t p-value matches scipy', () => {
    expect(tTwoSided(-16.819384638111565, 15.216841195495176))
      .toBeCloseTo(3.0424123732399504e-11, 20);
  });

  test('t tail retains precision where 1-cdf would underflow to zero', () => {
    const p = tTwoSided(50, 20);
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThan(1e-20);
  });

  test('critical t matches the textbook 95% value', () => {
    expect(tCritical(10, 0.95)).toBeCloseTo(2.228138852, 6);
    expect(tCritical(Infinity, 0.95)).toBeCloseTo(1.959963985, 5);
  });

  test('F upper tail matches scipy for a strong effect', () => {
    // The naive 1 - cdf(F) form returns exactly 0 here.
    expect(fUpperTail(377.5451829723711, 2, 21))
      .toBeCloseTo(3.4611747382894255e-17, 25);
  });

  test('F tail is 1 at and below zero', () => {
    expect(fUpperTail(0, 2, 10)).toBe(1);
    expect(fUpperTail(-5, 2, 10)).toBe(1);
  });

  test('normal two-sided p-value matches known values', () => {
    expect(zTwoSided(1.959963985)).toBeCloseTo(0.05, 8);
    expect(zTwoSided(0)).toBeCloseTo(1, 12);
  });

  test('normal tail stays positive beyond the vendored erfc range', () => {
    // jStat's erfc underflows to 0 at |z| > 8; the asymptotic branch takes over.
    const p = zTwoSided(10);
    expect(p).toBeGreaterThan(0);
    expect(p).toBeCloseTo(1.523970e-23, 28);
  });

  test('chi-squared upper tail is exact for two degrees of freedom', () => {
    // Q(1, x/2) = exp(-x/2) in closed form.
    expect(chiSquaredUpperTail(200, 2)).toBeCloseTo(Math.exp(-100), 50);
    expect(chiSquaredUpperTail(5.991464547, 2)).toBeCloseTo(0.05, 8);
  });

  test('chi-squared tail is 1 at and below zero', () => {
    expect(chiSquaredUpperTail(0, 3)).toBe(1);
  });

  test('invalid parameters yield NaN', () => {
    expect(Number.isNaN(tTwoSided(1, 0))).toBe(true);
    expect(Number.isNaN(fUpperTail(1, 0, 5))).toBe(true);
    expect(Number.isNaN(zTwoSided(Infinity))).toBe(true);
  });
});

describe('independentTTest', () => {
  test("Welch's t, df and p match scipy", () => {
    const r = independentTTest(A, B);
    expect(r.t).toBeCloseTo(-16.819384638111565, 10);
    expect(r.df).toBeCloseTo(15.216841195495176, 10);
    expect(r.p).toBeCloseTo(3.0424123732399504e-11, 18);
  });

  test("Student's pooled t uses integer degrees of freedom", () => {
    const r = independentTTest(A, B, { pooled: true });
    expect(r.t).toBeCloseTo(-16.819384638111565, 10);
    expect(r.df).toBe(18);
    expect(r.p).toBeCloseTo(1.8709350126618823e-12, 20);
  });

  test('Welch and Student share t but differ in df for equal n', () => {
    const w = independentTTest(A, B);
    const s = independentTTest(A, B, { pooled: true });
    expect(w.t).toBeCloseTo(s.t, 12);
    expect(w.df).not.toBeCloseTo(s.df, 3);
  });

  test('reports Cohen d and the Hedges g correction', () => {
    const r = independentTTest(A, B);
    expect(r.d).toBeCloseTo(-7.5218574781, 8);
    // g is always shrunk toward zero relative to d.
    expect(Math.abs(r.g)).toBeLessThan(Math.abs(r.d));
  });

  test('confidence interval brackets the mean difference', () => {
    const r = independentTTest(A, B);
    expect(r.ci[0]).toBeLessThan(r.meanDiff);
    expect(r.ci[1]).toBeGreaterThan(r.meanDiff);
    // A significant result must exclude zero.
    expect(r.ci[1]).toBeLessThan(0);
  });

  test('is antisymmetric under argument order', () => {
    const ab = independentTTest(A, B);
    const ba = independentTTest(B, A);
    expect(ab.t).toBeCloseTo(-ba.t, 10);
    expect(ab.df).toBeCloseTo(ba.df, 10);
    expect(ab.p).toBeCloseTo(ba.p, 15);
  });

  test('identical samples give t = 0 and p = 1', () => {
    const r = independentTTest([1, 2, 3, 4], [1, 2, 3, 4]);
    expect(r.t).toBeCloseTo(0, 12);
    expect(r.p).toBeCloseTo(1, 10);
  });

  test('returns null when a group is too small', () => {
    expect(independentTTest([1], [1, 2, 3])).toBeNull();
    expect(independentTTest(null, B)).toBeNull();
  });
});

describe('pairedTTest', () => {
  test('t and p match scipy ttest_rel', () => {
    const r = pairedTTest(X1, X2);
    expect(r.t).toBeCloseTo(3.0353754156485917, 10);
    expect(r.p).toBeCloseTo(0.016176627434908088, 8);
    expect(r.n).toBe(9);
    expect(r.df).toBe(8);
  });

  test("reports Cohen's d_z for the paired design", () => {
    const r = pairedTTest(X1, X2);
    expect(r.dz).toBeCloseTo(r.meanDiff / r.sdDiff, 12);
  });

  test('truncates to the shorter series', () => {
    const r = pairedTTest([1, 2, 3, 4, 5], [2, 4, 5, 4]);
    expect(r.n).toBe(4);
  });

  test('a constant difference yields NaN rather than an infinite t', () => {
    const r = pairedTTest([1, 1, 1], [2, 2, 2]);
    expect(r.sdDiff).toBe(0);
    expect(Number.isNaN(r.t)).toBe(true);
    expect(r.meanDiff).toBeCloseTo(-1, 12);
  });

  test('returns null with fewer than two pairs', () => {
    expect(pairedTTest([1], [2])).toBeNull();
  });
});

describe('oneWayAnova', () => {
  test('F matches scipy f_oneway', () => {
    const r = oneWayAnova([PLACEBO, LOWDOSE, HIGHDOSE]);
    expect(r.F).toBeCloseTo(377.5451829723711, 8);
    expect(r.dfBetween).toBe(2);
    expect(r.dfWithin).toBe(21);
  });

  test('p retains precision instead of underflowing to zero', () => {
    const r = oneWayAnova([PLACEBO, LOWDOSE, HIGHDOSE]);
    expect(r.p).toBeGreaterThan(0);
    expect(r.p).toBeCloseTo(3.4611747382894255e-17, 25);
  });

  test('sums of squares decompose additively', () => {
    const r = oneWayAnova([PLACEBO, LOWDOSE, HIGHDOSE]);
    expect(r.ssBetween + r.ssWithin).toBeCloseTo(r.ssTotal, 10);
  });

  test('omega-squared is smaller than eta-squared', () => {
    const r = oneWayAnova([PLACEBO, LOWDOSE, HIGHDOSE]);
    expect(r.etaSquared).toBeGreaterThan(0);
    expect(r.etaSquared).toBeLessThan(1);
    expect(r.omegaSquared).toBeLessThan(r.etaSquared);
  });

  test('agrees with the squared t statistic for two groups', () => {
    // F(1, n-2) is exactly t^2 for the pooled two-sample test.
    const anova = oneWayAnova([A, B]);
    const tt = independentTTest(A, B, { pooled: true });
    expect(anova.F).toBeCloseTo(tt.t * tt.t, 6);
    expect(anova.p).toBeCloseTo(tt.p, 15);
  });

  test('identical groups give F = 0 and p = 1', () => {
    const r = oneWayAnova([[1, 2, 3], [1, 2, 3], [1, 2, 3]]);
    expect(r.F).toBeCloseTo(0, 12);
    expect(r.p).toBeCloseTo(1, 10);
  });

  test('reports per-group descriptives', () => {
    const r = oneWayAnova([PLACEBO, LOWDOSE, HIGHDOSE]);
    expect(r.groupNs).toEqual([8, 8, 8]);
    expect(r.groupMeans[0]).toBeCloseTo(5.15, 10);
  });

  test('returns null for degenerate designs', () => {
    expect(oneWayAnova([[1, 2, 3]])).toBeNull();
    expect(oneWayAnova([[1], [2]])).toBeNull();
    expect(oneWayAnova(null)).toBeNull();
  });
});

describe('pearsonCorrelation', () => {
  const x = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const y = [2.1, 3.9, 6.2, 7.8, 10.1, 12.2, 13.8, 16.1, 18.0, 20.2];

  test('r and p match scipy pearsonr', () => {
    const r = pearsonCorrelation(x, y);
    expect(r.r).toBeCloseTo(0.9996697883603307, 12);
    expect(r.p).toBeCloseTo(5.1996662290963514e-14, 20);
  });

  test('r-squared is the square of r', () => {
    const r = pearsonCorrelation(x, y);
    expect(r.r2).toBeCloseTo(r.r * r.r, 15);
  });

  test('Fisher-z interval brackets r and stays within [-1, 1]', () => {
    const r = pearsonCorrelation(x, y);
    expect(r.ci[0]).toBeLessThan(r.r);
    expect(r.ci[1]).toBeGreaterThan(r.r);
    expect(r.ci[0]).toBeGreaterThan(-1);
    expect(r.ci[1]).toBeLessThan(1);
  });

  test('is symmetric in its arguments', () => {
    expect(pearsonCorrelation(x, y).r).toBeCloseTo(pearsonCorrelation(y, x).r, 15);
  });

  test('detects perfect positive and negative relationships', () => {
    expect(pearsonCorrelation([1, 2, 3, 4], [2, 4, 6, 8]).r).toBeCloseTo(1, 12);
    expect(pearsonCorrelation([1, 2, 3, 4], [8, 6, 4, 2]).r).toBeCloseTo(-1, 12);
  });

  test('a perfect fit reports p = 0 rather than NaN', () => {
    const r = pearsonCorrelation([1, 2, 3, 4], [2, 4, 6, 8]);
    expect(r.p).toBe(0);
  });

  test('a constant variable yields NaN rather than dividing by zero', () => {
    const r = pearsonCorrelation([1, 1, 1, 1], [1, 2, 3, 4]);
    expect(Number.isNaN(r.r)).toBe(true);
  });

  test('returns null with fewer than three pairs', () => {
    expect(pearsonCorrelation([1, 2], [1, 2])).toBeNull();
  });
});

describe('mannWhitneyU', () => {
  test('U matches scipy for completely separated groups', () => {
    const r = mannWhitneyU([1, 2, 3, 4, 5], [6, 7, 8, 9, 10]);
    expect(r.U).toBe(0);
    expect(r.rankBiserial).toBeCloseTo(1, 12);
  });

  test('U1 and U2 sum to n1*n2', () => {
    const r = mannWhitneyU(A, B);
    expect(r.U1 + r.U2).toBe(r.n1 * r.n2);
  });

  test('identical groups place U at its null expectation', () => {
    const r = mannWhitneyU([1, 2, 3, 4], [1, 2, 3, 4]);
    expect(r.U).toBe(8);
    expect(r.z).toBeCloseTo(0, 10);
  });

  test('flags when a tie correction was applied', () => {
    expect(mannWhitneyU([1, 2, 3], [3, 4, 5]).tieCorrected).toBe(true);
    expect(mannWhitneyU([1, 2, 3], [4, 5, 6]).tieCorrected).toBe(false);
  });

  test('reports group medians', () => {
    const r = mannWhitneyU([1, 2, 3], [10, 20, 30]);
    expect(r.median1).toBe(2);
    expect(r.median2).toBe(20);
  });

  test('returns null for empty input', () => {
    expect(mannWhitneyU([], [1, 2])).toBeNull();
  });
});

describe('wilcoxonSignedRank', () => {
  test('W matches scipy wilcoxon', () => {
    const r = wilcoxonSignedRank(X1, X2);
    expect(r.W).toBe(5);
    expect(r.n).toBe(9);
  });

  test('positive and negative rank sums total n(n+1)/2', () => {
    const r = wilcoxonSignedRank(X1, X2);
    expect(r.wPositive + r.wNegative).toBeCloseTo((r.n * (r.n + 1)) / 2, 10);
  });

  test('drops zero differences and reports how many', () => {
    const r = wilcoxonSignedRank([1, 2, 3, 4], [1, 5, 3, 9]);
    expect(r.nDropped).toBe(2);
    expect(r.n).toBe(2);
  });

  test('returns null when every difference is zero', () => {
    expect(wilcoxonSignedRank([1, 2, 3], [1, 2, 3])).toBeNull();
  });

  test('a uniformly positive shift drives W to zero', () => {
    const r = wilcoxonSignedRank([10, 20, 30, 40], [1, 2, 3, 4]);
    expect(r.W).toBe(0);
  });
});

describe('assumption checks', () => {
  test("D'Agostino K-squared matches scipy normaltest", () => {
    const r = dagostinoNormality(A);
    // Small residual: scipy uses a marginally different kurtosis transform.
    expect(r.K2).toBeCloseTo(1.9719420051794323, 3);
    expect(r.p).toBeCloseTo(0.3730767924710829, 4);
    expect(r.ok).toBe(true);
  });

  test('declines to test samples smaller than eight', () => {
    const r = dagostinoNormality([1, 2, 3, 4, 5]);
    expect(r.ok).toBeNull();
    expect(r.note).toContain('n < 8');
  });

  test('declines to test a zero-variance sample', () => {
    const r = dagostinoNormality([5, 5, 5, 5, 5, 5, 5, 5, 5]);
    expect(r.ok).toBeNull();
  });

  test("Levene's W and p match scipy with median centring", () => {
    const r = leveneTest([A, B]);
    expect(r.W).toBeCloseTo(1.4324235448865574, 8);
    expect(r.p).toBeCloseTo(0.24689534322848378, 6);
    expect(r.ok).toBe(true);
    expect(r.df1).toBe(1);
    expect(r.df2).toBe(18);
  });

  test('detects genuinely unequal variances', () => {
    const tight = [10, 10.1, 9.9, 10.05, 9.95, 10.02, 9.98, 10.01];
    const loose = [10, 20, 0, 15, 5, 18, 2, 12];
    expect(leveneTest([tight, loose]).ok).toBe(false);
  });

  test('is undefined when every value equals its group median', () => {
    const r = leveneTest([[5, 5, 5], [7, 7, 7]]);
    expect(r.ok).toBeNull();
    expect(Number.isNaN(r.W)).toBe(true);
  });

  test('requires at least two groups', () => {
    expect(leveneTest([[1, 2, 3]]).ok).toBeNull();
  });
});

describe('helpers', () => {
  test('alignPairs truncates to the shorter array', () => {
    expect(alignPairs([1, 2, 3, 4], [5, 6])).toEqual({ a: [1, 2], b: [5, 6] });
    expect(alignPairs(null, [1])).toEqual({ a: [], b: [] });
  });

  test('formatP follows APA conventions', () => {
    expect(formatP(0.0234)).toBe('.023');
    expect(formatP(0.0001)).toBe('< .001');
    expect(formatP(NaN)).toBe('n/a');
    expect(formatP(0.5)).toBe('.500');
  });

  test('effect-size labels follow the conventional cut-offs', () => {
    expect(interpretD(0.1)).toBe('negligible');
    expect(interpretD(0.3)).toBe('small');
    expect(interpretD(0.6)).toBe('medium');
    expect(interpretD(1.2)).toBe('large');
    expect(interpretD(-1.2)).toBe('large');
  });

  test('eta-squared and r labels follow their own cut-offs', () => {
    expect(interpretEta(0.005)).toBe('negligible');
    expect(interpretEta(0.2)).toBe('large');
    expect(interpretR(0.05)).toBe('negligible');
    expect(interpretR(0.7)).toBe('strong');
  });
});

describe('data shaping', () => {
  const rows = [
    { id: 'a', score: 5, group: 'ctrl' },
    { id: 'b', score: 7, group: 'ctrl' },
    { id: 'c', score: 9, group: 'treat' },
    { id: 'd', score: 11, group: 'treat' }
  ];

  test('classifyFields separates numeric from categorical columns', () => {
    const c = classifyFields(rows, ['id', 'score', 'group']);
    expect(c.numeric).toContain('score');
    expect(c.categorical).toContain('group');
    expect(c.numeric).not.toContain('group');
  });

  test('classifyFields ignores entirely empty columns', () => {
    const c = classifyFields([{ x: '', y: 1 }], ['x', 'y']);
    expect(c.numeric).not.toContain('x');
  });

  test('pivotLongToGroups splits values by group level', () => {
    const { groups, order } = pivotLongToGroups(rows, 'score', 'group');
    expect(order).toEqual(['ctrl', 'treat']);
    expect(groups.ctrl).toEqual([5, 7]);
    expect(groups.treat).toEqual([9, 11]);
  });

  test('pivot preserves first-appearance order', () => {
    const r = [
      { v: 1, g: 'z' }, { v: 2, g: 'a' }, { v: 3, g: 'z' }
    ];
    expect(pivotLongToGroups(r, 'v', 'g').order).toEqual(['z', 'a']);
  });

  test('pivot skips rows with a missing group or non-numeric value', () => {
    const r = [
      { v: 1, g: 'x' }, { v: null, g: 'x' }, { v: 3, g: '' }, { v: 'text', g: 'x' }
    ];
    expect(pivotLongToGroups(r, 'v', 'g').groups.x).toEqual([1]);
  });

  test('pivot rejects identical or missing column names', () => {
    expect(pivotLongToGroups(rows, 'score', 'score').order).toEqual([]);
    expect(pivotLongToGroups(rows, 'score', null).order).toEqual([]);
  });
});
