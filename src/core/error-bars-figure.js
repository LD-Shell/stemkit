/**
 * @module core/error-bars-figure
 *
 * The Error Bar Generator's figure and its Python script.
 *
 * `errorBarFigure` describes the chart (see figure.js) from the group
 * summaries of error-bars.js: a bar, or a mean with its error bar, for each
 * group on a categorical x axis, the replicates spread across each group, and
 * brackets over the pairs of groups that Welch's t-test separates after
 * Holm's correction (`pairwiseComparisons`), stacked so that none overlaps
 * another or the data under it.
 *
 * `errorBarScript` writes the matplotlib script for that figure. It does not
 * copy the page's numbers: it embeds the replicates, recomputes each group's
 * mean, SD, SEM and t interval and every pairwise test with numpy and scipy
 * as error-bars.js computes them, prints them, and places the brackets from
 * its own p-values by the same rule, so the script stays right when its data
 * are edited. tests/error-bars-figure.test.js runs it and compares both the
 * numbers and matplotlib's axis limits with the page's.
 */

import { errorLabel, pairwiseComparisons } from './error-bars.js';
import { jitterOffsets } from './figure.js';
import { figureScript, pyStr, pyNum, pyCall, wrapItems, wrapComment } from './figure-python.js';

/** Where the brackets go, as shares of the span of the data: legs, clearance, and the step between stacked brackets. */
export const ERROR_BAR_BRACKET_SPACING = Object.freeze({ height: 0.03, gap: 0.04, step: 0.12 });

/** The spread of the replicates across a group, as a share of a place on the x axis. */
const POINT_SPREAD = 0.24;
const BAR_WIDTH = 0.6;

/**
 * A bracket's label for a Holm-adjusted p-value: stars (*** p < 0.001,
 * ** p < 0.01, * p < 0.05, n.s. otherwise) or the p-value itself.
 *
 * @param {number} p
 * @param {'stars'|'p'} [style='stars']
 * @returns {string}
 */
export function significanceLabel(p, style = 'stars') {
  if (style === 'p') return p < 0.001 ? 'p < 0.001' : `p = ${p.toFixed(3)}`;
  if (p < 0.001) return '***';
  if (p < 0.01) return '**';
  if (p < 0.05) return '*';
  return 'n.s.';
}

/*
 * What each group draws, top and bottom: the bar from zero (bars only), the
 * mean with its error bar, and the replicates when they are shown.
 */
function groupExtents(groups, { display, points }) {
  return groups.map((g) => {
    const e = g.n > 1 && Number.isFinite(g.error) ? g.error : NaN;
    let top = Number.isFinite(e) ? Math.max(g.mean + e, g.mean) : g.mean;
    let bottom = Number.isFinite(e) ? Math.min(g.mean - e, g.mean) : g.mean;
    if (display !== 'means') { top = Math.max(top, 0); bottom = Math.min(bottom, 0); }
    if (points && g.values.length) {
      let hi = -Infinity; let lo = Infinity;
      for (const v of g.values) { if (v > hi) hi = v; if (v < lo) lo = v; }
      top = Math.max(top, hi);
      bottom = Math.min(bottom, lo);
    }
    return { top, bottom };
  });
}

/**
 * The significance brackets: which pairs get one, and where.
 *
 * The pairs are placed narrowest first, then from the left. Each bracket's
 * foot sits a little above the tallest thing drawn for the groups it spans,
 * and a step above any bracket already placed over any of those groups, so
 * no bracket or label lands on another. All distances are shares of the
 * span of the data (ERROR_BAR_BRACKET_SPACING); the script does the same.
 *
 * @param {Array<{key: string, n: number, mean: number, error: number, values: number[]}>} groups
 * @param {Array<{a: string, b: string, pAdjusted: number}>} comparisons - pairwiseComparisons()
 * @param {{display?: 'bars'|'means', points?: boolean, compare?: 'significant'|'all'|'none',
 *   labels?: 'stars'|'p'}} [options]
 * @returns {{height: number, brackets: Array<{i: number, j: number, y: number, text: string,
 *   a: string, b: string, p: number}>}}
 */
