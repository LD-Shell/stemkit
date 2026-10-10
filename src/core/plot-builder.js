/**
 * @module core/plot-builder
 *
 * The Plot Builder's data and figure, without the DOM: the person's CSV
 * files read exactly as the script it writes will read them, and the figure
 * description (src/core/figure.js) that the shared plot area draws and
 * src/core/figure-python.js turns into a matplotlib script.
 *
 * Reading. The script reads each file with Python's csv module and turns
 * every cell into a number with float(), a blank or a word becoming NaN
 * (read_csv in figure-python.js). The page reads the same way here, so the
 * preview and the script draw the same points: the records are split as
 * csv.reader splits them (quotes, doubled quotes, line breaks inside quotes,
 * blank lines skipped), the header is the first record with each name
 * stripped, and each cell goes through pyFloat, which accepts what float()
 * accepts. A line breaks where a cell has no number, as matplotlib draws it.
 *
 * Columns are kept by position. Python's DictReader keeps only the last of
 * two columns with the same name, so the earlier ones are marked
 * `readable: false` and the script is given their numbers instead.
 *
 * The figure. Each series names its file and columns by position; the
 * description gives every data field its numbers, a Python name, and, when
 * the file can be read by name, the file and column the script reads.
 * The examples' numbers are never read from a file (the person has none).
 *
 * The examples. EXAMPLES lists a built-in example for each kind of chart;
 * builderExample gives its files (generated here, the same every time) and
 * the series that show it off, exampleState the same as builderFigure
 * takes them.
 */

import {
  BIN_RULES, HISTOGRAM_NORMS, REPLICATE_ERRORS, STACK_MODES, KDE_BANDWIDTHS, VIOLIN_SCALES, VIOLIN_INNER,
  SHARE_X, SHARE_Y
} from './figure.js';

/* ------------------------------------------------------------------ *
 * Numbers as Python's float() reads them
 * ------------------------------------------------------------------ */

const DIGITS = String.raw`\d(?:_?\d)*`;
const PY_FLOAT = new RegExp(`^[+-]?(?:${DIGITS}(?:\\.(?:${DIGITS})?)?|\\.${DIGITS})(?:[eE][+-]?${DIGITS})?$`);
const PY_SPECIAL = /^([+-]?)(inf|infinity|nan)$/i;

/**
 * The number Python's float(text) gives, or NaN where it raises (a blank
 * cell, a word, a decimal comma). Surrounding white space is allowed, as are
 * underscores between digits, 'inf', 'infinity' and 'nan' in any case.
 *
 * @param {string|null|undefined} text
 * @returns {number}
 */
export function pyFloat(text) {
  if (text === null || text === undefined) return NaN;
  const t = String(text).trim();
  if (PY_FLOAT.test(t)) return Number(t.replace(/_/g, ''));
  const m = PY_SPECIAL.exec(t);
  if (m) return m[2].toLowerCase() === 'nan' ? NaN : (m[1] === '-' ? -Infinity : Infinity);
  return NaN;
}

/* ------------------------------------------------------------------ *
 * Records as Python's csv.reader splits them
 * ------------------------------------------------------------------ */

/**
 * The records of a CSV text, split as csv.reader(fh, delimiter=d) splits
 * them with the default dialect: fields in double quotes may hold the
 * delimiter, line breaks and doubled quotes; a quote inside an unquoted field
 * is kept; text after a closing quote joins the field. A line with nothing on
 * it gives an empty record ([]), which DictReader skips.
 *
 * @param {string} text
 * @param {string} [delimiter=',']
 * @returns {string[][]}
 */
export function parseCsv(text, delimiter = ',') {
  const s = String(text ?? '');
  const records = [];
  let fields = [];
  let field = '';
  let state = 'record';   // record | start | field | quoted | quote | crnl
  const saveField = () => { fields.push(field); field = ''; };
  const saveRecord = () => { records.push(fields); fields = []; };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const eol = c === '\n' || c === '\r';
    switch (state) {
      case 'crnl':
        if (eol) continue;
        state = 'record';
      // falls through
      case 'record':
        if (eol) { saveRecord(); state = 'crnl'; continue; }
        state = 'start';
      // falls through
      case 'start':
        if (eol) { saveField(); saveRecord(); state = 'crnl'; } else if (c === '"') state = 'quoted';
        else if (c === delimiter) saveField();
        else {
          // An unquoted field runs to the next delimiter or line end; a quote inside it is kept.
          let j = i + 1;
          while (j < s.length && s[j] !== delimiter && s[j] !== '\n' && s[j] !== '\r') j++;
          field += s.slice(i, j);
          i = j - 1;
          state = 'field';
        }
        break;
      case 'field':
        if (eol) { saveField(); saveRecord(); state = 'crnl'; } else if (c === delimiter) { saveField(); state = 'start'; } else field += c;
        break;
      case 'quoted':
        if (c === '"') state = 'quote'; else field += c;
        break;
      case 'quote':
        if (c === '"') { field += c; state = 'quoted'; } else if (c === delimiter) { saveField(); state = 'start'; } else if (eol) { saveField(); saveRecord(); state = 'crnl'; } else { field += c; state = 'field'; }
        break;
      default: break;
    }
  }
  // The end of the text ends the last record, as it does for csv.reader.
  if (state === 'start' || state === 'field' || state === 'quoted' || state === 'quote') { saveField(); saveRecord(); }
  return records;
}

export const DELIMITERS = Object.freeze([',', '\t', ';', '|']);

/**
 * The delimiter a table is written with: of comma, tab, semicolon and bar,
 * the one that splits the header into two or more columns and the most of the
 * next rows into as many; the most columns breaks a tie. A comma when none
 * does.
 *
 * @param {string} text
 * @returns {string}
 */
export function sniffDelimiter(text) {
  const sample = String(text ?? '').slice(0, 64 * 1024);
  let best = { d: ',', score: -1, width: 0 };
  for (const d of DELIMITERS) {
    const recs = parseCsv(sample, d).filter((r) => r.length).slice(0, 30);
    if (!recs.length) continue;
    const width = recs[0].length;
    if (width < 2) continue;
    const score = recs.slice(1).filter((r) => r.length === width).length;
    if (score > best.score || (score === best.score && width > best.width)) best = { d, score, width };
  }
  return best.d;
}

/**
 * A file read as the script reads it.
 *
 * @param {string} text
 * @param {{delimiter?: string}} [options] - the delimiter (default: sniffed)
 * @returns {{ok: boolean, error?: string, delimiter: string, headers: string[], columns: number[][],
 *   texts: string[][], rows: number, numeric: boolean[], readable: boolean[], counts: number[], notUtf8: boolean}}
 *   columns[i] holds a number (or NaN) for every row; texts[i] the cell's text, trimmed, for every
 *   row (the names of categories and groups); numeric[i] says whether at least half the
 *   rows have a number there; readable[i] whether the script can read the column by its name;
 *   counts[i] how many rows have a number there
 */
export function readTable(text, options = {}) {
  let s = String(text ?? '');
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);   // utf-8-sig
  const delimiter = options.delimiter || sniffDelimiter(s);
  const records = parseCsv(s, delimiter);
  const empty = { ok: false, delimiter, headers: [], columns: [], texts: [], rows: 0, numeric: [], readable: [], counts: [], notUtf8: s.includes('�') };
  if (!records.length || !records[0].length) return { ...empty, error: 'The first line should name the columns.' };
  const headers = records[0].map((h) => h.trim());
  if (headers.length < 2) return { ...empty, headers, error: 'It needs at least two columns, separated by commas, tabs or semicolons.' };
  const body = records.slice(1).filter((r) => r.length);
  const columns = headers.map((_, i) => body.map((r) => pyFloat(r[i])));
  const texts = headers.map((_, i) => body.map((r) => String(r[i] ?? '').trim()));
  const counts = columns.map((c) => c.reduce((n, v) => n + (Number.isFinite(v) ? 1 : 0), 0));
  const numeric = counts.map((n) => n > 0 && n >= body.length / 2);
  const readable = headers.map((h, i) => headers.lastIndexOf(h) === i);
  if (!body.length) return { ...empty, headers, error: 'It has a header but no rows of data.' };
  return { ok: true, delimiter, headers, columns, texts, rows: body.length, numeric, readable, counts, notUtf8: s.includes('�') };
}

/** A column's name for the page: its header, or its place when the header is blank. */
export function columnName(headers, i) {
  const h = headers[i];
  return h ? h : `Column ${i + 1}`;
}

/* ------------------------------------------------------------------ *
 * Names
 * ------------------------------------------------------------------ */

/** A file name made from text: lower case letters, digits and hyphens, or 'figure'. */
export function slug(text, fallback = 'figure') {
  const t = String(text ?? '')
    .replace(/\$[^$]*\$/g, ' ')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
  return t || fallback;
}

