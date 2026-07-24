/**
 * @module core/error-bars
 *
 * Group summary statistics and error-bar computation, extracted from STEMKit's
 * Error Bar Generator.
 *
 * The distinction between the three error measures is worth stating plainly,
 * because plotting the wrong one is a common and consequential mistake:
 *
 *   - **SD** describes the spread of the observations. It does not shrink as
 *     more data is collected.
 *   - **SEM** = SD/sqrt(n) describes the precision of the *mean*. It shrinks
 *     with n, which is why SEM bars look reassuringly small and are sometimes
 *     chosen for that reason rather than for a statistical one.
 *   - **CI** = t* x SEM gives an interval with a stated coverage probability.
 *     It is the only one of the three that supports a direct inferential
 *     reading.
 *
 * `errorLabel` therefore always names the measure, so a figure caption
 * generated from this module can never be ambiguous about what its bars mean.
 */

import { requireVendor } from './vendor.js';

/**
 * Arithmetic mean.
 *
 * @param {number[]} values
 * @returns {number}
 */
export function mean(values) {
  if (!Array.isArray(values) || values.length === 0) return NaN;
  return values.reduce((s, x) => s + x, 0) / values.length;
}

/**
 * Sample standard deviation (n-1 denominator).
 *
 * @param {number[]} values
 * @returns {number} Zero for a single observation, by convention.
 */
export function sd(values) {
  if (!Array.isArray(values) || values.length === 0) return NaN;
  if (values.length === 1) return 0;
  const m = mean(values);
  let ss = 0;
  for (const v of values) ss += (v - m) * (v - m);
  return Math.sqrt(ss / (values.length - 1));
}

/**
 * Median.
 *
 * @param {number[]} values
 * @returns {number}
 */
