/**
 * @module core/statistics
 *
 * Descriptive and inferential statistics extracted from STEMKit's Statistical
 * Calculator. Pure functions only: no DOM, no formatting, no UI state.
 *
 * Distribution CDFs and inverses are delegated to the vendored jStat bundle,
 * obtained through the injection layer in `vendor.js`, so that the browser and
 * Node builds compute identical numbers from identical code.
 *
 * Conventions
 * -----------
 * - Variance and standard deviation use the unbiased (n-1) denominator.
 * - Independent-samples comparison defaults to Welch's t-test, which does not
 *   assume equal variances; Student's pooled t is available explicitly.
 * - Every parametric test returns an effect size, and a 95% confidence
 *   interval where one is standard.
 * - Functions return structured results and never throw on statistically
 *   degenerate input; they report the condition in the result instead.
 */

import { requireVendor } from './vendor.js';
import { quantile } from './error-bars.js';

/* ------------------------------------------------------------------ *
 * Descriptive statistics
 * ------------------------------------------------------------------ */

/**
 * Arithmetic mean.
 *
 * @param {number[]} a - Non-empty numeric array.
 * @returns {number} The mean, or NaN for empty input.
 */
export function mean(a) {
  if (!Array.isArray(a) || a.length === 0) return NaN;
  let s = 0;
  for (const x of a) s += x;
  return s / a.length;
}

/**
 * Unbiased sample variance (n-1 denominator).
 *
 * @param {number[]} a - Array of at least two values.
 * @returns {number} The variance, or NaN when n < 2.
 */
export function variance(a) {
  if (!Array.isArray(a) || a.length < 2) return NaN;
  const m = mean(a);
  let s = 0;
  for (const x of a) {
    const d = x - m;
    s += d * d;
  }
  return s / (a.length - 1);
}

/**
 * Sample standard deviation.
 *
 * @param {number[]} a
 * @returns {number}
 */
export function sd(a) {
  return Math.sqrt(variance(a));
}

/**
 * Median. Does not mutate the input.
 *
 * @param {number[]} a - Non-empty numeric array.
 * @returns {number} The median, or NaN for empty input.
 */
export function median(a) {
  if (!Array.isArray(a) || a.length === 0) return NaN;
  const b = [...a].sort((x, y) => x - y);
  const n = b.length;
  const mid = Math.floor(n / 2);
  return n % 2 ? b[mid] : (b[mid - 1] + b[mid]) / 2;
}

/**
 * Bias-corrected (Fisher–Pearson) sample skewness, G1.
 *
 * The standardised third moment is defined against the *population* standard
 * deviation (n denominator); the (n-1) sample sd is not interchangeable here.
 * Using the sample sd deflates the statistic by a factor of ((n-1)/n)^(3/2) , 
 * about 15% at n = 10, and propagates that error into any normality test
 * built on it. Matches `scipy.stats.skew(..., bias=False)` and R's `e1071`
 * type-2 estimator.
 *
 * @param {number[]} a - Array of at least three values.
 * @returns {number} Skewness; 0 for a zero-variance sample, NaN when n < 3.
 */
export function skewness(a) {
  if (!Array.isArray(a) || a.length < 3) return NaN;
  const n = a.length;
  const g = momentSkewness(a);
  if (!Number.isFinite(g)) return g;
  if (g === 0) return 0;
  return (Math.sqrt(n * (n - 1)) / (n - 2)) * g;
}

/**
 * Biased skewness: the moment ratio sqrt(b1) = m3 / m2^(3/2).
 *
 * This is the quantity the D'Agostino-Pearson transformations are defined on,
 * and what `scipy.stats.skew(..., bias=True)` returns. It is deliberately not
 * exported: `skewness()` is the statistic to report, this is the one to feed
 * into a transform whose constants were derived for it.
 *
 * @param {number[]} a - Array of at least three values.
 * @returns {number} m3 / m2^(3/2); 0 for a zero-variance sample, NaN when n < 3.
 */
function momentSkewness(a) {
  if (!Array.isArray(a) || a.length < 3) return NaN;
  const n = a.length;
  const m = mean(a);

  // Population standard deviation (n denominator).
  let ss = 0;
  for (const x of a) ss += (x - m) * (x - m);
  const sPop = Math.sqrt(ss / n);
  if (sPop === 0) return 0;

  let g1 = 0;
  for (const x of a) g1 += Math.pow((x - m) / sPop, 3);
  return g1 / n;
}

/**
 * Excess kurtosis (normal distribution = 0), biased estimator.
 *
 * As with skewness, the fourth standardised moment uses the population
 * standard deviation. Matches `scipy.stats.kurtosis(..., fisher=True,
 * bias=True)`.
 *
 * @param {number[]} a - Array of at least two values.
 * @returns {number} Excess kurtosis; 0 for a zero-variance sample.
 */
export function kurtosis(a) {
  if (!Array.isArray(a) || a.length < 2) return NaN;
  const n = a.length;
  const m = mean(a);

  let ss = 0;
  for (const x of a) ss += (x - m) * (x - m);
  const sPop = Math.sqrt(ss / n);
  if (sPop === 0) return 0;

  let m4 = 0;
  for (const x of a) m4 += Math.pow((x - m) / sPop, 4);
  return m4 / n - 3;
}

/**
 * Fractional ranks with ties resolved by averaging (1-based).
 *
 * @param {number[]} a
 * @returns {number[]} Ranks in the original element order.
 */
export function ranks(a) {
  if (!Array.isArray(a)) return [];
  const idx = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]);
  const r = new Array(a.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
    i = j + 1;
  }
  return r;
}

/**
 * Full descriptive summary of a sample.
 *
 * @param {number[]} a
 * @returns {{n:number, mean:number, sd:number, variance:number,
 *            median:number, min:number, max:number,
 *            skewness:number, kurtosis:number}|null}
 */
export function describe(a) {
  if (!Array.isArray(a) || a.length === 0) return null;
  return {
    n: a.length,
    mean: mean(a),
    sd: sd(a),
    variance: variance(a),
    median: median(a),
    min: Math.min(...a),
    max: Math.max(...a),
    skewness: skewness(a),
    kurtosis: kurtosis(a)
  };
}

/**
 * The per-group summary a results table reports.
 *
 * Quartiles, and so the IQR, interpolate linearly between order statistics:
 * R's type 7 and NumPy's default `percentile`. Other definitions (Minitab and
 * SPSS use type 6) give slightly different values for small n, so a table
 * built from this says which it used. The interval is the t interval for the
 * mean, mean ± t(n−1) × SEM, with SEM = SD/√n and the (n−1) SD.
 *
 * A single observation has no spread: SD, SEM and the interval are NaN, not
 * zero, so a table shows them as missing rather than as perfectly precise.
 *
 * @param {number[]} a
 * @param {{conf?: number}} [options] - Confidence level, default 0.95.
 * @returns {{n:number, mean:number, sd:number, sem:number,
 *            ci:[number,number], conf:number, median:number,
 *            q1:number, q3:number, iqr:number, min:number, max:number}|null}
 */
