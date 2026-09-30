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
 *
 * The second half of the module is the recipe engine the Data Cleaner runs
 * on: `readTable` reads a file into a table of numbers, text and missing
 * values; a recipe is a list of plain step objects; `runRecipe` replays them
 * on the table as read. Its rules are pinned down so that the pandas script
 * written by `core/data-cleaning-python.js` gives the same table, cell for
 * cell (see "Recipes" below).
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

/* ====================================================================== *
 * Recipes
 * ----------------------------------------------------------------------
 * Everything below works on a table `{ columns, rows }`: `columns` is a list
 * of unique names and each row is an array aligned with it. A cell is a
 * finite number, a non-empty string, or null for a missing value.
 *
 * A recipe is a list of steps, each a plain object that survives JSON (see
 * STEP_TYPES), so a page can save one and apply it to another file.
 * `runRecipe` replays the steps on the table as it was read: a step can be
 * switched off, edited or moved and the result is recomputed from the start.
 *
 * Every rule has a twin in the pandas script that
 * core/data-cleaning-python.js writes, and tests/data-cleaning-python.test.js
 * runs that script to check that the two give the same table. Where
 * JavaScript and Python differ on their own, the rule is pinned down so both
 * compute the same thing:
 *
 *   - the file is split by a port of Python's csv.reader, lines ending in
 *     \n, \r\n or \r alike;
 *   - a cell is a number only when it matches one pattern (ASCII digits, an
 *     optional sign, point or comma, exponent), which both languages then
 *     convert with correct rounding; any other text stays text;
 *   - numbers are written the way JavaScript's String(number) writes them;
 *   - sums are exact (Python's math.fsum), so a mean does not depend on how
 *     a library adds;
 *   - logarithms are correctly rounded (libm results differ in the last bit
 *     between engines);
 *   - rounding works on the number as written (2.675 to 2.68), with ties
 *     away from zero or to even, as the step says;
 *   - text sorts by code point after lower-casing, never by locale;
 *   - "spaces" are the characters String.prototype.trim removes.
 * ====================================================================== */

/** The characters JavaScript's String.prototype.trim removes. */
export const SPACE_CHARACTERS = '\t\n\v\f\r           ' +
  '       　﻿';
const SPACE_SET = new Set(SPACE_CHARACTERS);
const SPACE_RUN = new RegExp(`[${SPACE_CHARACTERS}]+`, 'g');
const WORD = new RegExp(`[\\p{L}\\p{N}_][^${SPACE_CHARACTERS}]*`, 'gu');

const NUMBER_TEXT = {
  '.': /^[ \t]*[-+]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][-+]?[0-9]+)?[ \t]*$/,
  ',': /^[ \t]*[-+]?(?:[0-9]+,?[0-9]*|,[0-9]+)(?:[eE][-+]?[0-9]+)?[ \t]*$/
};
const INTEGER_TEXT = /^[ \t]*[-+]?[0-9]+[ \t]*$/;
/** Whole numbers from here up lose digits as doubles, so they stay text (IDs, barcodes). */
const EXACT_INTEGER_LIMIT = 2 ** 53;

/** Delimiters the reader guesses between, in order of preference. */
export const DELIMITERS = [',', '\t', ';', '|', ' '];

/**
 * Remove the characters in SPACE_CHARACTERS from both ends of a string.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripSpaces(text) {
  const s = String(text);
  let a = 0;
  let b = s.length;
  while (a < b && SPACE_SET.has(s[a])) a++;
  while (b > a && SPACE_SET.has(s[b - 1])) b--;
  return s.slice(a, b);
}

/**
 * One cell as the Data Cleaner reads it: null when empty, a number when the
 * text is one, otherwise the text unchanged.
 *
 * A number is ASCII digits with an optional sign, one decimal separator and
 * an exponent, with spaces or tabs around it: `12`, `-0.5`, `.5`, `1e-7`,
 * ` 3 `. With `decimal` set to ',' the separator is a comma (`0,5`) and a
 * point makes the cell text. A whole number of 2^53 or more stays text, since
 * a double would change its digits. Nothing else is converted: `NA`, `true`
 * and dates stay text.
 *
 * @param {string|number|null|undefined} text
 * @param {'.'|','} [decimal='.']
 * @returns {number|string|null}
 */
export function readCell(text, decimal = '.') {
  if (text === null || text === undefined || text === '') return null;
  if (typeof text === 'number') return Number.isFinite(text) ? text : null;
  const s = String(text);
  if ((NUMBER_TEXT[decimal] || NUMBER_TEXT['.']).test(s)) {
    const value = Number(decimal === ',' ? s.replace(',', '.') : s);
    if (Number.isFinite(value) && !(INTEGER_TEXT.test(s) && Math.abs(value) >= EXACT_INTEGER_LIMIT)) return value;
  }
  return s;
}

/**
 * Split delimited text into records as Python's `csv.reader(file,
 * delimiter=...)` does for a file opened with universal newlines: the
 * default double quote, doubled quotes inside quoted fields, `strict=False`.
 * A blank line gives an empty record.
 *
 * @param {string} text
 * @param {string} [delimiter=',']
 * @returns {string[][]}
 */
