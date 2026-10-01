/**
 * @module core/statistics-figure
 *
 * The Statistics Calculator's figure and its Python script.
 *
 * `statisticsFigure` describes the plot (see figure.js) that goes with each
 * test: box plots with every observation and the mean with its 95%
 * interval for groups, the same joined pair by pair for a paired design, a
 * dashed line at the reference value for a one-sample test, and a scatter
 * plot with the least-squares line for a correlation.
 *
 * `statisticsScript` writes the matplotlib script that draws it. The script
 * holds the values the test used, runs the same test with scipy (the rank
 * tests with the method the page used, exact or asymptotic, passed
 * explicitly), prints the result, and draws the plot from the same arrays.
 * tests/statistics-figure.test.js runs it and compares the numbers and
 * matplotlib's axis limits with the page's.
 */

import { jitterOffsets, normaliseFigure } from './figure.js';
import { figureScript, pyStr, pyNum, pyArray, wrapItems, comment } from './figure-python.js';
import { mannWhitneyU, wilcoxonSignedRank, oneSampleWilcoxon } from './statistics.js';

const BOX_WIDTH = 0.5;
const BOX_JITTER = 0.3;
const MEAN_OFFSET = 0.38;
/** The pair lines' colour: a neutral grey that reads on light and dark figures. */
const PAIR_COLOUR = '#8c96a3';

/** Every test the page runs, with how the script names it. */
export const STATISTICS_TESTS = Object.freeze({
  ttest_welch: "Welch's t-test (unequal variances)",
  ttest_ind: "Student's t-test (pooled variance)",
  mannwhitney: 'Mann–Whitney U test',
  ttest_pair: 'Paired t-test',
  wilcoxon: 'Wilcoxon signed-rank test',
  anova: 'One-way ANOVA',
  welch_anova: "Welch's ANOVA",
  kruskal: 'Kruskal–Wallis H test',
  ttest_one: 'One-sample t-test',
  wilcoxon_one: 'One-sample Wilcoxon signed-rank test',
  pearson: 'Pearson correlation',
  spearman: 'Spearman rank correlation'
});

const dataRef = (name) => `data[${pyStr(name)}]`;

/**
 * The plot for a test.
 *
 * @param {object} model - what the page plots:
 *   { kind: 'groups', groups: [{name, values}], yLabel, xLabel, ref?: {value, label} } (independent
 *   groups, or one group against a value), { kind: 'paired', groups: [first, second], yLabel, xLabel },
 *   or { kind: 'scatter', x, y, xLabel, yLabel, line?: {slope, intercept} }
 * @returns {object|null} a figure description
 */
export function statisticsFigure(model) {
  if (!model || typeof model !== 'object') return null;
  if (model.kind === 'scatter') {
    const x = Array.from(model.x || []); const y = Array.from(model.y || []);
    if (!x.length) return null;
    const series = [{
      id: 'points', kind: 'scatter', label: 'Pairs', legend: false, size: 5, alpha: 0.8, edgeWidth: 0,
      x: { values: x, py: 'x' }, y: { values: y, py: 'y' }
    }];
    const line = model.line;
    if (line && Number.isFinite(line.slope) && Number.isFinite(line.intercept)) {
      let lo = Infinity; let hi = -Infinity;
      for (const v of x) { if (v < lo) lo = v; if (v > hi) hi = v; }
      series.push({
        id: 'fit', kind: 'line', label: 'Least-squares line', lineWidth: 1.5,
        x: { values: [lo, hi], py: 'fit_x' },
        y: { values: [line.intercept + line.slope * lo, line.intercept + line.slope * hi], py: 'fit_y' }
      });
    }
    return {
      xLabel: String(model.xLabel || ''),
      export: { filename: 'correlation' },
      panels: [{ yLabel: String(model.yLabel || ''), series }]
    };
  }

  const groups = (model.groups || []).filter((g) => g && Array.isArray(g.values) && g.values.length);
  if (!groups.length) return null;
  const series = [];
  if (model.kind === 'paired' && groups.length === 2) {
    // Each pair joined, at the same spread its two points have in the boxes.
    const [a, b] = groups;
    const n = Math.min(a.values.length, b.values.length);
    const off = jitterOffsets(n, BOX_JITTER * BOX_WIDTH);
    const px = []; const py = [];
    for (let k = 0; k < n; k++) { px.push(0 + off[k], 1 + off[k], NaN); py.push(a.values[k], b.values[k], NaN); }
    series.push({
      id: 'pairs', kind: 'line', label: 'Pairs', legend: false, color: PAIR_COLOUR, alpha: 0.7, lineWidth: 0.8,
      x: { values: px, py: 'pair_x' }, y: { values: py, py: 'pair_y' }
    });
  }
  series.push({
    id: 'box', kind: 'box', width: BOX_WIDTH, jitter: BOX_JITTER, points: true, mean: true, meanOffset: MEAN_OFFSET,
    groups: groups.map((g) => ({ values: { values: g.values, py: dataRef(g.name) } }))
  });
  if (model.ref && Number.isFinite(model.ref.value)) {
    // μ₀ as mathematics: the subscript is set by mathtext, not taken from a font.
    const shown = String(model.ref.label || '').replace(/^\s*μ₀\s*=\s*/, '') || String(model.ref.value);
    series.push({ id: 'reference', kind: 'hline', y: model.ref.value, label: `$\\mu_0$ = ${shown}`, lineStyle: 'dashed', lineWidth: 1.2 });
  }
  return {
    xCategories: groups.map((g) => String(g.name)),
    xLabel: String(model.xLabel || ''),
    export: { filename: model.kind === 'paired' ? 'paired' : 'groups' },
    panels: [{ yLabel: String(model.yLabel || ''), series }]
  };
}