/** An id for a file's columns in the script: its name without the extension, unique among `taken`. */
export function sourceId(fileName, taken = new Set()) {
  const base = String(fileName ?? '').replace(/\.[^.]*$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'data';
  let id = /^[a-z]/.test(base) ? base : `data_${base}`;
  const root = id;
  let k = 2;
  while (taken.has(id)) id = `${root}_${k++}`;
  taken.add(id);
  return id;
}

/* ------------------------------------------------------------------ *
 * The example
 * ------------------------------------------------------------------ */

/**
 * Two logistic growth curves read every hour, with fixed "noise", so the
 * example is the same on every load and in the script; with a standard
 * deviation for each, from three replicates.
 */
export function exampleCsv() {
  let seed = 7;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const grow = (t, n0, cap, r) => cap / (1 + (cap / n0 - 1) * Math.exp(-r * t));
  const rows = ['time_h,control_OD600,control_sd,treated_OD600,treated_sd'];
  for (let t = 0; t <= 24; t++) {
    const c = grow(t, 0.02, 1.6, 0.55) * (1 + (rand() - 0.5) * 0.08);
    const d = grow(t, 0.02, 1.1, 0.32) * (1 + (rand() - 0.5) * 0.08);
    const sc = c * (0.03 + 0.04 * rand());
    const sd = d * (0.03 + 0.04 * rand());
    rows.push(`${t},${c.toFixed(3)},${sc.toFixed(3)},${d.toFixed(3)},${sd.toFixed(3)}`);
  }
  return rows.join('\n') + '\n';
}

/** How the example's columns are labelled on the axes. */
export const EXAMPLE_LABELS = Object.freeze({ time_h: 'Time (h)', control_OD600: 'OD$_{600}$', treated_OD600: 'OD$_{600}$' });

/* ------------------------------------------------------------------ *
 * More examples: one for each kind of chart
 * ------------------------------------------------------------------ */

/* Numbers that are the same on every load: uniform in (0, 1), and normal. */
function seeded(seed) {
  let s = seed;
  const rand = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const gauss = () => Math.sqrt(-2 * Math.log(rand())) * Math.cos(2 * Math.PI * rand());
  return { rand, gauss };
}
const csvOf = (header, rows) => [header, ...rows].join('\n') + '\n';

const EXAMPLE_DATA = {
  growth: () => ({
    files: [{ name: 'growth_example.csv', csv: exampleCsv(), labels: EXAMPLE_LABELS }],
    series: [
      { x: 'time_h', y: 'control_OD600', yerr: 'control_sd', draw: 'both', label: 'Control' },
      { x: 'time_h', y: 'treated_OD600', yerr: 'treated_sd', draw: 'both', label: 'Treated' }
    ]
  }),
  // A sealed vessel heated at constant volume: the pressure follows the temperature.
  'two-axes': () => {
    const { gauss } = seeded(11);
    const rows = [];
    for (let t = 0; t <= 300; t += 10) {
      const T = 293 + 60 * (1 - Math.exp(-t / 90)) + 0.4 * gauss();
      rows.push(`${t},${T.toFixed(2)},${(101.3 * T / 293 + 0.3 * gauss()).toFixed(2)}`);
    }
    return {
      files: [{ name: 'heating_example.csv', csv: csvOf('time_s,temperature_K,pressure_kPa', rows),
        labels: { time_s: 'Time (s)', temperature_K: 'Temperature (K)', pressure_kPa: 'Pressure (kPa)' } }],
      series: [
        { x: 'time_s', y: 'temperature_K', draw: 'both', label: 'Temperature' },
        { x: 'time_s', y: 'pressure_kPa', draw: 'line', yAxis: 'right', label: 'Pressure' }
      ]
    };
  },
  // Two absorption bands, read by wavelength and by wavenumber.
  spectrum: () => {
    const { gauss } = seeded(23);
    const rows = [];
    for (let wl = 400; wl <= 700; wl += 5) {
      const a = 0.82 * Math.exp(-(((wl - 452) / 24) ** 2)) + 0.55 * Math.exp(-(((wl - 618) / 34) ** 2)) + 0.03 + 0.008 * gauss();
      rows.push(`${wl},${a.toFixed(4)},${(1e7 / wl).toFixed(1)}`);
    }
    return {
      files: [{ name: 'spectrum_example.csv', csv: csvOf('wavelength_nm,absorbance,wavenumber_cm', rows),
        labels: { wavelength_nm: 'Wavelength (nm)', absorbance: 'Absorbance', wavenumber_cm: 'Wavenumber (cm$^{-1}$)' } }],
      series: [
        { x: 'wavelength_nm', y: 'absorbance', draw: 'line', label: 'By wavelength' },
        { x: 'wavenumber_cm', y: 'absorbance', draw: 'points', xAxis: 'top', label: 'By wavenumber' }
      ]
    };
  },
  // A summary table: one row for each condition, a mean and its standard deviation for each strain.
  'grouped-bars': () => ({
    files: [{ name: 'activity_example.csv',
      csv: csvOf('condition,wild_type,wild_type_sd,mutant,mutant_sd', ['Control,41.2,3.1,38.6,2.8', 'Inhibitor,18.4,2.2,33.9,3.4', 'Activator,63.5,4.6,44.1,3.9', 'Both,37.8,3.3,40.2,3.0']),
      labels: { condition: 'Condition', wild_type: 'Activity (nmol min$^{-1}$)', mutant: 'Activity (nmol min$^{-1}$)' } }],
    series: [
      { chart: 'bar', x: 'condition', y: 'wild_type', yerr: 'wild_type_sd', label: 'Wild type' },
      { chart: 'bar', x: 'condition', y: 'mutant', yerr: 'mutant_sd', label: 'Mutant' }
    ]
  }),
  // Replicate rows: six measurements of each treatment.
  'bars-of-means': () => {
    const { gauss } = seeded(37);
    const rows = [];
    [['Control', 41, 3.5], ['Low dose', 36, 3], ['High dose', 22, 4], ['Washout', 38, 5]].forEach(([name, mean, sd]) => {
      for (let k = 1; k <= 6; k++) rows.push(`${name},${k},${(mean + sd * gauss()).toFixed(1)}`);
    });
    return {
      files: [{ name: 'replicates_example.csv', csv: csvOf('treatment,replicate,activity', rows),
        labels: { treatment: 'Treatment', activity: 'Activity (nmol min$^{-1}$)' } }],
      series: [{ chart: 'bars-mean', x: 'treatment', y: 'activity', error: 'ci', level: 0.95, points: true }]
    };
  },
  // The texture of five soils: the mass of each fraction, stacked to 100%.
  'stacked-bars': () => ({
    files: [{ name: 'texture_example.csv',
      csv: csvOf('site,sand_g,silt_g,clay_g', ['Ridge,31.2,12.4,6.1', 'Slope,24.8,17.9,9.6', 'Terrace,18.3,21.5,13.7', 'Floodplain,9.4,24.6,19.8', 'Channel,36.5,8.2,3.9']),
      labels: { site: 'Site' } }],
    series: [
      { chart: 'bar', x: 'site', y: 'sand_g', orientation: 'h', stack: 'percent', label: 'Sand' },
      { chart: 'bar', x: 'site', y: 'silt_g', orientation: 'h', stack: 'percent', label: 'Silt' },
      { chart: 'bar', x: 'site', y: 'clay_g', orientation: 'h', stack: 'percent', label: 'Clay' }
    ],
    // Bars stacked to 100% fill the panel: the legend stands beside it.
    style: { panels: [{ legend: { position: 'outside right' } }] }
  }),
  // Particle diameters, a little skewed, as a size distribution usually is.
  histograms: () => {
    const { gauss } = seeded(41);
    const rows = [];
    for (let i = 0; i < 240; i++) rows.push((84 * Math.exp(0.16 * gauss())).toFixed(1));
    return {
      files: [{ name: 'diameters_example.csv', csv: csvOf('particle,diameter_nm', rows.map((d, i) => `${i + 1},${d}`)), labels: { diameter_nm: 'Diameter (nm)' } }],
      series: [
        { chart: 'hist', y: 'diameter_nm', binsMode: 'rule', binRule: 'fd', normalise: 'density', label: 'Density' },
        { chart: 'hist', y: 'diameter_nm', binsMode: 'rule', binRule: 'fd', normalise: 'fraction', cumulative: true, panel: 1, label: 'Running total' }
      ]
    };
  },
  // Doubling times of four strains, a dozen or so cultures of each.
  'box-violin': () => {
    const { gauss } = seeded(53);
    const rows = [];
    [['WT', 14, 31, 2.2], ['mutA', 12, 38, 3.4], ['mutB', 13, 34, 5.5], ['mutAB', 11, 47, 4.1]].forEach(([name, n, mean, sd]) => {
      for (let k = 0; k < n; k++) rows.push(`${name},${(mean + sd * gauss()).toFixed(1)}`);
    });
    return {
      files: [{ name: 'doubling_example.csv', csv: csvOf('strain,doubling_min', rows), labels: { strain: 'Strain', doubling_min: 'Doubling time (min)' } }],
      series: [
        { chart: 'box', y: 'doubling_min', groupBy: 'strain' },
        { chart: 'violin', y: 'doubling_min', groupBy: 'strain', points: true, panel: 1 }
      ]
    };
  },
  // A free-energy surface over two torsion angles, with two basins and a pass between them.
  surface: () => {
    const rows = [];
    const well = (x, y, x0, y0, s) => Math.exp(-(((x - x0) / s) ** 2 + ((y - y0) / s) ** 2));
    for (let psi = -180; psi <= 180; psi += 15) {
      for (let phi = -180; phi <= 180; phi += 15) {
        const f = 34 - 30 * well(phi, psi, -75, 140, 62) - 26 * well(phi, psi, -80, -40, 55) - 14 * well(phi, psi, 60, 45, 45) + 4 * Math.cos((phi * Math.PI) / 180);
        rows.push(`${phi},${psi},${f.toFixed(2)}`);
      }
    }
    return {
      files: [{ name: 'free_energy_example.csv', csv: csvOf('phi_deg,psi_deg,free_energy', rows),
        labels: { phi_deg: '$\\phi$ (deg)', psi_deg: '$\\psi$ (deg)', free_energy: 'Free energy (kJ mol$^{-1}$)' } }],
      series: [
        { chart: 'heatmap', x: 'phi_deg', y: 'psi_deg', z: 'free_energy' },
        { chart: 'contour', x: 'phi_deg', y: 'psi_deg', z: 'free_energy', levels: 8, filled: false }
      ]
    };
  },
  // Two proteins measured cell by cell: the brighter a cell in one, the brighter in the other.
  hist2d: () => {
    const { gauss } = seeded(67);
    const rows = [];
    for (let i = 0; i < 600; i++) {
      const a = gauss(); const b = 0.75 * a + 0.66 * gauss();
      rows.push(`${(1200 * Math.exp(0.35 * a)).toFixed(0)},${(800 * Math.exp(0.4 * b)).toFixed(0)}`);
    }
    return {
      files: [{ name: 'cells_example.csv', csv: csvOf('protein_a,protein_b', rows), labels: { protein_a: 'Protein A (a.u.)', protein_b: 'Protein B (a.u.)' } }],
      series: [{ chart: 'hist2d', x: 'protein_a', y: 'protein_b', bins: 18 }]
    };
  },
  // How many ion channels are open, read every 2 ms: it changes in whole steps.
  steps: () => {
    const { rand } = seeded(79);
    const rows = [];
    let open = 1;
    for (let t = 0; t <= 120; t += 2) {
      const u = rand();
      if (u < 0.22 && open < 4) open += 1; else if (u > 0.76 && open > 0) open -= 1;
      rows.push(`${t},${open},${(open * 1.8 + 0.25 * (rand() - 0.5)).toFixed(2)}`);
    }
    return {
      files: [{ name: 'channels_example.csv', csv: csvOf('time_ms,open_channels,current_pA', rows),
        labels: { time_ms: 'Time (ms)', open_channels: 'Open channels', current_pA: 'Current (pA)' } }],
      series: [{ x: 'time_ms', y: 'open_channels', draw: 'step' }]
    };
  },
  // A day of soil temperatures: the air above, and the wave it sends down, later and weaker with depth.
  panels: () => {
    const { gauss } = seeded(97);
    const air = [];
    for (let k = 0; k <= 48; k++) {
      const t = k / 2;
      air.push(`${t},${(15 + 9 * Math.sin((2 * Math.PI * (t - 9)) / 24) + 0.4 * gauss()).toFixed(2)}`);
    }
    const soil = [];
    for (let depth = 5; depth <= 40; depth += 5) {
      for (let t = 0; t <= 24; t++) {
        soil.push(`${t},${depth},${(15 + 7 * Math.exp(-depth / 12) * Math.sin((2 * Math.PI * (t - 9)) / 24 - depth / 12)).toFixed(2)}`);
      }
    }
    return {
      files: [
        { name: 'air_example.csv', csv: csvOf('time_h,air_C', air), labels: { time_h: 'Time (h)', air_C: 'Air (°C)' } },
        { name: 'soil_example.csv', csv: csvOf('time_h,depth_cm,soil_C', soil), labels: { time_h: 'Time (h)', depth_cm: 'Depth (cm)', soil_C: 'Soil (°C)' } }
      ],
      series: [
        { file: 0, x: 'time_h', y: 'air_C', draw: 'line', label: 'Air above the soil' },
        { file: 1, chart: 'heatmap', x: 'time_h', y: 'depth_cm', z: 'soil_C', panel: 1 }
      ]
    };
  },
  // A substrate used up at four temperatures: the same two quantities in every panel.
  grid: () => {
    const { gauss } = seeded(113);
    const rates = [0.018, 0.04, 0.085, 0.19];
    const rows = [];
    for (let t = 0; t <= 60; t += 4) rows.push([t, ...rates.map((k) => Math.max(0, 5 * Math.exp(-k * t) + 0.06 * gauss()).toFixed(2))].join(','));
    const header = ['at_10C', 'at_20C', 'at_30C', 'at_40C'];
    return {
      files: [{ name: 'decay_example.csv', csv: csvOf(`time_min,${header.join(',')}`, rows),
        labels: { time_min: 'Time (min)', ...Object.fromEntries(header.map((h) => [h, 'Substrate (mM)'])) } }],
      series: header.map((h, k) => ({ x: 'time_min', y: h, draw: 'both', panel: k, label: `${10 * (k + 1)} °C` })),
      layout: { rows: 2, cols: 2, sharex: 'col', sharey: 'row' },
      // Letters outside, clear of the curves; markers the preview draws exactly as matplotlib does.
      style: { panelLabels: { show: true, position: 'outside' }, series: { s3: { marker: 'D' }, s4: { marker: 'o' } } }
    };
  },
  // Raman spectra of three carbonate minerals: sharp lines on a flat background.
  'stacked-spectra': () => {
    const { gauss } = seeded(131);
    const peaks = [
      [[1086, 1, 4], [712, 0.18, 4], [282, 0.3, 7], [156, 0.14, 6]],
      [[1085, 1, 4], [705, 0.16, 4], [206, 0.34, 7], [153, 0.2, 6]],
      [[1098, 1, 5], [725, 0.14, 5], [300, 0.42, 8], [177, 0.18, 7]]
    ];
    const rows = [];
    for (let x = 120; x <= 1200; x += 4) {
      rows.push([x, ...peaks.map((list) => (0.04 + list.reduce((a, [at, hgt, w]) => a + hgt / (1 + ((x - at) / w) ** 2), 0) + 0.006 * gauss()).toFixed(3))].join(','));
    }
    const header = ['calcite', 'aragonite', 'dolomite'];
    return {
      files: [{ name: 'spectra_example.csv', csv: csvOf(`shift_cm1,${header.join(',')}`, rows),
        labels: { shift_cm1: 'Raman shift (cm$^{-1}$)', ...Object.fromEntries(header.map((h) => [h, 'Intensity'])) } }],
      series: header.map((h, k) => ({ x: 'shift_cm1', y: h, draw: 'line', panel: k, label: h[0].toUpperCase() + h.slice(1) })),
      style: { panelGap: { h: 0 } }
    };
  },
  // A signal that falls fast, then slowly: the first seconds enlarged in an inset.
  inset: () => {
    const { gauss } = seeded(149);
    const rows = [];
    for (let k = 0; k <= 120; k++) {
      const t = k / 2;
      rows.push(`${t},${(0.68 * Math.exp(-t / 1.3) + 0.3 * Math.exp(-t / 28) + 0.004 * gauss()).toFixed(4)}`);
    }
    return {
      files: [{ name: 'relaxation_example.csv', csv: csvOf('time_s,signal', rows), labels: { time_s: 'Time (s)', signal: 'Signal (a.u.)' } }],
      series: [
        { x: 'time_s', y: 'signal', draw: 'line', label: 'Signal' },
        { x: 'time_s', y: 'signal', draw: 'both', panel: 'inset1', label: '' }
      ],
      layout: { insets: [{ id: 'inset1', parent: 0, x: 0.36, y: 0.34, w: 0.6, h: 0.6, zoom: true, xLim: [0, 6], yLim: [0.25, 1] }] },
      // The inset shows the same curve: in the same colour, and no legend for one line.
      style: { series: { s2: { color: '#1f5c96' } }, panels: [{ legend: { show: false } }] }
    };
  }
};

/**
 * The built-in examples, one for each kind of chart: an id, a short name
 * and a line that says what it shows.
 */
export const EXAMPLES = Object.freeze([
  { id: 'growth', name: 'Growth curves', description: 'Two curves with error bars and a legend.' },
  { id: 'two-axes', name: 'Two y axes', description: 'Temperature on the left axis, pressure on the right, against time.' },
  { id: 'spectrum', name: 'Top x axis', description: 'A spectrum by wavelength, and by wavenumber on the top axis.' },
  { id: 'grouped-bars', name: 'Grouped bars', description: 'Two series of bars side by side, with error bars.' },
  { id: 'bars-of-means', name: 'Bars of means', description: 'Replicate rows as means with a 95% interval and each value.' },
  { id: 'stacked-bars', name: 'Stacked bars', description: 'Three fractions stacked to 100%, lying flat.' },
  { id: 'histograms', name: 'Histograms', description: 'A density and its running total, with bins by a rule of numpy\'s.' },
  { id: 'box-violin', name: 'Box and violin plots', description: 'The spread of each group, as boxes and as violins.' },
  { id: 'surface', name: 'Heatmap and contours', description: 'A free-energy surface on a grid, with contour lines over it.' },
  { id: 'hist2d', name: '2D histogram', description: 'How many points fall in each cell, for two related quantities.' },
  { id: 'steps', name: 'Step line', description: 'A count that changes in whole steps.' },
  { id: 'panels', name: 'Two panels', description: 'A line above a heatmap, sharing the time axis.' },
  { id: 'grid', name: 'Grid of panels', description: 'Four runs on a 2 by 2 grid, with shared axes and panel letters.' },
  { id: 'stacked-spectra', name: 'Stacked spectra', description: 'Three spectra one above the other with no gap between them.' },
  { id: 'inset', name: 'Zoomed inset', description: 'A decay curve, with its first seconds enlarged in an inset.' }
].map((e) => Object.freeze(e)));

const COLUMN_KEYS = ['x', 'y', 'y2', 'z', 'yerr', 'xerr', 'groupBy'];

/**
 * A built-in example: its files (name, CSV text and the axis labels of its
 * columns) and the series that show its chart off, each naming its columns
 * by their headers and its file by its place in `files`. The data are
 * generated here and are the same every time. An example that lays its
 * panels out has a `layout` (as builderLayout takes it), and one that needs
 * a look of its own (a gap, letters, where the legend stands) a `style`,
 * its series named s1, s2 … in their order.
 *
 * @param {string} id - one of EXAMPLES' ids
 * @returns {{id: string, name: string, description: string, files: {name: string, csv: string, labels: object}[],
 *   series: object[], layout?: object, style?: object}|null}
 */
export function builderExample(id) {
  const meta = EXAMPLES.find((e) => e.id === id);
  if (!meta) return null;
  return { ...meta, ...EXAMPLE_DATA[id]() };
}

/**
 * An example as the files and series builderFigure takes: every file read,
 * marked as an example (its numbers go into the script), and every series
 * with its columns by position; with the example's layout, and the style
 * to lay over the figure (applyStyle), when it has them.
 *
 * @param {string} id
 * @returns {{files: object[], series: object[], layout?: object, style?: object}|null}
 */
export function exampleState(id) {
  const ex = builderExample(id);
  if (!ex) return null;
  const files = ex.files.map((f, i) => ({ id: i ? `example${i + 1}` : 'example', name: f.name, example: true, labels: f.labels, table: readTable(f.csv) }));
  const series = ex.series.map((s, k) => {
    const file = files[s.file || 0];
    const out = { id: `s${k + 1}`, fileId: file.id, draw: 'line', panel: 0, ...s };
    delete out.file;
    for (const key of COLUMN_KEYS) if (typeof s[key] === 'string') out[key] = file.table.headers.indexOf(s[key]);
    return out;
  });
  const state = { files, series };
  if (ex.layout) state.layout = ex.layout;
  if (ex.style) state.style = ex.style;
  return state;
}

/* ------------------------------------------------------------------ *
 * The figure
 * ------------------------------------------------------------------ */

export const DRAW_MODES = Object.freeze(['line', 'points', 'both', 'step', 'band']);
/**
 * What a series is: a curve (drawn as one of DRAW_MODES) or one of the charts
 * the figure description also holds: bars (one for each row), bars of the
 * means of replicate rows, a histogram of one column, box plots, violin
 * plots, a heatmap or contours of z over x and y, or the counts of points in
 * a grid (a 2D histogram).
 */
export const CHART_KINDS = Object.freeze(['curve', 'bar', 'bars-mean', 'hist', 'box', 'violin', 'heatmap', 'contour', 'hist2d']);
/** How a histogram's bins are chosen on its card: a number, one of numpy's rules, or edges typed in. */
export const BIN_MODES = Object.freeze(['number', 'rule', 'edges']);
/** The confidence levels a card offers. */
export const LEVELS = Object.freeze([0.9, 0.95, 0.99]);
export const DEFAULT_BINS = 10;
export const DEFAULT_BINS_2D = 20;
export const DEFAULT_LEVELS = 7;
/* Markers for series drawn with points, in turn, so that past three they differ by shape too. */
export const POINT_MARKERS = Object.freeze(['o', 's', '^', 'D', 'v']);
const DASH_ROUNDS = ['solid', 'dashed', 'dotted', 'dashdot'];


/* ------------------------------------------------------------------ *
 * Charts made from columns
 * ------------------------------------------------------------------ */

const isNum = Number.isFinite;
const clampInt = (v, lo, hi, d) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};

