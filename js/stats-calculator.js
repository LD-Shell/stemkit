/**
 * Statistical Calculator | UI layer.
 *
 * Every statistic, assumption check, and distribution tail lives in
 * @stemkit/core; this file handles DOM wiring, KaTeX rendering, and the
 * publication-ready summary text.
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
  oneWayAnova,
  pearsonCorrelation,
  mannWhitneyU,
  wilcoxonSignedRank,
  dagostinoNormality,
  leveneTest,
  classifyFields,
  pivotLongToGroups,
  describe as summarise,
  formatP,
  interpretD,
  interpretEta,
  interpretR
} from '../src/core/statistics.js';

// jStat, Papa, and KaTeX are loaded as UMD globals by the page's <script> tags.
registerFromGlobals();

document.addEventListener('DOMContentLoaded', () => {

  // --- 1. State ---
  let parsedData = {};
  let variables = [];
  let rawRows = [];
  let rawFields = [];
  let numericFields = [];
  let categoricalFields = [];
  let activeFormat = 'wide';

  // --- 2. Bindings ---
  const dataInput = document.getElementById('dataInput');
  const fileInput = document.getElementById('fileInput');
  const parseBtn = document.getElementById('parseBtn');
  const dataMeta = document.getElementById('dataMeta');

  const formatSelect = document.getElementById('formatSelect');
  const longControls = document.getElementById('longControls');
  const valueColSelect = document.getElementById('valueColSelect');
  const groupColSelect = document.getElementById('groupColSelect');

  const testType = document.getElementById('testType');
  const var1 = document.getElementById('var1');
  const var2 = document.getElementById('var2');
  const groupSelect = document.getElementById('groupSelect');
  const twoVarRow = document.getElementById('twoVarRow');
  const groupRow = document.getElementById('groupRow');
  const runTestBtn = document.getElementById('runTestBtn');

  const resultsContainer = document.getElementById('resultsContainer');
  const statLabel = document.getElementById('statLabel');
  const statValue = document.getElementById('statValue');
  const pValueEl = document.getElementById('pValue');
  const effectLabel = document.getElementById('effectLabel');
  const effectValue = document.getElementById('effectValue');
  const ciBox = document.getElementById('ciBox');
  const assumptionsBox = document.getElementById('assumptionsBox');
  const pubSummary = document.getElementById('pubSummary');
  const copyBtn = document.getElementById('copyBtn');
  const theoryContainer = document.getElementById('theoryContainer');

  // --- 3. Parsing ---
  if (fileInput) fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => { dataInput.value = ev.target.result; parseData(); };
    reader.readAsText(file);
  });

  if (parseBtn) parseBtn.addEventListener('click', parseData);

  function parseData() {
    const rawText = dataInput.value.trim();
    if (!rawText) return showToast('Please input some data first.', 'error');

    Papa.parse(rawText, {
      header: true,
      dynamicTyping: true,
      skipEmptyLines: true,
      delimitersToGuess: ['\t', ',', ';', '|', ' '],
      complete: (results) => {
        if (results.errors.length > 0 && results.data.length === 0) {
          showToast('Error parsing data. Ensure the first row is a header.', 'error');
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

        showToast(
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
      `${rawRows.length} rows • ${variables.length} numeric ` +
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
      `${rawRows.length} rows • ${variables.length} ` +
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
    var1.innerHTML = '';
    var2.innerHTML = '';
    groupSelect.innerHTML = '';

    for (const v of variables) {
      var1.add(new Option(v, v));
      var2.add(new Option(v, v));
      const opt = new Option(`${v} (n=${parsedData[v].length})`, v);
      opt.selected = true;
      groupSelect.add(opt);
    }

    if (variables.length > 1) var2.selectedIndex = 1;
    var1.disabled = false;
    var2.disabled = false;
    groupSelect.disabled = false;
    runTestBtn.disabled = false;
  }

  function syncSelectorVisibility() {
    const isAnova = testType.value === 'anova';
    twoVarRow.style.display = isAnova ? 'none' : '';
    groupRow.style.display = isAnova ? '' : 'none';
  }
  // Render the theory as soon as a test is chosen, not only after running it , 
  // the formula and its symbol definitions are most useful while deciding
  // whether this is the right test.
  if (testType) testType.addEventListener('change', () => {
    syncSelectorVisibility();
    renderTheory(testType.value);
  });

  if (formatSelect) formatSelect.addEventListener('change', () => {
    if (rawRows.length) parseData();
  });
  if (valueColSelect) valueColSelect.addEventListener('change', () => {
    if (activeFormat === 'long') buildLongGroups();
  });
  if (groupColSelect) groupColSelect.addEventListener('change', () => {
    if (activeFormat === 'long') buildLongGroups();
  });

  // --- 4. Test runner (delegated to the core) ---
  if (runTestBtn) runTestBtn.addEventListener('click', executeTest);

  function executeTest() {
    const type = testType.value;
    renderTheory(type);

    try {
      if (type === 'anova') {
        const chosen = Array.from(groupSelect.selectedOptions).map(o => o.value);
        if (chosen.length < 2) {
          return showToast('Select at least two groups for ANOVA.', 'error');
        }
        const groups = chosen.map(v => parsedData[v]);
        if (groups.some(g => !g || g.length < 2)) {
          return showToast('Each group needs at least 2 numeric values.', 'error');
        }
        resultsContainer.classList.remove('hidden');
        return runANOVA(chosen, groups);
      }

      const n1 = var1.value;
      const n2 = var2.value;
      const a1 = parsedData[n1];
      const a2 = parsedData[n2];

      if (!a1 || !a1.length || !a2 || !a2.length) {
        return showToast('Selected variables contain no valid numeric data.', 'error');
      }
      resultsContainer.classList.remove('hidden');

      switch (type) {
        case 'ttest_welch': return runIndependentT(n1, n2, a1, a2, false);
        case 'ttest_ind': return runIndependentT(n1, n2, a1, a2, true);
        case 'ttest_pair': return runPairedT(n1, n2, a1, a2);
        case 'pearson': return runPearson(n1, n2, a1, a2);
        case 'mannwhitney': return runMannWhitney(n1, n2, a1, a2);
        case 'wilcoxon': return runWilcoxon(n1, n2, a1, a2);
        default: return showToast('Unknown test.', 'error');
      }
    } catch (err) {
      console.error(err);
      showToast('A mathematical error occurred. Check data for variance or length issues.', 'error');
    }
  }

  function runIndependentT(n1Name, n2Name, arr1, arr2, pooled) {
    const r = independentTTest(arr1, arr2, { pooled });
    if (!r) return showToast('Each group needs at least 2 values.', 'error');

    renderResults('t', r.t, r.p, "Cohen's d", r.d);
    renderCI(
      `95% CI for mean difference: [${r.ci[0].toFixed(3)}, ${r.ci[1].toFixed(3)}] ` +
      `(Hedges' g = ${r.g.toFixed(3)})`
    );

    const norm1 = dagostinoNormality(arr1);
    const norm2 = dagostinoNormality(arr2);
    const lev = leveneTest([arr1, arr2]);
    const warns = [];

    if (norm1.ok === false || norm2.ok === false) {
      const names = [norm1.ok === false ? n1Name : null, norm2.ok === false ? n2Name : null]
        .filter(Boolean).join(' & ');
      warns.push({
        level: 'warn',
        text: `Normality (D'Agostino K²) is questionable for ${names}. ` +
              `Consider the Mann–Whitney U test.`
      });
    }
    if (lev.ok === false && pooled) {
      warns.push({
        level: 'warn',
        text: `Levene's test is significant (W=${lev.W.toFixed(2)}, p=${formatP(lev.p)}): ` +
              `variances differ. Prefer Welch's t-test over the pooled version.`
      });
    }
    if (lev.ok !== false && !pooled) {
      warns.push({
        level: 'ok',
        text: `Levene's test not significant (p=${formatP(lev.p)}): the equal-variance ` +
              `assumption is tenable, so Student's pooled t would also be valid.`
      });
    }

    renderAssumptions(warns,
      `Levene W(${lev.df1}, ${lev.df2}) = ${lev.W.toFixed(3)}, p = ${formatP(lev.p)} · ` +
      `Normality p: ${n1Name}=${formatP(norm1.p)}, ${n2Name}=${formatP(norm2.p)}`);

    pubSummary.value =
      `${cap(r.method)} compared ${n1Name} (M = ${r.mean1.toFixed(2)}, ` +
      `SD = ${r.sd1.toFixed(2)}, n = ${r.n1}) and ${n2Name} (M = ${r.mean2.toFixed(2)}, ` +
      `SD = ${r.sd2.toFixed(2)}, n = ${r.n2}). The difference was ` +
      `${r.p < 0.05 ? 'statistically significant' : 'not statistically significant'}, ` +
      `t(${r.df.toFixed(2)}) = ${r.t.toFixed(3)}, p = ${formatP(r.p)}, ` +
      `95% CI [${r.ci[0].toFixed(2)}, ${r.ci[1].toFixed(2)}], ` +
      `Cohen's d = ${r.d.toFixed(2)} (${interpretD(r.d)}).`;
  }

  function runPairedT(n1Name, n2Name, arr1, arr2) {
    const r = pairedTTest(arr1, arr2);
    if (!r) return showToast('Paired tests need at least 2 complete pairs.', 'error');

    renderResults('t', r.t, r.p, "Cohen's dz", r.dz);
    renderCI(
      `95% CI for mean difference: [${r.ci[0].toFixed(3)}, ${r.ci[1].toFixed(3)}] ` +
      `(n = ${r.n} pairs)`
    );

    const normD = dagostinoNormality(r.diffs);
    const warns = [];
    if (normD.ok === false) {
      warns.push({
        level: 'warn',
        text: `Normality of the differences is questionable (D'Agostino p=${formatP(normD.p)}). ` +
              `Consider the Wilcoxon signed-rank test.`
      });
    } else if (normD.ok === true) {
      warns.push({
        level: 'ok',
        text: `Differences are consistent with normality (D'Agostino p=${formatP(normD.p)}).`
      });
    }
    renderAssumptions(warns, `Test operates on ${r.n} paired differences.`);

    pubSummary.value =
      `A paired-samples t-test compared ${n1Name} and ${n2Name} (n = ${r.n} pairs). ` +
      `The mean difference was ${r.meanDiff.toFixed(2)} (SD = ${r.sdDiff.toFixed(2)}); ` +
      `the effect was ${r.p < 0.05 ? 'statistically significant' : 'not statistically significant'}, ` +
      `t(${r.df}) = ${r.t.toFixed(3)}, p = ${formatP(r.p)}, ` +
      `95% CI [${r.ci[0].toFixed(2)}, ${r.ci[1].toFixed(2)}], ` +
      `Cohen's dz = ${r.dz.toFixed(2)} (${interpretD(r.dz)}).`;
  }

  function runANOVA(names, groups) {
    const r = oneWayAnova(groups);
    if (!r) return showToast('Each group needs at least 2 values.', 'error');

    renderResults('F', r.F, r.p, 'η²', r.etaSquared);
    renderCI(
      `η² = ${r.etaSquared.toFixed(3)}, ω² = ${r.omegaSquared.toFixed(3)} · ` +
      `groups: ${names.join(', ')}`
    );

    const lev = leveneTest(groups);
    const norms = groups.map(dagostinoNormality);
    const warns = [];

    if (lev.ok === false) {
      warns.push({
        level: 'warn',
        text: `Levene's test is significant (W=${lev.W.toFixed(2)}, p=${formatP(lev.p)}): ` +
              `group variances differ. Consider Welch's ANOVA or Kruskal–Wallis.`
      });
    } else {
      warns.push({
        level: 'ok',
        text: `Levene's test not significant (p=${formatP(lev.p)}): homogeneity of ` +
              `variance is tenable.`
      });
    }
    if (norms.some(x => x.ok === false)) {
      warns.push({
        level: 'warn',
        text: `At least one group departs from normality (D'Agostino). With small, ` +
              `unequal groups consider a non-parametric alternative.`
      });
    }
    renderAssumptions(warns,
      `Levene W(${lev.df1}, ${lev.df2}) = ${lev.W.toFixed(3)}, p = ${formatP(lev.p)}`);

    const desc = names.map((nm, i) =>
      `${nm} (M=${r.groupMeans[i].toFixed(2)}, SD=${r.groupSds[i].toFixed(2)}, n=${r.groupNs[i]})`
    ).join('; ');

    pubSummary.value =
      `A one-way ANOVA compared ${r.k} groups: ${desc}. The effect was ` +
      `${r.p < 0.05 ? 'statistically significant' : 'not statistically significant'}, ` +
      `F(${r.dfBetween}, ${r.dfWithin}) = ${r.F.toFixed(3)}, p = ${formatP(r.p)}, ` +
      `η² = ${r.etaSquared.toFixed(3)} (${interpretEta(r.etaSquared)}), ` +
      `ω² = ${r.omegaSquared.toFixed(3)}.` +
      (r.p < 0.05 && r.k > 2
        ? ' Post-hoc pairwise comparisons (e.g. Tukey HSD) are recommended to locate the differences.'
        : '');
  }

  function runPearson(n1Name, n2Name, arr1, arr2) {
    const r = pearsonCorrelation(arr1, arr2);
    if (!r) return showToast('Correlation needs at least 3 complete pairs.', 'error');

    renderResults('r', r.r, r.p, 'r²', r.r2);
    renderCI(
      `95% CI for r: [${r.ci[0].toFixed(3)}, ${r.ci[1].toFixed(3)}] · ` +
      `r² = ${r.r2.toFixed(3)} (${(100 * r.r2).toFixed(1)}% shared variance)`
    );

    const normX = dagostinoNormality(arr1);
    const normY = dagostinoNormality(arr2);
    const warns = [];
    if (normX.ok === false || normY.ok === false) {
      warns.push({
        level: 'warn',
        text: `One or both variables depart from normality. Pearson's r assumes ` +
              `bivariate normality for its p-value; consider Spearman's ρ.`
      });
    }
    renderAssumptions(warns,
      `Normality p: ${n1Name}=${formatP(normX.p)}, ${n2Name}=${formatP(normY.p)} · n=${r.n} pairs`);

    pubSummary.value =
      `A Pearson product–moment correlation assessed the relationship between ` +
      `${n1Name} and ${n2Name} (n = ${r.n}). The correlation was ` +
      `${r.p < 0.05 ? 'statistically significant' : 'not statistically significant'}, ` +
      `r(${r.df}) = ${r.r.toFixed(3)}, p = ${formatP(r.p)}, ` +
      `95% CI [${r.ci[0].toFixed(2)}, ${r.ci[1].toFixed(2)}]; ` +
      `r² = ${r.r2.toFixed(3)} indicates ${(100 * r.r2).toFixed(1)}% shared variance ` +
      `(${interpretR(r.r)}).`;
  }

  function runMannWhitney(n1Name, n2Name, arr1, arr2) {
    const r = mannWhitneyU(arr1, arr2);
    if (!r) return showToast('Both groups need at least one value.', 'error');

    renderResults('U', r.U, r.p, 'rank-biserial r', r.rankBiserial);
    renderCI(
      `z = ${r.z.toFixed(3)} (normal approximation${r.tieCorrected ? ', tie-corrected' : ''}) · ` +
      `medians: ${n1Name}=${r.median1.toFixed(2)}, ${n2Name}=${r.median2.toFixed(2)}`
    );
    renderAssumptions([{
      level: 'ok',
      text: 'Non-parametric: no normality assumption. Tests whether one distribution ' +
            'is stochastically shifted relative to the other.'
    }], `n₁=${r.n1}, n₂=${r.n2}. Normal approximation used; for very small n consult exact U tables.`);

    pubSummary.value =
      `A Mann–Whitney U test compared ${n1Name} (Mdn = ${r.median1.toFixed(2)}, n = ${r.n1}) ` +
      `and ${n2Name} (Mdn = ${r.median2.toFixed(2)}, n = ${r.n2}). The difference was ` +
      `${r.p < 0.05 ? 'statistically significant' : 'not statistically significant'}, ` +
      `U = ${r.U.toFixed(1)}, z = ${r.z.toFixed(3)}, p = ${formatP(r.p)}, ` +
      `rank-biserial r = ${r.rankBiserial.toFixed(2)}.`;
  }

  function runWilcoxon(n1Name, n2Name, arr1, arr2) {
    const r = wilcoxonSignedRank(arr1, arr2);
    if (!r) return showToast('No non-zero differences to test.', 'error');

    renderResults('W', r.W, r.p, 'effect r (z/√n)', r.effectR);
    renderCI(`z = ${r.z.toFixed(3)} (normal approximation) · n = ${r.n} non-zero differences`);
    renderAssumptions([{
      level: 'ok',
      text: 'Non-parametric paired test: assumes a symmetric distribution of ' +
            'differences, not normality.'
    }], `${r.nDropped} zero difference(s) dropped; normal approximation used (recommended for n ≳ 20).`);

    pubSummary.value =
      `A Wilcoxon signed-rank test compared ${n1Name} and ${n2Name} ` +
      `(n = ${r.n} non-zero differences). The difference was ` +
      `${r.p < 0.05 ? 'statistically significant' : 'not statistically significant'}, ` +
      `W = ${r.W.toFixed(1)}, z = ${r.z.toFixed(3)}, p = ${formatP(r.p)}, ` +
      `effect r = ${r.effectR.toFixed(2)}.`;
  }

  // --- 5. Output rendering ---
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  function renderResults(statName, statVal, pVal, effName, effVal) {
    statLabel.innerText = `${statName}-Statistic`;
    statValue.innerText = Number.isFinite(statVal)
      ? String(+statVal.toFixed(4)) : 'Error';

    if (!Number.isFinite(pVal)) {
      pValueEl.innerText = 'Error';
      pValueEl.className = 'text-2xl font-black text-red-600';
    } else {
      pValueEl.innerText = formatP(pVal);
      pValueEl.className = pVal < 0.05
        ? 'text-2xl font-black text-emerald-600 dark:text-emerald-400'
        : 'text-2xl font-black text-slate-600 dark:text-slate-400';
    }

    if (effectLabel && effectValue) {
      effectLabel.innerHTML = effName;
      effectValue.innerText = Number.isFinite(effVal)
        ? String(+effVal.toFixed(3)) : '--';
    }
  }

  function renderCI(text) {
    if (!ciBox) return;
    ciBox.innerHTML =
      `<i class="fa-solid fa-arrows-left-right-to-line mr-1" style="color:#6366f1"></i> ${text}`;
    ciBox.style.display = 'block';
  }

  function renderAssumptions(warns, footer) {
    if (!assumptionsBox) return;
    const rows = warns.map(w => {
      const icon = w.level === 'warn'
        ? '<i class="fa-solid fa-triangle-exclamation ico-warn"></i>'
        : '<i class="fa-solid fa-circle-check ico-ok"></i>';
      return `<div class="assume-row">${icon}<span>${w.text}</span></div>`;
    }).join('');

    assumptionsBox.innerHTML =
      `<div class="assume-title"><i class="fa-solid fa-clipboard-check"></i> Assumption checks</div>
       <div class="assume-rows">${rows || '<span class="assume-none">No assumption warnings.</span>'}</div>
       ${footer ? `<div class="assume-foot">${footer}</div>` : ''}`;
    assumptionsBox.style.display = 'block';
  }

  // --- 6. Theory (KaTeX) ---
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
    anova: String.raw`\begin{aligned}
      F &= \frac{MS_{\text{between}}}{MS_{\text{within}}}
         = \frac{SS_B/(k-1)}{SS_W/(N-k)} \\[6pt]
      \eta^2 &= \frac{SS_B}{SS_B+SS_W}
    \end{aligned}`,
    pearson: String.raw`\begin{aligned}
      r &= \frac{\sum (x_i-\bar{x})(y_i-\bar{y})}
                {\sqrt{\sum (x_i-\bar{x})^2 \; \sum (y_i-\bar{y})^2}} \\[6pt]
      t &= r\sqrt{\frac{n-2}{1-r^2}}
    \end{aligned}`,
    mannwhitney: String.raw`\begin{aligned}
      U_1 &= R_1 - \frac{n_1(n_1+1)}{2} \\[6pt]
      z &= \frac{U - \mu_U}{\sigma_U}, \qquad \mu_U = \frac{n_1 n_2}{2}
    \end{aligned}`,
    wilcoxon: String.raw`\begin{aligned}
      W &= \min(W_+,\, W_-) \\[6pt]
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
      [String.raw`s_1^2,\ s_2^2`, 'sample variance of each group (n\u22121 denominator)'],
      [String.raw`n_1,\ n_2`, 'number of observations in each group'],
      [String.raw`t`, 'difference in means divided by its standard error'],
      [String.raw`\nu`, 'Welch\u2013Satterthwaite degrees of freedom \u2014 usually not a whole number, which is why this test tolerates unequal variances']
    ],
    ttest_ind: [
      [String.raw`\bar{x}_1,\ \bar{x}_2`, 'mean of each group'],
      [String.raw`s_1^2,\ s_2^2`, 'sample variance of each group (n\u22121 denominator)'],
      [String.raw`s_p^2`, 'pooled variance \u2014 the two group variances averaged, weighted by degrees of freedom'],
      [String.raw`n_1,\ n_2`, 'number of observations in each group'],
      [String.raw`t`, 'difference in means divided by its standard error, on n\u2081+n\u2082\u22122 degrees of freedom']
    ],
    ttest_pair: [
      [String.raw`d_i`, 'difference within pair i, i.e. second measurement minus first'],
      [String.raw`\bar{d}`, 'mean of those differences'],
      [String.raw`s_d`, 'standard deviation of the differences'],
      [String.raw`n`, 'number of pairs, not the number of measurements'],
      [String.raw`t`, 'mean difference divided by its standard error, on n\u22121 degrees of freedom'],
      [String.raw`d_z`, 'effect size: the mean difference expressed in standard deviations']
    ],
    anova: [
      [String.raw`k`, 'number of groups'],
      [String.raw`N`, 'total number of observations across all groups'],
      [String.raw`SS_B`, 'between-group sum of squares \u2014 spread of the group means about the overall mean'],
      [String.raw`SS_W`, 'within-group sum of squares \u2014 spread of observations about their own group mean'],
      [String.raw`MS`, 'mean square: a sum of squares divided by its degrees of freedom'],
      [String.raw`F`, 'ratio of between-group to within-group variance; near 1 when the groups do not differ'],
      [String.raw`\eta^2`, 'eta squared: the share of total variation attributable to group membership']
    ],
    pearson: [
      [String.raw`x_i,\ y_i`, 'the two measurements on observation i'],
      [String.raw`\bar{x},\ \bar{y}`, 'mean of each variable'],
      [String.raw`n`, 'number of complete pairs; rows missing either value are dropped'],
      [String.raw`r`, 'correlation coefficient, between \u22121 and +1; measures straight-line association only'],
      [String.raw`t`, 'statistic for testing r \u2260 0, on n\u22122 degrees of freedom']
    ],
    mannwhitney: [
      [String.raw`n_1,\ n_2`, 'number of observations in each group'],
      [String.raw`R_1`, 'sum of the ranks held by group 1 once both groups are ranked together'],
      [String.raw`U_1`, 'rank-sum statistic for group 1; U\u2082 is defined the same way'],
      [String.raw`U`, 'the smaller of U\u2081 and U\u2082'],
      [String.raw`\mu_U,\ \sigma_U`, 'mean and standard deviation of U when the groups do not differ'],
      [String.raw`z`, 'normal approximation to U, used once both groups are reasonably large']
    ],
    wilcoxon: [
      [String.raw`W_+,\ W_-`, 'sum of the ranks of the positive and of the negative differences'],
      [String.raw`W`, 'the smaller of the two rank sums'],
      [String.raw`n`, 'number of pairs with a non-zero difference; ties at zero are discarded'],
      [String.raw`z`, 'normal approximation to W, used once n is reasonably large']
    ]
  };

  function renderTheory(type) {
    if (!theoryContainer) return;
    const formula = FORMULAS[type];
    if (!formula) { theoryContainer.innerHTML = ''; return; }

    if (!window.katex) {
      theoryContainer.innerHTML =
        '<span class="text-slate-400 text-sm">Formula renderer unavailable.</span>';
      return;
    }

    try {
      theoryContainer.innerHTML = katex.renderToString(formula, {
        displayMode: true, throwOnError: false, output: 'html'
      });
      renderDefinitions(type);
    } catch {
      theoryContainer.innerHTML =
        '<span class="text-slate-400 text-sm">Formula renderer unavailable.</span>';
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

  // --- 7. Copy and docs tabs ---
  if (copyBtn) copyBtn.addEventListener('click', () => {
    pubSummary.select();
    navigator.clipboard.writeText(pubSummary.value).then(
      () => showToast('Summary copied to clipboard.', 'info'),
      () => showToast('Clipboard access denied.', 'error')
    );
  });

  document.querySelectorAll('.doc-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const key = tab.getAttribute('data-doc-tab');
      document.querySelectorAll('.doc-tab').forEach(x =>
        x.classList.toggle('active', x === tab));
      document.querySelectorAll('.doc-pane').forEach(pane =>
        pane.classList.toggle('active', pane.getAttribute('data-doc-pane') === key));
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
          desc: "Control vs Treatment, a clear, significant difference.",
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
          desc: "Placebo / LowDose / HighDose | increasing means.",
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
          desc: "Repeated measures on the same subjects.",
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
          desc: "Height vs weight, strong positive relationship.",
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
      longtidy: {
          label: "Long / tidy format",
          desc: "One value column split by a group label (R / pandas style).",
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
          desc: "Skewed data: the t-test is fooled, Mann–Whitney isn't.",
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

  // Group the tutorial chips by test family for the banner.
  const SAMPLE_GROUPS = [
      { heading: "t-tests", keys: ["welch", "paired"] },
      { heading: "ANOVA", keys: ["anova"] },
      { heading: "Correlation", keys: ["pearson"] },
      { heading: "Formats & robustness", keys: ["longtidy", "nonparam"] }
  ];

  function loadSample(key) {
      const s = SAMPLES[key];
      if (!s) return;
      // 1) fill data + format, then parse (synchronous for string input)
      if (formatSelect) formatSelect.value = s.format;
      dataInput.value = s.csv;
      parseData();

      // 2) for long format, choose the value/group columns then re-pivot
      if (s.format === 'long') {
          if (s.valueCol) valueColSelect.value = s.valueCol;
          if (s.groupCol) groupColSelect.value = s.groupCol;
          buildLongGroups();
      }

      // 3) select the test and its variables/groups
      testType.value = s.test;
      syncSelectorVisibility();
      if (s.test === 'anova') {
          const wanted = s.groups || variables;
          Array.from(groupSelect.options).forEach(o => { o.selected = wanted.includes(o.value); });
      } else {
          if (s.v1 && [...var1.options].some(o => o.value === s.v1)) var1.value = s.v1;
          if (s.v2 && [...var2.options].some(o => o.value === s.v2)) var2.value = s.v2;
      }

      // 4) set up complete, the user reviews and runs it themselves.
      //    Hide any prior result so a stale one isn't shown before they run,
      //    then guide their eye to the primed Run button.
      if (resultsContainer) resultsContainer.classList.add('hidden');
      if (runTestBtn) {
          runTestBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
          runTestBtn.classList.add('run-pulse');
          setTimeout(() => runTestBtn.classList.remove('run-pulse'), 1600);
      }
      showToast(`Loaded "${s.label}", press Run Analysis to see the result.`, "info");
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
});