/* ------------------------------------------------------------------ *
 * The script
 * ------------------------------------------------------------------ */

const section = (L, title) => L.push(`# ${title} ` + '-'.repeat(Math.max(4, 76 - title.length)));

/* The Mann–Whitney test with the method the page used (statistics.js). */
function mannWhitneyLines(L, method) {
  if (method === 'exact') {
    L.push('# No tied values, and 8 or fewer in a group: the exact distribution of U, as');
    L.push("# SciPy's default (method='auto') chooses here.");
    L.push("result = stats.mannwhitneyu(a, b, alternative='two-sided', method='exact')");
  } else {
    L.push('# Tied values, or more than 8 in each group: the normal approximation, as');
    L.push("# SciPy's default (method='auto') chooses here, with the tie-corrected variance");
    L.push("# but without the continuity correction SciPy's default would add.");
    L.push("result = stats.mannwhitneyu(a, b, alternative='two-sided', use_continuity=False, method='asymptotic')");
  }
}

/* The signed-rank test on `d` with the method the page used (statistics.js),
   then z and the effect size r = |z|/sqrt(n) as the page computes them. Older
   SciPy names or lacks two of the methods, so those fall back. */
function signedRankLines(L, method) {
  if (method === 'exact') {
    L.push('# 50 or fewer differences, none tied or zero: the exact distribution of W, as');
    L.push("# SciPy's default (method='auto') chooses here.");
    L.push("result = stats.wilcoxon(d, method='exact')");
    L.push('statistic, p_value = result.statistic, result.pvalue  # W, the smaller rank sum');
  } else if (method === 'permutation') {
    L.push('# 13 or fewer differences, some tied or zero: the exact p over all 2**n ways of');
    L.push("# signing them, ties as they are, as SciPy's default (method='auto') chooses here.");
    L.push('try:');
    L.push('    result = stats.wilcoxon(d, method=stats.PermutationMethod())');
    L.push('    found = result.statistic, result.pvalue');
    L.push('except (AttributeError, ValueError):  # SciPy before 1.13: the same count, by permutation_test');
    L.push('    ranks = np.zeros(len(d))');
    L.push('    ranks[d != 0] = stats.rankdata(np.abs(d[d != 0]))');
    L.push("    result = stats.permutation_test((d,), lambda s: ranks[s > 0].sum(), permutation_type='samples', n_resamples=np.inf)");
    L.push('    found = min(result.statistic, ranks.sum() - result.statistic), result.pvalue');
    L.push('statistic, p_value = found  # W, the smaller rank sum');
  } else {
    L.push('# More than 50 differences, or more than 13 with some tied or zero: the normal');
    L.push("# approximation with the tie-corrected variance and no continuity correction, as");
    L.push("# SciPy's default (method='auto') chooses here.");
    L.push('try:');
    L.push("    result = stats.wilcoxon(d, method='asymptotic')");
    L.push("except ValueError:  # SciPy before 1.15 calls it 'approx'");
    L.push("    result = stats.wilcoxon(d, method='approx')");
    L.push('statistic, p_value = result.statistic, result.pvalue  # W, the smaller rank sum');
  }
  L.push('');
  L.push('# z, for the effect size: zero differences dropped, ties at their average rank');
  L.push('# and in the variance.');
  L.push('kept = d[d != 0]');
  L.push('m = len(kept)');
  L.push('ties = np.unique(np.abs(kept), return_counts=True)[1]');
  L.push('z = (statistic - m * (m + 1) / 4) / np.sqrt(m * (m + 1) * (2 * m + 1) / 24 - (ties ** 3 - ties).sum() / 48)');
  L.push('effect = abs(z) / np.sqrt(m)  # r = |z| / sqrt(n)');
}

