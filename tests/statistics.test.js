import { describe, test, expect } from '@jest/globals';
import '../tests/setup.js';
import { spawnSync } from 'node:child_process';
import {
  mean, variance, sd, median, skewness, kurtosis, ranks, describe as summarise,
  descriptives, boxPlotStats,
  tTwoSided, tCritical, fUpperTail, zTwoSided, chiSquaredUpperTail,
  dagostinoNormality, leveneTest,
  independentTTest, pairedTTest, oneSampleTTest, oneWayAnova, welchAnova,
  pearsonCorrelation,
  leastSquaresLine, spearmanCorrelation,
  mannWhitneyU, wilcoxonSignedRank, oneSampleWilcoxon, kruskalWallis,
  qUpperTail, adjustPValues, tukeyHSD, gamesHowell, dunnTest, recommendTest,
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

/*
 * The functions from here on were validated against SciPy 1.11.4 (with
 * NumPy 1.26.4, statsmodels 0.14.1 and matplotlib 3.6.3 where SciPy has no
 * equivalent). Each block names the call that produced its reference values.
 */

// A skewed sample with an outlier and a tie, and two more like it.
const S1 = [1.2, 1.5, 1.1, 2.0, 1.3, 1.2, 4.8, 1.4, 1.6, 1.2];
const S2 = [2.1, 2.4, 1.9, 2.2, 7.5, 2.0, 2.3, 2.6, 1.9, 2.1];
const S3 = [3.3, 2.9, 3.8, 3.1, 9.9, 3.4, 3.0, 3.6, 3.2, 12.4];
// Unequal sizes and unequal spreads.
const U1 = [10.2, 11.1, 9.8, 10.5, 10.9, 10.1, 10.4];
const U2 = [12.5, 14.9, 9.7, 16.2, 11.8, 13.4, 15.1, 10.6, 12.9];
const U3 = [11.0, 11.4, 10.8, 11.9, 11.2, 10.7];
// Ten replicate titrations of a nominal 0.1000 M solution.
const TITR = [0.1012, 0.1008, 0.1015, 0.1003, 0.1011, 0.1009, 0.1017, 0.1006, 0.1013, 0.1010];

describe('descriptives', () => {
  test('matches numpy and scipy.stats for a group of ten', () => {
    // a.std(ddof=1); stats.sem(a); stats.t.interval(0.95, n-1, loc=m, scale=sem);
    // np.percentile(a, [25, 50, 75])
    const d = descriptives(A);
    expect(d.n).toBe(10);
    expect(d.mean).toBeCloseTo(23.42, 12);
    expect(d.sd).toBeCloseTo(0.5672545969648704, 12);
    expect(d.sem).toBeCloseTo(0.1793816539609827, 12);
    expect(d.ci[0]).toBeCloseTo(23.01421050662784, 7);
    expect(d.ci[1]).toBeCloseTo(23.825789493372163, 7);
    expect(d.q1).toBeCloseTo(22.95, 12);
    expect(d.median).toBeCloseTo(23.4, 12);
    expect(d.q3).toBeCloseTo(23.875, 12);
    expect(d.iqr).toBeCloseTo(0.9250000000000007, 12);
    expect(d.min).toBe(22.6);
    expect(d.max).toBe(24.2);
    expect(d.conf).toBe(0.95);
  });

  test('keeps full precision for small magnitudes', () => {
    const d = descriptives(TITR);
    expect(d.sd).toBeCloseTo(0.00041686661868969366, 15);
    expect(d.ci[0]).toBeCloseTo(0.10074179158545922, 10);
    expect(d.ci[1]).toBeCloseTo(0.10133820841454076, 10);
    expect(d.q1).toBeCloseTo(0.100825, 15);
    expect(d.q3).toBeCloseTo(0.101275, 15);
  });

  test('interpolates quartiles for n = 6 (type 7)', () => {
    const d = descriptives(U3);
    expect(d.q1).toBeCloseTo(10.850000000000001, 12);
    expect(d.q3).toBeCloseTo(11.35, 12);
    expect(d.ci[0]).toBeCloseTo(10.703644689051707, 7);
    expect(d.ci[1]).toBeCloseTo(11.629688644281625, 7);
  });

  test('a single value has no spread: SD, SEM and CI are NaN, not zero', () => {
    const d = descriptives([4.2]);
    expect(d.n).toBe(1);
    expect(d.mean).toBe(4.2);
    expect(d.median).toBe(4.2);
    expect(Number.isNaN(d.sd)).toBe(true);
    expect(Number.isNaN(d.sem)).toBe(true);
    expect(Number.isNaN(d.ci[0])).toBe(true);
  });

  test('the interval widens with the confidence level', () => {
    const d95 = descriptives(A);
    const d99 = descriptives(A, { conf: 0.99 });
    expect(d99.ci[1] - d99.ci[0]).toBeGreaterThan(d95.ci[1] - d95.ci[0]);
  });

  test('returns null for empty or invalid input', () => {
    expect(descriptives([])).toBeNull();
    expect(descriptives(null)).toBeNull();
  });
});

describe('boxPlotStats', () => {
  test('matches matplotlib.cbook.boxplot_stats(whis=1.5) with two high outliers', () => {
    const b = boxPlotStats(S3);
    expect(b.q1).toBeCloseTo(3.125, 12);
    expect(b.median).toBeCloseTo(3.3499999999999996, 12);
    expect(b.q3).toBeCloseTo(3.75, 12);
    expect(b.whiskerLow).toBe(2.9);
    expect(b.whiskerHigh).toBe(3.8);
    expect(b.outliers).toEqual([9.9, 12.4]);
  });

  test('matches matplotlib with one outlier and a tie at the lower quartile', () => {
    const b = boxPlotStats(S1);
    expect(b.q1).toBeCloseTo(1.2, 12);
    expect(b.median).toBeCloseTo(1.35, 12);
    expect(b.q3).toBeCloseTo(1.5750000000000002, 12);
    expect(b.whiskerLow).toBe(1.1);
    expect(b.whiskerHigh).toBe(2.0);
    expect(b.outliers).toEqual([4.8]);
  });

  test('whiskers reach the extremes when nothing is outlying', () => {
    const b = boxPlotStats(A);
    expect(b.whiskerLow).toBe(22.6);
    expect(b.whiskerHigh).toBe(24.2);
    expect(b.outliers).toEqual([]);
  });

  test('fences sit 1.5 IQR beyond the quartiles, or as asked', () => {
    const b = boxPlotStats(S3, { whisker: 3 });
    expect(b.upperFence).toBeCloseTo(3.75 + 3 * 0.625, 12);
    // 9.9 is beyond 3.75 + 3 * 0.625 = 5.625 still.
    expect(b.outliers).toEqual([9.9, 12.4]);
  });

  test('a constant sample collapses to a line with no outliers', () => {
    const b = boxPlotStats([2, 2, 2, 2]);
    expect(b.iqr).toBe(0);
    expect(b.whiskerLow).toBe(2);
    expect(b.whiskerHigh).toBe(2);
    expect(b.outliers).toEqual([]);
  });

  test('does not reorder its argument and returns null for empty input', () => {
    const input = [3, 1, 2];
    boxPlotStats(input);
    expect(input).toEqual([3, 1, 2]);
    expect(boxPlotStats([])).toBeNull();
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

  test('normal tail keeps its relative accuracy far out', () => {
    // 2 * stats.norm.sf(z), SciPy 1.18.1. jStat's erfc was 1e-5 off at z = 7.
    const ref = [[1, 0.31731050786291415], [3, 0.0026997960632601866], [4.5, 6.795346249460107e-06],
      [5, 5.733031437583866e-07], [6, 1.973175290075389e-09], [7, 2.55962508777167e-12],
      [8, 1.244192114854348e-15], [9.5, 2.098903015072521e-21], [12, 3.552964224155306e-33],
      [20, 5.507248237212311e-89]];
    for (const [z, p] of ref) {
      expect(Math.abs(zTwoSided(z) / p - 1)).toBeLessThan(1e-12);
      expect(zTwoSided(-z)).toBe(zTwoSided(z));
    }
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

  test('chi-squared tail matches scipy chi2.sf on either side of x = df + 2', () => {
    // stats.chi2.sf(x, df). (0.5, 4) takes the 1 - P branch, the rest the
    // continued fraction.
    expect(chiSquaredUpperTail(0.5, 4)).toBeCloseTo(0.9735009788392561, 13);
    expect(chiSquaredUpperTail(3.0, 1)).toBeCloseTo(0.08326451666355042, 13);
    expect(chiSquaredUpperTail(7.8147279032511765, 3)).toBeCloseTo(0.05, 13);
    expect(chiSquaredUpperTail(44.0, 3) / 1.5091823835869955e-09).toBeCloseTo(1, 12);
  });

  test('chi-squared tail keeps relative precision where 1 - cdf would give 0', () => {
    // stats.chi2.sf(100, 5), stats.chi2.sf(60, 1), stats.chi2.sf(500, 7).
    // The previous 1 - lowRegGamma form gave the 5e-324 floor for the first
    // and third, and 9.437e-15 for the second, 0.5% low.
    expect(chiSquaredUpperTail(100, 5) / 5.285148360943219e-20).toBeCloseTo(1, 11);
    expect(chiSquaredUpperTail(60, 1) / 9.485737571073857e-15).toBeCloseTo(1, 11);
    expect(chiSquaredUpperTail(500, 7) / 8.0167910013494e-104).toBeCloseTo(1, 10);
  });

  test('a tail that underflows even so is floored above zero', () => {
    expect(chiSquaredUpperTail(5000, 3)).toBe(Number.MIN_VALUE);
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

describe('oneSampleTTest', () => {
  test('t, df and p match scipy ttest_1samp', () => {
    // stats.ttest_1samp(TITR, 0.1)
    const r = oneSampleTTest(TITR, 0.1);
    expect(r.t).toBeCloseTo(7.889259103816982, 8);
    expect(r.df).toBe(9);
    expect(r.p).toBeCloseTo(2.473809945507378e-05, 12);
    expect(r.n).toBe(10);
  });

  test('the interval of the mean matches ttest_1samp(...).confidence_interval()', () => {
    const r = oneSampleTTest(TITR, 0.1);
    expect(r.ci[0]).toBeCloseTo(0.10074179158545922, 10);
    expect(r.ci[1]).toBeCloseTo(0.10133820841454076, 10);
    // The interval of the difference is the same interval shifted by mu0.
    expect(r.ciDiff[0]).toBeCloseTo(r.ci[0] - 0.1, 14);
    expect(r.ciDiff[1]).toBeCloseTo(r.ci[1] - 0.1, 14);
  });

  test('matches scipy for a p-value near .05 and reports d', () => {
    // stats.ttest_1samp(A, 23.0); d = (mean - mu0) / std(ddof=1)
    const r = oneSampleTTest(A, 23.0);
    expect(r.t).toBeCloseTo(2.341376560678585, 10);
    // jStat's incomplete beta agrees with SciPy to about 2e-10 here, as in
    // the paired test above; eight places is the honest tolerance.
    expect(r.p).toBeCloseTo(0.04392113865543809, 8);
    expect(r.d).toBeCloseTo(0.7404082791875761, 10);
    expect(r.meanDiff).toBeCloseTo(0.42, 12);
  });

  test('a mean equal to mu0 gives t = 0 and p = 1', () => {
    const r = oneSampleTTest(A, 23.42);
    expect(r.t).toBeCloseTo(0, 10);
    expect(r.p).toBeCloseTo(1, 10);
  });

  test('defaults mu0 to zero', () => {
    expect(oneSampleTTest([1, 2, 3]).mu0).toBe(0);
  });

  test('a constant sample yields NaN rather than an infinite t', () => {
    const r = oneSampleTTest([5, 5, 5], 4);
    expect(Number.isNaN(r.t)).toBe(true);
    expect(r.meanDiff).toBe(1);
  });

  test('returns null with fewer than two values or a non-finite mu0', () => {
    expect(oneSampleTTest([1], 0)).toBeNull();
    expect(oneSampleTTest([1, 2, 3], NaN)).toBeNull();
    expect(oneSampleTTest(null, 0)).toBeNull();
  });
});

describe('oneSampleWilcoxon', () => {
  test('W and p match scipy wilcoxon on x - mu0', () => {
    // stats.wilcoxon(TITR - 0.1) (SciPy 1.18.1): ten distinct, non-zero
    // differences, so SciPy's default is the exact test, 2 * 1 / 2**10.
    const r = oneSampleWilcoxon(TITR, 0.1);
    expect(r.W).toBe(0);
    expect(r.method).toBe('exact');
    expect(r.p).toBe(0.001953125);
    expect(r.wPositive).toBe(55);
    expect(r.mu0).toBe(0.1);
    expect(r.median).toBeCloseTo(0.10105, 14);
    // z is still reported, for the effect size: method='asymptotic' gives the same.
    expect(r.z).toBeCloseTo(-2.8030595529069404, 12);
  });

  test('drops values equal to mu0', () => {
    const r = oneSampleWilcoxon([1, 2, 3, 4, 5], 3);
    expect(r.nDropped).toBe(1);
    expect(r.n).toBe(4);
  });

  test('returns null when every value equals mu0 or input is invalid', () => {
    expect(oneSampleWilcoxon([2, 2, 2], 2)).toBeNull();
    expect(oneSampleWilcoxon([1, 2], NaN)).toBeNull();
    expect(oneSampleWilcoxon(null)).toBeNull();
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

describe('welchAnova', () => {
  test('F, df and p match statsmodels anova_oneway(use_var="unequal")', () => {
    // anova_oneway([U1, U2, U3], use_var='unequal', welch_correction=True);
    // the same F and df by hand, and p = stats.f.sf(F, 2, df2).
    const r = welchAnova([U1, U2, U3]);
    expect(r.F).toBeCloseTo(8.670827891642329, 10);
    expect(r.df1).toBe(2);
    expect(r.df2).toBeCloseTo(12.349506180261182, 10);
    expect(r.p).toBeCloseTo(0.0044417833655213245, 10);
  });

  test('matches statsmodels for equal sizes and a strong effect', () => {
    const r = welchAnova([PLACEBO, LOWDOSE, HIGHDOSE]);
    expect(r.F).toBeCloseTo(346.97706866003296, 8);
    expect(r.df2).toBeCloseTo(13.817740426947656, 10);
    expect(r.p / 1.547349706525509e-12).toBeCloseTo(1, 6);
  });

  test("for two groups F is Welch's t squared on the Welch-Satterthwaite df", () => {
    const w = welchAnova([A, B]);
    const t = independentTTest(A, B);
    expect(w.F).toBeCloseTo(t.t * t.t, 8);
    expect(w.df2).toBeCloseTo(t.df, 10);
    expect(w.p).toBeCloseTo(t.p, 15);
  });

  test('reports the ordinary eta squared, the same as the classic ANOVA', () => {
    const w = welchAnova([U1, U2, U3]);
    expect(w.etaSquared).toBeCloseTo(oneWayAnova([U1, U2, U3]).etaSquared, 12);
  });

  test('a noisy group no longer hides a difference between two precise ones', () => {
    // The classic F pools the noisy group's variance into every comparison:
    // stats.f_oneway -> p = 0.364397295357027, while
    // anova_oneway(use_var='unequal') -> p = 0.003285465665046123.
    const noisy = [3, 18, 7, 25];
    const tight = [10.1, 10.3, 9.9, 10.0, 10.2, 10.1, 9.8, 10.0, 10.2, 9.9];
    const tight2 = tight.map(x => x + 0.4);
    expect(oneWayAnova([noisy, tight, tight2]).p).toBeCloseTo(0.364397295357027, 8);
    expect(welchAnova([noisy, tight, tight2]).p).toBeCloseTo(0.003285465665046123, 8);
  });

  test('is undefined with a zero-variance group, and says why', () => {
    const r = welchAnova([[5, 5, 5], [1, 2, 3], [4, 6, 8]]);
    expect(Number.isNaN(r.F)).toBe(true);
    expect(r.note).toContain('zero variance');
  });

  test('returns null for degenerate designs', () => {
    expect(welchAnova([[1, 2, 3]])).toBeNull();
    expect(welchAnova([[1], [2, 3]])).toBeNull();
    expect(welchAnova(null)).toBeNull();
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

describe('spearmanCorrelation', () => {
  test('rho and p match scipy spearmanr with ties in y', () => {
    // stats.spearmanr(X1, X2); X2 holds two tied pairs.
    const r = spearmanCorrelation(X1, X2);
    expect(r.rho).toBeCloseTo(0.6470816712483338, 12);
    expect(r.p).toBeCloseTo(0.059592213885008516, 8);
    expect(r.df).toBe(7);
    expect(r.ties).toBe(true);
  });

  test('matches scipy with ties in both variables', () => {
    // stats.spearmanr([1,2,2,3,4,5,5,5,6,7], [2.0,1.5,3.1,2.9,4.0,4.4,3.8,5.0,4.9,6.2])
    const x = [1, 2, 2, 3, 4, 5, 5, 5, 6, 7];
    const y = [2.0, 1.5, 3.1, 2.9, 4.0, 4.4, 3.8, 5.0, 4.9, 6.2];
    const r = spearmanCorrelation(x, y);
    expect(r.rho).toBeCloseTo(0.8985678841491289, 12);
    expect(r.p).toBeCloseTo(0.00040908483359797026, 10);
  });

  test('the interval is Fisher z with the Bonett-Wright variance', () => {
    // np.tanh(np.arctanh(rho) -/+ stats.norm.ppf(0.975) * np.sqrt((1 + rho**2/2) / (n - 3)))
    const r = spearmanCorrelation(X1, X2);
    expect(r.ci[0]).toBeCloseTo(-0.10923394836907992, 9);
    expect(r.ci[1]).toBeCloseTo(0.9288844022679728, 9);
    const r99 = spearmanCorrelation(X1, X2, { conf: 0.99 });
    expect(r99.ci[0]).toBeCloseTo(-0.3680508360136536, 9);
    expect(r99.ci[1]).toBeCloseTo(0.9584650312064131, 9);
  });

  test('a monotone but non-linear relationship gives rho = 1 where Pearson does not', () => {
    // stats.spearmanr -> 1.0, stats.pearsonr -> 0.7376908727427494
    const sx = [0.5, 1, 2, 3, 4, 6, 8, 10, 15, 20, 30, 40];
    const sy = [0.9, 1.7, 2.9, 3.6, 4.3, 5.0, 5.4, 5.6, 6.0, 6.1, 6.25, 6.3];
    const r = spearmanCorrelation(sx, sy);
    expect(r.rho).toBeCloseTo(1, 12);
    expect(r.p).toBeLessThan(1e-12);
    expect(pearsonCorrelation(sx, sy).r).toBeCloseTo(0.7376908727427494, 12);
  });

  test('is invariant to a monotone transform of either variable', () => {
    const a = spearmanCorrelation(X1, X2);
    const b = spearmanCorrelation(X1.map(Math.exp), X2.map(v => v * v * v));
    expect(b.rho).toBeCloseTo(a.rho, 12);
  });

  test('a perfectly reversed order gives rho = -1', () => {
    expect(spearmanCorrelation([1, 2, 3, 4, 5], [5, 4, 3, 2, 1]).rho).toBeCloseTo(-1, 12);
  });

  test('has no interval at n = 3 and is NaN for a constant variable', () => {
    const r3 = spearmanCorrelation([1, 2, 3], [1, 3, 2]);
    expect(r3.rho).toBeCloseTo(0.5, 12);
    expect(Number.isNaN(r3.ci[0])).toBe(true);
    expect(Number.isNaN(spearmanCorrelation([1, 1, 1, 1], [1, 2, 3, 4]).rho)).toBe(true);
  });

  test('returns null with fewer than three pairs', () => {
    expect(spearmanCorrelation([1, 2], [2, 1])).toBeNull();
  });
});

describe('leastSquaresLine', () => {
  const sx = [0.5, 1, 2, 3, 4, 6, 8, 10, 15, 20, 30, 40];
  const sy = [0.9, 1.7, 2.9, 3.6, 4.3, 5.0, 5.4, 5.6, 6.0, 6.1, 6.25, 6.3];

  test('slope and intercept match scipy.stats.linregress', () => {
    const l = leastSquaresLine(sx, sy);
    expect(l.slope).toBeCloseTo(0.1086310704113639, 12);
    expect(l.intercept).toBeCloseTo(3.2413304731345614, 12);
    expect(l.n).toBe(12);
  });

  test('recovers an exact line', () => {
    const l = leastSquaresLine([1, 2, 3, 4], [5, 7, 9, 11]);
    expect(l.slope).toBeCloseTo(2, 12);
    expect(l.intercept).toBeCloseTo(3, 12);
  });

  test('is undefined for a constant x and null for fewer than two pairs', () => {
    expect(Number.isNaN(leastSquaresLine([2, 2, 2], [1, 2, 3]).slope)).toBe(true);
    expect(leastSquaresLine([1], [2])).toBeNull();
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

  test('separated triplicates are not significant: the exact p is 0.1', () => {
    // The normal approximation gave 0.0495 here. stats.mannwhitneyu([1, 2, 3],
    // [4, 5, 6]) is exact by default: 2 of the 20 splits are this extreme.
    const r = mannWhitneyU([1, 2, 3], [4, 5, 6]);
    expect(r.method).toBe('exact');
    expect(r.p).toBeCloseTo(0.1, 15);
    expect(r.z).toBeCloseTo(-1.9639610121239315, 12);
    expect(mannWhitneyU([4, 5, 6], [1, 2, 3]).p).toBeCloseTo(0.1, 15);
  });

  test('chooses the method as SciPy does: exact without ties while a group has 8 or fewer', () => {
    const seq = (n, from) => Array.from({ length: n }, (_, i) => from + i);
    expect(mannWhitneyU(seq(8, 0), seq(200, 0.5)).method).toBe('exact');
    expect(mannWhitneyU(seq(200, 0.5), seq(8, 0)).method).toBe('exact');
    expect(mannWhitneyU(seq(9, 0), seq(9, 0.5)).method).toBe('asymptotic');
    expect(mannWhitneyU([1, 2, 3], [3, 4, 5]).method).toBe('asymptotic');
  });

  test('the exact p is the share of splits at least as extreme', () => {
    // Sizes 3 and 3: 20 equally likely splits, with U = 0, 1, 2 for 1, 1, 2 of them.
    expect(mannWhitneyU([1, 2, 4], [3, 5, 6]).p).toBeCloseTo((2 * 2) / 20, 15);
    expect(mannWhitneyU([1, 3, 4], [2, 5, 6]).p).toBeCloseTo((2 * 4) / 20, 15);
    // One against one: U = 0 or 1, each half the time, so p is capped at 1.
    expect(mannWhitneyU([1], [2]).p).toBe(1);
    // Five against 200, U = 0: the one most extreme split of C(205, 5), twice.
    const r = mannWhitneyU([1, 2, 3, 4, 5], Array.from({ length: 200 }, (_, i) => 10 + i));
    expect(r.p / (2 / 2872408791)).toBeCloseTo(1, 13);
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

describe('kruskalWallis', () => {
  test('H and p match scipy kruskal for three well-separated groups', () => {
    // stats.kruskal(PLACEBO, LOWDOSE, HIGHDOSE); no value repeats, so C = 1.
    const r = kruskalWallis([PLACEBO, LOWDOSE, HIGHDOSE]);
    expect(r.H).toBeCloseTo(20.480000000000004, 10);
    expect(r.df).toBe(2);
    expect(r.p).toBeCloseTo(3.571284964163516e-05, 14);
    expect(r.meanRanks).toEqual([4.5, 12.5, 20.5]);
  });

  test('applies the tie correction, matching scipy on skewed data with ties', () => {
    // stats.kruskal(S1, S2, S3): 1.2 appears three times, 1.9 and 2.1 twice.
    const r = kruskalWallis([S1, S2, S3]);
    expect(r.tieCorrection).toBeLessThan(1);
    expect(r.H).toBeCloseTo(17.509202317290555, 10);
    expect(r.p).toBeCloseTo(0.0001577338942155893, 13);
    // H / (N - 1)
    expect(r.epsilonSquared).toBeCloseTo(0.6037655971479502, 10);
  });

  test('handles unequal group sizes', () => {
    // stats.kruskal(U1, U2, U3)
    const r = kruskalWallis([U1, U2, U3]);
    expect(r.H).toBeCloseTo(8.548089591567845, 10);
    expect(r.p).toBeCloseTo(0.013925343915331161, 12);
    expect(r.N).toBe(22);
    expect(r.groupNs).toEqual([7, 9, 6]);
  });

  test('four groups use the chi-squared tail on 3 df', () => {
    // stats.kruskal(PLACEBO, LOWDOSE, HIGHDOSE, HIGHDOSE + 5)
    const r = kruskalWallis([PLACEBO, LOWDOSE, HIGHDOSE, HIGHDOSE.map(x => x + 5)]);
    expect(r.H).toBeCloseTo(29.090909090909093, 10);
    expect(r.df).toBe(3);
    expect(r.p / 2.1430569913908513e-06).toBeCloseTo(1, 10);
  });

  test('agrees with the Mann-Whitney z for two groups', () => {
    // For k = 2, H is the square of the tie-corrected Mann-Whitney z.
    const kw = kruskalWallis([S1, S2]);
    const mw = mannWhitneyU(S1, S2);
    expect(kw.H).toBeCloseTo(mw.z * mw.z, 10);
    expect(kw.p).toBeCloseTo(mw.p, 10);
  });

  test('identical groups give H = 0 and p = 1', () => {
    const r = kruskalWallis([[1, 2, 3], [1, 2, 3], [1, 2, 3]]);
    expect(r.H).toBeCloseTo(0, 12);
    expect(r.p).toBeCloseTo(1, 12);
  });

  test('is undefined when every observation is equal', () => {
    const r = kruskalWallis([[4, 4], [4, 4, 4]]);
    expect(Number.isNaN(r.H)).toBe(true);
    expect(Number.isNaN(r.p)).toBe(true);
  });

  test('returns null for fewer than two groups or an empty group', () => {
    expect(kruskalWallis([[1, 2, 3]])).toBeNull();
    expect(kruskalWallis([[1, 2], []])).toBeNull();
    expect(kruskalWallis(null)).toBeNull();
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

  test('five pairs all one way are not significant: the exact p is 0.0625', () => {
    // The normal approximation gave 0.043 here; stats.wilcoxon is exact by
    // default: 2 of the 32 sign patterns are this extreme.
    const r = wilcoxonSignedRank([1, 2, 3, 4, 5], [2, 4, 6, 8, 10]);
    expect(r.method).toBe('exact');
    expect(r.p).toBe(0.0625);
    expect(r.W).toBe(0);
  });

  test('chooses the method as SciPy does, counting zero differences', () => {
    const seq = (n) => Array.from({ length: n }, (_, i) => i + 1);
    const zeros = (n) => new Array(n).fill(0);
    expect(wilcoxonSignedRank(seq(50), zeros(50)).method).toBe('exact');
    expect(wilcoxonSignedRank(seq(51), zeros(51)).method).toBe('asymptotic');
    const tied = (n) => seq(n).map((v) => Math.ceil(v / 2));
    expect(wilcoxonSignedRank(tied(13), zeros(13)).method).toBe('permutation');
    expect(wilcoxonSignedRank(tied(14), zeros(14)).method).toBe('asymptotic');
    // Twelve non-zero differences and one zero: 13 pairs, so still counted.
    expect(wilcoxonSignedRank([...seq(12), 0], zeros(13)).method).toBe('permutation');
    expect(wilcoxonSignedRank([...seq(13), 0], zeros(14)).method).toBe('asymptotic');
  });

  test('ties go into the variance of the normal approximation', () => {
    // stats.wilcoxon(d, method='asymptotic') for 20 differences in tied pairs:
    // Σ(t³ − t) = 10 · 6 = 60, so σ² = 20·21·41/24 − 60/48 = 716.25.
    const d = Array.from({ length: 20 }, (_, i) => (i % 3 === 0 ? -1 : 1) * Math.ceil((i + 1) / 2));
    const r = wilcoxonSignedRank(d, new Array(20).fill(0));
    expect(r.method).toBe('asymptotic');
    expect(r.tieCorrected).toBe(true);
    expect(r.z).toBeCloseTo((r.W - 105) / Math.sqrt(716.25), 14);
  });
});

describe('qUpperTail', () => {
  test('matches scipy studentized_range.sf to 1e-9', () => {
    // stats.studentized_range.sf(q, k, df)
    expect(qUpperTail(3.5, 3, 21)).toBeCloseTo(0.05489508733888482, 9);
    expect(qUpperTail(5.0, 4, 30)).toBeCloseTo(0.006966833686719909, 9);
    expect(qUpperTail(2.0, 5, 10)).toBeCloseTo(0.6330822625273638, 9);
    expect(qUpperTail(4.2, 6, 57)).toBeCloseTo(0.047424360502407836, 9);
  });

  test('is 1 at zero and NaN for invalid parameters', () => {
    expect(qUpperTail(0, 3, 10)).toBe(1);
    expect(Number.isNaN(qUpperTail(3, 1, 10))).toBe(true);
    expect(Number.isNaN(qUpperTail(3, 3, 0))).toBe(true);
    expect(Number.isNaN(qUpperTail(NaN, 3, 10))).toBe(true);
  });
});

describe('adjustPValues', () => {
  const P = [0.01, 0.04, 0.03, 0.005, 0.2];

  test('Holm matches statsmodels multipletests(method="holm")', () => {
    const adj = adjustPValues(P, 'holm');
    [0.04, 0.09, 0.09, 0.025, 0.2].forEach((v, i) => expect(adj[i]).toBeCloseTo(v, 14));
  });

  test('defaults to Holm, which is never larger than Bonferroni', () => {
    const holm = adjustPValues(P);
    const bonf = adjustPValues(P, 'bonferroni');
    expect(bonf).toEqual([0.05, 0.2, 0.15, 0.025, 1]);
    holm.forEach((p, i) => expect(p).toBeLessThanOrEqual(bonf[i] + 1e-15));
  });

  test('keeps NaN out of the family and in place', () => {
    const adj = adjustPValues([0.01, NaN, 0.02]);
    expect(adj[0]).toBeCloseTo(0.02, 14);
    expect(Number.isNaN(adj[1])).toBe(true);
    expect(adj[2]).toBeCloseTo(0.02, 14);
  });

  test("'none' leaves them alone and an unknown method throws", () => {
    expect(adjustPValues(P, 'none')).toEqual(P);
    expect(() => adjustPValues(P, 'sidak')).toThrow('unknown method');
  });
});

describe('tukeyHSD', () => {
  test('differences, p and intervals match scipy tukey_hsd for equal n', () => {
    // res = stats.tukey_hsd(PLACEBO, LOWDOSE, HIGHDOSE); res.confidence_interval(0.95)
    const r = tukeyHSD([PLACEBO, LOWDOSE, HIGHDOSE]);
    expect(r.comparisons.map(c => [c.i, c.j])).toEqual([[0, 1], [0, 2], [1, 2]]);
    const [c01, c02, c12] = r.comparisons;
    expect(c01.diff).toBeCloseTo(-1.7874999999999996, 12);
    expect(c01.pAdjusted).toBeCloseTo(7.906864052387164e-11, 9);
    expect(c01.ci[0]).toBeCloseTo(-2.143298799419772, 6);
    expect(c01.ci[1]).toBeCloseTo(-1.4317012005802274, 6);
    // SciPy's own tail underflows to 0 here; both are far below any threshold.
    expect(c02.pAdjusted).toBeLessThan(1e-9);
    expect(c02.ci[0]).toBeCloseTo(-4.23079879941977, 6);
    expect(c12.diff).toBeCloseTo(-2.0874999999999986, 12);
    expect(c12.ci[1]).toBeCloseTo(-1.7317012005802264, 6);
  });

  test('uses the Tukey-Kramer standard error for unequal n', () => {
    // res = stats.tukey_hsd(U1, U2, U3)
    const [c01, c02, c12] = tukeyHSD([U1, U2, U3]).comparisons;
    expect(c01.diff).toBeCloseTo(-2.582539682539684, 12);
    expect(c01.pAdjusted).toBeCloseTo(0.0054307191349254325, 9);
    expect(c01.ci[0]).toBeCloseTo(-4.416226009440969, 6);
    expect(c01.ci[1]).toBeCloseTo(-0.7488533556383996, 6);
    expect(c02.pAdjusted).toBeCloseTo(0.6307888690029692, 9);
    expect(c02.ci[0]).toBeCloseTo(-2.762430130976139, 6);
    expect(c02.ci[1]).toBeCloseTo(1.2862396547856645, 6);
    expect(c12.diff).toBeCloseTo(1.8444444444444468, 12);
    expect(c12.pAdjusted).toBeCloseTo(0.06066040199718725, 9);
    expect(c12.ci[0]).toBeCloseTo(-0.07327061920605371, 6);
    expect(c12.ci[1]).toBeCloseTo(3.762159508094947, 6);
  });

  test('uses the ANOVA error term and df', () => {
    const r = tukeyHSD([U1, U2, U3]);
    const a = oneWayAnova([U1, U2, U3]);
    expect(r.df).toBe(a.dfWithin);
    expect(r.msWithin).toBeCloseTo(a.msWithin, 14);
    // stats.studentized_range.ppf(0.95, 3, 19); jStat's inverse is good to
    // about 1e-7, which moves an interval end by less than 1e-6 here.
    expect(r.qCrit).toBeCloseTo(3.5927389736224056, 6);
  });

  test('an interval excludes zero exactly when the pair is significant', () => {
    for (const c of tukeyHSD([U1, U2, U3]).comparisons) {
      const excludesZero = c.ci[0] > 0 || c.ci[1] < 0;
      expect(excludesZero).toBe(c.pAdjusted < 0.05);
    }
  });

  test('returns null when the ANOVA would', () => {
    expect(tukeyHSD([[1, 2, 3]])).toBeNull();
    expect(tukeyHSD([[1], [2, 3]])).toBeNull();
  });
});

describe('gamesHowell', () => {
  test('matches the Games-Howell formula with scipy studentized_range', () => {
    // t = diff / sqrt(va/na + vb/nb); df Welch; p = studentized_range.sf(|t|*sqrt(2), 3, df);
    // CI = diff -/+ studentized_range.ppf(0.95, 3, df) / sqrt(2) * se
    const [c01, c02, c12] = gamesHowell([U1, U2, U3]).comparisons;
    expect(c01.diff).toBeCloseTo(-2.582539682539684, 12);
    expect(c01.df).toBeCloseTo(8.907903195372821, 10);
    expect(c01.t).toBeCloseTo(-3.5141741226315912, 10);
    expect(c01.pAdjusted).toBeCloseTo(0.01656383555773855, 9);
    expect(c01.ci[0]).toBeCloseTo(-4.638276603366926, 6);
    expect(c01.ci[1]).toBeCloseTo(-0.526802761712442, 6);
    expect(c02.df).toBeCloseTo(10.785787067301756, 10);
    expect(c02.pAdjusted).toBeCloseTo(0.032192502605808526, 9);
    expect(c02.ci[0]).toBeCloseTo(-1.4116711225161764, 6);
    expect(c02.ci[1]).toBeCloseTo(-0.06451935367429817, 6);
    expect(c12.t).toBeCloseTo(2.5027432497635123, 10);
    expect(c12.pAdjusted).toBeCloseTo(0.07844328001636203, 9);
    expect(c12.ci[0]).toBeCloseTo(-0.21356790293536632, 6);
    expect(c12.ci[1]).toBeCloseTo(3.90245679182426, 6);
  });

  test('finds the U1-U3 difference that the pooled Tukey test misses', () => {
    // Tukey pools U2's large variance into the U1-U3 comparison (p = .63);
    // Games-Howell does not (p = .032).
    const gh = gamesHowell([U1, U2, U3]).comparisons[1];
    const tk = tukeyHSD([U1, U2, U3]).comparisons[1];
    expect(gh.pAdjusted).toBeLessThan(0.05);
    expect(tk.pAdjusted).toBeGreaterThan(0.5);
  });

  test('gives NaN for a pair with no spread, and null for degenerate input', () => {
    const r = gamesHowell([[1, 1, 1], [1, 1, 1], [2, 3, 4]]);
    expect(Number.isNaN(r.comparisons[0].pAdjusted)).toBe(true);
    expect(Number.isFinite(r.comparisons[1].pAdjusted)).toBe(true);
    expect(gamesHowell([[1, 2]])).toBeNull();
    expect(gamesHowell([[1], [2, 3]])).toBeNull();
  });
});

describe('dunnTest', () => {
  test('z, p and Holm-adjusted p match the formula on skewed, tied data', () => {
    // Joint ranks from stats.rankdata; sigma with the tie term; p = 2*norm.sf(|z|);
    // multipletests(p, method='holm')
    const r = dunnTest([S1, S2, S3]);
    expect(r.meanRanks[0]).toBeCloseTo(7.45, 12);
    expect(r.meanRanks[1]).toBeCloseTo(15.15, 12);
    expect(r.meanRanks[2]).toBeCloseTo(23.9, 12);
    const [c01, c02, c12] = r.comparisons;
    expect(c01.meanRankDiff).toBeCloseTo(-7.7, 12);
    expect(c01.z).toBeCloseTo(-1.9573266081521479, 12);
    expect(c01.p).toBeCloseTo(0.050309081093342825, 12);
    expect(c01.pAdjusted).toBeCloseTo(0.05226530406164814, 12);
    expect(c02.z).toBeCloseTo(-4.181561390143225, 12);
    expect(c02.p).toBeCloseTo(2.8951405676544472e-05, 15);
    expect(c02.pAdjusted).toBeCloseTo(8.685421702963342e-05, 15);
    expect(c12.z).toBeCloseTo(-2.224234781991077, 12);
    expect(c12.pAdjusted).toBeCloseTo(0.05226530406164814, 12);
  });

  test('matches the formula without ties, where equal gaps give equal p', () => {
    const [c01, c02, c12] = dunnTest([PLACEBO, LOWDOSE, HIGHDOSE]).comparisons;
    expect(c01.z).toBeCloseTo(-2.262741699796952, 12);
    expect(c01.pAdjusted).toBeCloseTo(0.047303233310711956, 12);
    expect(c02.pAdjusted).toBeCloseTo(1.8077283455286244e-05, 15);
    expect(c12.pAdjusted).toBeCloseTo(c01.pAdjusted, 15);
  });

  test('can use Bonferroni or no adjustment', () => {
    const none = dunnTest([S1, S2, S3], { adjust: 'none' }).comparisons;
    const bonf = dunnTest([S1, S2, S3], { adjust: 'bonferroni' }).comparisons;
    expect(none[0].pAdjusted).toBe(none[0].p);
    expect(bonf[0].pAdjusted).toBeCloseTo(Math.min(1, 3 * none[0].p), 14);
  });

  test('returns null when Kruskal-Wallis would', () => {
    expect(dunnTest([[1, 2, 3]])).toBeNull();
  });
});

describe('assumption checks', () => {
  test("D'Agostino K-squared matches scipy normaltest", () => {
    const r = dagostinoNormality(A);
    // Full double precision. An earlier version fed the sample-size-adjusted
    // G1 into the skewness transform, which disagreed with scipy in the fourth
    // decimal; the tolerance had been loosened to 3 places and the residual
    // blamed on scipy. The reference value was right, the implementation was
    // not. Do not loosen this again.
    expect(r.K2).toBeCloseTo(1.9719420051794323, 12);
    expect(r.p).toBeCloseTo(0.3730767924710829, 12);
    expect(r.ok).toBe(true);
  });

  test('K-squared uses the biased moment ratio, not adjusted G1', () => {
    // n = 10 is where the two conventions diverge most sharply: passing G1
    // here gives K2 = 0.4521 against scipy's 0.3724, a 21% error.
    const r = dagostinoNormality([2, 4, 4, 5, 7, 9, 3, 8, 6, 5]);
    expect(r.K2).toBeCloseTo(0.37244118363359957, 12);
    expect(r.p).toBeCloseTo(0.8300904636205573, 12);
  });

  test('skewness still reports adjusted G1, matching scipy bias=false', () => {
    // The public statistic and the transform input are deliberately different.
    expect(skewness([2, 4, 4, 5, 7, 9, 3, 8, 6, 5]))
      .toBeCloseTo(0.29502298870375565, 12);
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

describe('recommendTest', () => {
  // The decisions rest on dagostinoNormality and leveneTest, which match
  // stats.normaltest and stats.levene(center='median'); the p-values quoted
  // below are SciPy's.

  test("two normal groups: Welch's t, whatever Levene says", () => {
    // normaltest p: A .373, B .661; levene p = .247
    const r = recommendTest({ design: 'independent', groups: [A, B], names: ['Control', 'Treated'] });
    expect(r.test).toBe('welch-t');
    expect(r.reason).toBe("Control and Treated look normal (D'Agostino p = .373, p = .661); " +
      "Welch's t is the safe default whether or not the variances match.");
    expect(r.levene.p).toBeCloseTo(0.24689534322848375, 6);
  });

  test('two groups, one skewed: Mann-Whitney, naming the group', () => {
    // normaltest p: S1 4.8e-6, S2 1.2e-6
    const r = recommendTest({ design: 'independent', groups: [S1, S2], names: ['X', 'Y'] });
    expect(r.test).toBe('mann-whitney');
    expect(r.reason).toBe("X and Y depart from normality (D'Agostino p < .001, p < .001), " +
      'so a rank-based test is safer.');
  });

  test('three normal groups with similar spread: one-way ANOVA', () => {
    // normaltest p .712, .875, .556; levene p = .513
    const r = recommendTest({ design: 'independent', groups: [PLACEBO, LOWDOSE, HIGHDOSE] });
    expect(r.test).toBe('anova');
    expect(r.reason).toContain('Group 1, Group 2 and Group 3 look normal');
    expect(r.reason).toContain('the variances are similar (Levene p = .513)');
  });

  test("unequal spreads: Welch's ANOVA, and says which groups were too small to check", () => {
    // levene p = .0051; U2 normaltest p = .848; U1 (n = 7) and U3 (n = 6) untestable
    const r = recommendTest({ design: 'independent', groups: [U1, U2, U3], names: ['U1', 'U2', 'U3'] });
    expect(r.test).toBe('welch-anova');
    expect(r.reason).toBe("U2 looks normal (D'Agostino p = .848); U1 and U3 have too few " +
      "values to check (under 8); the variances differ (Levene p = .005), which Welch's ANOVA allows for.");
  });

  test('three skewed groups: Kruskal-Wallis', () => {
    // normaltest p: S3 .0097
    expect(recommendTest({ design: 'independent', groups: [S1, S2, S3] }).test).toBe('kruskal-wallis');
  });

  test('paired: t when the differences look normal, Wilcoxon when not', () => {
    // normaltest(X1 - X2) p = .608; normaltest(S2 - S1) p = .0039
    const t = recommendTest({ design: 'paired', groups: [X1, X2] });
    expect(t.test).toBe('paired-t');
    expect(t.reason).toBe("The paired differences look normal (D'Agostino p = .608).");
    const w = recommendTest({ design: 'paired', groups: [S2, S1] });
    expect(w.test).toBe('wilcoxon');
    expect(w.reason).toContain('The paired differences depart from normality (D\'Agostino p = .004)');
  });

  test('one sample: t for normal replicates, the signed-rank test for skewed ones', () => {
    // normaltest p: TITR .955, S1 4.8e-6
    expect(recommendTest({ design: 'one-sample', groups: [TITR] }).test).toBe('one-sample-t');
    expect(recommendTest({ design: 'one-sample', groups: [S1] }).test).toBe('one-sample-wilcoxon');
  });

  test('association: Pearson for normal variables, Spearman for a skewed one', () => {
    const x = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const y = [2.1, 3.9, 6.2, 7.8, 10.1, 12.2, 13.8, 16.1, 18.0, 20.2];
    // normaltest p: x .363, y .625; conc .00078
    expect(recommendTest({ design: 'association', groups: [x, y] }).test).toBe('pearson');
    const conc = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100];
    const resp = [0.4, 0.9, 1.9, 3.1, 4.6, 6.5, 7.6, 8.4, 9.0, 9.3];
    const r = recommendTest({ design: 'association', groups: [conc, resp], names: ['Dose', 'Response'] });
    expect(r.test).toBe('spearman');
    expect(r.reason).toBe("Dose departs from normality (D'Agostino p < .001), so a rank correlation is safer.");
  });

  test('too small to test anything: says so rather than calling the data normal', () => {
    const r = recommendTest({ design: 'independent', groups: [[1, 2, 3], [2, 3, 5]] });
    expect(r.test).toBe('welch-t');
    expect(r.reason).toMatch(/^There are too few values to check normality/);
    expect(r.reason).not.toContain('look normal');
  });

  test('returns the checks it based the advice on', () => {
    const r = recommendTest({ design: 'independent', groups: [A, B] });
    expect(r.normality.map(x => x.n)).toEqual([10, 10]);
    expect(r.normality[0].p).toBeCloseTo(0.3730767924710829, 12);
  });

  test('returns null for an unknown design or unusable samples', () => {
    expect(recommendTest({ design: 'cohort', groups: [A, B] })).toBeNull();
    expect(recommendTest({ design: 'independent', groups: [A] })).toBeNull();
    expect(recommendTest({ design: 'paired', groups: [A, B, X1] })).toBeNull();
    expect(recommendTest({ design: 'one-sample', groups: [[1]] })).toBeNull();
    expect(recommendTest()).toBeNull();
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

/* ------------------------------------------------------------------ *
 * The rank tests' p-values against SciPy's defaults
 * ------------------------------------------------------------------ */

/*
 * Rank-test references computed with SciPy 1.18.1, with its default
 * method='auto': scipy.stats.mannwhitneyu(x, y, use_continuity=False) and
 * scipy.stats.wilcoxon(x - y), or x - mu0. `method` is the one SciPy chose,
 * checked by asking for it explicitly and getting the same p.
 */
const RANK_REFERENCE = {
  mannWhitney: [
    {
      name: 'separated triplicates', method: 'exact', U1: 0, p: 0.1,
      x: [1, 2, 3],
      y: [4, 5, 6]
    },
    {
      name: "SciPy's docstring example", method: 'exact', U1: 17, p: 0.1111111111111111,
      x: [19, 22, 16, 29, 24],
      y: [20, 11, 17, 12]
    },
    {
      name: 'one value each', method: 'exact', U1: 0, p: 1,
      x: [1],
      y: [2]
    },
    {
      name: '2 against 5, separated', method: 'exact', U1: 0, p: 0.09523809523809523,
      x: [1, 2],
      y: [3, 4, 5, 6, 7]
    },
    {
      name: 'U at its mean', method: 'exact', U1: 8, p: 1,
      x: [1, 4, 5, 8],
      y: [2, 3, 6, 7]
    },
    {
      name: '8 against 9', method: 'exact', U1: 32, p: 0.7429864253393665,
      x: [1.1, 5.1, 3.6, 5.9, -1.9, 0.9, 0.4, 4.3],
      y: [-1, -3, 3.2, 2.2, 6.2, 5.5, 3.5, 10.5, 3.1]
    },
    {
      name: '9 against 8', method: 'exact', U1: 45, p: 0.4234471410941999,
      x: [7.1, -3.3, 1.8, -2, 3.9, -3.6, 2.2, 4.8, 8.2],
      y: [-0.2, 3.5, -2.5, -1.8, -5.6, 4, 2.8, 1.4]
    },
    {
      name: '4 against 40', method: 'exact', U1: 89, p: 0.7378951167947198,
      x: [-0.97, -1.94, -3.27, -3.38],
      y: [
        -2.89, -1.03, 0.24, -2.13, 4.17, -0.6, -8.29, -1.29, 1.03, -0.47, 1.59, 1.13, -4.8,
        -1.13, -4.27, -2.51, -3.78, -4.28, -5.28, -2.56, 0.64, -3.25, -2.38, -5.94, -2.62, -5.24,
        -7.39, -6.45, -6.93, 0.36, -4.36, -4.58, -2.81, -8.72, -4.1, -6.62, 1.12, -2.39, -5.52,
        2.34
      ]
    },
    {
      name: '8 against 120', method: 'exact', U1: 608, p: 0.21377051646295173,
      x: [1.24, 2.782, 0.108, -0.025, 0.097, -1.638, -4.095, -3.575],
      y: [
        -4.825, -4.459, -5.596, -4.394, -0.632, 1.18, 0.642, -3.579, -4.011, 0.633, 0.065,
        -0.003, -1.404, -5.877, -0.806, 6.643, -0.648, 2.423, -3.597, 1.931, -5.982, -2.193,
        -4.762, 0.545, -6.65, 0.485, 4.302, -2.983, 0.28, -3.199, -8.115, -5.838, 0.175, 5.912,
        -0.113, 0.647, -1.106, -4.492, -3.171, -4.463, -5.508, -0.557, -8.297, 1.417, 0.427,
        -1.3, -4.429, 4.939, -2.903, 1.695, 1.099, -1.641, -1.853, -9.226, -5.976, 3.515, -3.926,
        -7.209, -3.589, -10.028, -11.344, -3.466, -1.081, 0.958, -7.863, -2.013, -10.469, -0.61,
        -2.08, -7.499, -2.015, -1.706, -4.395, 3.222, 4.288, -2.505, -7.683, 2.17, -8.042,
        -3.982, -1.098, -0.269, 5.716, -1.579, 3.878, 2.625, 1.467, -5.172, -2.787, 4.423,
        -3.646, -2.709, -2.291, -3.125, 3.02, -1.746, -2.917, -4.813, 0.809, -2.454, -0.449,
        -6.112, -8.34, -6.965, -1.877, -4.268, -1.237, 2.332, 3.155, -6.557, -8.493, -7.362,
        -6.658, 0.141, -5.884, -4.32, -8.449, 1.949, 0.829, 2.3
      ]
    },
    {
      name: 'tied triplicates', method: 'asymptotic', U1: 0.5, p: 0.07652250047505922,
      x: [1, 2, 3],
      y: [3, 4, 5]
    },
    {
      name: '5 against 7 with ties', method: 'asymptotic', U1: 0, p: 0.004009362509751113,
      x: [1, 0, 0, 0, 1],
      y: [7, 7, 2, 3, 4, 5, 3]
    },
    {
      name: '9 against 9, no ties', method: 'asymptotic', U1: 35, p: 0.6272069263720121,
      x: [0.4, 2.4, 1.2, 4, 5.1, 3.8, -2.9, -5.4, 2.1],
      y: [7.9, 1.8, 1.1, 0.2, -3.2, 4.6, 4.9, -1.5, 7]
    },
    {
      name: '15 against 12 with ties', method: 'asymptotic', U1: 53, p: 0.06817005831668857,
      x: [2, 0, 6, 0, 3, 3, 3, 7, 6, 1, 3, 6, 7, 1, 4],
      y: [1, 7, 6, 5, 8, 7, 4, 8, 7, 1, 8, 1]
    },
    {
      name: '30 against 25', method: 'asymptotic', U1: 447, p: 0.22359579728336432,
      x: [
        2.41, 1.38, -0.45, 1.57, 2.76, 0.64, 6.65, 2.95, -0.59, 0.2, 1.42, 2.73, 8.34, -1.26,
        5.6, -3.03, 0.81, -3.12, 0.16, -5.58, -7.54, -3.3, -3.29, -3.18, 2.26, 4.04, 0.52, -3.05,
        1.78, 1.58
      ],
      y: [
        1.92, 7.05, -0.33, -1.43, -3.35, -7.84, -1.85, 3.18, -0.82, -9.99, -0.09, 4.27, -4.17,
        -1.25, -3.64, 8.18, 8.68, -4.7, -1.39, 3.86, -6.91, -2.08, -3.13, -4.23, 4.2
      ]
    }
  ],
  wilcoxon: [
    {
      name: 'five pairs, all one way', method: 'exact', W: 0, p: 0.0625,
      x: [1, 2, 3, 4, 5],
      y: [2, 4, 6, 8, 10]
    },
    {
      name: 'one pair', method: 'exact', W: 0, p: 1,
      x: [3],
      y: [1]
    },
    {
      name: '10 pairs', method: 'exact', W: 5, p: 0.01953125,
      x: [2.9, -2.6, 1.2, -2, -6.2, 1.3, -4.4, -5.7, -0.7, -1],
      y: [3.2, -3, 4.2, -2.8, -4.9, 4.5, 0.3, 5.6, 5, 5.1]
    },
    {
      name: '20 pairs', method: 'exact', W: 90, p: 0.5958194732666016,
      x: [
        2.32, 0.85, 1.42, 6, -1.14, 4.44, 5.34, -1.28, 1.08, -0.13, 2.02, 2.7, 5.16, 1.88, 2.24,
        5.99, -2.24, 7.66, -5.84, 2.64
      ],
      y: [
        6.52, 0.55, -6.33, 12.24, 1.08, 6.31, 6.4, -1.24, 3.66, -1.46, 0.07, -1.08, 4.93, 4.32,
        -0.91, 5.56, -2.92, 8.28, -4.13, 3.25
      ]
    },
    {
      name: '50 pairs, the exact limit', method: 'exact', W: 480, p: 0.13045894629165566,
      x: [
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
      ],
      y: [
        -4.542, -3.778, -6.639, 6.171, 4.501, -5.179, -1.481, -2.95, -0.056, 2.954, -3.911,
        -3.377, 4.507, 0.39, -4.202, 3.731, 2.539, -4.82, -2.626, -5.408, 2.725, -4.492, 3.615,
        -2.856, -0.536, 6.389, 0.327, -4.342, -2.055, 6.055, -5.084, -1.557, -5.686, -1.863,
        3.061, -2.364, 0.874, -1.986, -1.598, -5.703, 1.382, -1.531, -7.991, -3.394, 0.277,
        7.673, 0.525, 2.44, 3.997, -3.279
      ]
    },
    {
      name: '51 pairs, one past it', method: 'asymptotic', W: 436, p: 0.03335557893949904,
      x: [
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
      ],
      y: [
        -1.935, -3.999, 0.056, -0.378, -1.58, 2.721, -5.449, -0.482, 1.331, -2.767, -1.322, 0.55,
        -5.061, 4.635, 1.202, -4.204, 1.968, -3.624, -1.592, -3.603, -5.156, -1.486, -3.501,
        0.957, 7.051, 0.948, -0.174, -9.909, -4.71, 6.503, -1.295, 0.433, -4.35, -0.764, -3.25,
        1.214, -2.113, 1.479, -2.818, -3.955, 1.924, -2.842, 0.257, -5.397, -1.595, 6.168,
        -0.808, 3.192, -3.522, 1.816, 1.501
      ]
    },
    {
      name: 'before and after (the page example)', method: 'permutation', W: 0, p: 0.001953125,
      x: [120, 135, 128, 142, 118, 150, 133, 127, 145, 122],
      y: [112, 128, 119, 133, 115, 139, 124, 121, 138, 116]
    },
    {
      name: '13 pairs with ties', method: 'permutation', W: 16, p: 0.044189453125,
      x: [2, 0, 0, 2, 3, -1, 1, 1, 2, 2, 1, 1, 3],
      y: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]
    },
    {
      name: '14 pairs with ties', method: 'asymptotic', W: 33, p: 0.21201643182118513,
      x: [2, 3, 1, 2, -1, 1, 3, 0, 2, -1, 2, -1, 1, 0],
      y: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]
    },
    {
      name: '13 pairs with a zero', method: 'permutation', W: 38.5, p: 0.986328125,
      x: [-2.8, 2.8, 6.7, -2.6, 0, -2.5, 2.1, -0.7, -5.3, 1.3, -0.8, 3.1, -0.1],
      y: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
    },
    {
      name: '14 pairs with a zero', method: 'asymptotic', W: 42.5, p: 0.8338854386599464,
      x: [-5.1, -1.6, 3.1, 1, 0, -0.2, 3.8, 1.6, -1.5, -2.1, -0.5, -4.2, 3.9, 0.4],
      y: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
    },
    {
      name: 'six pairs with a zero and a tie', method: 'permutation', W: 1.5, p: 0.1875,
      x: [2, 3, 5, 5, 1, 4],
      y: [2, 1, 2, 2, 3, 1]
    },
    {
      name: 'one sample of ten (the page example)', method: 'exact', W: 0, p: 0.001953125,
      x: [0.1012, 0.1008, 0.1015, 0.1003, 0.1011, 0.1009, 0.1017, 0.1006, 0.1013, 0.101],
      mu0: 0.1
    },
    {
      name: 'one sample of 20 with ties and zeros', method: 'asymptotic', W: 39, p: 0.07172876725710192,
      x: [6, 5, 4, 6, 6, 6, 3, 1, 6, 4, 3, 4, 0, 2, 6, 5, 1, 3, 1, 5],
      mu0: 3
    },
    {
      name: 'one sample of 60', method: 'asymptotic', W: 600.5, p: 0.020598523960106852,
      x: [
        -1.24, 0.86, 2.42, -0.38, -0.66, 2.41, -2.06, -0.48, 3.76, 0.48, 0.62, -5.64, 4.32, 3.15,
        1.85, 4.11, 1.38, 0.88, 0.05, 7.42, 1.24, 2.32, -3.11, -2.64, -2.13, -1.25, 5.04, -4.3,
        3.21, -1.79, 6.61, 3.72, 2.46, 2.26, -0.76, -0.79, 0.06, -0.8, 0.76, -0.18, 5.65, -1.17,
        5.25, 3, 1.37, -2.6, 5.45, -6.26, 0.8, 4.3, -4.13, -1.94, 0.65, 4.87, -0.29, -3.7, 7.32,
        1.66, 5.7, 0.89
      ],
      mu0: 0
    }
  ]
};

/* Relative difference, 0 when both are 0. */
const relDiff = (a, b) => (a === b ? 0 : Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b)));
/* The agreement asked of each method: the counted ones to 1e-12, the normal approximation to 1e-10. */
const RANK_TOL = { exact: 1e-12, permutation: 1e-12, asymptotic: 1e-10 };

describe('rank tests against SciPy', () => {
  test("Mann-Whitney U reproduces SciPy's default p and its choice of method", () => {
    for (const c of RANK_REFERENCE.mannWhitney) {
      const r = mannWhitneyU(c.x, c.y);
      const got = [c.name, r.method, r.U1, relDiff(r.p, c.p) <= RANK_TOL[c.method]];
      expect(got).toEqual([c.name, c.method, c.U1, true]);
    }
  });

  test("Wilcoxon signed-rank reproduces SciPy's default p and its choice of method", () => {
    for (const c of RANK_REFERENCE.wilcoxon) {
      const r = c.y ? wilcoxonSignedRank(c.x, c.y) : oneSampleWilcoxon(c.x, c.mu0);
      const got = [c.name, r.method, r.W, relDiff(r.p, c.p) <= RANK_TOL[c.method]];
      expect(got).toEqual([c.name, c.method, c.W, true]);
    }
  });
});

/*
 * Many random data sets, small and medium, with and without ties and zeros,
 * against the SciPy that is installed (STEMKIT_PYTHON, or python3), when
 * there is one. SciPy is asked for the method this code chose, by name, so
 * any SciPy from 1.11 on will do (older ones name or lack two of the
 * methods, and the driver falls back as the page's script does); from 1.15
 * on, SciPy's own default (method='auto') must give the same p as well.
 */
const PYTHON_BIN = process.env.STEMKIT_PYTHON || 'python3';
const SCIPY = (() => {
  try {
    return spawnSync(PYTHON_BIN, ['-c', 'import numpy, scipy'], { encoding: 'utf8', timeout: 60000 }).status === 0;
  } catch {
    return false;
  }
})();
const withScipy = SCIPY ? test : test.skip;

const RANK_DRIVER = String.raw`
import json, sys, warnings
import numpy as np
import scipy
from scipy import stats
warnings.simplefilter('ignore')  # SciPy before 1.15 warns about small samples
version = tuple(int(v) for v in scipy.__version__.split('.')[:2])
cases = json.load(sys.stdin)

def wilcoxon(d, method):
    if method == 'permutation':
        try:
            res = stats.wilcoxon(d, method=stats.PermutationMethod())
        except (AttributeError, ValueError):  # SciPy before 1.13
            ranks = np.zeros(len(d))
            ranks[d != 0] = stats.rankdata(np.abs(d[d != 0]))
            res = stats.permutation_test((d,), lambda s, axis: (ranks * (s > 0)).sum(axis=axis),
                                         permutation_type='samples', n_resamples=np.inf, vectorized=True)
            return min(res.statistic, ranks.sum() - res.statistic), res.pvalue
    elif method == 'asymptotic':
        try:
            res = stats.wilcoxon(d, method='asymptotic')
        except ValueError:  # SciPy before 1.15
            res = stats.wilcoxon(d, method='approx')
    else:
        res = stats.wilcoxon(d, method='exact')
    return res.statistic, res.pvalue

out = {'version': scipy.__version__, 'mw': [], 'wx': []}
for c in cases['mw']:
    x, y = np.array(c['x'], float), np.array(c['y'], float)
    res = stats.mannwhitneyu(x, y, use_continuity=False, method=c['method'])
    auto = stats.mannwhitneyu(x, y, use_continuity=False).pvalue  # 'auto' chooses alike from 1.11 on
    out['mw'].append([float(res.statistic), float(res.pvalue), float(auto)])
for c in cases['wx']:
    d = np.array(c['d'], float)
    statistic, p = wilcoxon(d, c['method'])
    auto = float(stats.wilcoxon(d).pvalue) if version >= (1, 15) else None
    out['wx'].append([float(statistic), float(p), auto])
print(json.dumps(out))
`;

/* A seeded generator, so the data sets are the same on every run. */
function lcg(seed) {
  let s = seed;
  return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
}

function randomRankCases() {
  const rnd = lcg(20261001);
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
  // Six decimals keep values distinct; halves make ties common.
  const draw = (n, shift, ties) => Array.from({ length: n }, () => {
    const v = gauss() + shift;
    return ties ? Math.round(v * 2) / 2 : Math.round(v * 1e6) / 1e6;
  });
  const size = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
  const mw = [];
  for (let k = 0; k < 1200; k++) {
    const [n1, n2] = [[size(1, 8), size(1, 12)], [size(1, 8), size(9, 150)], [size(1, 40), size(1, 40)]][k % 3];
    const ties = rnd() < 0.3;
    const shift = rnd() < 0.5 ? 0 : 3 * rnd();
    const x = draw(n1, 0, ties);
    const y = draw(n2, shift, ties);
    const pair = rnd() < 0.5 ? [x, y] : [y, x];
    mw.push({ x: pair[0], y: pair[1], r: mannWhitneyU(pair[0], pair[1]) });
  }
  const wx = [];
  for (let k = 0; k < 1200; k++) {
    const n = k % 3 === 0 ? size(1, 15) : size(1, 70);
    const ties = rnd() < 0.4;
    const zeros = rnd() < 0.3;
    let d = draw(n, rnd() < 0.5 ? 0 : 2 * rnd(), ties);
    if (zeros) d = d.map((v) => (rnd() < 0.2 ? 0 : v));
    const r = wilcoxonSignedRank(d, d.map(() => 0));
    if (r) wx.push({ d, r });
  }
  return { mw, wx };
}

describe('rank tests against the installed SciPy', () => {
  withScipy('agree on random data sets, with and without ties and zeros', () => {
    const { mw, wx } = randomRankCases();
    const input = JSON.stringify({
      mw: mw.map(({ x, y, r }) => ({ x, y, method: r.method })),
      wx: wx.map(({ d, r }) => ({ d, method: r.method }))
    });
    const run = spawnSync(PYTHON_BIN, ['-c', RANK_DRIVER], { input, encoding: 'utf8', timeout: 240000, maxBuffer: 1 << 26 });
    expect(run.stderr).toBe('');
    const out = JSON.parse(run.stdout);

    // Every method turns up, so each branch is compared.
    const methods = (list) => [...new Set(list.map((c) => c.r.method))].sort();
    expect(methods(mw)).toEqual(['asymptotic', 'exact']);
    expect(methods(wx)).toEqual(['asymptotic', 'exact', 'permutation']);

    const worst = {};
    const note = (key, e) => { worst[key] = Math.max(worst[key] || 0, e); };
    mw.forEach(({ r }, i) => {
      const [U1, p, auto] = out.mw[i];
      expect(r.U1).toBe(U1);
      note(`mw ${r.method}`, relDiff(r.p, p));
      note(`mw ${r.method} (auto)`, relDiff(r.p, auto));
    });
    wx.forEach(({ r }, i) => {
      const [W, p, auto] = out.wx[i];
      expect(r.W).toBe(W);
      note(`wx ${r.method}`, relDiff(r.p, p));
      if (auto !== null) note(`wx ${r.method} (auto)`, relDiff(r.p, auto));
    });
    for (const [key, e] of Object.entries(worst)) {
      const method = key.split(' ')[1];
      if (!(e <= RANK_TOL[method])) throw new Error(`${key}: relative difference ${e} from SciPy ${out.version}`);
    }
  }, 300000);
});