export function descriptives(a, options = {}) {
  const { conf = 0.95 } = options;
  if (!Array.isArray(a) || a.length === 0) return null;
  const n = a.length;
  const m = mean(a);
  const s = sd(a);
  const sem = s / Math.sqrt(n);
  const tc = n > 1 ? tCritical(n - 1, conf) : NaN;
  const q1 = quantile(a, 0.25);
  const q3 = quantile(a, 0.75);

  // A loop rather than Math.min(...a), which overflows the call stack on a
  // column of a few hundred thousand values.
  let min = Infinity;
  let max = -Infinity;
  for (const x of a) {
    if (x < min) min = x;
    if (x > max) max = x;
  }

  return {
    n, mean: m, sd: s, sem,
    ci: [m - tc * sem, m + tc * sem], conf,
    median: median(a), q1, q3, iqr: q3 - q1,
    min, max
  };
}

/**
 * Box-plot statistics in Tukey's convention.
 *
 * The box spans the first to third quartile (type 7, as `descriptives` and
 * matplotlib's `boxplot` use), the whiskers reach the most extreme
 * observations lying within `whisker` × IQR of the box (1.5 by convention;
 * Tukey 1977), and every observation beyond a whisker is returned as an
 * outlier. Where no observation lies between a fence and its quartile, the
 * whisker stops at the quartile, as matplotlib's does.
 *
 * @param {number[]} a
 * @param {{whisker?: number}} [options]
 * @returns {{n:number, q1:number, median:number, q3:number, iqr:number,
 *            lowerFence:number, upperFence:number,
 *            whiskerLow:number, whiskerHigh:number,
 *            outliers:number[], min:number, max:number}|null}
 */
export function boxPlotStats(a, options = {}) {
  const { whisker = 1.5 } = options;
  if (!Array.isArray(a) || a.length === 0) return null;
  const s = [...a].sort((x, y) => x - y);
  const q1 = quantile(s, 0.25);
  const q3 = quantile(s, 0.75);
  const iqr = q3 - q1;
  const lowerFence = q1 - whisker * iqr;
  const upperFence = q3 + whisker * iqr;

  const inLow = s.find(x => x >= lowerFence);
  const inHigh = [...s].reverse().find(x => x <= upperFence);
  const whiskerLow = inLow === undefined || inLow > q1 ? q1 : inLow;
  const whiskerHigh = inHigh === undefined || inHigh < q3 ? q3 : inHigh;

  return {
    n: s.length, q1, median: quantile(s, 0.5), q3, iqr,
    lowerFence, upperFence, whiskerLow, whiskerHigh,
    outliers: s.filter(x => x < whiskerLow || x > whiskerHigh),
    min: s[0], max: s[s.length - 1]
  };
}

/* ------------------------------------------------------------------ *
 * Distribution helpers (delegated to the vendored jStat)
 * ------------------------------------------------------------------ */

/**
 * Two-sided p-value from Student's t.
 *
 * Evaluated at -|t| so the result comes from the lower tail directly; this
 * avoids the `1 - cdf` cancellation that would otherwise floor very small
 * p-values at zero.
 *
 * @param {number} t
 * @param {number} df
 * @returns {number}
 */
export function tTwoSided(t, df) {
  const jStat = requireVendor('jStat');
  if (!Number.isFinite(t) || !Number.isFinite(df) || df <= 0) return NaN;
  // I_{df/(df+t^2)}(df/2, 1/2) is exactly the two-sided tail area.
  return jStat.ibeta(df / (df + t * t), df / 2, 0.5);
}

/**
 * Two-sided critical t value.
 *
 * @param {number} df
 * @param {number} [conf=0.95]
 * @returns {number}
 */
export function tCritical(df, conf = 0.95) {
  const jStat = requireVendor('jStat');
  if (!Number.isFinite(conf) || conf <= 0 || conf >= 1) return NaN;
  const q = 1 - (1 - conf) / 2;
  // As df -> infinity the t distribution converges to the standard normal;
  // jStat's studentt.inv returns NaN for a non-finite df, so take the limit
  // explicitly rather than propagating NaN into a confidence interval.
  if (df === Infinity) return jStat.normal.inv(q, 0, 1);
  if (!Number.isFinite(df) || df <= 0) return NaN;
  return jStat.studentt.inv(q, df);
}

/**
 * Upper-tail p-value from the central F distribution.
 *
 * Computed as I_{d2/(d2+d1 f)}(d2/2, d1/2) rather than `1 - cdf(f)`. The two
 * are algebraically identical, but the naive subtraction catastrophically
 * cancels once the CDF rounds to 1.0 in double precision: a strong ANOVA
 * effect that should report p ~ 3e-17 instead reports exactly 0. Using the
 * complementary form of the incomplete beta keeps full relative precision
 * deep into the tail.
 *
 * @param {number} f - Test statistic; non-negative.
 * @param {number} d1 - Numerator degrees of freedom.
 * @param {number} d2 - Denominator degrees of freedom.
 * @returns {number} P(F >= f).
 */
export function fUpperTail(f, d1, d2) {
  const jStat = requireVendor('jStat');
  if (!Number.isFinite(f) || f <= 0) return 1;
  if (!Number.isFinite(d1) || !Number.isFinite(d2) || d1 <= 0 || d2 <= 0) return NaN;
  return jStat.ibeta(d2 / (d2 + d1 * f), d2 / 2, d1 / 2);
}

/**
 * Two-sided p-value for a standard normal deviate.
 *
 * Uses the vendored jStat `erfc` for |z| <= 8. Beyond that jStat's series
 * underflows to exactly 0, so the standard asymptotic expansion
 *
 *   erfc(x) ~ exp(-x^2)/(x*sqrt(pi)) * (1 - 1/(2x^2) + 3/(4x^4) - ...)
 *
 * is used instead (Abramowitz & Stegun 7.1.23). At x = 8/sqrt(2) the two agree
 * to better than 1e-3 relative, and the expansion improves monotonically
 * further out. Such p-values are far below any decision threshold and are
 * reported only so that output reads "2.1e-23" rather than a misleading "0".
 *
 * @param {number} z
 * @returns {number} P(|Z| >= |z|).
 */
export function zTwoSided(z) {
  const jStat = requireVendor('jStat');
  if (!Number.isFinite(z)) return NaN;
  const az = Math.abs(z);
  if (az <= 8) return jStat.erfc(az / Math.SQRT2);

  const x = az / Math.SQRT2;
  const x2 = x * x;
  const series = 1 - 1 / (2 * x2) + 3 / (4 * x2 * x2) - 15 / (8 * x2 * x2 * x2);
  return (Math.exp(-x2) / (x * Math.sqrt(Math.PI))) * series;
}

/**
 * Upper regularised incomplete gamma function, Q(a, x) = Γ(a, x)/Γ(a).
 *
 * jStat has only the lower function P, and 1 − P loses every significant
 * figure once P rounds to 1: for chi-squared on 3 df that happens near
 * x = 80, where p is about 1e-17. For x ≥ a + 1 the continued fraction for Q
 * (Numerical Recipes, 3rd ed., §6.2, evaluated by the modified Lentz method)
 * converges in a few dozen terms and keeps full relative precision far into
 * the tail. Below a + 1, P is not close to 1 and the subtraction is safe.
 *
 * @param {number} a - Shape, > 0.
 * @param {number} x - > 0.
 * @returns {number}
 */
