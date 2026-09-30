#!/usr/bin/env python3
"""
STEMKit, MD Workflow Generator: analysing what a PLUMED run wrote.
Author: Olanrewaju M. Daramola

The same analysis as the "Analyse a run" view of the MD Workflow Generator
(stemkit.net), for files too large for a browser, for runs that live on a
cluster, and for figures that go into a paper.

- A COLVAR from a short run with no bias gives the hill width and the grid of
  each variable (`suggest`).
- A HILLS file gives the free-energy surface, the surface at earlier times to
  see whether it has settled, and the height of the hills through the run
  (`fes`). Several HILLS files, one per walker, are summed together.
- A COLVAR from a biased run gives the free energy along any printed value by
  reweighting (`reweight`), and the work of a steered run (`work`).

The numbers are those of src/core/plumed-analysis.js in STEMKit, and the hill
sum is PLUMED's own: on the test files in tests/fixtures/plumed it matches
`plumed sum_hills` to within 1e-7.

A run continued from a checkpoint is read as one run. PLUMED writes the header
again where each part starts. When a job was killed between two checkpoints,
the next part starts from the last checkpoint, earlier than where the file
ends, so part of a COLVAR is written twice; the older copy is dropped and the
number of rows dropped is reported (`--keep-overlap` keeps them). A HILLS file
keeps every hill: a restarted METAD reads every hill in the file back into its
bias, those laid after the checkpoint too, and `plumed sum_hills` sums them
all. A last line cut off mid-write is left out.

With hills over more variables than the surface is drawn along, the others
are integrated out at the run's kT (`--temp`, `--energy`), as
`plumed sum_hills --idw <cv> --kt <kT>` does. Hills from ADAPTIVE=DIFF or GEOM
(multivariate) are summed with their full covariance. A reweighting adds up
every bias the COLVAR printed (the METAD's rbias and each wall's bias).

Needs Python 3.8 or later and numpy. matplotlib is optional: without it the
data files are written and the plots are skipped.

    python3 analyse_plumed.py all COLVAR HILLS
    python3 analyse_plumed.py suggest COLVAR --nonnegative d
    python3 analyse_plumed.py fes HILLS --cv d --slices 5
    python3 analyse_plumed.py fes HILLS.0 HILLS.1 HILLS.2 --cv d --cv2 t
    python3 analyse_plumed.py reweight COLVAR --arg d --bias metad.rbias
    python3 analyse_plumed.py work COLVAR --arg moving.work
"""

import argparse
import gzip
import json
import math
import os
import re
import sys

try:
    import numpy as np
except ImportError:  # pragma: no cover - reported to the user
    sys.stderr.write('analyse_plumed.py needs numpy: pip install numpy\n')
    sys.exit(2)

# Boltzmann constant in kJ/(mol K), and in each energy unit PLUMED takes.
KB_KJMOL = 0.0083144626
KB = {
    'kj/mol': KB_KJMOL,
    'kcal/mol': KB_KJMOL / 4.184,
    'eV': KB_KJMOL / 96.48533212,
    'Ha': KB_KJMOL / 2625.499639,
}
ENERGY_LABEL = {'kj/mol': 'kJ/mol', 'kcal/mol': 'kcal/mol', 'eV': 'eV', 'Ha': 'Hartree'}

# Columns that are the bias or its bookkeeping, not a variable to analyse.
BOOKKEEPING = re.compile(r'\.(bias|rbias|rct|work|force2|zed|neff|nker)$')

# The one accent of the site, and the faint and strong ends of the ramp for
# the same surface at later and later times (the faint end has 3:1 contrast
# with white).
ACCENT = '#1f5c96'
RAMP_FROM = (100, 148, 194)
RAMP_TO = (20, 62, 105)

# PLUMED drops a hill where half the squared distance from its centre, in
# widths, passes 6.25, and since 2.8 stretches the Gaussian so that it reaches
# zero there (the file then says "kerneltype stretched-gaussian").
DP2_CUTOFF = 6.25
# A variable integrated out is summed over this many points, and fewer when
# the whole grid would pass INTEGRATE_POINTS (four or more variables).
INTEGRATE_BINS = 100
INTEGRATE_POINTS = 4000000


# ------------------------------------------------------------------ #
# Numbers as JavaScript writes them, so the suggestions read the same
# as on the page.
# ------------------------------------------------------------------ #

def js_round(x):
    """Math.round: to the nearest integer, halves upwards."""
    return math.floor(x + 0.5)


def js_str(x):
    """String(x) for a JavaScript number."""
    if x != x:
        return 'NaN'
    if math.isinf(x):
        return 'Infinity' if x > 0 else '-Infinity'
    if x == 0:
        return '0'
    r = repr(float(x))
    sign = '-' if r.startswith('-') else ''
    r = r.lstrip('-')
    mant, _, exp = r.partition('e')
    exp = int(exp) if exp else 0
    ip, _, fp = mant.partition('.')
    full = ip + fp
    point = len(ip) + exp
    lead = len(full) - len(full.lstrip('0'))
    digits = full.strip('0')
    n = point - lead
    k = len(digits)
    if k <= n <= 21:
        return sign + digits + '0' * (n - k)
    if 0 < n <= 21:
        return sign + digits[:n] + '.' + digits[n:]
    if -6 < n <= 0:
        return sign + '0.' + '0' * (-n) + digits
    e = n - 1
    tail = ('+' if e >= 0 else '-') + str(abs(e))
    if k == 1:
        return sign + digits + 'e' + tail
    return sign + digits[0] + '.' + digits[1:] + 'e' + tail


def round_sig(value, figures=2):
    """Round to a number of significant figures (roundSig in the core)."""
    if not math.isfinite(value) or value == 0:
        return value
    p = 10.0 ** (figures - 1 - math.floor(math.log10(abs(value))))
    return js_round(value * p) / p


def tidy(value):
    r = round_sig(value, 3)
    return js_str(float('%.3g' % r)) if math.isfinite(r) else js_str(r)


def fmt(value, digits=3):
    """A number for a table: three significant figures, or a dash."""
    if value is None or not math.isfinite(value):
        return '-'
    return js_str(float('%.*g' % (digits, value)))


def constant(text):
    """A number as PLUMED writes it in a SET line: 1.5, -pi, 2*pi."""
    t = str(text).strip().lower()
    m = re.match(r'^([+-]?)(\d*\.?\d*)\*?pi$', t)
    if m:
        return (-1 if m.group(1) == '-' else 1) * (float(m.group(2)) if m.group(2) else 1.0) * math.pi
    try:
        n = float(t)
    except ValueError:
        return None
    return n if math.isfinite(n) else None


# ------------------------------------------------------------------ #
# Files
# ------------------------------------------------------------------ #

def read_text(path):
    opener = gzip.open if path.endswith('.gz') else open
    with opener(path, 'rt', encoding='utf-8', errors='replace') as fh:
        return fh.read()


def reached_back(rows, starts, covered, ti, t0):
    """How many rows a new part starting at time t0 reaches back over that no
    earlier part reached: the rows at the end with a time at or after t0, as
    far back as they go. Within a part the time never goes back, so each part
    is searched by bisection, and many walkers joined together read quickly."""
    end = len(rows)
    start = end
    for p in range(len(starts) - 1, -1, -1):
        a = starts[p]
        b = starts[p + 1] if p + 1 < len(starts) else end
        if a >= b:
            continue
        if rows[a][ti] >= t0:
            start = a
            continue
        lo, hi = a, b
        while lo < hi:
            mid = (lo + hi) >> 1
            if rows[mid][ti] >= t0:
                hi = mid
            else:
                lo = mid + 1
        start = lo
        break
    added = end - start
    merged = start
    while covered and covered[-1][1] > start:
        a, b = covered.pop()
        added -= b - max(a, start)
        merged = min(merged, a)
    if end > merged:
        covered.append((merged, end))
    return added