export function splitRecords(text, delimiter = ',') {
  const src = String(text ?? '').replace(/\r\n?/g, '\n');
  const EOL = null;
  const START_RECORD = 0;
  const START_FIELD = 1;
  const IN_FIELD = 2;
  const IN_QUOTED = 3;
  const QUOTE_IN_QUOTED = 4;
  const EAT_NEWLINE = 5;
  const records = [];
  let state = START_RECORD;
  let fields = [];
  let field = '';
  const save = () => { fields.push(field); field = ''; };
  const endOfLine = (c) => c === '\n' || c === '\r' || c === EOL;

  const take = (c) => {
    switch (state) {
      case START_RECORD:
        if (c === EOL) return;
        if (c === '\n' || c === '\r') { state = EAT_NEWLINE; return; }
        state = START_FIELD;
      // falls through
      case START_FIELD:
        if (endOfLine(c)) { save(); state = c === EOL ? START_RECORD : EAT_NEWLINE; }
        else if (c === '"') state = IN_QUOTED;
        else if (c === delimiter) save();
        else { field += c; state = IN_FIELD; }
        return;
      case IN_FIELD:
        if (endOfLine(c)) { save(); state = c === EOL ? START_RECORD : EAT_NEWLINE; }
        else if (c === delimiter) { save(); state = START_FIELD; }
        else field += c;
        return;
      case IN_QUOTED:
        if (c === EOL) return;
        if (c === '"') state = QUOTE_IN_QUOTED;
        else field += c;
        return;
      case QUOTE_IN_QUOTED:
        if (c === '"') { field += c; state = IN_QUOTED; }
        else if (c === delimiter) { save(); state = START_FIELD; }
        else if (endOfLine(c)) { save(); state = c === EOL ? START_RECORD : EAT_NEWLINE; }
        else { field += c; state = IN_FIELD; }
        return;
      default: // EAT_NEWLINE: the rest of the line is its newline
        if (c === EOL) state = START_RECORD;
    }
  };

  let pos = 0;
  while (pos < src.length) {
    let end = src.indexOf('\n', pos);
    end = end < 0 ? src.length : end + 1;
    // Unquoted runs are copied whole; the state machine sees one character
    // at a time only where it matters.
    for (let i = pos; i < end; i++) {
      if (state === IN_FIELD || state === IN_QUOTED) {
        const stop = state === IN_FIELD ? nextOf(src, i, end, delimiter, '\n') : nextOf(src, i, end, '"', '"');
        if (stop > i) { field += src.slice(i, stop); i = stop - 1; continue; }
      }
      take(src[i]);
    }
    take(EOL);
    if (state === START_RECORD) { records.push(fields); fields = []; }
    pos = end;
  }
  if (field.length || state === IN_QUOTED) { save(); records.push(fields); }
  return records;
}

function nextOf(s, from, to, a, b) {
  for (let i = from; i < to; i++) {
    const c = s[i];
    if (c === a || c === b) return i;
  }
  return to;
}

/**
 * Column names from a header row: each name trimmed of spaces, an empty one
 * called `column_<n>`, and a repeated one given `_2`, `_3` and so on.
 *
 * @param {string[]} cells  the header row, or [] when the file has none
 * @param {number} width    how many columns the table has
 * @returns {string[]}
 */
export function columnNames(cells, width) {
  const names = [];
  const used = new Set();
  for (let i = 0; i < width; i++) {
    const base = stripSpaces(i < cells.length ? cells[i] : '') || `column_${i + 1}`;
    let name = base;
    let k = 2;
    while (used.has(name)) name = `${base}_${k++}`;
    used.add(name);
    names.push(name);
  }
  return names;
}

function firstLines(text, count) {
  let pos = 0;
  for (let i = 0; i < count; i++) {
    const next = text.indexOf('\n', pos);
    if (next < 0) return { sample: text, whole: true };
    pos = next + 1;
  }
  return { sample: text.slice(0, pos), whole: pos >= text.length };
}

/**
 * Guess the delimiter: the candidate that splits the first lines into the
 * steadiest number of fields (at least two), earlier candidates winning ties.
 *
 * @param {string} text
 * @returns {string}
 */
export function guessDelimiter(text) {
  const { sample, whole } = firstLines(String(text ?? '').replace(/\r\n?/g, '\n'), 30);
  let best = null;
  let bestDelta = Infinity;
  let bestAverage = 0;
  for (const d of DELIMITERS) {
    let records = splitRecords(sample, d).filter(r => r.length > 0);
    if (!whole && records.length > 1) records = records.slice(0, -1);
    if (!records.length) continue;
    const counts = records.map(r => r.length);
    const average = counts.reduce((a, b) => a + b, 0) / counts.length;
    let delta = 0;
    for (let i = 1; i < counts.length; i++) delta += Math.abs(counts[i] - counts[i - 1]);
    if (average > 1.99 && (delta < bestDelta || (delta === bestDelta && average > bestAverage))) {
      best = d;
      bestDelta = delta;
      bestAverage = average;
    }
  }
  return best || ',';
}

function guessDecimal(records, delimiter) {
  if (delimiter === ',') return '.';
  let comma = 0;
  let point = 0;
  for (const record of records.slice(0, 200)) {
    for (const cell of record) {
      if (cell.includes(',') && NUMBER_TEXT[','].test(cell)) comma++;
      else if (cell.includes('.') && NUMBER_TEXT['.'].test(cell)) point++;
    }
  }
  return comma > point ? ',' : '.';
}

function guessHeader(records, decimal) {
  const first = records[0];
  if (!first) return true;
  const filled = first.filter(c => stripSpaces(c) !== '');
  if (!filled.length) return true;
  return !filled.every(c => typeof readCell(c, decimal) === 'number');
}

/**
 * Read delimited text into a table.
 *
 * Settings not given are guessed: the delimiter from the first lines, a
 * decimal comma when numbers are written that way in a file not split by
 * commas, and a header row unless the first row is all numbers. Blank lines
 * are skipped. A row shorter than the widest one is padded with missing
 * values, and a leading byte-order mark is dropped.
 *
 * @param {string} text
 * @param {{delimiter?:string, decimal?:'.'|',', header?:boolean}} [settings]
 * @returns {{columns:string[], rows:any[][],
 *            settings:{delimiter:string, decimal:'.'|',', header:boolean},
 *            notes:{shortRows:number}}}
 */
export function readTable(text, settings = {}) {
  let src = String(text ?? '');
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);
  src = src.replace(/\r\n?/g, '\n');
  const delimiter = settings.delimiter || guessDelimiter(src);
  const records = splitRecords(src, delimiter).filter(r => r.length > 0);
  const decimal = settings.decimal === ',' || settings.decimal === '.' ? settings.decimal : guessDecimal(records, delimiter);
  const header = typeof settings.header === 'boolean' ? settings.header : guessHeader(records, decimal);
  let width = 0;
  for (const r of records) if (r.length > width) width = r.length;
  const columns = columnNames(header && records.length ? records[0] : [], width);
  const body = header ? records.slice(1) : records;
  let shortRows = 0;
  const rows = body.map(r => {
    if (r.length < width) shortRows++;
    const row = new Array(width);
    for (let i = 0; i < width; i++) row[i] = readCell(i < r.length ? r[i] : '', decimal);
    return row;
  });
  return { columns, rows, settings: { delimiter, decimal, header }, notes: { shortRows } };
}

