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

/*
 * The smallest and largest of an array of any length. Math.min(...values)
 * passes every value as an argument and runs out of stack somewhere past a
 * hundred thousand of them; a NaN among the values gives NaN, as it does there.
 */
function extent(values) {
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (Number.isNaN(v)) return [NaN, NaN];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return [min, max];
}

/*
 * The sample SD of a group, exactly 0 when its values are all the same. The
 * computed SD of equal values is not always 0: the mean of six copies of 0.1
 * is 0.09999999999999999, which leaves 1.5e-17, enough for Welch's test to
 * find two constant groups apart by a t of 1e16.
 */
function spread(values) {
  for (let i = 1; i < values.length; i++) {
    if (values[i] !== values[0]) return sd(values);
  }
  return 0;
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
  const s = spread(values);
  const sem = n > 0 ? s / Math.sqrt(n) : 0;

  // A single observation gives no estimate of dispersion, so the interval is
  // undefined rather than zero-width; t* is reported as 0 to signal that.
  const p = 1 - (1 - level) / 2;
  const tStar = n > 1 ? jStat.studentt.inv(p, n - 1) : 0;

  const q1 = quantile(values, 0.25);
  const q3 = quantile(values, 0.75);
  const [min, max] = extent(values);

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
    min,
    max
  };
}

const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
// Digits, points and commas only: with a comma among them, a decimal comma
// (6,1) or a thousands separator (1,234).
const DIGITS_AND_SEPARATORS = /^[+-]?[\d.,]+([eE][+-]?\d+)?$/;

/**
 * Read one cell of a table as a replicate.
 *
 * A table parsed with Papa Parse's `dynamicTyping` arrives with most numbers
 * already typed, but that option leaves as text anything with a leading plus
 * (`+5`), anything of 2^53 or more (`1e16`) and anything out of range
 * (`1e400`), so strings are read here by the same rule as numbers typed in
 * full: an optional sign, digits with an optional point, an optional exponent.
 *
 * @param {*} cell
 * @returns {{kind:'number'|'blank'|'comma'|'infinite'|'text', value:number}}
 *          `number` with its `value`; `blank` for an empty cell; `comma` for
 *          digits written with a comma (`6,1`, `1,234`), which are not read;
 *          `infinite` for a number too large to hold (`1e400`); `text` for
 *          anything else. `value` is NaN unless the kind is `number`.
 */
export function readCell(cell) {
  if (typeof cell === 'number') {
    if (Number.isFinite(cell)) return { kind: 'number', value: cell };
    return { kind: Number.isNaN(cell) ? 'text' : 'infinite', value: NaN };
  }
  if (cell === null || cell === undefined) return { kind: 'blank', value: NaN };
  if (typeof cell !== 'string') return { kind: 'text', value: NaN };
  const text = cell.trim();
  if (text === '') return { kind: 'blank', value: NaN };
  if (NUMBER.test(text)) {
    const value = Number(text);
    return Number.isFinite(value) ? { kind: 'number', value } : { kind: 'infinite', value: NaN };
  }
  const comma = text.includes(',') && /\d/.test(text) && DIGITS_AND_SEPARATORS.test(text);
  return { kind: comma ? 'comma' : 'text', value: NaN };
}

/**
 * Decide whether the first row of a table is a header.
 *
 * A header row is one whose value cells hold no numbers while at least one
 * later row has them there. Detecting this rather than trusting a
 * checkbox means a pasted spreadsheet works on the first try. A cell that was
 * meant as a number but cannot be read as one (`6,1`, `1e400`) counts as a
 * number here, so a first row of them is kept as data and reported, not
 * dropped as a header.
 *
 * @param {Array<Array<*>>} rows
 * @returns {boolean}
 */
export function detectHeaderRow(rows) {
  if (!Array.isArray(rows) || rows.length < 2) return false;
  const numeric = (c) => {
    const kind = readCell(c).kind;
    return kind === 'number' || kind === 'comma' || kind === 'infinite';
  };
  const values = (r) => (Array.isArray(r) ? r.slice(1) : []);
  const firstAllText = values(rows[0]).every(c => !numeric(c));
  const laterHasNumbers = rows.slice(1).some(r => values(r).some(numeric));
  return firstAllText && laterHasNumbers;
}

/**
 * Group rows by their first-column label, pooling the numeric cells.
 *
 * Repeated labels accumulate, so replicates may be spread across several rows.
 * A cell under a label that holds something other than a number is left out
 * of its group and counted in `unread`, with the first such cell as an
 * example, so that a value never goes missing without a trace.
 *
 * @param {Array<Array<*>>} rows
 * @returns {{groups:Map<string, number[]>, skipped:number, unread:{
 *   total:number,
 *   text:{count:number, example:string|null},
 *   comma:{count:number, example:string|null},
 *   infinite:{count:number, example:string|null}
 * }}} `skipped` counts the rows with no label or no numbers. `unread` counts
 *     the cells of labelled rows that are not numbers, by kind (see
 *     `readCell`): `comma` for digits written with a comma, `infinite` for a
 *     number too large to hold, `text` for the rest. Empty cells are not
 *     counted.
 */
