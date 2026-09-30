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
 * surface (along fewer variables than the hills were laid on, the others are
 * integrated out at kT), their height over time shows whether the bias has
 * settled, and the printed biases, added up, reweight any other quantity.
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

/*
 * How many rows a new part starting at time t0 reaches back over that no
 * earlier part reached: the rows at the end of the file with a time at or
 * after t0, as far back as they go. Within a part the time never goes back
 * (where it does, a new part starts), so each part is searched by bisection,
 * and a file of many walkers joined together stays quick to read.
 */
function reachedBack(data, starts, covered, ti, t0) {
  const end = data.length;
  let from = end;
  for (let p = starts.length - 1; p >= 0; p--) {
    const a = starts[p];
    const b = p + 1 < starts.length ? starts[p + 1] : end;
    if (a >= b) continue;
    if (data[a][ti] >= t0) {
      from = a;
      continue;
    }
    let lo = a;
    let hi = b;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (data[mid][ti] >= t0) hi = mid;
      else lo = mid + 1;
    }
    from = lo;
    break;
  }
  let added = end - from;
  let merged = from;
  while (covered.length && covered[covered.length - 1][1] > from) {
    const [a, b] = covered.pop();
    added -= b - Math.max(a, from);
    merged = Math.min(merged, a);
  }
  if (end > merged) covered.push([merged, end]);
  return added;
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
 * next part starts from the last checkpoint, so part of a COLVAR is written
 * twice. With `keepOverlap: false` the older copy of such COLVAR rows is
 * dropped (the rows of the earlier part at or after the new part's first
 * time), as assets/plumed/analyse_plumed.py does by default; the default here
 * keeps every row, as this function always has. Rows that share a time are
 * not a new part: walkers that share one HILLS file write a hill each at the
 * same time.
 *
 * A HILLS file keeps every row whatever `keepOverlap` says. A restarted METAD
 * reads every hill in the file back, with no look at the time (MetaD.cpp,
 * readGaussians), so the hills an earlier part laid after the checkpoint stay
 * in the bias for the rest of the run, and `plumed sum_hills` sums them all;
 * they are not a copy of the later part's hills, which were laid on another
 * trajectory. The time also goes back where walkers' HILLS files were joined
 * into one (`cat HILLS.0 HILLS.1`), whose hills all count. Such rows are
 * counted in `overlap` and said, not dropped.
 *
 * @param {string} text
 * @param {{keepOverlap?: boolean}} [options]
 * @returns {{fields:string[], columns:Object<string, Float64Array>, rows:number,
 *   sets:Object<string, string>, periods:Object<string, {min:number, max:number,
 *   minText:string, maxText:string}>, skipped:number, headers:number,
 *   dropped:number, overlap:number, parts:number, starts:number[], cut:boolean,
 *   errors:string[]}} `starts` are the first rows of the parts, `dropped` the
 *   rows a later part wrote again, `overlap` the rows kept although a later
 *   part starts at or before their time, `cut` whether the last line was cut
 *   off mid-write (and left out). A period keeps the SET line's own words
 *   (`minText`, `maxText`: -pi, 2*pi, +0.5), which is how METAD wants a
 *   periodic grid written.
 */
