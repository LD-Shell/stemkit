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
 *   reweight     the free energy along one of them, reweighted with the biases
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
 * of rewritten COLVAR rows dropped and every hill kept, several walkers' HILLS
 * files summed together), the hills are summed as `plumed sum_hills` sums
 * them (with the variables a surface is not drawn along integrated out at
 * the run's kT, as `--idw` and `--kt` do), the reweighting weighs each frame
 * with every bias the run printed, and the histograms are the page's. Every
 * data field of a figure names the Python expression that holds it
 * ({ values, py }), so the script reads the files and draws what it computed;
 * with the data in the script instead, the numbers the page computed are
 * written into it (stripRefs).
 */

import {
  KB, hillsVariables, sumHills, fesOverTime, hillHeights, reweight, thermalEnergy, valueColumns, biasColumn,
  biasColumns, totalBias
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
  reached_back: "def reached_back(rows, starts, covered, ti, t0):\n    \"\"\"How many rows a new part starting at time t0 reaches back over that no\n    earlier part reached: the rows at the end with a time at or after t0, as\n    far back as they go. Within a part the time never goes back, so each part\n    is searched by bisection, and many walkers joined together read quickly.\"\"\"\n    end = len(rows)\n    start = end\n    for p in range(len(starts) - 1, -1, -1):\n        a = starts[p]\n        b = starts[p + 1] if p + 1 < len(starts) else end\n        if a >= b:\n            continue\n        if rows[a][ti] >= t0:\n            start = a\n            continue\n        lo, hi = a, b\n        while lo < hi:\n            mid = (lo + hi) >> 1\n            if rows[mid][ti] >= t0:\n                hi = mid\n            else:\n                lo = mid + 1\n        start = lo\n        break\n    added = end - start\n    merged = start\n    while covered and covered[-1][1] > start:\n        a, b = covered.pop()\n        added -= b - max(a, start)\n        merged = min(merged, a)\n    if end > merged:\n        covered.append((merged, end))\n    return added",
  file_kind: "def file_kind(fields):\n    f = fields or []\n    return 'hills' if 'height' in f and any(x.startswith('sigma_') for x in f) else 'colvar'",
  parse_colvar: "def parse_colvar(text, keep_overlap=False, name=''):\n    \"\"\"Parse a COLVAR, HILLS or any other file in PLUMED's column format.\n\n    Rows are kept as long as they have as many columns as the first header\n    names; a row with a value that is not a number is dropped and counted.\n\n    A new part of the run starts where the header is written again, or where\n    the time goes back. In a COLVAR the rows of the older part at or after the\n    new part's first time are dropped, since the new part writes them again.\n    Rows that share a time are not a new part: walkers that share one HILLS\n    file write a hill each at the same time.\n\n    A HILLS file keeps every row: a restarted METAD reads every hill in the\n    file back into its bias, whatever its time, and plumed sum_hills sums them\n    all; the time also goes back where walkers' files were joined into one.\n    Such hills are counted in 'overlap' and said.\n    \"\"\"\n    errors = []\n    sets = {}\n    fields = []\n    headers = 0\n    skipped = 0\n    dropped = 0\n    overlap = 0\n    hills = False\n    rows = []\n    covered = []\n    starts = [0]\n    new_part = False\n    ti = None\n\n    if not isinstance(text, str) or not text.strip():\n        return finish_parse(name, fields, [], sets, 0, 0, 0, ['The file is empty.'], [0], False)\n\n    lines = re.split(r'\\r\\n|\\r|\\n', text)\n    cut = not text.endswith(('\\n', '\\r'))\n    last_data = -1\n    for i, raw in enumerate(lines):\n        if raw.strip() and not raw.strip().startswith(('#', '@')):\n            last_data = i\n    cut_skipped = False\n\n    for i, raw in enumerate(lines):\n        line = raw.strip()\n        if not line:\n            continue\n        if line.startswith('#!'):\n            words = line[2:].split()\n            if words and words[0] == 'FIELDS':\n                headers += 1\n                if not fields:\n                    fields = words[1:]\n                    ti = 0 if fields and fields[0] == 'time' else None\n                    hills = file_kind(fields) == 'hills'\n                else:\n                    new_part = True\n            elif words and words[0] == 'SET' and len(words) >= 3:\n                sets[words[1]] = ' '.join(words[2:])\n            continue\n        if line.startswith(('#', '@')):\n            continue\n        parts = line.split()\n        if not fields:\n            # No header: name the columns by position.\n            fields = ['time' if j == 0 else 'col%d' % (j + 1) for j in range(len(parts))]\n            ti = 0\n            errors.append('The file has no \"#! FIELDS\" header, so the columns are named by position.')\n        if len(parts) != len(fields):\n            skipped += 1\n            if cut and i == last_data:\n                cut_skipped = True\n            continue\n        try:\n            row = [float(p) for p in parts]\n        except ValueError:\n            skipped += 1\n            if cut and i == last_data:\n                cut_skipped = True\n            continue\n        if not all(math.isfinite(v) for v in row):\n            skipped += 1\n            continue\n        if ti is not None and rows and (new_part or row[ti] < rows[-1][ti]):\n            if not keep_overlap and not hills:\n                while rows and rows[-1][ti] >= row[ti]:\n                    rows.pop()\n                    dropped += 1\n                while len(starts) > 1 and starts[-1] > len(rows):\n                    starts.pop()\n            else:\n                overlap += reached_back(rows, starts, covered, ti, row[ti])\n            if starts[-1] != len(rows):\n                starts.append(len(rows))\n        new_part = False\n        rows.append(row)\n\n    if dropped:\n        errors.append(\n            '%d row%s written again by a later part of the run %s dropped (the older copy); '\n            'the job was probably stopped between two checkpoints.'\n            % (dropped, '' if dropped == 1 else 's', 'was' if dropped == 1 else 'were'))\n    if hills and overlap:\n        errors.append(\n            '%d hill%s at or after the time where a later part of the file starts: a run continued from an '\n            'earlier checkpoint, or walkers\\' files joined into one. %s kept, since a restarted METAD reads every '\n            'hill in the file back into its bias, and plumed sum_hills sums them all.'\n            % (overlap, ' lies' if overlap == 1 else 's lie', 'It is' if overlap == 1 else 'They are all'))\n    return finish_parse(name, fields, rows, sets, skipped, headers, dropped, errors, starts, cut_skipped, overlap)",
  finish_parse: "def finish_parse(name, fields, rows, sets, skipped, headers, dropped, errors, starts, cut_skipped, overlap=0):\n    data = np.array(rows, dtype=float) if rows else np.zeros((0, len(fields)))\n    columns = {f: data[:, j].copy() for j, f in enumerate(fields)}\n    periods = {}\n    for f in fields:\n        lo = sets.get('min_' + f)\n        hi = sets.get('max_' + f)\n        if lo is None or hi is None:\n            continue\n        a = constant(lo)\n        b = constant(hi)\n        if a is not None and b is not None and b > a:\n            # The SET line's own words too, as METAD wants a periodic grid written.\n            periods[f] = {'min': a, 'max': b, 'minText': lo, 'maxText': hi}\n    if fields and not rows and not errors:\n        errors.append('The file holds no rows of numbers.')\n    if skipped:\n        errors.append('%d row%s left out: wrong number of columns, or a value that is not a number.'\n                      % (skipped, ' was' if skipped == 1 else 's were'))\n    if cut_skipped:\n        errors.append('The last line was cut off mid-write, as happens when a job is stopped; it was left out.')\n    return {\n        'name': name, 'fields': fields, 'columns': columns, 'rows': len(rows), 'sets': sets,\n        'periods': periods, 'skipped': skipped, 'headers': headers, 'dropped': dropped, 'overlap': overlap,\n        'parts': len(starts), 'starts': starts, 'errors': errors, 'cut': cut_skipped,\n    }",
  warn: "def warn(text):\n    sys.stderr.write('warning: %s\\n' % text)",
  fail: "def fail(text):\n    sys.stderr.write('error: %s\\n' % text)\n    sys.exit(1)",
  pool: "def pool(files):\n    \"\"\"Several files of the same columns as one, in time order (walkers).\"\"\"\n    if len(files) == 1:\n        return files[0]\n    fields = files[0]['fields']\n    for c in files[1:]:\n        if c['fields'] != fields:\n            fail('%s has the columns %s, but %s has %s; they cannot be taken together.'\n                 % (c['name'], ' '.join(c['fields']), files[0]['name'], ' '.join(fields)))\n    data = np.vstack([np.column_stack([c['columns'][f] for f in fields]) for c in files])\n    if 'time' in fields:\n        data = data[np.argsort(data[:, fields.index('time')], kind='stable')]\n    merged = dict(files[0])\n    merged['columns'] = {f: data[:, j].copy() for j, f in enumerate(fields)}\n    merged['rows'] = data.shape[0]\n    merged['name'] = ', '.join(c['name'] for c in files)\n    kernels = {c['sets'].get('kerneltype', '') for c in files}\n    if len(kernels) > 1:\n        warn('The files do not all use the same kernel type (%s); the first one\\'s is used.'\n             % ', '.join(sorted(k or 'unstated' for k in kernels)))\n    return merged",
  hills_variables: "def hills_variables(fields):\n    \"\"\"The variables of a HILLS file, in order; a multivariate file (ADAPTIVE)\n    has sigma_x_x columns instead of sigma_x.\"\"\"\n    f = fields or []\n    return [x for x in f if 'sigma_' + x in f or 'sigma_%s_%s' % (x, x) in f]",
  hills_multivariate: "def hills_multivariate(hills):\n    \"\"\"Whether the hills are multivariate (ADAPTIVE=DIFF or GEOM).\"\"\"\n    said = str(hills['sets'].get('multivariate', '')).strip().lower()\n    if said in ('true', 'false'):\n        return said == 'true'\n    every = hills_variables(hills['fields'])\n    return bool(every) and all('sigma_' + v not in hills['fields'] for v in every)",
  total_bias: "def total_bias(c, names):\n    \"\"\"The sum of some columns, row by row, in the order given.\"\"\"\n    out = np.zeros(c['rows'])\n    for name in names:\n        if name in c['columns']:\n            out = out + c['columns'][name]\n    return out",
  seq_sum: "def seq_sum(a):\n    \"\"\"A sum in order, as the page's loop adds, so the digits agree.\"\"\"\n    return float(np.cumsum(a)[-1]) if len(a) else 0.0",
  axis: "def axis(lo, hi, bins, periodic):\n    # A periodic axis leaves out its last point, which is its first again.\n    dx = (hi - lo) / (bins if periodic else bins - 1)\n    return {'x': lo + np.arange(bins) * dx, 'dx': dx, 'n': bins}",
  hill_widths: "def hill_widths(hills, name):\n    \"\"\"The width of each hill along one variable: its sigma, or for a\n    multivariate hill the square root of its variance along that variable.\"\"\"\n    cols = hills['columns']\n    if 'sigma_' + name in cols:\n        return cols['sigma_' + name]\n    every = hills_variables(hills['fields'])\n    out = np.zeros(hills['rows'])\n    for c in range(every.index(name) + 1):\n        col = cols.get('sigma_%s_%s' % (name, every[c]))\n        if col is not None:\n            out = out + col * col\n    return np.sqrt(out)",
  range_of: "def range_of(hills, name, lo=None, hi=None):\n    period = hills['periods'].get(name)\n    if period:\n        return {'min': period['min'], 'max': period['max'], 'periodic': True}\n    col = hills['columns'][name]\n    pad = 3 * float(hill_widths(hills, name).max())\n    return {'min': float(col.min()) - pad if lo is None else lo,\n            'max': float(col.max()) + pad if hi is None else hi,\n            'periodic': False}",
  hill_covariance: "def hill_covariance(hills, names, i):\n    \"\"\"The covariance L L^T of multivariate hill i: PLUMED writes the lower\n    triangle L as sigma_<a>_<b>, a after b in the METAD's order.\"\"\"\n    n = len(names)\n    L = np.zeros((n, n))\n    for r in range(n):\n        for c in range(r + 1):\n            col = hills['columns'].get('sigma_%s_%s' % (names[r], names[c]))\n            L[r, c] = col[i] if col is not None else 0.0\n    return L @ L.T",
  hill_kernel: "def hill_kernel(hills):\n    \"\"\"The shape of a hill as PLUMED 2.11's sum_hills reads it: stretched and\n    cut where dp2 reaches 6.25, unless the file says \"kerneltype gaussian\". A\n    file with no kerneltype (PLUMED 2.7 or older) is read as stretched too;\n    its run applied the plain Gaussian, about 0.2% apart. A plain Gaussian\n    has no cut of its own: it is added wherever its window reaches.\"\"\"\n    kind = str(hills['sets'].get('kerneltype', '')).strip().lower()\n    if kind in ('gaussian', 'truncated-gaussian'):\n        return lambda dp2: np.exp(-dp2)\n    floor = math.exp(-DP2_CUTOFF)\n    stretch = 1 / (1 - floor)\n    return lambda dp2: np.where(dp2 < DP2_CUTOFF, (np.exp(-dp2) - floor) * stretch, 0.0)",
  hill_window: "def hill_window(a, r, centre, span):\n    \"\"\"The grid points a hill reaches along one axis, and their distance from\n    its centre: span points either side of the point at or below the centre,\n    as PLUMED places the window. A periodic axis wraps, and a hill wider than\n    about half the period reaches some points twice, as in sum_hills.\"\"\"\n    at = math.floor((centre - r['min']) / a['dx'])\n    j = np.arange(at - span, at + span + 1)\n    width = r['max'] - r['min']\n    if r['periodic']:\n        idx = j % a['n']\n    else:\n        keep = (j >= 0) & (j < a['n'])\n        j = j[keep]\n        idx = j\n    d = r['min'] + j * a['dx'] - centre\n    if r['periodic']:\n        d = d - width * np.floor(d / width + 0.5)\n    return idx, d",
  sum_hills: "def sum_hills(hills, variables=None, bins=None, up_to=None, ranges=None, kT=None, integrate_bins=None):\n    \"\"\"Sum the hills into a free-energy surface in one or two dimensions, as\n    `plumed sum_hills` does: each hill a Gaussian of the height and widths in\n    its row (or its covariance, for ADAPTIVE hills), cut off, stretched and\n    placed on the grid as PLUMED does. The lowest point is zero. `up_to` sums\n    only the first so many hills.\n\n    The variables of the file not asked for are integrated out at the thermal\n    energy kT, F(d) = -kT ln sum_t exp(-F(d,t)/kT), as\n    `plumed sum_hills --idw d --kt <kT>` does; without kT there is no such\n    surface (None), as PLUMED refuses it without --kt.\"\"\"\n    every = hills_variables(hills['fields'])\n    asked = variables or every\n    chosen = [v for k, v in enumerate(asked) if v in every and v not in asked[:k]][:2]\n    if not chosen or not hills['rows'] or 'height' not in hills['columns']:\n        return None\n    rest = [v for v in every if v not in chosen]\n    if rest and not (kT is not None and kT > 0):\n        return None\n    ranges = ranges or {}\n    height = hills['columns']['height']\n    count = hills['rows'] if up_to is None else min(hills['rows'], max(0, up_to))\n    dim = len(chosen)\n    want = bins or (300 if dim == 1 else 120)\n    nb = list(want) if isinstance(want, (list, tuple)) else [want, want]\n    kept = [int(b) for b in nb[:dim]]\n    kept_size = int(np.prod(kept))\n    other = max(2, js_round(integrate_bins or INTEGRATE_BINS))\n    while other > 10 and kept_size * other ** len(rest) > INTEGRATE_POINTS:\n        other -= 1\n    order = chosen + rest\n    counts = kept + [other] * len(rest)\n    rg = [range_of(hills, v, *ranges.get(v, (None, None))) for v in order]\n    ax = [axis(r['min'], r['max'], counts[k], r['periodic']) for k, r in enumerate(rg)]\n    cols = [hills['columns'][v] for v in order]\n    kernel = hill_kernel(hills)\n    multi = hills_multivariate(hills)\n    file_order = hills_variables(hills['fields'])\n    pos = [file_order.index(v) for v in order]\n    cut = math.sqrt(2 * DP2_CUTOFF)\n    n = len(order)\n\n    def shaped(a, k):\n        \"\"\"A window's values along axis k of the grid, for broadcasting.\"\"\"\n        return a.reshape([-1 if j == k else 1 for j in range(n)])\n\n    f = np.zeros(counts)\n    for i in range(count):\n        if multi:\n            # The covariance in the grid's order, its inverse (the metric), and\n            # a window from its longest axis, as PLUMED sizes it.\n            cov = hill_covariance(hills, file_order, i)[np.ix_(pos, pos)]\n            metric = np.linalg.inv(cov)\n            values, vectors = np.linalg.eigh(cov)\n            top = int(np.argmax(values))\n            spans = [math.ceil((cut * abs(math.sqrt(values[top]) * vectors[k, top])) / ax[k]['dx'])\n                     for k in range(n)]\n        else:\n            sig = [hills['columns']['sigma_' + v][i] for v in order]\n            spans = [math.ceil((cut * sig[k]) / ax[k]['dx']) for k in range(n)]\n        win = [hill_window(ax[k], rg[k], cols[k][i], spans[k]) for k in range(n)]\n        if multi:\n            r2 = 0.0\n            for a in range(n):\n                for b in range(n):\n                    r2 = r2 + metric[a, b] * shaped(win[a][1], a) * shaped(win[b][1], b)\n            w = height[i] * kernel(0.5 * r2)\n        else:\n            dp2 = 0.0\n            for k in range(n):\n                d = win[k][1]\n                dp2 = dp2 + shaped((d * d) / (2 * sig[k] * sig[k]), k)\n            w = height[i] * kernel(dp2)\n        index = np.ix_(*[idx for idx, _ in win])\n        if all(not rg[k]['periodic'] or 2 * spans[k] + 1 <= ax[k]['n'] for k in range(n)):\n            f[index] -= w\n        else:\n            np.subtract.at(f, index, w)\n\n    if rest:\n        u = -f.reshape(tuple(kept) + (-1,)) / kT\n        top = u.max(axis=-1)\n        f = -kT * (top + np.log(np.exp(u - top[..., None]).sum(axis=-1)))\n    f = f - f.min()\n    return {'variables': chosen, 'x': ax[0]['x'], 'y': ax[1]['x'] if dim == 2 else None, 'f': f,\n            'hills': count, 'max': float(f.max()) if count else 0.0,\n            'periodic': [r['periodic'] for r in rg[:dim]], 'ranges': rg[:dim],\n            'integrated': rest, 'integrated_bins': [other] * len(rest), 'kT': kT if rest else None}",
  fes_over_time: "def fes_over_time(hills, variable=None, slices=5, bins=300, lo=None, hi=None, kT=None, integrate_bins=None):\n    \"\"\"The surface of one variable at several times through the run, all on\n    the same axis, to see whether it still changes. The other variables of\n    the hills are integrated out at kT, as in sum_hills.\"\"\"\n    every = hills_variables(hills['fields'])\n    variable = variable or (every[0] if every else None)\n    if not variable or not hills['rows']:\n        return []\n    r = range_of(hills, variable, lo, hi)\n    time = hills['columns'].get('time')\n    out = []\n    n = max(1, min(slices, hills['rows']))\n    for k in range(1, n + 1):\n        up_to = js_round(hills['rows'] * k / n)\n        s = sum_hills(hills, [variable], bins, up_to,\n                      {} if r['periodic'] else {variable: (r['min'], r['max'])}, kT, integrate_bins)\n        if s is None:\n            return []\n        out.append({'time': float(time[up_to - 1]) if time is not None else up_to,\n                    'hills': up_to, 'x': s['x'], 'f': s['f'], 'integrated': s['integrated']})\n    return out",
  hill_heights: "def hill_heights(hills, points=400):\n    \"\"\"Hill height through the run, thinned for plotting, with the factor\n    gamma/(gamma-1) a well-tempered file carries taken off again.\"\"\"\n    h = hills['columns'].get('height')\n    t = hills['columns'].get('time')\n    if h is None or not h.size:\n        return {'time': [], 'height': [], 'first': math.nan, 'last': math.nan, 'ratio': math.nan,\n                'tempered': False, 'biasFactor': None}\n    bf = hills['columns'].get('biasf')\n    gamma = float(bf[0]) if bf is not None and bf.size else None\n    tempered = gamma is not None and gamma > 1\n    scale = (gamma - 1) / gamma if tempered else 1.0\n    n = h.size\n    block = max(1, n // points)\n    times = []\n    heights = []\n    for i in range(0, n, block):\n        chunk = h[i:min(n, i + block)]\n        times.append(float(t[min(n - 1, i + chunk.size // 2)]) if t is not None else i)\n        heights.append(seq_sum(chunk) / chunk.size * scale)\n    tail = max(1, n // 10)\n    last = seq_sum(h[n - tail:]) / tail * scale\n    first = float(h[0]) * scale\n    return {'time': times, 'height': heights, 'first': first, 'last': last,\n            'ratio': last / first if first > 0 else math.nan, 'tempered': tempered, 'biasFactor': gamma}",
  reweight: "def reweight(values, bias, kT, bins=100, skip=0, lo=None, hi=None, period=None):\n    \"\"\"Free energy along any printed quantity, from a biased run: each frame\n    weighted by exp(V/kT), relative to the largest V so that nothing\n    overflows. Returns the Kish effective sample size too.\"\"\"\n    values = np.asarray(values, dtype=float)\n    bias = np.asarray(bias, dtype=float)\n    n = min(values.size, bias.size)\n    if not kT > 0 or n - skip < 2:\n        return None\n    v = values[skip:n]\n    b = bias[skip:n]\n    vmax = float(b.max())\n    if period:\n        lo, hi = period['min'], period['max']\n    if lo is None:\n        lo = float(v.min())\n    if hi is None:\n        hi = float(v.max())\n    if not hi > lo:\n        return None\n    width = (hi - lo) / bins\n    w = np.exp((b - vmax) / kT)\n    k = np.floor((v - lo) / width).astype(np.int64)\n    k[(k == bins) & (v == hi)] = bins - 1\n    inside = (k >= 0) & (k < bins)\n    p = np.zeros(bins)\n    np.add.at(p, k[inside], w[inside])\n    sw = seq_sum(w[inside])\n    sw2 = seq_sum(w[inside] ** 2)\n    x = lo + (np.arange(bins) + 0.5) * width\n    with np.errstate(divide='ignore', invalid='ignore'):\n        f = np.where(p > 0, -kT * np.log(p / sw), np.nan)\n    if np.isfinite(f).any():\n        f = f - np.nanmin(f)\n    return {'x': x, 'f': f, 'frames': n - skip, 'effective': sw * sw / sw2 if sw2 > 0 else 0.0}"
});