function upperRegGamma(a, x) {
  const jStat = requireVendor('jStat');
  if (x < a + 1) return 1 - jStat.lowRegGamma(a, x);

  const TINY = 1e-300;
  let b = x + 1 - a;
  let c = 1 / TINY;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i <= 500; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < TINY) d = TINY;
    c = b + an / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const step = d * c;
    h *= step;
    if (Math.abs(step - 1) < 1e-15) break;
  }
  return Math.exp(-x + a * Math.log(x) - jStat.gammaln(a)) * h;
}

/**
 * Upper-tail p-value from the chi-squared distribution.
 *
 * Q(df/2, x/2), from `upperRegGamma` above rather than as 1 − the lower
 * tail, so a strong Kruskal–Wallis effect on four groups reports p ~ 1e-20
 * instead of 0. For the common df = 2 case the closed form Q(1, x/2) =
 * exp(−x/2) is used. A tail that underflows even so (x in the thousands) is
 * floored at the smallest positive double, so that a p-value is never
 * reported as identically zero.
 *
 * @param {number} x
 * @param {number} df
 * @returns {number} P(X >= x).
 */
export function chiSquaredUpperTail(x, df) {
  if (!Number.isFinite(x) || !Number.isFinite(df) || df <= 0) return NaN;
  if (x <= 0) return 1;

  // Exact closed form for two degrees of freedom (the D'Agostino K^2 case).
  if (df === 2) return Math.exp(-x / 2);

  const q = upperRegGamma(df / 2, x / 2);
  return q > 0 ? q : Number.MIN_VALUE;
}

/* ------------------------------------------------------------------ *
 * Assumption checks
 * ------------------------------------------------------------------ */

/**
 * D'Agostino–Pearson K² omnibus test of normality.
 *
 * Combines the standardised skewness statistic of D'Agostino (1970) with the
 * Anscombe–Glynn (1983) kurtosis statistic; K² is referred to chi-squared on
 * two degrees of freedom. Requires n >= 8 for the transformations to be valid.
 *
 * @param {number[]} a
 * @returns {{K2:number, p:number, ok:boolean|null, note:string|null}}
 *          `ok` is true when normality is not rejected at alpha = 0.05, and
 *          null when the sample is too small to test.
 */
export function dagostinoNormality(a) {
  if (!Array.isArray(a)) return { K2: NaN, p: NaN, ok: null, note: 'invalid input' };
  const n = a.length;
  if (n < 8) return { K2: NaN, p: NaN, ok: null, note: 'n < 8: normality not testable' };

  const s = sd(a);
  if (!Number.isFinite(s) || s === 0) {
    return { K2: NaN, p: NaN, ok: null, note: 'zero variance: normality not testable' };
  }

  // The transformations below are defined on the biased moment ratios
  // sqrt(b1) = m3 / m2^(3/2) and b2 = m4 / m2^2. skewness() reports the
  // sample-size-adjusted G1 instead, which is the right statistic to publish
  // but the wrong one to feed in here: it inflates K2 at small n and diverges
  // from scipy.stats.normaltest. kurtosis() is already the biased estimator.
  const b1 = momentSkewness(a);
  const b2 = kurtosis(a) + 3;

  // Skewness component (D'Agostino 1970).
  const Y = b1 * Math.sqrt(((n + 1) * (n + 3)) / (6 * (n - 2)));
  const beta2 = (3 * (n * n + 27 * n - 70) * (n + 1) * (n + 3)) /
                ((n - 2) * (n + 5) * (n + 7) * (n + 9));
  const W2 = -1 + Math.sqrt(2 * (beta2 - 1));
  const delta = 1 / Math.sqrt(0.5 * Math.log(W2));
  const alpha = Math.sqrt(2 / (W2 - 1));
  const Zb1 = delta * Math.log(Y / alpha + Math.sqrt(Math.pow(Y / alpha, 2) + 1));

  // Kurtosis component (Anscombe–Glynn 1983).
  const meanB2 = (3 * (n - 1)) / (n + 1);
  const varB2 = (24 * n * (n - 2) * (n - 3)) /
                (Math.pow(n + 1, 2) * (n + 3) * (n + 5));
  const x = (b2 - meanB2) / Math.sqrt(varB2);
  const sqrtBeta1 = ((6 * (n * n - 5 * n + 2)) / ((n + 7) * (n + 9))) *
                    Math.sqrt((6 * (n + 3) * (n + 5)) / (n * (n - 2) * (n - 3)));
  const A = 6 + (8 / sqrtBeta1) *
            (2 / sqrtBeta1 + Math.sqrt(1 + 4 / Math.pow(sqrtBeta1, 2)));
  const term = (1 - 2 / A) / (1 + x * Math.sqrt(2 / (A - 4)));
  const Zb2 = ((1 - 2 / (9 * A)) - Math.cbrt(term)) / Math.sqrt(2 / (9 * A));

  const K2 = Zb1 * Zb1 + Zb2 * Zb2;
  const p = chiSquaredUpperTail(K2, 2);
  return { K2, p, ok: p > 0.05, note: null };
}

/**
 * Levene's test for homogeneity of variance, Brown–Forsythe variant.
 *
 * The median-centred variant is used because it is markedly more robust to
 * departures from normality than the original mean-centred formulation.
 *
 * @param {number[][]} groups - Two or more samples.
 * @returns {{W:number, df1:number, df2:number, p:number, ok:boolean|null}}
 */
export function leveneTest(groups) {
  if (!Array.isArray(groups) || groups.length < 2) {
    return { W: NaN, df1: NaN, df2: NaN, p: NaN, ok: null };
  }
  const k = groups.length;
  const N = groups.reduce((s, g) => s + g.length, 0);

  const Z = groups.map(g => {
    const med = median(g);
    return g.map(x => Math.abs(x - med));
  });
  const Zbar = Z.map(z => mean(z));
  const Zgrand = mean(Z.flat());

  let num = 0;
  let den = 0;
  for (let i = 0; i < k; i++) {
    num += Z[i].length * Math.pow(Zbar[i] - Zgrand, 2);
    for (const zij of Z[i]) den += Math.pow(zij - Zbar[i], 2);
  }

  // den === 0 means every observation equals its group median: no dispersion
  // to compare, so the test is undefined rather than infinitely significant.
  if (den === 0) return { W: NaN, df1: k - 1, df2: N - k, p: NaN, ok: null };

  const W = ((N - k) / (k - 1)) * (num / den);
  const p = fUpperTail(W, k - 1, N - k);
  return { W, df1: k - 1, df2: N - k, p, ok: p > 0.05 };
}

/* ------------------------------------------------------------------ *
 * Parametric tests
 * ------------------------------------------------------------------ */

/**
 * Independent-samples t-test.
 *
 * @param {number[]} arr1
 * @param {number[]} arr2
 * @param {{pooled?: boolean, conf?: number}} [options]
 *        `pooled` selects Student's equal-variance test; the default (false)
 *        is Welch's test with Satterthwaite degrees of freedom.
 * @returns {{t:number, df:number, p:number, meanDiff:number,
 *            d:number, g:number, ci:[number,number],
 *            n1:number, n2:number, mean1:number, mean2:number,
 *            sd1:number, sd2:number, method:string}|null}
 */