/**
 * Rows of x, y and z (one value per row) laid on the grid of the distinct x
 * and y values: z[row of y][column of x], NaN where no row gives that cell.
 * Rows with a missing number are left out; when two rows give the same cell
 * the later one is kept.
 *
 * @param {number[]} xs
 * @param {number[]} ys
 * @param {number[]} zs
 * @returns {{x: number[], y: number[], z: number[][], cells: number, filled: number, repeated: number, rows: number}}
 */
export function gridFromXyz(xs, ys, zs) {
  const n = Math.min(xs.length, ys.length, zs.length);
  const ok = [];
  for (let i = 0; i < n; i++) if (isNum(xs[i]) && isNum(ys[i]) && isNum(zs[i])) ok.push(i);
  const x = [...new Set(ok.map((i) => xs[i]))].sort((a, b) => a - b);
  const y = [...new Set(ok.map((i) => ys[i]))].sort((a, b) => a - b);
  const col = new Map(x.map((v, k) => [v, k]));
  const row = new Map(y.map((v, k) => [v, k]));
  const z = y.map(() => x.map(() => NaN));
  let repeated = 0;
  for (const i of ok) {
    const r = row.get(ys[i]); const c = col.get(xs[i]);
    if (!Number.isNaN(z[r][c])) repeated++;
    z[r][c] = zs[i];
  }
  return { x, y, z, cells: x.length * y.length, filled: ok.length - repeated, repeated, rows: ok.length };
}

