/**
 * @module core/plumed-analysis-figures
 *
 * The figures of the "Analyse a run" view of the MD Workflow Generator, and
 * the Python that makes each of them from the person's own files.
 *
 * Each figure is a description for the shared figure component (figure.js,
 * drawn by js/figure-plot.js and written as matplotlib by figure-python.js):
 *
 *   series       the printed values through the run, a panel for each
 *   histogram    how often each value of one of them was seen
 *   reweight     the free energy along one of them, reweighted with the bias
 *   fes          the free-energy surface from the hills, along one variable
 *                or over two (a heatmap with contour lines and a colour bar)
 *   convergence  the surface along one variable at several times
 *   heights      the height of the hills through the run
 *
 * The numbers come from plumed-analysis.js. The script computes them again
 * from COLVAR and HILLS with the functions of assets/plumed/analyse_plumed.py
 * (copied here word for word, and checked against that file by the tests),
 * which do what plumed-analysis.js does: the files are read the same way
 * (PLUMED's "#! FIELDS" header, comments, restarted runs with the older copy
 * of rewritten rows dropped, several walkers' HILLS files summed together),
 * the hills are summed as `plumed sum_hills` sums them, and the reweighting
 * and histograms are the page's. Every data field of a figure names the Python
 * expression that holds it ({ values, py }), so the script reads the files and
 * draws what it computed; with the data in the script instead, the numbers
 * the page computed are written into it (stripRefs).
 */

import {
  KB, hillsVariables, sumHills, fesOverTime, hillHeights, reweight, thermalEnergy, valueColumns, biasColumn
} from './plumed-analysis.js';
import { figureScript, identifier, pyStr, pyNum, comment } from './figure-python.js';

/** Energy units as they are written on an axis. */
export const ENERGY_LABELS = Object.freeze({ 'kj/mol': 'kJ/mol', 'kcal/mol': 'kcal/mol', eV: 'eV', Ha: 'Hartree' });

/** The figures, in the order the view offers them, and what each needs. */
export const ANALYSIS_FIGURES = Object.freeze([
  { id: 'series', label: 'Time series', title: 'Values through the run', needs: 'colvar' },
  { id: 'histogram', label: 'Histogram', title: 'Histogram', needs: 'colvar' },
  { id: 'reweight', label: 'Reweighted', title: 'Free energy, reweighted', needs: 'bias' },
  { id: 'fes', label: 'Free energy', title: 'Free-energy surface', needs: 'hills' },
  { id: 'convergence', label: 'Convergence', title: 'The surface through the run', needs: 'hills' },
  { id: 'heights', label: 'Hill heights', title: 'Hill height through the run', needs: 'hills' }
]);

/** Largest number of panels in the time series (figure.js draws up to 8). */
export const MAX_PANELS = 8;
/**
 * With the data in the script, a line longer than this is written thinned:
 * enough for four points a pixel across a 6.4 in figure at 300 dpi.
 */
export const EMBED_POINTS = 8000;
/**
 * The time series drawn on the page: a longer run is thinned to about this
 * many points a value, the lowest and highest of each stretch (decimate), so
 * that restyling stays quick; the preview draws no more than four points a
 * pixel anyway, and the script reads and draws every row.
 */
export const PREVIEW_POINTS = 20000;

/** The colours of the surface at later and later times: one hue, faint to strong. */
const RAMP_FROM = [100, 148, 194];
const RAMP_TO = [20, 62, 105];

/** How a number is written in a label or a note: three significant figures. */
export function fmt(v, digits = 3) {
  return Number.isFinite(v) ? String(Number(v.toPrecision(digits))) : '–';
}

const hex = (c) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

/** n colours from faint to strong, for surfaces summed to later and later times. */
export function rampColours(n) {
  return Array.from({ length: n }, (_, i) => {
    const k = n === 1 ? 1 : i / (n - 1);
    return hex(RAMP_FROM.map((a, j) => a + (RAMP_TO[j] - a) * k));
  });
}

/**
 * The figures a run can show.
 *
 * @param {{colvar?: object|null, hills?: object|null}} run
 * @returns {string[]} ids of ANALYSIS_FIGURES
 */
export function availableFigures(run) {
  const c = run && run.colvar;
  const h = run && run.hills;
  return ANALYSIS_FIGURES.filter((f) => {
    if (f.needs === 'colvar') return !!(c && c.rows && c.fields.some((x) => x !== 'time'));
    if (f.needs === 'bias') return !!(c && c.rows && biasColumn(c) && valueColumns(c).length);
    return !!(h && h.rows && hillsVariables(h.fields).length);
  }).map((f) => f.id);
}

/**
 * A long line thinned for drawing: in each stretch of the run, the lowest and
 * the highest point, in order, and the first and last points and the
 * extremes of x, so that the line looks the same and has the same limits.
 *
 * @param {ArrayLike<number>} x
 * @param {ArrayLike<number>} y
 * @param {number} [max] - about this many points at most
 * @returns {{x: number[], y: number[], thinned: boolean}}
 */
export function decimate(x, y, max = EMBED_POINTS) {
  const n = Math.min(x.length, y.length);
  if (n <= max) return { x: Array.from(x).slice(0, n), y: Array.from(y).slice(0, n), thinned: false };
  const keep = new Uint8Array(n);
  let xLo = 0;
  let xHi = 0;
  for (let i = 1; i < n; i++) {
    if (x[i] < x[xLo]) xLo = i;
    if (x[i] > x[xHi]) xHi = i;
  }
  keep[0] = 1; keep[n - 1] = 1; keep[xLo] = 1; keep[xHi] = 1;
  const buckets = Math.max(1, Math.floor((max - 4) / 2));
  for (let b = 0; b < buckets; b++) {
    const a = Math.floor((b * n) / buckets);
    const e = Math.floor(((b + 1) * n) / buckets);
    let lo = a;
    let hi = a;
    for (let i = a + 1; i < e; i++) {
      if (y[i] < y[lo]) lo = i;
      if (y[i] > y[hi]) hi = i;
    }
    keep[lo] = 1; keep[hi] = 1;
  }
  const ox = [];
  const oy = [];
  for (let i = 0; i < n; i++) if (keep[i]) { ox.push(x[i]); oy.push(y[i]); }
  return { x: ox, y: oy, thinned: true };
}