/* Which functions each one calls. */
const PY_NEEDS = {
  parse_colvar: ['constant', 'finish_parse', 'reached_back', 'file_kind'],
  finish_parse: ['constant'],
  constant: [],
  pool: ['warn', 'fail'],
  hills_multivariate: ['hills_variables'],
  hill_widths: ['hills_variables'],
  range_of: ['hill_widths'],
  sum_hills: ['hills_variables', 'hills_multivariate', 'axis', 'range_of', 'hill_covariance', 'hill_kernel',
    'hill_window', 'js_round'],
  fes_over_time: ['hills_variables', 'range_of', 'sum_hills', 'js_round'],
  hill_heights: ['seq_sum'],
  reweight: ['seq_sum']
};

/* The names the prelude defines at the top level, which a column's name must not take. */
const PRELUDE_NAMES = ['KB_KJMOL', 'KB', 'DP2_CUTOFF', 'INTEGRATE_BINS', 'INTEGRATE_POINTS', 'TEMPERATURE', 'ENERGY',
  'kT', 'COLVAR_FILE', 'HILLS_FILES', 'colvar', 'hills', 'note', 'path', 'fes', 'fes_z', 'rw', 'bias_total', 'slices',
  'heights', 'low', 'change', 'skip', 'row', 'gzip', 'math', 're', 'sys'];

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
  'DP2_CUTOFF = 6.25',
  '# A variable integrated out is summed over this many points, and fewer when',
  '# the whole grid would pass INTEGRATE_POINTS (four or more variables).',
  'INTEGRATE_BINS = 100',
  'INTEGRATE_POINTS = 4000000'
];