/* Which method the page's rank test used on the data in the model. */
function rankMethod(test, model, mu0) {
  const values = (model.groups || []).map((g) => (g && Array.isArray(g.values) ? g.values : []));
  let r = null;
  if (test === 'mannwhitney') r = mannWhitneyU(values[0] || [], values[1] || []);
  else if (test === 'wilcoxon') r = wilcoxonSignedRank(values[0] || [], values[1] || []);
  else if (test === 'wilcoxon_one') r = oneSampleWilcoxon(values[0] || [], mu0);
  return r ? r.method : 'asymptotic';
}

/* The test, as the page runs it, into `statistic`, `p_value` and `effect`. */
function testLines(L, test, names, mu0, method) {
  const [n1, n2] = names;
  const pairOf = () => { L.push(`a, b = ${dataRef(n1)}, ${dataRef(n2)}`); };
  const t2 = (pooled) => {
    pairOf();
    L.push(`result = stats.ttest_ind(a, b, equal_var=${pooled ? 'True' : 'False'})`);
    L.push('statistic, p_value = result.statistic, result.pvalue');
    if (pooled) {
      L.push('df = len(a) + len(b) - 2');
    } else {
      L.push('va, vb = a.var(ddof=1) / len(a), b.var(ddof=1) / len(b)');
      L.push('df = (va + vb) ** 2 / (va ** 2 / (len(a) - 1) + vb ** 2 / (len(b) - 1))  # Welch-Satterthwaite');
    }
    L.push("# Cohen's d, on the pooled SD whichever test gave t.");
    L.push('pooled_sd = np.sqrt(((len(a) - 1) * a.var(ddof=1) + (len(b) - 1) * b.var(ddof=1)) / (len(a) + len(b) - 2))');
    L.push('effect = (a.mean() - b.mean()) / pooled_sd');
    L.push("print(f\"t({df:.4g}) = {statistic:.4f}, p = {p_value:.4g}, Cohen's d = {effect:.3f}\")");
  };
  switch (test) {
    case 'ttest_welch': t2(false); break;
    case 'ttest_ind': t2(true); break;
    case 'mannwhitney':
      pairOf();
      mannWhitneyLines(L, method);
      L.push('statistic = min(result.statistic, len(a) * len(b) - result.statistic)  # U, the smaller of U1 and U2');
      L.push('p_value = result.pvalue');
      L.push('effect = 1 - 2 * statistic / (len(a) * len(b))  # rank-biserial r');
      L.push("print(f'U = {statistic:.1f}, p = {p_value:.4g}, rank-biserial r = {effect:.3f}')");
      break;
    case 'ttest_pair':
      pairOf();
      L.push('result = stats.ttest_rel(a, b)');
      L.push('statistic, p_value = result.statistic, result.pvalue');
      L.push('d = a - b');
      L.push("effect = d.mean() / d.std(ddof=1)  # Cohen's d_z");
      L.push("print(f\"t({len(d) - 1}) = {statistic:.4f}, p = {p_value:.4g}, Cohen's d_z = {effect:.3f}\")");
      break;
    case 'wilcoxon':
      pairOf();
      L.push('d = a - b');
      signedRankLines(L, method);
      L.push("print(f'W = {statistic:.1f}, z = {z:.4f}, p = {p_value:.4g}, r = {effect:.3f}')");
      break;
    case 'anova': {
      L.push('samples = list(data.values())');
      L.push('result = stats.f_oneway(*samples)');
      L.push('statistic, p_value = result.statistic, result.pvalue');
      L.push('grand = np.concatenate(samples).mean()');
      L.push('ss_between = sum(len(g) * (g.mean() - grand) ** 2 for g in samples)');
      L.push('ss_total = sum(((g - grand) ** 2).sum() for g in samples)');
      L.push('effect = ss_between / ss_total  # eta squared');
      L.push('df1, df2 = len(samples) - 1, sum(len(g) for g in samples) - len(samples)');
      L.push("print(f'F({df1}, {df2}) = {statistic:.4f}, p = {p_value:.4g}, eta squared = {effect:.3f}')");
      if (names.length > 2) {
        L.push('');
        L.push("# Tukey's HSD (Tukey-Kramer for unequal groups) for every pair.");
        L.push('names = list(data)');
        L.push('tukey = stats.tukey_hsd(*samples)');
        L.push('for i in range(len(names)):');
        L.push('    for j in range(i + 1, len(names)):');
        L.push("        print(f'  {names[i]} - {names[j]}: difference {tukey.statistic[i, j]:.4g}, p = {tukey.pvalue[i, j]:.4g}')");
      }
      break;
    }
    case 'welch_anova':
      L.push("# Welch's ANOVA (Welch 1951): each group weighted by n / s^2.");
      L.push('samples = list(data.values())');
      L.push('k = len(samples)');
      L.push('n = np.array([len(g) for g in samples])');
      L.push('means = np.array([g.mean() for g in samples])');
      L.push('w = n / np.array([g.var(ddof=1) for g in samples])');
      L.push('weighted_mean = (w * means).sum() / w.sum()');
      L.push('lam = (((1 - w / w.sum()) ** 2) / (n - 1)).sum()');
      L.push('statistic = ((w * (means - weighted_mean) ** 2).sum() / (k - 1)) / (1 + 2 * (k - 2) / (k ** 2 - 1) * lam)');
      L.push('df1, df2 = k - 1, (k ** 2 - 1) / (3 * lam)');
      L.push('p_value = stats.f.sf(statistic, df1, df2)');
      L.push('grand = np.concatenate(samples).mean()');
      L.push('effect = (n * (means - grand) ** 2).sum() / sum(((g - grand) ** 2).sum() for g in samples)  # eta squared');
      L.push("print(f'F({df1}, {df2:.2f}) = {statistic:.4f}, p = {p_value:.4g}, eta squared = {effect:.3f}')");
      break;
    case 'kruskal':
      L.push('samples = list(data.values())');
      L.push('result = stats.kruskal(*samples)  # tie-corrected H');
      L.push('statistic, p_value = result.statistic, result.pvalue');
      L.push('effect = statistic / (sum(len(g) for g in samples) - 1)  # epsilon squared');
      L.push("print(f'H({len(samples) - 1}) = {statistic:.4f}, p = {p_value:.4g}, epsilon squared = {effect:.3f}')");
      break;
    case 'ttest_one':
      L.push(`MU0 = ${pyNum(mu0)}  # the reference value`);
      L.push(`a = ${dataRef(n1)}`);
      L.push('result = stats.ttest_1samp(a, MU0)');
      L.push('statistic, p_value = result.statistic, result.pvalue');
      L.push("effect = (a.mean() - MU0) / a.std(ddof=1)  # Cohen's d");
      L.push("print(f\"t({len(a) - 1}) = {statistic:.4f}, p = {p_value:.4g}, Cohen's d = {effect:.3f}\")");
      break;
    case 'wilcoxon_one':
      L.push(`MU0 = ${pyNum(mu0)}  # the reference value`);
      L.push(`a = ${dataRef(n1)}`);
      L.push('d = a - MU0');
      signedRankLines(L, method);
      L.push("print(f'W = {statistic:.1f}, z = {z:.4f}, p = {p_value:.4g}, r = {effect:.3f}')");
      break;
    case 'pearson':
      L.push('result = stats.pearsonr(x, y)');
      L.push('statistic, p_value = result.statistic, result.pvalue');
      L.push('effect = statistic ** 2  # r squared');
      L.push("print(f'r({len(x) - 2}) = {statistic:.4f}, p = {p_value:.4g}, r squared = {effect:.3f}')");
      break;
    case 'spearman':
      L.push('result = stats.spearmanr(x, y)');
      L.push('statistic, p_value = result.statistic, result.pvalue');
      L.push('effect = len(x)  # pairs');
      L.push("print(f'rho({len(x) - 2}) = {statistic:.4f}, p = {p_value:.4g}, n = {effect}')");
      break;
    default:
      throw new Error(`statisticsScript: unknown test "${test}"`);
  }
}