/**
 * The counts of points in an nx by ny grid of equal bins over the range of
 * the data, as numpy.histogram2d counts them: a bin takes its left edge, the
 * last bin its right edge too; a range of no width is widened by 0.5 each side.
 *
 * @returns {{x: number[], y: number[], z: number[][], total: number, xEdges: number[], yEdges: number[]}}
 *   x and y are the bin centres; z[row of y][column of x] the counts
 */
export function histogram2d(xs, ys, nx = DEFAULT_BINS_2D, ny = nx) {
  nx = clampInt(nx, 1, 500, DEFAULT_BINS_2D);
  ny = clampInt(ny, 1, 500, DEFAULT_BINS_2D);
  const n = Math.min(xs.length, ys.length);
  let xlo = Infinity; let xhi = -Infinity; let ylo = Infinity; let yhi = -Infinity; let total = 0;
  for (let i = 0; i < n; i++) {
    if (!isNum(xs[i]) || !isNum(ys[i])) continue;
    total++;
    if (xs[i] < xlo) xlo = xs[i];
    if (xs[i] > xhi) xhi = xs[i];
    if (ys[i] < ylo) ylo = ys[i];
    if (ys[i] > yhi) yhi = ys[i];
  }
  if (!total) return { x: [], y: [], z: [], total: 0, xEdges: [], yEdges: [] };
  if (xlo === xhi) { xlo -= 0.5; xhi += 0.5; }
  if (ylo === yhi) { ylo -= 0.5; yhi += 0.5; }
  const edges = (lo, hi, m) => Array.from({ length: m + 1 }, (_, k) => (k === m ? hi : lo + (k * (hi - lo)) / m));
  const xEdges = edges(xlo, xhi, nx); const yEdges = edges(ylo, yhi, ny);
  const bin = (v, e, lo, hi, m) => {
    let k = Math.min(m - 1, Math.max(0, Math.floor(((v - lo) / (hi - lo)) * m)));
    while (k > 0 && v < e[k]) k--;
    while (k < m - 1 && v >= e[k + 1]) k++;
    return k;
  };
  const z = Array.from({ length: ny }, () => new Array(nx).fill(0));
  for (let i = 0; i < n; i++) {
    if (!isNum(xs[i]) || !isNum(ys[i])) continue;
    z[bin(ys[i], yEdges, ylo, yhi, ny)][bin(xs[i], xEdges, xlo, xhi, nx)]++;
  }
  const mid = (e) => e.slice(0, -1).map((v, k) => (v + e[k + 1]) / 2);
  return { x: mid(xEdges), y: mid(yEdges), z, total, xEdges, yEdges };
}

/**
 * The groups of a box plot: the values of one column, split by the text of a
 * second column (in the order they first appear, or by number when that
 * column holds numbers), or all of them as one group named for the column.
 * Rows with no number or no group name are left out.
 *
 * @param {ReturnType<typeof readTable>} table
 * @param {number} valueCol
 * @param {number|null} [groupCol]
 * @returns {{label: string, values: number[]}[]}
 */
export function boxGroups(table, valueCol, groupCol = null) {
  const v = table.columns[valueCol] || [];
  if (!Number.isInteger(groupCol) || groupCol < 0 || groupCol >= table.headers.length || groupCol === valueCol) {
    return [{ label: columnName(table.headers, valueCol), values: v.filter(isNum) }];
  }
  const names = table.texts[groupCol] || [];
  const groups = new Map();
  for (let i = 0; i < v.length; i++) {
    if (!isNum(v[i]) || !names[i]) continue;
    if (!groups.has(names[i])) groups.set(names[i], []);
    groups.get(names[i]).push(v[i]);
  }
  const list = [...groups].map(([label, values]) => ({ label, values }));
  if (table.numeric[groupCol]) list.sort((a, b) => pyFloat(a.label) - pyFloat(b.label));
  return list;
}

/**
 * Bin edges typed as text: numbers separated by commas, semicolons or
 * spaces, at least two, each larger than the one before.
 *
 * @param {string} text
 * @returns {{edges: number[]|null, error: string}} the edges, or why there are none
 */
export function parseEdges(text) {
  const parts = String(text ?? '').split(/[,;\s]+/).filter(Boolean);
  if (!parts.length) return { edges: null, error: 'Type the bin edges, for example 0, 1, 2, 5, 10.' };
  const edges = parts.map(pyFloat);
  const bad = parts.find((p, i) => !isNum(edges[i]));
  if (bad !== undefined) return { edges: null, error: `"${bad}" is not a number.` };
  if (edges.length < 2) return { edges: null, error: 'Bins need at least two edges.' };
  for (let i = 1; i < edges.length; i++) {
    if (!(edges[i] > edges[i - 1])) return { edges: null, error: `The edges must increase: ${parts[i]} comes after ${parts[i - 1]}.` };
  }
  return { edges, error: '' };
}

