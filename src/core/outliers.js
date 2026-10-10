/**
 * @module core/outliers
 *
 * Outlier-detection routines extracted from STEMKit's Outlier Detector.
 *
 * Three complementary methods are provided, plus Grubbs' formal test:
 *
 *   - **Z-score**, mean/SD based. Fast and familiar, but the statistics it
 *     relies on are themselves distorted by the outliers being sought
 *     (masking), so it is unreliable when contamination exceeds a few percent.
 *   - **Modified Z-score**, median/MAD based (Iglewicz & Hoaglin 1993). The
 *     MAD has a 50% breakdown point, so the criterion stays valid until half
 *     the sample is contaminated: the one to prefer when the number of
 *     outliers is unknown. (The page opens on the Z-score, the familiar rule,
 *     and its example shows where the two part.)
 *   - **Tukey IQR fence**, distribution-free; flags points beyond
 *     Q1 - k·IQR or Q3 + k·IQR (k = 1.5 conventionally, 3.0 for "far out").
 *   - **Grubbs' test**, a significance test for a single outlier in
 *     approximately normal data, reporting a p-value rather than a flag.
 *
 * All functions are pure and index-preserving: results reference positions in
 * the *input* array so callers can map flags back to original table rows.
 *
 * Each rule divides by, or builds its fences from, an estimate of spread (the
 * SD, the MAD, the IQR), and each estimate can be zero: the SD when every
 * value is the same, the MAD when more than half are, the IQR when the middle
 * half are. The rules are applied as their authors wrote them even then, and
 * the result says so: `degenerate` is true and `warning` holds a sentence for
 * the reader, because flags that come from a spread of zero say how many
 * values differ, not how far.
 */

import { requireVendor } from './vendor.js';

/** Scale factor making the MAD a consistent estimator of sigma under normality. */
export const MAD_TO_SIGMA = 0.6745;

/**
 * Scale factor for the mean-absolute-deviation fallback: sqrt(pi/2), the ratio
 * of sigma to the mean absolute deviation under normality. The fallback is the
 * one IBM's statistics documentation gives for a MAD of zero ("Modified z
 * score": (x - median)/(1.253314 MeanAD)).
 */
export const MEANAD_TO_SIGMA = 1.253314;

/*
 * Whether every value is the same number. A constant sample is told by its
 * values, not by a computed spread: the mean of six copies of 0.1 comes out as
 * 0.09999999999999999, which leaves a standard deviation of 1.5e-17, not 0,
 * while six copies of 0.3 give exactly 0.
 */
function isConstant(values) {
  for (let i = 1; i < values.length; i++) {
    if (values[i] !== values[0]) return false;
  }
  return true;
}

/* The mean and the sample (n-1) standard deviation, which is exactly 0 for a constant sample. */
function meanAndSD(values) {
  const n = values.length;
  const mean = values.reduce((s, x) => s + x, 0) / n;
  if (n < 2 || isConstant(values)) return { mean, sd: 0 };
  let ss = 0;
  for (const v of values) ss += (v - mean) * (v - mean);
  return { mean, sd: Math.sqrt(ss / (n - 1)) };
}

const SAME = 'Every value is the same';

/**
 * Median of an array. Sorts a copy; the input is not modified.
 *
 * @param {number[]} values
 * @returns {number} The median, or NaN for empty input.
 */