/**
 * A cell as text, the way the page shows and writes it: numbers as
 * String(number) writes them, missing values as ''.
 *
 * @param {*} value
 * @returns {string}
 */
export function cellText(value) {
  if (value === null || value === undefined) return '';
  return String(value);
}

/**
 * Write a table as CSV the way Python's csv.writer (and so pandas' to_csv)
 * does: a field is quoted only when it holds the delimiter, a quote or a line
 * break, a row whose only field is empty is written as "", and each line ends
 * in \n.
 *
 * @param {{columns:string[], rows:any[][]}} table
 * @param {{delimiter?:string}} [options]
 * @returns {string}
 */
export function writeTable(table, options = {}) {
  const { delimiter = ',' } = options;
  const quote = (s) => (s.includes(delimiter) || s.includes('"') || s.includes('\n') || s.includes('\r')
    ? `"${s.replace(/"/g, '""')}"`
    : s);
  const line = (cells) => (cells.length === 1 && cells[0] === '' ? '""' : cells.map(quote).join(delimiter));
  const out = [line(table.columns.map(String))];
  for (const row of table.rows) out.push(line(row.map(cellText)));
  return out.join('\n') + '\n';
}

/* ---------------------------------------------------------------------- *
 * Arithmetic both languages can agree on
 * ---------------------------------------------------------------------- */

/**
 * The exact sum of a list of numbers, rounded once: a port of CPython's
 * math.fsum (Shewchuk's algorithm with its half-even fix-up), so the result
 * is the same double in both languages whatever the order of addition.
 *
 * @param {number[]} values
 * @returns {number}
 */
export function exactSum(values) {
  const partials = [];
  for (const value of values) {
    let x = value;
    let i = 0;
    for (let j = 0; j < partials.length; j++) {
      let y = partials[j];
      if (Math.abs(x) < Math.abs(y)) { const t = x; x = y; y = t; }
      const hi = x + y;
      const lo = y - (hi - x);
      if (lo !== 0) partials[i++] = lo;
      x = hi;
    }
    partials.length = i;
    if (x !== 0) partials.push(x);
  }
  let n = partials.length;
  let hi = 0;
  if (n > 0) {
    let lo = 0;
    hi = partials[--n];
    while (n > 0) {
      const x = hi;
      const y = partials[--n];
      hi = x + y;
      lo = y - (hi - x);
      if (lo !== 0) break;
    }
    if (n > 0 && ((lo < 0 && partials[n - 1] < 0) || (lo > 0 && partials[n - 1] > 0))) {
      const y = lo * 2;
      const x = hi + y;
      if (y === x - hi) hi = x;
    }
  }
  return hi;
}

/** Mean as exactSum / n, which is what Python's statistics.fmean computes. */
export function exactMean(values) {
  return values.length ? exactSum(values) / values.length : NaN;
}

/** Population standard deviation: sqrt(exactSum((x - mean)^2) / n). */
export function exactPopulationSD(values) {
  if (!values.length) return NaN;
  const m = exactMean(values);
  return Math.sqrt(exactSum(values.map(x => (x - m) * (x - m))) / values.length);
}