def parse_colvar(text, keep_overlap=False, name=''):
    """Parse a COLVAR, HILLS or any other file in PLUMED's column format.

    Rows are kept as long as they have as many columns as the first header
    names; a row with a value that is not a number is dropped and counted.

    A new part of the run starts where the header is written again, or where
    the time goes back. In a COLVAR the rows of the older part at or after the
    new part's first time are dropped, since the new part writes them again.
    Rows that share a time are not a new part: walkers that share one HILLS
    file write a hill each at the same time.

    A HILLS file keeps every row: a restarted METAD reads every hill in the
    file back into its bias, whatever its time, and plumed sum_hills sums them
    all; the time also goes back where walkers' files were joined into one.
    Such hills are counted in 'overlap' and said.
    """
    errors = []
    sets = {}
    fields = []
    headers = 0
    skipped = 0
    dropped = 0
    overlap = 0
    hills = False
    rows = []
    covered = []
    starts = [0]
    new_part = False
    ti = None

    if not isinstance(text, str) or not text.strip():
        return finish_parse(name, fields, [], sets, 0, 0, 0, ['The file is empty.'], [0], False)

    lines = re.split(r'\r\n|\r|\n', text)
    cut = not text.endswith(('\n', '\r'))
    last_data = -1
    for i, raw in enumerate(lines):
        if raw.strip() and not raw.strip().startswith(('#', '@')):
            last_data = i
    cut_skipped = False

    for i, raw in enumerate(lines):
        line = raw.strip()
        if not line:
            continue
        if line.startswith('#!'):
            words = line[2:].split()
            if words and words[0] == 'FIELDS':
                headers += 1
                if not fields:
                    fields = words[1:]
                    ti = 0 if fields and fields[0] == 'time' else None
                    hills = file_kind(fields) == 'hills'
                else:
                    new_part = True
            elif words and words[0] == 'SET' and len(words) >= 3:
                sets[words[1]] = ' '.join(words[2:])
            continue
        if line.startswith(('#', '@')):
            continue
        parts = line.split()
        if not fields:
            # No header: name the columns by position.
            fields = ['time' if j == 0 else 'col%d' % (j + 1) for j in range(len(parts))]
            ti = 0
            errors.append('The file has no "#! FIELDS" header, so the columns are named by position.')
        if len(parts) != len(fields):
            skipped += 1
            if cut and i == last_data:
                cut_skipped = True
            continue
        try:
            row = [float(p) for p in parts]
        except ValueError:
            skipped += 1
            if cut and i == last_data:
                cut_skipped = True
            continue
        if not all(math.isfinite(v) for v in row):
            skipped += 1
            continue
        if ti is not None and rows and (new_part or row[ti] < rows[-1][ti]):
            if not keep_overlap and not hills:
                while rows and rows[-1][ti] >= row[ti]:
                    rows.pop()
                    dropped += 1
                while len(starts) > 1 and starts[-1] > len(rows):
                    starts.pop()
            else:
                overlap += reached_back(rows, starts, covered, ti, row[ti])
            if starts[-1] != len(rows):
                starts.append(len(rows))
        new_part = False
        rows.append(row)

    if dropped:
        errors.append(
            '%d row%s written again by a later part of the run %s dropped (the older copy); '
            'the job was probably stopped between two checkpoints.'
            % (dropped, '' if dropped == 1 else 's', 'was' if dropped == 1 else 'were'))
    if hills and overlap:
        errors.append(
            '%d hill%s at or after the time where a later part of the file starts: a run continued from an '
            'earlier checkpoint, or walkers\' files joined into one. %s kept, since a restarted METAD reads every '
            'hill in the file back into its bias, and plumed sum_hills sums them all.'
            % (overlap, ' lies' if overlap == 1 else 's lie', 'It is' if overlap == 1 else 'They are all'))
    return finish_parse(name, fields, rows, sets, skipped, headers, dropped, errors, starts, cut_skipped, overlap)


def finish_parse(name, fields, rows, sets, skipped, headers, dropped, errors, starts, cut_skipped, overlap=0):
    data = np.array(rows, dtype=float) if rows else np.zeros((0, len(fields)))
    columns = {f: data[:, j].copy() for j, f in enumerate(fields)}
    periods = {}
    for f in fields:
        lo = sets.get('min_' + f)
        hi = sets.get('max_' + f)
        if lo is None or hi is None:
            continue
        a = constant(lo)
        b = constant(hi)
        if a is not None and b is not None and b > a:
            # The SET line's own words too, as METAD wants a periodic grid written.
            periods[f] = {'min': a, 'max': b, 'minText': lo, 'maxText': hi}
    if fields and not rows and not errors:
        errors.append('The file holds no rows of numbers.')
    if skipped:
        errors.append('%d row%s left out: wrong number of columns, or a value that is not a number.'
                      % (skipped, ' was' if skipped == 1 else 's were'))
    if cut_skipped:
        errors.append('The last line was cut off mid-write, as happens when a job is stopped; it was left out.')
    return {
        'name': name, 'fields': fields, 'columns': columns, 'rows': len(rows), 'sets': sets,
        'periods': periods, 'skipped': skipped, 'headers': headers, 'dropped': dropped, 'overlap': overlap,
        'parts': len(starts), 'starts': starts, 'errors': errors, 'cut': cut_skipped,
    }


def file_kind(fields):
    f = fields or []
    return 'hills' if 'height' in f and any(x.startswith('sigma_') for x in f) else 'colvar'


def hills_variables(fields):
    """The variables of a HILLS file, in order; a multivariate file (ADAPTIVE)
    has sigma_x_x columns instead of sigma_x."""
    f = fields or []
    return [x for x in f if 'sigma_' + x in f or 'sigma_%s_%s' % (x, x) in f]


def hills_multivariate(hills):
    """Whether the hills are multivariate (ADAPTIVE=DIFF or GEOM)."""
    said = str(hills['sets'].get('multivariate', '')).strip().lower()
    if said in ('true', 'false'):
        return said == 'true'
    every = hills_variables(hills['fields'])
    return bool(every) and all('sigma_' + v not in hills['fields'] for v in every)


def value_columns(c):
    return [f for f in c['fields'] if f != 'time' and not BOOKKEEPING.search(f)]


def bias_column(c):
    for pattern in (r'\.rbias$', r'\.bias$'):
        for f in c['fields']:
            if re.search(pattern, f):
                return f
    return ''


def bias_columns(c):
    """Every bias column whose energy the run carried: each *.rbias in place
    of the same action's *.bias, and the *.bias of every other action (walls,
    restraints). A frame's weight is exp(sum of them / kT)."""
    f = c['fields']
    offset = {x[:-len('.rbias')] for x in f if x.endswith('.rbias')}
    return [x for x in f if x.endswith('.rbias') or (x.endswith('.bias') and x[:-len('.bias')] not in offset)]


def total_bias(c, names):
    """The sum of some columns, row by row, in the order given."""
    out = np.zeros(c['rows'])
    for name in names:
        if name in c['columns']:
            out = out + c['columns'][name]
    return out


def load(paths, keep_overlap=False):
    out = []
    for p in paths:
        try:
            text = read_text(p)
        except OSError as e:
            fail('Could not read %s: %s' % (p, e.strerror or e))
        c = parse_colvar(text, keep_overlap=keep_overlap, name=p)
        if not c['rows']:
            fail('%s: %s' % (p, c['errors'][0] if c['errors'] else 'no rows of numbers.'))
        out.append(c)
    return out


def pool(files):
    """Several files of the same columns as one, in time order (walkers)."""
    if len(files) == 1:
        return files[0]
    fields = files[0]['fields']
    for c in files[1:]:
        if c['fields'] != fields:
            fail('%s has the columns %s, but %s has %s; they cannot be taken together.'
                 % (c['name'], ' '.join(c['fields']), files[0]['name'], ' '.join(fields)))
    data = np.vstack([np.column_stack([c['columns'][f] for f in fields]) for c in files])
    if 'time' in fields:
        data = data[np.argsort(data[:, fields.index('time')], kind='stable')]
    merged = dict(files[0])
    merged['columns'] = {f: data[:, j].copy() for j, f in enumerate(fields)}
    merged['rows'] = data.shape[0]
    merged['name'] = ', '.join(c['name'] for c in files)
    kernels = {c['sets'].get('kerneltype', '') for c in files}
    if len(kernels) > 1:
        warn('The files do not all use the same kernel type (%s); the first one\'s is used.'
             % ', '.join(sorted(k or 'unstated' for k in kernels)))
    return merged