/* ------------------------------------------------------------------ *
 * The Python of analyse_plumed.py
 * ------------------------------------------------------------------ */

/**
 * The functions of assets/plumed/analyse_plumed.py the scripts use, word for
 * word (tests/plumed-analysis-figures.test.js checks them against the file).
 */
export const PYTHON_FUNCTIONS = Object.freeze({
  js_round: "def js_round(x):\n    \"\"\"Math.round: to the nearest integer, halves upwards.\"\"\"\n    return math.floor(x + 0.5)",
  constant: "def constant(text):\n    \"\"\"A number as PLUMED writes it in a SET line: 1.5, -pi, 2*pi.\"\"\"\n    t = str(text).strip().lower()\n    m = re.match(r'^([+-]?)(\\d*\\.?\\d*)\\*?pi$', t)\n    if m:\n        return (-1 if m.group(1) == '-' else 1) * (float(m.group(2)) if m.group(2) else 1.0) * math.pi\n    try:\n        n = float(t)\n    except ValueError:\n        return None\n    return n if math.isfinite(n) else None",
  read_text: "def read_text(path):\n    opener = gzip.open if path.endswith('.gz') else open\n    with opener(path, 'rt', encoding='utf-8', errors='replace') as fh:\n        return fh.read()",
  parse_colvar: "def parse_colvar(text, keep_overlap=False, name=''):\n    \"\"\"Parse a COLVAR, HILLS or any other file in PLUMED's column format.\n\n    Rows are kept as long as they have as many columns as the first header\n    names; a row with a value that is not a number is dropped and counted.\n\n    A new part of the run starts where the header is written again, or where\n    the time goes back. There the rows of the older part at or after the new\n    part's first time are dropped, since the new part writes them again. Rows\n    that share a time are not a new part: walkers that share one HILLS file\n    write a hill each at the same time.\n    \"\"\"\n    errors = []\n    sets = {}\n    fields = []\n    headers = 0\n    skipped = 0\n    dropped = 0\n    rows = []\n    starts = [0]\n    new_part = False\n    ti = None\n\n    if not isinstance(text, str) or not text.strip():\n        return finish_parse(name, fields, [], sets, 0, 0, 0, ['The file is empty.'], [0], False)\n\n    lines = re.split(r'\\r\\n|\\r|\\n', text)\n    cut = not text.endswith(('\\n', '\\r'))\n    last_data = -1\n    for i, raw in enumerate(lines):\n        if raw.strip() and not raw.strip().startswith(('#', '@')):\n            last_data = i\n    cut_skipped = False\n\n    for i, raw in enumerate(lines):\n        line = raw.strip()\n        if not line:\n            continue\n        if line.startswith('#!'):\n            words = line[2:].split()\n            if words and words[0] == 'FIELDS':\n                headers += 1\n                if not fields:\n                    fields = words[1:]\n                    ti = 0 if fields and fields[0] == 'time' else None\n                else:\n                    new_part = True\n            elif words and words[0] == 'SET' and len(words) >= 3:\n                sets[words[1]] = ' '.join(words[2:])\n            continue\n        if line.startswith(('#', '@')):\n            continue\n        parts = line.split()\n        if not fields:\n            # No header: name the columns by position.\n            fields = ['time' if j == 0 else 'col%d' % (j + 1) for j in range(len(parts))]\n            ti = 0\n            errors.append('The file has no \"#! FIELDS\" header, so the columns are named by position.')\n        if len(parts) != len(fields):\n            skipped += 1\n            if cut and i == last_data:\n                cut_skipped = True\n            continue\n        try:\n            row = [float(p) for p in parts]\n        except ValueError:\n            skipped += 1\n            if cut and i == last_data:\n                cut_skipped = True\n            continue\n        if not all(math.isfinite(v) for v in row):\n            skipped += 1\n            continue\n        if ti is not None and rows and (new_part or row[ti] < rows[-1][ti]):\n            if not keep_overlap:\n                while rows and rows[-1][ti] >= row[ti]:\n                    rows.pop()\n                    dropped += 1\n                while len(starts) > 1 and starts[-1] > len(rows):\n                    starts.pop()\n            if starts[-1] != len(rows):\n                starts.append(len(rows))\n        new_part = False\n        rows.append(row)\n\n    if dropped:\n        errors.append(\n            '%d row%s written again by a later part of the run %s dropped (the older copy); '\n            'the job was probably stopped between two checkpoints.'\n            % (dropped, '' if dropped == 1 else 's', 'was' if dropped == 1 else 'were'))\n    return finish_parse(name, fields, rows, sets, skipped, headers, dropped, errors, starts, cut_skipped)",
  finish_parse: "def finish_parse(name, fields, rows, sets, skipped, headers, dropped, errors, starts, cut_skipped):\n    data = np.array(rows, dtype=float) if rows else np.zeros((0, len(fields)))\n    columns = {f: data[:, j].copy() for j, f in enumerate(fields)}\n    periods = {}\n    for f in fields:\n        lo = sets.get('min_' + f)\n        hi = sets.get('max_' + f)\n        if lo is None or hi is None:\n            continue\n        a = constant(lo)\n        b = constant(hi)\n        if a is not None and b is not None and b > a:\n            periods[f] = {'min': a, 'max': b}\n    if fields and not rows and not errors:\n        errors.append('The file holds no rows of numbers.')\n    if skipped:\n        errors.append('%d row%s left out: wrong number of columns, or a value that is not a number.'\n                      % (skipped, ' was' if skipped == 1 else 's were'))\n    if cut_skipped:\n        errors.append('The last line was cut off mid-write, as happens when a job is stopped; it was left out.')\n    return {\n        'name': name, 'fields': fields, 'columns': columns, 'rows': len(rows), 'sets': sets,\n        'periods': periods, 'skipped': skipped, 'headers': headers, 'dropped': dropped,\n        'parts': len(starts), 'starts': starts, 'errors': errors, 'cut': cut_skipped,\n    }",
  warn: "def warn(text):\n    sys.stderr.write('warning: %s\\n' % text)",
  fail: "def fail(text):\n    sys.stderr.write('error: %s\\n' % text)\n    sys.exit(1)",
  pool: "def pool(files):\n    \"\"\"Several files of the same columns as one, in time order (walkers).\"\"\"\n    if len(files) == 1:\n        return files[0]\n    fields = files[0]['fields']\n    for c in files[1:]:\n        if c['fields'] != fields:\n            fail('%s has the columns %s, but %s has %s; they cannot be taken together.'\n                 % (c['name'], ' '.join(c['fields']), files[0]['name'], ' '.join(fields)))\n    data = np.vstack([np.column_stack([c['columns'][f] for f in fields]) for c in files])\n    if 'time' in fields:\n        data = data[np.argsort(data[:, fields.index('time')], kind='stable')]\n    merged = dict(files[0])\n    merged['columns'] = {f: data[:, j].copy() for j, f in enumerate(fields)}\n    merged['rows'] = data.shape[0]\n    merged['name'] = ', '.join(c['name'] for c in files)\n    kernels = {c['sets'].get('kerneltype', '') for c in files}\n    if len(kernels) > 1:\n        warn('The files do not all use the same kernel type (%s); the first one\\'s is used.'\n             % ', '.join(sorted(k or 'unstated' for k in kernels)))\n    return merged",
  hills_variables: "def hills_variables(fields):\n    f = fields or []\n    return [x for x in f if 'sigma_' + x in f]",
  seq_sum: "def seq_sum(a):\n    \"\"\"A sum in order, as the page's loop adds, so the digits agree.\"\"\"\n    return float(np.cumsum(a)[-1]) if len(a) else 0.0",
  axis: "def axis(lo, hi, bins, periodic):\n    # A periodic axis leaves out its last point, which is its first again.\n    dx = (hi - lo) / (bins if periodic else bins - 1)\n    return {'x': lo + np.arange(bins) * dx, 'dx': dx, 'n': bins}",
  range_of: "def range_of(hills, name, lo=None, hi=None):\n    period = hills['periods'].get(name)\n    if period:\n        return {'min': period['min'], 'max': period['max'], 'periodic': True}\n    col = hills['columns'][name]\n    pad = 3 * float(hills['columns']['sigma_' + name].max())\n    return {'min': float(col.min()) - pad if lo is None else lo,\n            'max': float(col.max()) + pad if hi is None else hi,\n            'periodic': False}",
  sum_hills: "def sum_hills(hills, variables=None, bins=None, up_to=None, ranges=None):\n    \"\"\"Sum the hills into a free-energy surface in one or two dimensions, as\n    `plumed sum_hills` does: each hill a Gaussian of the height and widths in\n    its row, cut off and stretched as PLUMED does. The lowest point is zero.\n    `up_to` sums only the first so many hills.\"\"\"\n    every = hills_variables(hills['fields'])\n    chosen = [v for v in (variables or every) if v in every][:2]\n    if not chosen or not hills['rows']:\n        return None\n    ranges = ranges or {}\n    height = hills['columns']['height']\n    count = hills['rows'] if up_to is None else min(hills['rows'], max(0, up_to))\n    rg = [range_of(hills, v, *ranges.get(v, (None, None))) for v in chosen]\n    dim = len(chosen)\n    want = bins or (300 if dim == 1 else 120)\n    nb = list(want) if isinstance(want, (list, tuple)) else [want, want]\n    ax = [axis(r['min'], r['max'], nb[k], r['periodic']) for k, r in enumerate(rg)]\n    cols = [hills['columns'][v] for v in chosen]\n    sigs = [hills['columns']['sigma_' + v] for v in chosen]\n    stretched = 'stretched' in str(hills['sets'].get('kerneltype', '')).lower()\n    floor = math.exp(-DP2_CUTOFF)\n    stretch = 1 / (1 - floor) if stretched else 1.0\n\n    def kernel(dp2):\n        g = np.exp(-dp2)\n        if stretched:\n            g = (g - floor) * stretch\n        return np.where(dp2 < DP2_CUTOFF, g, 0.0)\n\n    def reach(k, centre, sigma):\n        \"\"\"The bins a hill reaches along one axis, with (d/sigma)^2/2 on each.\"\"\"\n        a = ax[k]\n        r = rg[k]\n        span = math.ceil((math.sqrt(2 * DP2_CUTOFF) * sigma) / a['dx'])\n        at = js_round((centre - r['min']) / a['dx'])\n        j = np.arange(at - span, at + span + 1)\n        width = r['max'] - r['min']\n        if r['periodic']:\n            idx = j % a['n']\n        else:\n            keep = (j >= 0) & (j < a['n'])\n            j = j[keep]\n            idx = j\n        d = r['min'] + j * a['dx'] - centre\n        if r['periodic']:\n            d = d - width * np.floor(d / width + 0.5)\n        unique = not r['periodic'] or 2 * span + 1 <= a['n']\n        return idx, (d * d) / (2 * sigma * sigma), unique\n\n    f = np.zeros(ax[0]['n'] if dim == 1 else (ax[0]['n'], ax[1]['n']))\n    for i in range(count):\n        ia, da, ua = reach(0, cols[0][i], sigs[0][i])\n        if dim == 1:\n            w = height[i] * kernel(da)\n            if ua:\n                f[ia] -= w\n            else:\n                np.subtract.at(f, ia, w)\n            continue\n        ib, db, ub = reach(1, cols[1][i], sigs[1][i])\n        w = height[i] * kernel(da[:, None] + db[None, :])\n        if ua and ub:\n            f[np.ix_(ia, ib)] -= w\n        else:\n            np.subtract.at(f, (ia[:, None], ib[None, :]), w)\n\n    f = f - f.min()\n    return {'variables': chosen, 'x': ax[0]['x'], 'y': ax[1]['x'] if dim == 2 else None, 'f': f,\n            'hills': count, 'max': float(f.max()) if count else 0.0,\n            'periodic': [r['periodic'] for r in rg], 'ranges': rg}",
  fes_over_time: "def fes_over_time(hills, variable=None, slices=5, bins=300, lo=None, hi=None):\n    \"\"\"The surface of one variable at several times through the run, all on\n    the same axis, to see whether it still changes.\"\"\"\n    every = hills_variables(hills['fields'])\n    variable = variable or (every[0] if every else None)\n    if not variable or not hills['rows']:\n        return []\n    r = range_of(hills, variable, lo, hi)\n    time = hills['columns'].get('time')\n    out = []\n    n = max(1, min(slices, hills['rows']))\n    for k in range(1, n + 1):\n        up_to = js_round(hills['rows'] * k / n)\n        s = sum_hills(hills, [variable], bins, up_to,\n                      {} if r['periodic'] else {variable: (r['min'], r['max'])})\n        out.append({'time': float(time[up_to - 1]) if time is not None else up_to,\n                    'hills': up_to, 'x': s['x'], 'f': s['f']})\n    return out",
  hill_heights: "def hill_heights(hills, points=400):\n    \"\"\"Hill height through the run, thinned for plotting, with the factor\n    gamma/(gamma-1) a well-tempered file carries taken off again.\"\"\"\n    h = hills['columns'].get('height')\n    t = hills['columns'].get('time')\n    if h is None or not h.size:\n        return {'time': [], 'height': [], 'first': math.nan, 'last': math.nan, 'ratio': math.nan,\n                'tempered': False, 'biasFactor': None}\n    bf = hills['columns'].get('biasf')\n    gamma = float(bf[0]) if bf is not None and bf.size else None\n    tempered = gamma is not None and gamma > 1\n    scale = (gamma - 1) / gamma if tempered else 1.0\n    n = h.size\n    block = max(1, n // points)\n    times = []\n    heights = []\n    for i in range(0, n, block):\n        chunk = h[i:min(n, i + block)]\n        times.append(float(t[min(n - 1, i + chunk.size // 2)]) if t is not None else i)\n        heights.append(seq_sum(chunk) / chunk.size * scale)\n    tail = max(1, n // 10)\n    last = seq_sum(h[n - tail:]) / tail * scale\n    first = float(h[0]) * scale\n    return {'time': times, 'height': heights, 'first': first, 'last': last,\n            'ratio': last / first if first > 0 else math.nan, 'tempered': tempered, 'biasFactor': gamma}",
  reweight: "def reweight(values, bias, kT, bins=100, skip=0, lo=None, hi=None, period=None):\n    \"\"\"Free energy along any printed quantity, from a biased run: each frame\n    weighted by exp(V/kT), relative to the largest V so that nothing\n    overflows. Returns the Kish effective sample size too.\"\"\"\n    values = np.asarray(values, dtype=float)\n    bias = np.asarray(bias, dtype=float)\n    n = min(values.size, bias.size)\n    if not kT > 0 or n - skip < 2:\n        return None\n    v = values[skip:n]\n    b = bias[skip:n]\n    vmax = float(b.max())\n    if period:\n        lo, hi = period['min'], period['max']\n    if lo is None:\n        lo = float(v.min())\n    if hi is None:\n        hi = float(v.max())\n    if not hi > lo:\n        return None\n    width = (hi - lo) / bins\n    w = np.exp((b - vmax) / kT)\n    k = np.floor((v - lo) / width).astype(np.int64)\n    k[(k == bins) & (v == hi)] = bins - 1\n    inside = (k >= 0) & (k < bins)\n    p = np.zeros(bins)\n    np.add.at(p, k[inside], w[inside])\n    sw = seq_sum(w[inside])\n    sw2 = seq_sum(w[inside] ** 2)\n    x = lo + (np.arange(bins) + 0.5) * width\n    with np.errstate(divide='ignore', invalid='ignore'):\n        f = np.where(p > 0, -kT * np.log(p / sw), np.nan)\n    if np.isfinite(f).any():\n        f = f - np.nanmin(f)\n    return {'x': x, 'f': f, 'frames': n - skip, 'effective': sw * sw / sw2 if sw2 > 0 else 0.0}"
});

