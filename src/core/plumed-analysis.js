/**
 * @module core/plumed-analysis
 *
 * Reading what a PLUMED run writes, before and after the bias.
 *
 * Before: a short unbiased run gives the fluctuation and the range of each
 * collective variable, which is what the hill width and the grid bounds should
 * be chosen from rather than guessed.
 *
 * After: the hills a metadynamics run deposited sum to the free-energy
 * surface, their height over time shows whether the bias has settled, and the
 * printed bias reweights any other quantity.
 *
 * ## Conventions
 *
 * Files are PLUMED's column format: a header `#! FIELDS time cv ...`, optional
 * `#! SET min_cv -pi` lines that declare a period, then rows of numbers.
 *
 * In a well-tempered run PLUMED writes each hill height already multiplied by
 * γ/(γ-1), so that the negative sum of the hills is the free energy, as it is
 * without tempering [Barducci, Bussi and Parrinello, Phys. Rev. Lett. 100,
 * 020603 (2008)]. `sumHills` relies on that and applies no further factor.
 */

/** Boltzmann constant in kJ/(mol K). */
export const KB_KJMOL = 0.0083144626;

/** Boltzmann constant in each energy unit PLUMED takes, per kelvin. */
export const KB = Object.freeze({
  'kj/mol': KB_KJMOL,
  'kcal/mol': KB_KJMOL / 4.184,
  eV: KB_KJMOL / 96.48533212,
  Ha: KB_KJMOL / 2625.499639
});

/* ------------------------------------------------------------------ *
 * Files
 * ------------------------------------------------------------------ */

