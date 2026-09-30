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
 * The example's numbers are never read from a file (the person has none).
 */

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
 *   rows: number, numeric: boolean[], readable: boolean[], counts: number[], notUtf8: boolean}}
 *   columns[i] holds a number (or NaN) for every row; numeric[i] says whether at least half the
 *   rows have a number there; readable[i] whether the script can read the column by its name;
 *   counts[i] how many rows have a number there
 */
export function readTable(text, options = {}) {
  let s = String(text ?? '');
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);   // utf-8-sig
  const delimiter = options.delimiter || sniffDelimiter(s);
  const records = parseCsv(s, delimiter);
  const empty = { ok: false, delimiter, headers: [], columns: [], rows: 0, numeric: [], readable: [], counts: [], notUtf8: s.includes('�') };
  if (!records.length || !records[0].length) return { ...empty, error: 'The first line should name the columns.' };
  const headers = records[0].map((h) => h.trim());
  if (headers.length < 2) return { ...empty, headers, error: 'It needs at least two columns, separated by commas, tabs or semicolons.' };
  const body = records.slice(1).filter((r) => r.length);
  const columns = headers.map((_, i) => body.map((r) => pyFloat(r[i])));
  const counts = columns.map((c) => c.reduce((n, v) => n + (Number.isFinite(v) ? 1 : 0), 0));
  const numeric = counts.map((n) => n > 0 && n >= body.length / 2);
  const readable = headers.map((h, i) => headers.lastIndexOf(h) === i);
  if (!body.length) return { ...empty, headers, error: 'It has a header but no rows of data.' };
  return { ok: true, delimiter, headers, columns, rows: body.length, numeric, readable, counts, notUtf8: s.includes('�') };
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
 * The figure
 * ------------------------------------------------------------------ */

export const DRAW_MODES = Object.freeze(['line', 'points', 'both', 'band']);
/* Markers for series drawn with points, in turn, so that past three they differ by shape too. */
export const POINT_MARKERS = Object.freeze(['o', 's', '^', 'D', 'v']);
const DASH_ROUNDS = ['solid', 'dashed', 'dotted', 'dashdot'];

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
 * @param {{files: {id: string, name: string, source?: string, example?: boolean, labels?: object,
 *   table: ReturnType<typeof readTable>}[], series: {id: string, fileId: string, x: number, y: number,
 *   y2?: number, draw: string, yerr?: number|null, xerr?: number|null, panel?: number, label?: string}[]}} state
 * @param {{title?: string}} [options] - the title, for the file name of the exports
 * @returns {object|null} a figure description, or null when there is nothing to draw
 */
export function builderFigure(state, options = {}) {
  const files = new Map((state.files || []).map((f) => [f.id, f]));
  const list = (state.series || []).filter((s) => files.has(s.fileId));
  if (!list.length) return null;
  const many = list.length > 1;
  // Panels in the order of their numbers, empty ones left out.
  const used = [...new Set(list.map((s) => Math.max(0, Math.round(s.panel || 0))))].sort((a, b) => a - b);
  const { yTicks, ...look } = builderLook();
  const panels = used.map((p) => ({ id: used.length > 1 ? `panel${p + 1}` : 'main', yLabel: '', yTicks: { ...yTicks }, series: [] }));
  let pointIndex = 0;
  list.forEach((s, k) => {
    const file = files.get(s.fileId);
    const t = file.table;
    const panel = panels[used.indexOf(Math.max(0, Math.round(s.panel || 0)))];
    const draw = DRAW_MODES.includes(s.draw) ? s.draw : 'line';
    const cols = t.headers.length;
    const ok = (i) => Number.isInteger(i) && i >= 0 && i < cols;
    const x = ok(s.x) ? s.x : 0;
    const y = ok(s.y) ? s.y : Math.min(1, cols - 1);
    if (!panel.yLabel) panel.yLabel = labelOf(file, y);
    const y2 = ok(s.y2) ? s.y2 : y;
    const q = {
      id: s.id,
      label: typeof s.label === 'string' ? s.label
        : draw === 'band' && y2 !== y ? `${columnName(t.headers, y)} to ${columnName(t.headers, y2)}` : columnName(t.headers, y),
      legend: many,
      x: fieldOf(file, x)
    };
    const dash = DASH_ROUNDS[Math.floor(k / 8) % DASH_ROUNDS.length];
    if (draw === 'band') {
      Object.assign(q, { kind: 'band', lower: fieldOf(file, y), upper: fieldOf(file, y2) });
    } else {
      const marker = draw === 'line' ? 'none' : POINT_MARKERS[pointIndex++ % POINT_MARKERS.length];
      const yerr = ok(s.yerr) ? fieldOf(file, s.yerr) : null;
      const xerr = ok(s.xerr) ? fieldOf(file, s.xerr) : null;
      q.y = fieldOf(file, y);
      if (yerr || xerr) {
        Object.assign(q, { kind: 'errorbar', marker, size: 4, lineStyle: draw === 'points' ? 'none' : dash, lineWidth: 1.25 });
        if (yerr) q.yerr = yerr;
        if (xerr) q.xerr = xerr;
      } else if (draw === 'points') {
        Object.assign(q, { kind: 'scatter', marker, size: 4 });
      } else {
        Object.assign(q, { kind: 'line', marker, size: 4, lineWidth: 1.25, lineStyle: dash });
      }
    }
    panel.series.push(q);
  });
  const first = list[0];
  const firstFile = files.get(first.fileId);
  return {
    ...look,
    xLabel: labelOf(firstFile, Number.isInteger(first.x) ? first.x : 0),
    export: { ...look.export, filename: slug(options.title) },
    panels
  };
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
 * @param {{xLog?: boolean, yLog?: boolean}} [scales]
 * @returns {string} '' when there is nothing to say
 */
export function seriesNote(file, s, scales = {}) {
  const count = (v) => v.toLocaleString('en-GB');
  const t = file.table;
  const band = s.draw === 'band';
  const ys = band ? [s.y, Number.isInteger(s.y2) ? s.y2 : s.y] : [s.y];
  const cols = [s.x, ...ys];
  const xs = t.columns[s.x] || [];
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
  if (s.x === s.y && !band) notes.push('X and Y are the same column.');
  const missing = n - drawn;
  if (missing) {
    const lined = band || s.draw === 'line' || s.draw === 'both';
    notes.push(`${count(missing)} of ${count(n)} rows have no number in ${names.join(' or ')}${lined && gaps ? '; the line breaks there' : ' and are left out'}.`);
  }
  if (scales.xLog || scales.yLog) {
    let off = 0;
    for (let i = 0; i < n; i++) {
      if (!has(i)) continue;
      if ((scales.xLog && !(xs[i] > 0)) || (scales.yLog && ys.some((c) => !(t.columns[c][i] > 0)))) off++;
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