/* Which functions each one calls. */
const PY_NEEDS = {
  parse_colvar: ['constant', 'finish_parse'],
  finish_parse: ['constant'],
  constant: [],
  pool: ['warn', 'fail'],
  sum_hills: ['hills_variables', 'axis', 'range_of', 'js_round'],
  fes_over_time: ['hills_variables', 'range_of', 'sum_hills', 'js_round'],
  hill_heights: ['seq_sum'],
  reweight: ['seq_sum']
};

/* The names the prelude defines at the top level, which a column's name must not take. */
const PRELUDE_NAMES = ['KB_KJMOL', 'KB', 'DP2_CUTOFF', 'TEMPERATURE', 'ENERGY', 'kT', 'COLVAR_FILE', 'HILLS_FILES',
  'colvar', 'hills', 'note', 'path', 'fes', 'fes_z', 'rw', 'slices', 'heights', 'low', 'change', 'skip', 'row',
  'gzip', 'math', 're', 'sys'];

/** The imports the functions need, after the figure's own. */
export const PYTHON_IMPORTS = Object.freeze(['import gzip', 'import math', 'import re', 'import sys']);

function functionLines(wanted) {
  const all = new Set();
  const add = (name) => {
    if (all.has(name)) return;
    all.add(name);
    (PY_NEEDS[name] || []).forEach(add);
  };
  wanted.forEach(add);
  const lines = [];
  for (const name of Object.keys(PYTHON_FUNCTIONS)) {
    if (!all.has(name)) continue;
    lines.push(...PYTHON_FUNCTIONS[name].split('\n'), '', '');
  }
  return lines;
}

