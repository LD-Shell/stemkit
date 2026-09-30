import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pythonName, expressionToPython, generateFitScript } from '../src/core/fit-python.js';
import { FUNCTIONS, parseEquation, classify, compile } from '../src/core/expression.js';
import { defaultPlotStyle, normalisePlotStyle } from '../src/core/plot-style.js';

/* ------------------------------------------------------------------ *
 * Hand-built trees, in the shape parseEquation returns
 * ------------------------------------------------------------------ */

const n = (value) => ({ type: 'number', value, raw: String(value) });
const s = (name) => ({ type: 'symbol', name });
const bin = (op, left, right, implicit) => ({ type: 'binary', op, left, right, ...(implicit ? { implicit: true } : {}) });
const add = (a, b) => bin('+', a, b);
const sub = (a, b) => bin('-', a, b);
const mul = (a, b) => bin('*', a, b);
const div = (a, b) => bin('/', a, b);
const pow = (a, b) => bin('^', a, b);
const neg = (arg) => ({ type: 'unary', op: '-', arg });
const pos = (arg) => ({ type: 'unary', op: '+', arg });
const fn = (name, ...args) => ({ type: 'call', name, args });

/**
 * A spec from the equation as typed, read by the real parser: `settings`
 * gives each parameter's start, bounds or fixed value by name.
 */
function fromText(equation, settings, rest) {
  const parsed = parseEquation(equation);
  if (!parsed.ok) throw new Error(`${equation}: ${parsed.error.message}`);
  const roles = classify(parsed, rest.independent ? { independent: rest.independent } : {});
  return {
    equation,
    ast: parsed.ast,
    dependent: parsed.dependent,
    independent: roles.independent,
    parameters: roles.parameters.map((name) => ({ name, initial: 1, ...(settings[name] || {}) })),
    ...rest
  };
}

const py = (ast, names) => expressionToPython(ast, names || { a: 'a', b: 'b', c: 'c', x: 'x', t: 't', tau: 'tau', A: 'A', y0: 'y0' });

/* ------------------------------------------------------------------ *
 * Python, when it is installed
 * ------------------------------------------------------------------ */

const PYTHON = (() => {
  try {
    const r = spawnSync('python3', ['-c', 'import numpy, scipy, matplotlib'], { encoding: 'utf8', timeout: 60000 });
    return r.status === 0;
  } catch {
    return false;
  }
})();
const withPython = PYTHON ? test : test.skip;

function runPython(script, dir, files = {}) {
  writeFileSync(join(dir, 'fit.py'), script);
  Object.entries(files).forEach(([name, text]) => writeFileSync(join(dir, name), text));
  return new Promise((resolve) => {
    const child = spawn('python3', ['fit.py'], { cwd: dir, env: { ...process.env, MPLBACKEND: 'Agg' } });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr, dir }));
  });
}

/**
 * Appended to a script in the tests only: prints the fitted values at full
 * precision and what matplotlib actually drew, as JSON.
 */
const INSPECT = String.raw`

# --- test only: report what was drawn ---
import json as _json
from matplotlib.colors import to_hex as _hex
from matplotlib import font_manager as _fm
fig.canvas.draw()


def _axis(a, which):
    axis = a.xaxis if which == 'x' else a.yaxis
    lo, hi = sorted(a.get_xlim() if which == 'x' else a.get_ylim())
    pad = 1e-9 * (hi - lo)
    locs = [float(v) for v in axis.get_majorticklocs()]
    ticks = axis.get_major_ticks(len(locs))
    shown = [(v, t.label1.get_text()) for v, t in zip(locs, ticks) if lo - pad <= v <= hi + pad]
    major = ticks[0]
    minor_locs = [float(v) for v in axis.get_minorticklocs() if lo - pad <= v <= hi + pad]
    minor = axis.get_minor_ticks(1)[0]
    # Where the mirrored tick sits across the panel, in axes fractions: 1 is the top or the right.
    tick2 = major.tick2line
    far = a.transAxes.inverted().transform(tick2.get_transform().transform(np.column_stack(tick2.get_data())))[0]
    return {
        'scale': axis.get_scale(), 'lim': list(a.get_xlim() if which == 'x' else a.get_ylim()),
        'ticks': [v for v, _ in shown], 'labels': [t for _, t in shown],
        'offset': axis.get_offset_text().get_text(),
        'locator': type(axis.get_major_locator()).__name__,
        'formatter': type(axis.get_major_formatter()).__name__,
        'minorLocator': type(axis.get_minor_locator()).__name__,
        'minorTicks': len(minor_locs),
        'direction': major._tickdir, 'length': major._size, 'width': major._width,
        'mirror': [t.tick2line.get_visible() for t in ticks], 'minorMirror': minor.tick2line.get_visible(),
        'mirrorAt': float(far[1] if which == 'x' else far[0]), 'mirrorLabel': major.label2.get_visible(),
        'mirrorLength': tick2.get_markersize(), 'mirrorWidth': tick2.get_markeredgewidth(),
        'mirrorColor': _hex(tick2.get_color()),
        'tickColor': _hex(major.tick1line.get_color()), 'tickLabelColor': _hex(major.label1.get_color()),
        'minorTickColor': _hex(minor.tick1line.get_color()),
        'offsetColor': _hex(axis.get_offset_text().get_color()),
        'labelColor': _hex(axis.label.get_color()),
        'minorDirection': minor._tickdir, 'minorLength': minor._size, 'minorWidth': minor._width,
        'grid': major.gridline.get_visible(), 'gridColor': _hex(major.gridline.get_color()),
        'gridAlpha': major.gridline.get_alpha(), 'gridStyle': major.gridline.get_linestyle(),
        'gridWidth': major.gridline.get_linewidth(), 'minorGrid': minor.gridline.get_visible() and len(minor_locs) > 0,
        'tickSize': major.label1.get_fontsize(), 'label': axis.label.get_text(),
        'labelSize': axis.label.get_fontsize(), 'labelFamily': axis.label.get_family(),
    }


def _line(l):
    dashes = l._dash_pattern[1]
    return {
        'label': l.get_label(), 'color': _hex(l.get_color()), 'width': l.get_linewidth(),
        'style': l.get_linestyle(), 'dashes': list(dashes) if dashes else None,
        'marker': str(l.get_marker()), 'size': l.get_markersize(),
        'face': _hex(l.get_markerfacecolor()) if l.get_marker() not in ('None', None, '') else None,
        'edge': _hex(l.get_markeredgecolor()) if l.get_marker() not in ('None', None, '') else None,
        'alpha': l.get_alpha(), 'n': len(l.get_xdata()), 'edgeWidth': l.get_markeredgewidth(),
        'xs': [float(v) for v in (l.get_xdata()[:2].tolist() + l.get_xdata()[-2:].tolist())] if len(l.get_xdata()) > 3 else [],
    }


def _errorbar(c):
    _, caps, bars = c.lines
    # matplotlib draws each cap as a marker 2*capsize long: capsize is how far it reaches either side.
    return {
        'yerr': c.has_yerr, 'width': float(bars[0].get_linewidth()[0]), 'color': _hex(bars[0].get_color()[0]),
        'caps': len(caps), 'cap': caps[0].get_markersize() / 2 if caps else 0,
        'capThick': caps[0].get_markeredgewidth() if caps else None,
        'capColor': _hex(caps[0].get_markeredgecolor()) if caps else None,
    }


def _panel(a):
    return {
        'x': _axis(a, 'x'), 'y': _axis(a, 'y'), 'face': _hex(a.get_facecolor()),
        'position': list(a.get_position().bounds),
        'spines': {k: [sp.get_visible(), sp.get_linewidth(), _hex(sp.get_edgecolor())] for k, sp in a.spines.items()},
        'lines': [_line(l) for l in a.get_lines()],
        'bands': [{'color': _hex(c.get_facecolor()[0]), 'alpha': c.get_alpha(), 'label': c.get_label()}
                  for c in a.collections if type(c).__name__ in ('PolyCollection', 'FillBetweenPolyCollection')],
        'errorbars': [_errorbar(c) for c in a.containers if type(c).__name__ == 'ErrorbarContainer'],
        'title': a.title.get_text(), 'titleSize': a.title.get_fontsize(), 'titleColor': _hex(a.title.get_color()),
    }


_leg = fig.axes[0].get_legend()
_legend = None
if _leg is not None:
    _bb = _leg.get_window_extent()
    _legend = {
        'loc': _leg._loc, 'frame': _leg.get_frame_on(), 'face': _hex(_leg.get_frame().get_facecolor()),
        'texts': [t.get_text() for t in _leg.get_texts()], 'textColors': [_hex(t.get_color()) for t in _leg.get_texts()],
        'size': _leg.get_texts()[0].get_fontsize(),
        'extent': [_bb.x0 / fig.bbox.width, _bb.y0 / fig.bbox.height, _bb.x1 / fig.bbox.width, _bb.y1 / fig.bbox.height],
    }
print('@@FIGURE@@' + _json.dumps({
    'size': list(fig.get_size_inches()), 'face': _hex(fig.get_facecolor()),
    'panels': [_panel(a) for a in fig.axes], 'legend': _legend,
    'font': _fm.findfont(fig.axes[0].yaxis.label.get_fontproperties()),
    'legendCodes': dict(type(_leg).codes) if _leg is not None else None,
}))
print('@@POPT@@' + _json.dumps([float(v) for v in popt]))
print('@@STATS@@' + _json.dumps({'perr': [float(v) for v in perr], 'r2': float(r_squared), 'rmse': float(rmse),
                                 'chi2_red': float(chi2_red) if 'chi2_red' in globals() else None}))
`;

