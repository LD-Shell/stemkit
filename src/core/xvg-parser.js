/**
 * @module core/xvg-parser
 *
 * Pure parsing and data-extraction routines for GROMACS/Grace `.xvg` files
 * and generic whitespace/comma-delimited numerical tables.
 *
 * This module is deliberately free of any DOM, browser, or UI dependency so
 * that it can be consumed identically by a browser bundle, by Node.js, or by
 * a headless test runner.
 *
 * Format reference: GROMACS writes Grace/xmgrace-compatible files in which
 *   - lines beginning with '#' are free-form comments,
 *   - lines beginning with '@' are Grace formatting directives
 *     (title, xaxis label, yaxis label, sN legend, ...),
 *   - all remaining non-empty lines are whitespace-delimited numeric records.
 *
 * A CSV may instead open with a header row naming its columns. That row is
 * recognised when it sits directly above the first numeric record and has as
 * many fields as the file's records; its names then label the columns. A line
 * that is only '&' ends one Grace data set; the rows of every set are read
 * into one matrix, in file order. Every record must have the number of fields
 * most of the numeric records have; a longer or shorter row is rejected rather
 * than padded or truncated.
 */

/** Default colour palette used for series assignment (UI-agnostic hex list). */
export const COLOR_PALETTE = Object.freeze([
  '#2563eb', '#ef4444', '#10b981', '#f59e0b',
  '#8b5cf6', '#06b6d4', '#ec4899'
]);

/**
 * Extract the first double-quoted substring from a Grace directive line.
 *
 * @param {string} line - A single '@' directive line.
 * @returns {string|null} The quoted value, or null when no closed pair exists.
 */
export function extractQuoted(line) {
  if (typeof line !== 'string') return null;
  const match = line.match(/"([^"]*)"/);
  return match ? match[1] : null;
}

/**
 * Parse a single Grace '@' metadata directive and fold it into a metadata
 * accumulator. Unrecognised directives are ignored silently, which mirrors the
 * permissive behaviour of xmgrace itself.
 *
 * Tolerates arbitrary internal whitespace, e.g. both
 *   `@    xaxis  label "Time (ps)"` and `@ xaxis label "Time (ps)"`.
 *
 * @param {string} line - The raw directive line (leading '@' included).
 * @param {{title:string|null,xAxisLabel:string|null,yAxisLabel:string|null,legends:Object<number,string>}} meta
 *        Mutable accumulator, updated in place.
 * @returns {boolean} True when the directive was recognised and consumed.
 */
export function parseMetadataLine(line, meta) {
  if (typeof line !== 'string') return false;
  const trimmed = line.trim();
  if (!trimmed.startsWith('@')) return false;

  const body = trimmed.slice(1).trim();
  const value = extractQuoted(body);

  // `@ sN legend "..."` -> series legend for data column N+1
  const legendMatch = body.match(/^s(\d+)\s+legend\b/i);
  if (legendMatch && value !== null) {
    meta.legends[Number(legendMatch[1])] = value;
    return true;
  }

  if (/^xaxis\s+label\b/i.test(body)) {
    if (value !== null) meta.xAxisLabel = value;
    return true;
  }

  if (/^yaxis\s+label\b/i.test(body)) {
    if (value !== null) meta.yAxisLabel = value;
    return true;
  }

  if (/^title\b/i.test(body)) {
    if (value !== null) meta.title = value;
    return true;
  }

  return false;
}

/**
 * Tokenise a data record into finite numbers.
 *
 * A record is accepted only if *every* token converts to a finite number;
 * partially numeric lines (stray text, NaN, Infinity) are rejected outright so
 * that malformed records never silently contaminate a trajectory.
 *
 * A line containing a comma is split on commas alone, and an empty field
 * rejects the record in the same way. Collapsing it instead would move every
 * later value one column to the left, so a series would silently take its
 * numbers from the wrong column.
 *
 * @param {string} line - A single data line.
 * @returns {number[]|null} The numeric row, or null when the line is not a
 *          valid all-numeric record.
 */
export function parseDataLine(line) {
  if (typeof line !== 'string') return null;
  const trimmed = line.trim();
  if (trimmed === '') return null;
  const tokens = trimmed.includes(',')
    ? trimmed.split(',').map(t => t.trim())
    : trimmed.split(/\s+/);

  const row = new Array(tokens.length);
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === '') return null;
    const n = Number(tokens[i]);
    if (!Number.isFinite(n)) return null;
    row[i] = n;
  }
  return row;
}