def report_file(c):
    parts = ' in %d parts' % c['parts'] if c['parts'] > 1 else ''
    say('%s: %s rows%s.' % (c['name'], '{:,}'.format(c['rows']), parts))
    for e in c['errors']:
        say('  ' + e)


# ------------------------------------------------------------------ #
# Statistics
# ------------------------------------------------------------------ #

def seq_sum(a):
    """A sum in order, as the page's loop adds, so the digits agree."""
    return float(np.cumsum(a)[-1]) if len(a) else 0.0


def column_summary(values, period=None):
    """Mean, spread and range. For a periodic variable the mean and the
    spread are circular, so that values either side of the edge are
    neighbours."""
    v = np.asarray(values, dtype=float)
    n = v.size
    if not n:
        return {'n': 0, 'min': math.nan, 'max': math.nan, 'mean': math.nan, 'sd': math.nan}
    vmin = float(v.min())
    vmax = float(v.max())
    if period:
        width = period['max'] - period['min']
        k = (2 * math.pi) / width
        c = seq_sum(np.cos(k * v))
        s = seq_sum(np.sin(k * v))
        r = min(1.0, math.hypot(c, s) / n)
        mean = math.atan2(s, c) / k
        while mean < period['min']:
            mean += width
        while mean >= period['max']:
            mean -= width
        # Circular standard deviation, which tends to the ordinary one when
        # the values are close together.
        sd = math.sqrt(-2 * math.log(r)) / k if r > 0 else width / math.sqrt(12)
        return {'n': n, 'min': vmin, 'max': vmax, 'mean': mean, 'sd': sd}
    mean = seq_sum(v) / n
    ss = seq_sum((v - mean) ** 2)
    return {'n': n, 'min': vmin, 'max': vmax, 'mean': mean, 'sd': math.sqrt(ss / (n - 1)) if n > 1 else 0.0}


def outward(value, sigma, up):
    """A grid bound rounded outwards, away from the values it must hold, on
    the decade of the hill width (outward in the core). Rounding to the
    nearest two significant figures could move a bound inside the values
    seen; the step is at most one hill width and the pad at least ten."""
    e = math.floor(math.log10(sigma))
    scale = 10 ** abs(e)
    v = value * scale if e < 0 else value / scale
    k = math.ceil(v - 1e-9) if up else math.floor(v + 1e-9)
    return k / scale if e < 0 else float(k * scale)


def suggest_bias(values, period=None, non_negative=False, sigma_fraction=0.5):
    """Hill width and grid for one variable, from an unbiased run.

    The width is a fraction (half, by default) of the standard deviation in
    the basin the run sampled. The grid is the observed range widened by its
    own width on each side, and by at least ten hill widths, rounded
    outwards; a variable that cannot be negative starts five widths below
    zero, unless the run saw it below zero. A periodic variable takes its
    period, written as the COLVAR's SET line writes it (METAD compares the
    text, and stops on 6.28 where it wants 2*pi).
    """
    summary = column_summary(values, period)
    notes = []
    if summary['n'] < 10:
        return None
    if not summary['sd'] > 0:
        return {'sigma': '', 'min': '', 'max': '', 'bin': '', 'summary': summary,
                'notes': ['The variable does not change in this run, so no width can be taken from it.']}
    sigma = round_sig(summary['sd'] * sigma_fraction, 2)
    if period:
        lo, hi = period['min'], period['max']

        def edge_text(v):
            if abs(abs(v) - math.pi) < 1e-6:
                return '-pi' if v < 0 else 'pi'
            return tidy(v)

        lo_text = period.get('minText') or edge_text(lo)
        hi_text = period.get('maxText') or edge_text(hi)
        notes.append('The variable is periodic, so the grid is its period.')
    else:
        span = summary['max'] - summary['min']
        pad = max(span, 10 * sigma)
        lo = outward(summary['min'] - pad, sigma, False)
        hi = outward(summary['max'] + pad, sigma, True)
        lo_text = js_str(lo)
        hi_text = js_str(hi)
        if non_negative and summary['min'] >= 0 and lo < 0:
            # Room for the tail of a hill placed at zero, and no more.
            lo = -5 * sigma
            lo_text = tidy(lo)
            notes.append('The variable cannot be negative, so the grid starts just below zero.')
        elif non_negative and summary['min'] < 0:
            notes.append('The run saw values below zero, so the grid is padded below as well as above.')
        notes.append('The grid is wider than what this run sampled, since the bias will push the variable '
                     'further. Widen it if the biased run stops with a value outside the grid.')
    bins = math.ceil((hi - lo) / (sigma / 5))
    if summary['n'] < 200:
        notes.append('Only %d values: a longer run gives a steadier estimate of the fluctuation.' % summary['n'])
    return {'sigma': tidy(sigma), 'min': lo_text, 'max': hi_text,
            'bin': str(min(bins, 5000)), 'summary': summary, 'notes': notes}


def drift_of(values, period=None):
    """Has a column drifted? Compares the means of the first and last thirds,
    circular means for a periodic variable."""
    v = np.asarray(values, dtype=float)
    n = v.size
    if n < 30:
        return {'drift': 0.0, 'inSd': 0.0, 'drifting': False}
    third = n // 3
    first = column_summary(v[:third], period)
    last = column_summary(v[n - third:], period)
    drift = last['mean'] - first['mean']
    if period:
        width = period['max'] - period['min']
        drift -= width * js_round(drift / width)
    in_sd = abs(drift) / last['sd'] if last['sd'] > 0 else 0.0
    return {'drift': drift, 'inSd': in_sd, 'drifting': in_sd > 2}


# ------------------------------------------------------------------ #
# Free energy from the hills
# ------------------------------------------------------------------ #

def axis(lo, hi, bins, periodic):
    # A periodic axis leaves out its last point, which is its first again.
    dx = (hi - lo) / (bins if periodic else bins - 1)
    return {'x': lo + np.arange(bins) * dx, 'dx': dx, 'n': bins}


def hill_widths(hills, name):
    """The width of each hill along one variable: its sigma, or for a
    multivariate hill the square root of its variance along that variable."""
    cols = hills['columns']
    if 'sigma_' + name in cols:
        return cols['sigma_' + name]
    every = hills_variables(hills['fields'])
    out = np.zeros(hills['rows'])
    for c in range(every.index(name) + 1):
        col = cols.get('sigma_%s_%s' % (name, every[c]))
        if col is not None:
            out = out + col * col
    return np.sqrt(out)


def range_of(hills, name, lo=None, hi=None):
    period = hills['periods'].get(name)
    if period:
        return {'min': period['min'], 'max': period['max'], 'periodic': True}
    col = hills['columns'][name]
    pad = 3 * float(hill_widths(hills, name).max())
    return {'min': float(col.min()) - pad if lo is None else lo,
            'max': float(col.max()) + pad if hi is None else hi,
            'periodic': False}


def hill_covariance(hills, names, i):
    """The covariance L L^T of multivariate hill i: PLUMED writes the lower
    triangle L as sigma_<a>_<b>, a after b in the METAD's order."""
    n = len(names)
    L = np.zeros((n, n))
    for r in range(n):
        for c in range(r + 1):
            col = hills['columns'].get('sigma_%s_%s' % (names[r], names[c]))
            L[r, c] = col[i] if col is not None else 0.0
    return L @ L.T


def hill_kernel(hills):
    """The shape of a hill as PLUMED 2.11's sum_hills reads it: stretched and
    cut where dp2 reaches 6.25, unless the file says "kerneltype gaussian". A
    file with no kerneltype (PLUMED 2.7 or older) is read as stretched too;
    its run applied the plain Gaussian, about 0.2% apart. A plain Gaussian
    has no cut of its own: it is added wherever its window reaches."""
    kind = str(hills['sets'].get('kerneltype', '')).strip().lower()
    if kind in ('gaussian', 'truncated-gaussian'):
        return lambda dp2: np.exp(-dp2)
    floor = math.exp(-DP2_CUTOFF)
    stretch = 1 / (1 - floor)
    return lambda dp2: np.where(dp2 < DP2_CUTOFF, (np.exp(-dp2) - floor) * stretch, 0.0)