export function groupRows(rows) {
  const groups = new Map();
  let skipped = 0;
  const unread = {
    total: 0,
    text: { count: 0, example: null },
    comma: { count: 0, example: null },
    infinite: { count: 0, example: null }
  };
  if (!Array.isArray(rows)) return { groups, skipped, unread };

  for (const row of rows) {
    if (!Array.isArray(row)) { skipped++; continue; }
    const label = row[0];
    if (label === null || label === undefined || label === '') { skipped++; continue; }

    const values = [];
    for (let k = 1; k < row.length; k++) {
      const cell = readCell(row[k]);
      if (cell.kind === 'number') values.push(cell.value);
      else if (cell.kind !== 'blank') {
        const tally = unread[cell.kind];
        if (tally.count === 0) tally.example = String(row[k]).trim();
        tally.count++;
        unread.total++;
      }
    }
    if (values.length === 0) { skipped++; continue; }

    // Added to the group's own list: copying the list for every row makes a
    // long table of one value a row take time that grows with its square.
    const key = String(label);
    const list = groups.get(key);
    if (list) { for (const v of values) list.push(v); } else groups.set(key, values);
  }
  return { groups, skipped, unread };
}

/**
 * Compute summaries for every group in a parsed table.
 *
 * @param {Array<Array<*>>} rows
 * @param {{level?:number, hasHeader?:boolean|'auto'}} [options]
 * @returns {{results:object[], skipped:number, headerDetected:boolean, unread:object}}
 *          Each result is `summariseGroup`'s, plus `values`: the group's
 *          replicates in the order they were read. `unread` is `groupRows`'s
 *          count of the cells that are not numbers.
 */
export function computeGroups(rows, options = {}) {
  const { level = 0.95, hasHeader = 'auto' } = options;
  if (!Array.isArray(rows) || rows.length === 0) {
    return { results: [], skipped: 0, headerDetected: false, unread: groupRows([]).unread };
  }

  const headerDetected = hasHeader === 'auto'
    ? detectHeaderRow(rows)
    : Boolean(hasHeader);

  const dataRows = headerDetected ? rows.slice(1) : rows;
  const { groups, skipped, unread } = groupRows(dataRows);

  const results = [];
  for (const [key, values] of groups) {
    const s = summariseGroup(key, values, level);
    // The replicates stay with their summary, for the plot and the tests.
    if (s) results.push({ ...s, values });
  }
  return { results, skipped, headerDetected, unread };
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
 * `CI` is the half-width t* x SEM at the level the summaries were computed
 * with; the level itself is not written. A single replicate gives no
 * estimate of SD, SEM, t*, the interval or CV, so those cells are left empty
 * rather than written as a zero that reads as a measurement; CV is also empty
 * when the mean is zero.
 *
 * @param {object[]} results
 * @returns {string}
 */
export function resultsToCSV(results) {
  const header = 'Group,n,Mean,SD,SEM,t,CI,Median,Q1,Q3,IQR,CV%,Min,Max\n';
  if (!Array.isArray(results)) return header;

  return header + results.map(r => {
    const spread = (x) => (r.n > 1 ? x : '');
    const cv = r.n > 1 && r.mean !== 0 ? r.cv : '';
    return `"${String(r.key).replace(/"/g, '""')}",${r.n},${r.mean},` +
      `${spread(r.sd)},${spread(r.sem)},${spread(r.t)},${spread(r.ci)},` +
      `${r.median},${r.q1},${r.q3},${r.iqr},${cv},${r.min},${r.max}`;
  }).join('\n') + '\n';
}

/**
 * Pairwise Welch t-tests between all groups, with a Holm-Bonferroni
 * correction for multiplicity.
 *
 * Holm is used rather than plain Bonferroni because it is uniformly more
 * powerful while controlling the same family-wise error rate.
 *
 * A pair is skipped when either group has fewer than two values, or when
 * neither has any spread (both constant: the test has no variance to use).
 *
 * @param {Array<{key:string, values:number[]}>} groups
 * @param {{alpha?:number}} [options] - `alpha` is the family-wise level a
 *        pair is called significant at: 0.05 by default, and 1 - the
 *        confidence level when the caller reports intervals at another level
 *        (`significanceLevel` in error-bars-figure.js).
 * @returns {Array<{a:string, b:string, t:number, df:number, p:number,
 *                  pAdjusted:number, significant:boolean}>}
 *          `significant` is `pAdjusted < alpha`.
 */
export function pairwiseComparisons(groups, options = {}) {
  const jStat = requireVendor('jStat');
  if (!Array.isArray(groups) || groups.length < 2) return [];
  const alpha = Number.isFinite(options.alpha) ? options.alpha : 0.05;

  const out = [];
  for (let i = 0; i < groups.length; i++) {
    for (let j = i + 1; j < groups.length; j++) {
      const a = groups[i];
      const b = groups[j];
      const na = a.values.length;
      const nb = b.values.length;
      if (na < 2 || nb < 2) continue;

      const va = spread(a.values) ** 2;
      const vb = spread(b.values) ** 2;
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
    entry.significant = running < alpha;
  });

  return out;
}