/*
 * The prelude: the functions, the files, then what the figure computes.
 * `reads` is 'colvar' or 'hills'; `body` the lines that compute.
 */
function prelude({ run, reads, functions, constants = [], body }) {
  const L = ['# The analysis: the functions of analyse_plumed.py (STEMKit), which do what',
    "# the page does, so the numbers below are the page's.",
    ''];
  if (constants.length) L.push(...constants, '', '');
  L.push(...functionLines(['read_text', 'parse_colvar', ...(reads === 'hills' ? ['pool'] : []), ...functions]));
  if (reads === 'colvar') {
    const file = run.colvarFile || 'COLVAR';
    L.push('# Your run: point this at your file; it is read from the folder the script runs in.');
    L.push(`COLVAR_FILE = ${pyStr(file)}`);
    L.push('colvar = parse_colvar(read_text(COLVAR_FILE), name=COLVAR_FILE)');
    L.push("for note in colvar['errors']:");
    L.push("    print('%s: %s' % (COLVAR_FILE, note))");
  } else {
    const files = run.hillsFiles && run.hillsFiles.length ? run.hillsFiles : ['HILLS'];
    L.push('# Your run: point this at your HILLS file, or at one file per walker, whose');
    L.push('# hills are summed together. They are read from the folder the script runs in.');
    L.push(`HILLS_FILES = [${files.map(pyStr).join(', ')}]`);
    L.push('hills = pool([parse_colvar(read_text(path), name=path) for path in HILLS_FILES])');
    L.push("for note in hills['errors']:");
    L.push("    print('%s: %s' % (hills['name'], note))");
  }
  L.push('');
  L.push(...body);
  return L;
}