/**
 * Resolve final column headers from parsed Grace legends and axis labels.
 *
 * Column 0 is conventionally the abscissa and inherits the x-axis label;
 * column k (k >= 1) inherits legend `s(k-1)` when present, then the name from
 * a CSV header row, otherwise a deterministic fallback name.
 *
 * @param {number} colCount - Number of columns in the numeric matrix.
 * @param {Object<number,string>} legends - Legend map keyed by Grace series index.
 * @param {string} xAxisLabel - Resolved x-axis label.
 * @param {string[]} [names] - Column names from a header row, if the file has one.
 * @returns {string[]} Header array of length `colCount`.
 */
export function resolveHeaders(colCount, legends = {}, xAxisLabel = 'X', names = []) {
  const headers = new Array(Math.max(0, colCount));
  for (let c = 0; c < headers.length; c++) {
    const legend = legends[c - 1];
    const name = Array.isArray(names) ? names[c] : undefined;
    if (c >= 1 && typeof legend === 'string' && legend.length > 0) {
      headers[c] = legend;
    } else if (c >= 1 && typeof name === 'string' && name.length > 0) {
      headers[c] = name;
    } else if (c === 0) {
      headers[c] = xAxisLabel || 'X';
    } else {
      headers[c] = `Dataset ${c}`;
    }
  }
  return headers;
}

/**
 * Split a header row into column names, dropping quotes around each name.
 *
 * @param {string} line
 * @param {string|null} delimiter - ',' for a CSV, null for whitespace.
 * @returns {string[]}
 */