/** Median as Python's statistics.median: the middle value, or the mean of the two. */
export function median(values) {
  if (!values.length) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

// Logarithms in fixed point: a BigInt holding value * 2^P. The mantissa f,
// in [1, 2), is split as f = c * (f / c) with c = 1 + j/64 the nearest point
// of a table whose logarithms are worked out once; ln(f / c) is then an
// atanh series in z = (f - c) / (f + c), |z| < 1/256, so a dozen terms reach
// P bits.
const LOG_CACHE = new Map();
const bits = new DataView(new ArrayBuffer(8));
const TABLE_STEPS = 64;

function logConstants(P) {
  let c = LOG_CACHE.get(P);
  if (!c) {
    const B = BigInt(P);
    const ONE = 1n << B;
    const ln2 = 2n * atanhFixed(ONE / 3n, B);
    const ln10 = 3n * ln2 + 2n * atanhFixed(ONE / 9n, B);
    c = { B, ONE, ln2, ln10, table: new Array(TABLE_STEPS + 1) };
    c.table[0] = 0n;
    c.table[TABLE_STEPS] = ln2;
    LOG_CACHE.set(P, c);
  }
  return c;
}

// ln(1 + j/64) at P bits, from its own series the first time it is needed.
function tableLog(c, j) {
  if (c.table[j] === undefined) {
    const n = BigInt(TABLE_STEPS);
    const J = BigInt(j);
    c.table[j] = 2n * atanhFixed((J << c.B) / (2n * n + J), c.B);
  }
  return c.table[j];
}

function atanhFixed(Z, B) {
  // atanh is odd; working on |z| keeps the shifts truncating toward zero.
  if (Z < 0n) return -atanhFixed(-Z, B);
  const Z2 = (Z * Z) >> B;
  let term = Z;
  let sum = 0n;
  let k = 1n;
  while (term !== 0n) {
    sum += term / k;
    term = (term * Z2) >> B;
    k += 2n;
  }
  return sum;
}

function lnFixed(x, P) {
  const c = logConstants(P);
  bits.setFloat64(0, x);
  const hi = bits.getUint32(0);
  const lo = bits.getUint32(4);
  const exponentBits = (hi >>> 20) & 0x7ff;
  let m = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let e;
  if (exponentBits === 0) e = -1074;
  else { m |= 1n << 52n; e = exponentBits - 1075; }
  const L = m.toString(2).length;
  const k = e + L - 1;
  // f = m / 2^(L-1) in [1, 2), held as F = f * 2^P.
  const F = m << BigInt(P - (L - 1));
  const j = Math.round((Number(m) / 2 ** (L - 1) - 1) * TABLE_STEPS);
  const C = c.ONE + ((BigInt(j) << c.B) / BigInt(TABLE_STEPS));
  const Z = ((F - C) << c.B) / (F + C);
  return tableLog(c, j) + 2n * atanhFixed(Z, c.B) + BigInt(k) * c.ln2;
}

// The nearest double to R / 2^P, or null when R is too close to halfway
// between two doubles to decide at this precision.
function fixedToDouble(R, P) {
  if (R === 0n) return 0;
  const negative = R < 0n;
  const a = negative ? -R : R;
  const L = a.toString(2).length;
  const shift = L - 53;
  let mantissa;
  if (shift <= 0) mantissa = a << BigInt(-shift);
  else {
    const S = BigInt(shift);
    mantissa = a >> S;
    const rest = a - (mantissa << S);
    const half = 1n << (S - 1n);
    const gap = rest > half ? rest - half : half - rest;
    if (gap <= (1n << 24n)) return null;
    if (rest > half) mantissa += 1n;
  }
  const value = Number(mantissa) * 2 ** (shift - P);
  return negative ? -value : value;
}

function exactLog(x, base10) {
  if (!(x > 0) || !Number.isFinite(x)) return NaN;
  if (x === 1) return 0;
  for (const P of [160, 320, 1024]) {
    let R = lnFixed(x, P);
    if (base10) R = (R << BigInt(P)) / logConstants(P).ln10;
    const value = fixedToDouble(R, P);
    if (value !== null) return value;
  }
  return base10 ? Math.log10(x) : Math.log(x);
}

/**
 * Natural logarithm, correctly rounded. Math.log is not: engines differ in
 * the last bit for about one value in a hundred, and so do C libraries.
 *
 * @param {number} x
 * @returns {number}
 */
export function exactLn(x) {
  return exactLog(x, false);
}

/**
 * Base-10 logarithm, correctly rounded (exact for powers of ten).
 *
 * @param {number} x
 * @returns {number}
 */
export function exactLog10(x) {
  return exactLog(x, true);
}

function decimalDigits(x) {
  const s = String(Math.abs(x));
  const [mantissa, exponent = '0'] = s.split('e');
  const [whole, fraction = ''] = mantissa.split('.');
  let digits = whole + fraction;
  let point = whole.length + Number(exponent);
  const lead = /^0*/.exec(digits)[0].length;
  digits = digits.slice(lead).replace(/0+$/, '');
  point -= lead;
  return { digits, point };
}

/**
 * Round a number as it is written, not as it is stored: 2.675 has the
 * double 2.67499999..., but rounds to 2.68 here, as it would on paper.
 * Rounding to decimal places or to significant figures; a tie goes away
 * from zero ('up') or to the even digit ('even').
 *
 * @param {number} x
 * @param {number} digits  decimal places (may be negative), or significant figures
 * @param {{significant?:boolean, ties?:'up'|'even'}} [options]
 * @returns {number}
 */
export function roundNumber(x, digits, options = {}) {
  const { significant = false, ties = 'up' } = options;
  if (!Number.isFinite(x) || x === 0) return x;
  const { digits: D, point } = decimalDigits(x);
  const keep = significant ? digits : point + digits;
  if (keep >= D.length) return x;
  const zero = x < 0 ? -0 : 0;
  if (keep < 0) return zero;
  const head = D.slice(0, keep);
  const rest = D.slice(keep);
  let up;
  if (rest[0] !== '5') up = rest[0] > '5';
  else if (rest.length > 1) up = true;
  else up = ties === 'even' ? Number(head[head.length - 1] || '0') % 2 === 1 : true;
  const n = BigInt(head || '0') + (up ? 1n : 0n);
  if (n === 0n) return zero;
  const value = Number(`${n}e${point - keep}`);
  return x < 0 ? -value : value;
}

/**
 * Compare strings by code point, as Python compares str (JavaScript's `<`
 * compares UTF-16 code units, which orders characters above U+FFFF before
 * U+E000 to U+FFFF).
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function compareCodePoints(a, b) {
  if (a === b) return 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    let x = a.charCodeAt(i);
    let y = b.charCodeAt(i);
    if (x !== y) {
      if (x >= 0xd800 && y >= 0xd800) {
        x += x >= 0xe000 ? -0x800 : 0x2000;
        y += y >= 0xe000 ? -0x800 : 0x2000;
      }
      return x < y ? -1 : 1;
    }
  }
  return a.length < b.length ? -1 : a.length > b.length ? 1 : 0;
}

/**
 * Title case: the first letter or digit of each word upper-cased and the
 * rest of the word lower-cased, a word running to the next space. "they're"
 * stays one word, and "émile" becomes "Émile".
 *
 * @param {string} text
 * @returns {string}
 */
export function titleCase(text) {
  return String(text).replace(WORD, (w) => {
    const first = String.fromCodePoint(w.codePointAt(0));
    return first.toUpperCase() + w.slice(first.length).toLowerCase();
  });
}

/* ---------------------------------------------------------------------- *
 * Steps
 * ---------------------------------------------------------------------- */

/**
 * The step types, in the order a page lists them. Each step is a plain
 * object with a `type` and, optionally, `enabled: false` to switch it off:
 *
 *   dropMissing  {columns}                    rows with a missing value in any of them go
 *   dedupe       {columns}                    later rows repeating these values go
 *   filter       {column, op, value}          keep rows where the test holds
 *   sort         {column, descending}         stable; numbers, then text; missing last
 *   fill         {columns, method, value}     method: value | mean | median | previous
 *   replace      {columns, find, with, whole} whole cells, or text inside text cells
 *   trim         {columns, collapse}          spaces at the ends (and runs inside)
 *   case         {columns, mode}              upper | lower | title
 *   toNumber     {columns, decimal, invalid}  text that is a number becomes one
 *   round        {columns, digits, significant, ties}
 *   transform    {columns, operation, value}  log10 | ln | abs | minmax | zscore | multiply | add
 *   rename       {column, to}
 *   dropColumns  {columns}
 *
 * An empty `columns` list means every column.
 */
export const STEP_TYPES = ['dropMissing', 'dedupe', 'filter', 'sort', 'fill', 'replace', 'trim', 'case',
  'toNumber', 'round', 'transform', 'rename', 'dropColumns'];

export const FILTER_OPS = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'notContains', 'missing', 'present'];
const NUMERIC_OPS = new Set(['gt', 'gte', 'lt', 'lte']);
const TEXT_OPS = new Set(['contains', 'notContains']);
export const TRANSFORMS = ['log10', 'ln', 'abs', 'minmax', 'zscore', 'multiply', 'add'];

