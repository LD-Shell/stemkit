/**
 * @module core/data-cleaning
 *
 * Tabular data cleaning and transformation, extracted from STEMKit's Data
 * Cleaner.
 *
 * Every operation returns a new array rather than mutating in place, so a UI
 * can keep an undo stack cheaply and a pipeline can be replayed deterministically.
 *
 * Parsing is delegated to the vendored Papa Parse bundle through the injection
 * layer, so the browser and Node builds share one CSV implementation.
 */

import { requireVendor } from './vendor.js';

/**
 * Parse delimited text into row objects.
 *
 * Delimiter detection is left to Papa Parse, which guesses among tab, comma,
 * semicolon, pipe, and space. `dynamicTyping` converts numeric-looking fields
 * to numbers, which every downstream statistic depends on.
 *
 * @param {string} text
 * @param {{header?:boolean, delimiter?:string}} [options]
 * @returns {{rows:object[], fields:string[], errors:object[]}}
 */
export function parseDelimited(text, options = {}) {
  const Papa = requireVendor('Papa');
  const { header = true, delimiter } = options;

  if (typeof text !== 'string' || text.trim() === '') {
    return { rows: [], fields: [], errors: [] };
  }

  const config = {
    header,
    dynamicTyping: true,
    skipEmptyLines: true,
    delimitersToGuess: ['\t', ',', ';', '|', ' ']
  };
  if (delimiter) config.delimiter = delimiter;

  const result = Papa.parse(text.trim(), config);
  const fields = (result.meta && result.meta.fields
    ? result.meta.fields.filter(f => f && String(f).trim() !== '')
    : []);

  return { rows: result.data || [], fields, errors: result.errors || [] };
}

/**
 * Serialise rows back to CSV.
 *
 * @param {object[]} rows
 * @param {{fields?:string[], delimiter?:string}} [options]
 * @returns {string}
 */
export function toCSV(rows, options = {}) {
  const Papa = requireVendor('Papa');
  const { fields, delimiter = ',' } = options;
  const config = { delimiter };
  if (fields) config.columns = fields;
  return Papa.unparse(rows || [], config);
}

/**
 * Extract the finite numeric values of a column.
 *
 * @param {object[]} rows
 * @param {string} column
 * @returns {number[]}
 */
export function numericColumn(rows, column) {
  if (!Array.isArray(rows)) return [];
  return rows
    .map(r => (r ? r[column] : undefined))
    .filter(v => typeof v === 'number' && Number.isFinite(v));
}

/**
 * Descriptive statistics for one column.
 *
 * The standard deviation reported here is the *population* value (n
 * denominator), matching the original tool. This is a description of the data
 * in hand rather than an estimate of a wider population, so the Bessel
 * correction is deliberately not applied; the inferential routines in
 * `core/statistics.js` use the (n-1) form where it is appropriate.
 *
 * @param {object[]} rows
 * @param {string} column
 * @returns {{n:number, missing:number, mean:number, median:number,
 *            std:number, min:number, max:number}|null}
 */
export function columnStats(rows, column) {
  if (!Array.isArray(rows)) return null;
  const vec = numericColumn(rows, column);
  const total = rows.length;
  const missing = total - vec.length;
  if (vec.length === 0) {
    return { n: 0, missing, mean: NaN, median: NaN, std: NaN, min: NaN, max: NaN };
  }

  const n = vec.length;
  const mean = vec.reduce((a, b) => a + b, 0) / n;
  const variance = vec.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const sorted = [...vec].sort((a, b) => a - b);
  const median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;

  return {
    n, missing, mean, median,
    std: Math.sqrt(variance),
    min: sorted[0],
    max: sorted[n - 1]
  };
}

/**
 * Test whether a cell counts as missing.
 *
 * Zero and `false` are values, not absences, so only null, undefined, and the
 * empty string qualify.
 *
 * @param {*} v
 * @returns {boolean}
 */
export function isMissing(v) {
  return v === null || v === undefined || v === '';
}

