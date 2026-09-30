/**
 * @module core/outliers-figure
 *
 * The Outlier Detector's figure and its Python script.
 *
 * `outlierFigure` describes the chart (see figure.js): every value of the
 * column against its row, the flagged ones marked apart, and the lines of
 * the chosen rule (the mean and mean ± k SD for the Z-score, the median and
 * the values where the modified Z-score reaches ±k, or Tukey's fences).
 *
 * `outlierScript` writes the matplotlib script that draws it. The script
 * reads the column from the person's CSV file (as the page read it: the
 * same numbers, the same rows) or holds the values, flags them with numpy
 * by the rule outliers.js applies, runs Grubbs' test with scipy, prints what
 * it found, and draws the chart from its own flags and lines.
 * tests/outliers-figure.test.js runs it and compares the flags, the lines
 * and matplotlib's axis limits with the page's.
 */

import { detectOutliers, quartiles, median, MAD_TO_SIGMA, MEANAD_TO_SIGMA } from './outliers.js';
import { figureScript, pyStr, pyNum, pyArray } from './figure-python.js';

/** The lines' colour: a neutral grey that reads on light and dark figures. */
const LINE_COLOUR = '#6b7280';

const short = (v) => String(Number(Number(v).toPrecision(6)));

/**
 * Where the chosen rule draws its lines, in the units of the values.
 *
 * @param {number[]} values - the column's numbers
 * @param {'zscore'|'modzscore'|'iqr'} method
 * @param {number} threshold - k
 * @returns {{lower: number, upper: number, centre: number|null, centreName: string|null,
 *   ruleName: string}|null} null with no values or an unknown rule. For the Z-score the
 *   lines are the mean ± k SD; for the modified Z-score, the median ± k MAD/0.6745 (or
 *   ± k × 1.253314 × the mean absolute deviation, when the MAD is 0); for the IQR rule,
 *   Q1 − k IQR and Q3 + k IQR.
 */
export function outlierLines(values, method, threshold) {
  const x = Array.isArray(values) ? values : [];
  const n = x.length;
  if (!n) return null;
  const k = threshold;
  if (method === 'zscore') {
    const mean = x.reduce((s, v) => s + v, 0) / n;
    let ss = 0;
    for (const v of x) ss += (v - mean) * (v - mean);
    const sd = n > 1 ? Math.sqrt(ss / (n - 1)) : 0;
    return { lower: mean - k * sd, upper: mean + k * sd, centre: mean, centreName: 'Mean', ruleName: `Mean ± ${short(k)} SD` };
  }
  if (method === 'modzscore') {
    const med = median(x);
    const dev = x.map((v) => Math.abs(v - med));
    const mad = median(dev);
    let scale;
    if (mad > 0) scale = mad / MAD_TO_SIGMA;
    else scale = MEANAD_TO_SIGMA * (dev.reduce((s, v) => s + v, 0) / n);
    return { lower: med - k * scale, upper: med + k * scale, centre: med, centreName: 'Median', ruleName: `Modified Z = ±${short(k)}` };
  }
  if (method === 'iqr') {
    const q = quartiles(x);
    return { lower: q.q1 - k * q.iqr, upper: q.q3 + k * q.iqr, centre: null, centreName: null, ruleName: `Fences at ${short(k)} × IQR` };
  }
  return null;
}

/**
 * The Outlier Detector's figure.
 *
 * @param {object} spec
 * @param {number[]} spec.values - the column's numbers, in row order
 * @param {number[]} [spec.rows] - the row of each (1 is the first under the header);
 *   default 1, 2, 3 …
 * @param {'zscore'|'modzscore'|'iqr'} spec.method
 * @param {number} spec.threshold
 * @param {string} [spec.column] - the column's name, for the y axis
 * @param {boolean} [spec.lines=true] - draw the rule's lines
 * @returns {object|null} a figure description
 */