/* "t", "t and u": the variables integrated out of a surface. */
const listed = (names) => names.join(' and ');

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
  // Every bias the run applied, added up: a wall beside the metadynamics
  // pushed the run as much as the hills did, so its energy is in the weights.
  const biases = biasColumns(c);
  const bias = biases.join(' + ');
  const offsets = biases.filter((b) => /\.rbias$/.test(b));
  const rbias = offsets.length > 0;
  const skip = Math.floor(c.rows * (rbias ? 0 : 0.2));
  const period = c.periods[col] || null;
  const r = reweight(c.columns[col], totalBias(c, biases), { kT: o.kT, bins: o.reweightBins, skip, period: period || undefined });
  if (!r) return null;
  const body = [
    ...TEMPERATURE_LINES(o),
    '',
    rbias
      ? `# ${comment(offsets.join(', '))} ${offsets.length === 1 ? 'is the bias' : 'are the biases'} less the running offset, so every frame counts.`
      : `# The first fifth of the run is left out, since ${comment(bias)} still grows there.`,
    rbias ? 'skip = 0' : "skip = int(math.floor(colvar['rows'] * 0.2))",
    biases.length > 1
      ? `# Every bias the run applied, added up: ${comment(bias)}.`
      : `# The bias the run applied: ${comment(bias)}.`,
    `bias_total = total_bias(colvar, [${biases.map(pyStr).join(', ')}])`,
    `# Each frame weighted by exp(V/kT), in ${o.reweightBins} bins${period ? ' over the period' : ''}.`,
    `rw = reweight(colvar['columns'][${pyStr(col)}], bias_total, kT, ${o.reweightBins}, skip, None, None,`,
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
      prelude: prelude({ run, reads: 'colvar', functions: ['reweight', 'total_bias', 'js_round'], constants: KB_LINES, body }),
      reads: [run.colvarFile || 'COLVAR']
    },
    result: { ...r, bias, biases, skip, kT: o.kT, column: col }
  };
}