export function errorBarBrackets(groups, comparisons, options = {}) {
  const { display = 'bars', points = false, compare = 'significant', labels = 'stars' } = options;
  const ext = groupExtents(groups, { display, points });
  let hi = -Infinity; let lo = Infinity;
  for (const e of ext) { if (e.top > hi) hi = e.top; if (e.bottom < lo) lo = e.bottom; }
  let span = hi - lo;
  if (!(span > 0)) span = 1;
  const S = ERROR_BAR_BRACKET_SPACING;
  const height = S.height * span;
  const gap = S.gap * span;
  const step = S.step * span;
  if (compare === 'none') return { height, brackets: [] };

  const index = new Map(groups.map((g, i) => [g.key, i]));
  const chosen = (comparisons || [])
    .map((c) => ({ i: index.get(c.a), j: index.get(c.b), p: c.pAdjusted, a: c.a, b: c.b }))
    .filter((c) => c.i !== undefined && c.j !== undefined && (compare === 'all' || c.p < 0.05))
    .sort((x, y) => (x.j - x.i) - (y.j - y.i) || x.i - y.i);
  const placed = [];
  for (const c of chosen) {
    let y = -Infinity;
    for (let k = c.i; k <= c.j; k++) y = Math.max(y, ext[k].top);
    y += gap;
    for (const b of placed) if (b.i <= c.j && b.j >= c.i) y = Math.max(y, b.y + step);
    placed.push({ ...c, y, text: significanceLabel(c.p, labels) });
  }
  return { height, brackets: placed };
}

/**
 * The Error Bar Generator's figure.
 *
 * @param {Array<{key: string, n: number, mean: number, sd: number, sem: number, ci: number,
 *   values: number[]}>} results - computeGroups().results
 * @param {object} [options]
 * @param {'sd'|'sem'|'ci'} [options.mode='ci'] - what the error bars show
 * @param {number} [options.level=0.95] - the interval's level, for the axis label
 * @param {'bars'|'means'} [options.display='bars'] - a bar from zero, or the mean as a point
 * @param {boolean} [options.points=true] - each replicate, spread across its group
 * @param {'significant'|'all'|'none'} [options.compare='significant'] - which pairs get a bracket
 * @param {'stars'|'p'} [options.labels='stars']
 * @param {string} [options.pointColor='#1a1a1a'] - the replicates' colour (the figure's foreground)
 * @param {object[]} [options.comparisons] - pairwiseComparisons() of the groups, if already made
 * @returns {object|null} a figure description, or null with no groups
 */
export function errorBarFigure(results, options = {}) {
  const {
    mode = 'ci', level = 0.95, display = 'bars', points = true, compare = 'significant', labels = 'stars',
    pointColor = '#1a1a1a'
  } = options;
  const list = Array.isArray(results) ? results.filter((r) => r && Array.isArray(r.values) && r.values.length) : [];
  if (!list.length) return null;
  const groups = list.map((r) => ({
    key: String(r.key), n: r.n, mean: r.mean, values: r.values,
    error: r.n > 1 ? { sd: r.sd, sem: r.sem, ci: r.ci }[mode] : NaN
  }));
  const comparisons = options.comparisons || (compare === 'none' ? [] : pairwiseComparisons(groups.map((g) => ({ key: g.key, values: g.values }))));
  const { height, brackets } = errorBarBrackets(groups, comparisons, { display, points, compare, labels });

  const series = [];
  const replicates = {
    id: 'replicates', kind: 'scatter', label: 'Replicates', legend: false, show: !!points,
    x: { values: groups.flatMap((g, i) => jitterOffsets(g.values.length, POINT_SPREAD).map((o) => i + o)), py: 'point_x' },
    y: { values: groups.flatMap((g) => g.values), py: 'point_y' },
    marker: 'o', size: 4, color: pointColor, edgeWidth: 0, alpha: 0.7
  };
  const perGroup = groups.map((g, i) => {
    const s = {
      id: `group:${g.key}`, label: g.key, legend: false,
      x: { values: [i], py: String(i) },
      y: { values: [g.mean], py: `means[${i}]` }
    };
    // One value has no spread: no error bar at all (a NaN one makes matplotlib warn).
    if (Number.isFinite(g.error)) s.yerr = { values: [g.error], py: `errors[${i}]` };
    return display === 'means'
      ? { ...s, kind: 'errorbar', marker: 'o', size: 7, capSize: 4, errorWidth: 1.2, edgeWidth: 0 }
      : { ...s, kind: 'bar', width: BAR_WIDTH, group: false, capSize: 4, errorWidth: 1, alpha: points ? 0.55 : 0.9 };
  });
  // Bars go under the replicates; means go over them.
  if (display === 'means') series.push(replicates, ...perGroup);
  else series.push(...perGroup, replicates);
  for (const b of brackets) {
    series.push({ id: `pair:${b.a}|${b.b}`, kind: 'bracket', x1: b.i, x2: b.j, y: b.y, height, text: b.text });
  }

  return {
    xCategories: groups.map((g) => g.key),
    export: { filename: 'error_bars' },
    panels: [{ yLabel: `Mean ± ${errorLabel(mode, level)}`, series }]
  };
}