/**
 * The replicates of each name: the rows of a value column grouped by the
 * text of a name column, in the order the names first appear (by number
 * when the names are numbers). Rows with no number or no name are left out.
 *
 * @param {ReturnType<typeof readTable>} table
 * @param {number} valueCol
 * @param {number} nameCol
 * @returns {{names: string[], codes: number[], counts: number[]}} `codes[i]` is the group of
 *   row i (its place in `names`), -1 for a row that is in none; `counts` how many values each has
 */
export function replicateGroups(table, valueCol, nameCol) {
  const v = table.columns[valueCol] || [];
  const text = table.texts[nameCol] || [];
  const order = new Map();
  for (let i = 0; i < v.length; i++) if (isNum(v[i]) && text[i] && !order.has(text[i])) order.set(text[i], order.size);
  let names = [...order.keys()];
  if (table.numeric[nameCol]) names = names.slice().sort((a, b) => pyFloat(a) - pyFloat(b));
  const place = new Map(names.map((n, k) => [n, k]));
  const counts = names.map(() => 0);
  const codes = v.map((x, i) => {
    const k = place.get(text[i]);
    if (k === undefined) return -1;
    if (isNum(x)) counts[k]++;
    return k;
  });
  return { names, codes, counts };
}

/**
 * The columns a chart starts with: for bars the first text column and the
 * first column of numbers; for a histogram or box plot the first column of
 * numbers (a box plot grouped by the first text column); for maps the first
 * three columns of numbers.
 *
 * @param {ReturnType<typeof readTable>} table
 * @param {string} chart - one of CHART_KINDS
 * @returns {{x?: number, y?: number, z?: number, groupBy?: number|null}}
 */
export function suggestColumns(table, chart) {
  const all = table.headers.map((_, i) => i);
  const nums = all.filter((i) => table.numeric[i]);
  const text = all.filter((i) => !table.numeric[i]);
  const num = (k) => (nums.length ? nums[Math.min(k, nums.length - 1)] : Math.min(k, all.length - 1));
  switch (chart) {
    case 'bar': case 'bars-mean': {
      const x = text.length ? text[0] : num(0);
      const y = nums.find((i) => i !== x) ?? num(0);
      return { x, y };
    }
    case 'hist': return { y: num(0) };
    case 'box': case 'violin': return { y: num(0), groupBy: text.length ? text[0] : null };
    case 'heatmap': case 'contour': return { x: num(0), y: num(1), z: num(2) };
    case 'hist2d': return { x: num(0), y: num(1) };
    default: return {};
  }
}

/** The columns of the file a series needs a number from, for the rows it can draw. */
export function seriesColumns(table, s) {
  const chart = CHART_KINDS.includes(s.chart) ? s.chart : 'curve';
  switch (chart) {
    case 'bar': return table.numeric[s.x] && s.x !== s.y ? [s.x, s.y] : [s.y];
    case 'bars-mean': case 'hist': case 'box': case 'violin': return [s.y];
    case 'heatmap': case 'contour': return [s.x, s.y, s.z];
    case 'hist2d': return [s.x, s.y];
    default: return s.draw === 'band' ? [s.x, s.y, Number.isInteger(s.y2) ? s.y2 : s.y] : [s.x, s.y];
  }
}

/**
 * Which second axes a series may stand on: a top x axis for curves,
 * histograms and bars placed by numbers (bars named by text stand on the
 * groups along the bottom), a right y axis for curves, bars and histograms.
 * Maps, contours, box plots, violin plots and horizontal bars stay on the
 * panel's own axes.
 *
 * @returns {{x: boolean, y: boolean}}
 */
export function axisChoices(table, s) {
  const chart = CHART_KINDS.includes(s.chart) ? s.chart : 'curve';
  if (chart === 'curve' || chart === 'hist') return { x: true, y: true };
  if ((chart === 'bar' || chart === 'bars-mean') && s.orientation === 'h') return { x: false, y: false };
  if (chart === 'bar') return { x: !!table.numeric[s.x] && s.x !== s.y, y: true };
  if (chart === 'bars-mean') return { x: false, y: true };
  return { x: false, y: false };
}

/* What a histogram's y axis shows, for its label. */
function histogramLabel(normalise, cumulative) {
  const name = { counts: 'Count', density: 'Density', fraction: 'Fraction', percent: 'Percent' }[normalise];
  if (!cumulative) return name;
  return normalise === 'counts' ? 'Cumulative count' : normalise === 'percent' ? 'Cumulative percent' : 'Cumulative fraction';
}

/** A histogram series' bins and scaling as the figure takes them, and what is wrong with its edges, if anything. */
export function histogramOptions(s) {
  let bins = clampInt(s.bins, 1, 1000, DEFAULT_BINS);
  let error = '';
  if (s.binsMode === 'rule') bins = BIN_RULES.includes(s.binRule) ? s.binRule : 'auto';
  else if (s.binsMode === 'edges') {
    const e = parseEdges(s.binEdges);
    if (e.edges) bins = e.edges; else error = e.error;
  }
  const normalise = HISTOGRAM_NORMS.includes(s.normalise) ? s.normalise : s.density ? 'density' : 'counts';
  return { bins, normalise, cumulative: !!s.cumulative, error };
}

/**
 * The look a builder figure starts from: a single-column figure for a
 * journal, 9 pt labels (ticks 8 pt, title 10 pt), ticks inside and on all
 * four sides, saved at exactly the size set.
 */
export function builderLook() {
  const ticks = { direction: 'in', mirror: true };
  return {
    width: 3.5, height: 2.6, dpi: 300, fontSize: 9,
    legend: { show: true, position: 'best', frame: true, fontSize: 8 },
    xTicks: { ...ticks },
    yTicks: { ...ticks },
    export: { format: 'pdf', tight: false }
  };
}

/* ------------------------------------------------------------------ *
 * Where the panels go
 * ------------------------------------------------------------------ */

/** The largest grid the page offers, and the most insets. */
export const MAX_GRID_ROWS = 6;
export const MAX_GRID_COLS = 4;
export const MAX_INSETS = 4;

const share = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

/**
 * The page's layout, complete: the grid (`rows` by `cols`), which panels
 * share their axes (`sharex`: 'none', 'col' or 'all'; `sharey`: 'none',
 * 'row' or 'all'), and the insets, each drawn inside the panel of a cell
 * (`parent`, counted row by row from 0) at a share of its width and
 * height, with limits of its own (`xLim`, `yLim`; null: fitted to its data)
 * and, with `zoom`, a box on its parent around what it enlarges. The gap
 * between the panels and their letters are look: they are in the style.
 *
 * Left alone, panels in one column share their x axis, as they always
 * have; on a grid of several columns they share nothing.
 *
 * @param {object} [layout] - the page's state; any part may be missing
 * @returns {{rows: number, cols: number, sharex: string, sharey: string,
 *   insets: {id: string, parent: number, x: number, y: number, w: number, h: number, zoom: boolean,
 *   xLim: (number|null)[], yLim: (number|null)[]}[]}}
 */
export function builderLayout(layout) {
  const l = layout && typeof layout === 'object' ? layout : {};
  const cols = clampInt(l.cols, 1, MAX_GRID_COLS, 1);
  const rows = clampInt(l.rows, 1, MAX_GRID_ROWS, 1);
  const part = (v, lo, hi, d) => { const n = Number(v); return v === null || v === undefined || v === '' || !Number.isFinite(n) ? d : Math.min(hi, Math.max(lo, n)); };
  const lim = (pair) => [0, 1].map((k) => { const n = share(Array.isArray(pair) ? pair[k] : null); return n === null || !Number.isFinite(n) ? null : n; });
  // In one column, down a column is all of them, and along a row is none.
  const sharex = SHARE_X.includes(l.sharex) ? l.sharex : (cols === 1 ? 'all' : 'none');
  const sharey = SHARE_Y.includes(l.sharey) ? l.sharey : 'none';
  return {
    rows,
    cols,
    sharex: cols === 1 && sharex === 'col' ? 'all' : sharex,
    sharey: cols === 1 && sharey === 'row' ? 'none' : sharey,
    insets: (Array.isArray(l.insets) ? l.insets : []).slice(0, MAX_INSETS).map((s, k) => {
      const o = s && typeof s === 'object' ? s : {};
      const x = part(o.x, 0, 0.9, 0.55); const y = part(o.y, 0, 0.9, 0.5);
      return {
        id: typeof o.id === 'string' && o.id ? o.id : `inset${k + 1}`,
        parent: clampInt(o.parent, 0, MAX_GRID_ROWS * MAX_GRID_COLS - 1, 0),
        x, y, w: part(o.w, 0.1, 1 - x, Math.min(0.4, 1 - x)), h: part(o.h, 0.1, 1 - y, Math.min(0.4, 1 - y)),
        zoom: !!o.zoom, xLim: lim(o.xLim), yLim: lim(o.yLim)
      };
    })
  };
}