export function independentTTest(arr1, arr2, options = {}) {
  const { pooled = false, conf = 0.95 } = options;
  if (!Array.isArray(arr1) || !Array.isArray(arr2)) return null;
  const n1 = arr1.length;
  const n2 = arr2.length;
  if (n1 < 2 || n2 < 2) return null;

  const m1 = mean(arr1);
  const m2 = mean(arr2);
  const v1 = variance(arr1);
  const v2 = variance(arr2);
  const diff = m1 - m2;

  let se;
  let df;
  let method;
  if (pooled) {
    const sp2 = ((n1 - 1) * v1 + (n2 - 1) * v2) / (n1 + n2 - 2);
    se = Math.sqrt(sp2 * (1 / n1 + 1 / n2));
    df = n1 + n2 - 2;
    method = "Student's independent-samples t-test (pooled variance)";
  } else {
    se = Math.sqrt(v1 / n1 + v2 / n2);
    df = Math.pow(v1 / n1 + v2 / n2, 2) /
         (Math.pow(v1 / n1, 2) / (n1 - 1) + Math.pow(v2 / n2, 2) / (n2 - 1));
    method = "Welch's independent-samples t-test (unequal variances)";
  }

  const t = diff / se;
  const p = tTwoSided(t, df);

  // Cohen's d uses the pooled SD regardless of which test produced t, which is
  // the standard convention for reporting effect size.
  const sPooled = Math.sqrt(((n1 - 1) * v1 + (n2 - 1) * v2) / (n1 + n2 - 2));
  const d = diff / sPooled;
  const J = 1 - 3 / (4 * (n1 + n2) - 9);
  const g = d * J;

  const tc = tCritical(df, conf);
  const ci = [diff - tc * se, diff + tc * se];

  return {
    t, df, p, meanDiff: diff, d, g, ci,
    n1, n2, mean1: m1, mean2: m2,
    sd1: Math.sqrt(v1), sd2: Math.sqrt(v2),
    method
  };
}

/**
 * Paired-samples t-test.
 *
 * @param {number[]} arr1
 * @param {number[]} arr2
 * @param {{conf?: number}} [options]
 * @returns {{t:number, df:number, p:number, meanDiff:number, sdDiff:number,
 *            dz:number, ci:[number,number], n:number, diffs:number[]}|null}
 */
export function pairedTTest(arr1, arr2, options = {}) {
  const { conf = 0.95 } = options;
  const pair = alignPairs(arr1, arr2);
  const n = pair.a.length;
  if (n < 2) return null;

  const d = pair.a.map((v, i) => v - pair.b[i]);
  const md = mean(d);
  const sdd = sd(d);

  // A constant difference gives zero standard error; t is undefined rather
  // than infinite, and the caller is told so explicitly.
  if (sdd === 0) {
    return {
      t: NaN, df: n - 1, p: NaN, meanDiff: md, sdDiff: 0,
      dz: NaN, ci: [md, md], n, diffs: d
    };
  }

  const se = sdd / Math.sqrt(n);
  const t = md / se;
  const df = n - 1;
  const p = tTwoSided(t, df);
  const dz = md / sdd;
  const tc = tCritical(df, conf);

  return {
    t, df, p, meanDiff: md, sdDiff: sdd, dz,
    ci: [md - tc * se, md + tc * se], n, diffs: d
  };
}

/**
 * One-sample t-test of a mean against a stated value.
 *
 * Two-sided, t = (x̄ − μ₀)/(s/√n) on n − 1 df, matching
 * `scipy.stats.ttest_1samp`. The effect size is Cohen's d for one sample,
 * (x̄ − μ₀)/s. Both the interval of the mean and the interval of the
 * difference from μ₀ are returned, since a methods section may want either.
 *
 * @param {number[]} a
 * @param {number} [mu0=0] - The hypothesised mean.
 * @param {{conf?: number}} [options]
 * @returns {{t:number, df:number, p:number, mean:number, mu0:number,
 *            meanDiff:number, sd:number, se:number, d:number,
 *            ci:[number,number], ciDiff:[number,number], n:number}|null}
 *          null with fewer than two values or a non-finite μ₀.
 */
export function oneSampleTTest(a, mu0 = 0, options = {}) {
  const { conf = 0.95 } = options;
  if (!Array.isArray(a) || a.length < 2 || !Number.isFinite(mu0)) return null;
  const n = a.length;
  const m = mean(a);
  const s = sd(a);
  const df = n - 1;
  const diff = m - mu0;

  // A constant sample has no standard error; t is undefined, as for the
  // paired test with a constant difference.
  if (s === 0) {
    return {
      t: NaN, df, p: NaN, mean: m, mu0, meanDiff: diff, sd: 0, se: 0,
      d: NaN, ci: [m, m], ciDiff: [diff, diff], n
    };
  }

  const se = s / Math.sqrt(n);
  const t = diff / se;
  const tc = tCritical(df, conf);
  return {
    t, df, p: tTwoSided(t, df), mean: m, mu0, meanDiff: diff, sd: s, se,
    d: diff / s,
    ci: [m - tc * se, m + tc * se],
    ciDiff: [diff - tc * se, diff + tc * se],
    n
  };
}

/**
 * One-way analysis of variance across k >= 2 independent groups.
 *
 * @param {number[][]} groups
 * @returns {{F:number, dfBetween:number, dfWithin:number, p:number,
 *            ssBetween:number, ssWithin:number, ssTotal:number,
 *            msBetween:number, msWithin:number,
 *            etaSquared:number, omegaSquared:number,
 *            k:number, N:number, groupMeans:number[], groupSds:number[],
 *            groupNs:number[]}|null}
 */
export function oneWayAnova(groups) {
  if (!Array.isArray(groups) || groups.length < 2) return null;
  if (groups.some(g => !Array.isArray(g) || g.length < 2)) return null;

  const k = groups.length;
  const N = groups.reduce((s, g) => s + g.length, 0);
  const grand = mean(groups.flat());

  let ssB = 0;
  let ssW = 0;
  for (const g of groups) {
    const m = mean(g);
    ssB += g.length * Math.pow(m - grand, 2);
    for (const x of g) ssW += Math.pow(x - m, 2);
  }

  const dfB = k - 1;
  const dfW = N - k;
  const msB = ssB / dfB;
  const msW = ssW / dfW;
  const F = msB / msW;
  const p = fUpperTail(F, dfB, dfW);

  const ssT = ssB + ssW;
  const etaSquared = ssT === 0 ? NaN : ssB / ssT;
  const omegaSquared = (ssT + msW) === 0
    ? NaN
    : (ssB - dfB * msW) / (ssT + msW);

  return {
    F, dfBetween: dfB, dfWithin: dfW, p,
    ssBetween: ssB, ssWithin: ssW, ssTotal: ssT,
    msBetween: msB, msWithin: msW,
    etaSquared, omegaSquared,
    k, N,
    groupMeans: groups.map(mean),
    groupSds: groups.map(sd),
    groupNs: groups.map(g => g.length)
  };
}