/**
 * Drop rows with a missing value in any of the given columns.
 *
 * @param {object[]} rows
 * @param {string[]} columns
 * @returns {{rows:object[], removed:number}}
 */
export function dropMissing(rows, columns) {
  if (!Array.isArray(rows)) return { rows: [], removed: 0 };
  const cols = Array.isArray(columns) && columns.length ? columns : null;
  const kept = rows.filter(row => {
    const check = cols || Object.keys(row || {});
    return check.every(c => !isMissing(row ? row[c] : undefined));
  });
  return { rows: kept, removed: rows.length - kept.length };
}

/**
 * Remove duplicate rows.
 *
 * Identity is the tuple of values across `columns` (or every column). The
 * first occurrence is kept, so ordering is stable.
 *
 * @param {object[]} rows
 * @param {string[]} [columns]
 * @returns {{rows:object[], removed:number}}
 */
export function deduplicate(rows, columns) {
  if (!Array.isArray(rows)) return { rows: [], removed: 0 };
  const seen = new Set();
  const kept = [];

  for (const row of rows) {
    const cols = (Array.isArray(columns) && columns.length)
      ? columns
      : Object.keys(row || {});
    const key = JSON.stringify(cols.map(c => (row ? row[c] : undefined)));
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(row);
  }
  return { rows: kept, removed: rows.length - kept.length };
}

/**
 * Fill missing cells with a constant.
 *
 * @param {object[]} rows
 * @param {string[]} columns
 * @param {*} value
 * @returns {{rows:object[], filled:number}}
 */
export function fillMissing(rows, columns, value) {
  if (!Array.isArray(rows)) return { rows: [], filled: 0 };
  let filled = 0;
  const out = rows.map(row => {
    const copy = { ...row };
    const cols = (Array.isArray(columns) && columns.length)
      ? columns
      : Object.keys(copy);
    for (const c of cols) {
      if (isMissing(copy[c])) {
        copy[c] = value;
        filled++;
      }
    }
    return copy;
  });
  return { rows: out, filled };
}

/**
 * Fill missing numeric cells with a column statistic.
 *
 * @param {object[]} rows
 * @param {string[]} columns
 * @param {'mean'|'median'} [statistic='mean']
 * @returns {{rows:object[], filled:number}}
 */
export function fillWithStatistic(rows, columns, statistic = 'mean') {
  if (!Array.isArray(rows)) return { rows: [], filled: 0 };
  const cols = (Array.isArray(columns) && columns.length)
    ? columns
    : Object.keys(rows[0] || {});

  const replacement = {};
  for (const c of cols) {
    const s = columnStats(rows, c);
    replacement[c] = s && s.n > 0 ? (statistic === 'median' ? s.median : s.mean) : null;
  }

  let filled = 0;
  const out = rows.map(row => {
    const copy = { ...row };
    for (const c of cols) {
      if (isMissing(copy[c]) && replacement[c] !== null) {
        copy[c] = replacement[c];
        filled++;
      }
    }
    return copy;
  });
  return { rows: out, filled };
}

/**
 * Trim surrounding whitespace from every string cell.
 *
 * @param {object[]} rows
 * @param {string[]} [columns]
 * @returns {{rows:object[], changed:number}}
 */
export function trimWhitespace(rows, columns) {
  if (!Array.isArray(rows)) return { rows: [], changed: 0 };
  let changed = 0;
  const out = rows.map(row => {
    const copy = { ...row };
    const cols = (Array.isArray(columns) && columns.length)
      ? columns
      : Object.keys(copy);
    for (const c of cols) {
      if (typeof copy[c] === 'string') {
        const t = copy[c].trim();
        if (t !== copy[c]) {
          copy[c] = t;
          changed++;
        }
      }
    }
    return copy;
  });
  return { rows: out, changed };
}

/**
 * Change the case of string cells.
 *
 * @param {object[]} rows
 * @param {string[]} columns
 * @param {'upper'|'lower'|'title'} mode
 * @returns {{rows:object[], changed:number}}
 */
