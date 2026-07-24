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
 * @param {string} line - A single data line.
 * @returns {number[]|null} The numeric row, or null when the line is not a
 *          valid all-numeric record.
 */
export function parseDataLine(line) {
  if (typeof line !== 'string') return null;
  const tokens = line.trim().split(/[\s,]+/).filter(Boolean);
  if (tokens.length === 0) return null;

  const row = new Array(tokens.length);
  for (let i = 0; i < tokens.length; i++) {
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
 * column k (k >= 1) inherits legend `s(k-1)` when present, otherwise a
 * deterministic fallback name.
 *
 * @param {number} colCount - Number of columns in the numeric matrix.
 * @param {Object<number,string>} legends - Legend map keyed by Grace series index.
 * @param {string} xAxisLabel - Resolved x-axis label.
 * @returns {string[]} Header array of length `colCount`.
 */
export function resolveHeaders(colCount, legends = {}, xAxisLabel = 'X') {
  const headers = new Array(Math.max(0, colCount));
  for (let c = 0; c < headers.length; c++) {
    const legend = legends[c - 1];
    if (c >= 1 && typeof legend === 'string' && legend.length > 0) {
      headers[c] = legend;
    } else if (c === 0) {
      headers[c] = xAxisLabel || 'X';
    } else {
      headers[c] = `Dataset ${c}`;
    }
  }
  return headers;
}

/**
 * Parse a complete `.xvg` (or generic delimited numeric) buffer.
 *
 * Rows of differing arity are preserved as-is; `colCount` reports the widest
 * row so that downstream consumers can decide how to handle ragged input.
 * Missing cells surface as `undefined` on extraction rather than being coerced
 * to zero, which would fabricate data.
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
 *   skippedLines: number
 * }}
 */
export function parseXvg(rawText, options = {}) {
  const { fallbackTitle = 'Log Data' } = options;

  const meta = { title: null, xAxisLabel: null, yAxisLabel: null, legends: {} };
  const matrix = [];
  let colCount = 0;
  let skippedLines = 0;

  const text = typeof rawText === 'string' ? rawText : '';
  const lines = text.split(/\r\n|\r|\n/);

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

    const row = parseDataLine(line);
    if (row === null) {
      skippedLines++;
      continue;
    }
    matrix.push(row);
    if (row.length > colCount) colCount = row.length;
  }

  const xAxisLabel = meta.xAxisLabel || 'X';
  const yAxisLabel = meta.yAxisLabel || 'Y';
  const headers = resolveHeaders(colCount, meta.legends, xAxisLabel);

  return {
    matrix,
    headers,
    colCount,
    rowCount: matrix.length,
    title: meta.title || fallbackTitle,
    xAxisLabel,
    yAxisLabel,
    skippedLines
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
 * @param {{
 *   headers?: string[], xIndex?: number, yIndices?: number[],
 *   title?: string, xAxisLabel?: string, yAxisLabel?: string,
 *   showMarkers?: boolean, logY?: boolean, filename?: string
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
    filename = 'your_file.xvg'
  } = config;

  if (!Array.isArray(yIndices) || yIndices.length === 0) {
    return '# Load a file and select at least one Y column, then click Python again.';
  }

  const py = pythonLiteral;
  let c = 'import matplotlib.pyplot as plt\nimport numpy as np\n\n';
  c += '# --- Load your .xvg (skips GROMACS @/# metadata lines) ---\n';
  c += `data = np.loadtxt(${py(filename)}, comments=['@', '#'])\n`;
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
