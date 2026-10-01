/**
 * @module core/figure-python
 *
 * Writes the matplotlib script that draws a figure description (figure.js)
 * as the page previews it. The script runs as is with numpy and matplotlib
 * (scipy only for a box plot's confidence interval): it holds the data or
 * reads them from the person's own files, sets the fonts, sizes and colours
 * the page used, draws each series with the call a person would write, sets
 * the ticks, frame, grid, legend and colour bars, and saves the figure at the
 * size and resolution chosen.
 *
 * The page rewrites the script on every change, so generation is quick and
 * gives the same text for the same input. Every field of the description has
 * a matplotlib meaning here, written out as an explicit call so that a reader
 * can find the line to change. Numbers are written as the shortest text that
 * reads back as the same double.
 *
 * figureScript() writes the whole script. The pieces it is made of are
 * exported too (the rcParams block, subplots, one series, the axes, ticks,
 * frame, legend and save lines), so that a page with a script of its own
 * (the Curve Fitter's fit-python.js) draws its figure with the same code.
 *
 * Data: every data field of a series is embedded as a numpy array, unless
 * options.data is 'files' and the field names a column of one of the files in
 * options.files, or the field is a Python expression ({ py }) a prelude has
 * defined. Two readers are written when needed: read_csv (named columns of a
 * CSV file) and read_table (numbers in columns separated by spaces, as in
 * .xvg, .dat and PLUMED's COLVAR, where '#! FIELDS' names the columns).
 */

import { normaliseFigure, jitterOffsets, unitsPerInch } from './figure.js';
import { textSizes } from './plot-style.js';

/* ------------------------------------------------------------------ *
 * Python text
 * ------------------------------------------------------------------ */

/** push(...items) for arrays of any length. */
function append(target, items) {
  for (const v of items) target.push(v);
  return target;
}

/** A number as Python reads it back to the same double. */
export function pyNum(v) {
  const n = Number(v);
  if (n === Infinity) return 'np.inf';
  if (n === -Infinity) return '-np.inf';
  if (Number.isNaN(n)) return 'np.nan';
  return String(n);
}

/** A value rounded for a comment or a message. */
export function short(v, digits = 6) {
  const n = Number(v);
  return Number.isFinite(n) ? String(Number(n.toPrecision(digits))) : String(n);
}

/**
 * A Python string literal. Text with backslashes (LaTeX such as `$\tau$`)
 * is written raw so it reads as typed; anything a raw string cannot hold is
 * escaped instead.
 */
export function pyStr(s) {
  const text = String(s ?? '');
  if (text.includes('\\') && !/['\x00-\x1f\x7f]/.test(text) && !/\\$/.test(text)) return `r'${text}'`;
  return "'" + text
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    .replace(/[\x00-\x1f\x7f]/g, (c) => '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0')) + "'";
}

/** Text safe inside a `#` comment: one line, no control characters. */
export function comment(s) {
  return String(s ?? '').replace(/[\x00-\x1f\x7f\x85\u2028\u2029]+/g, ' ').trim();
}

/** Items joined with `, ` and wrapped at `width` characters, each line indented. */
export function wrapItems(items, indent, width = 88) {
  const lines = [];
  let line = '';
  for (const item of items) {
    const next = line ? `${line}, ${item}` : item;
    if (line && indent.length + next.length + 1 > width) {
      lines.push(indent + line + ',');
      line = item;
    } else {
      line = next;
    }
  }
  if (line) lines.push(indent + line + ',');
  return lines;
}

/** `name = np.array([...], dtype=float)`, on one line if it fits. */
export function pyArray(name, values) {
  const items = values.map(pyNum);
  const one = `${name} = np.array([${items.join(', ')}], dtype=float)`;
  if (one.length <= 88) return [one];
  const out = [`${name} = np.array([`];
  append(out, wrapItems(items, '    '));
  out.push('], dtype=float)');
  return out;
}

/** `name = np.array([[...], ...], dtype=float)`: a grid, one row per line or wrapped. */
function pyGrid(name, rows) {
  const lines = [`${name} = np.array([`];
  for (const row of rows) {
    const items = row.map(pyNum);
    const one = `    [${items.join(', ')}],`;
    if (one.length <= 88) lines.push(one);
    else { lines.push('    ['); append(lines, wrapItems(items, '        ')); lines.push('    ],'); }
  }
  lines.push('], dtype=float)');
  return lines;
}

/** `head[items]tail`, with the items wrapped onto indented lines when long. */
export function pyWrappedList(head, items, tail) {
  const one = `${head}[${items.join(', ')}]${tail}`;
  if (one.length <= 88) return [one];
  const out = [`${head}[`];
  append(out, wrapItems(items, '    '));
  out.push(`]${tail}`);
  return out;
}

/** A call whose keyword arguments wrap onto continuation lines past 88 characters. */
export function pyCall(head, args, indent = '') {
  const one = `${indent}${head}(${args.join(', ')})`;
  if (one.length <= 88) return [one];
  const lines = [];
  let line = `${indent}${head}(`;
  const pad = ' '.repeat(line.length);
  args.forEach((arg, i) => {
    const piece = arg + (i < args.length - 1 ? ',' : ')');
    if (line.trim().endsWith('(') || line.length + 1 + piece.length <= 88) {
      line += (line.endsWith('(') ? '' : ' ') + piece;
    } else {
      lines.push(line);
      line = pad + piece;
    }
  });
  lines.push(line);
  return lines;
}

/** A long comment wrapped at 88 characters. */
export function wrapComment(text) {
  const out = [];
  let line = '#';
  for (const word of comment(text).split(' ')) {
    if (line.length > 1 && line.length + 1 + word.length > 88) {
      out.push(line);
      line = '#';
    }
    line += ' ' + word;
  }
  out.push(line);
  return out;
}

export function round3(v) {
  return Math.round(v * 1000) / 1000;
}

const printfConversion = /%[-+ 0#]*\d*(?:\.\d+)?[diouxXeEfFgG]/g;

/** A printf format with exactly one conversion, as FormatStrFormatter wants, or null. */
export function printfFormat(format) {
  if (!format || format === 'sci') return null;
  const rest = format.replace(/%%/g, '');
  const conversions = rest.match(printfConversion) || [];
  if (conversions.length !== 1) return null;
  if (rest.replace(printfConversion, '').includes('%')) return null;
  return format;
}

/** The default text of a tick at `v` when the user gave fewer labels than values. */
function tickText(v) {
  return String(Number(Number(v).toPrecision(12)));
}

const KEYWORDS = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue',
  'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in',
  'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield',
  'match', 'case', 'type', '_', 'abs', 'all', 'any', 'bool', 'dict', 'filter', 'float', 'format', 'id',
  'input', 'int', 'iter', 'len', 'list', 'map', 'max', 'min', 'next', 'object', 'open', 'pow', 'print',
  'range', 'round', 'set', 'slice', 'sorted', 'str', 'sum', 'tuple', 'zip'
]);
/** The names the script uses itself. */
export const FIGURE_SCRIPT_NAMES = Object.freeze([
  'np', 'plt', 'matplotlib', 'ticker', 'stats', 'csv', 'fig', 'ax', 'axes', 'spine', 'formatter', 'cbar',
  'read_csv', 'read_table', 'to_grid', 'counts', 'edges', 'SHOW_BACKENDS'
]);

/**
 * The names Python lines assign at any depth: assignment targets (tuples and
 * augmented assignments too), def and class, for and with ... as, and
 * imports. The script's own names keep clear of them.
 *
 * @param {string[]} lines
 * @returns {Set<string>}
 */