export function changeCase(rows, columns, mode) {
  if (!Array.isArray(rows)) return { rows: [], changed: 0 };
  let changed = 0;

  const apply = (s) => {
    switch (mode) {
      case 'upper': return s.toUpperCase();
      case 'lower': return s.toLowerCase();
      case 'title':
        return s.replace(/\w\S*/g, w => w[0].toUpperCase() + w.slice(1).toLowerCase());
      default: return s;
    }
  };

  const out = rows.map(row => {
    const copy = { ...row };
    const cols = (Array.isArray(columns) && columns.length)
      ? columns
      : Object.keys(copy);
    for (const c of cols) {
      if (typeof copy[c] === 'string') {
        const v = apply(copy[c]);
        if (v !== copy[c]) {
          copy[c] = v;
          changed++;
        }
      }
    }
    return copy;
  });
  return { rows: out, changed };
}

/**
 * Sort rows by a column.
 *
 * Numeric values sort numerically and strings lexicographically; missing
 * values are always placed last regardless of direction, since a blank is not
 * meaningfully "smaller" than any value.
 *
 * @param {object[]} rows
 * @param {string} column
 * @param {{descending?:boolean}} [options]
 * @returns {object[]}
 */
export function sortByColumn(rows, column, options = {}) {
  if (!Array.isArray(rows)) return [];
  const { descending = false } = options;
  const dir = descending ? -1 : 1;

  return [...rows].sort((a, b) => {
    const av = a ? a[column] : undefined;
    const bv = b ? b[column] : undefined;
    const aMissing = isMissing(av);
    const bMissing = isMissing(bv);
    if (aMissing && bMissing) return 0;
    if (aMissing) return 1;
    if (bMissing) return -1;

    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
    return String(av).localeCompare(String(bv)) * dir;
  });
}

/**
 * Filter rows by a predicate on one column.
 *
 * @param {object[]} rows
 * @param {string} column
 * @param {'eq'|'ne'|'gt'|'lt'|'gte'|'lte'|'contains'} operator
 * @param {*} value
 * @returns {{rows:object[], removed:number}}
 */
export function filterRows(rows, column, operator, value) {
  if (!Array.isArray(rows)) return { rows: [], removed: 0 };

  const test = (cell) => {
    switch (operator) {
      case 'eq': return cell === value;
      case 'ne': return cell !== value;
      case 'gt': return Number(cell) > Number(value);
      case 'lt': return Number(cell) < Number(value);
      case 'gte': return Number(cell) >= Number(value);
      case 'lte': return Number(cell) <= Number(value);
      case 'contains':
        return String(cell).toLowerCase().includes(String(value).toLowerCase());
      default: return true;
    }
  };

  const kept = rows.filter(r => test(r ? r[column] : undefined));
  return { rows: kept, removed: rows.length - kept.length };
}

/**
 * Round numeric cells to a fixed number of decimal places.
 *
 * @param {object[]} rows
 * @param {string[]} columns
 * @param {number} decimals
 * @returns {{rows:object[], changed:number}}
 */
export function roundColumn(rows, columns, decimals) {
  if (!Array.isArray(rows)) return { rows: [], changed: 0 };
  const d = Math.max(0, Math.min(20, Math.floor(decimals)));
  let changed = 0;

  const out = rows.map(row => {
    const copy = { ...row };
    const cols = (Array.isArray(columns) && columns.length)
      ? columns
      : Object.keys(copy);
    for (const c of cols) {
      if (typeof copy[c] === 'number' && Number.isFinite(copy[c])) {
        const v = Number(copy[c].toFixed(d));
        if (v !== copy[c]) {
          copy[c] = v;
          changed++;
        }
      }
    }
    return copy;
  });
  return { rows: out, changed };
}

/**
 * Rename a column, preserving key order.
 *
 * @param {object[]} rows
 * @param {string} from
 * @param {string} to
 * @returns {object[]}
 */
export function renameColumn(rows, from, to) {
  if (!Array.isArray(rows) || !from || !to || from === to) return rows || [];
  return rows.map(row => {
    const copy = {};
    for (const [k, v] of Object.entries(row || {})) {
      copy[k === from ? to : k] = v;
    }
    return copy;
  });
}