const isNumber = (v) => typeof v === 'number' && Number.isFinite(v);
const isText = (v) => typeof v === 'string' && v !== '';
const isValue = (v) => isNumber(v) || isText(v);

/**
 * The columns a step reads or changes, with an empty list read as every
 * column of the table it meets.
 *
 * @param {object} step
 * @param {string[]} columns  the table's columns when the step runs
 * @returns {string[]}
 */
export function stepColumns(step, columns) {
  if (!step) return [];
  if (step.type === 'filter' || step.type === 'sort' || step.type === 'rename') return step.column ? [step.column] : [];
  const list = Array.isArray(step.columns) ? step.columns : [];
  if (list.length === 0 && step.type !== 'dropColumns') return columns.slice();
  return list.slice();
}

/**
 * Why a step cannot run on a table with these columns, or null when it can.
 *
 * @param {object} step
 * @param {string[]} columns
 * @returns {string|null}
 */
export function checkStep(step, columns) {
  if (!step || !STEP_TYPES.includes(step.type)) return 'This is not a step the Data Cleaner knows.';
  const has = new Set(columns);
  const named = step.type === 'filter' || step.type === 'sort' || step.type === 'rename'
    ? [step.column]
    : (Array.isArray(step.columns) ? step.columns : []);
  for (const c of named) {
    if (typeof c !== 'string' || c === '') return 'Choose a column.';
    if (!has.has(c)) return `There is no column "${c}" at this point.`;
  }
  switch (step.type) {
    case 'filter':
      if (!FILTER_OPS.includes(step.op)) return 'Choose a test.';
      if (NUMERIC_OPS.has(step.op) && !isNumber(step.value)) return 'Enter a number to compare with.';
      if (TEXT_OPS.has(step.op) && !isText(step.value)) return 'Enter the text to look for.';
      if ((step.op === 'eq' || step.op === 'ne') && !isValue(step.value)) return 'Enter a value to compare with.';
      return null;
    case 'fill':
      if (!['value', 'mean', 'median', 'previous'].includes(step.method)) return 'Choose what to fill with.';
      if (step.method === 'value' && !isValue(step.value)) return 'Enter the value to fill with.';
      return null;
    case 'replace':
      if (step.whole) {
        if (!isValue(step.find)) return 'Enter the value to replace.';
        if (!(step.with === null || isValue(step.with))) return 'Enter the new value, or leave it empty.';
      } else {
        if (!isText(step.find)) return 'Enter the text to replace.';
        if (typeof step.with !== 'string') return 'Enter the new text, or leave it empty.';
      }
      return null;
    case 'case':
      return ['upper', 'lower', 'title'].includes(step.mode) ? null : 'Choose upper, lower or title case.';
    case 'toNumber':
      if (step.decimal !== '.' && step.decimal !== ',') return 'Choose the decimal separator.';
      return null;
    case 'round': {
      const d = step.digits;
      if (!Number.isInteger(d)) return 'Enter a whole number of digits.';
      if (step.significant ? d < 1 || d > 17 : d < -15 || d > 15) {
        return step.significant ? 'Significant figures run from 1 to 17.' : 'Decimal places run from -15 to 15.';
      }
      return null;
    }
    case 'transform':
      if (!TRANSFORMS.includes(step.operation)) return 'Choose a transformation.';
      if ((step.operation === 'multiply' || step.operation === 'add') && !isNumber(step.value)) return 'Enter a number.';
      return null;
    case 'rename': {
      const to = typeof step.to === 'string' ? stripSpaces(step.to) : '';
      if (!to) return 'Enter the new name.';
      if (to !== step.column && has.has(to)) return `There is already a column "${to}".`;
      return null;
    }
    case 'dropColumns':
      if (!named.length) return 'Choose the columns to remove.';
      if (new Set(named).size >= columns.length) return 'At least one column has to stay.';
      return null;
    default:
      return null;
  }
}

/**
 * The columns after a step, without touching any data.
 *
 * @param {string[]} columns
 * @param {object} step
 * @returns {string[]}
 */
export function columnsAfterStep(columns, step) {
  if (!step || step.enabled === false || checkStep(step, columns)) return columns;
  if (step.type === 'rename') return columns.map(c => (c === step.column ? stripSpaces(step.to) : c));
  if (step.type === 'dropColumns') {
    const drop = new Set(step.columns);
    return columns.filter(c => !drop.has(c));
  }
  return columns;
}

/**
 * Check a whole recipe against the columns of the table it starts from:
 * for each step, null or the reason it cannot run (steps switched off are
 * not checked and do not change the columns).
 *
 * @param {string[]} columns
 * @param {object[]} steps
 * @returns {(string|null)[]}
 */
export function checkRecipe(columns, steps) {
  let cols = columns;
  return steps.map(step => {
    if (!step || step.enabled === false) return null;
    const problem = checkStep(step, cols);
    if (!problem) cols = columnsAfterStep(cols, step);
    return problem;
  });
}

function mapColumns(table, names, makeChange) {
  const idx = names.map(c => table.columns.indexOf(c));
  const changes = idx.map((i, k) => makeChange(names[k], i));
  let changed = 0;
  const rows = table.rows.map(row => {
    let copy = null;
    for (let k = 0; k < idx.length; k++) {
      const change = changes[k];
      if (!change) continue;
      const i = idx[k];
      const v = row[i];
      const w = change(v);
      // Object.is, so -0 becoming 0 counts (Python's abs(-0.0) is 0.0).
      if (!Object.is(w, v)) {
        if (!copy) copy = row.slice();
        copy[i] = w;
        changed++;
      }
    }
    return copy || row;
  });
  return { table: { columns: table.columns, rows }, changed };
}

const numbersIn = (table, i) => {
  const out = [];
  for (const row of table.rows) if (isNumber(row[i])) out.push(row[i]);
  return out;
};

// Apply a change to text cells; empty text becomes missing.
const onText = (change) => (v) => {
  if (!isText(v)) return v;
  const w = change(v);
  return w === '' ? null : w;
};

// Apply a change to numbers; a result that is not a finite number becomes missing.
const onNumbers = (change) => (v) => {
  if (!isNumber(v)) return v;
  const w = change(v);
  return isNumber(w) ? w : null;
};