const TEMPERATURE_LINES = (o) => [
  `TEMPERATURE = ${pyNum(o.temperature)}  # K`,
  `ENERGY = ${pyStr(o.energy)}  # the energy unit of the run: kj/mol, kcal/mol, eV or Ha`,
  'kT = KB[ENERGY] * TEMPERATURE'
];

const KB_LINES = [
  '# Boltzmann constant in kJ/(mol K), and in each energy unit PLUMED takes.',
  'KB_KJMOL = 0.0083144626',
  'KB = {',
  "    'kj/mol': KB_KJMOL,",
  "    'kcal/mol': KB_KJMOL / 4.184,",
  "    'eV': KB_KJMOL / 96.48533212,",
  "    'Ha': KB_KJMOL / 2625.499639,",
  '}'
];

const CUTOFF_LINES = [
  '# PLUMED drops a hill where half the squared distance from its centre, in',
  '# widths, passes 6.25, and since 2.8 stretches the Gaussian so that it reaches',
  '# zero there (the file then says "kerneltype stretched-gaussian").',
  'DP2_CUTOFF = 6.25'
];

/* ------------------------------------------------------------------ *
 * Options
 * ------------------------------------------------------------------ */

function options(run, opts = {}) {
  const c = run.colvar || null;
  const h = run.hills || null;
  const values = c ? valueColumns(c) : [];
  const others = c ? c.fields.filter((f) => f !== 'time') : [];
  const vars = h ? hillsVariables(h.fields) : [];
  const energy = Object.hasOwn(KB, opts.energy) ? opts.energy : 'kj/mol';
  const temperature = opts.temperature > 0 ? Number(opts.temperature) : 300;
  let columns = Array.isArray(opts.columns) ? opts.columns.filter((x) => others.includes(x)) : [];
  if (!columns.length) {
    columns = values.slice(0, 3);
    const bias = c ? biasColumn(c) : '';
    if (bias) columns.push(bias);
    if (!columns.length) columns = others.slice(0, 1);
  }
  const column = values.includes(opts.column) ? opts.column : (values[0] || others[0] || '');
  const along = Array.isArray(opts.along) && opts.along.length && opts.along.every((v) => vars.includes(v))
    ? opts.along.slice(0, 2) : vars.slice(0, 2);
  const int = (v, lo, hi, d) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Math.min(hi, Math.max(lo, Math.round(Number(v)))) : d);
  return {
    energy, temperature, unit: ENERGY_LABELS[energy], kT: thermalEnergy(temperature, energy),
    timeUnit: typeof opts.timeUnit === 'string' && opts.timeUnit ? opts.timeUnit : 'ps',
    columns: columns.slice(0, MAX_PANELS), column,
    bins: int(opts.bins, 5, 500, 50),
    reweightBins: int(opts.reweightBins, 5, 500, 60),
    along,
    variable: vars.includes(opts.variable) ? opts.variable : (vars[0] || ''),
    slices: int(opts.slices, 2, 10, 5),
    contours: opts.contours !== false,
    values, vars
  };
}

/* ------------------------------------------------------------------ *
 * The figures
 * ------------------------------------------------------------------ */

/**
 * One figure of the view: its description, the Python that computes its
 * numbers from the files, and the numbers themselves.
 *
 * @param {string} id - one of ANALYSIS_FIGURES
 * @param {{colvar?: object|null, colvarFile?: string, hills?: object|null, hillsFiles?: string[]}} run -
 *   files parsed with parseColvar (several walkers' HILLS pooled with poolRuns), and their names
 * @param {{temperature?: number, energy?: string, timeUnit?: string, columns?: string[], column?: string,
 *   bins?: number, reweightBins?: number, along?: string[], variable?: string, slices?: number,
 *   contours?: boolean}} [opts]
 * @returns {{id: string, styleKey: string, labelKey: string, panelKeys: string[], title: string,
 *   figure: object, python: {header: string[], imports: string[], prelude: string[], reads: string[]},
 *   result: object, options: object}|null} `styleKey` names the look kept for the
 *   figure, `labelKey` what its labels depend on, `panelKeys` what each panel shows
 */
export function analysisFigure(id, run, opts = {}) {
  if (!run || !availableFigures(run).includes(id)) return null;
  const o = options(run, opts);
  const make = { series, histogram, reweight: reweighted, fes, convergence, heights }[id];
  const out = make(run, o);
  if (!out) return null;
  const meta = ANALYSIS_FIGURES.find((f) => f.id === id);
  return { id, title: out.title || meta.title, options: o, ...out };
}

function taken() {
  return new Set([...PRELUDE_NAMES, ...Object.keys(PYTHON_FUNCTIONS)]);
}

/* Python names for columns of the COLVAR: `d = colvar['columns']['d']`. */
function columnNames(cols, names) {
  const lines = [];
  const map = {};
  for (const col of cols) {
    if (map[col]) continue;
    map[col] = identifier(col === 'time' ? 'time' : col, names);
    lines.push(`${map[col]} = colvar['columns'][${pyStr(col)}]`);
  }
  return { lines, map };
}