function fes(run, o) {
  const h = run.hills;
  const two = o.along.length === 2;
  const hillsNames = run.hillsFiles && run.hillsFiles.length ? run.hillsFiles : ['HILLS'];
  const s = sumHills(h, { variables: o.along, bins: two ? 100 : 300, kT: o.kT });
  if (!s) return null;
  const out = s.integrated;
  // With hills over more variables than the surface is drawn along, the
  // others are integrated out at kT, as `plumed sum_hills --idw --kt` does;
  // the hills summed along one variable alone would not be a free energy.
  const projected = out.length > 0;
  const kTArg = projected ? ', kT=kT' : '';
  const integrating = projected
    ? [`# ${comment(listed(out))} ${out.length === 1 ? 'is' : 'are'} integrated out at kT, as plumed sum_hills --idw ${comment(s.variables.join(','))} --kt does:`,
      `# F = -kT ln of the sum of exp(-F/kT) over ${comment(listed(out))}.`]
    : [];
  const python = (body, head) => ({
    header: [head],
    imports: PYTHON_IMPORTS.slice(),
    prelude: prelude({
      run, reads: 'hills', functions: ['sum_hills'], body: projected ? [...TEMPERATURE_LINES(o), '', ...body] : body,
      constants: projected ? [...KB_LINES, '', ...CUTOFF_LINES] : CUTOFF_LINES
    }),
    reads: hillsNames
  });
  const aside = projected ? `, ${listed(out)} integrated out` : '';
  if (two) {
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
      ...integrating,
      `fes = sum_hills(hills, [${pyStr(a)}, ${pyStr(b)}], [100, 100]${kTArg})`,
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
      styleKey: 'fes-2d', labelKey: `${a},${b}|${o.energy}`, panelKeys: [`${a},${b}`], figure,
      title: `Free-energy surface over ${a} and ${b}${aside}`,
      python: python(body, `The free-energy surface over ${a} and ${b}${aside}, summed from the hills, from STEMKit (https://stemkit.net)`),
      result: s
    };
  }
  const v = s.variables[0];
  const body = [
    '# The negative sum of the hills at 300 points, its lowest point at zero.',
    ...integrating,
    `fes = sum_hills(hills, [${pyStr(v)}], 300${kTArg})`,
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
    styleKey: 'fes-1d', labelKey: `${v}|${o.energy}`, panelKeys: [`${v}|${o.energy}`], figure, title: `Free energy along ${v}${aside}`,
    python: python(body, `The free energy along ${v}${aside}, summed from the hills, from STEMKit (https://stemkit.net)`),
    result: s
  };
}