function constant(text) {
  const t = String(text).trim().toLowerCase();
  const m = /^([+-]?)(\d*\.?\d*)\*?pi$/.exec(t);
  if (m) return (m[1] === '-' ? -1 : 1) * (m[2] === '' ? 1 : Number(m[2])) * Math.PI;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse a COLVAR, HILLS or any other file in PLUMED's column format.
 *
 * A run that was restarted writes its header again; rows are kept as long as
 * they have as many columns as the first header names. Rows with a value that
 * is not a number are dropped and counted.
 *
 * A new part of the run starts where the header is written again, or where
 * the time goes back. When a job was stopped between two checkpoints, the
 * next part starts from the last checkpoint, so part of the file is written
 * twice. With `keepOverlap: false` the older copy is dropped (the rows of the
 * earlier part at or after the new part's first time), as
 * assets/plumed/analyse_plumed.py does by default; the default here keeps
 * every row, as this function always has. Rows that share a time are not a
 * new part: walkers that share one HILLS file write a hill each at the same
 * time.
 *
 * @param {string} text
 * @param {{keepOverlap?: boolean}} [options]
 * @returns {{fields:string[], columns:Object<string, Float64Array>, rows:number,
 *   sets:Object<string, string>, periods:Object<string, {min:number, max:number}>,
 *   skipped:number, headers:number, dropped:number, parts:number, starts:number[],
 *   cut:boolean, errors:string[]}} `starts` are the first rows of the parts,
 *   `dropped` the rows a later part wrote again, `cut` whether the last line
 *   was cut off mid-write (and left out).
 */
export function parseColvar(text, options = {}) {
  const keepOverlap = !(options && options.keepOverlap === false);
  const errors = [];
  const sets = {};
  let fields = [];
  let headers = 0;
  let skipped = 0;
  let dropped = 0;
  const data = [];
  const starts = [0];
  let newPart = false;
  let ti = -1;

  if (typeof text !== 'string' || !text.trim()) {
    return {
      fields, columns: {}, rows: 0, sets, periods: {}, skipped, headers, dropped, parts: 1, starts, cut: false,
      errors: ['The file is empty.']
    };
  }

  const lines = text.split(/\r\n|\r|\n/);
  // A last line with no newline after it may have been cut off mid-write.
  const unfinished = !/[\r\n]$/.test(text);
  let lastData = -1;
  lines.forEach((raw, i) => {
    const t = raw.trim();
    if (t && !t.startsWith('#') && !t.startsWith('@')) lastData = i;
  });
  let cut = false;

  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    if (line.startsWith('#!')) {
      const words = line.slice(2).trim().split(/\s+/);
      if (words[0] === 'FIELDS') {
        headers += 1;
        if (!fields.length) {
          fields = words.slice(1);
          ti = fields[0] === 'time' ? 0 : -1;
        } else {
          newPart = true;
        }
      } else if (words[0] === 'SET' && words.length >= 3) {
        sets[words[1]] = words.slice(2).join(' ');
      }
      return;
    }
    if (line.startsWith('#') || line.startsWith('@')) return;
    const parts = line.split(/\s+/);
    if (!fields.length) {
      // No header: name the columns by position.
      fields = parts.map((_, j) => (j === 0 ? 'time' : `col${j + 1}`));
      ti = 0;
      errors.push('The file has no "#! FIELDS" header, so the columns are named by position.');
    }
    const row = parts.length === fields.length ? parts.map(Number) : null;
    if (!row || row.some(v => !Number.isFinite(v))) {
      skipped += 1;
      // Cut off: too few columns, or a number that is not one ("1.5e");
      // "nan" and "inf" are numbers written as such, not a cut.
      const garbled = !row || parts.some((p, j) => Number.isNaN(row[j]) && !/^[+-]?(nan|inf|infinity)$/i.test(p));
      if (unfinished && i === lastData && garbled) cut = true;
      return;
    }
    if (ti >= 0 && data.length && (newPart || row[ti] < data[data.length - 1][ti])) {
      if (!keepOverlap) {
        while (data.length && data[data.length - 1][ti] >= row[ti]) {
          data.pop();
          dropped += 1;
        }
        while (starts.length > 1 && starts[starts.length - 1] > data.length) starts.pop();
      }
      if (starts[starts.length - 1] !== data.length) starts.push(data.length);
    }
    newPart = false;
    data.push(row);
  });
  if (dropped) {
    errors.push(`${dropped} row${dropped === 1 ? '' : 's'} written again by a later part of the run ` +
      `${dropped === 1 ? 'was' : 'were'} dropped (the older copy); the job was probably stopped between two checkpoints.`);
  }

  const columns = {};
  fields.forEach((f, j) => {
    const col = new Float64Array(data.length);
    for (let i = 0; i < data.length; i++) col[i] = data[i][j];
    columns[f] = col;
  });

  const periods = {};
  for (const f of fields) {
    const lo = sets[`min_${f}`];
    const hi = sets[`max_${f}`];
    if (lo === undefined || hi === undefined) continue;
    const a = constant(lo);
    const b = constant(hi);
    if (a !== null && b !== null && b > a) periods[f] = { min: a, max: b };
  }
  if (!data.length) errors.push('The file holds no rows of numbers.');
  if (skipped) {
    errors.push(`${skipped} row${skipped === 1 ? ' was' : 's were'} left out: wrong number of columns, or a value that is not a number.`);
  }
  if (cut) errors.push('The last line was cut off mid-write, as happens when a job is stopped; it was left out.');
  return {
    fields, columns, rows: data.length, sets, periods, skipped, headers, dropped, parts: starts.length, starts, cut, errors
  };
}

/**
 * Several files of the same columns as one run, in time order: the HILLS
 * files of multiple walkers, one per walker, whose hills all add to the one
 * surface. Rows at the same time keep the order of the files (a stable sort),
 * as analyse_plumed.py pools them. The sets and periods are the first file's.
 *
 * @param {Array<ReturnType<typeof parseColvar>>} files
 * @param {string[]} [names] - the files' names, joined for the result's `name`
 * @returns {ReturnType<typeof parseColvar>|null} null when the files do not
 *          have the same columns.
 */