function series(run, o) {
  const c = run.colvar;
  const names = taken();
  const hasTime = !!c.columns.time;
  const cols = o.columns;
  const { lines: body, map } = columnNames(hasTime ? ['time', ...cols] : cols, names);
  const xName = hasTime ? map.time : 'row';
  if (!hasTime) body.unshift('row = np.arange(colvar[\'rows\'])');
  const x = hasTime ? c.columns.time : Float64Array.from({ length: c.rows }, (_, i) => i);
  const n = cols.length;
  const lines = cols.map((col) => decimate(x, c.columns[col], PREVIEW_POINTS));
  const thinned = lines.some((l) => l.thinned);
  // Ids keep only letters, digits, _ and -, as they always have, so that a
  // look saved for a panel's line still applies.
  const ids = new Set();
  const idOf = (col) => {
    let id = `trace-${col.replace(/[^\w-]+/g, '_')}`;
    while (ids.has(id)) id += '_';
    ids.add(id);
    return id;
  };
  const figure = {
    width: 6.4,
    height: Math.max(3.2, Math.min(9.6, Math.round((1.2 + 1.7 * n) * 10) / 10)),
    xLabel: hasTime ? `Time (${o.timeUnit})` : 'Row',
    legend: { show: false },
    export: { filename: 'colvar' },
    panels: cols.map((col, k) => ({
      id: map[col], name: col, yLabel: col,
      series: [{
        id: idOf(col), kind: 'line', lineWidth: 1, label: col, legend: false,
        x: { values: lines[k].x, py: xName },
        y: { values: lines[k].y, py: map[col] }
      }]
    }))
  };
  return {
    styleKey: 'series', labelKey: '', panelKeys: cols, figure,
    python: {
      header: [`The values of ${run.colvarFile || 'COLVAR'} through the run, from STEMKit (https://stemkit.net)`],
      imports: PYTHON_IMPORTS.slice(),
      prelude: prelude({ run, reads: 'colvar', functions: [], body }),
      reads: [run.colvarFile || 'COLVAR'],
      thinned
    },
    result: { rows: c.rows, columns: cols, thinned, drawn: lines.reduce((m, l) => Math.max(m, l.x.length), 0) }
  };
}

function histogram(run, o) {
  const c = run.colvar;
  const col = o.column;
  const names = taken();
  const { lines, map } = columnNames([col], names);
  const values = Array.from(c.columns[col]);
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) { if (v < lo) lo = v; if (v > hi) hi = v; }
  const figure = {
    width: 6.4, height: 4, xLabel: col,
    legend: { show: false },
    export: { filename: `histogram_${col}` },
    panels: [{
      id: 'count', yLabel: 'Frames',
      series: [{ id: 'hist', kind: 'histogram', label: col, legend: false, bins: o.bins, values: { values, py: map[col] } }]
    }]
  };
  return {
    styleKey: 'histogram', labelKey: col, panelKeys: [col], figure, title: `Histogram of ${col}`,
    python: {
      header: [`How often each value of ${col} was seen, from STEMKit (https://stemkit.net)`],
      imports: PYTHON_IMPORTS.slice(),
      prelude: prelude({ run, reads: 'colvar', functions: [], body: lines }),
      reads: [run.colvarFile || 'COLVAR']
    },
    result: { column: col, n: values.length, bins: o.bins, width: (hi - lo) / o.bins, min: lo, max: hi }
  };
}

function reweighted(run, o) {
  const c = run.colvar;
  const col = o.column;
  const bias = biasColumn(c);
  const rbias = /\.rbias$/.test(bias);
  const skip = Math.floor(c.rows * (rbias ? 0 : 0.2));
  const period = c.periods[col] || null;
  const r = reweight(c.columns[col], c.columns[bias], { kT: o.kT, bins: o.reweightBins, skip, period: period || undefined });
  if (!r) return null;
  const body = [
    ...TEMPERATURE_LINES(o),
    '',
    rbias
      ? `# ${comment(bias)} is the bias less its running offset, so every frame counts.`
      : `# The first fifth of the run is left out, since ${comment(bias)} still grows there.`,
    rbias ? 'skip = 0' : "skip = int(math.floor(colvar['rows'] * 0.2))",
    `# Each frame weighted by exp(V/kT), in ${o.reweightBins} bins${period ? ' over the period' : ''}.`,
    `rw = reweight(colvar['columns'][${pyStr(col)}], colvar['columns'][${pyStr(bias)}], kT, ${o.reweightBins}, skip, None, None,`,
    `              colvar['periods'].get(${pyStr(col)}))`,
    "print('%d frames carry the weight of %d equally weighted ones.' % (rw['frames'], js_round(rw['effective'])))"
  ];
  const figure = {
    width: 6.4, height: 4, xLabel: col,
    legend: { show: false },
    export: { filename: `fes_reweighted_${col}` },
    panels: [{
      id: 'fes', yLabel: `Free energy (${o.unit})`,
      series: [{
        id: 'reweighted', kind: 'line', label: col, legend: false, marker: 'o', size: 3.5, lineWidth: 1.5,
        x: { values: Array.from(r.x), py: "rw['x']" },
        y: { values: Array.from(r.f), py: "rw['f']" }
      }]
    }]
  };
  return {
    styleKey: 'reweight', labelKey: col, panelKeys: [`${col}|${o.energy}`], figure, title: `Free energy along ${col}, reweighted`,
    python: {
      header: [`The free energy along ${col}, reweighted with ${bias}, from STEMKit (https://stemkit.net)`],
      imports: PYTHON_IMPORTS.slice(),
      prelude: prelude({ run, reads: 'colvar', functions: ['reweight', 'js_round'], constants: KB_LINES, body }),
      reads: [run.colvarFile || 'COLVAR']
    },
    result: { ...r, bias, skip, kT: o.kT, column: col }
  };
}