/**
 * The panels the series of a state are drawn in, in the order of the
 * figure's panels: the cells in use, row by row, then the insets in use.
 * A series' `panel` is the number of its cell (from 0, row by row) or the
 * id of an inset. In one column, cells no series uses are left out, as
 * they always were; on a grid they stay empty.
 *
 * @param {{series?: object[], layout?: object}} state
 * @returns {{key: number|string, cell: number|null, inset: object|null}[]}
 */
export function builderPanels(state) {
  const lay = builderLayout(state.layout);
  const insets = new Map(lay.insets.map((s) => [s.id, s]));
  const cells = new Set(); const inside = new Set();
  for (const s of state.series || []) {
    if (typeof s.panel === 'string' && insets.has(s.panel)) inside.add(s.panel);
    else cells.add(cellOf(s));
  }
  return [
    ...[...cells].sort((a, b) => a - b).map((c) => ({ key: c, cell: c, inset: null })),
    ...lay.insets.filter((s) => inside.has(s.id)).map((s) => ({ key: s.id, cell: null, inset: s }))
  ];
}

/* The cell a series is drawn in (0 when it names none, or an inset that is gone). */
const cellOf = (s) => (typeof s.panel === 'string' ? 0 : Math.max(0, Math.round(Number(s.panel) || 0)));

/**
 * One data field: the column's numbers, a Python name, and where the script
 * reads it when it can.
 */
function fieldOf(file, i) {
  const t = file.table;
  const name = t.headers[i];
  const f = { values: t.columns[i] || [], name: name || `column_${i + 1}` };
  if (!file.example && t.readable[i] && file.source) { f.source = file.source; f.column = name; }
  return f;
}

/** The axis label a column gets: the file's own labels (the example's), or its header. */
function labelOf(file, i) {
  const h = file.table.headers[i] ?? '';
  return (file.labels && Object.hasOwn(file.labels, h)) ? file.labels[h] : h;
}

/**
 * The description of the figure for the files and series the person set up.
 *
 * A series is a curve (`chart` 'curve' or absent, drawn as `draw`) or one of
 * the other charts of CHART_KINDS, each reading the columns it names:
 *
 *   curve      x, y, optional y2 (band), yerr, xerr
 *   bar        x (text or numbers), y, optional yerr; orientation ('h': lying flat),
 *              stack ('stack' or 'percent': on the other stacked bars of its panel)
 *   bars-mean  x (the names), y (the values, several rows for each name), error
 *              ('sd', 'sem', 'ci' or 'none'), level (of the interval), points, orientation
 *   hist       y; binsMode 'number' (bins), 'rule' (binRule, one of numpy's) or 'edges'
 *              (binEdges, text); normalise ('counts', 'density', 'fraction', 'percent';
 *              `density: true` still means 'density'), cumulative
 *   box        y, optional groupBy; whis (the whisker rule), notch, interval (the level of
 *              the mean's confidence interval, which shows the mean)
 *   violin     y, optional groupBy; bandwidth, cut, scale, inner, points
 *   heatmap    x, y, z
 *   contour    x, y, z, levels, filled
 *   hist2d     x, y, bins
 *
 * A series may stand on its panel's second axes (axisChoices): a top x axis
 * (`xAxis` 'top'), a right y axis (`yAxis` 'right'), or both. Horizontal bars
 * do not: their names go on the left axis of their panel (`yCategories`, the
 * first name at the top) and their lengths along the bottom.
 *
 * Bars placed by numbers are four fifths as wide as the closest two are apart.
 *
 * Maps and the grids of 2D histograms go into the description as the
 * numbers the preview draws; the other charts read their columns by name
 * wherever the file has one.
 *
 * @param {{files: {id: string, name: string, source?: string, example?: boolean, labels?: object,
 *   table: ReturnType<typeof readTable>}[], series: {id: string, fileId: string, x: number, y: number,
 *   y2?: number, z?: number, chart?: string, draw: string, yerr?: number|null, xerr?: number|null,
 *   groupBy?: number|null, bins?: number, density?: boolean, levels?: number, filled?: boolean,
 *   panel?: number, label?: string, xAxis?: 'bottom'|'top', yAxis?: 'left'|'right'}[]}} state
 * @param {{title?: string}} [options] - the title, for the file name of the exports
 * @returns {object|null} a figure description, or null when there is nothing to draw
 */