/* ------------------------------------------------------------------ *
 * The script
 * ------------------------------------------------------------------ */

const section = (L, title) => L.push(`# ${title} ` + '-'.repeat(Math.max(4, 76 - title.length)));

/**
 * The Error Bar Generator's Python script.
 *
 * @param {object} figure - the figure as drawn (errorBarFigure's, with the person's
 *   style laid over it; mountFigure passes it normalised)
 * @param {object} spec - what the page computed it from
 * @param {Array<{key: string, values: number[]}>} spec.groups
 * @param {'sd'|'sem'|'ci'} [spec.mode='ci']
 * @param {number} [spec.level=0.95]
 * @param {'bars'|'means'} [spec.display='bars']
 * @param {boolean} [spec.points=true]
 * @param {'significant'|'all'|'none'} [spec.compare='significant']
 * @param {'stars'|'p'} [spec.labels='stars']
 * @returns {string}
 */
export function errorBarScript(figure, spec = {}) {
  const {
    groups = [], mode = 'ci', level = 0.95, display = 'bars', points = true, compare = 'significant', labels = 'stars'
  } = spec;
  const P = [];

  /* Data */
  P.push('# The replicates of each group, as the page read them.');
  P.push('data = {');
  for (const g of groups) {
    const items = g.values.map(pyNum);
    const one = `    ${pyStr(g.key)}: [${items.join(', ')}],`;
    if (one.length <= 88) P.push(one);
    else P.push(`    ${pyStr(g.key)}: [`, ...wrapItems(items, '        '), '    ],');
  }
  P.push('}');
  P.push('', '');

  /* Statistics */
  section(P, 'Statistics');
  P.push(`LEVEL = ${pyNum(level)}  # the confidence level of the interval`);
  P.push(`ERROR = ${pyStr(mode)}  # what the error bars show: 'sd', 'sem' or 'ci' (the y label says which)`);
  P.push('');
  P.push('names = list(data)');
  P.push('samples = [np.asarray(data[name], dtype=float) for name in names]');
  P.push('n = np.array([len(x) for x in samples])');
  P.push('means = np.array([x.mean() for x in samples])');
  P.push('# The sample SD (n - 1). One value has no spread: its SD, SEM and interval are 0,');
  P.push('# and it gets no error bar.');
  P.push('sds = np.array([x.std(ddof=1) if len(x) > 1 else 0.0 for x in samples])');
  P.push('sems = sds / np.sqrt(n)');
  P.push("# Student's t for the interval, two-sided, on n - 1 degrees of freedom.");
  P.push('q = 1 - (1 - LEVEL) / 2');
  P.push('t_crit = np.array([stats.t.ppf(q, k - 1) if k > 1 else 0.0 for k in n])');
  P.push('ci_half = t_crit * sems');
  P.push("errors = {'sd': sds, 'sem': sems, 'ci': ci_half}[ERROR]");
  P.push('');
  P.push("print(f\"{'Group':<16} {'n':>3} {'Mean':>11} {'SD':>11} {'SEM':>11} {'t*':>8}\",");
  P.push("      f'{LEVEL:.0%} CI (±)')");
  P.push('for k, name in enumerate(names):');
  P.push('    if n[k] > 1:');
  P.push("        spread = f'{sds[k]:11.5g} {sems[k]:11.5g} {t_crit[k]:8.4g} {ci_half[k]:11.5g}'");
  P.push('    else:');
  P.push("        spread = f\"{'-':>11} {'-':>11} {'-':>8} {'-':>11}\"");
  P.push("    print(f'{name[:16]:<16} {n[k]:>3} {means[k]:11.5g} {spread}')");
  P.push('');
  P.push("# Welch's t-test for every pair of groups with at least two values each (a pair");
  P.push("# with no spread in either is skipped), then Holm's correction across the pairs.");
  P.push('pairs = []');
  P.push('for i in range(len(names)):');
  P.push('    for j in range(i + 1, len(names)):');
  P.push('        a, b = samples[i], samples[j]');
  P.push('        if len(a) < 2 or len(b) < 2:');
  P.push('            continue');
  P.push('        va, vb = a.var(ddof=1) / len(a), b.var(ddof=1) / len(b)');
  P.push('        if va + vb == 0:');
  P.push('            continue');
  P.push('        test = stats.ttest_ind(a, b, equal_var=False)');
  P.push('        df = (va + vb) ** 2 / (va ** 2 / (len(a) - 1) + vb ** 2 / (len(b) - 1))');
  P.push("        pairs.append({'i': i, 'j': j, 't': test.statistic, 'df': df, 'p': test.pvalue})");
  P.push("p = np.array([pair['p'] for pair in pairs])");
  P.push("order = np.argsort(p, kind='stable')");
  P.push('p_holm = np.empty_like(p)');
  P.push('m = len(p)');
  P.push('p_holm[order] = np.maximum.accumulate(np.minimum(1, p[order] * (m - np.arange(m))))');
  P.push('');
  P.push("print(\"\\nWelch's t-tests, Holm-adjusted:\")");
  P.push('for pair, adjusted in zip(pairs, p_holm):');
  P.push("    pair['p_holm'] = adjusted");
  P.push("    print(f\"{names[pair['i']]} vs {names[pair['j']]}:\",");
  P.push("          f\"t({pair['df']:.2f}) = {pair['t']:.4f},\",");
  P.push("          f\"p = {pair['p']:.4g}, Holm p = {adjusted:.4g}\")");

  const after = [];
  if (compare !== 'none') {
    const S = ERROR_BAR_BRACKET_SPACING;
    P.push('', '');
    section(P, 'Brackets');
    P.push(compare === 'all'
      ? '# A bracket over every pair tested, labelled with its Holm-adjusted p-value.'
      : '# A bracket over each pair whose Holm-adjusted p-value is below 0.05.');
    P.push('');
    P.push('');
    P.push('def label(p):');
    if (labels === 'p') {
      P.push("    return 'p < 0.001' if p < 0.001 else f'p = {p:.3f}'");
    } else {
      P.push("    return '***' if p < 0.001 else '**' if p < 0.01 else '*' if p < 0.05 else 'n.s.'");
    }
    P.push('', '');
    P.push(...wrapComment(`The top and bottom of what each group draws: ${display === 'means' ? 'the mean and its error bar' : 'the bar from zero and its error bar'}${points ? ', and the replicates' : ''}.`));
    P.push('err = np.where(n > 1, errors, np.nan)');
    P.push('tops = np.fmax(means + err, means)');
    P.push('bottoms = np.fmin(means - err, means)');
    if (display !== 'means') {
      P.push('tops, bottoms = np.maximum(tops, 0), np.minimum(bottoms, 0)');
    }
    if (points) {
      P.push('tops = np.maximum(tops, [x.max() for x in samples])');
      P.push('bottoms = np.minimum(bottoms, [x.min() for x in samples])');
    }
    P.push('span = tops.max() - bottoms.min()');
    P.push('span = span if span > 0 else 1.0');
    P.push(`bracket_height = ${pyNum(S.height)} * span  # the legs`);
    P.push(`gap = ${pyNum(S.gap)} * span  # between the groups and a bracket's foot`);
    P.push(`step = ${pyNum(S.step)} * span  # between brackets over the same groups`);
    P.push('');
    P.push('# Narrowest first, then from the left; each above the groups it spans and above');
    P.push('# any bracket already over one of them.');
    P.push(compare === 'all'
      ? 'chosen = pairs'
      : "chosen = [pair for pair in pairs if pair['p_holm'] < 0.05]");
    P.push('brackets = []');
    P.push("for pair in sorted(chosen, key=lambda q: (q['j'] - q['i'], q['i'])):");
    P.push("    i, j = pair['i'], pair['j']");
    P.push('    y = tops[i:j + 1].max() + gap');
    P.push('    for x1, x2, below, _ in brackets:');
    P.push('        if x1 <= j and x2 >= i:');
    P.push('            y = max(y, below + step)');
    P.push("    brackets.append((i, j, y, label(pair['p_holm'])))");

    // The brackets' look: the person's style for the first of them.
    const f = figure && Array.isArray(figure.panels) ? figure : { panels: [] };
    const drawn = (f.panels[0] ? f.panels[0].series : []).filter((q) => q.show !== false);
    const look = drawn.find((q) => q.kind === 'bracket') || { color: f.foreground || '#1a1a1a', lineWidth: 1, fontSize: Math.max(1, (f.fontSize || 11) - 1), alpha: 1 };
    const colour = pyStr(look.color || f.foreground || '#1a1a1a');
    const alpha = look.alpha !== undefined && look.alpha !== 1 ? [`alpha=${pyNum(look.alpha)}`] : [];
    const z = drawn.filter((q) => q.kind !== 'bracket').length + 1;
    after.push('# Significance brackets, where the statistics above put them.');
    after.push('for x1, x2, y, text in brackets:');
    after.push(...pyCall('ax.plot', ['[x1, x1, x2, x2]', '[y, y + bracket_height, y + bracket_height, y]', `color=${colour}`,
      `linewidth=${pyNum(look.lineWidth ?? 1)}`, ...alpha, `zorder=${z}`], '    '));
    after.push(...pyCall('ax.text', ['(x1 + x2) / 2', 'y + bracket_height', 'text', "ha='center'", "va='bottom'",
      `fontsize=${pyNum(look.fontSize ?? 10)}`, `color=${colour}`, 'zorder=6'], '    '));
  }

  /* Replicates, spread as the page spreads them */
  if (points) {
    P.push('', '');
    P.push(`# Each replicate, spread across ${Math.round(POINT_SPREAD * 100)}% of its group's place the same way every time.`);
    P.push('point_x = np.concatenate([');
    P.push(`    k + (np.arange(len(x)) * 0.6180339887498949 % 1 - 0.5) * ${pyNum(POINT_SPREAD)}`);
    P.push('    for k, x in enumerate(samples)');
    P.push('])');
    P.push('point_y = np.concatenate(samples)');
  }

  /* The figure: the page's description, less the brackets (drawn above from the statistics) */
  const f = figure && typeof figure === 'object' ? JSON.parse(JSON.stringify(figure)) : { panels: [] };
  (f.panels || []).forEach((p) => { p.series = (p.series || []).filter((q) => q.kind !== 'bracket'); });
  return figureScript(f, {
    header: [
      'Error bars from STEMKit (https://stemkit.net/error-bar-generator.html).',
      `Each group's mean, SD, SEM and ${Math.round(level * 100)}% confidence interval, and Welch's t-test`,
      "between every pair of groups with Holm's correction, computed as the page computes",
      'them and printed.'
    ],
    imports: ['from scipy import stats'],
    prelude: P,
    // The brackets, drawn where the statistics above put them: after the
    // series, before the axes are dressed. The preview draws the page's
    // bracket series at the same places.
    after
  });
}