/**
 * Drop columns entirely.
 *
 * @param {object[]} rows
 * @param {string[]} columns
 * @returns {object[]}
 */
export function dropColumns(rows, columns) {
  if (!Array.isArray(rows)) return [];
  const drop = new Set(columns || []);
  return rows.map(row => {
    const copy = {};
    for (const [k, v] of Object.entries(row || {})) {
      if (!drop.has(k)) copy[k] = v;
    }
    return copy;
  });
}

/**
 * Apply a numeric transformation to columns.
 *
 * Two conventions are worth stating, since both differ between tools:
 *
 *   - **Z-score** uses the *population* standard deviation (n denominator),
 *     matching scikit-learn's `StandardScaler`. Pandas defaults to the sample
 *     (n-1) form, so values differ slightly for small samples.
 *   - **Logarithms** skip non-positive values rather than producing `-Infinity`
 *     or `NaN`, which would silently poison every later statistic. The count of
 *     skipped cells is returned so a caller can report it.
 *
 * @param {object[]} rows
 * @param {string[]} columns
 * @param {'log10'|'ln'|'abs'|'minmax'|'zscore'} operation
 * @returns {{rows:object[], transformed:number, skipped:number}}
 */
export function transformColumn(rows, columns, operation) {
  if (!Array.isArray(rows)) return { rows: [], transformed: 0, skipped: 0 };

  const cols = (Array.isArray(columns) && columns.length)
    ? columns
    : Object.keys(rows[0] || {});

  // Column-wide statistics must be computed before any value is rewritten,
  // or each cell would be scaled against a partially transformed column.
  const stats = {};
  for (const c of cols) {
    const vec = numericColumn(rows, c);
    if (vec.length === 0) continue;
    const n = vec.length;
    const mean = vec.reduce((a, b) => a + b, 0) / n;
    const variance = vec.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
    stats[c] = {
      mean,
      std: Math.sqrt(variance),
      min: Math.min(...vec),
      max: Math.max(...vec)
    };
  }

  let transformed = 0;
  let skipped = 0;

  const out = rows.map(row => {
    const copy = { ...row };
    for (const c of cols) {
      const v = copy[c];
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      const s = stats[c];
      if (!s) continue;

      switch (operation) {
        case 'log10':
          if (v > 0) { copy[c] = Math.log10(v); transformed++; }
          else skipped++;
          break;
        case 'ln':
          if (v > 0) { copy[c] = Math.log(v); transformed++; }
          else skipped++;
          break;
        case 'abs':
          copy[c] = Math.abs(v);
          transformed++;
          break;
        case 'minmax':
          // A constant column has no range; mapping it to 0 is the convention
          // scikit-learn uses and avoids a division by zero.
          copy[c] = s.max === s.min ? 0 : (v - s.min) / (s.max - s.min);
          transformed++;
          break;
        case 'zscore':
          copy[c] = s.std !== 0 ? (v - s.mean) / s.std : 0;
          transformed++;
          break;
        default:
          break;
      }
    }
    return copy;
  });

  return { rows: out, transformed, skipped };
}

/**
 * Summarise the shape and completeness of a table.
 *
 * @param {object[]} rows
 * @param {string[]} fields
 * @returns {{nRows:number, nColumns:number,
 *            missingByColumn:Object<string,number>, totalMissing:number,
 *            duplicateRows:number}}
 */
export function profileData(rows, fields) {
  const list = Array.isArray(rows) ? rows : [];
  const cols = Array.isArray(fields) && fields.length
    ? fields
    : Object.keys(list[0] || {});

  const missingByColumn = {};
  let totalMissing = 0;
  for (const c of cols) {
    let n = 0;
    for (const r of list) if (isMissing(r ? r[c] : undefined)) n++;
    missingByColumn[c] = n;
    totalMissing += n;
  }

  return {
    nRows: list.length,
    nColumns: cols.length,
    missingByColumn,
    totalMissing,
    duplicateRows: deduplicate(list, cols).removed
  };
}