def hill_window(a, r, centre, span):
    """The grid points a hill reaches along one axis, and their distance from
    its centre: span points either side of the point at or below the centre,
    as PLUMED places the window. A periodic axis wraps, and a hill wider than
    about half the period reaches some points twice, as in sum_hills."""
    at = math.floor((centre - r['min']) / a['dx'])
    j = np.arange(at - span, at + span + 1)
    width = r['max'] - r['min']
    if r['periodic']:
        idx = j % a['n']
    else:
        keep = (j >= 0) & (j < a['n'])
        j = j[keep]
        idx = j
    d = r['min'] + j * a['dx'] - centre
    if r['periodic']:
        d = d - width * np.floor(d / width + 0.5)
    return idx, d


def sum_hills(hills, variables=None, bins=None, up_to=None, ranges=None, kT=None, integrate_bins=None):
    """Sum the hills into a free-energy surface in one or two dimensions, as
    `plumed sum_hills` does: each hill a Gaussian of the height and widths in
    its row (or its covariance, for ADAPTIVE hills), cut off, stretched and
    placed on the grid as PLUMED does. The lowest point is zero. `up_to` sums
    only the first so many hills.

    The variables of the file not asked for are integrated out at the thermal
    energy kT, F(d) = -kT ln sum_t exp(-F(d,t)/kT), as
    `plumed sum_hills --idw d --kt <kT>` does; without kT there is no such
    surface (None), as PLUMED refuses it without --kt."""
    every = hills_variables(hills['fields'])
    asked = variables or every
    chosen = [v for k, v in enumerate(asked) if v in every and v not in asked[:k]][:2]
    if not chosen or not hills['rows'] or 'height' not in hills['columns']:
        return None
    rest = [v for v in every if v not in chosen]
    if rest and not (kT is not None and kT > 0):
        return None
    ranges = ranges or {}
    height = hills['columns']['height']
    count = hills['rows'] if up_to is None else min(hills['rows'], max(0, up_to))
    dim = len(chosen)
    want = bins or (300 if dim == 1 else 120)
    nb = list(want) if isinstance(want, (list, tuple)) else [want, want]
    kept = [int(b) for b in nb[:dim]]
    kept_size = int(np.prod(kept))
    other = max(2, js_round(integrate_bins or INTEGRATE_BINS))
    while other > 10 and kept_size * other ** len(rest) > INTEGRATE_POINTS:
        other -= 1
    order = chosen + rest
    counts = kept + [other] * len(rest)
    rg = [range_of(hills, v, *ranges.get(v, (None, None))) for v in order]
    ax = [axis(r['min'], r['max'], counts[k], r['periodic']) for k, r in enumerate(rg)]
    cols = [hills['columns'][v] for v in order]
    kernel = hill_kernel(hills)
    multi = hills_multivariate(hills)
    file_order = hills_variables(hills['fields'])
    pos = [file_order.index(v) for v in order]
    cut = math.sqrt(2 * DP2_CUTOFF)
    n = len(order)

    def shaped(a, k):
        """A window's values along axis k of the grid, for broadcasting."""
        return a.reshape([-1 if j == k else 1 for j in range(n)])

    f = np.zeros(counts)
    for i in range(count):
        if multi:
            # The covariance in the grid's order, its inverse (the metric), and
            # a window from its longest axis, as PLUMED sizes it.
            cov = hill_covariance(hills, file_order, i)[np.ix_(pos, pos)]
            metric = np.linalg.inv(cov)
            values, vectors = np.linalg.eigh(cov)
            top = int(np.argmax(values))
            spans = [math.ceil((cut * abs(math.sqrt(values[top]) * vectors[k, top])) / ax[k]['dx'])
                     for k in range(n)]
        else:
            sig = [hills['columns']['sigma_' + v][i] for v in order]
            spans = [math.ceil((cut * sig[k]) / ax[k]['dx']) for k in range(n)]
        win = [hill_window(ax[k], rg[k], cols[k][i], spans[k]) for k in range(n)]
        if multi:
            r2 = 0.0
            for a in range(n):
                for b in range(n):
                    r2 = r2 + metric[a, b] * shaped(win[a][1], a) * shaped(win[b][1], b)
            w = height[i] * kernel(0.5 * r2)
        else:
            dp2 = 0.0
            for k in range(n):
                d = win[k][1]
                dp2 = dp2 + shaped((d * d) / (2 * sig[k] * sig[k]), k)
            w = height[i] * kernel(dp2)
        index = np.ix_(*[idx for idx, _ in win])
        if all(not rg[k]['periodic'] or 2 * spans[k] + 1 <= ax[k]['n'] for k in range(n)):
            f[index] -= w
        else:
            np.subtract.at(f, index, w)

    if rest:
        u = -f.reshape(tuple(kept) + (-1,)) / kT
        top = u.max(axis=-1)
        f = -kT * (top + np.log(np.exp(u - top[..., None]).sum(axis=-1)))
    f = f - f.min()
    return {'variables': chosen, 'x': ax[0]['x'], 'y': ax[1]['x'] if dim == 2 else None, 'f': f,
            'hills': count, 'max': float(f.max()) if count else 0.0,
            'periodic': [r['periodic'] for r in rg[:dim]], 'ranges': rg[:dim],
            'integrated': rest, 'integrated_bins': [other] * len(rest), 'kT': kT if rest else None}


def fes_over_time(hills, variable=None, slices=5, bins=300, lo=None, hi=None, kT=None, integrate_bins=None):
    """The surface of one variable at several times through the run, all on
    the same axis, to see whether it still changes. The other variables of
    the hills are integrated out at kT, as in sum_hills."""
    every = hills_variables(hills['fields'])
    variable = variable or (every[0] if every else None)
    if not variable or not hills['rows']:
        return []
    r = range_of(hills, variable, lo, hi)
    time = hills['columns'].get('time')
    out = []
    n = max(1, min(slices, hills['rows']))
    for k in range(1, n + 1):
        up_to = js_round(hills['rows'] * k / n)
        s = sum_hills(hills, [variable], bins, up_to,
                      {} if r['periodic'] else {variable: (r['min'], r['max'])}, kT, integrate_bins)
        if s is None:
            return []
        out.append({'time': float(time[up_to - 1]) if time is not None else up_to,
                    'hills': up_to, 'x': s['x'], 'f': s['f'], 'integrated': s['integrated']})
    return out