function splitHeaderRow(line, delimiter) {
  const fields = delimiter === ',' ? line.split(',') : line.split(/\s+/);
  while (fields.length && fields[fields.length - 1].trim() === '') fields.pop();
  return fields.map(f => f.trim().replace(/^(["'])(.*)\1$/, '$2').trim());
}

/**
 * Whether every numeric line of a file ends with a comma.
 *
 * Some programs end each CSV row with the delimiter. When every numeric line
 * does so, the empty field after it is an artefact of the export, not a
 * missing value, and is dropped. One numeric line without it means the commas
 * mark real gaps, and those records stay rejected.
 *
 * @param {string[]} lines - The file's lines.
 * @returns {boolean}
 */
function hasTrailingDelimiter(lines) {
  let found = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line === '' || line[0] === '@' || line[0] === '#' || line === '&') continue;
    if (parseDataLine(line)) return false;
    if (line.endsWith(',') && parseDataLine(line.slice(0, -1))) found = true;
  }
  return found;
}

/**
 * Parse a complete `.xvg` (or generic delimited numeric) buffer.
 *
 * `colCount` is the number of fields that most numeric records have (ties go
 * to the width seen first), and the header row is only adopted when it has
 * the same number. A record with a different number is rejected and counted,
 * because a short or long row cannot be placed in the columns without guessing
 * which value is missing. Taking the most common width rather than the first
 * means one malformed opening line cannot reject the rest of the file.
 *
 * `delimiter`, `skipRows` and `strayLines` describe the file for
 * `numpy.loadtxt`: the delimiter is ',' when the records are comma-separated
 * (null means whitespace, NumPy's default), `skipRows` counts the lines before
 * the first record whenever any of them was rejected, such as a CSV header
 * row, and `strayLines` counts the rejected lines found after the first
 * record, which
 * `loadtxt` would otherwise stop at. `trailingDelimiter` is true when every
 * numeric line ends with a comma and that last empty field was dropped.
 *
 * @param {string} rawText - Full file contents.
 * @param {{fallbackTitle?: string}} [options]
 * @returns {{
 *   matrix: number[][],
 *   headers: string[],
 *   colCount: number,
 *   rowCount: number,
 *   title: string,
 *   xAxisLabel: string,
 *   yAxisLabel: string,
 *   skippedLines: number,
 *   delimiter: string|null,
 *   skipRows: number,
 *   strayLines: number,
 *   trailingDelimiter: boolean
 * }}
 */
export function parseXvg(rawText, options = {}) {
  const { fallbackTitle = 'Log Data' } = options;

  const meta = { title: null, xAxisLabel: null, yAxisLabel: null, legends: {} };
  const matrix = [];
  let colCount = 0;
  let skippedLines = 0;
  let delimiter = null;
  let skipRows = 0;
  let strayLines = 0;
  let names = [];
  // The last text line before any numeric line: a header candidate.
  let headerLine = null;
  let sawNumeric = false;
  let rejectedBefore = false;

  const text = typeof rawText === 'string' ? rawText : '';
  const lines = text.split(/\r\n|\r|\n/);
  const trailingDelimiter = hasTrailingDelimiter(lines);

  // First pass: parse every candidate record and find the most common width.
  const parsed = new Array(lines.length).fill(null);
  const widths = new Map();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '' || line[0] === '@' || line[0] === '#' || line === '&') continue;
    const body = trailingDelimiter && line.endsWith(',') ? line.slice(0, -1) : line;
    const row = parseDataLine(body);
    if (row === null) continue;
    parsed[i] = row;
    widths.set(row.length, (widths.get(row.length) || 0) + 1);
  }
  // Map iteration follows insertion order, so a tie keeps the width seen first.
  let most = 0;
  for (const [w, n] of widths) {
    if (n > most) { most = n; colCount = w; }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '') continue;

    if (line.startsWith('@')) {
      parseMetadataLine(line, meta);
      continue;
    }
    if (line.startsWith('#')) continue;
    // Grace multi-set separator; not a data record.
    if (line === '&') continue;

    const row = parsed[i];
    if (row === null || row.length !== colCount) {
      skippedLines++;
      if (matrix.length > 0) strayLines++;
      else rejectedBefore = true;
      if (row === null && !sawNumeric) headerLine = line;
      if (row !== null) sawNumeric = true;
      continue;
    }
    sawNumeric = true;
    if (matrix.length === 0) {
      delimiter = line.includes(',') ? ',' : null;
      if (rejectedBefore) skipRows = i;
      if (headerLine !== null) {
        // A header names at least one column in words; a line that is numbers
        // apart from empty fields is a malformed record instead.
        const fields = splitHeaderRow(headerLine, delimiter);
        const named = fields.some(f => f !== '' && !Number.isFinite(Number(f)));
        if (fields.length === colCount && named) {
          names = fields;
          skippedLines--;
        }
      }
    }
    matrix.push(row);
  }

  const xAxisLabel = meta.xAxisLabel || names[0] || 'X';
  const yAxisLabel = meta.yAxisLabel || 'Y';
  const headers = resolveHeaders(colCount, meta.legends, xAxisLabel, names);

  return {
    matrix,
    headers,
    colCount,
    rowCount: matrix.length,
    title: meta.title || fallbackTitle,
    xAxisLabel,
    yAxisLabel,
    skippedLines,
    delimiter,
    skipRows,
    strayLines,
    trailingDelimiter
  };
}

/**
 * Extract a single column from a parsed matrix.
 *
 * @param {number[][]} matrix
 * @param {number} index - Zero-based column index.
 * @returns {Array<number|undefined>} Column values; `undefined` for short rows.
 */
export function extractColumn(matrix, index) {
  if (!Array.isArray(matrix)) return [];
  if (!Number.isInteger(index) || index < 0) return [];
  return matrix.map(row => (Array.isArray(row) ? row[index] : undefined));
}

/**
 * Extract an (x, y) series pair, discarding records in which either coordinate
 * is absent or non-finite. Pairing is preserved: index i of `x` always
 * corresponds to index i of `y`.
 *
 * @param {number[][]} matrix
 * @param {number} xIndex
 * @param {number} yIndex
 * @returns {{x: number[], y: number[]}}
 */
export function extractSeries(matrix, xIndex, yIndex) {
  const x = [];
  const y = [];
  if (!Array.isArray(matrix)) return { x, y };

  for (const row of matrix) {
    if (!Array.isArray(row)) continue;
    const xv = row[xIndex];
    const yv = row[yIndex];
    if (Number.isFinite(xv) && Number.isFinite(yv)) {
      x.push(xv);
      y.push(yv);
    }
  }
  return { x, y };
}

/**
 * Choose the default set of ordinate columns to display.
 *
 * Wide files (more than four columns) default to the first two data columns to
 * keep the initial render legible; narrower files show every data column.
 *
 * @param {number} colCount
 * @returns {number[]} Sorted, zero-based column indices (never includes 0).
 */