export function poolRuns(files, names = []) {
  const list = (files || []).filter(Boolean);
  if (!list.length) return null;
  if (list.length === 1) return list[0];
  const fields = list[0].fields;
  if (list.some(c => c.fields.length !== fields.length || c.fields.some((f, j) => f !== fields[j]))) return null;
  const rows = [];
  for (const c of list) {
    for (let i = 0; i < c.rows; i++) rows.push(fields.map(f => c.columns[f][i]));
  }
  const ti = fields.indexOf('time');
  if (ti >= 0) rows.sort((a, b) => a[ti] - b[ti]);
  const columns = {};
  fields.forEach((f, j) => {
    const col = new Float64Array(rows.length);
    for (let i = 0; i < rows.length; i++) col[i] = rows[i][j];
    columns[f] = col;
  });
  const kernels = new Set(list.map(c => c.sets.kerneltype || ''));
  const errors = list[0].errors.slice();
  if (kernels.size > 1) {
    errors.push(`The files do not all use the same kernel type (${[...kernels].map(k => k || 'unstated').sort().join(', ')}); ` +
      "the first one's is used.");
  }
  return {
    ...list[0], columns, rows: rows.length, errors,
    name: names.length ? names.join(', ') : list[0].name, walkers: list.length
  };
}

/* The bias and its bookkeeping, not a variable to analyse. */
const BOOKKEEPING = /\.(bias|rbias|rct|work|force2|zed|neff|nker)$/;

/**
 * The columns of a COLVAR that are variables to analyse: all but the time
 * and the bias's own bookkeeping (bias, rbias, rct, work …).
 *
 * @param {{fields:string[]}} c
 * @returns {string[]}
 */
export function valueColumns(c) {
  return (c && c.fields ? c.fields : []).filter(f => f !== 'time' && !BOOKKEEPING.test(f));
}

/**
 * The bias column to reweight with: the first `*.rbias` (the bias less its
 * running offset), else the first `*.bias`; '' when there is none.
 *
 * @param {{fields:string[]}} c
 * @returns {string}
 */
export function biasColumn(c) {
  const f = c && c.fields ? c.fields : [];
  return f.find(x => /\.rbias$/.test(x)) || f.find(x => /\.bias$/.test(x)) || '';
}

/**
 * What kind of file the columns describe.
 *
 * @param {string[]} fields
 * @returns {'hills'|'colvar'}
 */
export function fileKind(fields) {
  const f = fields || [];
  return f.includes('height') && f.some(x => x.startsWith('sigma_')) ? 'hills' : 'colvar';
}

/**
 * The collective variables a HILLS file is about, in order.
 *
 * @param {string[]} fields
 * @returns {string[]}
 */
export function hillsVariables(fields) {
  const f = fields || [];
  return f.filter(x => f.includes(`sigma_${x}`));
}

/* ------------------------------------------------------------------ *
 * Statistics
 * ------------------------------------------------------------------ */

/**
 * Summary of a column. For a periodic variable the mean and the spread are
 * circular, so that values either side of the period's edge are neighbours.
 *
 * @param {ArrayLike<number>} values
 * @param {{min:number, max:number}} [period]
 * @returns {{n:number, min:number, max:number, mean:number, sd:number}}
 */
export function columnSummary(values, period) {
  const n = values ? values.length : 0;
  if (!n) return { n: 0, min: NaN, max: NaN, mean: NaN, sd: NaN };
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < n; i++) {
    if (values[i] < min) min = values[i];
    if (values[i] > max) max = values[i];
  }
  if (period) {
    const width = period.max - period.min;
    const k = (2 * Math.PI) / width;
    let c = 0;
    let s = 0;
    for (let i = 0; i < n; i++) {
      c += Math.cos(k * values[i]);
      s += Math.sin(k * values[i]);
    }
    const r = Math.min(1, Math.hypot(c, s) / n);
    let mean = Math.atan2(s, c) / k;
    while (mean < period.min) mean += width;
    while (mean >= period.max) mean -= width;
    // Circular standard deviation, which tends to the ordinary one when the
    // values are close together.
    const sd = r > 0 ? Math.sqrt(-2 * Math.log(r)) / k : width / Math.sqrt(12);
    return { n, min, max, mean, sd };
  }
  let sum = 0;
  for (let i = 0; i < n; i++) sum += values[i];
  const mean = sum / n;
  let ss = 0;
  for (let i = 0; i < n; i++) ss += (values[i] - mean) ** 2;
  return { n, min, max, mean, sd: n > 1 ? Math.sqrt(ss / (n - 1)) : 0 };
}