/**
 * Welch's one-way ANOVA for k ≥ 2 independent groups whose variances may
 * differ (Welch 1951).
 *
 * Each group is weighted by w_i = n_i/s_i², and with W = Σw_i and the
 * weighted grand mean x̄_w = Σw_i x̄_i / W,
 *
 *   F = [Σ w_i (x̄_i − x̄_w)² / (k − 1)] / [1 + 2(k − 2)/(k² − 1) · Λ],
 *   Λ = Σ (1 − w_i/W)² / (n_i − 1),
 *
 * on k − 1 and (k² − 1)/(3Λ) degrees of freedom. This is R's
 * `oneway.test(var.equal = FALSE)` and statsmodels'
 * `anova_oneway(use_var='unequal')`; for two groups F is the square of
 * Welch's t and the second df is Welch–Satterthwaite's.
 *
 * The effect size is the ordinary eta squared, SS_between/SS_total: it
 * describes how much of the variation the groups account for, which does not
 * depend on the test. A group with zero variance would carry infinite weight,
 * so the statistic is then NaN with a note.
 *
 * @param {number[][]} groups
 * @returns {{F:number, df1:number, df2:number, p:number, k:number, N:number,
 *            etaSquared:number, groupMeans:number[], groupSds:number[],
 *            groupNs:number[], note:string|null}|null}
 *          null with fewer than two groups or a group of fewer than two.
 */
export function welchAnova(groups) {
  if (!Array.isArray(groups) || groups.length < 2) return null;
  if (groups.some(g => !Array.isArray(g) || g.length < 2)) return null;

  const k = groups.length;
  const ns = groups.map(g => g.length);
  const ms = groups.map(mean);
  const vs = groups.map(variance);
  const N = ns.reduce((s, n) => s + n, 0);

  const grand = mean(groups.flat());
  let ssB = 0;
  let ssT = 0;
  groups.forEach((g, i) => {
    ssB += ns[i] * (ms[i] - grand) * (ms[i] - grand);
    for (const x of g) ssT += (x - grand) * (x - grand);
  });

  const base = {
    k, N, etaSquared: ssT === 0 ? NaN : ssB / ssT,
    groupMeans: ms, groupSds: vs.map(Math.sqrt), groupNs: ns
  };
  if (vs.some(v => v === 0)) {
    return {
      F: NaN, df1: k - 1, df2: NaN, p: NaN, ...base,
      note: 'a group has zero variance, so its weight is undefined'
    };
  }

  const w = ns.map((n, i) => n / vs[i]);
  const W = w.reduce((s, x) => s + x, 0);
  const xw = w.reduce((s, wi, i) => s + wi * ms[i], 0) / W;
  let num = 0;
  let lambda = 0;
  for (let i = 0; i < k; i++) {
    num += w[i] * (ms[i] - xw) * (ms[i] - xw);
    lambda += ((1 - w[i] / W) ** 2) / (ns[i] - 1);
  }
  const F = (num / (k - 1)) / (1 + ((2 * (k - 2)) / (k * k - 1)) * lambda);
  const df1 = k - 1;
  const df2 = (k * k - 1) / (3 * lambda);
  return { F, df1, df2, p: fUpperTail(F, df1, df2), ...base, note: null };
}

/**
 * Pearson product–moment correlation with a Fisher-z confidence interval.
 *
 * @param {number[]} arr1
 * @param {number[]} arr2
 * @param {{conf?: number}} [options]
 * @returns {{r:number, r2:number, t:number, df:number, p:number,
 *            ci:[number,number], n:number}|null}
 */
export function pearsonCorrelation(arr1, arr2, options = {}) {
  const { conf = 0.95 } = options;
  const pair = alignPairs(arr1, arr2);
  const x = pair.a;
  const y = pair.b;
  const n = x.length;
  if (n < 3) return null;

  const mx = mean(x);
  const my = mean(y);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (x[i] - mx) * (y[i] - my);
    sxx += Math.pow(x[i] - mx, 2);
    syy += Math.pow(y[i] - my, 2);
  }

  // A constant variable has no correlation to measure.
  if (sxx === 0 || syy === 0) {
    return { r: NaN, r2: NaN, t: NaN, df: n - 2, p: NaN, ci: [NaN, NaN], n };
  }

  const r = sxy / Math.sqrt(sxx * syy);
  const df = n - 2;

  // Perfect correlation drives the t statistic to infinity; report p = 0.
  if (Math.abs(r) >= 1) {
    return { r, r2: r * r, t: Infinity * Math.sign(r), df, p: 0, ci: [r, r], n };
  }

  const t = r * Math.sqrt(df / (1 - r * r));
  const p = tTwoSided(t, df);

  const jStat = requireVendor('jStat');
  const z = 0.5 * Math.log((1 + r) / (1 - r));
  const sez = 1 / Math.sqrt(n - 3);
  const zc = jStat.normal.inv(1 - (1 - conf) / 2, 0, 1);
  const ci = [Math.tanh(z - zc * sez), Math.tanh(z + zc * sez)];

  return { r, r2: r * r, t, df, p, ci, n };
}

/**
 * Ordinary least-squares line of y on x, the line a scatter plot draws.
 *
 * It minimises vertical distances only, so swapping x and y gives a
 * different line; that is the regression of y on x, not a symmetric fit.
 *
 * @param {number[]} arr1 - x values.
 * @param {number[]} arr2 - y values, paired with x by position.
 * @returns {{slope:number, intercept:number, n:number}|null}
 *          null with fewer than two pairs; slope and intercept NaN when x is
 *          constant, since no line is defined.
 */
export function leastSquaresLine(arr1, arr2) {
  const { a: x, b: y } = alignPairs(arr1, arr2);
  const n = x.length;
  if (n < 2) return null;
  const mx = mean(x);
  const my = mean(y);
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (x[i] - mx) * (y[i] - my);
    sxx += (x[i] - mx) * (x[i] - mx);
  }
  if (sxx === 0) return { slope: NaN, intercept: NaN, n };
  const slope = sxy / sxx;
  return { slope, intercept: my - slope * mx, n };
}

/* ------------------------------------------------------------------ *
 * Non-parametric tests
 * ------------------------------------------------------------------ */

/**
 * Mann–Whitney U test, using the tie-corrected normal approximation.
 *
 * @param {number[]} arr1
 * @param {number[]} arr2
 * @returns {{U:number, U1:number, U2:number, z:number, p:number,
 *            rankBiserial:number, n1:number, n2:number,
 *            median1:number, median2:number, tieCorrected:boolean}|null}
 */
export function mannWhitneyU(arr1, arr2) {
  if (!Array.isArray(arr1) || !Array.isArray(arr2)) return null;
  const n1 = arr1.length;
  const n2 = arr2.length;
  if (n1 < 1 || n2 < 1) return null;

  const combined = arr1.concat(arr2);
  const r = ranks(combined);
  const R1 = r.slice(0, n1).reduce((s, x) => s + x, 0);
  const U1 = R1 - (n1 * (n1 + 1)) / 2;
  const U2 = n1 * n2 - U1;
  const U = Math.min(U1, U2);

  const muU = (n1 * n2) / 2;
  const counts = {};
  for (const v of combined) counts[v] = (counts[v] || 0) + 1;
  const N = n1 + n2;
  const tieTerm = Object.values(counts).reduce((s, t) => s + (t ** 3 - t), 0);
  const sigmaU = Math.sqrt(
    ((n1 * n2) / 12) * ((N + 1) - tieTerm / (N * (N - 1)))
  );

  if (!Number.isFinite(sigmaU) || sigmaU === 0) {
    return {
      U, U1, U2, z: NaN, p: NaN,
      rankBiserial: 1 - (2 * U) / (n1 * n2),
      n1, n2, median1: median(arr1), median2: median(arr2),
      tieCorrected: tieTerm > 0
    };
  }

  const z = (U - muU) / sigmaU;
  const p = zTwoSided(z);
  const rankBiserial = 1 - (2 * U) / (n1 * n2);

  return {
    U, U1, U2, z, p, rankBiserial,
    n1, n2, median1: median(arr1), median2: median(arr2),
    tieCorrected: tieTerm > 0
  };
}