export function defaultActiveColumns(colCount) {
  if (!Number.isFinite(colCount) || colCount < 2) return [];
  const limit = colCount > 4 ? 3 : colCount;
  const out = [];
  for (let i = 1; i < limit; i++) out.push(i);
  return out;
}

/**
 * Compute descriptive statistics for a numeric column.
 *
 * The variance uses the unbiased (Bessel-corrected, n-1) estimator, matching
 * `numpy.std(..., ddof=1)` and the convention used throughout STEMKit.
 * Non-finite entries are excluded before computation.
 *
 * @param {Array<number|undefined>} values
 * @returns {{n:number, min:number, max:number, mean:number, std:number}|null}
 *          Null when no finite values are present.
 */
export function columnStats(values) {
  if (!Array.isArray(values)) return null;
  const clean = values.filter(Number.isFinite);
  const n = clean.length;
  if (n === 0) return null;

  let min = clean[0];
  let max = clean[0];
  let sum = 0;
  for (const v of clean) {
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  const mean = sum / n;

  let sq = 0;
  for (const v of clean) {
    const d = v - mean;
    sq += d * d;
  }
  const std = n > 1 ? Math.sqrt(sq / (n - 1)) : 0;

  return { n, min, max, mean, std };
}

/**
 * Generate a synthetic GROMACS-style `.xvg` buffer (RMSD + radius of gyration).
 *
 * A deterministic linear congruential generator is used instead of `Math.random`
 * so that the sample is byte-for-byte reproducible for a given seed, a
 * requirement for using the sample in regression tests and documentation.
 *
 * @param {{tMax?:number, dt?:number, seed?:number}} [options]
 * @returns {string} A valid `.xvg` document.
 */
export function generateSampleXvg(options = {}) {
  const { tMax = 1000, dt = 10, seed = 42 } = options;

  let s = seed >>> 0;
  const rand = () => {
    // Numerical Recipes LCG; returns a value in [0, 1).
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 4294967296;
  };

  let xvg = '# Synthetic sample generated by STEMKit\n';
  xvg += '@    title "RMSD & Radius of Gyration"\n';
  xvg += '@    xaxis  label "Time (ps)"\n';
  xvg += '@    yaxis  label "nm"\n';
  xvg += '@ s0 legend "Backbone RMSD"\n';
  xvg += '@ s1 legend "Rg"\n';

  for (let t = 0; t <= tMax; t += dt) {
    const rmsd = (0.12 + 0.08 * (1 - Math.exp(-t / 200)) + (rand() - 0.5) * 0.02).toFixed(4);
    const rg = (1.85 + 0.05 * Math.sin(t / 120) + (rand() - 0.5) * 0.01).toFixed(4);
    xvg += `${t.toFixed(1)}   ${rmsd}   ${rg}\n`;
  }
  return xvg;
}

/**
 * Escape a JavaScript string for safe embedding in single-quoted Python source.
 *
 * @param {*} value
 * @returns {string} A quoted Python string literal.
 */
export function pythonLiteral(value) {
  return "'" + String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
}

/**
 * Emit a standalone, runnable matplotlib script that reproduces the current
 * plot from the original `.xvg` file. This is the reproducibility bridge: the
 * figure a user sees in the browser can be regenerated offline, unchanged.
 *
 * `delimiter`, `skipRows` and `strayLines` come from `parseXvg`, so a CSV is
 * read with `delimiter=','` and its header row is skipped rather than parsed
 * as numbers. `comments` covers the '@' and '#' lines and the '&' that ends a
 * Grace data set, so the sets are read one after another, as the parser reads
 * them. When the parser rejected lines among the numeric records, the script
 * instead passes `loadtxt` only the lines the parser kept: `colCount` numbers
 * each, with a trailing comma dropped when `trailingDelimiter` is set. A
 * trailing comma also brings `usecols`, so NumPy ignores the empty last field.
 *
 * @param {{
 *   headers?: string[], xIndex?: number, yIndices?: number[],
 *   title?: string, xAxisLabel?: string, yAxisLabel?: string,
 *   showMarkers?: boolean, logY?: boolean, filename?: string,
 *   delimiter?: string|null, skipRows?: number, strayLines?: number,
 *   colCount?: number, trailingDelimiter?: boolean
 * }} config
 * @returns {string} Python source code.
 */
export function generateMatplotlibCode(config = {}) {
  const {
    headers = [],
    xIndex = 0,
    yIndices = [],
    title = '',
    xAxisLabel = 'x',
    yAxisLabel = 'y',
    showMarkers = false,
    logY = false,
    filename = 'your_file.xvg',
    delimiter = null,
    skipRows = 0,
    strayLines = 0,
    colCount = 0,
    trailingDelimiter = false
  } = config;

  if (!Array.isArray(yIndices) || yIndices.length === 0) {
    return '# Load a file and select at least one Y column, then click Python again.';
  }

  const py = pythonLiteral;
  let c = 'import matplotlib.pyplot as plt\nimport numpy as np\n\n';
  const width = Number.isInteger(colCount) && colCount > 0 ? colCount : 0;
  const trailing = Boolean(trailingDelimiter) && width > 0;
  const sep = (delimiter ? `, delimiter=${py(delimiter)}` : '') +
              (trailing ? `, usecols=range(${width})` : '');
  if (strayLines > 0) {
    // Text or ragged rows among the numbers would stop loadtxt, so the script
    // applies the parser's rule itself: a line is data only if it holds the
    // file's number of fields and every one is a number.
    c += '# --- Load your file: only the rows the page plotted' +
         `${width ? `, ${width} numbers each` : ''} ---\n`;
    c += 'def is_record(line):\n';
    if (trailing) {
      c += '    line = line.strip()\n';
      c += "    if line.endswith(','):  # each row ends with a comma; not a value\n";
      c += '        line = line[:-1]\n';
    }
    c += "    fields = line.split(',') if ',' in line else line.split()\n";
    c += '    try:\n';
    c += `        return ${width ? `len(fields) == ${width}` : 'bool(fields)'} and ` +
         'all(np.isfinite(float(f)) for f in fields)\n';
    c += '    except ValueError:\n';
    c += '        return False\n\n';
    c += `with open(${py(filename)}) as f:\n`;
    c += `    data = np.loadtxt([line for line in f if is_record(line)]${sep})\n`;
  } else {
    const rows = Number.isInteger(skipRows) && skipRows > 0 ? skipRows : 0;
    if (delimiter === ',' || rows) {
      const skip = rows === 1 ? 'the first line' : `the first ${rows} lines`;
      c += `# --- Load your file (${delimiter === ',' ? 'comma-separated; ' : ''}` +
           `skips ${rows ? skip + ' and ' : ''}@/#/& lines) ---\n`;
    } else {
      c += '# --- Load your .xvg (skips GROMACS @/# metadata lines and & set breaks) ---\n';
    }
    c += `data = np.loadtxt(${py(filename)}${sep}${rows ? `, skiprows=${rows}` : ''}, ` +
         "comments=['@', '#', '&'])\n";
  }
  c += `# Columns: ${xIndex} = ${headers[xIndex] || 'x'}`;
  c += yIndices.map(i => `, ${i} = ${headers[i] || 'y' + i}`).join('');
  c += '\n\n';
  c += `x = data[:, ${xIndex}]\n\n`;
  c += 'fig, ax = plt.subplots(figsize=(8, 5), dpi=150)\n';

  for (const i of yIndices) {
    const color = COLOR_PALETTE[i % COLOR_PALETTE.length];
    const label = headers[i] || `Dataset ${i}`;
    const style = showMarkers ? ", marker='o', markersize=3" : '';
    c += `ax.plot(x, data[:, ${i}], color='${color}', lw=1.5${style}, label=${py(label)})\n`;
  }

  c += `\nax.set_xlabel(${py(headers[xIndex] || xAxisLabel || 'x')})\n`;
  c += `ax.set_ylabel(${py(yAxisLabel || 'y')})\n`;
  if (title) c += `ax.set_title(${py(title)})\n`;
  if (logY) c += "ax.set_yscale('log')\n";
  c += 'ax.legend(frameon=True)\n';
  c += "ax.spines['top'].set_visible(False)\nax.spines['right'].set_visible(False)\n";
  c += "fig.tight_layout()\nfig.savefig('plot.png', dpi=300, bbox_inches='tight')\nplt.show()\n";
  return c;
}