function fes(run, o) {
  const h = run.hills;
  const two = o.along.length === 2;
  const hillsNames = run.hillsFiles && run.hillsFiles.length ? run.hillsFiles : ['HILLS'];
  const python = (body, head) => ({
    header: [head],
    imports: PYTHON_IMPORTS.slice(),
    prelude: prelude({ run, reads: 'hills', functions: ['sum_hills'], constants: CUTOFF_LINES, body }),
    reads: hillsNames
  });
  if (two) {
    const s = sumHills(h, { variables: o.along, bins: 100 });
    const [a, b] = s.variables;
    const rows = [];
    for (let j = 0; j < s.shape[1]; j++) {
      const row = new Array(s.shape[0]);
      for (let i = 0; i < s.shape[0]; i++) row[i] = s.f[i * s.shape[1] + j];
      rows.push(row);
    }
    const x = { values: Array.from(s.x), py: "fes['x']" };
    const y = { values: Array.from(s.y), py: "fes['y']" };
    const z = { values: rows, py: 'fes_z' };
    const body = [
      '# The negative sum of the hills on a 100 x 100 grid, its lowest point at zero.',
      `fes = sum_hills(hills, [${pyStr(a)}, ${pyStr(b)}], [100, 100])`,
      `# matplotlib draws z[j, i] at (x[i], y[j]): rows along ${comment(b)}.`,
      "fes_z = fes['f'].T",
      "print('%d hills summed; the surface reaches %.4g above its lowest point.' % (fes['hills'], fes['max']))"
    ];
    const figure = {
      width: 6.4, height: 4.8, xLabel: a, colormap: 'cividis',
      legend: { show: false },
      export: { filename: 'fes' },
      panels: [{
        id: 'fes', yLabel: b,
        series: [
          { id: 'fes-map', kind: 'heatmap', x, y, z, colorbar: { label: `Free energy (${o.unit})` } },
          { id: 'fes-lines', kind: 'contour', x, y, z, levels: 10, colors: '#ffffff', lineWidth: 0.5, alpha: 0.6, show: o.contours }
        ]
      }]
    };
    return {
      styleKey: 'fes-2d', labelKey: `${a},${b}|${o.energy}`, panelKeys: [`${a},${b}`], figure, title: `Free-energy surface over ${a} and ${b}`,
      python: python(body, `The free-energy surface over ${a} and ${b}, summed from the hills, from STEMKit (https://stemkit.net)`),
      result: s
    };
  }
  const v = o.along[0];
  const s = sumHills(h, { variables: [v], bins: 300 });
  const body = [
    '# The negative sum of the hills at 300 points, its lowest point at zero.',
    `fes = sum_hills(hills, [${pyStr(v)}], 300)`,
    "print('%d hills summed; the surface reaches %.4g above its lowest point.' % (fes['hills'], fes['max']))"
  ];
  const figure = {
    width: 6.4, height: 4, xLabel: v,
    legend: { show: false },
    export: { filename: 'fes' },
    panels: [{
      id: 'fes', yLabel: `Free energy (${o.unit})`,
      series: [{
        id: 'fes', kind: 'line', label: v, legend: false, lineWidth: 2,
        x: { values: Array.from(s.x), py: "fes['x']" },
        y: { values: Array.from(s.f), py: "fes['f']" }
      }]
    }]
  };
  return {
    styleKey: 'fes-1d', labelKey: `${v}|${o.energy}`, panelKeys: [`${v}|${o.energy}`], figure, title: `Free energy along ${v}`,
    python: python(body, `The free energy along ${v}, summed from the hills, from STEMKit (https://stemkit.net)`),
    result: s
  };
}

function convergence(run, o) {
  const h = run.hills;
  const v = o.variable;
  const slices = fesOverTime(h, { variable: v, slices: o.slices, bins: 300 });
  if (!slices.length) return null;
  const colours = rampColours(slices.length);
  const last = slices.length - 1;
  let change = null;
  if (slices.length >= 2) {
    // Where the surface is low enough to be sampled, below 16 kT.
    const low = 16 * o.kT;
    change = 0;
    for (let i = 0; i < slices[last].f.length; i++) {
      if (slices[last].f[i] < low) change = Math.max(change, Math.abs(slices[last].f[i] - slices[last - 1].f[i]));
    }
  }
  const part = slices.length === 5 ? 'fifth' : `1/${slices.length}`;
  const body = [
    ...TEMPERATURE_LINES(o),
    '',
    `# The hills summed up to ${slices.length} times through the run, all on the same axis.`,
    `slices = fes_over_time(hills, ${pyStr(v)}, ${slices.length}, 300)`
  ];
  if (slices.length >= 2) {
    body.push(
      '# How far the surface moved over the last part of the run, where it is below 16 kT.',
      "low = slices[-1]['f'] < 16 * kT",
      "change = float(np.abs(slices[-1]['f'][low] - slices[-2]['f'][low]).max()) if low.any() else 0.0",
      `print(${pyStr(`Over the last ${part} of the run the surface moved by at most %.3g ${o.unit}.`)} % change)`);
  }
  const figure = {
    width: 6.4, height: 4.4, xLabel: v,
    legend: { title: 'Hills summed', position: 'best' },
    export: { filename: 'fes_convergence' },
    panels: [{
      id: 'fes', yLabel: `Free energy (${o.unit})`,
      series: slices.map((s, k) => ({
        id: `slice-${k + 1}`, kind: 'line', label: `to ${fmt(s.time, 4)}`, color: colours[k], lineWidth: k === last ? 2.5 : 1.5,
        x: { values: Array.from(s.x), py: `slices[${k}]['x']` },
        y: { values: Array.from(s.f), py: `slices[${k}]['f']` }
      }))
    }]
  };
  return {
    styleKey: 'convergence', labelKey: `${v}|${o.energy}`, panelKeys: [`${v}|${o.energy}`], figure,
    title: `The surface along ${v} through the run`,
    python: {
      header: [`The free energy along ${v} at ${slices.length} times through the run, from STEMKit (https://stemkit.net)`],
      imports: PYTHON_IMPORTS.slice(),
      prelude: prelude({ run, reads: 'hills', functions: ['fes_over_time'], constants: [...KB_LINES, '', ...CUTOFF_LINES], body }),
      reads: run.hillsFiles && run.hillsFiles.length ? run.hillsFiles : ['HILLS']
    },
    result: { slices, change, part }
  };
}