export function median(values) {
  if (!Array.isArray(values) || values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

/**
 * Quantile by linear interpolation between order statistics.
 *
 * Matches `numpy.percentile(..., method='linear')` and R's type 7.
 *
 * @param {number[]} values
 * @param {number} p - Probability in [0, 1].
 * @returns {number}
 */
export function quantile(values, p) {
  if (!Array.isArray(values) || values.length === 0) return NaN;
  if (!Number.isFinite(p) || p < 0 || p > 1) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const h = (s.length - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  if (lo === hi) return s[lo];
  return s[lo] + (h - lo) * (s[hi] - s[lo]);
}

/**
 * Summary statistics for one group of replicates.
 *
 * @param {string} key - Group label.
 * @param {number[]} values
 * @param {number} [level=0.95] - Confidence level for the interval.
 * @returns {{
 *   key:string, n:number, mean:number, sd:number, sem:number,
 *   t:number, ci:number, level:number, median:number,
 *   q1:number, q3:number, iqr:number, cv:number,
 *   min:number, max:number
 * }|null}
 */
export function summariseGroup(key, values, level = 0.95) {
  const jStat = requireVendor('jStat');
  if (!Array.isArray(values) || values.length === 0) return null;

  const n = values.length;
  const m = mean(values);
  const s = n > 1 ? sd(values) : 0;
  const sem = n > 0 ? s / Math.sqrt(n) : 0;

  // A single observation gives no estimate of dispersion, so the interval is
  // undefined rather than zero-width; t* is reported as 0 to signal that.
  const p = 1 - (1 - level) / 2;
  const tStar = n > 1 ? jStat.studentt.inv(p, n - 1) : 0;

  const q1 = quantile(values, 0.25);
  const q3 = quantile(values, 0.75);

  return {
    key: String(key),
    n,
    mean: m,
    sd: s,
    sem,
    t: tStar,
    ci: tStar * sem,
    level,
    median: median(values),
    q1,
    q3,
    iqr: q3 - q1,
    cv: m !== 0 ? (s / Math.abs(m)) * 100 : 0,
    min: Math.min(...values),
    max: Math.max(...values)
  };
}

/**
 * Decide whether the first row of a table is a header.
 *
 * A header row is one whose value cells are all non-numeric while at least one
 * later row has numeric values there. Detecting this rather than trusting a
 * checkbox means a pasted spreadsheet works on the first try.
 *
 * @param {Array<Array<*>>} rows
 * @returns {boolean}
 */
export function detectHeaderRow(rows) {
  if (!Array.isArray(rows) || rows.length < 2) return false;
  const isNum = (v) => typeof v === 'number' && !Number.isNaN(v);
  const firstAllText = rows[0].slice(1).every(c => !isNum(c));
  const laterHasNumbers = rows.slice(1).some(r => r.slice(1).some(isNum));
  return firstAllText && laterHasNumbers;
}

/**
 * Group rows by their first-column label, pooling the numeric cells.
 *
 * Repeated labels accumulate, so replicates may be spread across several rows.
 *
 * @param {Array<Array<*>>} rows
 * @returns {{groups:Map<string, number[]>, skipped:number}}
 */
export function groupRows(rows) {
  const groups = new Map();
  let skipped = 0;
  if (!Array.isArray(rows)) return { groups, skipped };

  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

  for (const row of rows) {
    if (!Array.isArray(row)) { skipped++; continue; }
    const label = row[0];
    if (label === null || label === undefined || label === '') { skipped++; continue; }

    const values = row.slice(1).filter(isNum);
    if (values.length === 0) { skipped++; continue; }

    const key = String(label);
    groups.set(key, (groups.get(key) || []).concat(values));
  }
  return { groups, skipped };
}

/**
 * Compute summaries for every group in a parsed table.
 *
 * @param {Array<Array<*>>} rows
 * @param {{level?:number, hasHeader?:boolean|'auto'}} [options]
 * @returns {{results:object[], skipped:number, headerDetected:boolean}}
 */
export function computeGroups(rows, options = {}) {
  const { level = 0.95, hasHeader = 'auto' } = options;
  if (!Array.isArray(rows) || rows.length === 0) {
    return { results: [], skipped: 0, headerDetected: false };
  }

  const headerDetected = hasHeader === 'auto'
    ? detectHeaderRow(rows)
    : Boolean(hasHeader);

  const dataRows = headerDetected ? rows.slice(1) : rows;
  const { groups, skipped } = groupRows(dataRows);

  const results = [];
  for (const [key, values] of groups) {
    const s = summariseGroup(key, values, level);
    if (s) results.push(s);
  }
  return { results, skipped, headerDetected };
}

/**
 * Select the error value matching a chosen mode.
 *
 * @param {object} result - A group summary.
 * @param {'sd'|'sem'|'ci'} mode
 * @returns {number}
 */
export function currentError(result, mode) {
  if (!result) return NaN;
  switch (mode) {
    case 'sd': return result.sd;
    case 'sem': return result.sem;
    case 'ci': return result.ci;
    default: return NaN;
  }
}

/**
 * Human-readable label for an error mode, always naming the measure.
 *
 * @param {'sd'|'sem'|'ci'} mode
 * @param {number} [level=0.95]
 * @returns {string}
 */
export function errorLabel(mode, level = 0.95) {
  switch (mode) {
    case 'sd': return 'SD';
    case 'sem': return 'SEM';
    case 'ci': return `${Math.round(level * 100)}% CI`;
    default: return '';
  }
}

/**
 * Choose readable axis tick positions spanning a range.
 *
 * Steps are constrained to 1, 2, 2.5, or 5 times a power of ten, which are the
 * intervals a reader can interpolate between at a glance.
 *
 * @param {number} min
 * @param {number} max
 * @param {number} [count=5] - Approximate number of intervals.
 * @returns {number[]}
 */
export function niceTicks(min, max, count = 5) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (min === max) return [min];
  if (min > max) [min, max] = [max, min];

  const rawStep = (max - min) / Math.max(1, count);
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / mag;

  let step;
  if (norm <= 1) step = 1;
  else if (norm <= 2) step = 2;
  else if (norm <= 2.5) step = 2.5;
  else if (norm <= 5) step = 5;
  else step = 10;
  step *= mag;

  const start = Math.floor(min / step) * step;
  const end = Math.ceil(max / step) * step;

  const ticks = [];
  // Accumulate by index rather than repeated addition, so floating-point
  // error does not drift across a long axis.
  const n = Math.round((end - start) / step);
  for (let i = 0; i <= n; i++) {
    ticks.push(Number((start + i * step).toPrecision(12)));
  }
  return ticks;
}

/**
 * Compute the y-axis range needed to show every bar and its error.
 *
 * @param {object[]} results
 * @param {'sd'|'sem'|'ci'} mode
 * @param {{includeZero?:boolean}} [options]
 * @returns {{min:number, max:number}}
 */
export function axisRange(results, mode, options = {}) {
  const { includeZero = true } = options;
  if (!Array.isArray(results) || results.length === 0) {
    return { min: 0, max: 1 };
  }

  let lo = Infinity;
  let hi = -Infinity;
  for (const r of results) {
    const e = currentError(r, mode) || 0;
    lo = Math.min(lo, r.mean - e);
    hi = Math.max(hi, r.mean + e);
  }
  if (includeZero) {
    lo = Math.min(lo, 0);
    hi = Math.max(hi, 0);
  }
  if (lo === hi) { lo -= 1; hi += 1; }
  return { min: lo, max: hi };
}

/**
 * Find pairs of groups whose confidence intervals do not overlap.
 *
 * This is a *visual heuristic*, not a test, and it errs in both directions:
 *
 *   - Non-overlapping intervals imply a difference significant at roughly
 *     alpha = 0.01 rather than the nominal 0.05, so the rule is conservative
 *     and will miss real differences.
 *   - Overlapping intervals do **not** demonstrate equivalence. Two groups can
 *     have overlapping 95% intervals and still differ significantly by a
 *     two-sample t-test, because the standard error of a difference is smaller
 *     than the sum of the individual standard errors.
 *
 * Callers should present the result as a cue to run a formal test, never as a
 * substitute for one. `pairwiseComparisons` provides the actual test.
 *
 * @param {object[]} results - Group summaries.
 * @returns {{
 *   separated: Array<{a:string, b:string}>,
 *   allOverlap: boolean,
 *   comparable: number
 * }} `comparable` counts the groups that had enough data for an interval.
 */
export function nonOverlappingPairs(results) {
  const usable = (Array.isArray(results) ? results : [])
    .filter(r => r && r.n > 1 && Number.isFinite(r.ci) && r.ci > 0);

  const separated = [];
  for (let i = 0; i < usable.length; i++) {
    for (let j = i + 1; j < usable.length; j++) {
      const a = usable[i];
      const b = usable[j];
      const overlap = (a.mean - a.ci) <= (b.mean + b.ci) &&
                      (b.mean - b.ci) <= (a.mean + a.ci);
      if (!overlap) separated.push({ a: a.key, b: b.key });
    }
  }

  return {
    separated,
    allOverlap: usable.length >= 2 && separated.length === 0,
    comparable: usable.length
  };
}

/**
 * Serialise group summaries as CSV.
 *
 * @param {object[]} results
 * @returns {string}
 */
export function resultsToCSV(results) {
  const header = 'Group,n,Mean,SD,SEM,t,CI,Median,Q1,Q3,IQR,CV%,Min,Max\n';
  if (!Array.isArray(results)) return header;

  return header + results.map(r =>
    `"${String(r.key).replace(/"/g, '""')}",${r.n},${r.mean},${r.sd},${r.sem},` +
    `${r.t},${r.ci},${r.median},${r.q1},${r.q3},${r.iqr},${r.cv},${r.min},${r.max}`
  ).join('\n') + '\n';
}

/**
 * Pairwise Welch t-tests between all groups, with a Holm-Bonferroni
 * correction for multiplicity.
 *
 * Holm is used rather than plain Bonferroni because it is uniformly more
 * powerful while controlling the same family-wise error rate.
 *
 * @param {Array<{key:string, values:number[]}>} groups
 * @returns {Array<{a:string, b:string, t:number, df:number, p:number,
 *                  pAdjusted:number, significant:boolean}>}
 */
export function pairwiseComparisons(groups) {
  const jStat = requireVendor('jStat');
  if (!Array.isArray(groups) || groups.length < 2) return [];

  const out = [];
  for (let i = 0; i < groups.length; i++) {
    for (let j = i + 1; j < groups.length; j++) {
      const a = groups[i];
      const b = groups[j];
      const na = a.values.length;
      const nb = b.values.length;
      if (na < 2 || nb < 2) continue;

      const va = sd(a.values) ** 2;
      const vb = sd(b.values) ** 2;
      const se = Math.sqrt(va / na + vb / nb);
      if (se === 0) continue;

      const t = (mean(a.values) - mean(b.values)) / se;
      const df = Math.pow(va / na + vb / nb, 2) /
                 (Math.pow(va / na, 2) / (na - 1) + Math.pow(vb / nb, 2) / (nb - 1));
      const p = jStat.ibeta(df / (df + t * t), df / 2, 0.5);

      out.push({ a: a.key, b: b.key, t, df, p, pAdjusted: p, significant: false });
    }
  }

  // Holm-Bonferroni: sort ascending, scale by (m - rank), enforce monotonicity.
  const m = out.length;
  const sorted = [...out].sort((x, y) => x.p - y.p);
  let running = 0;
  sorted.forEach((entry, k) => {
    const adj = Math.min(1, entry.p * (m - k));
    running = Math.max(running, adj);
    entry.pAdjusted = running;
    entry.significant = running < 0.05;
  });

  return out;
}