export function parseColvar(text, options = {}) {
  const keepAsked = !(options && options.keepOverlap === false);
  const errors = [];
  const sets = {};
  let fields = [];
  let headers = 0;
  let skipped = 0;
  let dropped = 0;
  let overlap = 0;
  let hills = false;
  const data = [];
  // The stretches of kept rows that a later part starts at or before, merged,
  // so that a row two later parts reach is counted once.
  const covered = [];
  const starts = [0];
  let newPart = false;
  let ti = -1;

  if (typeof text !== 'string' || !text.trim()) {
    return {
      fields, columns: {}, rows: 0, sets, periods: {}, skipped, headers, dropped, overlap, parts: 1, starts, cut: false,
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
          hills = fileKind(fields) === 'hills';
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
      if (!keepAsked && !hills) {
        while (data.length && data[data.length - 1][ti] >= row[ti]) {
          data.pop();
          dropped += 1;
        }
        while (starts.length > 1 && starts[starts.length - 1] > data.length) starts.pop();
      } else {
        overlap += reachedBack(data, starts, covered, ti, row[ti]);
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
  if (hills && overlap) {
    errors.push(`${overlap} hill${overlap === 1 ? ' lies' : 's lie'} at or after the time where a later part of the ` +
      'file starts: a run continued from an earlier checkpoint, or walkers\' files joined into one. ' +
      `${overlap === 1 ? 'It is' : 'They are all'} kept, since a restarted METAD reads every hill in the file ` +
      'back into its bias, and plumed sum_hills sums them all.');
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
    if (a !== null && b !== null && b > a) periods[f] = { min: a, max: b, minText: lo, maxText: hi };
  }
  if (!data.length) errors.push('The file holds no rows of numbers.');
  if (skipped) {
    errors.push(`${skipped} row${skipped === 1 ? ' was' : 's were'} left out: wrong number of columns, or a value that is not a number.`);
  }
  if (cut) errors.push('The last line was cut off mid-write, as happens when a job is stopped; it was left out.');
  return {
    fields, columns, rows: data.length, sets, periods, skipped, headers, dropped, overlap, parts: starts.length, starts, cut, errors
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
 * running offset), else the first `*.bias`; '' when there is none. Whether a
 * COLVAR can be reweighted at all; the weights themselves need every bias the
 * run applied (biasColumns).
 *
 * @param {{fields:string[]}} c
 * @returns {string}
 */
export function biasColumn(c) {
  const f = c && c.fields ? c.fields : [];
  return f.find(x => /\.rbias$/.test(x)) || f.find(x => /\.bias$/.test(x)) || '';
}

/**
 * Every bias column of a COLVAR whose energy the run carried, to add up for
 * the weights of a reweighting: each `*.rbias` (a METAD's bias less its
 * running offset) in place of the same action's `*.bias`, and the `*.bias` of
 * every other action, such as the walls and restraints set next to the
 * metadynamics. A frame's weight is exp(ΣV/kT) over all of them, since the
 * run sampled with their sum; one column alone leaves a wall's push in the
 * surface.
 *
 * @param {{fields:string[]}} c
 * @returns {string[]} in the order of the file
 */
export function biasColumns(c) {
  const f = c && c.fields ? c.fields : [];
  const offset = new Set(f.filter(x => /\.rbias$/.test(x)).map(x => x.slice(0, -'.rbias'.length)));
  return f.filter(x => /\.rbias$/.test(x) || (/\.bias$/.test(x) && !offset.has(x.slice(0, -'.bias'.length))));
}

/**
 * The sum of some columns, row by row, in the order given: the total bias
 * of biasColumns.
 *
 * @param {{rows:number, columns:Object<string, ArrayLike<number>>}} c
 * @param {string[]} names
 * @returns {Float64Array}
 */
export function totalBias(c, names) {
  const out = new Float64Array(c && c.rows ? c.rows : 0);
  for (const name of names || []) {
    const col = c.columns[name];
    if (!col) continue;
    for (let i = 0; i < out.length; i++) out[i] += col[i];
  }
  return out;
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
 * The collective variables a HILLS file is about, in order. A run with
 * ADAPTIVE=DIFF or GEOM writes each hill's shape as a matrix
 * (`sigma_d_d`, `sigma_t_d`, `sigma_t_t`) rather than one width for each
 * variable.
 *
 * @param {string[]} fields
 * @returns {string[]}
 */
export function hillsVariables(fields) {
  const f = fields || [];
  return f.filter(x => f.includes(`sigma_${x}`) || f.includes(`sigma_${x}_${x}`));
}

/**
 * Whether the hills of a file are multivariate (ADAPTIVE=DIFF or GEOM): the
 * file says `#! SET multivariate true`, or has `sigma_x_x` columns instead of
 * `sigma_x`.
 *
 * @param {{fields:string[], sets?:Object<string,string>}} hills
 * @returns {boolean}
 */
export function hillsMultivariate(hills) {
  const f = (hills && hills.fields) || [];
  const said = String((hills && hills.sets && hills.sets.multivariate) || '').trim().toLowerCase();
  if (said === 'true') return true;
  if (said === 'false') return false;
  const vars = hillsVariables(f);
  return vars.length > 0 && vars.every(v => !f.includes(`sigma_${v}`));
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

/*
 * A grid bound rounded outwards, away from the values it must hold, on the
 * decade of the hill width: to 0.01 for a width of 0.033, to 1 for a width of
 * 3.3. Rounding to the nearest two significant figures could move a bound
 * inside the values seen when they are large beside their spread (a volume of
 * 101.5 ± 0.3 got a grid of 99 to 100, and METAD stopped at the first step).
 * The step is at most one hill width, so the grid grows by no more than that
 * on each side of a pad of at least ten; the 1e-9 keeps a bound that is
 * already round (1.1, not 1.11 from 110.00000000000001), and is far smaller
 * than the pad it could take from.
 */
function outward(value, sigma, up) {
  const e = Math.floor(Math.log10(sigma));
  const scale = 10 ** Math.abs(e);
  const v = e < 0 ? value * scale : value / scale;
  const k = up ? Math.ceil(v - 1e-9) : Math.floor(v + 1e-9);
  return e < 0 ? k / scale : k * scale;
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
 * side, and by at least ten hill widths, and rounded outwards. A variable that
 * cannot be negative starts five widths below zero instead, unless the run
 * saw it below zero (a component of a distance, say), when it is padded as any
 * other. A periodic variable takes its period, written as the COLVAR's SET
 * line writes it (`period.minText`, `period.maxText` from parseColvar): METAD
 * compares a periodic GRID_MIN and GRID_MAX with the variable's own domain as
 * text, and stops on 6.28 where it wants 2*pi.
 *
 * @param {ArrayLike<number>} values
 * @param {{period?:{min:number, max:number, minText?:string, maxText?:string},
 *   nonNegative?:boolean, sigmaFraction?:number}} [options]
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
  let minText;
  let maxText;
  if (period) {
    min = period.min;
    max = period.max;
    const edge = (v) => (Math.abs(Math.abs(v) - Math.PI) < 1e-6 ? (v < 0 ? '-pi' : 'pi') : tidy(v));
    minText = typeof period.minText === 'string' && period.minText ? period.minText : edge(min);
    maxText = typeof period.maxText === 'string' && period.maxText ? period.maxText : edge(max);
    notes.push('The variable is periodic, so the grid is its period.');
  } else {
    const range = summary.max - summary.min;
    const pad = Math.max(range, 10 * sigma);
    min = outward(summary.min - pad, sigma, false);
    max = outward(summary.max + pad, sigma, true);
    minText = String(min);
    maxText = String(max);
    if (nonNegative && summary.min >= 0 && min < 0) {
      // Room for the tail of a hill placed at zero, and no more.
      min = -5 * sigma;
      minText = tidy(min);
      notes.push('The variable cannot be negative, so the grid starts just below zero.');
    } else if (nonNegative && summary.min < 0) {
      notes.push('The run saw values below zero, so the grid is padded below as well as above.');
    }
    notes.push(
      'The grid is wider than what this run sampled, since the bias will push the variable ' +
      'further. Widen it if the biased run stops with a value outside the grid.');
  }
  const bin = Math.ceil((max - min) / (sigma / 5));

  if (summary.n < 200) {
    notes.push(`Only ${summary.n} values: a longer run gives a steadier estimate of the fluctuation.`);
  }
  return {
    sigma: tidy(sigma),
    min: minText,
    max: maxText,
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

/* A variable integrated out is summed over this many points, and fewer when
   the whole grid would pass INTEGRATE_POINTS (four or more variables). */
const INTEGRATE_BINS = 100;
const INTEGRATE_POINTS = 4000000;

function axis(min, max, bins, periodic) {
  // A periodic axis leaves out its last point, which is its first again.
  const n = bins;
  const dx = (max - min) / (periodic ? n : n - 1);
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = min + i * dx;
  return { x, dx, n };
}

/*
 * The lower triangle L of a multivariate hill, which PLUMED writes as
 * sigma_<a>_<b> for the variables a, b in the METAD's order (a after b, or
 * a = b): the hill's covariance is L Lᵀ (MetaD.cpp, writeGaussian).
 */
function covarianceOf(hills, names, i) {
  const n = names.length;
  const L = names.map(() => new Array(n).fill(0));
  for (let r = 0; r < n; r++) {
    for (let c = 0; c <= r; c++) {
      const col = hills.columns[`sigma_${names[r]}_${names[c]}`];
      L[r][c] = col ? col[i] : 0;
    }
  }
  return names.map((_, r) => names.map((__, c) => {
    let v = 0;
    for (let k = 0; k < n; k++) v += L[r][k] * L[c][k];
    return v;
  }));
}

/* The inverse of a small symmetric matrix, by Gauss-Jordan elimination. */
function invert(a) {
  const n = a.length;
  const m = a.map((row, i) => [...row, ...row.map((_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
    [m[c], m[p]] = [m[p], m[c]];
    const d = m[c][c];
    for (let j = 0; j < 2 * n; j++) m[c][j] /= d;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const k = m[r][c];
      for (let j = 0; j < 2 * n; j++) m[r][j] -= k * m[c][j];
    }
  }
  return m.map(row => row.slice(n));
}

/* The largest eigenvalue of a small symmetric matrix and its eigenvector, by
   Jacobi rotations; of equal ones, the first. */
function largestEigen(a) {
  const n = a.length;
  const m = a.map(row => row.slice());
  const v = a.map((_, i) => a.map((__, j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += m[p][q] * m[p][q];
    if (off < 1e-30) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        if (m[p][q] === 0) continue;
        const theta = (m[q][q] - m[p][p]) / (2 * m[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const mkp = m[k][p];
          const mkq = m[k][q];
          m[k][p] = c * mkp - s * mkq;
          m[k][q] = s * mkp + c * mkq;
        }
        for (let k = 0; k < n; k++) {
          const mpk = m[p][k];
          const mqk = m[q][k];
          m[p][k] = c * mpk - s * mqk;
          m[q][k] = s * mpk + c * mqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k][p];
          const vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  let best = 0;
  for (let i = 1; i < n; i++) if (m[i][i] > m[best][best]) best = i;
  return { value: m[best][best], vector: v.map(row => row[best]) };
}

/*
 * The width of each hill along one variable: its sigma, or for a
 * multivariate hill the square root of its variance along that variable.
 */
function widthsOf(hills, name) {
  const plain = hills.columns[`sigma_${name}`];
  if (plain) return plain;
  const names = hillsVariables(hills.fields);
  const r = names.indexOf(name);
  const out = new Float64Array(hills.rows);
  for (let c = 0; c <= r; c++) {
    const col = hills.columns[`sigma_${name}_${names[c]}`];
    if (!col) continue;
    for (let i = 0; i < out.length; i++) out[i] += col[i] * col[i];
  }
  for (let i = 0; i < out.length; i++) out[i] = Math.sqrt(out[i]);
  return out;
}

function rangeOf(hills, name, options) {
  const period = hills.periods[name];
  if (period) return { min: period.min, max: period.max, periodic: true };
  const col = hills.columns[name];
  const sig = widthsOf(hills, name);
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

/*
 * The shape of a hill, as PLUMED 2.11's sum_hills reads it
 * (KernelFunctions::read): stretched and cut where dp2 reaches 6.25, unless
 * the file says "kerneltype gaussian". A file with no kerneltype, from PLUMED
 * 2.7 or older, is read as stretched as well; the run that wrote it applied
 * the plain Gaussian, cut at the same place, which differs by about 0.2%. A
 * plain Gaussian has no cut of its own in sum_hills: it is added wherever its
 * window reaches.
 */
function kernelOf(hills) {
  const type = String((hills.sets && hills.sets.kerneltype) || '').trim().toLowerCase();
  if (type === 'gaussian' || type === 'truncated-gaussian') return (dp2) => Math.exp(-dp2);
  const floor = Math.exp(-DP2_CUTOFF);
  const stretch = 1 / (1 - floor);
  return (dp2) => (dp2 < DP2_CUTOFF ? (Math.exp(-dp2) - floor) * stretch : 0);
}

/*
 * The grid points a hill reaches along one axis, and their distance from its
 * centre. The window is `span` points either side of the point at or below
 * the centre, as PLUMED places it (Grid::getNeighbors, from
 * floor((x - min)/dx)). On a periodic axis the window wraps, and a hill wider
 * than about half the period reaches some points twice, as it does in
 * sum_hills and in a METAD with a grid.
 */
function reach(a, r, centre, span) {
  const idx = [];
  const d = [];
  const at = Math.floor((centre - r.min) / a.dx);
  const width = r.max - r.min;
  for (let j = at - span; j <= at + span; j++) {
    let i = j;
    if (r.periodic) i = ((j % a.n) + a.n) % a.n;
    else if (j < 0 || j >= a.n) continue;
    let dd = r.min + j * a.dx - centre;
    if (r.periodic) dd -= width * Math.round(dd / width);
    idx.push(i);
    d.push(dd);
  }
  return { idx, d };
}

/*
 * The hills summed onto a grid over `order` (the kept variables, then the
 * ones to integrate out), as their negative sum: f = -Σ h K. The first
 * variable runs slowest. A copy is taken after each count of hills in
 * `marks` (ascending), so the surface at several times costs one pass.
 */
function accumulate(hills, grid, marks) {
  const { order, ax, rg } = grid;
  const dim = order.length;
  const strides = new Array(dim).fill(1);
  for (let k = dim - 2; k >= 0; k--) strides[k] = strides[k + 1] * ax[k + 1].n;
  const size = strides[0] * ax[0].n;
  const f = new Float64Array(size);
  const out = [];
  const h = hills.columns.height;
  const kernel = kernelOf(hills);
  const multi = hillsMultivariate(hills);
  const fileOrder = hillsVariables(hills.fields);
  const cols = order.map(v => hills.columns[v]);
  const sigs = multi ? null : order.map(v => hills.columns[`sigma_${v}`]);
  const cut = Math.sqrt(2 * DP2_CUTOFF);
  const last = marks.length ? marks[marks.length - 1] : 0;
  let next = 0;
  const mark = (done) => {
    while (next < marks.length && marks[next] <= done) {
      out.push(f.slice());
      next += 1;
    }
  };
  mark(0);

  for (let i = 0; i < last; i++) {
    const height = h[i];
    const wins = [];
    if (!multi) {
      for (let k = 0; k < dim; k++) {
        const sigma = sigs[k][i];
        const span = Math.ceil((cut * sigma) / ax[k].dx);
        const w = reach(ax[k], rg[k], cols[k][i], span);
        const dp2 = new Float64Array(w.d.length);
        for (let p = 0; p < dp2.length; p++) dp2[p] = (w.d[p] * w.d[p]) / (2 * sigma * sigma);
        w.dp2 = dp2;
        wins.push(w);
      }
      // One and two variables, the usual cases, in plain loops; more by
      // recursion. The sum of the dp2 is taken in the same order either way.
      if (dim === 1) {
        const a = wins[0];
        for (let p = 0; p < a.idx.length; p++) f[a.idx[p]] -= height * kernel(a.dp2[p]);
      } else if (dim === 2) {
        const [a, b] = wins;
        for (let p = 0; p < a.idx.length; p++) {
          const row = a.idx[p] * strides[0];
          const da = a.dp2[p];
          for (let q = 0; q < b.idx.length; q++) f[row + b.idx[q]] -= height * kernel(da + b.dp2[q]);
        }
      } else {
        const add = (k, base, partial) => {
          const w = wins[k];
          const end = k === dim - 1;
          for (let p = 0; p < w.idx.length; p++) {
            const at = base + w.idx[p] * strides[k];
            const dp2 = partial + w.dp2[p];
            if (end) f[at] -= height * kernel(dp2);
            else add(k + 1, at, dp2);
          }
        };
        add(0, 0, 0);
      }
    } else {
      // The covariance in the grid's order, its inverse (the metric), and a
      // window from its longest axis, as PLUMED sizes it
      // (KernelFunctions::getContinuousSupport), which can be narrower than
      // the hill along a variable when the hill is tilted.
      const cov = covarianceOf(hills, fileOrder, i);
      const pos = order.map(v => fileOrder.indexOf(v));
      const c = pos.map(a => pos.map(b => cov[a][b]));
      const metric = invert(c);
      const e = largestEigen(c);
      for (let k = 0; k < dim; k++) {
        const extent = Math.abs(Math.sqrt(e.value) * e.vector[k]);
        wins.push(reach(ax[k], rg[k], cols[k][i], Math.ceil((cut * extent) / ax[k].dx)));
      }
      const ds = new Array(dim).fill(0);
      const add = (k, base) => {
        const w = wins[k];
        for (let p = 0; p < w.idx.length; p++) {
          ds[k] = w.d[p];
          const at = base + w.idx[p] * strides[k];
          if (k < dim - 1) {
            add(k + 1, at);
            continue;
          }
          let r2 = 0;
          for (let a = 0; a < dim; a++) for (let b = 0; b < dim; b++) r2 += metric[a][b] * ds[a] * ds[b];
          f[at] -= height * kernel(0.5 * r2);
        }
      };
      add(0, 0);
    }
    mark(i + 1);
  }
  return { snapshots: out, size };
}

/*
 * F over the kept variables with the others integrated out, from the
 * negative sum f on the full grid, the kept variables first:
 * F = -kT ln Σ exp(-f/kT) over each block of `block` points, as
 * `plumed sum_hills --idw <kept> --kt <kT>` does (Grid::project with
 * BiasWeight). Relative to the largest term, so that nothing overflows.
 */
function project(f, block, kT) {
  const n = f.length / block;
  const out = new Float64Array(n);
  for (let p = 0; p < n; p++) {
    const base = p * block;
    let m = -Infinity;
    for (let q = 0; q < block; q++) {
      const u = -f[base + q] / kT;
      if (u > m) m = u;
    }
    let s = 0;
    for (let q = 0; q < block; q++) s += Math.exp(-f[base + q] / kT - m);
    out[p] = -kT * (m + Math.log(s));
  }
  return out;
}

/*
 * The surface after each count of hills in `marks`, on one grid; what
 * sumHills and fesOverTime share. Null when there is nothing to sum, or when
 * variables would have to be integrated out and no kT is given.
 */
function surfaces(hills, options, marks) {
  const all = hillsVariables(hills.fields);
  const asked = options.variables && options.variables.length ? options.variables : all;
  const variables = asked.filter((v, k) => all.includes(v) && asked.indexOf(v) === k).slice(0, 2);
  if (!variables.length || !hills.rows || !hills.columns.height) return null;
  const rest = all.filter(v => !variables.includes(v));
  const kT = Number(options.kT);
  if (rest.length && !(kT > 0)) return null;

  const dim = variables.length;
  const want = options.bins || (dim === 1 ? 300 : 120);
  const bins = Array.isArray(want) ? want : [want, want];
  const kept = variables.map((_, k) => bins[k]);
  const keptSize = kept.reduce((m, n) => m * n, 1);
  let other = Math.max(2, Math.round(Number(options.integrateBins) || INTEGRATE_BINS));
  while (other > 10 && keptSize * other ** rest.length > INTEGRATE_POINTS) other -= 1;

  const order = [...variables, ...rest];
  const counts = [...kept, ...rest.map(() => other)];
  const rg = order.map(v => rangeOf(hills, v, (options.ranges && options.ranges[v]) || {}));
  const ax = rg.map((r, k) => axis(r.min, r.max, counts[k], r.periodic));
  const { snapshots, size } = accumulate(hills, { order, ax, rg }, marks);
  const block = size / keptSize;

  return snapshots.map((raw, k) => {
    const count = marks[k];
    const f = rest.length ? project(raw, block, kT) : raw;
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
      periodic: rg.slice(0, dim).map(r => r.periodic),
      integrated: rest,
      integratedBins: rest.map(() => other),
      kT: rest.length ? kT : null
    };
  });
}

/**
 * Sum the hills of a metadynamics run into a free-energy surface, in one or
 * two dimensions.
 *
 * Each hill is a Gaussian of the height and widths in its row, cut off and
 * stretched as PLUMED does and placed on the grid as PLUMED places it, so the
 * result is what `plumed sum_hills` gives. Multivariate hills (ADAPTIVE=DIFF
 * or GEOM) are summed with their full covariance.
 *
 * When the file has more variables than are asked for, the others are
 * integrated out at the thermal energy `kT`: F(d) = -kT ln ∫ exp(-F(d,t)/kT) dt,
 * summed over INTEGRATE_BINS points of each, as
 * `plumed sum_hills --idw d --kt <kT>` does. Summing the hills along d alone
 * would not be a free energy: a hill counts in full whatever its t. Without
 * `kT` such a surface is not made (null), as PLUMED refuses it without --kt.
 *
 * The lowest point of the surface is set to zero.
 *
 * @param {ReturnType<typeof parseColvar>} hills - A parsed HILLS file.
 * @param {{variables?:string[], bins?:number|number[], upTo?:number, kT?:number,
 *   integrateBins?:number, ranges?:Object<string,{min?:number, max?:number}>}} [options]
 *        `upTo` sums only the first so many hills, which is how the surface
 *        at an earlier time is obtained. `ranges` may name the variables
 *        integrated out too.
 * @returns {{variables:string[], x:Float64Array, y:Float64Array|null,
 *   f:Float64Array, shape:number[], hills:number, min:number, max:number,
 *   periodic:boolean[], integrated:string[], integratedBins:number[],
 *   kT:number|null}|null} `integrated` names the variables integrated out.
 */
export function sumHills(hills, options = {}) {
  if (!hills || !hills.rows) return null;
  const count = Math.min(hills.rows, options.upTo !== undefined ? Math.max(0, options.upTo) : hills.rows);
  const out = surfaces(hills, options, [count]);
  return out ? out[0] : null;
}

/**
 * The surface at several times through the run, to see whether it still
 * changes. One variable only; the others of a HILLS file over several are
 * integrated out at `kT`, as in sumHills (and without `kT` there are none).
 *
 * @param {ReturnType<typeof parseColvar>} hills
 * @param {{variable?:string, slices?:number, bins?:number, kT?:number,
 *   integrateBins?:number, ranges?:Object<string,{min?:number, max?:number}>}} [options]
 *   `ranges` as in sumHills (analyse_plumed.py's --min and --max).
 * @returns {Array<{time:number, hills:number, x:Float64Array, f:Float64Array,
 *   integrated:string[]}>}
 */
export function fesOverTime(hills, options = {}) {
  const { slices = 5, bins = 300 } = options;
  const all = hillsVariables(hills.fields);
  const variable = options.variable || all[0];
  if (!variable || !hills.rows) return [];
  const time = hills.columns.time || null;
  const n = Math.max(1, Math.min(slices, hills.rows));
  const marks = [];
  for (let k = 1; k <= n; k++) marks.push(Math.round((hills.rows * k) / n));
  // Every slice on the same axis, taken from all the hills.
  const out = surfaces(hills, {
    variables: [variable], bins, kT: options.kT, integrateBins: options.integrateBins, ranges: options.ranges
  }, marks);
  if (!out) return [];
  return out.map((s, k) => ({
    time: time ? time[marks[k] - 1] : marks[k], hills: marks[k], x: s.x, f: s.f, integrated: s.integrated
  }));
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