/**
 * Round to a number of significant figures.
 *
 * @param {number} value
 * @param {number} [figures]
 * @returns {number}
 */
export function roundSig(value, figures = 2) {
  if (!Number.isFinite(value) || value === 0) return value;
  const p = Math.pow(10, figures - 1 - Math.floor(Math.log10(Math.abs(value))));
  return Math.round(value * p) / p;
}

function tidy(value) {
  const r = roundSig(value, 3);
  return String(Number(r.toPrecision(3)));
}

/**
 * Hill width and grid for one collective variable, from an unbiased run.
 *
 * The width is half the standard deviation of the variable in the basin the
 * run sampled, the usual starting point: a hill much wider than the basin
 * smooths the surface away, and a much narrower one fills it slowly.
 *
 * The grid must hold every value the biased run will reach, which is more than
 * the unbiased run saw. The observed range is widened by its own width on each
 * side, and by at least ten hill widths. A periodic variable takes its period.
 *
 * @param {ArrayLike<number>} values
 * @param {{period?:{min:number, max:number}, nonNegative?:boolean,
 *   sigmaFraction?:number}} [options]
 * @returns {{sigma:string, min:string, max:string, bin:string, summary:object,
 *   notes:string[]}|null} Null when there are too few values.
 */
export function suggestBias(values, options = {}) {
  const { period = null, nonNegative = false, sigmaFraction = 0.5 } = options;
  const summary = columnSummary(values, period);
  const notes = [];
  if (summary.n < 10) return null;
  if (!(summary.sd > 0)) {
    return {
      sigma: '', min: '', max: '', bin: '', summary,
      notes: ['The variable does not change in this run, so no width can be taken from it.']
    };
  }

  const sigma = roundSig(summary.sd * sigmaFraction, 2);
  let min;
  let max;
  if (period) {
    min = period.min;
    max = period.max;
    notes.push('The variable is periodic, so the grid is its period.');
  } else {
    const range = summary.max - summary.min;
    const pad = Math.max(range, 10 * sigma);
    min = summary.min - pad;
    max = summary.max + pad;
    if (nonNegative && min < 0) {
      // Room for the tail of a hill placed at zero, and no more.
      min = -5 * sigma;
      notes.push('The variable cannot be negative, so the grid starts just below zero.');
    }
    min = roundSig(min, 2);
    max = roundSig(max, 2);
    notes.push(
      'The grid is wider than what this run sampled, since the bias will push the variable ' +
      'further. Widen it if the biased run stops with a value outside the grid.');
  }
  const bin = Math.ceil((max - min) / (sigma / 5));

  if (summary.n < 200) {
    notes.push(`Only ${summary.n} values: a longer run gives a steadier estimate of the fluctuation.`);
  }
  const written = (v, isPeriodEdge) => {
    if (isPeriodEdge && Math.abs(Math.abs(v) - Math.PI) < 1e-6) return v < 0 ? '-pi' : 'pi';
    return tidy(v);
  };
  return {
    sigma: tidy(sigma),
    min: written(min, !!period),
    max: written(max, !!period),
    bin: String(Math.min(bin, 5000)),
    summary,
    notes
  };
}

/**
 * Has a column drifted? Compares the means of the first and the last third.
 *
 * A variable still moving one way has not reached the basin it will
 * fluctuate in, and its spread overstates the fluctuation. A periodic
 * variable is compared with circular means, so that values either side of
 * the period's edge do not read as a drift.
 *
 * @param {ArrayLike<number>} values
 * @param {{min:number, max:number}} [period]
 * @returns {{drift:number, inSd:number, drifting:boolean}}
 */
