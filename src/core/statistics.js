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
  const m = mean(a);

  // Population standard deviation (n denominator).
  let ss = 0;
  for (const x of a) ss += (x - m) * (x - m);
  const sPop = Math.sqrt(ss / n);
  if (sPop === 0) return 0;

  let g1 = 0;
  for (const x of a) g1 += Math.pow((x - m) / sPop, 3);
  g1 /= n;
  return (Math.sqrt(n * (n - 1)) / (n - 2)) * g1;
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
 * Upper-tail p-value from the chi-squared distribution.
 *
 * jStat exposes only the lower regularised incomplete gamma, so the upper tail
 * is obtained by subtraction and saturates at 0 once the lower tail rounds to
 * 1. For the common df = 2 case the closed form Q(1, x/2) = exp(-x/2) is used
 * instead, which stays exact; other degrees of freedom fall back to the
 * subtraction and are floored at the smallest representable positive double so
 * that a p-value is never reported as identically zero.
 *
 * @param {number} x
 * @param {number} df
 * @returns {number} P(X >= x).
 */
export function chiSquaredUpperTail(x, df) {
  const jStat = requireVendor('jStat');
  if (!Number.isFinite(x) || !Number.isFinite(df) || df <= 0) return NaN;
  if (x <= 0) return 1;

  // Exact closed form for two degrees of freedom (the D'Agostino K^2 case).
  if (df === 2) return Math.exp(-x / 2);

  const q = 1 - jStat.lowRegGamma(df / 2, x / 2);
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

  const b1 = skewness(a);
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