export function outlierFigure(spec = {}) {
  const values = Array.isArray(spec.values) ? spec.values : [];
  if (!values.length) return null;
  const rows = Array.isArray(spec.rows) && spec.rows.length === values.length ? spec.rows : values.map((_, i) => i + 1);
  const result = detectOutliers(values, spec.method, spec.threshold);
  const lines = outlierLines(values, spec.method, spec.threshold);
  if (!result || !lines) return null;
  const flagged = new Set(result.indices);
  const keep = (want) => values.map((_, i) => i).filter((i) => flagged.has(i) === want);
  const kept = keep(false); const out = keep(true);
  let lo = Infinity; let hi = -Infinity;
  for (const r of rows) { if (r < lo) lo = r; if (r > hi) hi = r; }
  const showLines = spec.lines !== false;
  const line = (id, y, py, label, style, extra = {}) => ({
    id, kind: 'line', show: showLines, label, color: LINE_COLOUR, lineWidth: 1, lineStyle: style,
    x: { values: [lo, hi], py: 'line_x' }, y: { values: [y, y], py }, ...extra
  });
  const series = [];
  if (lines.centre !== null) series.push(line('centre_line', lines.centre, 'np.full(2, centre)', lines.centreName, 'dotted'));
  series.push(line('threshold_hi', lines.upper, 'np.full(2, upper)', lines.ruleName, 'dashed'));
  series.push(line('threshold_lo', lines.lower, 'np.full(2, lower)', lines.ruleName, 'dashed', { legend: false }));
  series.push({
    id: 'kept', kind: 'scatter', label: 'Values', size: 5, edgeWidth: 0, alpha: 0.85,
    x: { values: kept.map((i) => rows[i]), py: 'row[~flagged]' }, y: { values: kept.map((i) => values[i]), py: 'value[~flagged]' }
  });
  series.push({
    id: 'flagged_points', kind: 'scatter', label: 'Outliers', marker: 'D', size: 7, edgeWidth: 0, show: out.length > 0,
    x: { values: out.map((i) => rows[i]), py: 'row[flagged]' }, y: { values: out.map((i) => values[i]), py: 'value[flagged]' }
  });
  return {
    xLabel: 'Row',
    export: { filename: 'outliers' },
    panels: [{ yLabel: String(spec.column || 'Value'), series }]
  };
}

/* ------------------------------------------------------------------ *
 * The script
 * ------------------------------------------------------------------ */

const section = (L, title) => L.push(`# ${title} ` + '-'.repeat(Math.max(4, 76 - title.length)));

const READ_COLUMN = [
  'def read_column(path, column, delimiter=\',\'):',
  '    """The numbers in one column of a CSV file with a header row, and their rows.',
  '',
  '    Rows are counted from 1 under the header, blank lines left out. A cell counts as a',
  '    number as the page reads one: digits with an optional minus, point and exponent,',
  '    below 2**53 in size; anything else (text, blanks, true/false) is skipped.',
  '    """',
  '    rows, values = [], []',
  "    with open(path, newline='', encoding='utf-8-sig') as fh:",
  '        reader = csv.reader(fh, delimiter=delimiter)',
  '        header = [name.strip() for name in next(reader)]',
  '        k = header.index(column.strip())',
  '        for number, record in enumerate((r for r in reader if r), start=1):',
  "            cell = record[k] if k < len(record) else ''",
  '            if NUMBER.match(cell) and abs(float(cell)) < 2 ** 53:',
  '                rows.append(number)',
  '                values.append(float(cell))',
  '    return np.array(rows), np.array(values, dtype=float)'
];

/**
 * The Outlier Detector's Python script.
 *
 * @param {object} figure - the figure as drawn (outlierFigure's, with the person's style)
 * @param {object} spec
 * @param {number[]} spec.values
 * @param {number[]} spec.rows
 * @param {'zscore'|'modzscore'|'iqr'} spec.method
 * @param {number} spec.threshold
 * @param {string} [spec.column]
 * @param {{name: string, delimiter?: string}|null} [spec.file] - the CSV the values came
 *   from, to read them from it
 * @param {'files'|'embed'} [spec.source='embed']
 * @returns {string}
 */