export function driftOf(values, period) {
  const n = values ? values.length : 0;
  if (n < 30) return { drift: 0, inSd: 0, drifting: false };
  const third = Math.floor(n / 3);
  const slice = (a, b) => Array.prototype.slice.call(values, a, b);
  const first = columnSummary(slice(0, third), period);
  const last = columnSummary(slice(n - third, n), period);
  let drift = last.mean - first.mean;
  if (period) {
    const width = period.max - period.min;
    drift -= width * Math.round(drift / width);
  }
  const inSd = last.sd > 0 ? Math.abs(drift) / last.sd : 0;
  return { drift, inSd, drifting: inSd > 2 };
}

/* ------------------------------------------------------------------ *
 * Free energy from the hills
 * ------------------------------------------------------------------ */

/* PLUMED drops a hill where half the squared distance from its centre, in
   widths, passes 6.25, and since 2.8 stretches the Gaussian so that it reaches
   zero there (the file then says "kerneltype stretched-gaussian"). */
const DP2_CUTOFF = 6.25;

function axis(min, max, bins, periodic) {
  // A periodic axis leaves out its last point, which is its first again.
  const n = bins;
  const dx = (max - min) / (periodic ? n : n - 1);
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = min + i * dx;
  return { x, dx, n };
}

function rangeOf(hills, name, options) {
  const period = hills.periods[name];
  if (period) return { min: period.min, max: period.max, periodic: true };
  const col = hills.columns[name];
  const sig = hills.columns[`sigma_${name}`];
  let min = Infinity;
  let max = -Infinity;
  let smax = 0;
  for (let i = 0; i < col.length; i++) {
    if (col[i] < min) min = col[i];
    if (col[i] > max) max = col[i];
    if (sig[i] > smax) smax = sig[i];
  }
  const pad = 3 * smax;
  return {
    min: options.min !== undefined ? options.min : min - pad,
    max: options.max !== undefined ? options.max : max + pad,
    periodic: false
  };
}

/**
 * Sum the hills of a metadynamics run into a free-energy surface, in one or
 * two dimensions.
 *
 * Each hill is a Gaussian of the height and widths in its row, cut off and
 * stretched as PLUMED does, so the result is what `plumed sum_hills` gives.
 * The lowest point of the surface is set to zero.
 *
 * @param {ReturnType<typeof parseColvar>} hills - A parsed HILLS file.
 * @param {{variables?:string[], bins?:number|number[], upTo?:number,
 *   ranges?:Object<string,{min?:number, max?:number}>}} [options]
 *        `upTo` sums only the first so many hills, which is how the surface
 *        at an earlier time is obtained.
 * @returns {{variables:string[], x:Float64Array, y:Float64Array|null,
 *   f:Float64Array, shape:number[], hills:number, min:number, max:number,
 *   periodic:boolean[]}|null}
 */