/**
 * Convert text to a number as the toNumber step does: spaces at the ends are
 * ignored, and text that is not a number gives null (or stays unchanged,
 * with `keep`).
 *
 * @param {string} text
 * @param {'.'|','} [decimal='.']
 * @param {boolean} [keep=false]
 * @returns {number|string|null}
 */
export function textToNumber(text, decimal = '.', keep = false) {
  const value = readCell(stripSpaces(text), decimal);
  if (typeof value === 'string') return keep ? text : null;
  return value;
}

function sameValue(v, value) {
  return typeof value === 'number' ? isNumber(v) && v === value : v === value;
}

function filterTest(step) {
  const { op, value } = step;
  switch (op) {
    case 'eq': return v => sameValue(v, value);
    case 'ne': return v => !sameValue(v, value);
    case 'gt': return v => isNumber(v) && v > value;
    case 'gte': return v => isNumber(v) && v >= value;
    case 'lt': return v => isNumber(v) && v < value;
    case 'lte': return v => isNumber(v) && v <= value;
    case 'contains': {
      const needle = String(value).toLowerCase();
      return v => cellText(v).toLowerCase().includes(needle);
    }
    case 'notContains': {
      const needle = String(value).toLowerCase();
      return v => !cellText(v).toLowerCase().includes(needle);
    }
    case 'missing': return v => v === null || v === undefined;
    case 'present': return v => v !== null && v !== undefined;
    default: return () => true;
  }
}

/**
 * The sort order the sort step uses between two cells that are not missing:
 * numbers first, by value; then text, by code point after lower-casing.
 *
 * @param {number|string} a
 * @param {number|string} b
 * @returns {number}
 */
export function compareCells(a, b) {
  const an = isNumber(a);
  const bn = isNumber(b);
  if (an && bn) return a < b ? -1 : a > b ? 1 : 0;
  if (an) return -1;
  if (bn) return 1;
  return compareCodePoints(String(a).toLowerCase(), String(b).toLowerCase());
}

/**
 * Apply one step to a table. The step must pass checkStep first.
 *
 * @param {{columns:string[], rows:any[][]}} table
 * @param {object} step
 * @returns {{table:{columns:string[], rows:any[][]}, changed:number, note?:string}}
 */
export function applyStep(table, step) {
  const cols = stepColumns(step, table.columns);
  const index = (c) => table.columns.indexOf(c);
  switch (step.type) {
    case 'dropMissing': {
      const idx = cols.map(index);
      const rows = table.rows.filter(r => idx.every(i => r[i] !== null && r[i] !== undefined));
      return { table: { columns: table.columns, rows }, changed: 0 };
    }
    case 'dedupe': {
      const idx = cols.map(index);
      const seen = new Set();
      const rows = [];
      for (const r of table.rows) {
        const key = JSON.stringify(idx.map(i => (r[i] === undefined ? null : r[i])));
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push(r);
      }
      return { table: { columns: table.columns, rows }, changed: 0 };
    }
    case 'filter': {
      const i = index(step.column);
      const test = filterTest(step);
      return { table: { columns: table.columns, rows: table.rows.filter(r => test(r[i])) }, changed: 0 };
    }
    case 'sort': {
      const i = index(step.column);
      const present = [];
      const missing = [];
      for (const r of table.rows) (r[i] === null || r[i] === undefined ? missing : present).push(r);
      const sign = step.descending ? -1 : 1;
      present.sort((a, b) => sign * compareCells(a[i], b[i]));
      return { table: { columns: table.columns, rows: present.concat(missing) }, changed: 0 };
    }
    case 'fill': {
      let note;
      const r = mapColumns(table, cols, (name, i) => {
        if (step.method === 'previous') {
          let last = null;
          return v => {
            if (v === null || v === undefined) return last;
            last = v;
            return v;
          };
        }
        let value = step.value;
        if (step.method === 'mean' || step.method === 'median') {
          const values = numbersIn(table, i);
          if (!values.length) return null;
          value = step.method === 'mean' ? exactMean(values) : median(values);
          if (cols.length === 1) note = `${step.method} ${formatForNote(value)}`;
        }
        return v => (v === null || v === undefined ? value : v);
      });
      return { ...r, note };
    }
    case 'replace': {
      const change = step.whole
        ? (v => (sameValue(v, step.find) ? step.with : v))
        : onText(s => s.split(step.find).join(step.with));
      return mapColumns(table, cols, () => change);
    }
    case 'trim': {
      const tidy = step.collapse ? (s => stripSpaces(s.replace(SPACE_RUN, ' '))) : stripSpaces;
      return mapColumns(table, cols, () => onText(tidy));
    }
    case 'case': {
      const change = step.mode === 'upper' ? (s => s.toUpperCase())
        : step.mode === 'lower' ? (s => s.toLowerCase()) : titleCase;
      return mapColumns(table, cols, () => onText(change));
    }
    case 'toNumber': {
      const keep = step.invalid === 'keep';
      return mapColumns(table, cols, () => onText(s => textToNumber(s, step.decimal, keep)));
    }
    case 'round': {
      const options = { significant: !!step.significant, ties: step.ties === 'even' ? 'even' : 'up' };
      return mapColumns(table, cols, () => onNumbers(x => roundNumber(x, step.digits, options)));
    }
    case 'transform': {
      let dropped = 0;
      const r = mapColumns(table, cols, (name, i) => {
        switch (step.operation) {
          case 'log10':
          case 'ln': {
            const log = step.operation === 'log10' ? exactLog10 : exactLn;
            return onNumbers(x => {
              if (x > 0) return log(x);
              dropped++;
              return null;
            });
          }
          case 'abs': return onNumbers(Math.abs);
          case 'multiply': return onNumbers(x => x * step.value);
          case 'add': return onNumbers(x => x + step.value);
          case 'minmax': {
            const values = numbersIn(table, i);
            if (!values.length) return null;
            let low = values[0];
            let high = values[0];
            for (const v of values) { if (v < low) low = v; if (v > high) high = v; }
            return onNumbers(x => (high !== low ? (x - low) / (high - low) : 0));
          }
          case 'zscore': {
            const values = numbersIn(table, i);
            if (!values.length) return null;
            const m = exactMean(values);
            const sd = Math.sqrt(exactSum(values.map(x => (x - m) * (x - m))) / values.length);
            return onNumbers(x => (sd !== 0 ? (x - m) / sd : 0));
          }
          default: return null;
        }
      });
      const note = dropped ? `${dropped} zero or negative ${dropped === 1 ? 'value' : 'values'} became missing` : undefined;
      return { ...r, note };
    }
    case 'rename': {
      const to = stripSpaces(step.to);
      return { table: { columns: table.columns.map(c => (c === step.column ? to : c)), rows: table.rows }, changed: 0 };
    }
    case 'dropColumns': {
      const drop = new Set(step.columns);
      const keep = table.columns.map((c, i) => (drop.has(c) ? -1 : i)).filter(i => i >= 0);
      return {
        table: { columns: keep.map(i => table.columns[i]), rows: table.rows.map(r => keep.map(i => r[i])) },
        changed: 0
      };
    }
    default:
      return { table, changed: 0 };
  }
}