function convergence(run, o) {
  const h = run.hills;
  const v = o.variable;
  const slices = fesOverTime(h, { variable: v, slices: o.slices, bins: 300, kT: o.kT });
  if (!slices.length) return null;
  const out = slices[0].integrated || [];
  const projected = out.length > 0;
  const aside = projected ? `, ${listed(out)} integrated out` : '';
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
    ...(projected
      ? [`# ${comment(listed(out))} ${out.length === 1 ? 'is' : 'are'} integrated out at kT, as plumed sum_hills --idw ${comment(v)} --kt does.`]
      : []),
    `slices = fes_over_time(hills, ${pyStr(v)}, ${slices.length}, 300${projected ? ', kT=kT' : ''})`
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
    title: `The surface along ${v} through the run${aside}`,
    python: {
      header: [`The free energy along ${v}${aside} at ${slices.length} times through the run, from STEMKit (https://stemkit.net)`],
      imports: PYTHON_IMPORTS.slice(),
      prelude: prelude({ run, reads: 'hills', functions: ['fes_over_time'], constants: [...KB_LINES, '', ...CUTOFF_LINES], body }),
      reads: run.hillsFiles && run.hillsFiles.length ? run.hillsFiles : ['HILLS']
    },
    result: { slices, change, part, integrated: out, kT: projected ? o.kT : null }
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
      const integrated = r.integrated && r.integrated.length
        ? [`#! SET integrated ${r.integrated.join(',')}`, `#! SET kT ${num(r.kT)}`] : [];
      if (r.y) {
        L.push(`#! FIELDS ${r.variables[0]} ${r.variables[1]} file.free`, ...integrated);
        for (let j = 0; j < r.y.length; j++) {
          for (let i = 0; i < r.x.length; i++) L.push(`${num(r.x[i])} ${num(r.y[j])} ${num(r.f[i * r.y.length + j])}`);
          L.push('');
        }
      } else {
        L.push(`#! FIELDS ${r.variables[0]} file.free`, ...integrated);
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
      if (r.integrated && r.integrated.length) L.push(`#! SET integrated ${r.integrated.join(',')}`, `#! SET kT ${num(r.kT)}`);
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