export function sumHills(hills, options = {}) {
  const all = hillsVariables(hills.fields);
  const variables = (options.variables && options.variables.length ? options.variables : all)
    .filter(v => all.includes(v)).slice(0, 2);
  if (!variables.length || !hills.rows) return null;

  const h = hills.columns.height;
  const count = Math.min(hills.rows, options.upTo !== undefined ? Math.max(0, options.upTo) : hills.rows);
  const ranges = variables.map(v => rangeOf(hills, v, (options.ranges && options.ranges[v]) || {}));
  const dim = variables.length;
  const want = options.bins || (dim === 1 ? 300 : 120);
  const bins = Array.isArray(want) ? want : [want, want];
  const ax = ranges.map((r, k) => axis(r.min, r.max, bins[k], r.periodic));
  const cols = variables.map(v => hills.columns[v]);
  const sigs = variables.map(v => hills.columns[`sigma_${v}`]);
  const stretched = /stretched/i.test(String(hills.sets.kerneltype || ''));
  const floor = Math.exp(-DP2_CUTOFF);
  const stretch = stretched ? 1 / (1 - floor) : 1;
  const kernel = (dp2) => (dp2 < DP2_CUTOFF ? ((stretched ? Math.exp(-dp2) - floor : Math.exp(-dp2)) * stretch) : 0);

  // The bins a hill reaches along one axis, with (d/σ)²/2 on each.
  const reach = (k, centre, sigma) => {
    const a = ax[k];
    const r = ranges[k];
    const span = Math.ceil((Math.sqrt(2 * DP2_CUTOFF) * sigma) / a.dx);
    const at = Math.round((centre - r.min) / a.dx);
    const idx = [];
    const dp2 = [];
    const width = r.max - r.min;
    for (let j = at - span; j <= at + span; j++) {
      let i = j;
      if (r.periodic) i = ((j % a.n) + a.n) % a.n;
      else if (j < 0 || j >= a.n) continue;
      let d = r.min + j * a.dx - centre;
      if (r.periodic) d -= width * Math.round(d / width);
      idx.push(i);
      dp2.push((d * d) / (2 * sigma * sigma));
    }
    return { idx, dp2 };
  };

  const f = new Float64Array(dim === 1 ? ax[0].n : ax[0].n * ax[1].n);
  for (let i = 0; i < count; i++) {
    const height = h[i];
    const a = reach(0, cols[0][i], sigs[0][i]);
    if (dim === 1) {
      for (let p = 0; p < a.idx.length; p++) f[a.idx[p]] -= height * kernel(a.dp2[p]);
      continue;
    }
    const b = reach(1, cols[1][i], sigs[1][i]);
    for (let p = 0; p < a.idx.length; p++) {
      const row = a.idx[p] * ax[1].n;
      for (let q = 0; q < b.idx.length; q++) {
        f[row + b.idx[q]] -= height * kernel(a.dp2[p] + b.dp2[q]);
      }
    }
  }

  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < f.length; i++) if (f[i] < min) min = f[i];
  for (let i = 0; i < f.length; i++) {
    f[i] -= min;
    if (f[i] > max) max = f[i];
  }
  return {
    variables,
    x: ax[0].x,
    y: dim === 2 ? ax[1].x : null,
    f,
    shape: dim === 1 ? [ax[0].n] : [ax[0].n, ax[1].n],
    hills: count,
    min: 0,
    max: count ? max : 0,
    periodic: ranges.map(r => r.periodic)
  };
}

/**
 * The surface at several times through the run, to see whether it still
 * changes. One variable only.
 *
 * @param {ReturnType<typeof parseColvar>} hills
 * @param {{variable?:string, slices?:number, bins?:number}} [options]
 * @returns {Array<{time:number, hills:number, x:Float64Array, f:Float64Array}>}
 */
export function fesOverTime(hills, options = {}) {
  const { slices = 5, bins = 300 } = options;
  const all = hillsVariables(hills.fields);
  const variable = options.variable || all[0];
  if (!variable || !hills.rows) return [];
  const range = rangeOf(hills, variable, {});
  const time = hills.columns.time || null;
  const out = [];
  const n = Math.max(1, Math.min(slices, hills.rows));
  for (let k = 1; k <= n; k++) {
    const upTo = Math.round((hills.rows * k) / n);
    const s = sumHills(hills, {
      variables: [variable], bins, upTo,
      ranges: { [variable]: range.periodic ? {} : { min: range.min, max: range.max } }
    });
    out.push({ time: time ? time[upTo - 1] : upTo, hills: upTo, x: s.x, f: s.f });
  }
  return out;
}

/**
 * Free-energy difference between two regions of a one-dimensional surface:
 * -kT ln of the ratio of their populations.
 *
 * @param {ArrayLike<number>} x
 * @param {ArrayLike<number>} f
 * @param {{a:[number, number], b:[number, number], kT:number}} regions
 * @returns {number} F(b) - F(a), in the units of `f`; NaN when a region is
 *          empty.
 */