function formatForNote(x) {
  return Number.isInteger(x) ? String(x) : String(Number(x.toPrecision(6)));
}

/**
 * Replay a recipe on a table. Each result records the rows and columns
 * before and after, how many cells changed, and the table after the step,
 * so a page can show counts and preview any point in the recipe. A step
 * that is switched off, or cannot run at its place (a column renamed or
 * removed earlier, say), leaves the table as it was.
 *
 * @param {{columns:string[], rows:any[][]}} table
 * @param {object[]} steps
 * @returns {{table:{columns:string[], rows:any[][]}, results:object[]}}
 */
export function runRecipe(table, steps, options = {}) {
  const { reuse } = options;
  const results = [];
  let current = table;
  let reusing = !!reuse;
  (steps || []).forEach((step, k) => {
    if (reusing && reuse.steps[k] !== undefined && reuse.results[k] && stepKey(reuse.steps[k]) === stepKey(step)) {
      results.push(reuse.results[k]);
      current = reuse.results[k].table;
      return;
    }
    reusing = false;
    const base = { rowsBefore: current.rows.length, columnsBefore: current.columns.length };
    const problem = step && step.enabled !== false ? checkStep(step, current.columns) : null;
    if (!step || step.enabled === false || problem) {
      results.push({
        ...base,
        status: problem ? 'error' : 'off',
        error: problem || undefined,
        rowsAfter: base.rowsBefore,
        columnsAfter: base.columnsBefore,
        changed: 0,
        table: current
      });
      return;
    }
    const r = applyStep(current, step);
    current = r.table;
    results.push({
      ...base,
      status: 'ok',
      rowsAfter: current.rows.length,
      columnsAfter: current.columns.length,
      changed: r.changed,
      note: r.note,
      table: current
    });
  });
  return { table: current, results };
}

function stepKey(step) {
  return JSON.stringify(step, (k, v) => (k === 'id' ? undefined : v));
}

/* ---------------------------------------------------------------------- *
 * Describing steps in words
 * ---------------------------------------------------------------------- */

const OP_WORDS = {
  eq: 'is', ne: 'is not', gt: 'is more than', gte: 'is at least', lt: 'is less than', lte: 'is at most',
  contains: 'contains', notContains: 'does not contain', missing: 'is missing', present: 'is not missing'
};

/**
 * A list of names in words: "a", "a and b", "a, b and c", "5 columns".
 *
 * @param {string[]} names
 * @param {string} [all='every column']  what an empty list means
 * @returns {string}
 */