/**
 * Wilcoxon signed-rank test for paired samples.
 *
 * Zero differences are discarded (Wilcoxon's original procedure) and the
 * normal approximation is applied to the remaining ranks.
 *
 * @param {number[]} arr1
 * @param {number[]} arr2
 * @returns {{W:number, wPositive:number, wNegative:number, z:number,
 *            p:number, effectR:number, n:number, nDropped:number}|null}
 */
export function wilcoxonSignedRank(arr1, arr2) {
  const pair = alignPairs(arr1, arr2);
  if (pair.a.length === 0) return null;

  const allDiffs = pair.a.map((v, i) => v - pair.b[i]);
  const diffs = allDiffs.filter(d => d !== 0);
  const n = diffs.length;
  const nDropped = allDiffs.length - n;
  if (n < 1) return null;

  const absRanks = ranks(diffs.map(Math.abs));
  let wPositive = 0;
  let wNegative = 0;
  diffs.forEach((d, i) => {
    if (d > 0) wPositive += absRanks[i];
    else wNegative += absRanks[i];
  });
  const W = Math.min(wPositive, wNegative);

  const muW = (n * (n + 1)) / 4;
  const sigmaW = Math.sqrt((n * (n + 1) * (2 * n + 1)) / 24);
  if (sigmaW === 0) {
    return { W, wPositive, wNegative, z: NaN, p: NaN, effectR: NaN, n, nDropped };
  }

  const z = (W - muW) / sigmaW;
  const p = zTwoSided(z);
  const effectR = Math.abs(z) / Math.sqrt(n);

  return { W, wPositive, wNegative, z, p, effectR, n, nDropped };
}

/**
 * One-sample Wilcoxon signed-rank test of a location against a stated value.
 *
 * The signed-rank test on the differences x − μ₀, with the conventions of
 * `wilcoxonSignedRank`: values equal to μ₀ are dropped, ties among the
 * absolute differences get average ranks, and z uses the normal approximation
 * with no continuity correction and no tie correction to its variance. It
 * assumes the distribution is symmetric about its median, and tests that
 * median against μ₀.
 *
 * @param {number[]} a
 * @param {number} [mu0=0]
 * @returns {{W:number, wPositive:number, wNegative:number, z:number,
 *            p:number, effectR:number, n:number, nDropped:number,
 *            mu0:number, median:number}|null}
 *          wPositive sums the ranks of values above μ₀.
 */
export function oneSampleWilcoxon(a, mu0 = 0) {
  if (!Array.isArray(a) || !Number.isFinite(mu0)) return null;
  const r = wilcoxonSignedRank(a, a.map(() => mu0));
  return r ? { ...r, mu0, median: median(a) } : null;
}

/**
 * Spearman's rank correlation, rho, with a confidence interval.
 *
 * Each variable is ranked with ties given their average rank, and rho is
 * Pearson's r on those ranks. That is exact with or without ties; the
 * textbook shortcut 1 − 6Σd²/(n(n²−1)) is not once ties are present. The
 * p-value refers t = rho·√((n−2)/(1−rho²)) to Student's t on n − 2 df, as
 * `scipy.stats.spearmanr` does, an approximation that is adequate from about
 * n = 10.
 *
 * The interval is a Fisher-z interval with the variance of Bonett & Wright
 * (2000), (1 + rho²/2)/(n − 3), in place of Pearson's 1/(n − 3), which is too
 * narrow for rho and undercovers as |rho| grows. It needs n ≥ 4.
 *
 * @param {number[]} arr1
 * @param {number[]} arr2
 * @param {{conf?: number}} [options]
 * @returns {{rho:number, t:number, df:number, p:number,
 *            ci:[number,number], n:number, ties:boolean}|null}
 *          null with fewer than three pairs; rho NaN when either variable is
 *          constant.
 */
export function spearmanCorrelation(arr1, arr2, options = {}) {
  const { conf = 0.95 } = options;
  const { a, b } = alignPairs(arr1, arr2);
  const n = a.length;
  if (n < 3) return null;

  const ties = new Set(a).size < n || new Set(b).size < n;
  const pr = pearsonCorrelation(ranks(a), ranks(b), { conf });
  const rho = pr.r;
  const df = n - 2;
  if (!Number.isFinite(rho)) {
    return { rho: NaN, t: NaN, df, p: NaN, ci: [NaN, NaN], n, ties };
  }
  if (Math.abs(rho) >= 1) {
    return { rho, t: Infinity * Math.sign(rho), df, p: 0, ci: [rho, rho], n, ties };
  }

  let ci = [NaN, NaN];
  if (n > 3) {
    const jStat = requireVendor('jStat');
    const z = Math.atanh(rho);
    const se = Math.sqrt((1 + (rho * rho) / 2) / (n - 3));
    const zc = jStat.normal.inv(1 - (1 - conf) / 2, 0, 1);
    ci = [Math.tanh(z - zc * se), Math.tanh(z + zc * se)];
  }
  return { rho, t: pr.t, df, p: pr.p, ci, n, ties };
}

/**
 * Kruskal–Wallis H test for k ≥ 2 independent groups.
 *
 * All observations are ranked together, ties taking their average rank, and
 *
 *   H = [12/(N(N+1)) Σ R_i²/n_i − 3(N+1)] / C,  C = 1 − Σ(t³ − t)/(N³ − N),
 *
 * where R_i is group i's rank sum and t runs over the sizes of the tied
 * runs. Dividing by C is the tie correction that `scipy.stats.kruskal` and
 * R's `kruskal.test` apply. The p-value is the chi-squared approximation on
 * k − 1 df; there is no exact small-sample distribution here, so with five
 * or fewer observations per group it is approximate.
 *
 * The effect size is epsilon squared, ε² = H/(N − 1), between 0 and 1
 * (Tomczak & Tomczak 2014).
 *
 * @param {number[][]} groups
 * @returns {{H:number, df:number, p:number, k:number, N:number,
 *            epsilonSquared:number, meanRanks:number[], rankSums:number[],
 *            groupNs:number[], groupMedians:number[],
 *            tieCorrection:number}|null}
 *          null with fewer than two groups or an empty group; H and p NaN
 *          when every observation is equal, since nothing can be ranked.
 */