export function outlierScript(figure, spec = {}) {
  const { values = [], rows = [], method = 'zscore', threshold = 3, column = 'Value', file = null } = spec;
  const fromFile = spec.source === 'files' && file && file.name;
  const P = [];
  const imports = ['from scipy import stats'];
  if (fromFile) {
    imports.unshift('import csv', 'import re');
    P.push("NUMBER = re.compile(r'^\\s*-?(\\d+\\.?|\\.\\d+|\\d+\\.\\d+)([eE][-+]?\\d+)?\\s*$')");
    P.push('', '');
    P.push(...READ_COLUMN);
    P.push('', '');
    P.push('# Point this at your file; the column is found by its header.');
    const args = [pyStr(file.name), pyStr(column)];
    if (file.delimiter && file.delimiter !== ',') args.push(`delimiter=${pyStr(file.delimiter)}`);
    P.push(`row, value = read_column(${args.join(', ')})`);
  } else {
    P.push(spec.source === 'files'
      ? '# The example has no file to read, so its values are here.'
      : `# The numbers in the column ${pyStr(column)}, and the row each is on (1 is the first under the header).`);
    const rowLines = pyArray('row', rows);
    rowLines[rowLines.length - 1] = rowLines[rowLines.length - 1].replace('dtype=float)', 'dtype=int)');
    P.push(...rowLines, ...pyArray('value', values));
  }
  P.push('', '');

  section(P, 'Outliers');
  P.push(`THRESHOLD = ${pyNum(threshold)}`);
  P.push('');
  if (method === 'zscore') {
    P.push('# Z-scores against the mean and the sample SD (n - 1); a value is flagged when');
    P.push('# |z| is above the threshold. No spread, no outliers.');
    P.push('centre = value.mean()');
    P.push('sd = value.std(ddof=1) if len(value) > 1 else 0.0');
    P.push('scores = (value - centre) / sd if sd > 0 else np.zeros(len(value))');
    P.push('lower, upper = centre - THRESHOLD * sd, centre + THRESHOLD * sd');
  } else if (method === 'modzscore') {
    P.push('# Modified Z-scores (Iglewicz and Hoaglin): 0.6745 (x - median) / MAD, flagged when');
    P.push('# |M| is above the threshold. When more than half the values are equal the MAD is');
    P.push('# 0, and 1.253314 times the mean absolute deviation stands in for MAD / 0.6745.');
    P.push('centre = np.median(value)');
    P.push('deviation = np.abs(value - centre)');
    P.push('mad = np.median(deviation)');
    P.push('if mad > 0:');
    P.push(`    scores = ${pyNum(MAD_TO_SIGMA)} * (value - centre) / mad`);
    P.push(`    scale = mad / ${pyNum(MAD_TO_SIGMA)}`);
    P.push('else:');
    P.push(`    scale = ${pyNum(MEANAD_TO_SIGMA)} * deviation.mean()`);
    P.push('    scores = (value - centre) / scale if scale > 0 else np.zeros(len(value))');
    P.push('lower, upper = centre - THRESHOLD * scale, centre + THRESHOLD * scale');
  } else {
    P.push("# Tukey's fences: below Q1 - k IQR or above Q3 + k IQR, with the quartiles");
    P.push("# interpolated linearly (numpy's default, R's type 7).");
    P.push('q1, q3 = np.percentile(value, [25, 75])');
    P.push('iqr = q3 - q1');
    P.push('lower, upper = q1 - THRESHOLD * iqr, q3 + THRESHOLD * iqr');
  }
  P.push(method === 'iqr' ? 'flagged = (value < lower) | (value > upper)' : 'flagged = np.abs(scores) > THRESHOLD');
  P.push('');
  P.push("print(f'{flagged.sum()} of {len(value)} values flagged:')");
  P.push('for r, v in zip(row[flagged], value[flagged]):');
  P.push("    print(f'  row {r}: {v:g}')");
  P.push('');
  P.push("# Grubbs' test of the most extreme value (normal data, alpha = 0.05).");
  P.push('n = len(value)');
  P.push('if n >= 3 and value.std(ddof=1) > 0:');
  P.push('    deviations = np.abs(value - value.mean())');
  P.push('    G = deviations.max() / value.std(ddof=1)');
  P.push('    t_crit = stats.t.ppf(0.05 / (2 * n), n - 2)');
  P.push('    critical = (n - 1) / np.sqrt(n) * np.sqrt(t_crit ** 2 / (n - 2 + t_crit ** 2))');
  P.push('    t_obs_sq = (n - 2) * G ** 2 / ((n - 1) ** 2 / n - G ** 2)');
  P.push('    tail = stats.t.sf(np.sqrt(t_obs_sq), n - 2) if t_obs_sq > 0 else 0.0');
  P.push('    grubbs_p = min(1.0, 2 * n * tail)');
  P.push("    verdict = 'an outlier' if G > critical else 'not an outlier at the 5% level'");
  P.push("    print(f\"Grubbs' G = {G:.4f}, critical {critical:.4f}, p = {grubbs_p:.4g}:\",");
  P.push("          f'the value in row {row[np.argmax(deviations)]} is {verdict}.')");
  P.push('');
  P.push('# Where the lines are drawn: across the rows.');
  P.push('line_x = np.array([row.min(), row.max()])');

  return figureScript(figure || {}, {
    header: [
      'Outliers from STEMKit (https://stemkit.net/outlier-detector.html).',
      `Flags the values of ${pyStr(column)} by the ${{ zscore: 'Z-score', modzscore: 'modified Z-score', iqr: 'IQR' }[method] || method} rule as the page does, runs`,
      "Grubbs' test, prints what it finds, and draws the chart."
    ],
    imports,
    prelude: P
  });
}