export function listColumns(names, all = 'every column') {
  if (!names || !names.length) return all;
  if (names.length > 4) return `${names.length} columns`;
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * A value as the step descriptions quote it: numbers bare, text in quotes.
 *
 * @param {*} v
 * @returns {string}
 */
export function quoteValue(v) {
  if (v === null || v === undefined) return 'a missing value';
  return typeof v === 'number' ? String(v) : `"${v}"`;
}

/**
 * One sentence saying what a step does, for the recipe list and as the
 * comment above the step in the Python script.
 *
 * @param {object} step
 * @returns {string}
 */
export function describeStep(step) {
  if (!step) return 'Unknown step';
  const cols = Array.isArray(step.columns) ? step.columns : [];
  const where = listColumns(cols);
  switch (step.type) {
    case 'dropMissing':
      if (!cols.length) return 'Drop rows with a missing value';
      if (cols.length === 1) return `Drop rows where ${cols[0]} is missing`;
      return `Drop rows with a missing value in ${where}`;
    case 'dedupe':
      return cols.length ? `Remove duplicate rows, comparing ${where}` : 'Remove duplicate rows';
    case 'filter': {
      const words = OP_WORDS[step.op] || step.op;
      if (step.op === 'missing' || step.op === 'present') return `Keep rows where ${step.column} ${words}`;
      return `Keep rows where ${step.column} ${words} ${quoteValue(step.value)}`;
    }
    case 'sort':
      return `Sort rows by ${step.column}, ${step.descending ? 'descending' : 'ascending'}`;
    case 'fill': {
      const what = step.method === 'mean' ? 'the column mean'
        : step.method === 'median' ? 'the column median'
          : step.method === 'previous' ? 'the value above' : quoteValue(step.value);
      return `Fill missing values in ${where} with ${what}`;
    }
    case 'replace':
      if (step.whole) return `Replace ${quoteValue(step.find)} with ${quoteValue(step.with)} in ${where}`;
      if (step.with === '') return `Remove "${step.find}" from text in ${where}`;
      return `Replace "${step.find}" with "${step.with}" inside text in ${where}`;
    case 'trim':
      return step.collapse ? `Trim spaces and shrink runs of spaces in ${where}` : `Trim spaces in ${where}`;
    case 'case':
      return `Change text in ${where} to ${step.mode === 'upper' ? 'upper' : step.mode === 'lower' ? 'lower' : 'title'} case`;
    case 'toNumber':
      return `Convert text to numbers in ${where}${step.invalid === 'keep' ? ', keeping other text' : ', other text becomes missing'}`;
    case 'round': {
      const unit = step.significant
        ? `${step.digits} significant ${step.digits === 1 ? 'figure' : 'figures'}`
        : `${step.digits} decimal ${Math.abs(step.digits) === 1 ? 'place' : 'places'}`;
      return `Round ${where} to ${unit}${step.ties === 'even' ? ', ties to even' : ''}`;
    }
    case 'transform':
      switch (step.operation) {
        case 'log10': return `Take log10 of ${where}`;
        case 'ln': return `Take the natural log of ${where}`;
        case 'abs': return `Take the absolute value of ${where}`;
        case 'minmax': return `Rescale ${where} to 0 to 1 (min-max)`;
        case 'zscore': return `Standardise ${where} as z-scores`;
        case 'multiply': return `Multiply ${where} by ${step.value}`;
        case 'add': return step.value < 0 ? `Subtract ${-step.value} from ${where}` : `Add ${step.value} to ${where}`;
        default: return `Transform ${where}`;
      }
    case 'rename':
      return `Rename ${step.column} to ${typeof step.to === 'string' ? stripSpaces(step.to) : ''}`;
    case 'dropColumns':
      return cols.length === 1 ? `Remove the column ${cols[0]}` : `Remove the columns ${where}`;
    default:
      return 'Unknown step';
  }
}

/* ---------------------------------------------------------------------- *
 * Recipes as files
 * ---------------------------------------------------------------------- */

const STEP_FIELDS = {
  dropMissing: ['columns'],
  dedupe: ['columns'],
  filter: ['column', 'op', 'value'],
  sort: ['column', 'descending'],
  fill: ['columns', 'method', 'value'],
  replace: ['columns', 'find', 'with', 'whole'],
  trim: ['columns', 'collapse'],
  case: ['columns', 'mode'],
  toNumber: ['columns', 'decimal', 'invalid'],
  round: ['columns', 'digits', 'significant', 'ties'],
  transform: ['columns', 'operation', 'value'],
  rename: ['column', 'to'],
  dropColumns: ['columns']
};

/**
 * A clean copy of a step with only the fields its type uses, and the
 * defaults filled in. Throws when the step is not one the cleaner knows.
 *
 * @param {object} step
 * @returns {object}
 */
export function normaliseStep(step) {
  if (!step || typeof step !== 'object' || !STEP_TYPES.includes(step.type)) {
    throw new Error(`"${step && step.type}" is not a step the Data Cleaner knows.`);
  }
  const out = { type: step.type };
  for (const f of STEP_FIELDS[step.type]) {
    if (step[f] !== undefined) out[f] = step[f];
  }
  if ('columns' in out || STEP_FIELDS[step.type].includes('columns')) {
    out.columns = Array.isArray(out.columns) ? out.columns.map(String) : [];
  }
  if (out.value === undefined && STEP_FIELDS[step.type].includes('value')) delete out.value;
  switch (step.type) {
    case 'sort': out.descending = !!out.descending; break;
    case 'trim': out.collapse = !!out.collapse; break;
    case 'replace':
      out.whole = out.whole !== false;
      if (out.with === undefined) out.with = out.whole ? null : '';
      break;
    case 'toNumber':
      out.decimal = out.decimal === ',' ? ',' : '.';
      out.invalid = out.invalid === 'keep' ? 'keep' : 'missing';
      break;
    case 'round':
      out.significant = !!out.significant;
      out.ties = out.ties === 'even' ? 'even' : 'up';
      out.digits = Number(out.digits);
      break;
    case 'fill':
      if (out.method !== 'value') delete out.value;
      break;
    default:
      break;
  }
  if (step.enabled === false) out.enabled = false;
  return out;
}

/**
 * A recipe as the JSON the Data Cleaner saves.
 *
 * @param {object[]} steps
 * @param {object} [source]  the file it was made on and how it was read
 * @returns {string}
 */
export function recipeToJSON(steps, source) {
  const doc = {
    format: 'stemkit-data-cleaner-recipe',
    version: 1,
    ...(source ? { source } : {}),
    steps: steps.map(normaliseStep)
  };
  return JSON.stringify(doc, null, 2) + '\n';
}

/**
 * Read a recipe saved by recipeToJSON (or a bare list of steps).
 *
 * @param {string|object} input
 * @returns {{steps:object[], source:object|null}}
 */
export function parseRecipe(input) {
  let doc = input;
  if (typeof input === 'string') {
    try {
      doc = JSON.parse(input);
    } catch (e) {
      throw new Error('This file is not a recipe: it is not valid JSON.');
    }
  }
  const list = Array.isArray(doc) ? doc : doc && Array.isArray(doc.steps) ? doc.steps : null;
  if (!list) throw new Error('This file is not a recipe: it has no list of steps.');
  const steps = list.map((s, i) => {
    try {
      return normaliseStep(s);
    } catch (e) {
      throw new Error(`Step ${i + 1}: ${e.message}`);
    }
  });
  return { steps, source: doc && !Array.isArray(doc) && doc.source ? doc.source : null };
}

/* ---------------------------------------------------------------------- *
 * What a table holds
 * ---------------------------------------------------------------------- */

/**
 * Per-column counts for a table: numbers, text, missing values, text with
 * spaces at the ends, and text that would be a number once trimmed; with
 * the number of rows that repeat an earlier row.
 *
 * @param {{columns:string[], rows:any[][]}} table
 * @returns {{rows:number, missing:number, duplicateRows:number,
 *            columns:{name:string, numbers:number, texts:number, missing:number,
 *                     padded:number, numeric:number}[]}}
 */
export function profileTable(table) {
  const columns = table.columns.map(name => ({ name, numbers: 0, texts: 0, missing: 0, padded: 0, numeric: 0 }));
  const seen = new Set();
  let duplicateRows = 0;
  for (const row of table.rows) {
    for (let i = 0; i < columns.length; i++) {
      const v = row[i];
      const c = columns[i];
      if (v === null || v === undefined) c.missing++;
      else if (typeof v === 'number') c.numbers++;
      else {
        c.texts++;
        const t = stripSpaces(v);
        if (t !== v) c.padded++;
        if (typeof readCell(t) === 'number') c.numeric++;
      }
    }
    const key = JSON.stringify(row.map(v => (v === undefined ? null : v)));
    if (seen.has(key)) duplicateRows++;
    else seen.add(key);
  }
  return {
    rows: table.rows.length,
    missing: columns.reduce((a, c) => a + c.missing, 0),
    duplicateRows,
    columns
  };
}