function figureOf(run) {
  const line = run.stdout.split('\n').find((l) => l.startsWith('@@FIGURE@@'));
  return line ? JSON.parse(line.slice('@@FIGURE@@'.length)) : null;
}

function poptOf(run) {
  const line = run.stdout.split('\n').find((l) => l.startsWith('@@POPT@@'));
  return line ? JSON.parse(line.slice('@@POPT@@'.length)) : null;
}

function statsOf(run) {
  const line = run.stdout.split('\n').find((l) => l.startsWith('@@STATS@@'));
  return line ? JSON.parse(line.slice('@@STATS@@'.length)) : null;
}

/** The parameter table the script prints: name → [value, stderr]. */
function tableOf(run) {
  const out = {};
  run.stdout.split('\n').forEach((l) => {
    const m = l.match(/^(\S+)\s+(\S+) ± (\S+)\s+\[/);
    if (m) out[m[1]] = [Number(m[2]), Number(m[3])];
    const f = l.match(/^(\S+)\s+(\S+)\s+\(fixed\)$/);
    if (f) out[f[1]] = [Number(f[2]), null];
  });
  return out;
}

const close = (a, b, rel) => Math.abs(a - b) <= rel * Math.max(Math.abs(a), Math.abs(b), 1e-300);

/* ------------------------------------------------------------------ *
 * pythonName
 * ------------------------------------------------------------------ */

describe('pythonName', () => {
  test('keeps readable names, including Greek letters', () => {
    expect(pythonName('A')).toBe('A');
    expect(pythonName('y0')).toBe('y0');
    expect(pythonName('k_1')).toBe('k_1');
    expect(pythonName('τ')).toBe('τ');
    expect(pythonName('Δ')).toBe('Δ');
  });

  test('renames keywords, builtins and the script\'s own names', () => {
    for (const name of ['lambda', 'len', 'sum', 'min', 'max', 'abs', 'pow', 'range', 'print', 'None', 'type']) {
      expect(pythonName(name)).toBe(name + '_');
    }
    for (const name of ['np', 'scipy', 'plt', 'matplotlib', 'popt', 'pcov', 'model', 'fig', 'ax', 'stats', 'ticker']) {
      expect(pythonName(name)).toBe(name + '_');
    }
  });

  test('is unique within the names already taken, and records its choice', () => {
    const taken = new Set();
    expect(pythonName('k', taken)).toBe('k');
    expect(pythonName('k', taken)).toBe('k_');
    expect(pythonName('lambda', taken)).toBe('lambda_');
    expect(pythonName('lambda_', taken)).toBe('lambda__');
    expect([...taken]).toEqual(['k', 'k_', 'lambda_', 'lambda__']);
  });

  test('normalises as Python does, so two spellings of one letter stay apart', () => {
    const taken = new Set();
    const micro = pythonName('µ', taken); // MICRO SIGN, which Python reads as Greek mu
    expect(micro).toBe('μ');
    expect(pythonName('μ', taken)).toBe('μ_');
  });

  test('replaces characters Python does not allow', () => {
    expect(pythonName("k'")).toBe('k_');
    expect(pythonName('E-a')).toBe('E_a');
    expect(pythonName('2x')).toBe('_2x');
    expect(pythonName('')).toBe('p');
  });

  withPython('gives identifiers Python accepts and does not reserve', () => {
    const names = ['A', 'τ', 'lambda', 'len', 'np', "k'", '2x', 'µ', 'λ₁', 'x²', 'class', 'Ω0'].map((v) => pythonName(v));
    const r = spawnSync('python3', ['-c', 'import json, keyword, sys; names = json.load(sys.stdin); print(all(n.isidentifier() and not keyword.iskeyword(n) for n in names))'],
      { input: JSON.stringify(names), encoding: 'utf8' });
    expect(r.stdout.trim()).toBe('True');
  });
});

/* ------------------------------------------------------------------ *
 * expressionToPython
 * ------------------------------------------------------------------ */

describe('expressionToPython', () => {
  test('writes the decay model as a person would', () => {
    expect(py(add(mul(s('A'), fn('exp', neg(div(s('t'), s('tau'))))), s('y0')))).toBe('A*np.exp(-t/tau) + y0');
  });

  test('brackets only where Python needs them to evaluate the same tree', () => {
    expect(py(sub(s('a'), sub(s('b'), s('c'))))).toBe('a - (b - c)');
    expect(py(sub(sub(s('a'), s('b')), s('c')))).toBe('a - b - c');
    expect(py(add(s('a'), add(s('b'), s('c'))))).toBe('a + (b + c)');
    expect(py(div(s('a'), mul(s('b'), s('c'))))).toBe('a/(b*c)');
    expect(py(mul(div(s('a'), s('b')), s('c')))).toBe('a/b*c');
    expect(py(mul(s('a'), div(s('b'), s('c'))))).toBe('a*(b/c)');
    expect(py(mul(add(s('a'), s('b')), s('c')))).toBe('(a + b)*c');
    expect(py(mul(s('a'), add(s('b'), s('c'))))).toBe('a*(b + c)');
    expect(py(add(mul(s('a'), s('b')), s('c')))).toBe('a*b + c');
  });

  test('turns ^ into ** with its right-to-left grouping', () => {
    expect(py(pow(s('x'), n(2)))).toBe('x**2');
    expect(py(pow(s('a'), pow(s('b'), s('c'))))).toBe('a**b**c');
    expect(py(pow(pow(s('a'), s('b')), s('c')))).toBe('(a**b)**c');
    expect(py(pow(n(2), mul(s('a'), s('b'))))).toBe('2**(a*b)');
    expect(py(pow(mul(s('a'), s('b')), n(2)))).toBe('(a*b)**2');
    expect(py(pow(fn('sqrt', s('x')), n(2)))).toBe('np.sqrt(x)**2');
  });

  test('gets unary minus right', () => {
    expect(py(neg(pow(s('x'), n(2))))).toBe('-x**2');
    expect(py(pow(neg(s('x')), n(2)))).toBe('(-x)**2');
    expect(py(pow(n(2), neg(s('x'))))).toBe('2**-x');
    expect(py(neg(add(s('a'), s('b'))))).toBe('-(a + b)');
    expect(py(neg(mul(s('a'), s('b'))))).toBe('-a*b');
    expect(py(mul(s('c'), neg(mul(s('a'), s('b')))))).toBe('c*(-a*b)');
    expect(py(pow(n(2), neg(mul(s('a'), s('b')))))).toBe('2**(-a*b)');
    expect(py(neg(neg(s('x'))))).toBe('-(-x)');
    expect(py(add(s('a'), neg(s('b'))))).toBe('a - b');
    expect(py(sub(s('a'), neg(s('b'))))).toBe('a + b');
    expect(py(sub(s('a'), neg(add(s('b'), s('c')))))).toBe('a + (b + c)');
    expect(py(pos(s('x')))).toBe('x');
    expect(py(mul(s('a'), neg(s('b'))))).toBe('a*-b');
  });

  test('writes implicit multiplication out', () => {
    expect(py(bin('*', n(2), s('x'), true))).toBe('2*x');
    expect(py(bin('*', s('a'), fn('sin', s('x')), true))).toBe('a*np.sin(x)');
  });

  test('writes numbers so that they read back exactly', () => {
    expect(py(n(0.1))).toBe('0.1');
    expect(py(n(1e-7))).toBe('1e-7');
    expect(py(n(6.022e23))).toBe('6.022e+23');
    expect(py(n(8.314))).toBe('8.314');
  });

  test('maps constants and user names', () => {
    expect(py(mul(n(2), s('pi')))).toBe('2*np.pi');
    expect(py(pow(s('e'), s('x')))).toBe('np.e**x');
    expect(expressionToPython(div(s('t'), s('τ')), new Map([['t', 't'], ['τ', 'τ']]))).toBe('t/τ');
    expect(expressionToPython(s('lambda'), { lambda: 'lambda_' })).toBe('lambda_');
    expect(() => expressionToPython(s('q'), {})).toThrow(/q/);
  });

  test('every function has a numpy or scipy.special spelling', () => {
    for (const [name, f] of Object.entries(FUNCTIONS)) {
      expect(typeof f.python).toBe('string');
      expect(f.python).toMatch(/^(np|scipy\.special)\.[A-Za-z_]\w*(\(\u2026(, [\w.]+)*\))?$/);
      const arity = Array.isArray(f.arity) ? f.arity[0] : f.arity;
      expect(py(fn(name, ...Array.from({ length: arity }, () => s('x'))))).toContain(f.python.replace(/\(.*$/, '('));
    }
  });

  withPython('every function computes in numpy what the page computes', () => {
    // Each function at points inside and outside its domain, in Python from
    // the generated code and in JavaScript from the page's own evaluator.
    const X = [0.3, 0.7, 2.5, -1.2, 0, 0.5, 1.5, -2.5, 3.7];
    const cases = [];
    for (const [name, f] of Object.entries(FUNCTIONS)) {
      const arity = Array.isArray(f.arity) ? f.arity[0] : f.arity;
      const ast = fn(name, ...[s('x'), s('y')].slice(0, arity));
      const run = compile(ast, ['x', 'y']);
      X.forEach((x) => cases.push({ name, code: py(ast, { x: 'x', y: 'y' }), x, y: 1.7, want: run([x, 1.7]) }));
    }
    const code = [
      'import json, sys', 'import numpy as np', 'import scipy.special', "np.seterr(all='ignore')",
      'out = []',
      'for c in json.load(sys.stdin):',
      "    x, y = np.float64(c['x']), np.float64(c['y'])",
      "    v = float(eval(c['code']))",
      "    out.append(v if np.isfinite(v) else str(v))",
      'print(json.dumps(out))'
    ].join('\n');
    const r = spawnSync('python3', ['-c', code], { input: JSON.stringify(cases), encoding: 'utf8' });
    expect(r.stderr).toBe('');
    const got = JSON.parse(r.stdout);
    cases.forEach((c, i) => {
      const g = typeof got[i] === 'string' ? Number(got[i].replace('inf', 'Infinity')) : got[i];
      const same = Object.is(g, c.want) || (Number.isNaN(g) && Number.isNaN(c.want))
        || Math.abs(g - c.want) <= 1e-10 * Math.max(1, Math.abs(c.want));
      if (!same) throw new Error(`${c.code} at x = ${c.x}: numpy ${g}, page ${c.want}`);
    });
  });

  test('reads equations as the parser does', () => {
    const cases = {
      'y = -x^2': '-x**2',
      'y = 2^-x': '2**-x',
      'y = t/2tau': 't/2*tau',
      'y = A(1 - exp(-k t))': 'A*(1 - np.exp(-k*t))',
      'y = (a+b)(c+d)': '(a + b)*(c + d)',
      'y = x²': 'x**2',
      'y = 2 pi x': '2*np.pi*x',
      'y = 1e-3x + 6.022e23': '1e-3*x + 6.022e23',
      'y = e^(-x)': 'np.e**-x',
      'y = x**2**3': 'x**2**3',
      'y = heaviside(x - x0)*a': 'np.heaviside(x - x0, 0.5)*a',
      'y = erf(x/w)': 'scipy.special.erf(x/w)',
      'y = min + (max - min)/(1 + exp(-(x - x0)/w))': 'min_ + (max_ - min_)/(1 + np.exp(-(x - x0)/w))'
    };
    for (const [text, want] of Object.entries(cases)) {
      const parsed = parseEquation(text);
      const roles = classify(parsed);
      const taken = new Set();
      const names = {};
      [...roles.independent, ...roles.parameters].forEach((v) => { names[v] = pythonName(v, taken); });
      expect([text, expressionToPython(parsed.ast, names)]).toEqual([text, want]);
    }
  });

  withPython('evaluates random trees to the same numbers as JavaScript', () => {
    // A small seeded generator, so a failure can be reproduced.
    let seed = 20260929;
    const rand = () => {
      seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = (a) => a[Math.floor(rand() * a.length)];
    const fns = ['exp', 'sin', 'cos', 'sqrt', 'abs', 'tanh', 'log', 'erf'].filter((k) => FUNCTIONS[k]);
    const leaf = () => (rand() < 0.6 ? s(pick(['a', 'b', 'c'])) : n(pick([0.5, 2, 3, 10, 0.001, 7.25])));
    const tree = (depth) => {
      if (depth === 0) return leaf();
      const r = rand();
      if (r < 0.15) return neg(tree(depth - 1));
      if (r < 0.25 && fns.length) return fn(pick(fns), tree(depth - 1));
      if (r < 0.35) return pow(tree(depth - 1), rand() < 0.5 ? n(pick([2, 3])) : s(pick(['a', 'b'])));
      return bin(pick(['+', '-', '*', '/']), tree(depth - 1), tree(depth - 1), rand() < 0.2);
    };
    // The page's own evaluator is the reference.
    const evaluate = (node) => compile(node, ['a', 'b', 'c'])([0.7, 1.3, 2.1]);
    const trees = Array.from({ length: 300 }, () => tree(1 + Math.floor(rand() * 4)));
    const codes = trees.map((t) => py(t));
    const script = [
      'import json, sys', 'import numpy as np', 'import scipy.special', "np.seterr(all='ignore')",
      'a, b, c = np.float64(0.7), np.float64(1.3), np.float64(2.1)',
      'out = []',
      'for code in json.load(sys.stdin):',
      '    try:',
      '        v = eval(code)',
      "        out.append(float(v) if np.isfinite(v) else str(float(v)))",
      '    except Exception:',
      "        out.append('error')",
      'print(json.dumps(out))'
    ].join('\n');
    const r = spawnSync('python3', ['-c', script], { input: JSON.stringify(codes), encoding: 'utf8' });
    const got = JSON.parse(r.stdout);
    let compared = 0;
    trees.forEach((t, i) => {
      const want = evaluate(t);
      if (got[i] === 'error') return;
      compared++;
      if (typeof got[i] === 'string') {
        expect([codes[i], String(want)]).toEqual([codes[i], got[i].replace('inf', 'Infinity').replace('nan', 'NaN')]);
      } else {
        const ok = Math.abs(got[i] - want) <= 1e-9 * Math.max(Math.abs(want), 1) || Object.is(got[i], want);
        if (!ok) throw new Error(`${codes[i]}: Python ${got[i]}, JavaScript ${want}`);
      }
    });
    expect(compared).toBeGreaterThan(250);
  });
});

/* ------------------------------------------------------------------ *
 * The script, as text
 * ------------------------------------------------------------------ */

const T = Array.from({ length: 30 }, (_, i) => i * 0.25);
const DECAY_Y = T.map((t, i) => 3 * Math.exp(-t / 1.5) + 0.5 + 0.02 * Math.sin(7 * i));
const decaySpec = (style = {}, extra = {}) => fromText('y = A*exp(-t/tau) + y0', { y0: { initial: 0 } }, {
  data: { columns: { t: T }, y: DECAY_Y, names: { t: 'Time (s)', y: 'Signal' } },
  style: normalisePlotStyle(style),
  ...extra
});

describe('generateFitScript', () => {
  test('writes f-strings that Python before 3.12 can read', () => {
    // Reusing an f-string's own quote inside a {field} is new in Python 3.12.
    const reused = (code) => code.split('\n').filter((line) => !line.trim().startsWith('#')).some((line) => {
      for (const m of line.matchAll(/(?<![\w'"])f(['"])/g)) {
        const quote = m[1];
        let depth = 0;
        for (let i = m.index + 2; i < line.length; i++) {
          const ch = line[i];
          if (depth === 0 && ch === quote) break;
          if (ch === '{') { if (depth === 0 && line[i + 1] === '{') i++; else depth++; }
          else if (ch === '}') { if (depth === 0 && line[i + 1] === '}') i++; else depth--; }
          else if (depth > 0 && ch === quote) return true;
        }
      }
      return false;
    });
    expect(reused("print(f'{'R':<9}')")).toBe(true);
    for (const make of Object.values(CASES)) expect(reused(generateFitScript(make()))).toBe(false);
  });

  test('is deterministic', () => {
    expect(generateFitScript(decaySpec())).toBe(generateFitScript(decaySpec()));
  });

  test('holds the data at full precision, wrapped', () => {
    const code = generateFitScript(decaySpec());
    DECAY_Y.forEach((v) => expect(code).toContain(String(v)));
    code.split('\n').forEach((line) => {
      if (/^\s+[\d.e+-]+(, [\d.e+-]+)*,$/.test(line)) expect(line.length).toBeLessThanOrEqual(88);
    });
  });

  test('leaves rows with a missing value out and says how many', () => {
    const y = DECAY_Y.slice();
    y[3] = NaN;
    y[5] = null;
    const code = generateFitScript(decaySpec({}, { data: { columns: { t: T }, y } }));
    expect(code).toContain('# 28 points; 2 rows with a blank or non-numeric value left out, as on the page.');
    expect(code).not.toMatch(/\bnan\b/);
    // As on the page, an uncertainty must be positive too.
    const sigma = T.map((_, i) => (i === 7 ? 0 : i === 9 ? -1 : i === 11 ? '' : 0.02));
    const weighted = generateFitScript(decaySpec({}, { data: { columns: { t: T }, y, sigma } }));
    expect(weighted).toContain('# 25 points; 2 rows with a blank or non-numeric value and 3 rows whose '
      + 'uncertainty was missing, zero or negative left out, as on the page.');
  });

  test('passes no bounds when there are none, so scipy uses Levenberg-Marquardt', () => {
    const code = generateFitScript(decaySpec());
    expect(code).toContain('popt, pcov = curve_fit(model, t, y, p0=p0, maxfev=20000)');
    expect(code).not.toContain('bounds=');
  });

  test('writes open bounds as infinity', () => {
    const spec = decaySpec();
    spec.parameters[1] = { name: 'tau', initial: 1, min: 0 };
    const code = generateFitScript(spec);
    expect(code).toContain('bounds = ([-np.inf, 0, -np.inf], [np.inf, np.inf, np.inf])');
    expect(code).toContain('bounds=bounds');
  });

  test('imports scipy.special only when the model uses it', () => {
    expect(generateFitScript(decaySpec())).not.toContain('scipy.special');
    if (FUNCTIONS.erf) {
      const spec = decaySpec({}, { ast: parseEquation('y = A*erf(t/tau) + y0').ast });
      expect(generateFitScript(spec)).toContain('import scipy.special');
    }
  });

  test('quotes the page\'s result as comments', () => {
    const code = generateFitScript(decaySpec({}, {
      fit: { parameters: [{ name: 'A', value: 3.00960123, stderr: 0.0103783 }], r2: 0.99970312 }
    }));
    expect(code).toContain('#   A = 3.0096 ± 0.01038');
    expect(code).toContain('#   R² = 0.999703');
  });

  test('keeps user text out of the code', () => {
    const code = generateFitScript(decaySpec({ title: "It's\nimport os", xLabel: '$\\tau$ (s)' }, { equation: 'y = A\nimport os' }));
    expect(code).not.toMatch(/^import os/m);
    expect(code).toContain("ax.set_title('It\\'s\\nimport os')");
    expect(code).toContain("set_xlabel(r'$\\tau$ (s)')");
  });

  test('renames symbols that clash with Python or the script', () => {
    const spec = fromText('np = lambda*exp(-x/popt) + len', {}, {
      data: { columns: { x: T }, y: DECAY_Y },
      style: defaultPlotStyle()
    });
    const code = generateFitScript(spec);
    expect(code).toContain('def model(x, lambda_, popt_, len_):');
    expect(code).toContain('    return lambda_*np.exp(-x/popt_) + len_');
    expect(code).toContain('np_ = np.array([');
  });

  test('saves at exactly the set size unless tight is asked for', () => {
    expect(generateFitScript(decaySpec())).toMatch(/^fig\.savefig\('fit\.pdf', dpi=300, transparent=False, bbox_inches='tight'\)$/m);
    const exact = generateFitScript(decaySpec({ export: { tight: false } }));
    expect(exact).toMatch(/^fig\.savefig\('fit\.pdf', dpi=300, transparent=False\)$/m);
  });

  test('names the band by its level unless it has a label', () => {
    expect(generateFitScript(decaySpec({ band: { show: true, level: 0.9 } }))).toContain("label='90% confidence band'");
    expect(generateFitScript(decaySpec({ band: { show: true, label: 'Model $\\pm$ 2σ' } }))).toContain("label=r'Model $\\pm$ 2σ'");
  });

  test('gives the marker edge width after errorbar(), which would also give it to the caps', () => {
    const spec = decaySpec({ data: { edgeWidth: 2, errorWidth: 0.5, capSize: 3 } });
    spec.data = { ...spec.data, sigma: T.map(() => 0.02) };
    const code = generateFitScript(spec);
    const call = code.slice(code.indexOf('data_points = ax.errorbar('), code.indexOf('data_points[0]'));
    expect(call).toContain('capthick=0.5');
    expect(call).not.toContain('markeredgewidth');
    expect(code).toContain('data_points[0].set_markeredgewidth(2)');
  });
});

/* ------------------------------------------------------------------ *
 * Running the scripts
 * ------------------------------------------------------------------ */

const ARRHENIUS_T = Array.from({ length: 10 }, (_, i) => 280 + 10 * i);
const ARRHENIUS_K = ARRHENIUS_T.map((T, i) => 1e4 * Math.exp(-30000 / (8.314 * T)) * (1 + 0.01 * Math.sin(3 * i)));
const GX = Array.from({ length: 41 }, (_, i) => -5 + 0.25 * i);
const GY = GX.map((x, i) => 2 * Math.exp(-((x - 0.3) ** 2) / (2 * 1.2 ** 2)) + 0.1 + 0.03 * Math.sin(5 * i));
const GS = GX.map((_, i) => 0.02 + 0.01 * Math.abs(Math.cos(i)));
const XY = [];
for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) XY.push([i * 0.5, j * 0.4]);
const Z = XY.map(([x, y], k) => 1.5 * x + 2 * Math.exp(-y) - 0.5 + 0.01 * Math.sin(11 * k));

const FULL_STYLE = normalisePlotStyle({
  title: 'Decay of $\\tau$', xLabel: 'Time (ms)', yLabel: 'Signal (a.u.)',
  fontFamily: 'serif', fontSize: 12, width: 5, height: 4, dpi: 200,
  yScale: 'log',
  yTicks: { mode: 'list', values: [0.5, 1, 2, 3], labels: ['½', 'one', '2', '$3$'], minor: true, direction: 'in', length: 5, width: 1, mirror: true },
  xTicks: { mode: 'auto', minor: true, format: 'sci', direction: 'inout', length: 4, width: 0.9, mirror: true },
  grid: { show: true, minor: true, color: '#999999', alpha: 0.4, style: 'dashed', width: 0.5 },
  data: { marker: 's', size: 5, color: '#2a9d8f', edgeColor: '#264653', edgeWidth: 0.5, alpha: 0.8, label: 'Measured' },
  fit: { color: '#e76f51', width: 1.5, style: 'dashed', label: 'Model', samples: 300 },
  band: { show: true, color: '#f4a261', alpha: 0.3, level: 0.9, label: 'Model, 90% band' },
  foreground: '#203040',
  residuals: { show: true, heightRatio: 0.35 },
  legend: { position: 'outside right', frame: false, fontSize: 9 },
  spines: { top: false, right: false, width: 1.2 },
  background: '#fbfaf5',
  export: { format: 'pdf', filename: 'decay_figure' }
});

const ARRHENIUS_STYLE = normalisePlotStyle({
  xLabel: 'T (K)', yLabel: 'k (1/s)',
  xLim: [270, 380], yLim: [0, null],
  xTicks: { mode: 'step', step: 20, direction: 'in' },
  yTicks: { mode: 'count', count: 4, format: '%.3f', direction: 'in' },
  data: { marker: '^', size: 8, color: '#6a4c93' },
  fit: { style: 'dotted', width: 2.5, color: '#1982c4' },
  legend: { position: 'lower right', frame: false, fontSize: 8 },
  fontFamily: 'monospace',
  background: '#f8f8f0',
  export: { format: 'pdf', filename: 'arrhenius', tight: false }
});

const SIGMOID_Y = T.map((x, i) => 0.2 + (1.8 - 0.2) / (1 + Math.exp(-(x - 3.5) / 0.6)) + 0.01 * Math.sin(3 * i));
const LX = Array.from({ length: 25 }, (_, i) => 0.01 * 10 ** (i / 6));
const LY = LX.map((x, i) => 2.5 * x ** 0.75 * (1 + 0.01 * Math.sin(5 * i)));

const LOGX_STYLE = normalisePlotStyle({
  xScale: 'log', yScale: 'log',
  xTicks: { mode: 'step', step: 1, minor: true },
  yTicks: { mode: 'count', count: 4, format: 'sci' },
  data: { marker: 'none', errorBars: true },
  fit: { style: 'dashdot', samples: 57 },
  legend: { show: false },
  export: { format: 'png', filename: 'power', transparent: true },
  dpi: 96
});

const BARE_STYLE = normalisePlotStyle({
  data: { show: false },
  fit: { label: '' },
  band: { show: true, level: 0.99 },
  residuals: { show: true, heightRatio: 0.5 },
  xLim: [-1, 8],
  xTicks: { mode: 'list', values: [0, 2.5, 5, 7.5], labels: ['zero', 'two and a half'] },
  yTicks: { format: '{:.2f}' },
  grid: { show: true, minor: true, style: 'dotted' },
  legend: { position: 'upper center' }
});

const EXACT_STYLE = normalisePlotStyle({
  width: 4.5, height: 3.5, dpi: 120,   // 540 x 420 pixels
  title: 'A peak in $\\mu$A', xLabel: 'Position (mm)', yLabel: 'Current (nA)',
  xTicks: { direction: 'in' },
  yTicks: { mirror: true, minor: true, format: 'sci', direction: 'inout', length: 5, width: 1.2 },
  data: { marker: 'D', size: 5, color: '#8338ec', edgeColor: '#3a0ca3', edgeWidth: 2.5, errorWidth: 0.75, capSize: 4 },
  band: { show: true, level: 0.68 },
  residuals: { show: true, heightRatio: 0.4 },
  legend: { position: 'upper left', fontSize: 8 },
  foreground: '#7a1f5c',
  export: { format: 'png', filename: 'exact', tight: false }
});

const CASES = {
  decay: () => decaySpec(),
  arrhenius: () => fromText('k = A*exp(-Ea/(R*T))', {
    A: { initial: 5000, min: 0, max: null },
    Ea: { initial: 25000, min: 0, max: 1e6 },
    R: { initial: 8.314, fixed: true }
  }, {
    data: { columns: { T: ARRHENIUS_T }, y: ARRHENIUS_K },
    style: ARRHENIUS_STYLE
  }),
  gaussian: () => fromText('y = A*exp(-(x - mu)^2/(2*sigma^2)) + c', { mu: { initial: 0 }, c: { initial: 0 } }, {
    data: { columns: { x: GX }, y: GY, sigma: GS },
    absoluteSigma: true,
    style: normalisePlotStyle({
      band: { show: true }, export: { format: 'png', filename: 'gauss', tight: false }, dpi: 150,
      data: { edgeWidth: 0, errorWidth: 1.5, capSize: 3 }, xTicks: { mirror: true }, foreground: '#333333'
    })
  }),
  twoVariables: () => fromText('z = a*x + b*exp(-y) + c', { c: { initial: 0 } }, {
    independent: ['x', 'y'],
    data: { columns: { x: XY.map((p) => p[0]), y: XY.map((p) => p[1]) }, y: Z },
    style: normalisePlotStyle({ residuals: { show: true }, band: { show: true }, xLabel: 'Predicted z', yLabel: 'Observed z', export: { format: 'svg', filename: 'pred' } })
  }),
  full: () => decaySpec(FULL_STYLE, {
    data: { columns: { t: T.map((v) => v * 1000) }, y: DECAY_Y },
    parameters: [{ name: 'A', initial: 1 }, { name: 'tau', initial: 1000 }, { name: 'y0', initial: 0 }]
  }),
  clash: () => fromText('np = lambda*exp(-x/τ) + len', { len: { initial: 0 } }, {
    data: { columns: { x: T }, y: DECAY_Y },
    style: normalisePlotStyle({ export: { format: 'png', filename: 'clash' }, dpi: 72 })
  }),
  sigmoid: () => fromText('y = min + (max - min)/(1 + exp(-(x - x0)/w))', {
    min: { initial: 0 }, max: { initial: 2 }, x0: { initial: 4 }, w: { initial: 1 }
  }, {
    data: { columns: { x: T }, y: SIGMOID_Y },
    style: normalisePlotStyle({ export: { format: 'svg', filename: 'sigmoid' } })
  }),
  logX: () => fromText('y = a*x^b', {}, {
    data: { columns: { x: LX }, y: LY, sigma: LY.map((v) => 0.02 * v) },
    style: LOGX_STYLE
  }),
  bare: () => decaySpec(BARE_STYLE),
  exact: () => fromText('y = A*exp(-(x - mu)^2/(2*sigma^2)) + c', { A: { initial: 1000 }, mu: { initial: 0 }, c: { initial: 0 } }, {
    data: { columns: { x: GX }, y: GY.map((v) => 1000 * v), sigma: GS.map((v) => 1000 * v) },
    style: EXACT_STYLE
  }),
  csv: () => ({
    ...decaySpec(),
    data: { columns: { t: [] }, y: [] },
    dataSource: { kind: 'csv', file: 'data.csv', columns: { t: 'time', y: 'signal', sigma: 'err' } }
  })
};

const CSV_TEXT = 'time, signal,err\n'
  + T.map((t, i) => `${t},${DECAY_Y[i]},0.02`).join('\n')
  + '\n7.5,,0.02\n7.75,abc,0.02\n';

const runs = {};

beforeAll(async () => {
  if (!PYTHON) return;
  await Promise.all(Object.entries(CASES).map(async ([name, make]) => {
    const dir = mkdtempSync(join(tmpdir(), `stemkit-fit-${name}-`));
    const script = generateFitScript(make()) + INSPECT;
    runs[name] = await runPython(script, dir, name === 'csv' ? { 'data.csv': CSV_TEXT } : {});
  }));
}, 180000);

afterAll(() => {
  Object.values(runs).forEach((r) => rmSync(r.dir, { recursive: true, force: true }));
});

const file = (name, f) => readFileSync(join(runs[name].dir, f));
/** The figure a case saved, under the name and format its style gives. */
const saved = (name) => {
  const { filename, format } = normalisePlotStyle(CASES[name]().style).export;
  return file(name, `${filename}.${format}`);
};

describe('the script runs', () => {
  withPython('without errors or warnings for every case', () => {
    for (const [name, r] of Object.entries(runs)) {
      expect([name, r.code, r.stderr]).toEqual([name, 0, '']);
    }
  });

  withPython('exponential decay: recovers the parameters and saves a PDF', () => {
    const table = tableOf(runs.decay);
    expect(table.A[0]).toBeCloseTo(3, 1);
    expect(table.tau[0]).toBeCloseTo(1.5, 1);
    expect(table.y0[0]).toBeCloseTo(0.5, 1);
    const popt = poptOf(runs.decay);
    ['A', 'tau', 'y0'].forEach((k, i) => expect(close(table[k][0], popt[i], 1e-5)).toBe(true));
    expect(file('decay', 'fit.pdf').subarray(0, 5).toString()).toBe('%PDF-');
    expect(runs.decay.stdout).toMatch(/^R²\s+0\.99/m);
  });

  withPython('Arrhenius: holds R fixed, respects the bounds', () => {
    const table = tableOf(runs.arrhenius);
    expect(table.R).toEqual([8.314, null]);
    expect(close(table.Ea[0], 30000, 0.02)).toBe(true);
    expect(close(table.A[0], 1e4, 0.3)).toBe(true);
    expect(poptOf(runs.arrhenius)).toHaveLength(2);
    const pdf = file('arrhenius', 'arrhenius.pdf');
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    // Not trimmed, so the page is exactly 6.4 x 4.8 in, in PostScript points.
    expect(pdf.toString('latin1')).toMatch(/MediaBox\s*\[\s*0 0 460\.8 345\.6\s*\]/);
  });

  withPython('Gaussian: sigma as absolute uncertainties, PNG at the chosen dpi', () => {
    const table = tableOf(runs.gaussian);
    expect(table.A[0]).toBeCloseTo(2, 1);
    expect(table.mu[0]).toBeCloseTo(0.3, 1);
    expect(Math.abs(table.sigma[0])).toBeCloseTo(1.2, 1);
    expect(table.c[0]).toBeCloseTo(0.1, 1);
    expect(runs.gaussian.stdout).toMatch(/^Reduced chi-squared\s+\d/m);
    const png = file('gaussian', 'gauss.png');
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const at = png.indexOf('pHYs');
    expect(at).toBeGreaterThan(0);
    expect(Math.round(png.readUInt32BE(at + 4) * 0.0254)).toBe(150);
    // Not trimmed, so the image is exactly 6.4 x 4.8 in at 150 dpi.
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([960, 720]);
    expectFigureMatches(figureOf(runs.gaussian), CASES.gaussian().style, { errorBars: true, range: [-5, 5], saved: saved('gaussian') });
  });

  withPython('two independent variables: predicted against observed, as SVG', () => {
    const table = tableOf(runs.twoVariables);
    expect(table.a[0]).toBeCloseTo(1.5, 1);
    expect(table.b[0]).toBeCloseTo(2, 1);
    expect(table.c[0]).toBeCloseTo(-0.5, 1);
    const svg = file('twoVariables', 'pred.svg').toString();
    expect(svg.slice(0, 600)).toContain('<svg');
    const fig = figureOf(runs.twoVariables);
    expect(fig.panels).toHaveLength(2);
    expect(fig.panels[0].bands).toEqual([]);
    const line = fig.panels[0].lines.find((l) => l.label === 'Fit');
    expect(line).toBeDefined();
  });

  withPython('names that clash with Python still run', () => {
    const table = tableOf(runs.clash);
    expect(table.lambda_[0]).toBeCloseTo(3, 1);
    expect(table['τ'][0]).toBeCloseTo(1.5, 1);
    expect(table.len_[0]).toBeCloseTo(0.5, 1);
  });

  withPython('builtins as parameter names: a sigmoid between min and max', () => {
    const table = tableOf(runs.sigmoid);
    expect(table.min_[0]).toBeCloseTo(0.2, 1);
    expect(table.max_[0]).toBeCloseTo(1.8, 1);
    expect(table.x0[0]).toBeCloseTo(3.5, 1);
    expect(table.w[0]).toBeCloseTo(0.6, 1);
    expect(file('sigmoid', 'sigmoid.svg').toString().slice(0, 600)).toContain('<svg');
  });

  withPython('reads a CSV file by its headers and leaves out incomplete rows', () => {
    expect(runs.csv.stdout).toContain('2 rows left out');
    const a = poptOf(runs.csv), b = poptOf(runs.decay);
    // The CSV adds sigma = 0.02 for every row: the same fit, weighted evenly.
    a.forEach((v, i) => expect(close(v, b[i], 1e-8)).toBe(true));
  });
});

/* ------------------------------------------------------------------ *
 * The same numbers as the page
 * ------------------------------------------------------------------ */

/** The page's fit of a spec, or null when the fit engine is not there yet. */
async function pageFit(spec) {
  let mod;
  try {
    mod = await import('../src/core/nonlinear-fit.js');
  } catch {
    return null;
  }
  return mod.fitModel({
    ast: spec.ast,
    independent: spec.independent,
    parameters: spec.parameters,
    columns: spec.data.columns,
    y: spec.data.y,
    sigma: spec.data.sigma,
    absoluteSigma: spec.absoluteSigma
  });
}

describe('the script reproduces the page\'s fit', () => {
  const cases = ['decay', 'arrhenius', 'gaussian', 'twoVariables', 'clash', 'sigmoid', 'logX', 'full', 'exact'];

  withPython.each(cases)('%s: values, R² and RMSE agree to 1e-6, standard errors to 1e-5', async (name) => {
    const fit = await pageFit(CASES[name]());
    if (!fit) return; // the fit engine is not in this tree yet
    expect(fit.ok).toBe(true);
    const popt = poptOf(runs[name]);
    const stats = statsOf(runs[name]);
    const free = fit.parameters.filter((p) => !p.fixed);
    expect(popt).toHaveLength(free.length);
    free.forEach((p, i) => {
      if (!close(popt[i], p.value, 1e-6)) throw new Error(`${name} ${p.name}: script ${popt[i]}, page ${p.value}`);
      // scipy's 'lm' covariance comes from MINPACK's forward-difference Jacobian and
      // the page's from exact derivatives: they agree to about 1e-6, not further.
      if (!close(stats.perr[i], p.stderr, 1e-5)) throw new Error(`${name} ${p.name} stderr: script ${stats.perr[i]}, page ${p.stderr}`);
    });
    expect(close(stats.r2, fit.r2, 1e-9)).toBe(true);
    expect(close(stats.rmse, fit.rmse, 1e-6)).toBe(true);
    if (stats.chi2_red !== null) expect(close(stats.chi2_red, fit.reducedChi2, 1e-6)).toBe(true);
  });

  withPython('starting from the page\'s result, when it is given, lands on the same values', async () => {
    const spec = CASES.gaussian();
    const fit = await pageFit(spec);
    if (!fit) return;
    const code = generateFitScript({ ...spec, fit });
    expect(code).toContain("# Starting values: the page's result");
    expect(code).toContain('# The starting values typed on the page were A = 1, mu = 0, sigma = 1, c = 0.');
    const dir = mkdtempSync(join(tmpdir(), 'stemkit-fit-seeded-'));
    try {
      const r = await runPython(code + INSPECT, dir);
      expect([r.code, r.stderr]).toEqual([0, '']);
      poptOf(r).forEach((v, i) => expect(close(v, fit.parameters[i].value, 1e-8)).toBe(true));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------------------------------ *
 * The figure the script draws matches the style
 * ------------------------------------------------------------------ */

const LINESTYLE = { solid: '-', dashed: '--', dotted: ':', dashdot: '-.' };

function expectFigureMatches(fig, style, opts = {}) {
  const st = normalisePlotStyle(style);
  expect(fig.size[0]).toBeCloseTo(st.width, 6);
  expect(fig.size[1]).toBeCloseTo(st.height, 6);
  expect(fig.face).toBe(st.background);
  expect(fig.panels).toHaveLength(st.residuals.show ? 2 : 1);
  const [main] = fig.panels;
  const bottom = fig.panels[fig.panels.length - 1];

  fig.panels.forEach((p) => {
    expect(p.face).toBe(st.background);
    expect(p.spines.top[0]).toBe(st.spines.top);
    expect(p.spines.right[0]).toBe(st.spines.right);
    Object.values(p.spines).forEach(([, w, colour]) => {
      expect(w).toBeCloseTo(st.spines.width, 6);
      expect(colour).toBe(st.foreground);
    });
    if (p.title) expect(p.titleColor).toBe(st.foreground);
    for (const k of ['x', 'y']) {
      const a = p[k], t = st[`${k}Ticks`];
      expect(a.direction).toBe(t.direction);
      expect(a.length).toBeCloseTo(t.length, 6);
      expect(a.width).toBeCloseTo(t.width, 6);
      expect(a.mirror.length).toBeGreaterThan(0);
      expect(a.mirror).toEqual(a.mirror.map(() => t.mirror));
      if (t.mirror) {
        // On the far side of the panel, drawn as the near ones are, without labels.
        expect(a.mirrorAt).toBeCloseTo(1, 6);
        expect(a.mirrorLength).toBeCloseTo(t.length, 6);
        expect(a.mirrorWidth).toBeCloseTo(t.width, 6);
        expect(a.mirrorColor).toBe(st.foreground);
        expect(a.mirrorLabel).toBe(false);
      }
      if (a.minorTicks > 0) {
        expect(a.minorMirror).toBe(t.mirror);
        expect(a.minorTickColor).toBe(st.foreground);
      }
      expect(a.tickColor).toBe(st.foreground);
      expect(a.tickLabelColor).toBe(st.foreground);
      expect(a.labelColor).toBe(st.foreground);
      if (a.offset) expect(a.offsetColor).toBe(st.foreground);
      if (t.minor) {
        expect(a.minorTicks).toBeGreaterThan(0);
        expect(a.minorLength).toBeGreaterThan(0);
        expect(a.minorDirection).toBe(t.direction);
      } else if (a.minorTicks > 0) {
        expect(a.minorLength).toBe(0);
      }
      expect(a.grid).toBe(st.grid.show);
      if (st.grid.show) {
        expect(a.gridColor).toBe(st.grid.color);
        expect(a.gridAlpha).toBeCloseTo(st.grid.alpha, 6);
        expect(a.gridStyle).toBe(LINESTYLE[st.grid.style]);
        expect(a.gridWidth).toBeCloseTo(st.grid.width, 6);
        if (st.grid.minor) expect(a.minorGrid).toBe(true);
      }
    }
  });

  // Scales, limits, labels and fonts.
  expect(main.x.scale).toBe(st.xScale);
  expect(main.y.scale).toBe(st.yScale);
  st.xLim.forEach((v, i) => { if (v !== null) expect(main.x.lim[i]).toBeCloseTo(v, 9); });
  st.yLim.forEach((v, i) => { if (v !== null) expect(main.y.lim[i]).toBeCloseTo(v, 9); });
  expect(bottom.x.label).toBe(st.xLabel);
  expect(main.y.label).toBe(st.yLabel);
  expect(main.title).toBe(st.title);
  expect(main.y.labelFamily).toEqual([st.fontFamily]);
  expect(main.y.labelSize).toBeCloseTo(st.fontSize, 6);
  expect(bottom.x.tickSize).toBeCloseTo(st.fontSize - 1, 6);
  expect(main.y.tickSize).toBeCloseTo(st.fontSize - 1, 6);
  expect(main.titleSize).toBeCloseTo(st.fontSize + 1, 6);

  // Ticks.
  for (const k of ['x', 'y']) {
    const t = st[`${k}Ticks`];
    const a = (k === 'x' ? bottom : main)[k];
    if (t.mode === 'list') {
      const lo = Math.min(...a.lim), hi = Math.max(...a.lim);
      const inView = t.values.map((v, i) => [v, i]).filter(([v]) => v >= lo && v <= hi);
      expect(a.ticks).toEqual(inView.map(([v]) => v));
      if (t.labels.length) expect(a.labels).toEqual(inView.map(([v, i]) => (i < t.labels.length ? t.labels[i] : String(v))));
    } else if (t.mode === 'step') {
      const log = st[`${k}Scale`] === 'log';
      const gaps = a.ticks.slice(1).map((v, i) => (log ? Math.log10(v / a.ticks[i]) : v - a.ticks[i]));
      gaps.forEach((g) => expect(g).toBeCloseTo(t.step, 9));
    } else if (t.mode === 'count') {
      expect(a.ticks.length).toBeLessThanOrEqual(t.count + 1);
      expect(a.locator).toBe(st[`${k}Scale`] === 'log' ? 'LogLocator' : 'MaxNLocator');
    }
    if (/%/.test(t.format) && !(t.mode === 'list' && t.labels.length)) {
      expect(a.formatter).toBe('FormatStrFormatter');
      const digits = Number((t.format.match(/\.(\d+)f/) || [])[1]);
      if (Number.isFinite(digits)) a.labels.forEach((text, i) => expect(text.replace('−', '-')).toBe(a.ticks[i].toFixed(digits)));
    }
    if (t.format === 'sci' && st[`${k}Scale`] === 'linear') {
      expect(a.formatter).toBe('ScalarFormatter');
      expect(a.offset).toMatch(/10\^\{\d+\}/);
    }
  }

  // Data, fit and band.
  const lines = main.lines;
  const data = lines.find((l) => l.marker === st.data.marker);
  if (st.data.show && st.data.marker !== 'none') {
    expect(data).toBeDefined();
    expect(data.size).toBeCloseTo(st.data.size, 6);
    expect(data.face).toBe(st.data.color);
    expect(data.edge).toBe(st.data.edgeColor);
    expect(data.alpha).toBeCloseTo(st.data.alpha, 6);
    expect(data.style).toBe('None');
    expect(data.edgeWidth).toBeCloseTo(st.data.edgeWidth, 6);
  }
  const expectErrorBars = (panel) => {
    if (!opts.errorBars) {
      expect(panel.errorbars).toEqual([]);
      return;
    }
    expect(panel.errorbars).toHaveLength(1);
    const [bar] = panel.errorbars;
    expect(bar.yerr).toBe(true);
    expect(bar.width).toBeCloseTo(st.data.errorWidth, 6);
    expect(bar.color).toBe(st.data.color);
    // capSize is how far each cap reaches either side of its bar, as capsize is to matplotlib.
    expect(bar.caps).toBe(st.data.capSize > 0 ? 2 : 0);
    expect(bar.cap).toBeCloseTo(st.data.capSize, 6);
    if (st.data.capSize > 0) {
      expect(bar.capThick).toBeCloseTo(st.data.errorWidth, 6);
      expect(bar.capColor).toBe(st.data.color);
    }
  };
  expectErrorBars(main);
  const bandLabel = st.band.label || `${+(st.band.level * 100).toFixed(1)}% confidence band`;
  if (st.fit.show) {
    const fit = opts.multi
      ? lines.find((l) => l.label === st.fit.label)
      : lines.find((l) => l.marker === 'None' && l.n === st.fit.samples);
    expect(fit).toBeDefined();
    expect(fit.color).toBe(st.fit.color);
    expect(fit.width).toBeCloseTo(st.fit.width, 6);
    expect(fit.style).toBe(LINESTYLE[st.fit.style]);
    expect(fit.marker).toBe('None');
    if (st.fit.style === 'dashed') expect(fit.dashes.map((v) => +(v / st.fit.width).toFixed(3))).toEqual([3.7, 1.6]);
    if (!opts.multi) {
      expect(fit.n).toBe(st.fit.samples);
      if (opts.range) {
        expect(fit.xs[0]).toBeCloseTo(opts.range[0], 9);
        expect(fit.xs[3]).toBeCloseTo(opts.range[1], 9);
      }
      if (st.xScale === 'log') expect(fit.xs[1] / fit.xs[0]).toBeCloseTo(fit.xs[3] / fit.xs[2], 9);
      else expect(fit.xs[1] - fit.xs[0]).toBeCloseTo(fit.xs[3] - fit.xs[2], 9);
    }
  }
  if (st.band.show && !opts.multi) {
    expect(main.bands).toHaveLength(1);
    expect(main.bands[0].color).toBe(st.band.color);
    expect(main.bands[0].alpha).toBeCloseTo(st.band.alpha, 6);
    expect(main.bands[0].label).toBe(bandLabel);
  }

  // Residuals below.
  if (st.residuals.show) {
    const [m, r] = [fig.panels[0].position, fig.panels[1].position];
    expect(r[3] / m[3]).toBeGreaterThan(st.residuals.heightRatio * 0.8);
    expect(r[3] / m[3]).toBeLessThan(st.residuals.heightRatio * 1.25);
    expect(r[1]).toBeLessThan(m[1]);
    expect(fig.panels[1].y.label).toBe('Residual');
    // The residuals are drawn as the data are, even when the data are hidden.
    const points = fig.panels[1].lines.find((l) => l.marker === st.data.marker);
    expect(points !== undefined).toBe(st.data.marker !== 'none');
    if (points) {
      expect(points.edge).toBe(st.data.edgeColor);
      expect(points.edgeWidth).toBeCloseTo(st.data.edgeWidth, 6);
    }
    expectErrorBars(fig.panels[1]);
  }

  // Legend.
  if (st.legend.show) {
    const leg = fig.legend;
    expect(leg).not.toBeNull();
    expect(leg.frame).toBe(st.legend.frame);
    // The legend box takes the figure's background, not matplotlib's white.
    expect(leg.face).toBe(st.background);
    expect(leg.size).toBeCloseTo(st.legend.fontSize, 6);
    if (st.legend.position === 'outside right') {
      expect(leg.extent[0]).toBeGreaterThan(main.position[0] + main.position[2]);
      expect(leg.extent[2]).toBeLessThanOrEqual(1.0001);
    } else {
      expect(leg.loc).toBe(fig.legendCodes[st.legend.position]);
    }
    const expected = [
      st.data.show && (st.data.marker !== 'none' || opts.errorBars) ? st.data.label : '',
      st.fit.show ? st.fit.label : '',
      st.band.show && !opts.multi ? bandLabel : ''
    ].filter(Boolean);
    expect(leg.texts).toEqual(expected);
    expect(leg.textColors).toEqual(expected.map(() => st.foreground));
  } else {
    expect(fig.legend).toBeNull();
  }

  // The saved file: exactly the set size, or with tight, fitted to what is drawn.
  if (opts.saved) {
    const { format, tight } = st.export;
    const perInch = format === 'png' ? st.dpi : 72;
    const exact = [st.width * perInch, st.height * perInch];
    const got = savedSize(opts.saved, format);
    expect(got).not.toBeNull();
    if (!tight) {
      if (format === 'png') expect(got).toEqual(exact.map(Math.round));
      else got.forEach((v, i) => expect(v).toBeCloseTo(exact[i], 3));
    } else {
      // matplotlib's 0.1 in margin around what is drawn: near the set size but not on it.
      expect(got.some((v, i) => Math.abs(v - exact[i]) >= 1)).toBe(true);
      got.forEach((v, i) => expect(Math.abs(v - exact[i])).toBeLessThan(0.3 * perInch));
    }
  }
}

/** The size of a saved figure: pixels for PNG, points for PDF and SVG. */
function savedSize(buf, format) {
  if (format === 'png') return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
  const text = buf.toString('latin1');
  const m = format === 'pdf'
    ? text.match(/MediaBox\s*\[\s*0 0 ([\d.]+) ([\d.]+)\s*\]/)
    : text.match(/<svg\b[^>]*?\swidth="([\d.]+)pt"[^>]*?\sheight="([\d.]+)pt"/);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

describe('the figure matches the style', () => {
  withPython('with the default style', () => {
    const fig = figureOf(runs.decay);
    expectFigureMatches(fig, decaySpec().style, { range: [0, 7.25], saved: saved('decay') });
    // No mirrored ticks unless asked for, and the default foreground.
    expect(fig.panels[0].x.mirror.some(Boolean) || fig.panels[0].y.mirror.some(Boolean)).toBe(false);
    expect(fig.panels[0].y.tickColor).toBe('#1a1a1a');
    expect(fig.panels[0].lines.find((l) => l.marker === 'o').edgeWidth).toBeCloseTo(1, 6);
  });

  withPython('with log axes, decade steps, markers off but error bars on, and no legend', () => {
    const fig = figureOf(runs.logX);
    expectFigureMatches(fig, LOGX_STYLE, { range: [LX[0], LX[LX.length - 1]], errorBars: true, saved: saved('logX') });
    expect(fig.panels[0].x.ticks.length).toBeGreaterThan(2);
    expect(fig.panels[0].errorbars.map((b) => b.yerr)).toEqual([true]);
    expect(fig.panels[0].errorbars[0]).toMatchObject({ caps: 0, cap: 0, width: 1 });
    expect(fig.panels[0].lines.some((l) => l.marker !== 'None' && l.label !== '_nolegend_' && l.n === LX.length && l.size > 0 && l.style === 'None' && l.face)).toBe(false);
    const png = file('logX', 'power.png');
    expect([...png.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  withPython('with the data hidden, short tick labels, a minor grid and the band alone in the legend', () => {
    const fig = figureOf(runs.bare);
    expectFigureMatches(fig, BARE_STYLE, { range: [-1, 8], saved: saved('bare') });
    expect(fig.panels[0].lines.filter((l) => l.marker !== 'None')).toEqual([]);
    expect(fig.panels[0].y.formatter).not.toBe('FormatStrFormatter');
    // A band with no label of its own is named by its level.
    expect(fig.legend.texts).toEqual(['99% confidence band']);
  });

  withPython('with log y, listed ticks, minor ticks, sci labels, grid, band, residuals and an outside legend', () => {
    const fig = figureOf(runs.full);
    expectFigureMatches(fig, FULL_STYLE, { saved: saved('full') });
    expect(fig.panels[0].y.minorLocator).toBe('LogLocator');
    expect(fig.panels[0].x.minorLocator).toBe('AutoMinorLocator');
    expect(fig.panels[0].spines.top[0]).toBe(false);
    expect(fig.font).toMatch(/Times|Nimbus ?Roman|Liberation ?Serif|DejaVu ?Serif/i);
    expect(file('full', 'decay_figure.pdf').subarray(0, 5).toString()).toBe('%PDF-');
    // Mirrored on both axes of both panels, though the top and right spines are hidden.
    fig.panels.forEach((p) => ['x', 'y'].forEach((k) => {
      expect(p[k].mirror.every(Boolean)).toBe(true);
      expect(p[k].mirrorAt).toBeCloseTo(1, 6);
    }));
    expect(fig.panels[0].y.minorMirror).toBe(true);
    expect(fig.panels[0].lines.find((l) => l.marker === 's').edgeWidth).toBeCloseTo(0.5, 6);
    expect(fig.legend.texts).toEqual(['Measured', 'Model', 'Model, 90% band']);
    expect(fig.legend.textColors).toEqual(['#203040', '#203040', '#203040']);
    expect(fig.panels[0].titleColor).toBe('#203040');
    expect(fig.panels[0].x.offsetColor).toBe('#203040');
  });

  withPython('with step and count ticks, a printf format, limits and a dotted fit', () => {
    const fig = figureOf(runs.arrhenius);
    expectFigureMatches(fig, ARRHENIUS_STYLE, { saved: saved('arrhenius') });
    expect(fig.panels[0].x.locator).toBe('MultipleLocator');
    expect(fig.font).toMatch(/Courier|Nimbus ?Mono|Liberation ?Mono|DejaVu ?Sans ?Mono/i);
  });

  withPython('with two independent variables', () => {
    expectFigureMatches(figureOf(runs.twoVariables), CASES.twoVariables().style, { multi: true, saved: saved('twoVariables') });
  });

  withPython('with mirrored y ticks, heavy marker edges, capped error bars on both panels, a foreground colour and the exact size', () => {
    const fig = figureOf(runs.exact);
    expectFigureMatches(fig, EXACT_STYLE, { errorBars: true, range: [-5, 5], saved: saved('exact') });
    // The same, spelled out, so that a slip shared by the script and the check above still shows.
    const fg = '#7a1f5c';
    fig.panels.forEach((p) => {
      expect(p.y.mirror.every(Boolean)).toBe(true);
      expect(p.y).toMatchObject({ mirrorLabel: false, minorMirror: true, mirrorColor: fg });
      expect(p.y.mirrorAt).toBeCloseTo(1, 6);
      expect(p.y.mirrorLength).toBeCloseTo(5, 6);
      expect(p.y.mirrorWidth).toBeCloseTo(1.2, 6);
      expect(p.x.mirror.some(Boolean)).toBe(false);
      expect(p.errorbars).toHaveLength(1);
      expect(p.errorbars[0]).toMatchObject({ caps: 2, cap: 4, capThick: 0.75, width: 0.75, capColor: '#8338ec' });
      expect(p.lines.find((l) => l.marker === 'D')).toMatchObject({ edgeWidth: 2.5, edge: '#3a0ca3' });
      Object.values(p.spines).forEach(([, , colour]) => expect(colour).toBe(fg));
      ['x', 'y'].forEach((k) => expect([p[k].tickColor, p[k].tickLabelColor, p[k].labelColor]).toEqual([fg, fg, fg]));
      expect(p.y.minorTickColor).toBe(fg);
    });
    const [main] = fig.panels;
    expect(main.titleColor).toBe(fg);
    expect(main.y.offset).toMatch(/10\^\{3\}/);
    expect(main.y.offsetColor).toBe(fg);
    expect(fig.legend.texts).toEqual(['Data', 'Fit', '68% confidence band']);
    expect(fig.legend.textColors).toEqual([fg, fg, fg]);
    // Not trimmed: 4.5 x 3.5 in at 120 dpi.
    expect(savedSize(saved('exact'), 'png')).toEqual([540, 420]);
  });
});

describe('grid lines along one axis and fonts of their own', () => {
  withPython('the fit\'s figure takes grid.axis, titleSize and tickSize', async () => {
    const style = normalisePlotStyle({ title: 'Decay', titleSize: 15, tickSize: 6, grid: { show: true, axis: 'x', minor: true }, xTicks: { minor: false } });
    const code = generateFitScript(decaySpec(style));
    expect(code).toMatch(/axes\.grid\(True, which='major', axis='x'/);
    expect(generateFitScript(decaySpec())).not.toMatch(/grid\(True, which='major', axis=/);
    const dir = mkdtempSync(join(tmpdir(), 'stemkit-fit-looks-'));
    try {
      const r = await runPython(code + INSPECT, dir);
      expect([r.code, r.stderr]).toEqual([0, '']);
      const [p] = figureOf(r).panels;
      expect(p.x.grid).toBe(true);
      expect(p.y.grid).toBe(false);
      expect(p.x.minorGrid).toBe(true);
      expect(p.y.minorTicks).toBe(0);
      expect(p.x.tickSize).toBeCloseTo(6, 6);
      expect(p.y.tickSize).toBeCloseTo(6, 6);
      expect(p.titleSize).toBeCloseTo(15, 6);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);
});