export function kruskalWallis(groups) {
  if (!Array.isArray(groups) || groups.length < 2) return null;
  if (groups.some(g => !Array.isArray(g) || g.length < 1)) return null;

  const k = groups.length;
  const all = groups.flat();
  const N = all.length;
  const r = ranks(all);

  const groupNs = groups.map(g => g.length);
  const rankSums = [];
  let offset = 0;
  for (const n of groupNs) {
    let s = 0;
    for (let i = offset; i < offset + n; i++) s += r[i];
    rankSums.push(s);
    offset += n;
  }
  const meanRanks = rankSums.map((s, i) => s / groupNs[i]);

  const counts = new Map();
  for (const v of all) counts.set(v, (counts.get(v) || 0) + 1);
  let tieSum = 0;
  for (const t of counts.values()) tieSum += t * t * t - t;
  const C = 1 - tieSum / (N * N * N - N);

  const base = {
    df: k - 1, k, N, meanRanks, rankSums, groupNs,
    groupMedians: groups.map(median), tieCorrection: C
  };
  if (!(C > 0)) return { H: NaN, p: NaN, epsilonSquared: NaN, ...base };

  let s = 0;
  for (let i = 0; i < k; i++) s += (rankSums[i] * rankSums[i]) / groupNs[i];
  const H = ((12 / (N * (N + 1))) * s - 3 * (N + 1)) / C;
  // Rounding can leave H a hair below zero when the groups are identical.
  const Hc = Math.max(0, H);
  return {
    H: Hc, p: chiSquaredUpperTail(Hc, k - 1),
    epsilonSquared: Hc / (N - 1), ...base
  };
}

/* ------------------------------------------------------------------ *
 * Post-hoc pairwise comparisons
 * ------------------------------------------------------------------ */

/**
 * Upper-tail probability of the studentized range, P(Q ≥ q) for k means and
 * df error degrees of freedom.
 *
 * Taken as 1 − cdf from jStat's `tukey.cdf`, a port of R's `ptukey`
 * (Copenhaver & Holland 1988). It agrees with
 * `scipy.stats.studentized_range.sf` to about 1e-9 absolute, including for
 * non-integer df, so a tail below that carries no relative precision. Such
 * p-values are reported as "< .001" in any case.
 *
 * @param {number} q
 * @param {number} k - Number of means, ≥ 2.
 * @param {number} df
 * @returns {number}
 */
export function qUpperTail(q, k, df) {
  const jStat = requireVendor('jStat');
  if (!Number.isFinite(q) || !Number.isFinite(k) || !Number.isFinite(df) || k < 2 || df <= 0) {
    return NaN;
  }
  if (q <= 0) return 1;
  return Math.min(1, Math.max(0, 1 - jStat.tukey.cdf(q, k, df)));
}

/**
 * Adjust a family of p-values for multiple comparisons.
 *
 * `holm` is Holm's (1979) step-down procedure: sort ascending, multiply the
 * i-th smallest by (m − i + 1), carry the running maximum so the order is
 * kept, cap at 1. It controls the family-wise error rate exactly as
 * Bonferroni does and is never less powerful, so it is the default.
 * `bonferroni` multiplies every p by m; `none` returns them unchanged.
 * Non-finite entries stay NaN and do not count towards m.
 *
 * @param {number[]} pvalues
 * @param {'holm'|'bonferroni'|'none'} [method='holm']
 * @returns {number[]} Adjusted p-values in the input order.
 */
export function adjustPValues(pvalues, method = 'holm') {
  if (!Array.isArray(pvalues)) return [];
  const out = pvalues.map(p => (Number.isFinite(p) ? p : NaN));
  const idx = out.map((p, i) => i).filter(i => Number.isFinite(out[i]));
  const m = idx.length;
  if (method === 'none' || m === 0) return out;
  if (method === 'bonferroni') {
    for (const i of idx) out[i] = Math.min(1, out[i] * m);
    return out;
  }
  if (method !== 'holm') throw new Error(`adjustPValues: unknown method "${method}"`);
  idx.sort((x, y) => out[x] - out[y]);
  let running = 0;
  idx.forEach((i, rank) => {
    running = Math.max(running, Math.min(1, out[i] * (m - rank)));
    out[i] = running;
  });
  return out;
}

/**
 * Tukey's honestly significant difference test: every pairwise difference of
 * means after a one-way ANOVA.
 *
 * The Tukey–Kramer form (Kramer 1956), which allows unequal group sizes:
 * with the ANOVA's pooled within-group mean square MS_W on N − k df,
 *
 *   q = |x̄_i − x̄_j| / √(MS_W/2 · (1/n_i + 1/n_j)),
 *
 * referred to the studentized range for k means. The interval is
 * (x̄_i − x̄_j) ± q_crit · SE. Both are simultaneous for the whole family of
 * k(k − 1)/2 comparisons, so `pAdjusted` needs no further correction. Because
 * MS_W is pooled, this assumes equal variances; with unequal variances use
 * `gamesHowell`. Matches `scipy.stats.tukey_hsd`.
 *
 * @param {number[][]} groups
 * @param {{conf?: number}} [options]
 * @returns {{method:string, comparisons:Array<{i:number, j:number,
 *            diff:number, se:number, q:number, df:number, pAdjusted:number,
 *            ci:[number,number]}>, k:number, df:number, msWithin:number,
 *            qCrit:number, conf:number}|null}
 *          `diff` is mean i minus mean j, for i < j.
 */
export function tukeyHSD(groups, options = {}) {
  const { conf = 0.95 } = options;
  const a = oneWayAnova(groups);
  if (!a) return null;
  const jStat = requireVendor('jStat');
  const { k, dfWithin: df, msWithin: ms, groupMeans: m, groupNs: n } = a;
  const qCrit = jStat.tukey.inv(conf, k, df);

  const comparisons = [];
  for (let i = 0; i < k; i++) {
    for (let j = i + 1; j < k; j++) {
      const diff = m[i] - m[j];
      const se = Math.sqrt((ms / 2) * (1 / n[i] + 1 / n[j]));
      const q = se > 0 ? Math.abs(diff) / se : NaN;
      comparisons.push({
        i, j, diff, se, q, df,
        pAdjusted: qUpperTail(q, k, df),
        ci: [diff - qCrit * se, diff + qCrit * se]
      });
    }
  }
  return { method: 'Tukey HSD', comparisons, k, df, msWithin: ms, qCrit, conf };
}

/**
 * Games–Howell pairwise comparisons, the counterpart of Tukey's HSD when
 * variances differ, as after Welch's ANOVA (Games & Howell 1976).
 *
 * Each pair keeps its own standard error and Welch–Satterthwaite df:
 *
 *   SE = √(s_i²/n_i + s_j²/n_j),  t = (x̄_i − x̄_j)/SE,
 *
 * and |t|·√2 is referred to the studentized range for k means on that df.
 * The interval is (x̄_i − x̄_j) ± q_crit/√2 · SE. Like Tukey's, the p-values
 * and intervals already cover the whole family. SciPy has no Games–Howell;
 * the tests check it against the formula with
 * `scipy.stats.studentized_range`.
 *
 * @param {number[][]} groups
 * @param {{conf?: number}} [options]
 * @returns {{method:string, comparisons:Array<{i:number, j:number,
 *            diff:number, se:number, t:number, df:number, pAdjusted:number,
 *            ci:[number,number]}>, k:number, conf:number}|null}
 */