export function basinDifference(x, f, regions) {
  const { a, b, kT } = regions;
  if (!(kT > 0)) return NaN;
  let pa = 0;
  let pb = 0;
  for (let i = 0; i < x.length; i++) {
    const w = Math.exp(-f[i] / kT);
    if (x[i] >= a[0] && x[i] <= a[1]) pa += w;
    if (x[i] >= b[0] && x[i] <= b[1]) pb += w;
  }
  if (!(pa > 0) || !(pb > 0)) return NaN;
  return -kT * Math.log(pb / pa);
}

/**
 * Hill height through the run, thinned for plotting.
 *
 * In a well-tempered run the height falls as the bias grows where the system
 * is; a height that has stopped falling and sits well below its first value
 * says the basins in reach have been filled.
 *
 * @param {ReturnType<typeof parseColvar>} hills
 * @param {{points?:number}} [options]
 * @returns {{time:number[], height:number[], first:number, last:number,
 *   ratio:number, tempered:boolean, biasFactor:number|null}}
 */
export function hillHeights(hills, options = {}) {
  const { points = 400 } = options;
  const h = hills.columns.height;
  const t = hills.columns.time;
  if (!h || !h.length) {
    return { time: [], height: [], first: NaN, last: NaN, ratio: NaN, tempered: false, biasFactor: null };
  }
  const bf = hills.columns.biasf;
  const gamma = bf && bf.length ? bf[0] : null;
  const tempered = gamma !== null && gamma > 1;
  // Undo the γ/(γ-1) the file carries, to show the height that was deposited.
  const scale = tempered ? (gamma - 1) / gamma : 1;
  const block = Math.max(1, Math.floor(h.length / points));
  const time = [];
  const height = [];
  for (let i = 0; i < h.length; i += block) {
    let s = 0;
    let n = 0;
    for (let j = i; j < Math.min(h.length, i + block); j++) { s += h[j]; n += 1; }
    time.push(t ? t[Math.min(h.length - 1, i + Math.floor(n / 2))] : i);
    height.push((s / n) * scale);
  }
  const tail = Math.max(1, Math.floor(h.length / 10));
  let last = 0;
  for (let i = h.length - tail; i < h.length; i++) last += h[i];
  last = (last / tail) * scale;
  const first = h[0] * scale;
  return { time, height, first, last, ratio: first > 0 ? last / first : NaN, tempered, biasFactor: gamma };
}

/* ------------------------------------------------------------------ *
 * Reweighting
 * ------------------------------------------------------------------ */

/**
 * Free energy along any printed quantity, from a biased run.
 *
 * Each frame is weighted by exp(V/kT), where V is the bias it felt. With
 * `metad.rbias`, the bias less its running offset c(t), the weights are right
 * through the whole run [Tiwary and Parrinello, J. Phys. Chem. B 119, 736
 * (2015)]; with the plain `metad.bias` the early part, where the bias still
 * grows fast, should be left out with `skip`.
 *
 * @param {ArrayLike<number>} values - The quantity, one per frame.
 * @param {ArrayLike<number>} bias - The bias, one per frame, in energy units.
 * @param {{kT:number, bins?:number, skip?:number, min?:number, max?:number,
 *   period?:{min:number, max:number}}} options
 * @returns {{x:Float64Array, f:Float64Array, frames:number, effective:number}|null}
 *          `effective` is the Kish sample size, the number of equally weighted
 *          frames that would carry the same information.
 */
