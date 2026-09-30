/**
 * Statistical Calculator | UI layer.
 *
 * Every statistic, assumption check, distribution tail, box-plot whisker and
 * test recommendation lives in stemkit-core; this file handles DOM wiring,
 * KaTeX rendering, the SVG plot, table formatting and the publication-ready
 * summary text.
 *
 * Three numerical corrections came with the extraction and change what this
 * tool reports:
 *
 *   - Skewness and kurtosis now use the population standard deviation, as the
 *     standardised moments require. The previous sample-based form deflated
 *     skewness by about 15% at n = 10 and propagated into every D'Agostino
 *     normality p-value.
 *   - Upper-tail probabilities are computed through the complementary
 *     incomplete beta, so a strong ANOVA effect reports p ~ 3e-17 rather than
 *     underflowing to exactly 0.
 *   - Beyond |z| ~ 8 an asymptotic expansion takes over from the vendored erfc.
 */
import { registerFromGlobals } from '../src/core/vendor.js';
import {
  independentTTest,
  pairedTTest,
  oneSampleTTest,
  oneWayAnova,
  welchAnova,
  pearsonCorrelation,
  spearmanCorrelation,
  leastSquaresLine,
  mannWhitneyU,
  wilcoxonSignedRank,
  oneSampleWilcoxon,
  kruskalWallis,
  tukeyHSD,
  gamesHowell,
  dunnTest,
  recommendTest,
  dagostinoNormality,
  leveneTest,
  classifyFields,
  pivotLongToGroups,
  descriptives,
  alignPairs,
  formatP,
  interpretD,
  interpretEta,
  interpretR
} from '../src/core/statistics.js';
import { generateLatexTable, generateMarkdownTable } from '../src/core/latex.js';
import { statisticsFigure, statisticsScript } from '../src/core/statistics-figure.js';
import { toCSV } from '../src/core/data-cleaning.js';

// jStat, Papa, and KaTeX are loaded as UMD globals by the page's <script> tags.
registerFromGlobals();

/**
 * The tests the page offers. `design` and `inputs` decide which selectors
 * show; `id` is the name recommendTest() uses for the same test (Student's
 * pooled t has none, since the core never recommends it). Labels are written
 * to sit mid-sentence; cap() starts a sentence with one.
 */
const TESTS = {
  ttest_welch: { label: "Welch's t-test", design: 'independent', inputs: 'two', id: 'welch-t' },
  ttest_ind: { label: "Student's t-test", design: 'independent', inputs: 'two' },
  mannwhitney: { label: 'Mann–Whitney U test', design: 'independent', inputs: 'two', id: 'mann-whitney' },
  ttest_pair: { label: 'paired t-test', design: 'paired', inputs: 'two', id: 'paired-t' },
  wilcoxon: { label: 'Wilcoxon signed-rank test', design: 'paired', inputs: 'two', id: 'wilcoxon' },
  anova: { label: 'one-way ANOVA', design: 'independent', inputs: 'k', id: 'anova' },
  welch_anova: { label: "Welch's ANOVA", design: 'independent', inputs: 'k', id: 'welch-anova' },
  kruskal: { label: 'Kruskal–Wallis test', design: 'independent', inputs: 'k', id: 'kruskal-wallis' },
  ttest_one: { label: 'one-sample t-test', design: 'one-sample', inputs: 'one', id: 'one-sample-t' },
  wilcoxon_one: { label: 'one-sample Wilcoxon signed-rank test', design: 'one-sample', inputs: 'one', id: 'one-sample-wilcoxon' },
  pearson: { label: 'Pearson correlation', design: 'association', inputs: 'two', id: 'pearson' },
  spearman: { label: 'Spearman rank correlation', design: 'association', inputs: 'two', id: 'spearman' }
};
const BY_ID = {};
for (const [key, t] of Object.entries(TESTS)) if (t.id) BY_ID[t.id] = key;

