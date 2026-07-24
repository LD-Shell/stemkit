/**
 * @module core/latex
 *
 * LaTeX table generation and text escaping, extracted from STEMKit's LaTeX
 * Tables and LaTeX Formatter tools.
 */

/**
 * Characters requiring escape in LaTeX text mode, with their replacements.
 *
 * The backslash must map to a macro rather than to `\\`, which in LaTeX means
 * a line break rather than a literal backslash.
 */
const LATEX_ESCAPES = Object.freeze({
  '&': '\\&',
  '%': '\\%',
  '$': '\\$',
  '#': '\\#',
  '_': '\\_',
  '{': '\\{',
  '}': '\\}',
  '~': '\\textasciitilde{}',
  '^': '\\textasciicircum{}',
  '\\': '\\textbackslash{}'
});

/**
 * Escape a string for LaTeX text mode.
 *
 * Escaping is performed in a single pass. This matters: a two-step approach
 * that first replaces backslashes and then braces will re-escape the braces
 * that `\textbackslash{}` just introduced, producing the broken output
 * `\textbackslash\{\}` for any cell containing a backslash. Because
 * `String.replace` scans the original string, characters inserted by the
 * replacement are never themselves matched.
 *
 * @param {*} text
 * @returns {string}
 */
export function escapeLatex(text) {
  if (text === null || text === undefined) return '';
  return String(text).replace(/[&%$#_{}~^\\]/g, c => LATEX_ESCAPES[c]);
}

/**
 * Parse delimited text into a matrix of cells.
 *
 * Handles quoted fields containing the delimiter, and the Excel convention of
 * doubling a quote to escape it.
 *
 * @param {string} rawText
 * @param {{delimiter?:string}} [options] - Auto-detected when omitted.
 * @returns {string[][]}
 */
export function parseTableData(rawText, options = {}) {
  if (typeof rawText !== 'string' || rawText.trim() === '') return [];
  const lines = rawText.trim().split(/\r\n|\r|\n/).filter(l => l.trim() !== '');
  if (lines.length === 0) return [];

  const delimiter = options.delimiter || detectDelimiter(lines[0]);
  return lines.map(line => splitLine(line, delimiter));
}

/**
 * Guess a delimiter from a sample line.
 *
 * Tabs win when present, since a tab in tabular text is almost never literal
 * content; otherwise the most frequent candidate is chosen.
 *
 * @param {string} line
 * @returns {string}
 */
export function detectDelimiter(line) {
  if (typeof line !== 'string') return ',';
  if (line.includes('\t')) return '\t';

  const candidates = [',', ';', '|'];
  let best = ',';
  let bestCount = 0;
  for (const c of candidates) {
    const n = line.split(c).length - 1;
    if (n > bestCount) {
      bestCount = n;
      best = c;
    }
  }
  return bestCount > 0 ? best : ',';
}

/**
 * Split one delimited line, honouring quoted fields.
 *
 * @param {string} line
 * @param {string} delimiter
 * @returns {string[]}
 */
export function splitLine(line, delimiter) {
  const out = [];
  let cur = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      // A doubled quote inside a quoted field is a literal quote.
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === delimiter && !inQuotes) {
      out.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur.trim());
  return out;
}

/**
 * Build the column specification for a `tabular` environment.
 *
 * @param {number} colCount
 * @param {'l'|'c'|'r'} align
 * @param {'booktabs'|'grid'|'standard'|'plain'} style
 * @returns {string}
 */
export function buildColumnSpec(colCount, align, style) {
  const n = Math.max(0, Math.floor(colCount));
  if (style === 'grid') {
    return '|' + Array(n).fill(align).join('|') + '|';
  }
  const spec = Array(n).fill(align).join('');
  // booktabs recommends suppressing the outer column padding.
  return style === 'booktabs' ? `@{}${spec}@{}` : spec;
}

/**
 * Generate a complete LaTeX table.
 *
 * Required packages are emitted as leading comments so that a pasted snippet
 * tells the user what its preamble needs rather than failing to compile with
 * an opaque "undefined control sequence".
 *
 * @param {string[][]} matrix - Row 0 is the header.
 * @param {{
 *   environment?: string, style?: string, align?: 'l'|'c'|'r',
 *   caption?: string, label?: string, headerRow?: boolean
 * }} [options]
 * @returns {string}
 */
export function generateLatexTable(matrix, options = {}) {
  if (!Array.isArray(matrix) || matrix.length === 0) return '';

  const {
    environment = 'table',
    style = 'booktabs',
    align = 'l',
    caption = '',
    label = '',
    headerRow = true
  } = options;

  const colCount = matrix[0].length;
  const colSpec = buildColumnSpec(colCount, align, style);

  const packages = [];
  if (style === 'booktabs') packages.push('\\usepackage{booktabs}');
  if (environment === 'sidewaystable') packages.push('\\usepackage{rotating}');

  let out = '';
  if (packages.length) {
    out += packages.map(p => `% Requires: ${p}`).join('\n') + '\n';
  }

  out += `\\begin{${environment}}[htbp]\n\\centering\n`;
  if (caption) out += `\\caption{${escapeLatex(caption)}}\n`;
  if (label) out += `\\label{${escapeLatex(label)}}\n`;
  out += `\\begin{tabular}{${colSpec}}\n`;

  const topRule = style === 'booktabs' ? '\\toprule\n'
    : (style === 'grid' || style === 'standard') ? '\\hline\n' : '';
  const midRule = style === 'booktabs' ? '\\midrule\n'
    : (style === 'grid' || style === 'standard') ? '\\hline\n' : '';
  const bottomRule = style === 'booktabs' ? '\\bottomrule\n'
    : style === 'standard' ? '\\hline\n' : '';

  out += topRule;

  let startRow = 0;
  if (headerRow) {
    out += `    ${matrix[0].map(escapeLatex).join(' & ')} \\\\\n`;
    out += midRule;
    startRow = 1;
  }

  for (let i = startRow; i < matrix.length; i++) {
    out += `    ${matrix[i].map(escapeLatex).join(' & ')} \\\\\n`;
    if (style === 'grid') out += '\\hline\n';
  }

  // A grid style already closed the final row with a rule.
  if (!(style === 'grid')) out += bottomRule;

  out += `\\end{tabular}\n\\end{${environment}}`;
  return out;
}

/**
 * Convert a matrix into a Markdown table.
 *
 * @param {string[][]} matrix
 * @param {{align?:'l'|'c'|'r'}} [options]
 * @returns {string}
 */
export function generateMarkdownTable(matrix, options = {}) {
  if (!Array.isArray(matrix) || matrix.length === 0) return '';
  const { align = 'l' } = options;

  const sep = { l: ':---', c: ':---:', r: '---:' }[align] || '---';
  const escapePipe = (s) => String(s ?? '').replace(/\|/g, '\\|');

  const lines = [];
  lines.push(`| ${matrix[0].map(escapePipe).join(' | ')} |`);
  lines.push(`| ${matrix[0].map(() => sep).join(' | ')} |`);
  for (let i = 1; i < matrix.length; i++) {
    lines.push(`| ${matrix[i].map(escapePipe).join(' | ')} |`);
  }
  return lines.join('\n');
}

/**
 * Normalise a matrix so every row has the same width.
 *
 * @param {string[][]} matrix
 * @param {string} [fill='']
 * @returns {string[][]}
 */
export function padMatrix(matrix, fill = '') {
  if (!Array.isArray(matrix) || matrix.length === 0) return [];
  const width = Math.max(...matrix.map(r => r.length));
  return matrix.map(row => {
    const copy = [...row];
    while (copy.length < width) copy.push(fill);
    return copy;
  });
}

/**
 * Transpose a matrix, padding ragged rows first.
 *
 * @param {string[][]} matrix
 * @returns {string[][]}
 */
export function transposeMatrix(matrix) {
  const padded = padMatrix(matrix);
  if (padded.length === 0) return [];
  const width = padded[0].length;
  const out = [];
  for (let c = 0; c < width; c++) {
    out.push(padded.map(row => row[c]));
  }
  return out;
}

/**
 * Generate a LaTeX matrix environment with placeholder entries.
 *
 * Row separators are placed between rows but not after the last one: a
 * trailing `\\` produces a spurious empty row in most renderers.
 *
 * @param {number} rows
 * @param {number} cols
 * @param {string} [style='pmatrix'] - Any amsmath matrix environment.
 * @param {{symbol?:string}} [options] - Placeholder base name; entries are
 *        subscripted by position, so `x` gives `x_{11}`.
 * @returns {string}
 */
export function generateMatrix(rows, cols, style = 'pmatrix', options = {}) {
  const { symbol = 'x' } = options;
  const r = Math.max(1, Math.floor(Number(rows) || 1));
  const c = Math.max(1, Math.floor(Number(cols) || 1));

  const lines = [`\\begin{${style}}`];
  for (let i = 1; i <= r; i++) {
    const cells = [];
    for (let j = 1; j <= c; j++) cells.push(`${symbol}_{${i}${j}}`);
    lines.push(`  ${cells.join(' & ')}${i < r ? ' \\\\' : ''}`);
  }
  lines.push(`\\end{${style}}`);
  return lines.join('\n');
}

/**
 * Strip zero-width characters from a LaTeX string.
 *
 * MathLive inserts U+200B as a cursor anchor. The character is invisible but
 * survives a copy, and pasting it into a `.tex` file produces an error that
 * gives no clue as to its cause.
 *
 * @param {string} latex
 * @returns {string}
 */
export function stripZeroWidth(latex) {
  return String(latex ?? '').replace(/[\u200B-\u200D\uFEFF]/g, '');
}

/**
 * Format a number for a table cell.
 *
 * @param {*} value
 * @param {{decimals?:number, scientific?:boolean}} [options]
 * @returns {string}
 */
export function formatCell(value, options = {}) {
  const { decimals = null, scientific = false } = options;
  if (value === null || value === undefined || value === '') return '';

  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);

  if (scientific) {
    const exp = n.toExponential(decimals ?? 3);
    // Render as LaTeX maths so exponents typeset properly.
    const m = exp.match(/^(-?[\d.]+)e([+-]\d+)$/);
    if (m) {
      const mantissa = m[1];
      const power = parseInt(m[2], 10);
      return `$${mantissa} \\times 10^{${power}}$`;
    }
    return exp;
  }

  return decimals === null ? String(n) : n.toFixed(decimals);
}