export function median(values) {
  if (!Array.isArray(values) || values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

/**
 * Median absolute deviation from the median.
 *
 * @param {number[]} values
 * @returns {number} The MAD, or NaN for empty input.
 */
export function medianAbsoluteDeviation(values) {
  if (!Array.isArray(values) || values.length === 0) return NaN;
  const med = median(values);
  return median(values.map(v => Math.abs(v - med)));
}

/**
 * Quartiles by linear interpolation between order statistics.
 *
 * Uses the same definition as `numpy.percentile(..., method='linear')` and R's
 * `quantile(..., type=7)`, which is the most widely reported convention. Note
 * that this differs from the hinge-based definition used in some textbooks;
 * for large samples the distinction is negligible.
 *
 * @param {number[]} values
 * @returns {{q1:number, q2:number, q3:number, iqr:number}|null}
 */
export function quartiles(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const n = s.length;

  const at = (p) => {
    const h = (n - 1) * p;
    const lo = Math.floor(h);
    const hi = Math.ceil(h);
    if (lo === hi) return s[lo];
    return s[lo] + (h - lo) * (s[hi] - s[lo]);
  };

  const q1 = at(0.25);
  const q2 = at(0.5);
  const q3 = at(0.75);
  return { q1, q2, q3, iqr: q3 - q1 };
}

/**
 * Standard Z-scores, using the sample (n-1) standard deviation.
 *
 * @param {number[]} values
 * @returns {number[]} Signed Z-scores; all zero when the sample has no spread.
 */
export function zScores(values) {
  if (!Array.isArray(values) || values.length === 0) return [];
  const { mean, sd } = meanAndSD(values);

  // Zero spread means no point can be anomalous; return zeros rather than NaN.
  if (!(sd > 0)) return values.map(() => 0);
  return values.map(v => (v - mean) / sd);
}

/**
 * Modified Z-scores (Iglewicz & Hoaglin 1993).
 *
 * Defined as 0.6745·(x - median)/MAD. When more than half the observations are
 * identical the MAD collapses to zero; the mean absolute deviation is then
 * substituted, with its own consistency constant, so the score stays finite.
 * The score of a value that differs is then its share of the total deviation:
 * one value apart from n - 1 equal ones scores n/1.253314 whatever the size
 * of the difference, which is above 3.5 from n = 5.
 *
 * @param {number[]} values
 * @returns {number[]} Signed modified Z-scores.
 */
export function modifiedZScores(values) {
  if (!Array.isArray(values) || values.length === 0) return [];
  const med = median(values);
  const absDev = values.map(v => Math.abs(v - med));
  const mad = median(absDev);

  if (mad > 0) {
    return values.map(v => (MAD_TO_SIGMA * (v - med)) / mad);
  }

  const meanAD = absDev.reduce((a, b) => a + b, 0) / absDev.length;
  if (meanAD === 0) return values.map(() => 0);
  return values.map(v => (v - med) / (MEANAD_TO_SIGMA * meanAD));
}

/**
 * Detect outliers by absolute Z-score.
 *
 * @param {number[]} values
 * @param {number} [threshold=3] - Flag when |z| exceeds this value.
 * @returns {{indices:number[], scores:number[], threshold:number,
 *            method:string, degenerate:boolean, warning:string|null}}
 *          `degenerate` is true when the sample has zero spread (every value
 *          the same): nothing is flagged, and `warning` says why.
 */
export function detectZScore(values, threshold = 3) {
  const scores = zScores(values);
  const indices = [];
  for (let i = 0; i < scores.length; i++) {
    if (Math.abs(scores[i]) > threshold) indices.push(i);
  }
  const degenerate = Array.isArray(values) && values.length > 1 && !(meanAndSD(values).sd > 0);
  return {
    indices,
    scores,
    threshold,
    method: 'zscore',
    degenerate,
    warning: degenerate
      ? `${SAME}, so the standard deviation is zero and no value can be flagged.`
      : null
  };
}

/**
 * Detect outliers by modified Z-score.
 *
 * @param {number[]} values
 * @param {number} [threshold=3.5] - The conventional cut-off of Iglewicz &
 *        Hoaglin, corresponding to roughly a 3.5-sigma normal deviate.
 * @returns {{indices:number[], scores:number[], threshold:number,
 *            method:string, usedFallback:boolean, degenerate:boolean,
 *            warning:string|null}}
 *          `usedFallback` and `degenerate` are true when the MAD is zero (more
 *          than half the values equal). The flags are then the fallback's,
 *          and `warning` says what they mean; with every value the same
 *          nothing is flagged.
 */
export function detectModifiedZScore(values, threshold = 3.5) {
  const scores = modifiedZScores(values);
  const indices = [];
  for (let i = 0; i < scores.length; i++) {
    if (Math.abs(scores[i]) > threshold) indices.push(i);
  }
  const some = Array.isArray(values) && values.length > 0;
  const usedFallback = some && !(medianAbsoluteDeviation(values) > 0);
  const degenerate = usedFallback && values.length > 1;
  let warning = null;
  if (degenerate && isConstant(values)) {
    warning = `${SAME}, so the median absolute deviation (MAD) is zero and no value can be flagged.`;
  } else if (degenerate) {
    warning = `More than half the values are equal (${median(values)}), so the median absolute ` +
      'deviation (MAD) is zero and the modified Z-score cannot be formed with it. The mean absolute ' +
      'deviation stands in, so a value is scored against the few that differ, not against the ' +
      'spread of the rest: it can be flagged however little it differs.';
  }
  return {
    indices,
    scores,
    threshold,
    method: 'modzscore',
    usedFallback,
    degenerate,
    warning
  };
}

/**
 * Detect outliers using Tukey's inter-quartile fences.
 *
 * When the middle half of the values are equal the IQR is zero and both
 * fences sit on that value, so the rule, applied as written, puts every value
 * that differs outside them (matplotlib's `cbook.boxplot_stats` and R's
 * `boxplot.stats` do the same). The flags are kept and `warning` says so.
 *
 * @param {number[]} values
 * @param {number} [k=1.5] - Fence multiplier; 1.5 flags "outliers", 3.0 flags
 *        "far out" points in Tukey's original terminology.
 * @returns {{indices:number[], lower:number, upper:number, q1:number,
 *            q3:number, iqr:number, threshold:number, method:string,
 *            degenerate:boolean, warning:string|null}|null}
 *          `degenerate` is true when the IQR is zero.
 */
export function detectIQR(values, k = 1.5) {
  const q = quartiles(values);
  if (q === null) return null;

  const lower = q.q1 - k * q.iqr;
  const upper = q.q3 + k * q.iqr;
  const indices = [];
  for (let i = 0; i < values.length; i++) {
    if (values[i] < lower || values[i] > upper) indices.push(i);
  }
  const degenerate = values.length > 1 && q.iqr === 0;
  let warning = null;
  if (degenerate && isConstant(values)) {
    warning = `${SAME}, so the interquartile range is zero and no value can be flagged.`;
  } else if (degenerate) {
    warning = `The middle half of the values are all equal (${q.q1}), so the interquartile range ` +
      'is zero and both fences sit on that value: every value that differs from it is flagged, ' +
      'however small the difference.';
  }
  return {
    indices, lower, upper,
    q1: q.q1, q3: q.q3, iqr: q.iqr,
    threshold: k, method: 'iqr',
    degenerate, warning
  };
}

/**
 * Grubbs' test for a single outlier in an approximately normal sample.
 *
 * The statistic G = max|x - mean| / sd is referred to its exact critical
 * distribution, derived from the Student t quantile at alpha/(2n):
 *
 *   G_crit = ((n-1)/sqrt(n)) · sqrt(t² / (n - 2 + t²))
 *
 * Requires n >= 3. Unlike the flagging methods above this returns a p-value,
 * making it appropriate when a formal decision is needed rather than a
 * screening heuristic.
 *
 * @param {number[]} values
 * @param {number} [alpha=0.05] - Two-sided significance level.
 * @returns {{G:number, critical:number, p:number, index:number,
 *            value:number, isOutlier:boolean, n:number}|null}
 *          Null when n < 3 or the sample has zero spread.
 */
export function grubbsTest(values, alpha = 0.05) {
  const jStat = requireVendor('jStat');
  if (!Array.isArray(values) || values.length < 3) return null;

  const n = values.length;
  const { mean, sd } = meanAndSD(values);
  if (!(sd > 0)) return null;

  let index = 0;
  let maxDev = -Infinity;
  for (let i = 0; i < n; i++) {
    const dev = Math.abs(values[i] - mean);
    if (dev > maxDev) {
      maxDev = dev;
      index = i;
    }
  }

  const G = maxDev / sd;
  const tCrit = jStat.studentt.inv(alpha / (2 * n), n - 2);
  const t2 = tCrit * tCrit;
  const critical = ((n - 1) / Math.sqrt(n)) * Math.sqrt(t2 / (n - 2 + t2));

  // Invert the critical-value relation to obtain the attained p-value.
  const gg = G * G;
  const tObsSq = ((n - 2) * gg) / (((n - 1) * (n - 1)) / n - gg);
  let p;
  if (tObsSq <= 0 || !Number.isFinite(tObsSq)) {
    p = 0;
  } else {
    const tObs = Math.sqrt(tObsSq);
    p = Math.min(1, 2 * n * (1 - jStat.studentt.cdf(tObs, n - 2)));
  }

  return {
    G,
    critical,
    p,
    index,
    value: values[index],
    isOutlier: G > critical,
    n
  };
}

/**
 * Dispatch to a named detection method.
 *
 * @param {number[]} values
 * @param {'zscore'|'modzscore'|'iqr'} method
 * @param {number} threshold
 * @returns {{indices:number[], method:string, degenerate:boolean,
 *            warning:string|null}|null}
 */
export function detectOutliers(values, method, threshold) {
  switch (method) {
    case 'zscore':
      return detectZScore(values, threshold ?? 3);
    case 'modzscore':
      return detectModifiedZScore(values, threshold ?? 3.5);
    case 'iqr':
      return detectIQR(values, threshold ?? 1.5);
    default:
      return null;
  }
}

/**
 * Extract a numeric column while recording each value's original row index.
 *
 * Detection runs on the compacted vector; `indexMap` restores the mapping back
 * to the source table so that flags land on the right rows even when the
 * column contains gaps or non-numeric entries.
 *
 * @param {object[]} rows
 * @param {string} column
 * @returns {{values:number[], indexMap:number[]}}
 */
export function extractNumericColumn(rows, column) {
  const values = [];
  const indexMap = [];
  if (!Array.isArray(rows)) return { values, indexMap };

  rows.forEach((row, i) => {
    const v = row ? row[column] : undefined;
    if (typeof v === 'number' && Number.isFinite(v)) {
      values.push(v);
      indexMap.push(i);
    }
  });
  return { values, indexMap };
}

/**
 * Translate detected positions back to original row indices.
 *
 * @param {number[]} detected - Positions within the compacted vector.
 * @param {number[]} indexMap - Mapping produced by `extractNumericColumn`.
 * @returns {number[]} Original row indices.
 */
export function mapToRowIndices(detected, indexMap) {
  if (!Array.isArray(detected) || !Array.isArray(indexMap)) return [];
  return detected
    .map(i => indexMap[i])
    .filter(i => i !== undefined);
}

/**
 * Partition rows into retained and flagged sets.
 *
 * @param {object[]} rows
 * @param {number[]} flaggedIndices - Original row indices to flag.
 * @returns {{clean:object[], flagged:object[]}}
 */
export function partitionRows(rows, flaggedIndices) {
  if (!Array.isArray(rows)) return { clean: [], flagged: [] };
  const flagSet = new Set(flaggedIndices || []);
  const clean = [];
  const flagged = [];
  rows.forEach((row, i) => {
    if (flagSet.has(i)) flagged.push(row);
    else clean.push(row);
  });
  return { clean, flagged };
}