/**
 * The Statistics Calculator's Python script.
 *
 * @param {object} figure - the figure as drawn (statisticsFigure's, with the person's
 *   style laid over it)
 * @param {object} spec
 * @param {string} spec.test - a key of STATISTICS_TESTS
 * @param {object} spec.model - the model statisticsFigure drew (its groups, or x and y)
 * @param {number} [spec.mu0] - the reference value of a one-sample test
 * @param {string} [spec.title] - what was compared, for the header
 * @returns {string}
 */
export function statisticsScript(figure, spec = {}) {
  const { test, model = {}, mu0 = 0 } = spec;
  const P = [];
  let names;
  if (model.kind === 'scatter') {
    names = [String(model.xLabel || 'x'), String(model.yLabel || 'y')];
    P.push('# The pairs the test used, as the page read them (complete rows only).');
    P.push(...pyArray('x', Array.from(model.x || [])), ...pyArray('y', Array.from(model.y || [])));
    P.push(`# x: ${comment(names[0])}; y: ${comment(names[1])}`);
  } else {
    const groups = (model.groups || []).filter((g) => g && Array.isArray(g.values) && g.values.length);
    names = groups.map((g) => String(g.name));
    P.push(model.kind === 'paired'
      ? '# The two measurements, paired by row (rows without a partner are left out).'
      : `# The values of ${groups.length === 1 ? 'the group' : 'each group'}, as the page read them.`);
    P.push('data = {');
    for (const g of groups) {
      const items = g.values.map(pyNum);
      const one = `    ${pyStr(g.name)}: np.array([${items.join(', ')}], dtype=float),`;
      if (one.length <= 88) P.push(one);
      else P.push(`    ${pyStr(g.name)}: np.array([`, ...wrapItems(items, '        '), '    ], dtype=float),');
    }
    P.push('}');
  }
  P.push('', '');
  section(P, 'Test');
  P.push(`# ${STATISTICS_TESTS[test] || comment(test)}${names.length ? `: ${comment(names.join(', '))}` : ''}.`);
  testLines(P, test, names, mu0, rankMethod(test, model, mu0));

  if (model.kind === 'scatter' && figure) {
    const drawnFit = (figure.panels || []).some((p) => (p.series || []).some((q) => q.id === 'fit'));
    if (drawnFit) {
      P.push('');
      P.push('# The least-squares line of y on x, across the data.');
      P.push('least_squares = stats.linregress(x, y)');
      P.push('fit_x = np.array([x.min(), x.max()])');
      P.push('fit_y = least_squares.intercept + least_squares.slope * fit_x');
      P.push("print(f'Least squares: y = {least_squares.slope:.6g} x + {least_squares.intercept:.6g}')");
    }
  }
  if (model.kind === 'paired') {
    const n = Math.min(...(model.groups || []).map((g) => g.values.length));
    P.push('');
    P.push("# Each pair joined, at the spread its two points have in the boxes (see below).");
    P.push(`offsets = (np.arange(${n}) * 0.6180339887498949 % 1 - 0.5) * ${pyNum(BOX_JITTER * BOX_WIDTH)}`);
    P.push('gaps = np.full(len(offsets), np.nan)  # breaks the line between pairs');
    P.push('pair_x = np.column_stack([0 + offsets, 1 + offsets, gaps]).ravel()');
    P.push(`pair_y = np.column_stack([${dataRef(names[0])}, ${dataRef(names[1])}, gaps]).ravel()`);
  }

  // figureScript imports scipy itself when a box shows its mean's interval.
  const f = normaliseFigure(figure || {});
  const boxStats = f.panels.some((p) => p.series.some((q) => q.show && q.kind === 'box' && q.mean));
  return figureScript(figure || {}, {
    header: [
      'Statistics from STEMKit (https://stemkit.net/stats-calculator.html).',
      `Runs the ${(STATISTICS_TESTS[test] || comment(test)).replace(/ \(.*\)$/, '').replace(/^(Paired|One)/, (w) => w.toLowerCase())} on the data the page used, as the page`,
      'runs it, prints the result, and draws the plot.'
    ],
    imports: boxStats ? [] : ['from scipy import stats'],
    prelude: P
  });
}