export function assignedNames(lines) {
  const out = new Set();
  const names = (text) => String(text).split(',').map((t) => t.trim().replace(/^\*/, '')).filter((t) => /^[A-Za-z_]\w*$/.test(t));
  for (const raw of lines || []) {
    const line = String(raw).replace(/#.*$/, '').trim();
    if (!line) continue;
    let m = line.match(/^\(?([A-Za-z_]\w*(?:\s*,\s*\*?[A-Za-z_]\w*)*)\s*,?\)?\s*(?:[-+*/%@&|^]|\/\/|\*\*|<<|>>)?=(?!=)/);
    if (m) names(m[1]).forEach((n) => out.add(n));
    m = line.match(/^(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/);
    if (m) out.add(m[1]);
    m = line.match(/^for\s+\(?(.+?)\)?\s+in\b/);
    if (m) names(m[1]).forEach((n) => out.add(n));
    for (const a of line.matchAll(/\bas\s+([A-Za-z_]\w*)/g)) out.add(a[1]);
    m = line.match(/^import\s+(.+)$/);
    if (m) m[1].split(',').forEach((part) => { const t = part.trim(); if (!/\bas\b/.test(t)) out.add(t.split('.')[0]); });
    m = line.match(/^from\s+\S+\s+import\s+\(?([^)]*)\)?$/);
    if (m) m[1].split(',').forEach((part) => { const t = part.trim(); if (t && !/\bas\b/.test(t) && t !== '*') out.add(t); });
  }
  return out;
}

/* Python's own modules: not something a person installs. */
const STDLIB = new Set(['csv', 'json', 'os', 'sys', 'math', 'gzip', 're', 'io', 'pathlib', 'glob', 'itertools', 'collections',
  'functools', 'statistics', 'datetime', 'time', 'random', 'warnings', 'typing', 'string', 'bz2', 'lzma', 'zipfile', 'shutil',
  'copy', 'textwrap', 'fractions', 'decimal', 'operator', 'dataclasses', 'argparse', 'pickle', 'struct']);

/** The packages Python lines import, in order: 'scipy' for `from scipy import stats`. */
export function importedPackages(lines) {
  const out = [];
  for (const raw of lines || []) {
    const line = String(raw).replace(/#.*$/, '').trim();
    const m = line.match(/^import\s+(.+)$/) || line.match(/^from\s+([\w.]+)\s+import\b/);
    if (!m) continue;
    const mods = line.startsWith('import') ? m[1].split(',').map((t) => t.trim().split(/\s+/)[0]) : [m[1]];
    for (const mod of mods) {
      const top = mod.split('.')[0];
      if (top && !STDLIB.has(top) && !out.includes(top)) out.push(top);
    }
  }
  return out;
}

/**
 * A readable Python identifier for `name`, unique within `taken` (which
 * records it): letters, digits and _, never a keyword, a builtin or a name
 * the script uses itself.
 */
export function identifier(name, taken = new Set()) {
  let id = String(name ?? '').normalize('NFKC').replace(/[^\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}]+/gu, '_').replace(/^_+|_+$/g, '');
  if (!id) id = 'data';
  if (!/^[\p{L}\p{Nl}_]/u.test(id)) id = '_' + id;
  const base = id;
  let k = 2;
  while (KEYWORDS.has(id) || FIGURE_SCRIPT_NAMES.includes(id) || taken.has(id)) id = `${base}_${k++}`;
  taken.add(id);
  return id;
}

/* ------------------------------------------------------------------ *
 * The figure's parts in matplotlib terms
 * ------------------------------------------------------------------ */

/** Fonts tried in order for each family, the browser's usual choices first. */
export const FONT_LISTS = {
  'sans-serif': ['Arial', 'Helvetica', 'Liberation Sans', 'DejaVu Sans'],
  serif: ['Times New Roman', 'Times', 'Nimbus Roman', 'Liberation Serif', 'DejaVu Serif'],
  monospace: ['Courier New', 'Courier', 'Nimbus Mono PS', 'Liberation Mono', 'DejaVu Sans Mono']
};

/**
 * The rcParams block: fonts, sizes and colours as the page has them, and
 * text kept as text in PDF, PostScript and SVG.
 *
 * @param {string[]} L - lines, appended to
 * @param {object} s - a plot style or a normalised figure (the look fields)
 */
export function rcLines(L, s) {
  // mathtext reads fontconfig patterns, where '-' separates a size: 'sans' it is.
  const mathFamily = { 'sans-serif': 'sans', serif: 'serif', monospace: 'monospace' }[s.fontFamily];
  const size = textSizes(s);
  if (s.titleSize === null || s.titleSize === undefined) {
    if (s.tickSize === null || s.tickSize === undefined) {
      L.push('# Fonts: the axis labels at the size you set, tick labels 1 pt smaller, the title');
      L.push('# 1 pt larger. Text between $ signs is set as mathematics in the same font.');
    } else {
      L.push('# Fonts: the axis labels, the tick labels and the title at the sizes you set (the');
      L.push('# title 1 pt larger than the labels). Text between $ signs is set as mathematics.');
    }
  } else {
    L.push('# Fonts: the axis labels, the tick labels and the title at the sizes you set.');
    L.push('# Text between $ signs is set as mathematics in the same font.');
  }
  L.push('plt.rcParams.update({');
  L.push(`    'font.family': ${pyStr(s.fontFamily)},`);
  L.push(`    'font.${s.fontFamily}': [${FONT_LISTS[s.fontFamily].map(pyStr).join(', ')}],`);
  L.push(`    'mathtext.fontset': 'custom', 'mathtext.rm': ${pyStr(mathFamily)},`);
  L.push(`    'mathtext.it': ${pyStr(mathFamily + ':italic')}, 'mathtext.bf': ${pyStr(mathFamily + ':bold')},`);
  L.push(`    'mathtext.sf': ${pyStr(mathFamily)}, 'mathtext.tt': 'monospace', 'mathtext.cal': ${pyStr(mathFamily)},`);
  L.push(`    'font.size': ${pyNum(s.fontSize)}, 'axes.labelsize': ${pyNum(s.fontSize)}, 'axes.titlesize': ${pyNum(size.title)},`);
  L.push(`    'xtick.labelsize': ${pyNum(size.tick)}, 'ytick.labelsize': ${pyNum(size.tick)},`);
  L.push(`    'legend.fontsize': ${pyNum(s.legend.fontSize)},`);
  // The legend's face otherwise comes from axes.facecolor, which stays white
  // however the axes are painted: light text on a white box on a dark figure.
  L.push(`    'legend.facecolor': ${pyStr(s.background)},`);
  L.push('    # The foreground colour: all text, tick marks and tick labels, and the frame.');
  const fg = pyStr(s.foreground);
  L.push(`    'text.color': ${fg}, 'axes.labelcolor': ${fg}, 'axes.edgecolor': ${fg},`);
  L.push(`    'xtick.color': ${fg}, 'ytick.color': ${fg},`);
  L.push("    'pdf.fonttype': 42,        # TrueType in PDF and PostScript: text stays text");
  L.push("    'ps.fonttype': 42,");
  L.push("    'svg.fonttype': 'none',    # SVG text stays editable");
  L.push('})');
}

/**
 * `fig, ax = plt.subplots(...)`: the panels stacked, sharing x, at their
 * height ratios, with constrained layout and the figure's background.
 *
 * @param {string[]} L
 * @param {object} s - the look (width, height, background)
 * @param {string[]} names - a Python name for each panel's axes
 * @param {number[]} [ratios] - the panels' height ratios
 */
export function subplotsLines(L, s, names, ratios = names.map(() => 1)) {
  const args = [];
  const many = names.length > 1;
  if (many) args.push(String(names.length), '1', 'sharex=True');
  args.push(`figsize=(${pyNum(s.width)}, ${pyNum(s.height)})`, "layout='constrained'");
  if (many) args.push(`gridspec_kw={'height_ratios': [${ratios.map(pyNum).join(', ')}]}`);
  args.push(`facecolor=${pyStr(s.background)}`);
  L.push(...pyCall(many ? `fig, (${names.join(', ')}) = plt.subplots` : `fig, ${names[0]} = plt.subplots`, args));
}

/* The keyword arguments shared by the artists of a series. */
const kw = (k, v) => `${k}=${v}`;
const colourArg = (k, c) => kw(k, pyStr(c));

/**
 * The lines that draw one series on the axes `ax`.
 *
 * @param {string[]} L
 * @param {object} q - a normalised series (figure.js), or the fields its kind uses
 * @param {string} ax - the axes' Python name
 * @param {object} c - the Python text of its data fields (x, y, lower, upper, xerr, yerr,
 *   values, z, groups…), and: handle (a name to keep the artist under, for the legend),
 *   markerName (a name for an errorbar container whose marker edge is set after),
 *   zorder, labelled (whether to pass the label), fig (the figure, for box plots)
 * @returns {{handle: string|null, mappable: string|null}} the name the legend and the
 *   colour bar use
 */
export function seriesLines(L, q, ax, c) {
  const z = c.zorder !== undefined && c.zorder !== null ? [kw('zorder', pyNum(c.zorder))] : [];
  const label = c.labelled && q.label ? [kw('label', pyStr(q.label))] : [];
  const alpha = (a) => (a === 1 ? [] : [kw('alpha', pyNum(a))]);
  const lineArgs = (color, width, style) => [colourArg('color', color), kw('linewidth', pyNum(width)), kw('linestyle', pyStr(style))];
  const handle = c.handle || null;
  switch (q.kind) {
    case 'line': {
      const args = [c.x, c.y, ...lineArgs(q.color, q.lineWidth, q.lineStyle)];
      if (q.marker && q.marker !== 'none') args.push(kw('marker', pyStr(q.marker)), kw('markersize', pyNum(q.size)));
      if (q.step) args.push(kw('drawstyle', pyStr(`steps-${q.step}`)));
      args.push(...alpha(q.alpha), ...label, ...z);
      L.push(...pyCall(`${handle ? `${handle}, = ` : ''}${ax}.plot`, args));
      return { handle, mappable: null };
    }
    case 'scatter': case 'errorbar': {
      const markerOn = q.marker !== 'none';
      const hasErr = q.kind === 'errorbar' && (c.yerr || c.xerr);
      if (hasErr) {
        const args = [c.x, c.y];
        if (c.yerr) args.push(kw('yerr', c.yerr));
        if (c.xerr) args.push(kw('xerr', c.xerr));
        args.push(kw('fmt', pyStr(markerOn ? q.marker : 'none')));
        if (markerOn) {
          args.push(kw('markersize', pyNum(q.size)), colourArg('color', q.color), colourArg('markeredgecolor', q.edgeColor));
        }
        args.push(colourArg('ecolor', q.color), kw('elinewidth', pyNum(q.errorWidth)), kw('capsize', pyNum(q.capSize)));
        if (q.capSize > 0) args.push(kw('capthick', pyNum(q.errorWidth)));
        if (q.lineStyle && q.lineStyle !== 'none') {
          args.push(kw('linestyle', pyStr(q.lineStyle)), kw('linewidth', pyNum(q.lineWidth)));
          if (!markerOn) args.push(colourArg('color', q.color));
        }
        args.push(kw('alpha', pyNum(q.alpha)), ...label, ...z);
        const name = handle || (markerOn ? c.markerName : null);
        L.push(...pyCall(`${name ? `${name} = ` : ''}${ax}.errorbar`, args));
        if (markerOn) {
          L.push("# The markers' edge width, set here: given to errorbar() it would set the caps' too.");
          L.push(`${name}[0].set_markeredgewidth(${pyNum(q.edgeWidth)})`);
        }
        return { handle, mappable: null };
      }
      const args = [c.x, c.y, "linestyle='none'", kw('marker', pyStr(markerOn ? q.marker : 'o')), kw('markersize', pyNum(q.size)),
        colourArg('color', q.color), colourArg('markeredgecolor', q.edgeColor), kw('markeredgewidth', pyNum(q.edgeWidth)),
        kw('alpha', pyNum(q.alpha)), ...label, ...z];
      L.push(...pyCall(`${handle ? `${handle}, = ` : ''}${ax}.plot`, args));
      return { handle, mappable: null };
    }
    case 'band': {
      const args = [c.x, c.lower, c.upper, colourArg('color', q.color), kw('alpha', pyNum(q.alpha)), kw('linewidth', pyNum(q.edgeWidth || 0)), ...label, ...z];
      L.push(...pyCall(`${handle ? `${handle} = ` : ''}${ax}.fill_between`, args));
      return { handle, mappable: null };
    }
    case 'bar': {
      const args = [c.x, c.y, kw('width', pyNum(q.barWidth || q.width))];
      if (q.bottom) args.push(kw('bottom', pyNum(q.bottom)));
      args.push(colourArg('color', q.color), colourArg('edgecolor', q.edgeColor), kw('linewidth', pyNum(q.edgeWidth)), ...alpha(q.alpha));
      if (c.yerr) {
        args.push(kw('yerr', c.yerr), kw('capsize', pyNum(q.capSize)),
          `error_kw=dict(ecolor=${pyStr(q.errorColor)}, elinewidth=${pyNum(q.errorWidth)}, capthick=${pyNum(q.errorWidth)})`);
      }
      args.push(...label, ...z);
      L.push(...pyCall(`${handle ? `${handle} = ` : ''}${ax}.bar`, args));
      return { handle, mappable: null };
    }
    case 'histogram': {
      const look = [...alpha(q.alpha), ...label, ...z];
      if (q.histtype === 'bar') {
        L.push(...pyCall(`${handle ? `${handle} = ` : ''}${ax}.bar`, [`${c.edges}[:-1]`, c.counts, kw('width', `np.diff(${c.edges})`), "align='edge'",
          colourArg('color', q.color), colourArg('edgecolor', q.edgeColor), kw('linewidth', pyNum(q.edgeWidth)), ...look]));
      } else if (q.histtype === 'step') {
        L.push(...pyCall(`${handle ? `${handle} = ` : ''}${ax}.stairs`, [c.counts, c.edges, 'fill=False', colourArg('edgecolor', q.edgeColor),
          kw('linewidth', pyNum(q.edgeWidth)), ...look]));
      } else {
        L.push(...pyCall(`${handle ? `${handle} = ` : ''}${ax}.stairs`, [c.counts, c.edges, 'fill=True', colourArg('facecolor', q.color),
          colourArg('edgecolor', q.edgeWidth > 0 ? q.edgeColor : q.color), kw('linewidth', pyNum(q.edgeWidth)), ...look]));
      }
      return { handle, mappable: null };
    }
    case 'box': {
      const positions = `[${q.groups.map((g) => pyNum(g.position)).join(', ')}]`;
      const lw = pyNum(q.lineWidth);
      const col = pyStr(q.color);
      L.push(`# Quartiles, the median, whiskers to the last value within ${short(q.whis)} × IQR of the box${q.fliers ? ', and the values beyond' : ''}.`);
      L.push(...pyCall(`${ax}.boxplot`, [c.groups, kw('positions', positions), kw('widths', pyNum(q.width)), kw('whis', pyNum(q.whis)),
        'patch_artist=True', kw('showfliers', q.fliers ? 'True' : 'False'),
        `boxprops=dict(facecolor=matplotlib.colors.to_rgba(${col}, ${pyNum(q.faceAlpha)}), edgecolor=${col}, linewidth=${lw})`,
        `whiskerprops=dict(color=${col}, linewidth=${lw})`, `capprops=dict(color=${col}, linewidth=${lw})`,
        `medianprops=dict(color=${pyStr(q.medianColor)}, linewidth=${lw})`,
        `flierprops=dict(marker=${pyStr(q.marker)}, markersize=${pyNum(q.pointSize + 2)}, markerfacecolor='none', markeredgecolor=${col})`,
        kw('manage_ticks', c.categorical ? 'True' : 'False'), ...z]));
      if (q.points || q.mean) {
        // The loop's own names start with _, so a page's prelude keeps its names.
        L.push(`for _position, _values in zip(${positions}, ${c.groups}):`);
        if (q.points) {
          L.push(`    # Each value, spread across ${short(q.jitter * 100)}% of the box's width the same way every time.`);
          L.push(`    _jitter = (np.arange(len(_values)) * 0.6180339887498949 % 1 - 0.5) * ${pyNum(q.jitter * q.width)}`);
          L.push(...pyCall(`${ax}.plot`, ['_position + _jitter', '_values', "linestyle='none'", kw('marker', pyStr(q.marker)),
            kw('markersize', pyNum(q.pointSize)), kw('color', col), 'markeredgewidth=0', 'alpha=0.6', ...z], '    '));
        }
        if (q.mean) {
          const pct = short(q.level * 100, 4);
          L.push(`    # The mean and its ${pct}% confidence interval (Student's t)${q.meanOffset ? ', beside the box' : ''}.`);
          L.push('    _mean = _values.mean()');
          L.push(`    _half = ${c.statsName || 'stats'}.t.ppf(${pyNum((1 + q.level) / 2)}, len(_values) - 1) * _values.std(ddof=1) / np.sqrt(len(_values)) if len(_values) > 1 else 0`);
          L.push(...pyCall(`${ax}.errorbar`, [q.meanOffset ? `_position + ${pyNum(q.meanOffset)}` : '_position', '_mean', 'yerr=_half', "fmt='D'",
            kw('markersize', pyNum(q.pointSize + 1)), colourArg('markerfacecolor', c.fig.background), colourArg('markeredgecolor', c.fig.foreground),
            'markeredgewidth=1', colourArg('ecolor', c.fig.foreground), kw('elinewidth', lw), 'capsize=0',
            ...(c.zorder !== undefined && c.zorder !== null ? [kw('zorder', pyNum(c.zorder + 0.1))] : [])], '    '));
        }
      }
      return { handle: null, mappable: null };
    }
    case 'heatmap': {
      const args = [c.x, c.y, c.z, kw('cmap', pyStr(q.colormap))];
      if (q.vmin !== null) args.push(kw('vmin', pyNum(q.vmin)));
      if (q.vmax !== null) args.push(kw('vmax', pyNum(q.vmax)));
      args.push("shading='nearest'", ...alpha(q.alpha), ...z);
      const name = c.mappableName || 'mesh';
      L.push(...pyCall(`${name} = ${ax}.pcolormesh`, args));
      return { handle: null, mappable: name };
    }
    case 'contour': {
      const levels = Array.isArray(q.levels) ? `[${q.levels.map(pyNum).join(', ')}]` : pyNum(q.levels);
      const args = [c.x, c.y, c.z, kw('levels', levels)];
      if (q.filled || !q.colors) args.push(kw('cmap', pyStr(q.colormap)));
      else args.push(colourArg('colors', q.colors));
      if (q.vmin !== null) args.push(kw('vmin', pyNum(q.vmin)));
      if (q.vmax !== null) args.push(kw('vmax', pyNum(q.vmax)));
      if (!q.filled) args.push(kw('linewidths', pyNum(q.lineWidth)), kw('linestyles', pyStr(q.lineStyle)));
      args.push(...alpha(q.alpha), ...z);
      const name = c.mappableName || 'contours';
      L.push(...pyCall(`${name} = ${ax}.${q.filled ? 'contourf' : 'contour'}`, args));
      if (q.filled && q.lineWidth > 0) {
        L.push(...pyCall(`${ax}.contour`, [name, colourArg('colors', q.colors || '#000000'), kw('linewidths', pyNum(q.lineWidth)), ...z]));
      }
      return { handle: null, mappable: name };
    }
    case 'hline': case 'vline': {
      const args = [pyNum(q.kind === 'hline' ? q.y : q.x), ...lineArgs(q.color, q.lineWidth, q.lineStyle), ...alpha(q.alpha), ...label, ...z];
      L.push(...pyCall(`${handle ? `${handle} = ` : ''}${ax}.ax${q.kind}`, args));
      return { handle, mappable: null };
    }
    case 'axline': {
      const pt = (p) => `(${pyNum(p[0])}, ${pyNum(p[1])})`;
      const where = q.points.length > 1 ? [pt(q.points[0]), pt(q.points[1])] : [pt(q.points[0]), kw('slope', pyNum(q.slope))];
      L.push(...pyCall(`${handle ? `${handle} = ` : ''}${ax}.axline`, [...where, ...lineArgs(q.color, q.lineWidth, q.lineStyle), ...alpha(q.alpha), ...label, ...z]));
      return { handle, mappable: null };
    }
    case 'text': {
      const rotated = q.rotation === 90;
      const args = [pyNum(q.x), pyNum(q.y), pyStr(q.text), kw('ha', pyStr(rotated ? 'center' : q.ha)), kw('va', pyStr(rotated ? 'center' : q.va)),
        kw('fontsize', pyNum(q.fontSize)), colourArg('color', q.color)];
      if (rotated) args.push('rotation=90');
      if (q.coords === 'axes') args.push(kw('transform', `${ax}.transAxes`));
      args.push('zorder=6');
      L.push(...pyCall(`${ax}.text`, args));
      return { handle: null, mappable: null };
    }
    case 'bracket': {
      const top = `${pyNum(q.y + q.height)}`;
      L.push(...pyCall(`${ax}.plot`, [`[${pyNum(q.x1)}, ${pyNum(q.x1)}, ${pyNum(q.x2)}, ${pyNum(q.x2)}]`,
        `[${pyNum(q.y)}, ${top}, ${top}, ${pyNum(q.y)}]`, colourArg('color', q.color), kw('linewidth', pyNum(q.lineWidth)), ...alpha(q.alpha), ...z]));
      if (q.text) {
        L.push(...pyCall(`${ax}.text`, [pyNum((q.x1 + q.x2) / 2), top, pyStr(q.text), "ha='center'", "va='bottom'",
          kw('fontsize', pyNum(q.fontSize)), colourArg('color', q.color), 'zorder=6']));
      }
      return { handle: null, mappable: null };
    }
    default:
      return { handle: null, mappable: null };
  }
}

/**
 * Locator and formatter lines for one axis.
 *
 * @param {string[]} L
 * @param {{k: 'x'|'y', axis: string, T: object, log: boolean, note?: string,
 *   minorAlso?: string[], gridMinor?: boolean}} a - `axis` is the Axis in Python
 *   ('ax.xaxis'), `note` goes in the comment, `minorAlso` are other Axis objects
 *   that take the minor locator (a panel below that shares the tick look)
 */
export function tickLines(L, a) {
  const { T, log } = a;
  const axis = a.axis;
  const out = [];
  let describe = '';

  if (T.mode === 'step' && T.step) {
    if (log) {
      describe = T.step === 1 ? 'a tick every decade' : `a tick every ${short(T.step)} decades`;
      out.push(`${axis}.set_major_locator(ticker.LogLocator(base=${T.step === 1 ? '10' : `10**${pyNum(T.step)}`}, numticks=1000))`);
    } else {
      describe = `a tick every ${short(T.step)}`;
      out.push(`${axis}.set_major_locator(ticker.MultipleLocator(${pyNum(T.step)}))`);
    }
  } else if (T.mode === 'count' && T.count) {
    describe = `about ${T.count} ticks`;
    out.push(log
      ? `${axis}.set_major_locator(ticker.LogLocator(numticks=${T.count}))`
      : `${axis}.set_major_locator(ticker.MaxNLocator(nbins=${T.count}))`);
  } else if (T.mode === 'list' && T.values.length) {
    describe = a.categories ? 'one tick for each group' : 'ticks at the values you listed';
    out.push(...pyWrappedList(`${axis}.set_major_locator(ticker.FixedLocator(`, T.values.map(pyNum), '))'));
    if (T.labels.length && T.labels.some((t) => t !== '')) {
      const labels = T.values.map((v, i) => (i < T.labels.length ? T.labels[i] : tickText(v)));
      out.push(...pyWrappedList(`${axis}.set_major_formatter(ticker.FixedFormatter(`, labels.map(pyStr), '))'));
    }
  }

  const labelled = T.mode === 'list' && T.values.length && T.labels.some((t) => t !== '');
  if (!labelled && T.format) {
    const printf = printfFormat(T.format);
    if (T.format === 'sci') {
      describe += (describe ? ', ' : '') + 'labels in scientific notation';
      if (log) {
        out.push(`${axis}.set_major_formatter(ticker.LogFormatterSciNotation())`);
      } else {
        out.push('formatter = ticker.ScalarFormatter(useMathText=True)');
        out.push('formatter.set_scientific(True)');
        out.push('formatter.set_powerlimits((0, 0))  # always a power of ten at the end of the axis');
        out.push(`${axis}.set_major_formatter(formatter)`);
      }
    } else if (printf) {
      describe += (describe ? ', ' : '') + `labels as ${printf}`;
      out.push(`${axis}.set_major_formatter(ticker.FormatStrFormatter(${pyStr(printf)}))`);
    } else {
      out.push(`# (The tick format ${comment(JSON.stringify(T.format))} is not a printf format such as '%.2f', so matplotlib chooses.)`);
    }
  }

  if (log && out.some((line) => !line.startsWith('#'))) {
    // On a short log axis matplotlib labels the minor ticks as well; once the
    // major ticks or their format are chosen, only the major ticks are labelled.
    out.push(`${axis}.set_minor_formatter(ticker.NullFormatter())`);
  }

  const minorLocated = !a.categories && (T.minor || a.gridMinor);
  if (minorLocated) {
    describe += (describe ? ', ' : '') + (T.minor ? 'minor ticks between' : 'minor grid lines between');
    if (log) {
      out.push(`${axis}.set_minor_locator(ticker.LogLocator(subs='auto'))`);
    } else {
      out.push(`${axis}.set_minor_locator(ticker.AutoMinorLocator())`);
    }
    for (const other of a.minorAlso || []) out.push(`${other}.set_minor_locator(ticker.AutoMinorLocator())`);
  }

  if (!out.length) return;
  L.push(`# ${a.k} axis${a.note || ''}: ${describe || 'ticks as matplotlib chooses'}.`);
  L.push(...out);
  L.push('');
}

/** Whether the grid has lines along axis k ('x': at the x ticks). */
export function gridOn(s, k) {
  return !s.grid.axis || s.grid.axis === 'both' || s.grid.axis === k;
}

/**
 * The tick_params, frame and grid lines inside the loop over the panels.
 *
 * @param {string[]} L
 * @param {object} s - the look (background, spines, grid)
 * @param {{x: object, y: object, xLog: boolean, yLog: boolean, categorical?: boolean}} t - the
 *   tick settings and scales that decide the minor ticks
 * @param {string} indent
 */
export function frameBody(L, s, t, indent = '    ') {
  L.push(`${indent}axes.set_facecolor(${pyStr(s.background)})`);
  L.push(`${indent}axes.spines['top'].set_visible(${s.spines.top ? 'True' : 'False'})`);
  L.push(`${indent}axes.spines['right'].set_visible(${s.spines.right ? 'True' : 'False'})`);
  L.push(`${indent}for spine in axes.spines.values():`);
  L.push(`${indent}    spine.set_linewidth(${pyNum(s.spines.width)})`);
  ['x', 'y'].forEach((k) => {
    const T = t[k];
    L.push(`${indent}axes.tick_params(axis='${k}', which='major', direction=${pyStr(T.direction)}, length=${pyNum(T.length)}, width=${pyNum(T.width)})`);
    const far = k === 'x' ? 'top' : 'right';
    if (T.mirror) L.push(`${indent}axes.tick_params(axis='${k}', which='both', ${far}=True)  # tick marks on the ${far} too`);
    const minorLocated = (k === 'x' && t.categorical) ? false : (T.minor || (s.grid.show && s.grid.minor && gridOn(s, k)) || t[`${k}Log`]);
    if (!minorLocated) return;
    if (T.minor) {
      // matplotlib's own proportions: minor ticks 4/7 as long and 3/4 as thick.
      L.push(`${indent}axes.tick_params(axis='${k}', which='minor', direction=${pyStr(T.direction)}, length=${pyNum(round3(T.length * 4 / 7))}, width=${pyNum(round3(T.width * 0.75))})`);
    } else {
      L.push(`${indent}axes.tick_params(axis='${k}', which='minor', length=0)  # no minor tick marks`);
    }
  });
  if (s.grid.show) {
    // axis='x': lines at the x ticks only (vertical); 'y': the y ticks only.
    const along = s.grid.axis && s.grid.axis !== 'both' ? [`axis=${pyStr(s.grid.axis)}`] : [];
    const g = [`color=${pyStr(s.grid.color)}`, `alpha=${pyNum(s.grid.alpha)}`, `linestyle=${pyStr(s.grid.style)}`];
    L.push(...pyCall('axes.grid', ['True', "which='major'", ...along, ...g, `linewidth=${pyNum(s.grid.width)}`], indent));
    if (s.grid.minor) {
      L.push(...pyCall('axes.grid', ['True', "which='minor'", ...along, ...g, `linewidth=${pyNum(round3(s.grid.width / 2))}`], indent));
    }
    L.push(`${indent}axes.set_axisbelow(True)`);
  }
}

/**
 * `ax.legend(handles=[...], ...)`: the legend of one panel, in the order of
 * `handles`, where the style puts it.
 */
export function legendCall(L, s, ax, handles, { title = '', columns = 1 } = {}) {
  const args = [`handles=[${handles.join(', ')}]`];
  if (s.legend.position === 'outside right') {
    args.push("loc='upper left'", 'bbox_to_anchor=(1.02, 1)', 'borderaxespad=0');
  } else {
    args.push(`loc=${pyStr(s.legend.position)}`);
  }
  args.push(`frameon=${s.legend.frame ? 'True' : 'False'}`, `fontsize=${pyNum(s.legend.fontSize)}`);
  if (title) args.push(`title=${pyStr(title)}`);
  if (columns > 1) args.push(`ncols=${columns}`);
  L.push(...pyCall(`${ax}.legend`, args));
}

/**
 * The save section: savefig in the export format, at the dpi, tight or at
 * the exact size, then plt.show() only where there is a screen.
 *
 * @param {string[]} L
 * @param {object} s - the look (export, dpi, width, height)
 * @param {(title: string) => void} section - writes a section heading
 */
export function saveLines(L, s, section) {
  const fileName = `${s.export.filename}.${s.export.format}`;
  L.push('');
  section('Save');
  const saveArgs = [pyStr(fileName), `dpi=${s.dpi}`, `transparent=${s.export.transparent ? 'True' : 'False'}`];
  if (s.export.tight) {
    L.push("# bbox_inches='tight' fits the page to what is drawn, with a 0.1 in margin;");
    L.push(`# leave it out to keep the page exactly ${short(s.width)} x ${short(s.height)} in.`);
    saveArgs.push("bbox_inches='tight'");
  } else {
    L.push(`# The page is exactly ${short(s.width)} x ${short(s.height)} in; add bbox_inches='tight' to fit it to`);
    L.push('# what is drawn instead.');
  }
  L.push(...pyCall('fig.savefig', saveArgs));
  L.push(`print(${pyStr('Saved ' + fileName)})`);
  L.push('');
  L.push('# Show the figure when there is a screen for it; a headless run just saves it.');
  L.push("if matplotlib.get_backend().lower() not in ('agg', 'cairo', 'pdf', 'pgf', 'ps', 'svg', 'template'):");
  L.push('    plt.show()');
}

/**
 * The comment over the log scales, which the script sets once the data are
 * drawn: matplotlib 3.8 to 3.10 take the limits of error bars drawn on an
 * axis that is already logarithmic in log units (vlines and hlines go
 * through Collection.get_datalim, which 3.11 mended), so the axis would miss
 * the data. Setting a scale also resets its tick locators: the ticks are set
 * after.
 *
 * @param {string[]} L
 */
export function scaleComment(L) {
  L.push('# Log scales once the data are drawn: matplotlib 3.8 to 3.10 misplace the limits of');
  L.push('# error bars drawn on an axis that is already logarithmic.');
}

/*
 * Whether the data on the shared x axis reach 0 or below, as matplotlib's
 * data limits count them: bars and boxes by their edges, a heatmap by its
 * cells (a box plot on categories also half a place beyond its outer boxes).
 */
export function xReachesZero(f) {
  const low = (values) => {
    for (const v of values || []) if (Number.isFinite(v) && v <= 0) return true;
    return false;
  };
  return f.panels.some((p) => p.series.some((q) => {
    if (!q.show) return false;
    switch (q.kind) {
      case 'line': case 'scatter': case 'band': case 'contour': return low(q.x);
      case 'errorbar': return low(q.x) || (!!q.xerr && low(q.x.map((v, i) => v - (q.xerr[0][i] ?? 0))));
      case 'bar': return low(q.x.map((v) => v + (q.offset || 0) - (q.barWidth || q.width) / 2));
      case 'histogram': return low(q.edges);
      case 'box': return low(q.groups.map((g) => g.position - q.width / 2 - 0.5));
      case 'heatmap': {
        const xs = (q.x || []).filter(Number.isFinite);
        if (!xs.length) return false;
        return low([xs[0] - (xs.length > 1 ? Math.abs(xs[1] - xs[0]) / 2 : 0.5), ...xs]);
      }
      case 'vline': return low([q.x]);
      case 'axline': return low(q.points.map((pt) => pt[0]));
      case 'bracket': return low([q.x1, q.x2]);
      default: return false;
    }
  }));
}

/**
 * The lines that start a log x axis shared by panels at the smallest
 * positive x of all of them, when the data reach 0 or below (a log axis
 * cannot show those). matplotlib 3.8 and later do so on their own; 3.6 and
 * 3.7 took the smallest positive x of the panel that owns the axis's
 * locator, so the script tells every panel the shared value. Written after
 * everything is drawn and before the log scale is set (setting the scale
 * autoscales there and then); it changes nothing but where the x axis starts.
 *
 * @param {string[]} L
 * @param {string[]} names - the panels' axes names
 * @param {Set<string>} taken - the names in use (the new name is added)
 */
export function sharedLogLines(L, names, taken) {
  const x = identifier('x_min_positive', taken);
  const all = `(${names.join(', ')})`;
  L.push('# The log x axis cannot show 0 or below: it starts at the smallest positive x of');
  L.push('# all the panels, as matplotlib 3.8 and later choose. (3.6 and 3.7 take the top');
  L.push("# panel's alone; telling every panel the shared value makes them agree.)");
  L.push(`${x} = min(axes.dataLim.minposx for axes in ${all})`);
  L.push(`for axes in ${all}:`);
  L.push(`    axes.update_datalim([(${x}, 1)], updatey=False)`);
}

/* ------------------------------------------------------------------ *
 * The whole script
 * ------------------------------------------------------------------ */

/*
 * A fingerprint of an array of numbers: its length and two 32-bit hashes of
 * every value's bits. Arrays with the same numbers get the same print, so a
 * page that redraws with a new style (or new arrays holding the same data)
 * has its data written once.
 */
const scratch = new Float64Array(1);
const halves = new Uint32Array(scratch.buffer);
function fingerprint(values) {
  let h1 = 0x811c9dc5; let h2 = 0x01000193;
  const n = values.length;
  for (let i = 0; i < n; i++) {
    const v = values[i];
    scratch[0] = Number.isFinite(v) ? v : NaN;
    h1 = Math.imul(h1 ^ halves[0], 0x01000193) ^ halves[1];
    h2 = Math.imul(h2 + halves[1], 0x85ebca6b) ^ (h2 >>> 13) ^ halves[0];
  }
  return `${n}:${(h1 >>> 0).toString(36)}:${(h2 >>> 0).toString(36)}`;
}

/* The written lines of the last arrays embedded, by name and fingerprint:
   a style change rewrites the script without printing the numbers again. */
const lineCache = new Map();
let cachedCount = 0;
function cachedLines(key, make) {
  if (lineCache.has(key)) {
    const hit = lineCache.get(key);
    lineCache.delete(key);
    lineCache.set(key, hit);   // most recent last
    return hit;
  }
  const lines = make();
  lineCache.set(key, lines);
  cachedCount += lines.length;
  // Keep about half a million lines (some 40 MB of text) at most.
  while (cachedCount > 500000 && lineCache.size > 1) {
    const [oldest, old] = lineCache.entries().next().value;
    lineCache.delete(oldest);
    cachedCount -= old.length;
  }
  return lines;
}

const READ_CSV = [
  'def read_csv(path, delimiter=\',\'):',
  '    """The columns of a CSV file with a header row, by name; blank or non-numeric cells become NaN."""',
  "    with open(path, newline='', encoding='utf-8-sig') as fh:",
  '        reader = csv.DictReader(fh, delimiter=delimiter)',
  '        reader.fieldnames = [field.strip() for field in reader.fieldnames or []]',
  '        rows = list(reader)',
  '',
  '    def number(text):',
  '        try:',
  '            return float(text)',
  '        except (TypeError, ValueError):',
  '            return np.nan',
  '',
  '    return {name: np.array([number(row[name]) for row in rows]) for name in reader.fieldnames}'
];

const READ_TABLE = [
  'def read_table(path):',
  '    """The columns of a text table: numbers separated by spaces or tabs.',
  '',
  '    Lines starting with #, @ or & are skipped (the comments of .dat, .xvg and',
  "    PLUMED files), except PLUMED's '#! FIELDS' line, which names the columns.",
  '    Columns are found by number (0 is the first) or by that name.',
  '    """',
  '    names, rows = [], []',
  "    with open(path, encoding='utf-8') as fh:",
  '        for line in fh:',
  "            if line.startswith('#! FIELDS'):",
  '                names = line.split()[2:]',
  '                continue',
  "            if not line.strip() or line.lstrip()[0] in '#@&':",
  '                continue',
  '            try:',
  '                rows.append([float(v) for v in line.split()])',
  '            except ValueError:',
  '                continue',
  '    width = len(names) or max((len(r) for r in rows), default=0)',
  '    data = np.array([r for r in rows if len(r) == width], dtype=float).reshape(-1, width)',
  '    columns = {i: data[:, i] for i in range(width)}',
  '    columns.update({name: data[:, i] for i, name in enumerate(names)})',
  '    return columns'
];

const TO_GRID = [
  'def to_grid(x, y, z):',
  '    """Values listed point by point (as in PLUMED\'s fes.dat) as a grid: z[j, i] at (x[i], y[j])."""',
  '    xs, i = np.unique(x, return_inverse=True)',
  '    ys, j = np.unique(y, return_inverse=True)',
  '    grid = np.full((len(ys), len(xs)), np.nan)',
  '    grid[j, i] = z',
  '    return xs, ys, grid'
];

const IMAGE_KINDS = ['heatmap', 'contour'];

/**
 * The complete Python script for a figure: data, figure, save.
 *
 * @param {object} figure - a figure description (normalised here)
 * @param {object} [options]
 * @param {'embed'|'files'} [options.data='embed'] - read the fields that name a file column
 *   from the files, or embed every number
 * @param {Object<string, {file: string, format?: 'csv'|'table', delimiter?: string}>} [options.files] -
 *   the person's files, by the source id the data fields use
 * @param {string[]} [options.header] - the first comment lines (without '#')
 * @param {string[]} [options.imports] - more import lines
 * @param {string[]} [options.prelude] - Python lines after the data, before the figure; they may
 *   define names that data fields use as { py }. The names they assign (and those `after`
 *   assigns, and options.names) are never used for the script's own
 * @param {string[]} [options.names] - more names the script must leave alone
 * @param {string[]|((axes: string[]) => string[])} [options.after] - Python lines drawn after the
 *   series of every panel and before the axes are labelled (annotations the prelude worked
 *   out); a function is given the Python names of the panels' axes, top first ('ax', …). The
 *   lines may use those names, fig, np, plt, matplotlib, ticker and whatever the data section
 *   and the prelude defined
 * @returns {string}
 */
export function figureScript(figure, options = {}) {
  const f = normaliseFigure(figure);
  const mode = options.data === 'files' ? 'files' : 'embed';
  const files = options.files && typeof options.files === 'object' ? options.files : {};
  // Names the page's own lines use (the prelude, `after`, options.names) are
  // never taken for the script's: a series called 'fit' does not overwrite
  // the prelude's fit.
  const prelude = Array.isArray(options.prelude) ? options.prelude.map(String) : [];
  const pageNames = new Set([...assignedNames(prelude), ...(Array.isArray(options.names) ? options.names.map(String) : [])]);
  const taken = new Set(pageNames);
  const L = [];
  const blank = () => L.push('');
  const section = (title) => { L.push(`# ${title} ` + '-'.repeat(Math.max(4, 76 - title.length))); };
  const fileName = `${f.export.filename}.${f.export.format}`;

  /* The data each series draws, as Python text */
  // The data as read or embedded come first (a prelude may use them); lines
  // worked out from the fields (a histogram's bins, a box plot's groups) come
  // after the prelude, which may define the names those fields use.
  const dataLines = [];
  const derivedLines = [];
  const readers = new Set();
  const sourcesUsed = new Map();   // source id -> Python name of its columns
  const known = new Map();         // key -> Python name
  const panelNames = f.panels.length > 1 ? f.panels.map((p, i) => (i === 0 ? 'ax' : identifier(`ax_${p.id}`, taken))) : ['ax'];
  taken.add('ax');
  const afterLines = (() => {
    const a = typeof options.after === 'function' ? options.after(panelNames.slice()) : options.after;
    return Array.isArray(a) ? a.map(String) : [];
  })();
  for (const n of assignedNames(afterLines)) { taken.add(n); pageNames.add(n); }
  // scipy's stats, for a box plot's interval, under another name if the page's lines use 'stats'.
  const statsName = pageNames.has('stats') ? 'scipy_stats' : 'stats';
  const fromFile = (ref) => mode === 'files' && ref && ref.source && files[ref.source] && ref.column !== undefined;
  const sourceName = (id) => {
    if (sourcesUsed.has(id)) return sourcesUsed.get(id);
    const src = files[id];
    const name = identifier(`${id}_columns`, taken);
    const fmt = src.format === 'csv' ? 'csv' : 'table';
    readers.add(fmt);
    const call = fmt === 'csv'
      ? pyCall(`${name} = read_csv`, [pyStr(src.file), ...(src.delimiter && src.delimiter !== ',' ? [`delimiter=${pyStr(src.delimiter)}`] : [])])
      : [`${name} = read_table(${pyStr(src.file)})`];
    dataLines.push(`# Point this at your file${fmt === 'csv' ? '; the columns are found by their headers' : ''}.`, ...call);
    sourcesUsed.set(id, name);
    return name;
  };
  const arrayOf = (values, ref, fallback) => {
    if (ref && ref.py) return ref.py;
    if (fromFile(ref)) {
      const key = `file:${ref.source}:${ref.column}`;
      if (known.has(key)) return known.get(key);
      const cols = sourceName(ref.source);
      const name = identifier(ref.name || (typeof ref.column === 'string' ? ref.column : fallback), taken);
      dataLines.push(`${name} = ${cols}[${typeof ref.column === 'string' ? pyStr(ref.column) : ref.column}]`);
      known.set(key, name);
      return name;
    }
    const print = fingerprint(values || []);
    const key = `data:${ref && ref.name ? ref.name : ''}:${print}`;
    if (known.has(key)) return known.get(key);
    const name = identifier(ref && ref.name ? ref.name : fallback, taken);
    append(dataLines, cachedLines(`${name}|${print}`, () => pyArray(name, Array.from(values || [], (v) => (Number.isFinite(v) ? v : NaN)))));
    known.set(key, name);
    return name;
  };
  const gridOf = (rows, ref, fallback) => {
    if (ref && ref.py) return ref.py;
    const print = rows.map((r) => fingerprint(r)).join(';');
    const key = `grid:${print}`;
    if (known.has(key)) return known.get(key);
    const name = identifier(ref && ref.name ? ref.name : fallback, taken);
    append(dataLines, cachedLines(`${name}|${print}`, () => pyGrid(name, rows.map((r) => r.map((v) => (Number.isFinite(v) ? v : NaN))))));
    known.set(key, name);
    return name;
  };
  const errOf = (err, ref, fallback) => {
    if (!err) return null;
    if (Array.isArray(ref)) return `[${arrayOf(err[0], ref[0], `${fallback}_minus`)}, ${arrayOf(err[1], ref[1], `${fallback}_plus`)}]`;
    if (ref || err[0] === err[1] || err[0].every((v, i) => v === err[1][i])) return arrayOf(err[1], ref, fallback);
    return `[${arrayOf(err[0], null, `${fallback}_minus`)}, ${arrayOf(err[1], null, `${fallback}_plus`)}]`;
  };

  let needsStats = false;
  const plans = f.panels.map((p, pi) => {
    const drawn = p.series.filter((q) => q.show);
    const images = drawn.filter((q) => IMAGE_KINDS.includes(q.kind));
    const ordered = [...images.filter((q) => q.kind === 'heatmap'), ...images.filter((q) => q.kind === 'contour'), ...drawn.filter((q) => !IMAGE_KINDS.includes(q.kind))];
    return ordered.map((q, k) => {
      const id = q.id;
      const r = q.refs || {};
      const c = { zorder: q.zorder ?? (q.kind === 'text' ? 6 : 1 + k), labelled: q.legend && !!q.label, fig: f, categorical: !!f.xCategories, statsName };
      const x = () => arrayOf(q.x, r.x, `${id}_x`);
      const y = () => arrayOf(q.y, r.y, `${id}_y`);
      switch (q.kind) {
        case 'line': case 'scatter': Object.assign(c, { x: x(), y: y() }); break;
        case 'errorbar': Object.assign(c, { x: x(), y: y(), yerr: errOf(q.yerr, r.yerr, `${id}_yerr`), xerr: errOf(q.xerr, r.xerr, `${id}_xerr`) }); break;
        case 'band': Object.assign(c, { x: x(), lower: arrayOf(q.lower, r.lower, `${id}_lower`), upper: arrayOf(q.upper, r.upper, `${id}_upper`) }); break;
        case 'bar': {
          // The bars' positions with the group offset worked in, as the preview has them.
          const xs = q.x.map((v) => v + q.offset);
          Object.assign(c, { x: q.offset || !r.x ? arrayOf(xs, null, `${id}_x`) : x(), y: y(), yerr: errOf(q.yerr, r.yerr, `${id}_yerr`) });
          break;
        }
        case 'histogram': {
          const cn = identifier(`${id}_counts`, taken); const en = identifier(`${id}_edges`, taken);
          if (q.values) {
            const v = arrayOf(q.values, r.values, `${id}_values`);
            const bins = Array.isArray(q.bins) ? `[${q.bins.map(pyNum).join(', ')}]` : pyNum(q.bins);
            derivedLines.push(`# The histogram of ${v}: numpy's bins, as the page's.`);
            append(derivedLines, pyCall(`${cn}, ${en} = np.histogram`, [`${v}[np.isfinite(${v})]`, `bins=${bins}`, ...(q.density ? ['density=True'] : [])]));
          } else {
            append(append(dataLines, pyArray(cn, q.counts)), pyArray(en, q.edges));
          }
          Object.assign(c, { counts: cn, edges: en });
          break;
        }
        case 'box': {
          const names = q.groups.map((g, i) => arrayOf(g.values, g.ref, `${id}_group${i + 1}`));
          const gn = identifier(`${id}_groups`, taken);
          derivedLines.push(`${gn} = [${names.map((n) => `${n}[np.isfinite(${n})]`).join(', ')}]`);
          c.groups = gn;
          if (q.mean) needsStats = true;
          c.zorder = q.zorder ?? 1 + k;
          break;
        }
        case 'heatmap': case 'contour': {
          if (fromFile(r.z) && r.z.x !== undefined && r.z.y !== undefined) {
            const cols = sourceName(r.z.source);
            const gx = identifier(`${id}_x`, taken); const gy = identifier(`${id}_y`, taken); const gz = identifier(`${id}_z`, taken);
            readers.add('grid');
            const col = (v) => `${cols}[${typeof v === 'string' ? pyStr(v) : v}]`;
            dataLines.push(`${gx}, ${gy}, ${gz} = to_grid(${col(r.z.x)}, ${col(r.z.y)}, ${col(r.z.column)})`);
            Object.assign(c, { x: gx, y: gy, z: gz });
          } else {
            Object.assign(c, { x: x(), y: y(), z: gridOf(q.z, r.z, `${id}_z`) });
          }
          c.mappableName = identifier(q.kind === 'heatmap' ? `${id}_mesh` : `${id}_levels`, taken);
          break;
        }
        default: break;
      }
      if (c.labelled && ['line', 'scatter', 'errorbar', 'band', 'bar', 'histogram', 'hline', 'vline', 'axline'].includes(q.kind)) {
        c.handle = identifier(q.id, taken);
      }
      c.markerName = identifier(`${q.id}_points`, taken);
      return { q, c, ax: panelNames[pi] };
    });
  });

  /* Header */
  const header = Array.isArray(options.header) && options.header.length ? options.header : ['Figure from STEMKit (https://stemkit.net)'];
  header.forEach((line) => L.push(`# ${comment(line)}`));
  L.push('#');
  L.push(`# Draws the figure as the page shows it and saves it as ${fileName}.`);
  // What the script imports, its own and the page's, besides Python itself.
  const statsImport = statsName === 'stats' ? 'from scipy import stats' : 'from scipy import stats as scipy_stats';
  const needs = importedPackages([...(needsStats ? [statsImport] : []), ...(options.imports || []), ...prelude, ...afterLines])
    .filter((m) => m !== 'numpy' && m !== 'matplotlib');
  const list = ['numpy', ...needs];
  L.push(`# Needs ${list.join(', ')} and matplotlib 3.6 or later (3.11 or later to match the preview).`);
  blank();

  /* Imports */
  if (readers.has('csv')) L.push('import csv', '');
  L.push('import numpy as np');
  L.push('import matplotlib');
  L.push('import matplotlib.pyplot as plt');
  L.push('from matplotlib import ticker');
  if (needsStats) L.push(statsImport);
  (options.imports || []).forEach((line) => L.push(line));
  blank();

  /* Data */
  if (dataLines.length || derivedLines.length || prelude.length) {
    section('Data');
    const helpers = [];
    if (readers.has('csv')) helpers.push(READ_CSV);
    if (readers.has('table') || readers.has('grid')) helpers.push(READ_TABLE);
    if (readers.has('grid')) helpers.push(TO_GRID);
    helpers.forEach((h) => { append(L, h); L.push('', ''); });
    append(L, dataLines);
    if (prelude.length) { if (dataLines.length) blank(); append(L, prelude); }
    if (derivedLines.length) { if (dataLines.length || prelude.length) blank(); append(L, derivedLines); }
    blank();
    blank();
  }

  /* Figure */
  section('Figure');
  rcLines(L, f);
  blank();
  if (f.sizeUnit && f.sizeUnit !== 'in') {
    const k = unitsPerInch(f.sizeUnit, f.dpi);
    const u = (v) => String(Number((v * k).toFixed({ px: 0, mm: 1, cm: 2 }[f.sizeUnit])));
    L.push(`# The figure is ${u(f.width)} x ${u(f.height)} ${f.sizeUnit}${f.sizeUnit === 'px' ? ` at ${f.dpi} dpi` : ''}; matplotlib takes its size in inches.`);
  }
  if (f.panels.length > 1) {
    L.push(`# ${f.panels.length} panels, one above the other, sharing the x axis; heights ${f.panels.map((p) => short(p.ratio)).join(' : ')}.`);
  }
  subplotsLines(L, f, panelNames, f.panels.map((p) => p.ratio));
  blank();

  const handles = f.panels.map(() => []);
  const colorbars = [];
  plans.forEach((plan, pi) => {
    if (!plan.length) return;
    if (f.panels.length > 1) L.push(`# Panel ${pi + 1}${f.panels[pi].name ? `: ${comment(f.panels[pi].name)}` : ''}`);
    for (const { q, c, ax } of plan) {
      const out = seriesLines(L, q, ax, c);
      if (out.handle) handles[pi].push({ id: q.id, name: out.handle });
      if (out.mappable && q.colorbar && q.colorbar.show && (q.kind === 'heatmap' || q.filled) && !colorbars.some((cb) => cb.panel === pi)) {
        colorbars.push({ panel: pi, mappable: out.mappable, q });
      }
    }
    blank();
  });

  /* The page's own drawing, after the series: annotations its prelude worked out */
  if (afterLines.length) {
    append(L, afterLines);
    blank();
  }

  /* A shared log x axis whose data reach 0 or below starts where every
     matplotlib starts it. Before the scale is set: setting it autoscales. */
  if (f.xScale === 'log' && panelNames.length > 1 && xReachesZero(f)) {
    sharedLogLines(L, panelNames, taken);
    blank();
  }

  /* Log scales, once everything is drawn */
  const scales = [];
  if (f.xScale === 'log') scales.push("ax.set_xscale('log')");
  f.panels.forEach((p, i) => { if (p.yScale === 'log') scales.push(`${panelNames[i]}.set_yscale('log')`); });
  if (scales.length) {
    scaleComment(L);
    append(L, scales);
    blank();
  }

  /* Colour bars */
  if (colorbars.length) {
    L.push('# Colour bars, beside their panels.');
    colorbars.forEach((cb, i) => {
      const name = colorbars.length > 1 ? identifier(`cbar${i + 1}`, taken) : 'cbar';
      const T = f.panels[cb.panel].yTicks;
      L.push(...pyCall(`${name} = fig.colorbar`, [cb.mappable, `ax=${panelNames[cb.panel]}`, ...(cb.q.colorbar.label ? [`label=${pyStr(cb.q.colorbar.label)}`] : [])]));
      L.push(`${name}.outline.set_linewidth(${pyNum(f.spines.width)})`);
      L.push(`${name}.ax.tick_params(which='major', direction=${pyStr(T.direction)}, length=${pyNum(T.length)}, width=${pyNum(T.width)})`);
    });
    blank();
  }

  /* Axes */
  L.push('# Axes');
  if (f.title) L.push(`ax.set_title(${pyStr(f.title)})`);
  const bottom = panelNames[panelNames.length - 1];
  if (f.xLabel) L.push(`${bottom}.set_xlabel(${pyStr(f.xLabel)})`);
  f.panels.forEach((p, i) => { if (p.yLabel) L.push(`${panelNames[i]}.set_ylabel(${pyStr(p.yLabel)})`); });
  const limLine = (target, k, lim, log) => {
    const [a, b] = lim.map((v) => (v !== null && log && v <= 0 ? null : v));
    if (a === null && b === null) return;
    L.push(`${target}.set_${k}lim(${a === null ? 'None' : pyNum(a)}, ${b === null ? 'None' : pyNum(b)})${a === null || b === null ? '  # None: automatic' : ''}`);
  };
  limLine('ax', 'x', f.xLim, f.xScale === 'log');
  f.panels.forEach((p, i) => limLine(panelNames[i], 'y', p.yLim, p.yScale === 'log'));
  blank();

  /* Ticks */
  const xT = f.xCategories
    ? { ...f.xTicks, mode: 'list', values: f.xCategories.map((_, i) => i), labels: f.xCategories.slice(), minor: false, format: '' }
    : f.xTicks;
  tickLines(L, { k: 'x', axis: 'ax.xaxis', T: xT, log: f.xScale === 'log', note: f.panels.length > 1 ? ' (shared by the panels)' : '',
    gridMinor: f.grid.show && f.grid.minor && gridOn(f, 'x'), categories: !!f.xCategories });
  f.panels.forEach((p, i) => {
    tickLines(L, { k: 'y', axis: `${panelNames[i]}.yaxis`, T: p.yTicks, log: p.yScale === 'log', note: f.panels.length > 1 ? ` of panel ${i + 1}` : '',
      gridMinor: f.grid.show && f.grid.minor && gridOn(f, 'y') });
  });

  /* Frame, ticks, grid, for each panel */
  const same = f.panels.every((p) => JSON.stringify([p.yTicks.direction, p.yTicks.length, p.yTicks.width, p.yTicks.mirror, p.yTicks.minor, p.yScale])
    === JSON.stringify([f.panels[0].yTicks.direction, f.panels[0].yTicks.length, f.panels[0].yTicks.width, f.panels[0].yTicks.mirror, f.panels[0].yTicks.minor, f.panels[0].yScale]));
  const ticksOf = (p) => ({ x: xT, y: p.yTicks, xLog: f.xScale === 'log', yLog: p.yScale === 'log', categorical: !!f.xCategories });
  L.push('# Background, frame, tick marks and grid, for each panel.');
  if (same) {
    L.push(`for axes in ${panelNames.length > 1 ? `(${panelNames.join(', ')})` : `[${panelNames[0]}]`}:`);
    frameBody(L, f, ticksOf(f.panels[0]));
  } else {
    f.panels.forEach((p, i) => {
      L.push(`axes = ${panelNames[i]}`);
      frameBody(L, f, ticksOf(p), '');
    });
  }
  blank();

  /* Legends */
  let anyLegend = false;
  f.panels.forEach((p, i) => {
    const show = p.legend.show === null ? f.legend.show : p.legend.show;
    const list = handles[i].slice();
    const rank = (h) => { const k = p.legend.order.indexOf(h.id); return k < 0 ? p.legend.order.length + handles[i].indexOf(h) : k; };
    list.sort((a, b) => rank(a) - rank(b));
    if (!show || !list.length) return;
    if (!anyLegend) L.push(f.panels.length > 1 ? '# Legends' : '# Legend');
    anyLegend = true;
    const look = { ...f, legend: { ...f.legend, position: p.legend.position || f.legend.position } };
    legendCall(L, look, panelNames[i], list.map((h) => h.name), { title: i === 0 ? f.legend.title : '', columns: f.legend.columns });
  });
  if (!anyLegend) L.pop();

  /* Save */
  saveLines(L, f, section);
  return L.join('\n') + '\n';
}

/* Used by the box plot's points: the same spread the preview draws. */
export { jitterOffsets };