export function builderFigure(state, options = {}) {
  const files = new Map((state.files || []).map((f) => [f.id, f]));
  const list = (state.series || []).filter((s) => files.has(s.fileId));
  if (!list.length) return null;
  const many = list.length > 1;
  // Panels in the order of their cells, then the insets. In one column the
  // empty cells are left out; on a grid each panel names its cell.
  const lay = builderLayout(state.layout);
  const slots = builderPanels({ series: list, layout: state.layout });
  const grid = lay.cols > 1;
  // One x axis for the whole figure, labelled once: the plain stack.
  const oneX = !grid && lay.sharex === 'all' && !slots.some((p) => p.inset);
  const idOf = (slot) => (slot.inset ? slot.inset.id : slots.length > 1 ? `panel${slot.cell + 1}` : 'main');
  const { yTicks, ...look } = builderLook();
  const panels = slots.map((slot) => {
    const p = { id: idOf(slot), yLabel: '', yTicks: { ...yTicks }, series: [] };
    if (slot.inset) {
      const at = slot.inset;
      const parent = slots.find((x) => x.cell === at.parent) || slots.find((x) => !x.inset);
      p.name = `inset ${lay.insets.findIndex((x) => x.id === at.id) + 1}`;
      // An inset is too small for axis labels: it gets them in the Style panel, if at all.
      p.xLabel = '';
      p.inset = { parent: parent ? idOf(parent) : 'main', x: at.x, y: at.y, w: at.w, h: at.h, zoom: at.zoom };
      if (at.xLim.some((v) => v !== null)) p.xLim = at.xLim.slice();
      if (at.yLim.some((v) => v !== null)) p.yLim = at.yLim.slice();
    } else if (grid) {
      p.row = Math.floor(slot.cell / lay.cols);
      p.col = slot.cell % lay.cols;
      p.name = `row ${p.row + 1}, column ${p.col + 1}`;
    }
    return p;
  });
  const panelOf = (s) => {
    const key = typeof s.panel === 'string' && slots.some((p) => p.key === s.panel) ? s.panel : cellOf(s);
    return panels[slots.findIndex((p) => p.key === key)];
  };
  let pointIndex = 0;
  // The next free place for a box or a violin, in each panel: panels that
  // share the x axis share its names, so the groups of one stand over the
  // groups of another.
  const boxNext = new Map();
  const nameLists = new Map();
  const categoriesOf = (panel) => {
    const slot = slots[panels.indexOf(panel)];
    const key = slot.inset ? `inset ${slot.key}` : lay.sharex === 'all' ? 'all' : lay.sharex === 'col' ? `col ${slot.cell % lay.cols}` : `cell ${slot.cell}`;
    if (!nameLists.has(key)) nameLists.set(key, []);
    return nameLists.get(key);
  };
  // The x label each panel would give its own axis, from its first series on it.
  const xLabels = new Map();
  // Horizontal bars named by text: the names of each panel's y axis, and the
  // series that stand on them, to be turned so that the first name is on top.
  const lying = new Map();
  let xLabel = null;
  let bottom = false;
  list.forEach((s, k) => {
    const file = files.get(s.fileId);
    const t = file.table;
    const panel = panelOf(s);
    const categories = categoriesOf(panel);
    const chart = CHART_KINDS.includes(s.chart) ? s.chart : 'curve';
    const draw = DRAW_MODES.includes(s.draw) ? s.draw : 'line';
    const cols = t.headers.length;
    const ok = (i) => Number.isInteger(i) && i >= 0 && i < cols;
    const x = ok(s.x) ? s.x : 0;
    const y = ok(s.y) ? s.y : Math.min(1, cols - 1);
    const z = ok(s.z) ? s.z : y;
    const y2 = ok(s.y2) ? s.y2 : y;
    const label = typeof s.label === 'string' ? s.label
      : chart === 'curve' && draw === 'band' && y2 !== y ? `${columnName(t.headers, y)} to ${columnName(t.headers, y2)}`
        : columnName(t.headers, chart === 'heatmap' || chart === 'contour' ? z : y);
    const q = { id: s.id, label, legend: many };
    // A series on a second axis names it: the top x by its x column, the
    // right y by its y; the axis takes the series' colour when it is the only one there.
    const can = axisChoices(t, { ...s, x, y });
    const top = can.x && s.xAxis === 'top';
    const right = can.y && s.yAxis === 'right';
    if (top) { q.xAxis = 'top'; panel.x2Color = 'auto'; } else bottom = true;
    if (right) { q.yAxis = 'right'; panel.y2Color = 'auto'; }
    const note = (xl, yl) => {
      if (top) { if (panel.x2Label === undefined) panel.x2Label = xl; } else {
        if (xLabel === null) xLabel = xl;
        if (!xLabels.has(panel)) xLabels.set(panel, xl);
      }
      if (right) { if (panel.y2Label === undefined) panel.y2Label = yl; } else if (!panel.yLabel && !panel.inset) panel.yLabel = yl;
    };
    // Bars lie flat when asked to: their names or positions go up the y axis
    // (the first name on top), their lengths along x.
    const flat = (chart === 'bar' || chart === 'bars-mean') && s.orientation === 'h';
    const named = (names, positionName) => {
      const at = { values: names.map((_, i) => i), name: positionName };
      if (flat) {
        if (!lying.has(panel)) lying.set(panel, { names: [], fields: [] });
        const l = lying.get(panel);
        names.forEach((n, i) => { if (l.names[i] === undefined) l.names[i] = n; });
        l.fields.push(at);
      } else {
        names.forEach((n, i) => { if (categories[i] === undefined) categories[i] = n; });
      }
      return at;
    };
    if (chart === 'bar') {
      const numericX = t.numeric[x] && x !== y;
      const yv = t.columns[y]; const xv = t.columns[x];
      const keep = [];
      for (let i = 0; i < t.rows; i++) if (isNum(yv[i]) && (!numericX || isNum(xv[i]))) keep.push(i);
      const whole = keep.length === t.rows;
      const pick = (arr) => keep.map((i) => arr[i]);
      q.kind = 'bar';
      let at;
      if (numericX) {
        at = whole ? fieldOf(file, x) : { values: pick(xv), name: `${columnName(t.headers, x)}_used` };
        // Bars as wide as four fifths of the closest gap between them.
        const xs = [...new Set(pick(xv))].sort((a, b) => a - b);
        let gap = Infinity;
        for (let i = 1; i < xs.length; i++) gap = Math.min(gap, xs[i] - xs[i - 1]);
        q.width = Number.isFinite(gap) && gap > 0 ? 0.8 * gap : 0.8;
      } else {
        at = named(keep.map((i) => t.texts[x][i] || String(i + 1)), `${columnName(t.headers, x)}_position`);
      }
      const length = whole ? fieldOf(file, y) : { values: pick(yv), name: `${columnName(t.headers, y)}_used` };
      const err = ok(s.yerr) ? (whole ? fieldOf(file, s.yerr) : { values: pick(t.columns[s.yerr]), name: `${columnName(t.headers, s.yerr)}_used` }) : null;
      if (flat) Object.assign(q, { orientation: 'h', y: at, x: length }, err ? { xerr: err } : {});
      else Object.assign(q, { x: at, y: length }, err ? { yerr: err } : {});
      const stack = STACK_MODES.includes(s.stack) ? s.stack : 'none';
      if (stack !== 'none') q.stack = stack;
      const along = stack === 'percent' ? 'Share (%)' : labelOf(file, y);
      if (flat) note(along, labelOf(file, x)); else note(labelOf(file, x), along);
    } else if (chart === 'bars-mean') {
      // One bar for each name: the mean of its rows, which the script works
      // out again from the file (the group of each row goes into the script).
      const g = replicateGroups(t, y, x);
      if (!g.names.length) return;
      const error = REPLICATE_ERRORS.includes(s.error) ? s.error : 'sd';
      const at = named(g.names, `${columnName(t.headers, x)}_position`);
      Object.assign(q, { kind: 'bar', replicates: { values: fieldOf(file, y), codes: g.codes, names: g.names, error, level: LEVELS.includes(Number(s.level)) ? Number(s.level) : 0.95 } });
      if (s.points) q.points = true;
      if (flat) Object.assign(q, { orientation: 'h', y: at }); else q.x = at;
      if (flat) note(labelOf(file, y), labelOf(file, x)); else note(labelOf(file, x), labelOf(file, y));
    } else if (chart === 'hist') {
      const h = histogramOptions(s);
      const density = h.normalise === 'density';
      Object.assign(q, { kind: 'histogram', values: fieldOf(file, y), bins: h.bins, density });
      if (h.normalise !== 'counts' && !density) q.normalise = h.normalise;
      if (h.cumulative) q.cumulative = true;
      note(labelOf(file, y), histogramLabel(h.normalise, h.cumulative));
    } else if (chart === 'box' || chart === 'violin') {
      const by = ok(s.groupBy) && s.groupBy !== y ? s.groupBy : null;
      const groups = boxGroups(t, y, by);
      q.kind = chart;
      q.legend = false;
      q.groups = groups.map((g) => {
        const position = boxNext.get(panel) || 0;
        boxNext.set(panel, position + 1);
        // A place named differently in two panels carries both names.
        const named = categories[position] === undefined ? [] : String(categories[position]).split(' / ');
        if (!named.includes(g.label)) categories[position] = [...named, g.label].join(' / ');
        return { position, values: by === null ? fieldOf(file, y) : { values: g.values, name: `${columnName(t.headers, y)}_${g.label}` } };
      });
      if (chart === 'box') {
        if (s.whis !== undefined && s.whis !== null && String(s.whis) !== '1.5') q.whis = s.whis;
        if (s.notch) q.notch = true;
        if (LEVELS.includes(Number(s.interval))) Object.assign(q, { mean: true, level: Number(s.interval) });
      } else {
        if (KDE_BANDWIDTHS.includes(s.bandwidth) && s.bandwidth !== 'scott') q.bandwidth = s.bandwidth;
        if (Number(s.cut) > 0) q.cut = Number(s.cut);
        if (VIOLIN_SCALES.includes(s.scale) && s.scale !== 'width') q.scale = s.scale;
        if (VIOLIN_INNER.includes(s.inner) && s.inner !== 'box') q.inner = s.inner;
        if (s.points) q.points = true;
      }
      note(by === null ? '' : labelOf(file, by), labelOf(file, y));
    } else if (chart === 'heatmap' || chart === 'contour') {
      const g = gridFromXyz(t.columns[x], t.columns[y], t.columns[z]);
      if (!g.x.length) return;
      const cb = { show: true, label: labelOf(file, z) };
      const base = columnName(t.headers, z);
      Object.assign(q, {
        kind: chart, legend: false, x: { values: g.x, name: `${columnName(t.headers, x)}_grid` },
        y: { values: g.y, name: `${columnName(t.headers, y)}_grid` }, z: { values: g.z, name: `${base}_grid` }, colorbar: cb
      });
      if (chart === 'contour') Object.assign(q, { levels: clampInt(s.levels, 1, 100, DEFAULT_LEVELS), filled: s.filled !== false });
      note(labelOf(file, x), labelOf(file, y));
    } else if (chart === 'hist2d') {
      const n = clampInt(s.bins, 1, 500, DEFAULT_BINS_2D);
      const h = histogram2d(t.columns[x], t.columns[y], n, n);
      if (!h.x.length) return;
      Object.assign(q, {
        kind: 'heatmap', legend: false, label: typeof s.label === 'string' ? s.label : 'Count',
        x: { values: h.x, name: `${columnName(t.headers, x)}_bins` }, y: { values: h.y, name: `${columnName(t.headers, y)}_bins` },
        z: { values: h.z, name: 'counts' }, colorbar: { show: true, label: 'Count' }
      });
      note(labelOf(file, x), labelOf(file, y));
    } else {
      q.x = fieldOf(file, x);
      const dash = DASH_ROUNDS[Math.floor(k / 8) % DASH_ROUNDS.length];
      if (draw === 'band') {
        Object.assign(q, { kind: 'band', lower: fieldOf(file, y), upper: fieldOf(file, y2) });
      } else {
        const marker = draw === 'line' || draw === 'step' ? 'none' : POINT_MARKERS[pointIndex++ % POINT_MARKERS.length];
        const yerr = draw !== 'step' && ok(s.yerr) ? fieldOf(file, s.yerr) : null;
        const xerr = draw !== 'step' && ok(s.xerr) ? fieldOf(file, s.xerr) : null;
        q.y = fieldOf(file, y);
        if (yerr || xerr) {
          Object.assign(q, { kind: 'errorbar', marker, size: 4, lineStyle: draw === 'points' ? 'none' : dash, lineWidth: 1.25 });
          if (yerr) q.yerr = yerr;
          if (xerr) q.xerr = xerr;
        } else if (draw === 'points') {
          Object.assign(q, { kind: 'scatter', marker, size: 4 });
        } else {
          Object.assign(q, { kind: 'line', marker, size: 4, lineWidth: 1.25, lineStyle: dash });
          if (draw === 'step') q.step = 'mid';
        }
      }
      note(labelOf(file, x), labelOf(file, y));
    }
    panel.series.push(q);
  });
  // The names of horizontal bars read down the axis: the first at the top.
  for (const [panel, l] of lying) {
    const n = l.names.length;
    for (const at of l.fields) at.values = at.values.map((i) => n - 1 - i);
    panel.yCategories = Array.from(l.names, (c) => (c === undefined ? '' : c)).reverse();
  }
  const drawn = panels.filter((p) => p.series.length);
  if (!drawn.length) return null;
  const firstFile = files.get(list[0].fileId);
  const fig = {
    ...look,
    xLabel: !oneX ? '' : xLabel === null ? (bottom ? labelOf(firstFile, Number.isInteger(list[0].x) ? list[0].x : 0) : '') : xLabel,
    export: { ...look.export, filename: slug(options.title) },
    panels: drawn
  };
  const names = (list) => Array.from(list, (c) => (c === undefined ? '' : c));
  if (oneX) {
    if (categoriesOf(panels[0]).length) fig.xCategories = names(categoriesOf(panels[0]));
  } else {
    // Each panel labels and names its own x axis; where panels share one,
    // the figure labels it on the outer panels.
    for (const panel of drawn) {
      if (!panel.inset) panel.xLabel = xLabels.get(panel) ?? '';
      if (categoriesOf(panel).length) panel.xCategories = names(categoriesOf(panel));
    }
    if (grid) fig.layout = { rows: Math.max(lay.rows, ...slots.filter((p) => !p.inset).map((p) => Math.floor(p.cell / lay.cols) + 1)), cols: lay.cols };
    fig.sharex = lay.sharex;
  }
  if (lay.sharey !== 'none') fig.sharey = lay.sharey;
  return fig;
}