export function gamesHowell(groups, options = {}) {
  const { conf = 0.95 } = options;
  if (!Array.isArray(groups) || groups.length < 2) return null;
  if (groups.some(g => !Array.isArray(g) || g.length < 2)) return null;
  const jStat = requireVendor('jStat');
  const k = groups.length;
  const n = groups.map(g => g.length);
  const m = groups.map(mean);
  const v = groups.map(variance);

  const comparisons = [];
  for (let i = 0; i < k; i++) {
    for (let j = i + 1; j < k; j++) {
      const vi = v[i] / n[i];
      const vj = v[j] / n[j];
      const se = Math.sqrt(vi + vj);
      const diff = m[i] - m[j];
      if (!(se > 0)) {
        comparisons.push({ i, j, diff, se, t: NaN, df: NaN, pAdjusted: NaN, ci: [NaN, NaN] });
        continue;
      }
      const df = (vi + vj) ** 2 / (vi * vi / (n[i] - 1) + vj * vj / (n[j] - 1));
      const t = diff / se;
      const half = (jStat.tukey.inv(conf, k, df) / Math.SQRT2) * se;
      comparisons.push({
        i, j, diff, se, t, df,
        pAdjusted: qUpperTail(Math.abs(t) * Math.SQRT2, k, df),
        ci: [diff - half, diff + half]
      });
    }
  }
  return { method: 'Games-Howell', comparisons, k, conf };
}

/**
 * Dunn's test of every pairwise difference after a Kruskal–Wallis test
 * (Dunn 1964).
 *
 * It uses the mean ranks from the joint ranking of all groups, not a fresh
 * ranking of each pair, so it stays consistent with the omnibus H. With the
 * tie-corrected variance
 *
 *   σ² = [N(N+1)/12 − Σ(t³ − t)/(12(N − 1))] · (1/n_i + 1/n_j)
 *      = C · N(N+1)/12 · (1/n_i + 1/n_j),
 *
 * where C is Kruskal–Wallis' tie correction, z = (R̄_i − R̄_j)/σ gives a
 * two-sided normal p-value, with no continuity correction. The p-values are
 * then adjusted across all k(k − 1)/2 pairs, by Holm's method unless asked
 * otherwise (see `adjustPValues`). A difference in mean ranks has no
 * confidence interval in the units of the data, so none is given.
 *
 * @param {number[][]} groups
 * @param {{adjust?: 'holm'|'bonferroni'|'none'}} [options]
 * @returns {{method:string, adjust:string, comparisons:Array<{i:number,
 *            j:number, meanRankDiff:number, z:number, p:number,
 *            pAdjusted:number}>, k:number, N:number,
 *            meanRanks:number[]}|null}
 */
export function dunnTest(groups, options = {}) {
  const { adjust = 'holm' } = options;
  const kw = kruskalWallis(groups);
  if (!kw) return null;
  const { k, N, meanRanks, groupNs: n, tieCorrection: C } = kw;

  const comparisons = [];
  for (let i = 0; i < k; i++) {
    for (let j = i + 1; j < k; j++) {
      const d = meanRanks[i] - meanRanks[j];
      const sigma = Math.sqrt(C * (N * (N + 1) / 12) * (1 / n[i] + 1 / n[j]));
      const z = sigma > 0 ? d / sigma : NaN;
      comparisons.push({ i, j, meanRankDiff: d, z, p: zTwoSided(z), pAdjusted: NaN });
    }
  }
  const adj = adjustPValues(comparisons.map(c => c.p), adjust);
  comparisons.forEach((c, idx) => { c.pAdjusted = adj[idx]; });
  return { method: "Dunn's test", adjust, comparisons, k, N, meanRanks };
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/**
 * Truncate two arrays to a common length so they can be treated as pairs.
 *
 * @param {number[]} a
 * @param {number[]} b
 * @returns {{a:number[], b:number[]}}
 */
export function alignPairs(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return { a: [], b: [] };
  const n = Math.min(a.length, b.length);
  return { a: a.slice(0, n), b: b.slice(0, n) };
}

/**
 * Format a p-value in APA style (leading zero removed, "< .001" floor).
 *
 * @param {number} p
 * @returns {string}
 */
export function formatP(p) {
  if (!Number.isFinite(p)) return 'n/a';
  if (p < 0.001) return '< .001';
  return p.toFixed(3).replace(/^0/, '');
}

/**
 * Conventional verbal label for a Cohen's d magnitude (Cohen 1988).
 *
 * @param {number} d - Absolute effect size.
 * @returns {string}
 */
export function interpretD(d) {
  const a = Math.abs(d);
  if (!Number.isFinite(a)) return 'undefined';
  if (a < 0.2) return 'negligible';
  if (a < 0.5) return 'small';
  if (a < 0.8) return 'medium';
  return 'large';
}

/**
 * Conventional verbal label for an eta-squared magnitude.
 *
 * @param {number} e
 * @returns {string}
 */
export function interpretEta(e) {
  if (!Number.isFinite(e)) return 'undefined';
  if (e < 0.01) return 'negligible';
  if (e < 0.06) return 'small';
  if (e < 0.14) return 'medium';
  return 'large';
}

/**
 * Conventional verbal label for a correlation magnitude.
 *
 * @param {number} r - Absolute correlation.
 * @returns {string}
 */
export function interpretR(r) {
  const a = Math.abs(r);
  if (!Number.isFinite(a)) return 'undefined';
  if (a < 0.1) return 'negligible';
  if (a < 0.3) return 'weak';
  if (a < 0.5) return 'moderate';
  return 'strong';
}

/**
 * Classify data columns as numeric or categorical.
 *
 * A column is numeric when at least 80% of its non-empty values parse as
 * numbers. A column is a grouping candidate when it is mostly non-numeric, or
 * when it is a numeric code taking few distinct values.
 *
 * @param {object[]} rows - Parsed row objects.
 * @param {string[]} fields - Column names.
 * @returns {{numeric:string[], categorical:string[]}}
 */
export function classifyFields(rows, fields) {
  const numeric = [];
  const categorical = [];
  if (!Array.isArray(rows) || !Array.isArray(fields)) return { numeric, categorical };

  for (const f of fields) {
    let nNum = 0;
    let nNonEmpty = 0;
    const distinct = new Set();
    for (const r of rows) {
      const v = r[f];
      if (v === null || v === undefined || v === '') continue;
      nNonEmpty++;
      if (typeof v === 'number' && !Number.isNaN(v)) nNum++;
      distinct.add(v);
    }
    if (nNonEmpty === 0) continue;

    const numericRatio = nNum / nNonEmpty;
    if (numericRatio >= 0.8) numeric.push(f);
    if (numericRatio < 0.8 ||
        (distinct.size >= 2 && distinct.size <= Math.max(10, rows.length / 3))) {
      categorical.push(f);
    }
  }
  return { numeric, categorical };
}

/**
 * Pivot long/tidy rows into one numeric array per level of a grouping column.
 *
 * Group order follows first appearance, so results are stable and match the
 * order a reader sees in the source file.
 *
 * @param {object[]} rows
 * @param {string} valueCol
 * @param {string} groupCol
 * @returns {{groups:Object<string,number[]>, order:string[]}}
 */
export function pivotLongToGroups(rows, valueCol, groupCol) {
  const groups = {};
  const order = [];
  if (!Array.isArray(rows) || !valueCol || !groupCol || valueCol === groupCol) {
    return { groups, order };
  }

  for (const r of rows) {
    const val = r[valueCol];
    const grp = r[groupCol];
    if (grp === null || grp === undefined || grp === '') continue;
    if (typeof val !== 'number' || Number.isNaN(val)) continue;
    const key = String(grp);
    if (!(key in groups)) {
      groups[key] = [];
      order.push(key);
    }
    groups[key].push(val);
  }
  return { groups, order: order.filter(k => groups[k].length > 0) };
}