def hill_heights(hills, points=400):
    """Hill height through the run, thinned for plotting, with the factor
    gamma/(gamma-1) a well-tempered file carries taken off again."""
    h = hills['columns'].get('height')
    t = hills['columns'].get('time')
    if h is None or not h.size:
        return {'time': [], 'height': [], 'first': math.nan, 'last': math.nan, 'ratio': math.nan,
                'tempered': False, 'biasFactor': None}
    bf = hills['columns'].get('biasf')
    gamma = float(bf[0]) if bf is not None and bf.size else None
    tempered = gamma is not None and gamma > 1
    scale = (gamma - 1) / gamma if tempered else 1.0
    n = h.size
    block = max(1, n // points)
    times = []
    heights = []
    for i in range(0, n, block):
        chunk = h[i:min(n, i + block)]
        times.append(float(t[min(n - 1, i + chunk.size // 2)]) if t is not None else i)
        heights.append(seq_sum(chunk) / chunk.size * scale)
    tail = max(1, n // 10)
    last = seq_sum(h[n - tail:]) / tail * scale
    first = float(h[0]) * scale
    return {'time': times, 'height': heights, 'first': first, 'last': last,
            'ratio': last / first if first > 0 else math.nan, 'tempered': tempered, 'biasFactor': gamma}


def heights_verdict(heights):
    """The same reading of the heights as the page gives."""
    if not heights['tempered']:
        return ('The run is not well-tempered, so every hill has the same height and the surface keeps '
                'oscillating by about that much. Average the surface over the last part of the run.')
    pct = js_round(heights['ratio'] * 100)
    if heights['ratio'] < 0.1:
        return ('The hills have fallen to %d%% of their first height: the bias changes slowly now. '
                'Check that the surface has stopped changing shape too.' % pct)
    if heights['ratio'] < 0.4:
        return ('The hills are at %d%% of their first height: the basins in reach are filling, '
                'and the run is not finished.' % pct)
    return ('The hills are still at %d%% of their first height: the run is at an early stage, '
            'or the variable keeps finding new ground.' % pct)


# ------------------------------------------------------------------ #
# Reweighting, and the work of a steered run
# ------------------------------------------------------------------ #

def reweight(values, bias, kT, bins=100, skip=0, lo=None, hi=None, period=None):
    """Free energy along any printed quantity, from a biased run: each frame
    weighted by exp(V/kT), relative to the largest V so that nothing
    overflows. Returns the Kish effective sample size too."""
    values = np.asarray(values, dtype=float)
    bias = np.asarray(bias, dtype=float)
    n = min(values.size, bias.size)
    if not kT > 0 or n - skip < 2:
        return None
    v = values[skip:n]
    b = bias[skip:n]
    vmax = float(b.max())
    if period:
        lo, hi = period['min'], period['max']
    if lo is None:
        lo = float(v.min())
    if hi is None:
        hi = float(v.max())
    if not hi > lo:
        return None
    width = (hi - lo) / bins
    w = np.exp((b - vmax) / kT)
    k = np.floor((v - lo) / width).astype(np.int64)
    k[(k == bins) & (v == hi)] = bins - 1
    inside = (k >= 0) & (k < bins)
    p = np.zeros(bins)
    np.add.at(p, k[inside], w[inside])
    sw = seq_sum(w[inside])
    sw2 = seq_sum(w[inside] ** 2)
    x = lo + (np.arange(bins) + 0.5) * width
    with np.errstate(divide='ignore', invalid='ignore'):
        f = np.where(p > 0, -kT * np.log(p / sw), np.nan)
    if np.isfinite(f).any():
        f = f - np.nanmin(f)
    return {'x': x, 'f': f, 'frames': n - skip, 'effective': sw * sw / sw2 if sw2 > 0 else 0.0}


def stitch_work(c, name):
    """The work of a steered run over parts that were continued from a
    checkpoint. PLUMED starts the work of MOVINGRESTRAINT at zero again in
    each part, so each part is carried on from the work the part before it
    had at the new part's first time (exact when that time was printed).
    `c` must be read with keep_overlap, so that the older copy is there to
    take the work from."""
    t = c['columns']['time']
    w = c['columns'][name]
    bounds = list(c['starts']) + [c['rows']]
    out_t = []
    out_w = []
    parts = 0
    for a, b in zip(bounds[:-1], bounds[1:]):
        if a == b:
            continue
        t0 = t[a]
        offset = 0.0
        if out_t:
            parts += 1
            before = [i for i, ti in enumerate(out_t) if ti <= t0]
            offset = out_w[before[-1]] if before else 0.0
            keep = [i for i, ti in enumerate(out_t) if ti < t0]
            out_t = [out_t[i] for i in keep]
            out_w = [out_w[i] for i in keep]
        out_t.extend(float(x) for x in t[a:b])
        out_w.extend(float(x) + offset for x in w[a:b])
    return np.array(out_t), np.array(out_w), parts


# ------------------------------------------------------------------ #
# Output
# ------------------------------------------------------------------ #

QUIET = False


def say(text=''):
    if not QUIET:
        print(text)


def warn(text):
    sys.stderr.write('warning: %s\n' % text)


def fail(text):
    sys.stderr.write('error: %s\n' % text)
    sys.exit(1)


def num(v):
    return '%.9f' % v if math.isfinite(v) else 'nan'


def edge(v):
    if abs(abs(v) - math.pi) < 1e-9:
        return '-pi' if v < 0 else 'pi'
    return js_str(v)


def write(out, name, lines):
    path = os.path.join(out, name)
    with open(path, 'w', encoding='utf-8') as fh:
        fh.write('\n'.join(lines) + '\n')
    return path


def write_fes(out, s, name='fes.dat'):
    """The surface in PLUMED's own layout: the first variable runs fastest,
    and in two dimensions each block ends with a blank line."""
    v = s['variables']
    lines = ['#! FIELDS %s file.free' % ' '.join(v)]
    for k, var in enumerate(v):
        r = s['ranges'][k]
        n = len(s['x'] if k == 0 else s['y'])
        lines += ['#! SET min_%s %s' % (var, edge(r['min'])), '#! SET max_%s %s' % (var, edge(r['max'])),
                  '#! SET nbins_%s %d' % (var, n), '#! SET periodic_%s %s' % (var, 'true' if r['periodic'] else 'false')]
    if s.get('integrated'):
        lines += ['#! SET integrated %s' % ','.join(s['integrated']), '#! SET kT %s' % num(s['kT'])]
    if s['y'] is None:
        lines += ['%s %s' % (num(x), num(f)) for x, f in zip(s['x'], s['f'])]
    else:
        for j, y in enumerate(s['y']):
            lines += ['%s %s %s' % (num(x), num(y), num(s['f'][i, j])) for i, x in enumerate(s['x'])]
            lines.append('')
    return write(out, name, lines)


TOLD = {'plots': False}


class Plots:
    """matplotlib when it is there; otherwise nothing is drawn, once said."""

    def __init__(self, args):
        self.out = args.out
        self.fmt = args.format
        self.plt = None
        if args.no_plots:
            TOLD['plots'] = True
            return
        try:
            import matplotlib
            matplotlib.use('Agg')
            import matplotlib.pyplot as plt
            plt.rcParams.update({
                'figure.dpi': 150, 'savefig.dpi': 150, 'font.size': 10, 'axes.spines.top': False,
                'axes.spines.right': False, 'axes.grid': True, 'grid.color': '#e2e8f0',
                'grid.linewidth': 0.8, 'axes.edgecolor': '#94a3b8', 'axes.labelcolor': '#0f172a',
                'xtick.color': '#475569', 'ytick.color': '#475569', 'legend.frameon': False,
            })
            self.plt = plt
        except ImportError:
            pass

    def figure(self, height=3.2):
        if not self.plt:
            if not TOLD['plots']:
                warn('matplotlib is not installed, so the plots were skipped; the data files were written. '
                     'pip install matplotlib to draw them.')
                TOLD['plots'] = True
            return None, None
        fig, ax = self.plt.subplots(figsize=(6.4, height))
        return fig, ax

    def save(self, fig, name):
        path = os.path.join(self.out, '%s.%s' % (name, self.fmt))
        fig.tight_layout()
        fig.savefig(path)
        self.plt.close(fig)
        say('  wrote %s' % path)


def ramp(n):
    out = []
    for i in range(n):
        k = 1.0 if n == 1 else i / (n - 1)
        out.append(tuple((a + (b - a) * k) / 255 for a, b in zip(RAMP_FROM, RAMP_TO)))
    return out


def energy_of(args):
    e = args.energy
    for key in KB:
        if key.lower() == e.lower():
            return key
    fail('--energy must be one of %s.' % ', '.join(KB))


def kT_of(args):
    if not args.temp > 0:
        fail('--temp must be a temperature in kelvin above zero.')
    return KB[energy_of(args)] * args.temp


def split_list(text):
    return [x.strip() for x in str(text or '').split(',') if x.strip()]


def per_variable(text, count):
    """--min 0,-pi and the like: one value per variable, blank to leave it."""
    parts = [x.strip() for x in str(text).split(',')] if text is not None else []
    out = []
    for k in range(count):
        v = parts[k] if k < len(parts) else (parts[0] if len(parts) == 1 and count == 1 else '')
        out.append(constant(v) if v else None)
    return out


# ------------------------------------------------------------------ #
# Commands
# ------------------------------------------------------------------ #

def cmd_suggest(args, files=None):
    files = files or load(args.files, args.keep_overlap)
    non_negative = set(split_list(args.nonnegative))
    lines = ['#! FIELDS file value n mean sd min max sigma grid_min grid_max grid_bin drifting']
    for c in files:
        report_file(c)
        cols = value_columns(c)
        biased = bool(bias_column(c))
        say()
        head = ('Value', 'Mean', 'Std. dev.', 'Range seen', 'Sigma', 'Grid', '')
        rows = []
        notes = []
        for name in cols:
            period = c['periods'].get(name)
            s = suggest_bias(c['columns'][name], period, name in non_negative, args.sigma_fraction)
            drift = drift_of(c['columns'][name], period)
            summ = s['summary'] if s else column_summary(c['columns'][name], period)
            has = bool(s and s['sigma'])
            rows.append((name, fmt(summ['mean']), fmt(summ['sd']),
                         '%s to %s' % (fmt(summ['min']), fmt(summ['max'])),
                         s['sigma'] if has else '-',
                         '%s to %s, %s bins' % (s['min'], s['max'], s['bin']) if has else '-',
                         'still drifting' if drift['drifting'] else ''))
            for note in (s['notes'] if s else []):
                if note not in notes:
                    notes.append(note)
            lines.append(' '.join([c['name'].replace(' ', '_'), name, str(summ['n']), num(summ['mean']),
                                   num(summ['sd']), num(summ['min']), num(summ['max']),
                                   s['sigma'] if has else '-', s['min'] if has else '-',
                                   s['max'] if has else '-', s['bin'] if has else '-',
                                   'yes' if drift['drifting'] else 'no']))
        widths = [max(len(str(r[k])) for r in rows + [head]) for k in range(len(head))]
        for r in [head] + rows:
            say('  ' + '  '.join(str(v).ljust(widths[k]) for k, v in enumerate(r)).rstrip())
        say()
        if biased:
            say('This run was biased, so the spread of a biased variable is wider than its fluctuation in one '
                'basin. Take hill widths from a run with the method set to None.')
        else:
            say('Sigma is %s of the standard deviation. A variable marked as drifting had not settled, so its '
                'spread overstates its fluctuation: run longer, or use the last part of the run.'
                % ('half' if args.sigma_fraction == 0.5 else js_str(args.sigma_fraction)))
        for note in notes:
            say('- ' + note)
        say()
    say('  wrote %s' % write(args.out, 'suggest.dat', lines))


def surface_note(s, kT, energy):
    """What the surface is, in a sentence, with the sum_hills that gives it."""
    head = 'The surface is the negative sum of all %s hills' % '{:,}'.format(s['hills'])
    if not s['integrated']:
        return head + ', as plumed sum_hills gives it, with its lowest point at zero.'
    return ('%s over %s, with %s integrated out at kT = %s %s (each point -kT ln of the sum of exp(-F/kT) over '
            '%s), as plumed sum_hills --idw %s --kt %s gives it, with its lowest point at zero.'
            % (head, ' and '.join(s['variables'] + s['integrated']), ' and '.join(s['integrated']), fmt(kT), energy,
               ' and '.join(s['integrated']), ','.join(s['variables']), fmt(kT, 6)))


def cmd_fes(args, files=None):
    files = files or load(args.files, args.keep_overlap)
    for c in files:
        report_file(c)
        if file_kind(c['fields']) != 'hills':
            fail('%s is not a HILLS file: it has no height and sigma_ columns.' % c['name'])
    hills = pool(files)
    every = hills_variables(hills['fields'])
    if not every:
        fail('%s: no variable has a sigma_ column to go with it, so the hills cannot be summed.' % hills['name'])
    chosen = [v for v in (args.cv, args.cv2) if v]
    for v in chosen:
        if v not in every:
            fail('The hills have no variable "%s"; they are on %s.' % (v, ', '.join(every)))
    if not chosen:
        # As on the page: two variables give the surface over both.
        chosen = every[:2]
    energy = ENERGY_LABEL[energy_of(args)]
    kT = kT_of(args)
    plots = Plots(args)
    heights = hill_heights(hills)
    last_time = float(hills['columns']['time'][-1]) if 'time' in hills['columns'] else hills['rows']
    say()
    say('%s hills on %s, up to time %s%s.' % ('{:,}'.format(hills['rows']), ' and '.join(every), fmt(last_time, 5),
                                             ', bias factor %s' % fmt(heights['biasFactor']) if heights['tempered'] else ''))
    say(heights_verdict(heights))
    write(args.out, 'hill_heights.dat',
          ['#! FIELDS time height', '#! SET first %s' % num(heights['first']), '#! SET last %s' % num(heights['last']),
           '#! SET ratio %s' % num(heights['ratio'])] +
          ['%s %s' % (num(t), num(h)) for t, h in zip(heights['time'], heights['height'])])
    fig, ax = plots.figure(2.6)
    if fig:
        ax.plot(heights['time'], heights['height'], color=ACCENT, lw=1.6)
        ax.set_xlabel('Time (%s)' % args.time_unit)
        ax.set_ylabel('Hill height (%s)' % energy)
        plots.save(fig, 'hill_heights')

    bins = [int(b) for b in split_list(args.bins)] if args.bins else None
    los = per_variable(args.min, len(chosen))
    his = per_variable(args.max, len(chosen))
    ranges = {v: (los[k], his[k]) for k, v in enumerate(chosen)}
    if bins and len(bins) == 1 and len(chosen) == 2:
        bins = bins * 2
    if len(chosen) == 2:
        s = sum_hills(hills, chosen, bins or [100, 100], None, ranges, kT, args.integrate_bins)
        path = write_fes(args.out, s)
        say(surface_note(s, kT, energy))
        say('  wrote %s' % path)
        fig, ax = plots.figure(4.4)
        if fig:
            from matplotlib.colors import LinearSegmentedColormap
            cmap = LinearSegmentedColormap.from_list('fes', ['#143e69', '#6da5d6', '#f4f8fc'])
            ax.grid(False)
            mesh = ax.pcolormesh(s['x'], s['y'], s['f'].T, cmap=cmap, shading='auto')
            ax.contour(s['x'], s['y'], s['f'].T, levels=10, colors='#0f172a', linewidths=0.4, alpha=0.5)
            bar = fig.colorbar(mesh, ax=ax)
            bar.set_label('Free energy (%s)' % energy)
            bar.outline.set_visible(False)
            ax.set_xlabel(s['variables'][0])
            ax.set_ylabel(s['variables'][1])
            plots.save(fig, 'fes')
        return
    v = chosen[0]
    b = bins[0] if bins else 300
    s = sum_hills(hills, [v], b, None, ranges, kT, args.integrate_bins)
    say(surface_note(s, kT, energy))
    say('  wrote %s' % write_fes(args.out, s))
    slices = fes_over_time(hills, v, args.slices, b, *ranges[v], kT=kT, integrate_bins=args.integrate_bins)
    change = None
    if len(slices) >= 2:
        prev, last = slices[-2]['f'], slices[-1]['f']
        # Compare only where the surface is low enough to matter.
        low = last < 16 * kT
        change = float(np.abs(last[low] - prev[low]).max()) if low.any() else 0.0
    head = '#! FIELDS %s %s' % (v, ' '.join('file.free.%d' % (k + 1) for k in range(len(slices))))
    sets = ['#! SET time_%d %s' % (k + 1, num(sl['time'])) for k, sl in enumerate(slices)]
    sets += ['#! SET hills_%d %d' % (k + 1, sl['hills']) for k, sl in enumerate(slices)]
    if s['integrated']:
        sets += ['#! SET integrated %s' % ','.join(s['integrated']), '#! SET kT %s' % num(kT)]
    body = ['%s %s' % (num(x), ' '.join(num(sl['f'][i]) for sl in slices)) for i, x in enumerate(slices[0]['x'])] if slices else []
    say('  wrote %s' % write(args.out, 'fes_slices.dat', [head] + sets + body))
    say('Each slice sums the hills up to a time; slices that lie on top of one another say the surface has '
        'stopped changing.' + (' Over the last %s of the run it moved by at most %s %s where it is below 16 kT.'
                               % ('fifth' if len(slices) == 5 else '1/%d' % len(slices), fmt(change), energy)
                               if change is not None else ''))
    fig, ax = plots.figure(3.4)
    if fig:
        colours = ramp(len(slices))
        for k, sl in enumerate(slices):
            ax.plot(sl['x'], sl['f'], color=colours[k], lw=2.5 if k == len(slices) - 1 else 1.5,
                    label='to %s' % fmt(sl['time'], 4))
        ax.set_xlabel(v)
        ax.set_ylabel('Free energy (%s)' % energy)
        ax.legend(title='Hills summed', fontsize=8, title_fontsize=8, ncol=min(5, len(slices)),
                  loc='upper center', bbox_to_anchor=(0.5, -0.2))
        plots.save(fig, 'fes')


def cmd_reweight(args, files=None):
    files = files or load(args.files, args.keep_overlap)
    for c in files:
        report_file(c)
    groups = [pool(files)] if args.pool else files
    energy = ENERGY_LABEL[energy_of(args)]
    kT = kT_of(args)
    plots = Plots(args)
    lines = []
    fig, ax = plots.figure(3.2)
    colours = [ACCENT] if len(groups) == 1 else ramp(len(groups))
    for g, c in enumerate(groups):
        cols = value_columns(c)
        arg = args.arg or (cols[0] if cols else '')
        if arg not in c['columns']:
            fail('%s has no column "%s"; it has %s.' % (c['name'], arg, ', '.join(c['fields'])))
        biases = split_list(args.bias) or bias_columns(c)
        if not biases:
            fail('%s has no bias column to reweight with. Print the bias (for example metad.bias, or metad.rbias '
                 'with CALC_RCT) into it, or name the column with --bias.' % c['name'])
        for b in biases:
            if b not in c['columns']:
                fail('%s has no bias column "%s"; it has %s.' % (c['name'], b, ', '.join(c['fields'])))
        # Every bias the run applied, added up: a wall beside the metadynamics
        # pushed the run as much as the hills did.
        bias = ' + '.join(biases)
        rbias = any(b.endswith('.rbias') for b in biases)
        fraction = args.skip if args.skip is not None else (0.0 if rbias else 0.2)
        skip = int(fraction) if fraction >= 1 else int(math.floor(c['rows'] * fraction))
        los = per_variable(args.min, 1)
        his = per_variable(args.max, 1)
        bins = args.bins if isinstance(args.bins, int) else 60
        r = reweight(c['columns'][arg], total_bias(c, biases), kT, bins, skip, los[0], his[0],
                     c['periods'].get(arg))
        if not r:
            fail('%s: there is too little to reweight.' % c['name'])
        say()
        say('%s: each frame is weighted by exp(V/kT) with V from %s, at %s K (kT = %s %s). %s frames carry the '
            'weight of %s equally weighted ones.%s%s'
            % (c['name'], bias, js_str(args.temp), fmt(kT), energy, '{:,}'.format(r['frames']),
               '{:,}'.format(js_round(r['effective'])),
               (' The first %s frames are left out, since %s still grows there; print metad.rbias with CALC_RCT '
                'to use the whole run.' % ('{:,}'.format(skip), bias)) if skip and not rbias else
               (' The first %s frames are left out.' % '{:,}'.format(skip) if skip else ''),
               ' That is too few to trust the surface.' if r['effective'] < 50 else ''))
        name = 'fes_reweighted.dat' if len(groups) == 1 else 'fes_reweighted.%d.dat' % g
        lines = ['#! FIELDS %s file.free' % arg, '#! SET bias %s' % bias, '#! SET frames %d' % r['frames'],
                 '#! SET effective %s' % num(r['effective']), '#! SET kT %s' % num(kT), '#! SET skip %d' % skip]
        lines += ['%s %s' % (num(x), num(f)) for x, f in zip(r['x'], r['f'])]
        say('  wrote %s' % write(args.out, name, lines))
        if fig:
            ax.plot(r['x'], r['f'], color=colours[g], lw=2, marker='o', ms=3,
                    label=os.path.basename(c['name']) if len(groups) > 1 else None)
            ax.set_xlabel(arg)
            ax.set_ylabel('Free energy (%s)' % energy)
    if fig:
        if len(groups) > 1:
            ax.legend(fontsize=8)
        plots.save(fig, 'fes_reweighted')


def cmd_trace(args, files=None):
    files = files or load(args.files, args.keep_overlap)
    for c in files:
        report_file(c)
    plots = Plots(args)
    names = split_list(args.arg) or value_columns(files[0])
    if not names:
        fail('There is no value to draw.')
    if not plots.plt:
        plots.figure()
        return
    fig, axes = plots.plt.subplots(len(names), 1, figsize=(6.4, 2.2 * len(names) + 0.4), sharex=True, squeeze=False)
    colours = [ACCENT] if len(files) == 1 else ramp(len(files))
    for k, name in enumerate(names):
        ax = axes[k][0]
        for g, c in enumerate(files):
            if name not in c['columns']:
                fail('%s has no column "%s".' % (c['name'], name))
            y = c['columns'][name]
            x = c['columns'].get('time', np.arange(y.size))
            # A long run is thinned for drawing only.
            step = max(1, y.size // 20000)
            ax.plot(x[::step], y[::step], color=colours[g], lw=0.9,
                    label=os.path.basename(c['name']) if len(files) > 1 else None)
        ax.set_ylabel(name)
        if len(files) > 1 and k == 0:
            ax.legend(fontsize=8, ncol=min(4, len(files)))
    axes[-1][0].set_xlabel('Time (%s)' % args.time_unit if 'time' in files[0]['columns'] else 'Row')
    plots.save(fig, 'trace')


def cmd_work(args, files=None):
    paths = args.files if files is None else [c['name'] for c in files]
    raw = load(paths, keep_overlap=True)
    energy = ENERGY_LABEL[energy_of(args)]
    plots = Plots(args)
    for g, c in enumerate(raw):
        names = split_list(args.arg) or [f for f in c['fields'] if f.endswith('work')]
        if not names:
            fail('%s has no work column; print the work of the moving restraint (for example moving.work).'
                 % c['name'])
        if 'time' not in c['columns']:
            fail('%s has no time column, so its parts cannot be put in order.' % c['name'])
        cols = {}
        parts = 0
        t = None
        for name in names:
            if name not in c['columns']:
                fail('%s has no column "%s".' % (c['name'], name))
            t, w, parts = stitch_work(c, name)
            cols[name] = w
        say('%s: %s rows in %d part%s.%s' % (c['name'], '{:,}'.format(t.size), parts + 1, '' if parts == 0 else 's',
                                           ' The work of each continued part was added to the work before it, '
                                           'since PLUMED starts it at zero again.' if parts else ''))
        name = 'work.dat' if len(raw) == 1 else 'work.%d.dat' % g
        lines = ['#! FIELDS time %s' % ' '.join(names)]
        lines += ['%s %s' % (num(t[i]), ' '.join(num(cols[n][i]) for n in names)) for i in range(t.size)]
        say('  wrote %s' % write(args.out, name, lines))
        fig, ax = plots.figure(3.0)
        if fig:
            colours = [ACCENT] if len(names) == 1 else ramp(len(names))
            for k, n in enumerate(names):
                ax.plot(t, cols[n], color=colours[k], lw=1.4, label=n if len(names) > 1 else None)
            ax.set_xlabel('Time (%s)' % args.time_unit)
            ax.set_ylabel('Work (%s)' % energy)
            if len(names) > 1:
                ax.legend(fontsize=8)
            plots.save(fig, 'work' if len(raw) == 1 else 'work.%d' % g)


def cmd_all(args):
    files = load(args.files, args.keep_overlap)
    hills = [c for c in files if file_kind(c['fields']) == 'hills']
    colvars = [c for c in files if file_kind(c['fields']) == 'colvar']
    if colvars:
        say('== The variables ==')
        cmd_suggest(args, colvars)
        say()
        cmd_trace(args, colvars)
        for c in colvars:
            if bias_column(c):
                say('== Free energy, reweighted ==')
                cmd_reweight(args, [c])
                break
    if hills:
        say()
        say('== The bias ==')
        cmd_fes(args, hills)


def cmd_inspect(args):
    files = load(args.files, args.keep_overlap)
    out = []
    for c in files:
        t = c['columns'].get('time')
        out.append({
            'file': c['name'], 'kind': file_kind(c['fields']), 'fields': c['fields'], 'rows': c['rows'],
            'parts': c['parts'], 'headers': c['headers'], 'dropped': c['dropped'], 'overlap': c['overlap'],
            'skipped': c['skipped'],
            'cut': c['cut'], 'periods': c['periods'],
            'time': [float(t[0]), float(t[-1])] if t is not None and t.size else None,
            'errors': c['errors'],
        })
    if args.json:
        print(json.dumps(out, indent=1))
        return
    for c, o in zip(files, out):
        report_file(c)
        say('  %s; columns %s%s' % (o['kind'], ' '.join(o['fields']),
                                   '; time %s to %s' % (fmt(o['time'][0], 6), fmt(o['time'][1], 6)) if o['time'] else ''))


# ------------------------------------------------------------------ #
# Command line
# ------------------------------------------------------------------ #

COMMANDS = [
    ('all', 'everything the page shows, for any mix of COLVAR and HILLS files',
     'python3 analyse_plumed.py all COLVAR HILLS'),
    ('suggest', 'hill width (SIGMA) and grid of each variable, from a run with no bias',
     'python3 analyse_plumed.py suggest COLVAR --nonnegative d'),
    ('fes', 'free-energy surface from the hills, its change through the run, and the hill heights',
     'python3 analyse_plumed.py fes HILLS --cv d --slices 5'),
    ('reweight', 'free energy along any printed value of a biased run',
     'python3 analyse_plumed.py reweight COLVAR --arg d --bias metad.rbias'),
    ('trace', 'the printed values through the run',
     'python3 analyse_plumed.py trace COLVAR --arg d'),
    ('work', 'work of a steered run, carried across restarted parts',
     'python3 analyse_plumed.py work COLVAR --arg moving.work'),
    ('inspect', 'what a file holds: columns, rows, parts, rows dropped',
     'python3 analyse_plumed.py inspect HILLS --json'),
]


def parser():
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument('--temp', type=float, default=300.0, help='temperature in K (default 300)')
    common.add_argument('--energy', default='kj/mol', help='energy unit of the run: kj/mol, kcal/mol, eV or Ha')
    common.add_argument('--time-unit', default='ps', help='time unit of the run, for the axes (default ps)')
    common.add_argument('--out', default='.', help='directory for the files written (default: here)')
    common.add_argument('--no-plots', action='store_true', help='write the data files only')
    common.add_argument('--format', default='png', choices=['png', 'pdf', 'svg'], help='plot format')
    common.add_argument('--keep-overlap', action='store_true',
                        help='keep COLVAR rows a restarted part wrote again, instead of the newer copy only '
                             '(HILLS files always keep every hill, as PLUMED does)')
    common.add_argument('--quiet', action='store_true', help='print only warnings and errors')

    epilog = 'commands:\n' + '\n'.join('  %-9s %s\n  %-9s   e.g. %s' % (n, d, '', e) for n, d, e in COMMANDS)
    p = argparse.ArgumentParser(
        prog='analyse_plumed.py',
        description='Analyse what a PLUMED run wrote: hill widths and grids from a trial run, the free-energy '
                    'surface from HILLS, reweighting, and the work of a steered run. Restarted runs and '
                    'several walkers are read as one.',
        epilog=epilog, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest='command', metavar='command')

    def add(name, help_text):
        example = next(e for n, _, e in COMMANDS if n == name)
        return sub.add_parser(name, parents=[common], help=help_text, description='%s.\n\nExample: %s'
                              % (help_text[0].upper() + help_text[1:], example),
                              formatter_class=argparse.RawDescriptionHelpFormatter)

    a = add('all', COMMANDS[0][1])
    a.add_argument('files', nargs='+')
    a.add_argument('--nonnegative', default='', help='values that cannot be negative, comma-separated')
    a.add_argument('--sigma-fraction', type=float, default=0.5)
    a.add_argument('--arg', default='')
    a.add_argument('--cv', default='')
    a.add_argument('--cv2', default='')
    a.add_argument('--bins', default='')
    a.add_argument('--min', default=None)
    a.add_argument('--max', default=None)
    a.add_argument('--slices', type=int, default=5)
    a.add_argument('--integrate-bins', type=int, default=None)
    a.add_argument('--bias', default='')
    a.add_argument('--skip', type=float, default=None)
    a.add_argument('--pool', action='store_true')

    s = add('suggest', COMMANDS[1][1])
    s.add_argument('files', nargs='+', metavar='COLVAR')
    s.add_argument('--nonnegative', default='',
                   help='values that cannot be negative, such as distances: comma-separated names')
    s.add_argument('--sigma-fraction', type=float, default=0.5, help='SIGMA as a fraction of the standard deviation')

    f = add('fes', COMMANDS[2][1])
    f.add_argument('files', nargs='+', metavar='HILLS', help='one HILLS file, or one per walker')
    f.add_argument('--cv', default='', help='the variable to sum along (default: the first)')
    f.add_argument('--cv2', default='', help='a second variable, for a surface in two dimensions')
    f.add_argument('--bins', default='', help='points on each axis: 300 in one dimension, 100,100 in two')
    f.add_argument('--min', default=None, help='lower end of each axis, e.g. 0 or 0,-pi (periodic ones take their period)')
    f.add_argument('--max', default=None, help='upper end of each axis')
    f.add_argument('--slices', type=int, default=5, help='surfaces at this many times through the run')
    f.add_argument('--integrate-bins', type=int, default=None,
                   help='points on each axis of a variable integrated out (default %d)' % INTEGRATE_BINS)

    r = add('reweight', COMMANDS[3][1])
    r.add_argument('files', nargs='+', metavar='COLVAR')
    r.add_argument('--arg', default='', help='the value to reweight along (default: the first)')
    r.add_argument('--bias', default='',
                   help='the bias columns to add up, comma-separated (default: every *.rbias, and every *.bias '
                        'of an action with no *.rbias, such as the walls)')
    r.add_argument('--bins', type=int, default=60)
    r.add_argument('--skip', type=float, default=None,
                   help='frames to leave out at the start: a fraction below 1, a count from 1 up '
                        '(default 0 with *.rbias, 0.2 with *.bias)')
    r.add_argument('--min', default=None)
    r.add_argument('--max', default=None)
    r.add_argument('--pool', action='store_true', help='take several COLVAR files (walkers) together')

    t = add('trace', COMMANDS[4][1])
    t.add_argument('files', nargs='+', metavar='COLVAR')
    t.add_argument('--arg', default='', help='the values to draw, comma-separated (default: all)')

    w = add('work', COMMANDS[5][1])
    w.add_argument('files', nargs='+', metavar='COLVAR')
    w.add_argument('--arg', default='', help='the work columns (default: every column ending in work)')

    i = add('inspect', COMMANDS[6][1])
    i.add_argument('files', nargs='+')
    i.add_argument('--json', action='store_true', help='print the result as JSON')
    return p


def main(argv=None):
    global QUIET
    p = parser()
    args = p.parse_args(argv)
    if not args.command:
        p.print_help()
        return 1
    QUIET = args.quiet
    os.makedirs(args.out, exist_ok=True)
    if args.command == 'all':
        cmd_all(args)
    else:
        {'suggest': cmd_suggest, 'fes': cmd_fes, 'reweight': cmd_reweight, 'trace': cmd_trace,
         'work': cmd_work, 'inspect': cmd_inspect}[args.command](args)
    return 0


if __name__ == '__main__':
    sys.exit(main())