/**
 * What the Python script needs to read the files: the source id of each
 * file the series use (the example has none), as figureScript's `files`.
 */
export function pythonFiles(state) {
  const used = new Set((state.series || []).map((s) => s.fileId));
  const out = {};
  for (const f of state.files || []) {
    if (!used.has(f.id) || f.example || !f.source) continue;
    out[f.source] = { file: f.name, format: 'csv', ...(f.table.delimiter !== ',' ? { delimiter: f.table.delimiter } : {}) };
  }
  return out;
}

/**
 * What a series draws and what it leaves out, for the note under its card.
 *
 * @param {object} file - as in builderFigure
 * @param {object} s - the series
 * @param {{xLog?: boolean, yLog?: boolean, x2Log?: boolean, y2Log?: boolean}} [scales] - which
 *   axes of the series' panel are logarithmic: the bottom x, the left y, the top x, the right y
 * @returns {string} '' when there is nothing to say
 */
export function seriesNote(file, s, scales = {}) {
  const count = (v) => v.toLocaleString('en-GB');
  const t = file.table;
  const chart = CHART_KINDS.includes(s.chart) ? s.chart : 'curve';
  const band = chart === 'curve' && s.draw === 'band';
  const cols = seriesColumns(t, s);
  const n = t.rows;
  const has = (i) => cols.every((c) => Number.isFinite((t.columns[c] || [])[i]));
  let drawn = 0; let first = -1; let last = -1; let gaps = 0;
  for (let i = 0; i < n; i++) {
    if (has(i)) { drawn++; if (first < 0) first = i; last = i; }
  }
  for (let i = first + 1; i < last; i++) if (!has(i)) gaps++;
  const names = [...new Set(cols)].map((c) => columnName(t.headers, c));
  if (!drawn) return `No row has a number in ${names.join(' and ')}, so nothing is drawn.`;
  const notes = [];
  if (chart === 'curve' && s.x === s.y && !band) notes.push('X and Y are the same column.');
  if ((chart === 'heatmap' || chart === 'contour' || chart === 'hist2d') && new Set(cols).size < cols.length) {
    notes.push('Two of the columns are the same, so the picture is a diagonal at best.');
  }
  const missing = n - drawn;
  if (missing) {
    const lined = chart === 'curve' && (band || s.draw === 'line' || s.draw === 'both' || s.draw === 'step');
    notes.push(`${count(missing)} of ${count(n)} rows have no number in ${names.join(' or ')}${lined && gaps ? '; the line breaks there' : ' and are left out'}.`);
  }
  if (chart === 'bar' && !t.numeric[s.x]) {
    const names = [];
    for (let i = 0; i < n; i++) if (has(i)) names.push(t.texts[s.x][i]);
    const different = new Set(names).size;
    if (different < names.length) {
      notes.push(`${count(names.length)} rows share ${count(different)} names, and each row is a bar. For one bar per name, choose Bars of means.`);
    }
  }
  if ((chart === 'bar' || chart === 'bars-mean') && s.orientation === 'h' && (s.xAxis === 'top' || s.yAxis === 'right')) {
    notes.push('Horizontal bars stand on the bottom and left axes; the second axis chosen is not used.');
  }
  if (chart === 'bar' && (s.stack === 'stack' || s.stack === 'percent') && scales.stackPartners === 0) {
    notes.push('No other stacked bars in this panel on the same axes: set Stacking on the series it should stand on too.');
  }
  if (chart === 'bars-mean') {
    const g = replicateGroups(t, s.y, s.x);
    const each = g.names.map((name, k) => `${name} ${count(g.counts[k])}`);
    const lo = Math.min(...g.counts); const hi = Math.max(...g.counts);
    notes.push(g.names.length <= 8
      ? `Values per name: ${each.join(', ')}.`
      : `${count(g.names.length)} names, ${lo === hi ? count(lo) : `${count(lo)} to ${count(hi)}`} values each.`);
    const single = g.names.filter((_, k) => g.counts[k] === 1);
    const error = REPLICATE_ERRORS.includes(s.error) ? s.error : 'sd';
    if (single.length && error !== 'none') {
      notes.push(`${single.length === 1 ? `"${single[0]}" has` : `${count(single.length)} names have`} one value, so no error bar.`);
    }
    const skipped = g.codes.filter((c, i) => c < 0 && Number.isFinite(t.columns[s.y][i])).length;
    if (skipped) notes.push(`${count(skipped)} row${skipped === 1 ? ' has' : 's have'} no name and ${skipped === 1 ? 'is' : 'are'} left out.`);
    if (t.numeric[s.x]) notes.push('The names column holds numbers: each different number is a bar.');
  }
  if (chart === 'hist') {
    const h = histogramOptions(s);
    if (h.error) notes.push(`${h.error} Until the edges are right, ${DEFAULT_BINS} equal bins are drawn.`);
    else if (Array.isArray(h.bins)) {
      const v = t.columns[s.y] || [];
      const out = v.filter((x) => Number.isFinite(x) && (x < h.bins[0] || x > h.bins[h.bins.length - 1])).length;
      if (out) notes.push(`${count(out)} value${out === 1 ? ' lies' : 's lie'} outside the edges and ${out === 1 ? 'is' : 'are'} not counted.`);
    }
  }
  if (chart === 'heatmap' || chart === 'contour') {
    const g = gridFromXyz(t.columns[s.x] || [], t.columns[s.y] || [], t.columns[s.z] || []);
    if (g.repeated) notes.push(`${count(g.repeated)} row${g.repeated === 1 ? ' repeats' : 's repeat'} a cell already given; the last value is used.`);
    if (g.cells > g.filled) notes.push(`${count(g.cells - g.filled)} of ${count(g.cells)} cells of the grid have no value and are left blank.`);
  }
  const alike = (g) => g.values.length > 0 && g.values.every((v) => v === g.values[0]);
  if ((chart === 'box' || chart === 'violin') && Number.isInteger(s.groupBy) && s.groupBy !== s.y) {
    const small = boxGroups(t, s.y, s.groupBy).filter((g) => g.values.length < 3 && !(chart === 'violin' && alike(g)));
    if (small.length) notes.push(`${small.length === 1 ? `Group "${small[0].label}" has` : `${count(small.length)} groups have`} fewer than three values.`);
  }
  if (chart === 'violin') {
    const groups = boxGroups(t, s.y, Number.isInteger(s.groupBy) && s.groupBy !== s.y ? s.groupBy : null);
    const flat = groups.filter(alike);
    if (flat.length) notes.push(`${flat.length === 1 ? `"${flat[0].label}" has` : `${count(flat.length)} groups have`} one value or values all alike, drawn as a line.`);
  }
  // The scales of the axes the series stands on.
  const can = axisChoices(t, s);
  const xLog = can.x && s.xAxis === 'top' ? !!scales.x2Log : !!scales.xLog;
  const yLog = can.y && s.yAxis === 'right' ? !!scales.y2Log : !!scales.yLog;
  if (chart === 'curve' && (xLog || yLog)) {
    const xs = t.columns[s.x] || [];
    const ys = band ? [s.y, Number.isInteger(s.y2) ? s.y2 : s.y] : [s.y];
    let off = 0;
    for (let i = 0; i < n; i++) {
      if (!has(i)) continue;
      if ((xLog && !(xs[i] > 0)) || (yLog && ys.some((c) => !(t.columns[c][i] > 0)))) off++;
    }
    if (off) notes.push(`${count(off)} point${off === 1 ? ' is' : 's are'} at or below zero and cannot be shown on a log axis.`);
  }
  return notes.join(' ');
}

/* ------------------------------------------------------------------ *
 * The look kept between visits
 * ------------------------------------------------------------------ */

const TICK_LOOK = ['direction', 'length', 'width', 'minor', 'mirror'];
const pickKeys = (o, keys) => {
  const out = {};
  if (!o || typeof o !== 'object') return out;
  for (const k of keys) if (o[k] !== undefined) out[k] = JSON.parse(JSON.stringify(o[k]));
  return out;
};

/**
 * The part of the person's style that is a house style rather than about
 * this figure's data: sizes, fonts, colours, frame, grid, legend, tick marks
 * and export settings. Titles, labels, limits, scales, tick positions and
 * each series' look are left out, so a new file starts clean.
 */
export function houseStyle(style) {
  const s = style && typeof style === 'object' ? style : {};
  const out = pickKeys(s, ['width', 'height', 'dpi', 'fontFamily', 'fontSize', 'titleSize', 'tickSize', 'sizeUnit',
    'background', 'foreground', 'grid', 'spines', 'colormap']);
  if (s.legend) out.legend = pickKeys(s.legend, ['show', 'position', 'frame', 'fontSize', 'columns']);
  if (s.export) out.export = pickKeys(s.export, ['format', 'transparent', 'tight']);
  if (s.xTicks) out.xTicks = pickKeys(s.xTicks, TICK_LOOK);
  if (Array.isArray(s.panels)) {
    const panels = s.panels.map((p) => (p && p.yTicks ? { yTicks: pickKeys(p.yTicks, TICK_LOOK) } : {}));
    if (panels.some((p) => Object.keys(p).length)) out.panels = panels;
  }
  for (const k of Object.keys(out)) if (out[k] && typeof out[k] === 'object' && !Array.isArray(out[k]) && !Object.keys(out[k]).length) delete out[k];
  return out;
}