function heights(run, o) {
  const h = run.hills;
  const r = hillHeights(h);
  const body = [
    '# The height of the hills in blocks of the run, as deposited: a well-tempered',
    '# file carries each height times gamma/(gamma - 1), taken off again here.',
    'heights = hill_heights(hills)',
    "if heights['tempered']:",
    "    print('The hills are at %d%% of their first height.' % js_round(heights['ratio'] * 100))"
  ];
  const figure = {
    width: 6.4, height: 3.6, xLabel: h.columns.time ? `Time (${o.timeUnit})` : 'Hill',
    legend: { show: false },
    export: { filename: 'hill_heights' },
    panels: [{
      id: 'height', yLabel: `Hill height (${o.unit})`,
      series: [{
        id: 'height', kind: 'line', label: 'Height', legend: false, lineWidth: 1.5,
        x: { values: r.time.slice(), py: "heights['time']" },
        y: { values: r.height.slice(), py: "heights['height']" }
      }]
    }]
  };
  return {
    styleKey: 'heights', labelKey: `|${o.energy}`, panelKeys: [o.energy], figure,
    python: {
      header: ['The height of the hills through the run, from STEMKit (https://stemkit.net)'],
      imports: PYTHON_IMPORTS.slice(),
      prelude: prelude({ run, reads: 'hills', functions: ['hill_heights', 'js_round'], body }),
      reads: run.hillsFiles && run.hillsFiles.length ? run.hillsFiles : ['HILLS']
    },
    result: r
  };
}

/* ------------------------------------------------------------------ *
 * Scripts
 * ------------------------------------------------------------------ */

/**
 * A figure with the numbers the page computed in place of the Python that
 * computes them: every data field embedded. A line longer than EMBED_POINTS
 * is thinned (decimate), and a histogram of more values than that is written
 * as its counts, so that the script stays a script.
 *
 * @param {object} figure - a description, normalised or not
 * @returns {{figure: object, thinned: boolean}}
 */
export function stripRefs(figure) {
  let thinned = false;
  const panels = (figure.panels || []).map((p) => ({
    ...p,
    series: (p.series || []).map((q) => {
      const plain = (v) => (v && typeof v === 'object' && !Array.isArray(v) && !ArrayBuffer.isView(v) ? v.values : v);
      const out = { ...q, refs: {} };
      for (const k of ['x', 'y', 'z', 'values', 'lower', 'upper', 'counts']) if (out[k] !== undefined) out[k] = plain(out[k]);
      if (q.kind === 'line' && out.x && out.y && out.x.length > EMBED_POINTS) {
        const d = decimate(out.x, out.y, EMBED_POINTS);
        out.x = d.x;
        out.y = d.y;
        thinned = true;
      }
      if (q.kind === 'histogram' && out.values && out.values.length > EMBED_POINTS && Array.isArray(q.counts) && Array.isArray(q.edges)) {
        out.values = null;
        out.counts = q.counts;
        out.edges = q.edges;
        delete out.bins;
      }
      return out;
    })
  }));
  return { figure: { ...figure, panels }, thinned };
}

/**
 * The script for a figure of the view.
 *
 * @param {object} figure - the figure as drawn (mountFigure's figure())
 * @param {'files'|'embed'} source - read the files and compute, or hold the page's numbers
 * @param {{header: string[], imports: string[], prelude: string[]}} python - analysisFigure's `python`
 * @returns {string}
 */
export function analysisScript(figure, source, python) {
  if (source === 'files' && python) {
    return figureScript(figure, { data: 'files', header: python.header, imports: python.imports, prelude: python.prelude });
  }
  const { figure: plain, thinned } = stripRefs(figure);
  const header = [...(python && python.header ? python.header : []), 'The numbers are the ones the page computed, written into the script.'];
  if (thinned || (python && python.thinned)) {
    header.push(`Lines longer than ${EMBED_POINTS.toLocaleString('en-GB')} points are thinned to the lowest and highest point of each`,
      'stretch; read the files to draw every row.');
  }
  return figureScript(plain, { data: 'embed', header });
}

/* ------------------------------------------------------------------ *
 * Data files
 * ------------------------------------------------------------------ */

const num = (v) => (Number.isFinite(v) ? String(v) : 'nan');

/**
 * The numbers behind a figure, as a PLUMED-style table to download.
 *
 * @param {ReturnType<typeof analysisFigure>} a
 * @returns {{filename: string, text: string}|null}
 */
export function analysisData(a) {
  if (!a) return null;
  const L = [];
  const r = a.result;
  switch (a.id) {
    case 'fes': {
      if (r.y) {
        L.push(`#! FIELDS ${r.variables[0]} ${r.variables[1]} file.free`);
        for (let j = 0; j < r.y.length; j++) {
          for (let i = 0; i < r.x.length; i++) L.push(`${num(r.x[i])} ${num(r.y[j])} ${num(r.f[i * r.y.length + j])}`);
          L.push('');
        }
      } else {
        L.push(`#! FIELDS ${r.variables[0]} file.free`);
        for (let i = 0; i < r.x.length; i++) L.push(`${num(r.x[i])} ${num(r.f[i])}`);
      }
      return { filename: 'fes.dat', text: `${L.join('\n')}\n` };
    }
    case 'reweight':
      L.push(`#! FIELDS ${r.column} file.free`, `#! SET bias ${r.bias}`, `#! SET frames ${r.frames}`,
        `#! SET effective ${num(r.effective)}`, `#! SET kT ${num(r.kT)}`, `#! SET skip ${r.skip}`);
      for (let i = 0; i < r.x.length; i++) L.push(`${num(r.x[i])} ${num(r.f[i])}`);
      return { filename: 'fes_reweighted.dat', text: `${L.join('\n')}\n` };
    case 'convergence': {
      const s = r.slices;
      L.push(`#! FIELDS ${a.options.variable} ${s.map((_, k) => `file.free.${k + 1}`).join(' ')}`);
      s.forEach((x, k) => L.push(`#! SET time_${k + 1} ${num(x.time)}`));
      s.forEach((x, k) => L.push(`#! SET hills_${k + 1} ${x.hills}`));
      for (let i = 0; i < s[0].x.length; i++) L.push(`${num(s[0].x[i])} ${s.map((x) => num(x.f[i])).join(' ')}`);
      return { filename: 'fes_slices.dat', text: `${L.join('\n')}\n` };
    }
    case 'heights':
      L.push('#! FIELDS time height', `#! SET first ${num(r.first)}`, `#! SET last ${num(r.last)}`, `#! SET ratio ${num(r.ratio)}`);
      for (let i = 0; i < r.time.length; i++) L.push(`${num(r.time[i])} ${num(r.height[i])}`);
      return { filename: 'hill_heights.dat', text: `${L.join('\n')}\n` };
    default:
      return null;
  }
}
