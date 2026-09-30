/**
 * Error Bar Generator | UI layer.
 *
 * Group statistics, the pairwise tests and CSV export live in stemkit-core
 * (src/core/error-bars.js), and so do the chart and its Python script
 * (src/core/error-bars-figure.js). This file wires the page: the data, the
 * table, the chart's own choices (which error, bars or points, which
 * brackets), and the shared plot area (js/figure-plot.js), which draws the
 * chart, keeps the Style panel and the exports, and writes the script into
 * the Python panel.
 */
import { registerFromGlobals } from '../src/core/vendor.js';
import { computeGroups, resultsToCSV, pairwiseComparisons } from '../src/core/error-bars.js';
import { errorBarFigure, errorBarScript, significanceLabel } from '../src/core/error-bars-figure.js';

// jStat and Papa are loaded as UMD globals by the page's <script> tags.
registerFromGlobals();

const STYLE_KEY = 'stemkit.error-bar-generator.figure';
const OPTIONS_KEY = 'stemkit.error-bar-generator.chart';

document.addEventListener('DOMContentLoaded', () => {

  // # --- 1. State and bindings ---
  let computedResults = [];
  let comparisons = [];
  let currentLevel = 0.95;
  let sigFigs = 4;

  // What the chart shows, kept between visits.
  const chart = { mode: 'ci', display: 'bars', points: true, compare: 'significant', labels: 'stars' };
  try {
    const saved = JSON.parse(localStorage.getItem(OPTIONS_KEY) || '{}');
    if (['sd', 'sem', 'ci'].includes(saved.mode)) chart.mode = saved.mode;
    if (['bars', 'means'].includes(saved.display)) chart.display = saved.display;
    if (typeof saved.points === 'boolean') chart.points = saved.points;
    if (['significant', 'all', 'none'].includes(saved.compare)) chart.compare = saved.compare;
    if (['stars', 'p'].includes(saved.labels)) chart.labels = saved.labels;
  } catch (e) { /* storage blocked */ }
  const saveChart = () => { try { localStorage.setItem(OPTIONS_KEY, JSON.stringify(chart)); } catch (e) { /* blocked */ } };

  const dataInput = document.getElementById('dataInput');
  const fileInput = document.getElementById('fileInput');
  const hasHeaders = document.getElementById('hasHeaders');
  const calculateBtn = document.getElementById('calculateBtn');
  const resultsBody = document.getElementById('resultsBody');
  const exportCsvBtn = document.getElementById('exportCsvBtn');
  const theoryContainer = document.getElementById('theoryContainer');
  const ciLevelSelect = document.getElementById('ciLevel');
  const ciHeader = document.getElementById('ciHeader');
  const decimalsSelect = document.getElementById('decimals');

  const plotSection = document.getElementById('ebPlot');
  const pointsToggle = document.getElementById('ebPoints');
  const compareSelect = document.getElementById('ebCompare');
  const labelsOpt = document.getElementById('ebLabelsOpt');
  const segButtons = (attr) => Array.from(document.querySelectorAll(`[${attr}]`));
  const errButtons = segButtons('data-errmode');
  const displayButtons = segButtons('data-display');
  const labelButtons = segButtons('data-labels');
  const pairsBox = document.getElementById('ebPairs');
  const pairsBody = document.getElementById('ebPairsBody');
  const pairsNote = document.getElementById('ebPairsNote');

  const SAMPLES = {
    basic: 'Label,Rep1,Rep2,Rep3,Rep4\nControl,4.5,4.2,4.8,4.6\nLow Dose,6.1,6.5,6.2,6.3\nHigh Dose,8.3,8.1,8.9,8.5',
    overlap: 'Group,M1,M2,M3,M4\nAlpha,10.2,9.1,11.5,8.8\nBeta,10.8,9.6,12.1,9.4\nGamma,11.1,10.2,12.4,9.9',
    many: 'Sample,Trial1,Trial2,Trial3\npH 4,2.1,2.3,2.0\npH 5,3.4,3.6,3.5\npH 6,5.8,6.0,5.9\npH 7,8.2,8.5,8.1\npH 8,6.1,5.9,6.3\npH 9,3.2,3.0,3.4',
    ragged: 'Condition,V1,V2,V3,V4,V5\nBaseline,12.1,12.4,11.9\nStress,18.2,17.9,18.5,18.1,18.3\nRecovery,14.0,14.3',
    negative: 'Region,Q1,Q2,Q3,Q4\nNorth,-2.5,-1.8,-3.1,-2.2\nEquator,0.5,-0.3,1.1,-0.8\nSouth,3.2,2.8,3.6,3.0',
    messy: 'Label,Rep1,Rep2,Rep3\n\nControl,4.5,4.2,4.8\n\nTreatment,6.1,6.5,6.2\n\nNotes: run on 2026-03-01,,,'
  };

  // The example chips under the box, and the one in the plot's empty state.
  // The chip for the loaded example stays marked until the data is edited.
  const chips = document.querySelectorAll('.eb-chip');
  const markChip = (key) => chips.forEach(c =>
    c.setAttribute('aria-pressed', String(c.getAttribute('data-sample') === key)));
  markChip(null);

  document.querySelectorAll('[data-sample]').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.getAttribute('data-sample');
      const s = SAMPLES[key];
      if (!s) return;
      dataInput.value = s;
      markChip(key);
      calculate();
    });
  });

  // Editing the data unmarks the example; emptying the box clears the
  // results, so no statistics are shown for data that is no longer there.
  dataInput.addEventListener('input', () => {
    markChip(null);
    if (!dataInput.value.trim()) clearResults();
  });

  /** Back to the state before the first calculation. */
  function clearResults(message) {
    computedResults = [];
    comparisons = [];
    resultsBody.innerHTML =
      '<tr><td colspan="11" class="px-4 py-16 text-center text-slate-500 dark:text-slate-400">' +
      (message || 'N, mean, SD, SEM, median, IQR, CV and the confidence interval for each group appear here.') +
      '</td></tr>';
    exportCsvBtn.disabled = true;
    renderPairs();
    drawPlot();
  }

  function calculate() {
    const rawText = dataInput.value.trim();
    if (!rawText) return showToast('Paste or upload some data first.', 'error');

    // Parsed without header mode so the core can decide for itself whether the
    // first row is a header; the control acts as an explicit override.
    const parsed = Papa.parse(rawText, {
      header: false, dynamicTyping: true, skipEmptyLines: true
    });

    const rows = (parsed.data || [])
      .filter(r => Array.isArray(r) && r.some(c => c !== null && c !== ''));

    if (rows.length === 0) return showToast('Could not parse any rows.', 'error');
    if (rows[0].length < 2) {
      return showToast('Each row needs a label plus at least one value.', 'error');
    }

    const mode = (hasHeaders && hasHeaders.value) || 'auto';
    const hasHeader = mode === 'auto' ? 'auto' : (mode === 'yes');

    const result = computeGroups(rows, { level: currentLevel, hasHeader });
    computedResults = result.results;

    if (computedResults.length === 0) {
      clearResults('No numeric groups found. Put a text label in the first column and ' +
        'numeric replicates in the rest, or change the header setting.');
      return;
    }
    comparisons = pairwiseComparisons(computedResults);

    renderTable();
    renderPairs();
    drawPlot();

    let msg = `Computed statistics for ${computedResults.length} ` +
              `group${computedResults.length > 1 ? 's' : ''}.`;
    if (result.skipped > 0) {
      msg += ` Skipped ${result.skipped} row${result.skipped > 1 ? 's' : ''} ` +
             `with no label or no numbers.`;
    }
    showToast(msg, 'success');
    exportCsvBtn.disabled = false;
  }

  if (calculateBtn) calculateBtn.onclick = calculate;

  if (fileInput) fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => { dataInput.value = ev.target.result; markChip(null); calculate(); };
    reader.readAsText(file);
    fileInput.value = '';
  });

  if (ciLevelSelect) ciLevelSelect.addEventListener('change', () => {
    currentLevel = parseFloat(ciLevelSelect.value) || 0.95;
    if (ciHeader) ciHeader.textContent = `${Math.round(currentLevel * 100)}% CI (±)`;
    if (computedResults.length) calculate();
  });

  if (decimalsSelect) decimalsSelect.addEventListener('change', () => {
    sigFigs = parseInt(decimalsSelect.value, 10) || 4;
    if (computedResults.length) { renderTable(); renderPairs(); }
  });

  // # --- 2. The chart's own choices ---
  // Each segmented control has exactly one pressed button: the state drawn.
  function bindSeg(buttons, attr, key) {
    const sync = () => buttons.forEach(b => b.setAttribute('aria-pressed', String(b.getAttribute(attr) === chart[key])));
    buttons.forEach(b => b.addEventListener('click', () => {
      chart[key] = b.getAttribute(attr);
      sync();
      saveChart();
      drawPlot();
    }));
    sync();
  }
  bindSeg(errButtons, 'data-errmode', 'mode');
  bindSeg(displayButtons, 'data-display', 'display');
  bindSeg(labelButtons, 'data-labels', 'labels');
  const syncCompare = () => { if (labelsOpt) labelsOpt.hidden = chart.compare === 'none'; };
  if (compareSelect) {
    compareSelect.value = chart.compare;
    compareSelect.addEventListener('change', () => {
      chart.compare = compareSelect.value;
      syncCompare();
      saveChart();
      drawPlot();
    });
  }
  syncCompare();
  if (pointsToggle) {
    pointsToggle.checked = chart.points;
    pointsToggle.addEventListener('change', () => {
      chart.points = pointsToggle.checked;
      saveChart();
      drawPlot();
    });
  }

  // # --- 3. Table ---
  // A value that cannot be computed (a single replicate has no SD) shows as
  // an en dash rather than a zero that looks like a measurement.
  const fmt = (x) => (Number.isFinite(x) ? String(+x.toFixed(sigFigs)) : '–');
  const minus = (s) => String(s).replace(/^-/, '−');

  // Cells in the order of the table's headings: Label, N, Mean, SD, SEM,
  // Median, IQR, CV, Min/Max, t*, CI.
  function renderTable() {
    const pct = Math.round(currentLevel * 100);
    resultsBody.innerHTML = computedResults.map(r => `
      <tr class="hover:bg-slate-50 dark:hover:bg-slate-900/50 transition-colors">
        <td class="px-3 py-3 font-bold text-brand-700 dark:text-brand-300 border-r border-slate-100 dark:border-slate-800">${escapeHtml(String(r.key))}</td>
        <td class="px-3 py-3">${r.n}</td>
        <td class="px-3 py-3 font-mono">${fmt(r.mean)}</td>
        <td class="px-3 py-3 font-mono">${r.n > 1 ? fmt(r.sd) : '–'}</td>
        <td class="px-3 py-3 font-mono">${r.n > 1 ? fmt(r.sem) : '–'}</td>
        <td class="px-3 py-3 font-mono">${fmt(r.median)}</td>
        <td class="px-3 py-3 font-mono">${fmt(r.iqr)}</td>
        <td class="px-3 py-3 font-mono">${r.n > 1 && r.mean !== 0 ? fmt(r.cv) + '%' : '–'}</td>
        <td class="px-3 py-3 font-mono">${fmt(r.min)} / ${fmt(r.max)}</td>
        <td class="px-3 py-3 font-mono">${r.n > 1 ? fmt(r.t) : '–'}</td>
        <td class="px-3 py-3 font-mono font-bold">${r.n > 1 ? fmt(r.ci) : '–'}</td>
      </tr>`).join('');
    if (ciHeader) ciHeader.textContent = `${pct}% CI (±)`;
  }

  // # --- 4. Pairwise tests ---
  const pText = (p) => (p < 0.001 ? '< 0.001' : p.toFixed(3));
  function renderPairs() {
    if (!pairsBox) return;
    if (computedResults.length < 2) { pairsBox.hidden = true; return; }
    pairsBox.hidden = false;
    const mean = new Map(computedResults.map(r => [r.key, r.mean]));
    pairsBody.innerHTML = comparisons.map(c => {
      const sig = c.pAdjusted < 0.05;
      return `<tr${sig ? ' class="is-sig"' : ''}>
        <th scope="row">${escapeHtml(c.a)} <span class="eb-vs">vs</span> ${escapeHtml(c.b)}</th>
        <td>${minus(fmt(mean.get(c.a) - mean.get(c.b)))}</td>
        <td>${minus(c.t.toFixed(3))}</td>
        <td>${c.df.toFixed(2)}</td>
        <td>${pText(c.p)}</td>
        <td class="eb-holm">${pText(c.pAdjusted)}</td>
        <td class="eb-mark">${escapeHtml(significanceLabel(c.pAdjusted))}</td>
      </tr>`;
    }).join('');
    const untested = computedResults.filter(r => r.n < 2).map(r => r.key);
    const m = comparisons.length;
    pairsNote.textContent = (m
      ? `Difference is the first group's mean minus the second's. Holm's method adjusts the ${m} p-value${m === 1 ? '' : 's'} ` +
        'so that the chance of any false positive among the pairs stays at 5%. * p < 0.05, ** p < 0.01, *** p < 0.001.'
      : 'No pair could be tested: each group needs at least two replicates, and a pair needs some spread.') +
      (untested.length ? ` Not tested (one replicate): ${untested.join(', ')}.` : '');
  }

  // # --- 5. The chart ---
  const pyHost = document.getElementById('ebPython');
  let plot = null;
  let lastForeground = null;
  let stored = {};
  try { stored = JSON.parse(localStorage.getItem(STYLE_KEY) || '{}'); } catch (e) { stored = {}; }

  // The replicates are drawn in the figure's foreground colour, so they stay
  // visible on any background the person picks.
  const foreground = () => {
    const s = plot ? plot.getStyle() : stored;
    return typeof s.foreground === 'string' && /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(s.foreground) ? s.foreground : '#1a1a1a';
  };
  const chartOptions = () => ({ ...chart, level: currentLevel, comparisons });

  function drawPlot() {
    if (!plot) return;
    lastForeground = foreground();
    plot.update(computedResults.length
      ? errorBarFigure(computedResults, { ...chartOptions(), pointColor: lastForeground })
      : null);
  }

  function exported(r, err, format) {
    if (err) {
      showToast(`The ${format.toUpperCase()} could not be made: ${err && err.message ? err.message : err}`, 'error');
      return;
    }
    showToast(`Saved ${r.filename}.`, 'success');
  }

  import('./figure-plot.js').then(({ mountFigure }) => {
    plot = mountFigure(plotSection, {
      style: stored,
      onStyleChange: (style) => {
        try { localStorage.setItem(STYLE_KEY, JSON.stringify(style)); } catch (e) { /* storage full or blocked */ }
        if (foreground() !== lastForeground) drawPlot();
      },
      label: "Each group's mean with its error bars, the replicates, and brackets over the pairs that differ",
      onExport: exported,
      python: pyHost ? {
        host: pyHost,
        title: 'Python script',
        filename: 'error_bars.py',
        script: (figure) => errorBarScript(figure, { ...chartOptions(), groups: computedResults })
      } : false
    });
    drawPlot();
  }).catch((err) => {
    const notes = plotSection.querySelector('.fg-notes');
    if (notes) {
      notes.textContent = `The chart could not load (${err && err.message ? err.message : err}). Reload the page to try again; the table still works.`;
      notes.hidden = false;
    }
  });

  // # --- 6. Export ---
  if (exportCsvBtn) exportCsvBtn.addEventListener('click', () => {
    const csv = resultsToCSV(computedResults);
    downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8;' }), 'error_bar_stats.csv');
    showToast('CSV exported.', 'success');
  });

  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  // # --- 7. Utilities ---
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function showToast(msg, type) {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    const colors = type === 'success'
      ? 'bg-emerald-50 text-emerald-800 border-emerald-200 dark:bg-emerald-900/40 dark:text-emerald-200'
      : type === 'error'
        ? 'bg-red-50 text-red-800 border-red-200 dark:bg-red-900/40 dark:text-red-200'
        : 'bg-blue-50 text-blue-800 border-blue-200 dark:bg-blue-900/40 dark:text-blue-200';
    toast.className = `px-4 py-3 rounded-xl border shadow-lg text-sm font-medium transition-all ${colors}`;
    toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
    toast.innerText = msg;
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  // # --- 8. Theory (KaTeX) ---
  function renderTheory() {
    if (!theoryContainer) return;
    const texMain = String.raw`\begin{aligned}
        \bar{x} &= \frac{1}{n}\sum_{i=1}^{n} x_i
        \qquad s = \sqrt{\frac{\sum_{i=1}^{n}(x_i - \bar{x})^2}{n-1}} \\[8pt]
        \mathrm{SEM} &= \frac{s}{\sqrt{n}}
        \qquad \mathrm{CI}_{1-\alpha} = \bar{x} \pm t^{*}_{\alpha/2,\,n-1}\cdot \mathrm{SEM}
    \end{aligned}`;
    const texSpread = String.raw`\begin{aligned}
        \tilde{x} &= \begin{cases} x_{((n+1)/2)} & n \text{ odd} \\[2pt]
            \tfrac{1}{2}\left(x_{(n/2)} + x_{(n/2+1)}\right) & n \text{ even} \end{cases}
        \qquad \mathrm{IQR} = Q_3 - Q_1 \\[8pt]
        \mathrm{CV} &= \frac{s}{\lvert \bar{x} \rvert}\times 100\%
        \qquad \text{range} = [\,x_{\min},\, x_{\max}\,]
    \end{aligned}`;
    const texTest = String.raw`t = \frac{\bar{x}_a - \bar{x}_b}{\sqrt{s_a^2/n_a + s_b^2/n_b}}
        \qquad p_{(k)}^{\mathrm{Holm}} = \max_{j \le k}\ \min\!\left(1,\ (m - j + 1)\,p_{(j)}\right)`;
    if (typeof katex !== 'undefined') {
      const kxBlock = tex => { try { return katex.renderToString(tex, { displayMode: true, throwOnError: false, output: 'html' }); } catch (e) { return '<span class="text-slate-500 dark:text-slate-400 text-sm">Formula unavailable.</span>'; } };
      theoryContainer.innerHTML =
        `<div class="mf-block-label">Central tendency &amp; inference</div>${kxBlock(texMain)}
         <div class="mf-block-label" style="margin-top:1rem;">Spread &amp; robustness</div>${kxBlock(texSpread)}
         <div class="mf-block-label" style="margin-top:1rem;">Pairwise comparisons (Welch, Holm)</div>${kxBlock(texTest)}`;
      renderDefs();
    }
  }
  function renderDefs() {
    const defs = [
      [`\\bar{x}`, `group mean`],
      [`\\tilde{x}`, `median — middle value; robust to outliers`],
      [`n`, `number of replicates in the group`],
      [`s`, `sample standard deviation (n−1 denominator)`],
      [`\\mathrm{SEM}`, `standard error of the mean = s / √n`],
      [`Q_1,\\ Q_3`, `first and third quartiles (25th, 75th percentiles)`],
      [`\\mathrm{IQR}`, `interquartile range = Q₃ − Q₁; spread of the middle 50%`],
      [`\\mathrm{CV}`, `coefficient of variation — SD relative to the mean, as a %`],
      [`x_{\\min},\\ x_{\\max}`, `smallest and largest replicate values`],
      [`t^{*}_{\\alpha/2,\\,n-1}`, `Student’s t critical value at the chosen level, df = n−1`],
      [`\\mathrm{CI}`, `confidence interval; half-width = t* × SEM`],
      [`p_{(j)},\\ m`, `the j-th smallest of the m pairwise p-values, each from Welch’s t on its Welch–Satterthwaite df`]
    ];
    const kx = tex => { try { return katex.renderToString(tex, { throwOnError: false, output: 'html' }); } catch (e) { return tex; } };
    const items = defs.map(([s, m]) => `<div class="mf-def"><dt>${kx(s)}</dt><dd>${m}</dd></div>`).join('');
    const host = document.getElementById('theoryDefs');
    if (host) host.innerHTML = `<div class="mf-defs"><div class="mf-defs-title">Where:</div><dl>${items}</dl></div>`;
  }
  renderTheory();
});