const INPUT_LABELS = {
  independent: ['Group 1', 'Group 2'],
  paired: ['First measurement', 'Second measurement'],
  association: ['X variable', 'Y variable'],
  'one-sample': ['Variable', '']
};

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
/** A typographic minus for numbers shown on the page; copies keep ASCII. */
const minus = (s) => String(s).replace(/(^|[\s([,=])-(?=\d|\.\d|∞)/g, '$1−');
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/** "p = .032", or "p < .001" rather than "p = < .001". */
const pEq = (p) => (formatP(p).startsWith('<') ? `p ${formatP(p)}` : `p = ${formatP(p)}`);
const fx = (v, d) => (Number.isFinite(v) ? v.toFixed(d) : 'n/a');
/** Full-precision value for CSV, without float noise such as 23.419999999999998. */
const num = (v) => (Number.isFinite(v) ? String(Number(v.toPrecision(12))) : '');
const formatNumber = (v) => String(Number(v.toPrecision(10)));

document.addEventListener('DOMContentLoaded', () => {

  // --- 1. State ---
  let parsedData = {};
  let variables = [];
  let rawRows = [];
  let rawFields = [];
  let numericFields = [];
  let categoricalFields = [];
  let activeFormat = 'wide';
  let lastRunSig = null;
  let lastView = null;

  // --- 2. Bindings ---
  const $ = (id) => document.getElementById(id);
  const dataInput = $('dataInput');
  const fileInput = $('fileInput');
  const dataMeta = $('dataMeta');

  const formatSelect = $('formatSelect');
  const longControls = $('longControls');
  const valueColSelect = $('valueColSelect');
  const groupColSelect = $('groupColSelect');

  const testType = $('testType');
  const var1 = $('var1');
  const var2 = $('var2');
  const var1Label = $('var1Label');
  const var2Label = $('var2Label');
  const var2Field = $('var2Field');
  const mu0 = $('mu0');
  const mu0Field = $('mu0Field');
  const mu0Hint = $('mu0Hint');
  const groupSelect = $('groupSelect');
  const twoVarRow = $('twoVarRow');
  const groupRow = $('groupRow');
  const runTestBtn = $('runTestBtn');

  const adviceBox = $('adviceBox');
  const adviceTitle = $('adviceTitle');
  const adviceText = $('adviceText');
  const adviceUse = $('adviceUse');

  const resultsContainer = $('resultsContainer');
  const resultMethod = $('resultMethod');
  const staleNote = $('staleNote');
  const statLabel = $('statLabel');
  const statValue = $('statValue');
  const pValueEl = $('pValue');
  const effectLabel = $('effectLabel');
  const effectValue = $('effectValue');
  const ciBox = $('ciBox');
  const assumptionsBox = $('assumptionsBox');
  const pubSummary = $('pubSummary');
  const copyBtn = $('copyBtn');
  const theoryContainer = $('theoryContainer');
  const plotCaption = $('plotCaption');
  const descTable = $('descTable');
  const descNote = $('descNote');
  const pairwiseSection = $('pairwiseSection');
  const pairwiseWarn = $('pairwiseWarn');
  const pairTable = $('pairTable');
  const pairNote = $('pairNote');

  const resultsShown = () => !resultsContainer.classList.contains('hidden');

  // --- 3. Parsing ---
  if (fileInput) fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => { markSample(null); dataInput.value = ev.target.result; parseData(); };
    reader.readAsText(file);
  });

  // The data is read as it is typed or pasted, so there is no separate parse
  // step. While typing, a half-finished table is expected, so parsing stays
  // quiet: no toasts, and the status line under the box says what was read.
  let parseTimer = null;
  dataInput.addEventListener('input', () => {
    markSample(null);
    clearTimeout(parseTimer);
    parseTimer = setTimeout(() => {
      if (dataInput.value.trim()) parseData({ quiet: true });
      else clearParsed();
    }, 300);
  });

  function clearParsed() {
    parsedData = {}; variables = []; rawRows = []; rawFields = [];
    [var1, var2, groupSelect].forEach(el => { el.innerHTML = ''; el.disabled = true; });
    runTestBtn.disabled = true;
    dataMeta.innerText = 'Read as you type or paste.';
    resultsContainer.classList.add('hidden');
    staleNote.hidden = true;
    settingsChanged();
  }

  function parseData(opts = {}) {
    const quiet = !!opts.quiet;
    const rawText = dataInput.value.trim();
    if (!rawText) return quiet ? clearParsed() : showToast('Please input some data first.', 'error');

    Papa.parse(rawText, {
      header: true,
      dynamicTyping: true,
      skipEmptyLines: true,
      delimitersToGuess: ['\t', ',', ';', '|', ' '],
      complete: (results) => {
        if (results.errors.length > 0 && results.data.length === 0) {
          if (quiet) dataMeta.innerText = 'Could not read a table yet. The first row should be a header.';
          else showToast('Error parsing data. Ensure the first row is a header.', 'error');
          return;
        }

        rawRows = results.data;
        rawFields = (results.meta.fields || [])
          .filter(f => f && String(f).trim() !== '');

        const cls = classifyFields(rawRows, rawFields);
        numericFields = cls.numeric;
        categoricalFields = cls.categorical;

        // Long format is one numeric column split by a grouping column;
        // anything else is wide.
        const chosen = formatSelect ? formatSelect.value : 'auto';
        activeFormat = chosen === 'auto'
          ? ((numericFields.length === 1 &&
              categoricalFields.some(c => !numericFields.includes(c)))
              ? 'long' : 'wide')
          : chosen;

        if (activeFormat === 'long') {
          setupLongControls();
          buildLongGroups();
        } else {
          buildWideGroups();
        }

        if (!quiet) showToast(
          `Parsed as ${activeFormat === 'long' ? 'long / tidy' : 'wide'} format.`,
          'success'
        );
      }
    });
  }

  function buildWideGroups() {
    if (longControls) longControls.style.display = 'none';
    variables = [];
    parsedData = {};

    for (const v of numericFields) {
      const arr = rawRows
        .map(r => r[v])
        .filter(x => typeof x === 'number' && Number.isFinite(x));
      if (arr.length) {
        parsedData[v] = arr;
        variables.push(v);
      }
    }

    dataMeta.innerText =
      `${rawRows.length} rows, ${variables.length} numeric ` +
      `column${variables.length === 1 ? '' : 's'} (wide)`;
    updateDropdowns();
  }

  function buildLongGroups() {
    const valueCol = valueColSelect.value;
    const groupCol = groupColSelect.value;

    if (!valueCol || !groupCol || valueCol === groupCol) {
      showToast('Pick distinct value and group columns.', 'error');
      return;
    }

    const { groups, order } = pivotLongToGroups(rawRows, valueCol, groupCol);
    parsedData = groups;
    variables = order;

    dataMeta.innerText =
      `${rawRows.length} rows, ${variables.length} ` +
      `group${variables.length === 1 ? '' : 's'} of "${valueCol}" by "${groupCol}" (long)`;
    updateDropdowns();
  }

  function setupLongControls() {
    if (!longControls) return;
    longControls.style.display = '';
    valueColSelect.innerHTML = '';
    groupColSelect.innerHTML = '';

    const valueCandidates = numericFields.length ? numericFields : rawFields.slice();
    for (const f of valueCandidates) valueColSelect.add(new Option(f, f));
    valueColSelect.selectedIndex = 0;

    const chosenValue = valueColSelect.value;
    const nonNumeric = rawFields.filter(f =>
      !numericFields.includes(f) && f !== chosenValue);
    const groupCandidates = nonNumeric.length
      ? nonNumeric
      : rawFields.filter(f => f !== chosenValue);

    for (const f of (groupCandidates.length ? groupCandidates : rawFields)) {
      groupColSelect.add(new Option(f, f));
    }
    groupColSelect.selectedIndex = 0;
  }

  function updateDropdowns() {
    // Keep the user's picks when the data is re-read as they type.
    const keep1 = var1.value;
    const keep2 = var2.value;
    const keepGroups = new Set(Array.from(groupSelect.selectedOptions).map(o => o.value));
    var1.innerHTML = '';
    var2.innerHTML = '';
    groupSelect.innerHTML = '';

    for (const v of variables) {
      var1.add(new Option(v, v));
      var2.add(new Option(v, v));
      const opt = new Option(`${v} (n=${parsedData[v].length})`, v);
      opt.selected = keepGroups.size ? keepGroups.has(v) : true;
      groupSelect.add(opt);
    }
    if (!Array.from(groupSelect.options).some(o => o.selected)) {
      Array.from(groupSelect.options).forEach(o => { o.selected = true; });
    }

    if (variables.includes(keep1)) var1.value = keep1;
    if (variables.includes(keep2) && keep2 !== var1.value) var2.value = keep2;
    else if (variables.length > 1) var2.value = variables.find(v => v !== var1.value);
    var1.disabled = false;
    var2.disabled = false;
    groupSelect.disabled = false;
    runTestBtn.disabled = false;
    settingsChanged();
  }

  function syncSelectorVisibility() {
    const meta = TESTS[testType.value];
    twoVarRow.hidden = meta.inputs === 'k';
    groupRow.hidden = meta.inputs !== 'k';
    var2Field.hidden = meta.inputs === 'one';
    mu0Field.hidden = meta.inputs !== 'one';
    mu0Hint.hidden = meta.inputs !== 'one';
    const [l1, l2] = INPUT_LABELS[meta.design];
    var1Label.textContent = l1;
    var2Label.textContent = l2;
  }

  // Render the theory as soon as a test is chosen, not only after running it:
  // the formula and its symbol definitions are most useful while deciding
  // whether this is the right test.
  testType.addEventListener('change', () => {
    syncSelectorVisibility();
    renderTheory(testType.value);
    settingsChanged();
  });
  [var1, var2, groupSelect].forEach(el => el.addEventListener('change', settingsChanged));
  mu0.addEventListener('input', settingsChanged);

  if (formatSelect) formatSelect.addEventListener('change', () => {
    if (rawRows.length) parseData();
  });
  if (valueColSelect) valueColSelect.addEventListener('change', () => {
    if (activeFormat === 'long') buildLongGroups();
  });
  if (groupColSelect) groupColSelect.addEventListener('change', () => {
    if (activeFormat === 'long') buildLongGroups();
  });

  // --- 4. Selection, advice and staleness ---

  /** What the current controls select: the test and the samples. */
  function currentSelection() {
    const type = testType.value;
    const meta = TESTS[type];
    let names;
    if (meta.inputs === 'k') names = Array.from(groupSelect.selectedOptions).map(o => o.value);
    else if (meta.inputs === 'one') names = [var1.value];
    else names = [var1.value, var2.value];
    names = names.filter(n => n && parsedData[n]);
    return { type, meta, names, groups: names.map(n => parsedData[n]), mu0: parseFloat(mu0.value) };
  }

  /** Why the selection cannot be run, or null. */
  function selectionProblem(sel) {
    const { meta, names, groups } = sel;
    if (meta.inputs === 'k') {
      if (names.length < 2) return 'Select at least two groups.';
      if (groups.some(g => g.length < 2)) return 'Each group needs at least 2 numeric values.';
      return null;
    }
    if (names.length < (meta.inputs === 'one' ? 1 : 2)) return 'Selected variables contain no valid numeric data.';
    if (meta.inputs === 'two' && names[0] === names[1]) return 'Choose two different columns.';
    if (groups.some(g => g.length < 2)) return 'Each variable needs at least 2 numeric values.';
    if (meta.inputs === 'one' && !Number.isFinite(sel.mu0)) return 'Enter a number to compare with.';
    return null;
  }

  function runSignature() {
    const sel = currentSelection();
    return JSON.stringify([sel.type, sel.names, sel.meta.inputs === 'one' ? mu0.value : '',
      dataInput.value, activeFormat, valueColSelect.value, groupColSelect.value]);
  }

  /** Re-derive the advice, and flag results that no longer match the controls. */
  function settingsChanged() {
    updateAdvice();
    if (resultsShown() && lastRunSig) staleNote.hidden = runSignature() === lastRunSig;
  }

  let adviceKey = null;
  function updateAdvice() {
    adviceKey = null;
    if (!variables.length) { adviceBox.hidden = true; return; }
    const sel = currentSelection();
    if (selectionProblem({ ...sel, mu0: 0 })) { adviceBox.hidden = true; return; }
    const rec = recommendTest({ design: sel.meta.design, groups: sel.groups, names: sel.names });
    const key = rec && BY_ID[rec.test];
    if (!key) { adviceBox.hidden = true; return; }

    const match = key === sel.type;
    adviceBox.classList.toggle('is-match', match);
    adviceTitle.textContent = match
      ? `${cap(TESTS[key].label)} fits this data.`
      : `Suggested: ${cap(TESTS[key].label)}.`;
    adviceText.textContent = rec.reason;
    adviceUse.hidden = match;
    adviceUse.setAttribute('aria-label', `Use the ${TESTS[key].label}`);
    adviceKey = match ? null : key;
    adviceBox.hidden = false;
  }

  // A suggestion is only ever applied by this button: the page never swaps
  // the test on its own.
  adviceUse.addEventListener('click', () => {
    if (!adviceKey) return;
    const prev = currentSelection();
    const key = adviceKey;
    testType.value = key;
    // Coming from the k-group selector to a two-group test, keep the two groups.
    if (TESTS[key].inputs === 'two' && prev.meta.inputs === 'k' && prev.names.length >= 2) {
      var1.value = prev.names[0];
      var2.value = prev.names[1];
    }
    syncSelectorVisibility();
    renderTheory(key);
    settingsChanged();
    if (resultsShown()) executeTest();
    else pulseRun();
  });

  function pulseRun() {
    runTestBtn.classList.remove('run-pulse');
    void runTestBtn.offsetWidth;
    runTestBtn.classList.add('run-pulse');
    setTimeout(() => runTestBtn.classList.remove('run-pulse'), 1600);
  }

  // --- 5. Test runner (delegated to the core) ---
  runTestBtn.addEventListener('click', executeTest);

  function executeTest() {
    const sel = currentSelection();
    const problem = selectionProblem(sel);
    if (problem) return showToast(problem, 'error');

    let view;
    try {
      view = RUNNERS[sel.type](sel);
    } catch (err) {
      console.error(err);
      return showToast('A calculation failed. Check the data for constant columns or very short groups.', 'error');
    }
    if (!view) return;

    lastRun = { test: sel.type, mu0: sel.mu0 };
    // Shown before rendering, so the plot can measure the space it has.
    resultsContainer.classList.remove('hidden');
    renderView(view);
    renderTheory(sel.type);
    lastRunSig = runSignature();
    staleNote.hidden = true;
  }

  /** The axis titles for group plots: the long-format column names if any. */
  function axisNames() {
    return activeFormat === 'long'
      ? { value: valueColSelect.value || 'Value', group: groupColSelect.value || 'Group' }
      : { value: 'Value', group: 'Column' };
  }

  const groupPlot = (sel, extra = {}) => ({
    kind: 'groups',
    groups: sel.names.map((n, i) => ({ name: n, values: sel.groups[i] })),
    yLabel: axisNames().value,
    xLabel: axisNames().group,
    ...extra
  });
  const descRows = (sel) => sel.names.map((n, i) => ({ name: n, values: sel.groups[i] }));

  function normalityWarn(names, groups, alternative) {
    const norms = groups.map(dagostinoNormality);
    const bad = names.filter((n, i) => norms[i].ok === false);
    const warns = [];
    if (bad.length) {
      warns.push({
        level: 'warn',
        text: `Normality (D'Agostino K²) is questionable for ${bad.join(' & ')}. Consider the ${alternative}.`
      });
    }
    return { norms, warns };
  }

  const verdict = (p) => (p < 0.05 ? 'statistically significant' : 'not statistically significant');

  const RUNNERS = {
    ttest_welch: (sel) => runIndependentT(sel, false),
    ttest_ind: (sel) => runIndependentT(sel, true),
    ttest_pair: runPairedT,
    mannwhitney: runMannWhitney,
    wilcoxon: runWilcoxon,
    anova: runANOVA,
    welch_anova: runWelchANOVA,
    kruskal: runKruskal,
    ttest_one: runOneSampleT,
    wilcoxon_one: runOneSampleWilcoxon,
    pearson: (sel) => runCorrelation(sel, false),
    spearman: (sel) => runCorrelation(sel, true)
  };

  function runIndependentT(sel, pooled) {
    const [n1Name, n2Name] = sel.names;
    const [arr1, arr2] = sel.groups;
    const r = independentTTest(arr1, arr2, { pooled });
    if (!r) return showToast('Each group needs at least 2 values.', 'error');

    const { norms, warns } = normalityWarn(sel.names, sel.groups, 'Mann–Whitney U test');
    const lev = leveneTest([arr1, arr2]);
    if (lev.ok === false && pooled) {
      warns.push({
        level: 'warn',
        text: `Levene's test is significant (W = ${lev.W.toFixed(2)}, ${pEq(lev.p)}): ` +
              `variances differ. Prefer Welch's t-test over the pooled version.`
      });
    }
    if (lev.ok !== false && !pooled) {
      warns.push({
        level: 'ok',
        text: `Levene's test not significant (${pEq(lev.p)}): the equal-variance ` +
              `assumption is tenable, so Student's pooled t would also be valid.`
      });
    }

    return {
      method: `${pooled ? "Student's" : "Welch's"} t-test, ${n1Name} against ${n2Name}`,
      stat: ['t statistic', r.t], p: r.p, effect: ["Cohen's d", r.d],
      ci: `95% CI for the mean difference (${n1Name} − ${n2Name}): [${r.ci[0].toFixed(3)}, ${r.ci[1].toFixed(3)}] ` +
          `(Hedges' g = ${r.g.toFixed(3)})`,
      assumptions: {
        warns,
        footer: `Levene W(${lev.df1}, ${lev.df2}) = ${fx(lev.W, 3)}, ${pEq(lev.p)}; ` +
                `normality: ${n1Name} ${pEq(norms[0].p)}, ${n2Name} ${pEq(norms[1].p)}`
      },
      summary:
        `${cap(r.method)} compared ${n1Name} (M = ${r.mean1.toFixed(2)}, ` +
        `SD = ${r.sd1.toFixed(2)}, n = ${r.n1}) and ${n2Name} (M = ${r.mean2.toFixed(2)}, ` +
        `SD = ${r.sd2.toFixed(2)}, n = ${r.n2}). The difference was ${verdict(r.p)}, ` +
        `t(${r.df.toFixed(2)}) = ${r.t.toFixed(3)}, ${pEq(r.p)}, ` +
        `95% CI [${r.ci[0].toFixed(2)}, ${r.ci[1].toFixed(2)}], ` +
        `Cohen's d = ${r.d.toFixed(2)} (${interpretD(r.d)}).`,
      plot: groupPlot(sel),
      desc: { rows: descRows(sel) },
      pairwise: null
    };
  }

  function runPairedT(sel) {
    const [n1Name, n2Name] = sel.names;
    const r = pairedTTest(sel.groups[0], sel.groups[1]);
    if (!r) return showToast('Paired tests need at least 2 complete pairs.', 'error');
    if (!Number.isFinite(r.t)) return showToast('Every pair differs by the same amount, so the t statistic is undefined.', 'error');

    const normD = dagostinoNormality(r.diffs);
    const warns = [];
    if (normD.ok === false) {
      warns.push({
        level: 'warn',
        text: `Normality of the differences is questionable (D'Agostino ${pEq(normD.p)}). ` +
              `Consider the Wilcoxon signed-rank test.`
      });
    } else if (normD.ok === true) {
      warns.push({
        level: 'ok',
        text: `Differences are consistent with normality (D'Agostino ${pEq(normD.p)}).`
      });
    }

    return {
      method: `Paired t-test, ${n1Name} against ${n2Name}`,
      stat: ['t statistic', r.t], p: r.p, effect: ["Cohen's d<sub>z</sub>", r.dz],
      ci: `95% CI for the mean difference (${n1Name} − ${n2Name}): [${r.ci[0].toFixed(3)}, ${r.ci[1].toFixed(3)}] (n = ${r.n} pairs)`,
      assumptions: { warns, footer: `The test operates on ${r.n} paired differences.` },
      summary:
        `A paired-samples t-test compared ${n1Name} and ${n2Name} (n = ${r.n} pairs). ` +
        `The mean difference was ${r.meanDiff.toFixed(2)} (SD = ${r.sdDiff.toFixed(2)}); ` +
        `the effect was ${verdict(r.p)}, ` +
        `t(${r.df}) = ${r.t.toFixed(3)}, ${pEq(r.p)}, ` +
        `95% CI [${r.ci[0].toFixed(2)}, ${r.ci[1].toFixed(2)}], ` +
        `Cohen's dz = ${r.dz.toFixed(2)} (${interpretD(r.dz)}).`,
      ...pairedParts(sel)
    };
  }

  /** Plot and descriptives for a paired design: the complete pairs only. */
  function pairedParts(sel) {
    const [n1Name, n2Name] = sel.names;
    const { a, b } = alignPairs(sel.groups[0], sel.groups[1]);
    const dropped = Math.abs(sel.groups[0].length - sel.groups[1].length);
    return {
      plot: {
        kind: 'paired',
        groups: [{ name: n1Name, values: a }, { name: n2Name, values: b }],
        yLabel: axisNames().value,
        xLabel: 'Measurement'
      },
      desc: {
        rows: [{ name: n1Name, values: a }, { name: n2Name, values: b },
          { name: `Difference (${n1Name} − ${n2Name})`, values: a.map((v, i) => v - b[i]) }],
        note: `Values are paired by row. ${dropped
          ? `${dropped} value${dropped === 1 ? '' : 's'} without a partner ${dropped === 1 ? 'was' : 'were'} left out.`
          : ''}`
      },
      pairwise: null
    };
  }

  function groupSummaryText(names, means, sds, ns) {
    return names.map((nm, i) =>
      `${nm} (M = ${means[i].toFixed(2)}, SD = ${sds[i].toFixed(2)}, n = ${ns[i]})`).join('; ');
  }

  function runANOVA(sel) {
    const { names, groups } = sel;
    const r = oneWayAnova(groups);
    if (!r) return showToast('Each group needs at least 2 values.', 'error');

    const lev = leveneTest(groups);
    const norms = groups.map(dagostinoNormality);
    const warns = [];
    if (lev.ok === false) {
      warns.push({
        level: 'warn',
        text: `Levene's test is significant (W = ${lev.W.toFixed(2)}, ${pEq(lev.p)}): ` +
              `group variances differ. Consider Welch's ANOVA with Games–Howell comparisons.`
      });
    } else {
      warns.push({
        level: 'ok',
        text: `Levene's test not significant (${pEq(lev.p)}): homogeneity of variance is tenable.`
      });
    }
    if (norms.some(x => x.ok === false)) {
      warns.push({
        level: 'warn',
        text: `At least one group departs from normality (D'Agostino). With small, ` +
              `unequal groups consider the Kruskal–Wallis test.`
      });
    }

    const ph = names.length > 2 ? tukeyHSD(groups) : null;
    return {
      method: `One-way ANOVA across ${r.k} groups${ph ? ', with Tukey HSD' : ''}`,
      stat: ['F statistic', r.F], p: r.p, effect: ['η²', r.etaSquared],
      ci: `η² = ${r.etaSquared.toFixed(3)}, ω² = ${r.omegaSquared.toFixed(3)}; ` +
          `F(${r.dfBetween}, ${r.dfWithin})`,
      assumptions: { warns, footer: `Levene W(${lev.df1}, ${lev.df2}) = ${fx(lev.W, 3)}, ${pEq(lev.p)}` },
      summary:
        `A one-way ANOVA compared ${r.k} groups: ${groupSummaryText(names, r.groupMeans, r.groupSds, r.groupNs)}. ` +
        `The effect was ${verdict(r.p)}, ` +
        `F(${r.dfBetween}, ${r.dfWithin}) = ${r.F.toFixed(3)}, ${pEq(r.p)}, ` +
        `η² = ${r.etaSquared.toFixed(3)} (${interpretEta(r.etaSquared)}), ` +
        `ω² = ${r.omegaSquared.toFixed(3)}.` + posthocSentence(names, ph, 'Tukey HSD comparisons'),
      plot: groupPlot(sel),
      desc: { rows: descRows(sel) },
      pairwise: pairwiseView(names, ph, r.p)
    };
  }

  function runWelchANOVA(sel) {
    const { names, groups } = sel;
    const r = welchAnova(groups);
    if (!r) return showToast('Each group needs at least 2 values.', 'error');
    if (!Number.isFinite(r.F)) return showToast(`Welch's ANOVA is undefined here: ${r.note}.`, 'error');

    const lev = leveneTest(groups);
    const { warns } = normalityWarn(names, groups, 'Kruskal–Wallis test');
    warns.push({
      level: 'ok',
      text: `Welch's ANOVA does not assume equal variances` +
            (Number.isFinite(lev.p) ? ` (Levene ${pEq(lev.p)}).` : '.')
    });

    const ph = names.length > 2 ? gamesHowell(groups) : null;
    return {
      method: `Welch's ANOVA across ${r.k} groups${ph ? ', with Games–Howell comparisons' : ''}`,
      stat: ['F statistic', r.F], p: r.p, effect: ['η²', r.etaSquared],
      ci: `F(${r.df1}, ${r.df2.toFixed(2)}); the second df is Welch's, which is why it is not a whole number. ` +
          `η² = ${r.etaSquared.toFixed(3)}`,
      assumptions: { warns, footer: `Levene W(${lev.df1}, ${lev.df2}) = ${fx(lev.W, 3)}, ${pEq(lev.p)}` },
      summary:
        `Welch's ANOVA compared ${r.k} groups: ${groupSummaryText(names, r.groupMeans, r.groupSds, r.groupNs)}. ` +
        `The effect was ${verdict(r.p)}, ` +
        `F(${r.df1}, ${r.df2.toFixed(2)}) = ${r.F.toFixed(3)}, ${pEq(r.p)}, ` +
        `η² = ${r.etaSquared.toFixed(3)} (${interpretEta(r.etaSquared)}).` +
        posthocSentence(names, ph, 'Games–Howell comparisons'),
      plot: groupPlot(sel),
      desc: { rows: descRows(sel) },
      pairwise: pairwiseView(names, ph, r.p)
    };
  }

  function runKruskal(sel) {
    const { names, groups } = sel;
    const r = kruskalWallis(groups);
    if (!r) return showToast('Each group needs at least one value.', 'error');
    if (!Number.isFinite(r.H)) return showToast('Every value is the same, so there is nothing to rank.', 'error');

    const ph = names.length > 2 ? dunnTest(groups) : null;
    const small = r.groupNs.some(n => n <= 5);
    const desc = names.map((nm, i) =>
      `${nm} (Mdn = ${r.groupMedians[i].toFixed(2)}, n = ${r.groupNs[i]})`).join('; ');

    return {
      method: `Kruskal–Wallis test across ${r.k} groups${ph ? ", with Dunn's comparisons (Holm)" : ''}`,
      stat: ['H statistic', r.H], p: r.p, effect: ['ε²', r.epsilonSquared],
      ci: `H(${r.df}) with the tie correction C = ${r.tieCorrection.toFixed(4)}; ` +
          `mean ranks: ${names.map((n, i) => `${n} ${r.meanRanks[i].toFixed(2)}`).join(', ')}`,
      assumptions: {
        warns: [{
          level: 'ok',
          text: 'Rank-based: no normality assumption. A significant H says at least one group ' +
                'tends to have larger values; read it as a difference in medians only if the ' +
                'groups have similar shapes.'
        }].concat(small ? [{
          level: 'warn',
          text: 'Some groups have five or fewer values, where the chi-squared approximation to H is rough.'
        }] : []),
        footer: `N = ${r.N}; p from the chi-squared distribution on ${r.df} df.`
      },
      summary:
        `A Kruskal–Wallis test compared ${r.k} groups: ${desc}. The difference was ${verdict(r.p)}, ` +
        `H(${r.df}) = ${r.H.toFixed(2)}, ${pEq(r.p)}, ε² = ${r.epsilonSquared.toFixed(2)}.` +
        posthocSentence(names, ph, "Dunn's tests with Holm's correction"),
      plot: groupPlot(sel),
      desc: { rows: descRows(sel) },
      pairwise: pairwiseView(names, ph, r.p)
    };
  }

  function runOneSampleT(sel) {
    const [name] = sel.names;
    const r = oneSampleTTest(sel.groups[0], sel.mu0);
    if (!r) return showToast('The one-sample test needs at least 2 values.', 'error');
    if (!Number.isFinite(r.t)) return showToast('Every value is the same, so the t statistic is undefined.', 'error');

    const norm = dagostinoNormality(sel.groups[0]);
    const warns = [];
    if (norm.ok === false) {
      warns.push({ level: 'warn', text: `Normality is questionable (D'Agostino ${pEq(norm.p)}). Consider the one-sample Wilcoxon signed-rank test.` });
    } else if (norm.ok === true) {
      warns.push({ level: 'ok', text: `The values are consistent with normality (D'Agostino ${pEq(norm.p)}).` });
    }
    const mu = formatNumber(r.mu0);

    return {
      method: `One-sample t-test, ${name} against μ₀ = ${mu}`,
      stat: ['t statistic', r.t], p: r.p, effect: ["Cohen's d", r.d],
      ci: `Mean ${r.mean.toPrecision(6)}, 95% CI [${r.ci[0].toPrecision(6)}, ${r.ci[1].toPrecision(6)}]; ` +
          `difference from μ₀ ${r.meanDiff.toPrecision(4)}, 95% CI [${r.ciDiff[0].toPrecision(4)}, ${r.ciDiff[1].toPrecision(4)}]`,
      assumptions: { warns, footer: norm.ok === null ? `Normality not tested: ${norm.note}.` : `n = ${r.n}` },
      summary:
        `A one-sample t-test compared ${name} (M = ${r.mean.toPrecision(4)}, SD = ${r.sd.toPrecision(3)}, n = ${r.n}) ` +
        `with the reference value μ₀ = ${mu}. The mean was ${r.meanDiff >= 0 ? 'higher' : 'lower'} by ` +
        `${Math.abs(r.meanDiff).toPrecision(3)}, a difference that was ${verdict(r.p)}, ` +
        `t(${r.df}) = ${r.t.toFixed(3)}, ${pEq(r.p)}, ` +
        `95% CI of the difference [${r.ciDiff[0].toPrecision(3)}, ${r.ciDiff[1].toPrecision(3)}], ` +
        `Cohen's d = ${r.d.toFixed(2)} (${interpretD(r.d)}).`,
      plot: groupPlot(sel, { ref: { value: r.mu0, label: `μ₀ = ${mu}` }, xLabel: '' }),
      desc: { rows: descRows(sel) },
      pairwise: null
    };
  }

  function runOneSampleWilcoxon(sel) {
    const [name] = sel.names;
    const r = oneSampleWilcoxon(sel.groups[0], sel.mu0);
    if (!r) return showToast('Every value equals μ₀, so there is nothing to rank.', 'error');
    const mu = formatNumber(r.mu0);

    return {
      method: `One-sample Wilcoxon signed-rank test, ${name} against μ₀ = ${mu}`,
      stat: ['W statistic', r.W], p: r.p, effect: ['effect r (z/√n)', r.effectR],
      ci: `z = ${fx(r.z, 3)} (normal approximation); median ${r.median.toPrecision(6)}; ` +
          `${r.n} values differ from μ₀`,
      assumptions: {
        warns: [{
          level: 'ok',
          text: 'Rank-based: no normality assumption, but the values should be roughly symmetric about their median.'
        }],
        footer: `${r.nDropped} value(s) equal to μ₀ dropped; normal approximation used (recommended for n ≳ 20).`
      },
      summary:
        `A one-sample Wilcoxon signed-rank test compared ${name} (Mdn = ${r.median.toPrecision(4)}, n = ${r.n + r.nDropped}) ` +
        `with μ₀ = ${mu}. The difference was ${verdict(r.p)}, ` +
        `W = ${r.W.toFixed(1)}, z = ${fx(r.z, 3)}, ${pEq(r.p)}, effect r = ${fx(r.effectR, 2)}.`,
      plot: groupPlot(sel, { ref: { value: r.mu0, label: `μ₀ = ${mu}` }, xLabel: '' }),
      desc: { rows: descRows(sel) },
      pairwise: null
    };
  }

  function runCorrelation(sel, spearman) {
    const [n1Name, n2Name] = sel.names;
    const { a: x, b: y } = alignPairs(sel.groups[0], sel.groups[1]);
    const r = spearman ? spearmanCorrelation(x, y) : pearsonCorrelation(x, y);
    if (!r) return showToast('Correlation needs at least 3 complete pairs.', 'error');
    const coef = spearman ? r.rho : r.r;
    if (!Number.isFinite(coef)) return showToast('One variable is constant, so there is no correlation to measure.', 'error');

    const normX = dagostinoNormality(x);
    const normY = dagostinoNormality(y);
    const warns = [];
    if (spearman) {
      warns.push({
        level: 'ok',
        text: 'Rank-based: no normality assumption. ρ measures any monotonic relationship, straight or curved.'
      });
    } else if (normX.ok === false || normY.ok === false) {
      warns.push({
        level: 'warn',
        text: `One or both variables depart from normality. Pearson's r assumes ` +
              `bivariate normality for its p-value; consider Spearman's ρ.`
      });
    }

    const ciText = Number.isFinite(r.ci[0]) ? `[${r.ci[0].toFixed(3)}, ${r.ci[1].toFixed(3)}]` : 'undefined for n = 3';
    const ciApa = Number.isFinite(r.ci[0]) ? `, 95% CI [${r.ci[0].toFixed(2)}, ${r.ci[1].toFixed(2)}]` : '';
    const parts = {
      plot: { kind: 'scatter', x, y, xLabel: n1Name, yLabel: n2Name, line: leastSquaresLine(x, y), spearman },
      desc: {
        rows: [{ name: n1Name, values: x }, { name: n2Name, values: y }],
        perRow: true,
        note: 'Values are paired by row; only complete pairs are used.'
      },
      pairwise: null
    };
    if (spearman) {
      return {
        method: `Spearman rank correlation, ${n1Name} and ${n2Name}`,
        stat: ["Spearman's ρ", r.rho], p: r.p, effect: ['pairs', r.n, 0],
        ci: `95% CI for ρ: ${ciText} (Fisher z with the Bonett–Wright variance)` +
            (r.ties ? '; tied values share their average rank' : ''),
        assumptions: {
          warns,
          footer: `p from t(${r.df}) = ${Number.isFinite(r.t) ? r.t.toFixed(3) : '∞'}; n = ${r.n} pairs`
        },
        summary:
          `Spearman's rank correlation assessed the monotonic relationship between ${n1Name} and ${n2Name} ` +
          `(n = ${r.n}). The correlation was ${verdict(r.p)}, ` +
          `rs(${r.df}) = ${r.rho.toFixed(3)}, ${pEq(r.p)}${ciApa} (${interpretR(r.rho)}).`,
        ...parts
      };
    }
    return {
      method: `Pearson correlation, ${n1Name} and ${n2Name}`,
      stat: ["Pearson's r", r.r], p: r.p, effect: ['r²', r.r2],
      ci: `95% CI for r: ${ciText}; r² = ${r.r2.toFixed(3)} (${(100 * r.r2).toFixed(1)}% shared variance)`,
      assumptions: {
        warns,
        footer: `Normality: ${n1Name} ${pEq(normX.p)}, ${n2Name} ${pEq(normY.p)}; n = ${r.n} pairs`
      },
      summary:
        `A Pearson product–moment correlation assessed the relationship between ` +
        `${n1Name} and ${n2Name} (n = ${r.n}). The correlation was ${verdict(r.p)}, ` +
        `r(${r.df}) = ${r.r.toFixed(3)}, ${pEq(r.p)}${ciApa}; ` +
        `r² = ${r.r2.toFixed(3)} indicates ${(100 * r.r2).toFixed(1)}% shared variance ` +
        `(${interpretR(r.r)}).`,
      ...parts
    };
  }

  function runMannWhitney(sel) {
    const [n1Name, n2Name] = sel.names;
    const r = mannWhitneyU(sel.groups[0], sel.groups[1]);
    if (!r) return showToast('Both groups need at least one value.', 'error');

    return {
      method: `Mann–Whitney U test, ${n1Name} against ${n2Name}`,
      stat: ['U statistic', r.U], p: r.p, effect: ['rank-biserial r', r.rankBiserial],
      ci: `z = ${fx(r.z, 3)} (normal approximation${r.tieCorrected ? ', tie-corrected' : ''}); ` +
          `medians: ${n1Name} ${r.median1.toFixed(2)}, ${n2Name} ${r.median2.toFixed(2)}`,
      assumptions: {
        warns: [{
          level: 'ok',
          text: 'Non-parametric: no normality assumption. Tests whether one distribution ' +
                'is stochastically shifted relative to the other.'
        }],
        footer: `n₁ = ${r.n1}, n₂ = ${r.n2}. Normal approximation used; for very small n consult exact U tables.`
      },
      summary:
        `A Mann–Whitney U test compared ${n1Name} (Mdn = ${r.median1.toFixed(2)}, n = ${r.n1}) ` +
        `and ${n2Name} (Mdn = ${r.median2.toFixed(2)}, n = ${r.n2}). The difference was ${verdict(r.p)}, ` +
        `U = ${r.U.toFixed(1)}, z = ${fx(r.z, 3)}, ${pEq(r.p)}, ` +
        `rank-biserial r = ${r.rankBiserial.toFixed(2)}.`,
      plot: groupPlot(sel),
      desc: { rows: descRows(sel) },
      pairwise: null
    };
  }

  function runWilcoxon(sel) {
    const [n1Name, n2Name] = sel.names;
    const r = wilcoxonSignedRank(sel.groups[0], sel.groups[1]);
    if (!r) return showToast('No non-zero differences to test.', 'error');

    return {
      method: `Wilcoxon signed-rank test, ${n1Name} against ${n2Name}`,
      stat: ['W statistic', r.W], p: r.p, effect: ['effect r (z/√n)', r.effectR],
      ci: `z = ${fx(r.z, 3)} (normal approximation); n = ${r.n} non-zero differences`,
      assumptions: {
        warns: [{
          level: 'ok',
          text: 'Non-parametric paired test: assumes a symmetric distribution of ' +
                'differences, not normality.'
        }],
        footer: `${r.nDropped} zero difference(s) dropped; normal approximation used (recommended for n ≳ 20).`
      },
      summary:
        `A Wilcoxon signed-rank test compared ${n1Name} and ${n2Name} ` +
        `(n = ${r.n} non-zero differences). The difference was ${verdict(r.p)}, ` +
        `W = ${r.W.toFixed(1)}, z = ${fx(r.z, 3)}, ${pEq(r.p)}, ` +
        `effect r = ${fx(r.effectR, 2)}.`,
      ...pairedParts(sel)
    };
  }

  /** One sentence naming the pairs that differ after correction. */
  function posthocSentence(names, ph, what) {
    if (!ph) return '';
    const label = (c) => `${names[c.i]} and ${names[c.j]}`;
    const sig = ph.comparisons.filter(c => c.pAdjusted < 0.05);
    const ns = ph.comparisons.filter(c => !(c.pAdjusted < 0.05));
    if (!sig.length) return ` ${what} found no pair that differed after correction.`;
    let s = ` ${what} showed differences between ${sig.map(c => `${label(c)} (${pEq(c.pAdjusted)})`).join(', ')}`;
    if (ns.length) s += `; ${ns.map(c => `${label(c)} (${pEq(c.pAdjusted)})`).join(', ')} did not differ`;
    return s + '.';
  }

  /** Table model for Tukey, Games–Howell or Dunn results. */
  function pairwiseView(names, ph, omnibusP) {
    if (!ph) return null;
    const d = decimalsFor(names.map(n => parsedData[n]).flat());
    const cmp = (c) => `${names[c.i]} - ${names[c.j]}`;
    const warn = omnibusP >= 0.05
      ? 'The overall test was not significant, so these comparisons are shown for completeness and are not evidence of a difference on their own.'
      : null;

    if (ph.method === "Dunn's test") {
      return {
        title: "Dunn's test, Holm-adjusted",
        warn,
        head: ['Comparison', 'Mean-rank difference', 'z', 'p', 'p (Holm)'],
        csvHead: ['Comparison', 'Mean rank difference', 'z', 'p', 'p Holm'],
        rows: ph.comparisons.map(c => [cmp(c), c.meanRankDiff.toFixed(2), fx(c.z, 3), formatP(c.p), formatP(c.pAdjusted)]),
        csv: ph.comparisons.map(c => [cmp(c), num(c.meanRankDiff), num(c.z), num(c.p), num(c.pAdjusted)]),
        sig: ph.comparisons.map(c => c.pAdjusted < 0.05),
        note: 'Mean ranks come from ranking all groups together, with ties averaged and the tie-corrected variance; ' +
              `two-sided normal p-values, adjusted by Holm's method across all ${ph.comparisons.length} pairs. ` +
              'A difference in mean ranks has no confidence interval in the units of the data.'
      };
    }
    const tukey = ph.method === 'Tukey HSD';
    return {
      title: tukey ? 'Tukey HSD' : 'Games–Howell',
      warn,
      head: tukey
        ? ['Comparison', 'Difference', '95% CI', 'q', 'p (adjusted)']
        : ['Comparison', 'Difference', '95% CI', 't', 'df', 'p (adjusted)'],
      csvHead: tukey
        ? ['Comparison', 'Difference', 'CI95 lower', 'CI95 upper', 'q', 'p adjusted']
        : ['Comparison', 'Difference', 'CI95 lower', 'CI95 upper', 't', 'df', 'p adjusted'],
      rows: ph.comparisons.map(c => [
        cmp(c), fx(c.diff, d), `[${fx(c.ci[0], d)}, ${fx(c.ci[1], d)}]`,
        ...(tukey ? [fx(c.q, 3)] : [fx(c.t, 3), fx(c.df, 2)]),
        formatP(c.pAdjusted)
      ]),
      // The studentized-range tail is good to about 1e-9, so smaller
      // p-values are written as a bound rather than a spuriously exact number.
      csv: ph.comparisons.map(c => [
        cmp(c), num(c.diff), num(c.ci[0]), num(c.ci[1]),
        ...(tukey ? [num(c.q)] : [num(c.t), num(c.df)]), c.pAdjusted < 1e-9 ? '<1e-9' : num(c.pAdjusted)
      ]),
      sig: ph.comparisons.map(c => c.pAdjusted < 0.05),
      note: tukey
        ? "Difference is the first group's mean minus the second's. Tukey–Kramer standard errors from the ANOVA's pooled mean square; " +
          `the intervals and p-values are simultaneous for all ${ph.comparisons.length} comparisons, so no further correction is needed.`
        : "Difference is the first group's mean minus the second's. Each pair keeps its own standard error and Welch degrees of freedom; " +
          `the intervals and p-values are simultaneous for all ${ph.comparisons.length} comparisons.`
    };
  }

  // --- 6. Output rendering ---

  function renderView(view) {
    lastView = view;
    resultMethod.textContent = view.method;
    renderStats(view.stat, view.p, view.effect);

    ciBox.innerHTML = `<i class="fa-solid fa-arrows-left-right-to-line" aria-hidden="true"></i> <span>${escapeHtml(minus(view.ci))}</span>`;
    ciBox.hidden = false;

    renderAssumptions(view.assumptions.warns, view.assumptions.footer);
    pubSummary.value = view.summary;
    // Grow the box to the summary, which runs longer once post-hoc results
    // are in it; it can still be resized by hand.
    pubSummary.style.height = 'auto';
    pubSummary.style.height = `${pubSummary.scrollHeight + 2}px`;

    renderDescriptives(view.desc);
    renderPairwise(view.pairwise);
    renderPlot();
  }

  function renderStats([statName, statVal], pVal, [effName, effVal, effDigits = 3]) {
    statLabel.textContent = statName;
    statValue.textContent = Number.isFinite(statVal) ? minus(String(+statVal.toFixed(4))) : 'n/a';

    pValueEl.textContent = Number.isFinite(pVal) ? formatP(pVal) : 'n/a';
    pValueEl.className = Number.isFinite(pVal) && pVal < 0.05 ? 'res-trio-value is-sig' : 'res-trio-value';

    effectLabel.innerHTML = effName;
    effectValue.textContent = Number.isFinite(effVal) ? minus(String(+effVal.toFixed(effDigits))) : 'n/a';
  }

  function renderAssumptions(warns, footer) {
    const rows = warns.map(w => {
      const icon = w.level === 'warn'
        ? '<i class="fa-solid fa-triangle-exclamation ico-warn" aria-hidden="true"></i><span class="sr-only">Warning: </span>'
        : '<i class="fa-solid fa-circle-check ico-ok" aria-hidden="true"></i>';
      return `<div class="assume-row">${icon}<span>${escapeHtml(minus(w.text))}</span></div>`;
    }).join('');

    assumptionsBox.innerHTML =
      `<div class="assume-title"><i class="fa-solid fa-clipboard-check" aria-hidden="true"></i> Assumption checks</div>
       <div class="assume-rows">${rows || '<span class="assume-none">No assumption warnings.</span>'}</div>
       ${footer ? `<div class="assume-foot">${escapeHtml(minus(footer))}</div>` : ''}`;
    assumptionsBox.hidden = false;
  }

  // Number formatting for tables: one decimal more than the data carry, the
  // usual reporting rule for means and SDs, between 1 and 6.
  function decimalsOf(x) {
    const [m, e] = String(x).split('e');
    const d = (m.split('.')[1] || '').length - (e ? Number(e) : 0);
    return Math.max(0, d);
  }
  function decimalsFor(values) {
    let d = 0;
    for (const v of values) d = Math.max(d, decimalsOf(v));
    return Math.min(6, Math.max(1, d + 1));
  }

  const tables = { desc: null, pairs: null };

  function renderDescriptives(desc) {
    // Groups of one measurement share their decimals; two different
    // variables (a correlation) each keep their own.
    const pooled = decimalsFor(desc.rows.map(r => r.values).flat());
    const head = ['Group', 'n', 'Mean', 'SD', 'SEM', '95% CI', 'Median', 'IQR', 'Min', 'Max'];
    const csvHead = ['Group', 'n', 'Mean', 'SD', 'SEM', 'CI95 lower', 'CI95 upper', 'Median', 'Q1', 'Q3', 'IQR', 'Min', 'Max'];
    const rows = [];
    const csv = [];
    for (const r of desc.rows) {
      const s = descriptives(r.values);
      const d = desc.perRow ? decimalsFor(r.values) : pooled;
      rows.push([r.name, String(s.n), fx(s.mean, d), fx(s.sd, d), fx(s.sem, d),
        Number.isFinite(s.ci[0]) ? `[${fx(s.ci[0], d)}, ${fx(s.ci[1], d)}]` : 'n/a',
        fx(s.median, d), fx(s.iqr, d), fx(s.min, d), fx(s.max, d)]);
      csv.push([r.name, String(s.n), num(s.mean), num(s.sd), num(s.sem), num(s.ci[0]), num(s.ci[1]),
        num(s.median), num(s.q1), num(s.q3), num(s.iqr), num(s.min), num(s.max)]);
    }
    tables.desc = { head, rows, csv: [csvHead, ...csv], caption: 'Descriptive statistics by group', label: 'tab:descriptives' };
    descTable.innerHTML = tableHtml('Descriptive statistics by group', head, rows);
    descNote.textContent = minus('SD uses n − 1. The 95% CI is the t interval for the mean. ' +
      "Quartiles interpolate linearly between observations (NumPy's default, R type 7); IQR = Q3 − Q1. " +
      (desc.note || '')).trim();
  }

  function renderPairwise(pw) {
    if (!pw) {
      pairwiseSection.hidden = true;
      tables.pairs = null;
      return;
    }
    $('pair-h').textContent = `Pairwise comparisons: ${pw.title}`;
    pairwiseWarn.hidden = !pw.warn;
    if (pw.warn) pairwiseWarn.querySelector('span').textContent = pw.warn;
    tables.pairs = {
      head: pw.head, rows: pw.rows, csv: [pw.csvHead, ...pw.csv],
      caption: `Pairwise comparisons (${pw.title})`, label: 'tab:pairwise'
    };
    pairTable.innerHTML = tableHtml(`Pairwise comparisons, ${pw.title}`, pw.head, pw.rows, pw.sig);
    pairNote.textContent = minus(pw.note);
    pairwiseSection.hidden = false;
  }

  function tableHtml(caption, head, rows, sig) {
    const last = head.length - 1;
    const th = head.map((h, i) => `<th scope="col"${i ? ' class="num"' : ''}>${escapeHtml(h)}</th>`).join('');
    const body = rows.map((r, ri) => {
      const cells = r.map((c, i) => {
        if (i === 0) return `<th scope="row">${escapeHtml(c.replace(' - ', ' − '))}</th>`;
        const hit = sig && sig[ri] && i === last;
        return `<td class="num${hit ? ' is-sig' : ''}">${escapeHtml(minus(c))}${hit ? '<span class="sr-only"> (significant)</span>' : ''}</td>`;
      }).join('');
      return `<tr>${cells}</tr>`;
    }).join('');
    return `<caption class="sr-only">${escapeHtml(caption)}</caption><thead><tr>${th}</tr></thead><tbody>${body}</tbody>`;
  }

  function tableText(t, format) {
    if (format === 'csv') return toCSV(t.csv);
    const matrix = [t.head, ...t.rows];
    if (format === 'md') {
      // Right-align the numbers; the first column holds names.
      const lines = generateMarkdownTable(matrix, { align: 'r' }).split('\n');
      lines[1] = lines[1].replace('---:', ':---');
      return lines.join('\n');
    }
    // booktabs, names left-aligned and numbers right-aligned. In text mode
    // "<" prints as an inverted exclamation mark and "-" as a hyphen, so both
    // go into math mode.
    return generateLatexTable(matrix, { style: 'booktabs', align: 'r', caption: t.caption, label: t.label })
      .replace('{@{}r', '{@{}l')
      .replace(/ - /g, () => ' $-$ ')
      .replace(/< \.001/g, () => '$<$ .001')
      .replace(/(^|[\s[&])-(?=\d|\.\d)/gm, (m, pre) => `${pre}$-$`);
  }

  document.querySelectorAll('[data-copy-table]').forEach(btn => {
    btn.addEventListener('click', () => {
      const t = tables[btn.getAttribute('data-copy-table')];
      if (!t) return;
      const format = btn.getAttribute('data-format');
      const name = { csv: 'CSV', md: 'Markdown', latex: 'LaTeX' }[format];
      copyText(tableText(t, format), `Table copied as ${name}.`);
    });
  });

  function copyText(text, done) {
    if (!navigator.clipboard) return showToast('Clipboard access is not available here.', 'error');
    navigator.clipboard.writeText(text).then(
      () => showToast(done, 'info'),
      () => showToast('Clipboard access denied.', 'error')
    );
  }

  // --- 7. Plot ---
  //
  // The shared plot area (js/figure-plot.js): the figure for the test comes
  // from src/core/statistics-figure.js, drawn as matplotlib will draw it, with
  // the Style panel, PDF, PNG and SVG, and the Python script that runs the
  // same test and draws the same plot.

  const STYLE_KEY = 'stemkit.stats-calculator.figure';
  let plot = null;
  let lastRun = null;

  const lineEquation = (l) =>
    minus(`y = ${Number(l.slope.toPrecision(4))}x ${l.intercept < 0 ? '−' : '+'} ${Number(Math.abs(l.intercept).toPrecision(4))}`);

  function plotText(m) {
    if (m.kind === 'scatter') {
      const eq = m.line && Number.isFinite(m.line.slope) ? lineEquation(m.line) : null;
      return {
        caption: `${m.yLabel} against ${m.xLabel}, n = ${m.x.length} pairs` +
          (eq ? `, with the least-squares line ${eq} across the data.` : '.') +
          (m.spearman ? " The line is for reference: Spearman's ρ measures a monotonic trend, which need not be straight." : '')
      };
    }
    return {
      caption: 'Boxes show the median and quartiles, and whiskers reach the furthest values within 1.5 × IQR. ' +
        `Dots are the ${m.kind === 'paired' ? 'observations, joined by pair' : 'observations'}; ` +
        'the diamond and bar beside each box are the mean and its 95% CI.' +
        (m.ref ? ` The dashed line marks ${m.ref.label}.` : '')
    };
  }

  /** The figure for the last run, named for the test. */
  function figureFor(view) {
    const fig = statisticsFigure(view.plot);
    if (fig && lastRun) fig.export.filename = `stemkit-${lastRun.test.replace(/_/g, '-')}`;
    return fig;
  }

  function renderPlot() {
    if (!lastView || !resultsShown()) { if (plot) plot.update(null); return; }
    plotCaption.textContent = plotText(lastView.plot).caption;
    if (plot) plot.update(figureFor(lastView));
  }

  function exported(r, err, format) {
    if (err) {
      showToast(`The ${format.toUpperCase()} could not be made: ${err && err.message ? err.message : err}`, 'error');
      return;
    }
    showToast(`Saved ${r.filename}.`, 'success');
  }

  let storedStyle = {};
  try { storedStyle = JSON.parse(localStorage.getItem(STYLE_KEY) || '{}'); } catch (e) { storedStyle = {}; }
  import('./figure-plot.js').then(({ mountFigure }) => {
    plot = mountFigure($('statsPlot'), {
      style: storedStyle,
      onStyleChange: (style) => { try { localStorage.setItem(STYLE_KEY, JSON.stringify(style)); } catch (e) { /* storage full or blocked */ } },
      label: 'The plot for the test: the groups as box plots with each observation and the mean with its 95% interval, or the two variables as a scatter plot',
      onExport: exported,
      python: $('statsPython') ? {
        host: $('statsPython'),
        title: 'Python script',
        filename: 'statistics.py',
        script: (figure) => (lastView && lastRun
          ? statisticsScript(figure, { test: lastRun.test, model: lastView.plot, mu0: lastRun.mu0 })
          : '')
      } : false
    });
    renderPlot();
  }).catch((err) => {
    const notes = document.querySelector('#statsPlot .fg-notes');
    if (notes) {
      notes.textContent = `The plot could not load (${err && err.message ? err.message : err}). Reload the page to try again; the results still work.`;
      notes.hidden = false;
    }
  });

  // --- 8. Theory (KaTeX) ---
  const FORMULAS = {
    ttest_welch: String.raw`\begin{aligned}
      t &= \frac{\bar{x}_1 - \bar{x}_2}{\sqrt{\dfrac{s_1^2}{n_1} + \dfrac{s_2^2}{n_2}}} \\[10pt]
      \nu &= \frac{\left(\dfrac{s_1^2}{n_1}+\dfrac{s_2^2}{n_2}\right)^2}
                  {\dfrac{(s_1^2/n_1)^2}{n_1-1}+\dfrac{(s_2^2/n_2)^2}{n_2-1}}
    \end{aligned}`,
    ttest_ind: String.raw`\begin{aligned}
      s_p^2 &= \frac{(n_1-1)s_1^2 + (n_2-1)s_2^2}{n_1+n_2-2} \\[8pt]
      t &= \frac{\bar{x}_1 - \bar{x}_2}{s_p \sqrt{\dfrac{1}{n_1} + \dfrac{1}{n_2}}}
    \end{aligned}`,
    ttest_pair: String.raw`\begin{aligned}
      \bar{d} &= \frac{1}{n}\sum_{i=1}^{n} d_i \\[6pt]
      t &= \frac{\bar{d}}{s_d / \sqrt{n}}, \qquad d_z = \frac{\bar{d}}{s_d}
    \end{aligned}`,
    ttest_one: String.raw`\begin{aligned}
      t &= \frac{\bar{x} - \mu_0}{s / \sqrt{n}}, \qquad \nu = n - 1 \\[6pt]
      d &= \frac{\bar{x} - \mu_0}{s}
    \end{aligned}`,
    anova: String.raw`\begin{aligned}
      F &= \frac{MS_{\text{between}}}{MS_{\text{within}}}
         = \frac{SS_B/(k-1)}{SS_W/(N-k)} \\[6pt]
      \eta^2 &= \frac{SS_B}{SS_B+SS_W} \\[6pt]
      q_{ij} &= \frac{|\bar{x}_i - \bar{x}_j|}{\sqrt{\dfrac{MS_W}{2}\left(\dfrac{1}{n_i}+\dfrac{1}{n_j}\right)}}
    \end{aligned}`,
    welch_anova: String.raw`\begin{aligned}
      w_i &= \frac{n_i}{s_i^2}, \quad W = \sum_i w_i, \quad \bar{x}_w = \frac{1}{W}\sum_i w_i \bar{x}_i \\[6pt]
      F &= \frac{\dfrac{1}{k-1}\sum_i w_i(\bar{x}_i - \bar{x}_w)^2}{1 + \dfrac{2(k-2)}{k^2-1}\Lambda},
      \quad \Lambda = \sum_i \frac{(1 - w_i/W)^2}{n_i - 1} \\[6pt]
      \nu_1 &= k - 1, \qquad \nu_2 = \frac{k^2-1}{3\Lambda}
    \end{aligned}`,
    kruskal: String.raw`\begin{aligned}
      H &= \frac{1}{C}\left[\frac{12}{N(N+1)}\sum_{i=1}^{k}\frac{R_i^2}{n_i} - 3(N+1)\right],
      \quad C = 1 - \frac{\sum (t^3 - t)}{N^3 - N} \\[6pt]
      z_{ij} &= \frac{\bar{R}_i - \bar{R}_j}{\sqrt{C\,\dfrac{N(N+1)}{12}\left(\dfrac{1}{n_i}+\dfrac{1}{n_j}\right)}}
    \end{aligned}`,
    pearson: String.raw`\begin{aligned}
      r &= \frac{\sum (x_i-\bar{x})(y_i-\bar{y})}
                {\sqrt{\sum (x_i-\bar{x})^2 \; \sum (y_i-\bar{y})^2}} \\[6pt]
      t &= r\sqrt{\frac{n-2}{1-r^2}}
    \end{aligned}`,
    spearman: String.raw`\begin{aligned}
      \rho &= r\big(\operatorname{rank}(x),\, \operatorname{rank}(y)\big), \qquad t = \rho\sqrt{\frac{n-2}{1-\rho^2}} \\[6pt]
      \text{CI} &= \tanh\!\left(\operatorname{artanh}\rho \pm z_{0.975}\sqrt{\frac{1+\rho^2/2}{n-3}}\right)
    \end{aligned}`,
    mannwhitney: String.raw`\begin{aligned}
      U_1 &= R_1 - \frac{n_1(n_1+1)}{2} \\[6pt]
      z &= \frac{U - \mu_U}{\sigma_U}, \qquad \mu_U = \frac{n_1 n_2}{2}
    \end{aligned}`,
    wilcoxon: String.raw`\begin{aligned}
      W &= \min(W_+,\, W_-) \\[6pt]
      z &= \frac{W - \frac{n(n+1)}{4}}{\sqrt{\dfrac{n(n+1)(2n+1)}{24}}}
    \end{aligned}`,
    wilcoxon_one: String.raw`\begin{aligned}
      d_i &= x_i - \mu_0, \qquad W = \min(W_+,\, W_-) \\[6pt]
      z &= \frac{W - \frac{n(n+1)}{4}}{\sqrt{\dfrac{n(n+1)(2n+1)}{24}}}
    \end{aligned}`
  };

  /**
   * Symbol definitions, per test.
   *
   * A formula is only useful if the reader knows what each symbol stands for,
   * and these differ enough between tests that one shared glossary would be
   * misleading, n is a count of pairs for the paired t-test but a count of
   * observations elsewhere, and W means something different again.
   */
  const DEFINITIONS = {
    ttest_welch: [
      [String.raw`\bar{x}_1,\ \bar{x}_2`, 'mean of each group'],
      [String.raw`s_1^2,\ s_2^2`, 'sample variance of each group (n−1 denominator)'],
      [String.raw`n_1,\ n_2`, 'number of observations in each group'],
      [String.raw`t`, 'difference in means divided by its standard error'],
      [String.raw`\nu`, 'Welch–Satterthwaite degrees of freedom, usually not a whole number, which is why this test tolerates unequal variances']
    ],
    ttest_ind: [
      [String.raw`\bar{x}_1,\ \bar{x}_2`, 'mean of each group'],
      [String.raw`s_1^2,\ s_2^2`, 'sample variance of each group (n−1 denominator)'],
      [String.raw`s_p^2`, 'pooled variance: the two group variances averaged, weighted by degrees of freedom'],
      [String.raw`n_1,\ n_2`, 'number of observations in each group'],
      [String.raw`t`, 'difference in means divided by its standard error, on n₁+n₂−2 degrees of freedom']
    ],
    ttest_pair: [
      [String.raw`d_i`, 'difference within pair i, i.e. first measurement minus second'],
      [String.raw`\bar{d}`, 'mean of those differences'],
      [String.raw`s_d`, 'standard deviation of the differences'],
      [String.raw`n`, 'number of pairs, not the number of measurements'],
      [String.raw`t`, 'mean difference divided by its standard error, on n−1 degrees of freedom'],
      [String.raw`d_z`, 'effect size: the mean difference expressed in standard deviations']
    ],
    ttest_one: [
      [String.raw`\bar{x},\ s`, 'mean and standard deviation (n−1) of the values'],
      [String.raw`\mu_0`, 'the value you compare with, such as a certified or theoretical value'],
      [String.raw`n`, 'number of values'],
      [String.raw`t`, 'distance of the mean from μ₀ in standard errors, on n−1 degrees of freedom'],
      [String.raw`d`, "Cohen's d for one sample: the same distance in standard deviations"]
    ],
    anova: [
      [String.raw`k`, 'number of groups'],
      [String.raw`N`, 'total number of observations across all groups'],
      [String.raw`SS_B`, 'between-group sum of squares: spread of the group means about the overall mean'],
      [String.raw`SS_W`, 'within-group sum of squares: spread of observations about their own group mean'],
      [String.raw`MS`, 'mean square: a sum of squares divided by its degrees of freedom'],
      [String.raw`F`, 'ratio of between-group to within-group variance; near 1 when the groups do not differ'],
      [String.raw`\eta^2`, 'eta squared: the share of total variation attributable to group membership'],
      [String.raw`q_{ij}`, "Tukey's statistic for groups i and j, referred to the studentized range for k means on N−k degrees of freedom"]
    ],
    welch_anova: [
      [String.raw`w_i`, 'weight of group i: its size over its variance, so precise groups count for more'],
      [String.raw`\bar{x}_w`, 'the weighted grand mean'],
      [String.raw`\Lambda`, 'a correction that grows as the groups become unbalanced'],
      [String.raw`F`, 'weighted between-group variation, on k−1 and ν₂ degrees of freedom'],
      [String.raw`\nu_2`, "Welch's denominator degrees of freedom, usually not a whole number"]
    ],
    kruskal: [
      [String.raw`N,\ k`, 'total number of observations, and number of groups'],
      [String.raw`R_i`, 'sum of the ranks in group i, ranking all groups together'],
      [String.raw`C`, 'tie correction; t is the size of each run of tied values'],
      [String.raw`H`, 'referred to chi-squared on k−1 degrees of freedom'],
      [String.raw`\bar{R}_i`, "mean rank of group i, used by Dunn's pairwise z"],
      [String.raw`z_{ij}`, "Dunn's statistic for groups i and j; the p-values are then Holm-adjusted"]
    ],
    pearson: [
      [String.raw`x_i,\ y_i`, 'the two measurements on observation i'],
      [String.raw`\bar{x},\ \bar{y}`, 'mean of each variable'],
      [String.raw`n`, 'number of complete pairs; rows missing either value are dropped'],
      [String.raw`r`, 'correlation coefficient, between −1 and +1; measures straight-line association only'],
      [String.raw`t`, 'statistic for testing r ≠ 0, on n−2 degrees of freedom']
    ],
    spearman: [
      [String.raw`\operatorname{rank}`, 'position of each value within its own variable; ties share their average rank'],
      [String.raw`\rho`, "Pearson's r computed on the ranks: +1 for any perfectly increasing relationship, straight or curved"],
      [String.raw`t`, 'statistic for testing ρ ≠ 0, on n−2 degrees of freedom'],
      [String.raw`\text{CI}`, 'Fisher z interval with the Bonett–Wright variance, which suits ρ better than 1/(n−3)']
    ],
    mannwhitney: [
      [String.raw`n_1,\ n_2`, 'number of observations in each group'],
      [String.raw`R_1`, 'sum of the ranks held by group 1 once both groups are ranked together'],
      [String.raw`U_1`, 'rank-sum statistic for group 1; U₂ is defined the same way'],
      [String.raw`U`, 'the smaller of U₁ and U₂'],
      [String.raw`\mu_U,\ \sigma_U`, 'mean and standard deviation of U when the groups do not differ'],
      [String.raw`z`, 'normal approximation to U, used once both groups are reasonably large']
    ],
    wilcoxon: [
      [String.raw`W_+,\ W_-`, 'sum of the ranks of the positive and of the negative differences'],
      [String.raw`W`, 'the smaller of the two rank sums'],
      [String.raw`n`, 'number of pairs with a non-zero difference; ties at zero are discarded'],
      [String.raw`z`, 'normal approximation to W, used once n is reasonably large']
    ],
    wilcoxon_one: [
      [String.raw`d_i`, 'each value minus μ₀; values equal to μ₀ are discarded'],
      [String.raw`W_+,\ W_-`, 'sum of the ranks of |d| for the values above and below μ₀'],
      [String.raw`n`, 'number of values that differ from μ₀'],
      [String.raw`z`, 'normal approximation to W, used once n is reasonably large']
    ]
  };

  function renderTheory(type) {
    if (!theoryContainer) return;
    const formula = FORMULAS[type];
    if (!formula) { theoryContainer.innerHTML = ''; return; }

    if (!window.katex) {
      theoryContainer.innerHTML =
        '<span class="text-slate-500 dark:text-slate-400 text-sm">Formula renderer unavailable.</span>';
      return;
    }

    try {
      theoryContainer.innerHTML = katex.renderToString(formula, {
        displayMode: true, throwOnError: false, output: 'html'
      });
      renderDefinitions(type);
    } catch {
      theoryContainer.innerHTML =
        '<span class="text-slate-500 dark:text-slate-400 text-sm">Formula renderer unavailable.</span>';
    }
  }

  /** Append the "where" glossary beneath the rendered formula. */
  function renderDefinitions(type) {
    const defs = DEFINITIONS[type];
    if (!defs || !defs.length) return;

    const kx = (tex) => {
      try {
        return katex.renderToString(tex, { throwOnError: false, output: 'html' });
      } catch {
        return tex;
      }
    };

    const items = defs
      .map(([sym, meaning]) => `<div class="mf-def"><dt>${kx(sym)}</dt><dd>${meaning}</dd></div>`)
      .join('');

    theoryContainer.insertAdjacentHTML('beforeend',
      `<div class="mf-defs"><div class="mf-defs-title">Where:</div><dl>${items}</dl></div>`);
  }

  // --- 9. Copy and docs tabs ---
  copyBtn.addEventListener('click', () => {
    pubSummary.select();
    copyText(pubSummary.value, 'Summary copied to clipboard.');
  });

  // The method tabs follow the ARIA tabs pattern: the selected tab carries
  // aria-selected (which is also what the stylesheet highlights, so the two
  // cannot disagree), only it is in the tab order, and the arrow keys, Home
  // and End move between tabs.
  const docTabs = Array.from(document.querySelectorAll('.doc-tab'));
  function selectDocTab(tab, focus) {
    const key = tab.getAttribute('data-doc-tab');
    docTabs.forEach(x => {
      const on = x === tab;
      x.classList.toggle('active', on);
      x.setAttribute('aria-selected', on ? 'true' : 'false');
      x.tabIndex = on ? 0 : -1;
    });
    document.querySelectorAll('.doc-pane').forEach(pane =>
      pane.classList.toggle('active', pane.getAttribute('data-doc-pane') === key));
    if (focus) tab.focus();
  }
  docTabs.forEach((tab, i) => {
    tab.addEventListener('click', () => selectDocTab(tab, false));
    tab.addEventListener('keydown', (e) => {
      const last = docTabs.length - 1;
      const to = { ArrowRight: i === last ? 0 : i + 1, ArrowLeft: i === 0 ? last : i - 1, Home: 0, End: last }[e.key];
      if (to === undefined) return;
      e.preventDefault();
      selectDocTab(docTabs[to], true);
    });
  });

  function showToast(msg, type) {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    const colors = type === 'success'
      ? 'bg-emerald-50 text-emerald-800 border-emerald-200 dark:bg-emerald-900/40 dark:text-emerald-200'
      : type === 'error'
        ? 'bg-red-50 text-red-800 border-red-200 dark:bg-red-900/40 dark:text-red-200'
        : 'bg-blue-50 text-blue-800 border-blue-200 dark:bg-blue-900/40 dark:text-blue-200';
    toast.className =
      `px-4 py-3 rounded-xl border shadow-lg toast-enter text-sm font-medium transition-all ${colors}`;
    toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
    toast.innerText = msg;
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }


  /* --- Tutorial samples ---
   * Preloaded datasets that set up a complete, runnable analysis, so a
   * user can check the tool against a known answer before trusting it
   * with their own data.
   */
  const SAMPLES = {
      welch: {
          label: "Two groups (t-test)",
          format: "wide", test: "ttest_welch", v1: "Control", v2: "Treatment",
          csv: `Control,Treatment
23.1,28.4
22.8,29.1
24.2,27.9
23.5,30.2
22.9,28.8
23.8,29.5
24.1,28.1
23.3,30.7
22.6,29.3
23.9,28.6`
      },
      anova: {
          label: "Three groups (ANOVA)",
          format: "wide", test: "anova", groups: ["Placebo", "LowDose", "HighDose"],
          csv: `Placebo,LowDose,HighDose
5.2,6.8,9.1
4.9,7.1,8.7
5.5,6.5,9.4
5.1,7.3,8.9
4.8,6.9,9.2
5.3,7.0,8.6
5.0,6.7,9.5
5.4,7.2,8.8`
      },
      paired: {
          label: "Before / after (paired t)",
          format: "wide", test: "ttest_pair", v1: "Before", v2: "After",
          csv: `Before,After
120,112
135,128
128,119
142,133
118,115
150,139
133,124
127,121
145,138
122,116`
      },
      pearson: {
          label: "Correlation (Pearson)",
          format: "wide", test: "pearson", v1: "Height_cm", v2: "Weight_kg",
          csv: `Height_cm,Weight_kg
158,52
162,55
168,61
171,64
175,68
180,74
165,58
177,71
183,79
160,54`
      },
      spearman: {
          label: "Rate against temperature (Spearman)",
          format: "wide", test: "spearman", v1: "Temperature_C", v2: "Rate_per_min",
          csv: `Temperature_C,Rate_per_min
20,0.52
25,0.81
30,0.77
35,1.95
40,2.96
45,4.81
50,7.30
55,11.9
60,17.8
65,29.4
70,44.1
75,71.5`
      },
      onesample: {
          label: "Against a certified value (one-sample t)",
          format: "wide", test: "ttest_one", v1: "Concentration_M", mu0: 0.1,
          csv: `Concentration_M
0.1012
0.1008
0.1015
0.1003
0.1011
0.1009
0.1017
0.1006
0.1013
0.1010`
      },
      welchanova: {
          label: "Unequal spreads (Welch's ANOVA)",
          format: "wide", test: "welch_anova", groups: ["Supplier_A", "Supplier_B", "Supplier_C"],
          csv: `Supplier_A,Supplier_B,Supplier_C
10.2,12.5,11.0
11.1,14.9,11.4
9.8,9.7,10.8
10.5,16.2,11.9
10.9,11.8,11.2
10.1,13.4,10.7
10.4,15.1,
,10.6,
,12.9,`
      },
      kruskal: {
          label: "Skewed groups (Kruskal-Wallis)",
          format: "wide", test: "kruskal", groups: ["Site_A", "Site_B", "Site_C"],
          csv: `Site_A,Site_B,Site_C
12,21,33
15,24,29
11,19,38
20,22,31
13,75,99
12,20,34
48,23,30
14,26,36
16,19,32
12,21,124`
      },
      longtidy: {
          label: "Long / tidy format",
          format: "long", test: "anova", valueCol: "score", groupCol: "method", groups: ["A", "B", "C"],
          csv: `score,method
78,A
82,A
75,A
80,A
85,B
88,B
83,B
90,B
92,C
95,C
89,C
97,C`
      },
      nonparam: {
          label: "Outliers → non-parametric",
          format: "wide", test: "mannwhitney", v1: "GroupX", v2: "GroupY",
          csv: `GroupX,GroupY
1.1,2.0
1.2,2.1
1.0,1.9
1.3,2.2
1.1,2.0
1.2,15.5
1.0,1.8
14.8,2.1
1.1,2.0
1.2,18.2`
      }
  };

  // The chip of the example in the box stays pressed until the data is
  // edited, so it is clear what is loaded.
  function markSample(key) {
      document.querySelectorAll('.tut-chip[data-sample]').forEach(c =>
          c.setAttribute('aria-pressed', c.getAttribute('data-sample') === key ? 'true' : 'false'));
  }

  function loadSample(key) {
      const s = SAMPLES[key];
      if (!s) return;
      markSample(key);
      // 1) fill data + format, then parse (synchronous for string input)
      if (formatSelect) formatSelect.value = s.format;
      dataInput.value = s.csv;
      parseData({ quiet: true });

      // 2) for long format, choose the value/group columns then re-pivot
      if (s.format === 'long') {
          if (s.valueCol) valueColSelect.value = s.valueCol;
          if (s.groupCol) groupColSelect.value = s.groupCol;
          buildLongGroups();
      }

      // 3) select the test and its variables/groups
      testType.value = s.test;
      syncSelectorVisibility();
      renderTheory(s.test);
      if (TESTS[s.test].inputs === 'k') {
          const wanted = s.groups || variables;
          Array.from(groupSelect.options).forEach(o => { o.selected = wanted.includes(o.value); });
      } else {
          if (s.v1 && [...var1.options].some(o => o.value === s.v1)) var1.value = s.v1;
          if (s.v2 && [...var2.options].some(o => o.value === s.v2)) var2.value = s.v2;
      }
      if (s.mu0 !== undefined) mu0.value = String(s.mu0);

      // 4) set up complete, the user reviews and runs it themselves.
      //    Hide any prior result so a stale one isn't shown before they run,
      //    then guide their eye to the primed Run button.
      resultsContainer.classList.add('hidden');
      staleNote.hidden = true;
      settingsChanged();
      runTestBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
      pulseRun();
      showToast(`Loaded "${s.label}", press Run analysis to see the result.`, "info");
  }

  // Wire up tutorial banner (buttons carry data-sample) + dismissal.

  function initTutorialBanner() {
      document.querySelectorAll('[data-sample]').forEach(btn => {
          btn.addEventListener('click', () => loadSample(btn.getAttribute('data-sample')));
      });
      const banner = document.getElementById('tutorialBanner');
      const dismiss = document.getElementById('tutorialDismiss');
      const reopen = document.getElementById('tutorialReopen');
      if (dismiss && banner) dismiss.addEventListener('click', () => {
          banner.style.display = 'none';
          if (reopen) reopen.style.display = 'inline-flex';
          try { localStorage.statsTutorialDismissed = '1'; } catch (e) {}
      });
      if (reopen && banner) reopen.addEventListener('click', () => {
          banner.style.display = '';
          reopen.style.display = 'none';
          try { localStorage.removeItem('statsTutorialDismissed'); } catch (e) {}
      });
      // respect prior dismissal
      try {
          if (localStorage.statsTutorialDismissed === '1' && banner) {
              banner.style.display = 'none';
              if (reopen) reopen.style.display = 'inline-flex';
          }
      } catch (e) {}
  }

  initTutorialBanner();

  syncSelectorVisibility();
  renderTheory(testType.value);
});