export function reweight(values, bias, options) {
  const { kT, bins = 100, skip = 0, period = null } = options || {};
  const n = Math.min(values ? values.length : 0, bias ? bias.length : 0);
  if (!(kT > 0) || n - skip < 2) return null;

  let vmax = -Infinity;
  for (let i = skip; i < n; i++) if (bias[i] > vmax) vmax = bias[i];
  let lo = options.min;
  let hi = options.max;
  if (period) { lo = period.min; hi = period.max; }
  if (lo === undefined || hi === undefined) {
    let a = Infinity;
    let b = -Infinity;
    for (let i = skip; i < n; i++) {
      if (values[i] < a) a = values[i];
      if (values[i] > b) b = values[i];
    }
    if (lo === undefined) lo = a;
    if (hi === undefined) hi = b;
  }
  if (!(hi > lo)) return null;

  const width = (hi - lo) / bins;
  const p = new Float64Array(bins);
  let sw = 0;
  let sw2 = 0;
  for (let i = skip; i < n; i++) {
    // Relative to the largest bias, so that the exponential cannot overflow.
    const w = Math.exp((bias[i] - vmax) / kT);
    let k = Math.floor((values[i] - lo) / width);
    if (k === bins && values[i] === hi) k = bins - 1;
    if (k < 0 || k >= bins) continue;
    p[k] += w;
    sw += w;
    sw2 += w * w;
  }
  const x = new Float64Array(bins);
  const f = new Float64Array(bins);
  let fmin = Infinity;
  for (let k = 0; k < bins; k++) {
    x[k] = lo + (k + 0.5) * width;
    f[k] = p[k] > 0 ? -kT * Math.log(p[k] / sw) : NaN;
    if (f[k] < fmin) fmin = f[k];
  }
  for (let k = 0; k < bins; k++) f[k] -= fmin;
  return { x, f, frames: n - skip, effective: sw2 > 0 ? (sw * sw) / sw2 : 0 };
}

/* ------------------------------------------------------------------ *
 * Small calculators
 * ------------------------------------------------------------------ */

/**
 * Thermal energy kT.
 *
 * @param {number} temperature - In kelvin.
 * @param {string} [unit] - 'kj/mol' | 'kcal/mol' | 'eV' | 'Ha'.
 * @returns {number}
 */
export function thermalEnergy(temperature, unit = 'kj/mol') {
  const k = KB[unit];
  if (!k || !(temperature > 0)) return NaN;
  return k * temperature;
}

/**
 * What a well-tempered run does to a barrier.
 *
 * With bias factor γ the bias converges to (1 - 1/γ) of the free energy, so a
 * barrier ΔF is left as ΔF/γ and the variable is sampled as if at the
 * temperature γT.
 *
 * @param {{barrier:number, biasFactor:number, temperature:number, unit?:string}} p
 * @returns {{kT:number, residual:number, residualInKT:number,
 *   effectiveTemperature:number, suggested:number}|null} `suggested` is the
 *          bias factor that leaves the barrier at 2 kT, never below 2.
 */
export function wellTempered(p) {
  const { barrier, biasFactor, temperature, unit = 'kj/mol' } = p || {};
  const kT = thermalEnergy(temperature, unit);
  if (!(kT > 0) || !(barrier > 0)) return null;
  const gamma = biasFactor > 1 ? biasFactor : NaN;
  const residual = barrier / gamma;
  return {
    kT,
    residual,
    residualInKT: residual / kT,
    effectiveTemperature: gamma * temperature,
    suggested: Math.max(2, Math.round(barrier / (2 * kT)))
  };
}

/**
 * How fast hills are laid down at the start of a run, and how long a basin of
 * a given depth takes to fill at that rate. The true time is longer in a
 * well-tempered run, where the height falls, and in more than one dimension.
 *
 * @param {{height:number, pace:number, timestep:number, depth?:number}} p -
 *        `timestep` in ps.
 * @returns {{perPs:number, hillsPerNs:number, fillNs:number|null}|null}
 */
export function depositionRate(p) {
  const { height, pace, timestep, depth } = p || {};
  if (!(height > 0) || !(pace > 0) || !(timestep > 0)) return null;
  const every = pace * timestep;
  return {
    perPs: height / every,
    hillsPerNs: 1000 / every,
    fillNs: depth > 0 ? (depth / (height / every)) / 1000 : null
  };
}
