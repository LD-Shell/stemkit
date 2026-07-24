/**
 * Outlier Detector | UI layer.
 *
 * Detection algorithms live in @stemkit/core; this file handles DOM wiring,
 * file intake, and rendering only.
 */
import { registerFromGlobals } from '../src/core/vendor.js';
import {
  detectOutliers,
  extractNumericColumn,
  mapToRowIndices,
  partitionRows,
  grubbsTest
} from '../src/core/outliers.js';

// Papa is loaded as a UMD global by the page's <script> tags.
registerFromGlobals();

document.addEventListener('DOMContentLoaded', () => {

  // # --- 1. State ---
  let rawData = [];
  let headers = [];
  let outlierIndices = new Set();

  // # --- 2. Interface bindings ---
  const uploadZone = document.getElementById('uploadZone');
  const fileInput = document.getElementById('fileInput');
  const workspace = document.getElementById('workspace');
  const colSelect = document.getElementById('colSelect');
  const methodSelect = document.getElementById('methodSelect');
  const thresholdSlider = document.getElementById('thresholdSlider');
  const thresholdValue = document.getElementById('thresholdValue');
  const methodHint = document.getElementById('methodHint');
  const outlierCountEl = document.getElementById('outlierCount');
  const exampleBtn = document.getElementById('exampleBtn');

  const scanBtn = document.getElementById('scanBtn');
  const exportCleanBtn = document.getElementById('exportCleanBtn');
  const exportFlaggedBtn = document.getElementById('exportFlaggedBtn');

  // Dark-mode toggling is handled by the shared inline script in the page.

  ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
    uploadZone.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
    }, false);
  });
  uploadZone.addEventListener('dragover', () => uploadZone.classList.add('border-indigo-500'));
  uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('border-indigo-500'));
  uploadZone.addEventListener('drop', (e) => {
    uploadZone.classList.remove('border-indigo-500');
    if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
  });
  uploadZone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (e) => {
    if (e.target.files.length) handleFile(e.target.files[0]);
  });

  // # --- 3. Threshold and method parameters ---
  const METHOD_DEFAULTS = {
    zscore: { min: 1, max: 5, step: 0.1, value: 3 },
    iqr: { min: 0.5, max: 3, step: 0.1, value: 1.5 },
    modzscore: { min: 2, max: 6, step: 0.1, value: 3.5 }
  };

  thresholdSlider.addEventListener('input', (e) => {
    const val = parseFloat(e.target.value).toFixed(1);
    thresholdValue.innerText = val;
    updateMethodHint(methodSelect.value, val);
  });

  methodSelect.addEventListener('change', (e) => {
    const d = METHOD_DEFAULTS[e.target.value] || METHOD_DEFAULTS.zscore;
    thresholdSlider.min = d.min;
    thresholdSlider.max = d.max;
    thresholdSlider.step = d.step;
    thresholdSlider.value = d.value;
    thresholdValue.innerText = d.value.toFixed(1);
    updateMethodHint(e.target.value, d.value);
  });

  function updateMethodHint(method, threshold) {
    if (method === 'zscore') {
      methodHint.innerText =
        `Flags values where the absolute Z-Score exceeds ${threshold}. Assumes roughly normal data.`;
    } else if (method === 'modzscore') {
      methodHint.innerText =
        `Flags values where the modified Z-Score (median/MAD based) exceeds ${threshold}. ` +
        `Robust to existing outliers; 3.5 is the Iglewicz–Hoaglin default.`;
    } else {
      methodHint.innerText =
        `Flags values outside Q1 − ${threshold}×IQR and Q3 + ${threshold}×IQR (Tukey fences). ` +
        `Good for skewed data.`;
    }
  }

  // # --- 4. Data intake ---
  function handleFile(file) {
    const name = ((file && file.name) || '').toLowerCase();
    if (!file || !/\.(csv|tsv|txt)$/.test(name)) {
      showToast('Please choose a .csv, .tsv or .txt file.', 'error');
      return;
    }
    document.getElementById('fileName').innerText = file.name;

    Papa.parse(file, {
      header: true,
      dynamicTyping: true,
      skipEmptyLines: true,
      delimiter: '',
      complete: (results) => {
        if (!results.data || results.data.length === 0) {
          showToast('No rows could be parsed from that file.', 'error');
          return;
        }
        rawData = results.data;
        headers = (results.meta.fields || []).filter(h => h !== null && h !== undefined && h !== '');
        outlierIndices.clear();

        populateColumnSelector();
        renderArrayView();

        uploadZone.classList.add('hidden');
        workspace.classList.remove('hidden');
        document.getElementById('dataMeta').innerText =
          `${rawData.length} Rows • ${headers.length} Columns`;
      }
    });
    fileInput.value = '';
  }

  function loadExample() {
    const rows = [78, 80, 79, 81, 77, 80, 79, 82, 78, 250, 80, 79, 3, 81, 79];
    rawData = rows.map((v, i) => ({ sample_id: i + 1, measurement: v }));
    headers = ['sample_id', 'measurement'];
    outlierIndices.clear();
    document.getElementById('fileName').innerText = 'example_data.csv';
    populateColumnSelector();
    colSelect.value = 'measurement';
    renderArrayView();
    uploadZone.classList.add('hidden');
    workspace.classList.remove('hidden');
    document.getElementById('dataMeta').innerText =
      `${rawData.length} Rows • ${headers.length} Columns`;
  }
  if (exampleBtn) exampleBtn.addEventListener('click', loadExample);

  function populateColumnSelector() {
    colSelect.innerHTML = '';
    headers.forEach(header => {
      const opt = document.createElement('option');
      opt.value = header;
      opt.textContent = header;
      colSelect.appendChild(opt);
    });
  }

  // # --- 5. Detection (delegated to the core) ---
  scanBtn.addEventListener('click', () => {
    const targetCol = colSelect.value;
    const method = methodSelect.value;
    const threshold = parseFloat(thresholdSlider.value);
    outlierIndices.clear();

    const { values, indexMap } = extractNumericColumn(rawData, targetCol);

    if (values.length < 4) {
      showToast('Need at least 4 numeric values in the selected column.', 'error');
      return;
    }

    const result = detectOutliers(values, method, threshold);
    if (!result) {
      showToast('Unknown detection method.', 'error');
      return;
    }

    if (result.degenerate) {
      showToast('Standard deviation is zero, no spread to flag.', 'info');
    }
    if (result.usedFallback) {
      showToast('More than half the values are identical; using the mean ' +
                'absolute deviation instead of the MAD.', 'info');
    }

    for (const i of mapToRowIndices(result.indices, indexMap)) {
      outlierIndices.add(i);
    }

    outlierCountEl.innerText = outlierIndices.size;
    renderArrayView();

    const has = outlierIndices.size > 0;
    exportCleanBtn.disabled = !has;
    exportFlaggedBtn.disabled = !has;

    // Grubbs offers a formal significance statement alongside the flag count.
    const g = grubbsTest(values, 0.05);
    if (g && g.isOutlier) {
      showToast(
        `${outlierIndices.size} outlier${outlierIndices.size > 1 ? 's' : ''} flagged. ` +
        `Grubbs' test: G = ${g.G.toFixed(3)} exceeds the critical ` +
        `${g.critical.toFixed(3)} (p = ${g.p < 0.001 ? '< 0.001' : g.p.toFixed(3)}).`,
        'success'
      );
    } else if (has) {
      showToast(`${outlierIndices.size} outlier${outlierIndices.size > 1 ? 's' : ''} flagged.`, 'success');
    } else {
      showToast('No outliers detected with the current settings.', 'info');
    }
  });

  // # --- 6. Table view ---
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function renderArrayView() {
    const thead = document.getElementById('tableHead');
    thead.innerHTML = '<tr>' + headers.map(h =>
      `<th class="px-4 py-3 font-semibold text-slate-700 dark:text-slate-300 border-r border-slate-200 dark:border-slate-700 last:border-0">${escapeHtml(h)}</th>`
    ).join('') + '</tr>';

    const tbody = document.getElementById('tableBody');
    const previewLimit = Math.min(rawData.length, 200);
    let rowsHtml = '';
    for (let i = 0; i < previewLimit; i++) {
      const row = rawData[i];
      const isOutlier = outlierIndices.has(i);
      let tdHtml = '';
      headers.forEach(h => {
        let val = row[h];
        if (typeof val === 'number' && !Number.isInteger(val)) val = val.toFixed(4);
        const textClass = isOutlier
          ? 'text-red-700 dark:text-red-400 font-bold'
          : 'text-slate-600 dark:text-slate-400';
        const display = (val !== null && val !== undefined) ? escapeHtml(String(val)) : 'NaN';
        tdHtml += `<td class="px-4 py-2 ${textClass} border-r border-slate-100 dark:border-slate-800/50 last:border-0">${display}</td>`;
      });
      rowsHtml += `<tr class="${isOutlier ? 'outlier-row' : ''}">${tdHtml}</tr>`;
    }
    tbody.innerHTML = rowsHtml;
  }

  // # --- 7. Export ---
  exportCleanBtn.addEventListener('click', () => {
    const { clean } = partitionRows(rawData, [...outlierIndices]);
    triggerDownload(clean, 'scrubbed_dataset.csv');
  });
  exportFlaggedBtn.addEventListener('click', () => {
    const { flagged } = partitionRows(rawData, [...outlierIndices]);
    triggerDownload(flagged, 'isolated_anomalies.csv');
  });

  function triggerDownload(dataArray, filename) {
    if (!dataArray.length) return;
    const csvString = Papa.unparse(dataArray);
    const blob = new Blob([csvString], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', filename);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    showToast(`Exported ${filename}`, 'success');
  }

  // # --- 8. Toasts ---
  function showToast(msg, type) {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    const colors = type === 'success'
      ? 'bg-emerald-50 text-emerald-800 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-400'
      : type === 'error'
        ? 'bg-red-50 text-red-800 border-red-200 dark:bg-red-900/30 dark:text-red-400'
        : 'bg-indigo-50 text-indigo-800 border-indigo-200 dark:bg-indigo-900/30 dark:text-indigo-400';
    toast.className = `px-4 py-3 rounded-xl border shadow-lg toast-enter text-sm font-medium transition-all ${colors}`;
    toast.innerHTML = `<i class="fa-solid ${type === 'success' ? 'fa-check-circle' : type === 'error' ? 'fa-triangle-exclamation' : 'fa-info-circle'} mr-2"></i> ${escapeHtml(msg)}`;
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  /* --- What the method computes --------------------------------------------
   * The method names alone do not say which convention is in use, and they
   * differ in ways that change the answer: the modified z-score carries a
   * consistency constant, the fences carry a multiplier, and quartiles have
   * several competing definitions. The formula and its terms are shown so the
   * result can be checked rather than taken on trust.
   */
  const FORMULAS = {
    zscore: String.raw`z_i = \frac{x_i - \bar{x}}{s}, \qquad
                       s = \sqrt{\frac{1}{n-1}\sum_{i=1}^{n}(x_i - \bar{x})^2}`,
    modzscore: String.raw`M_i = \frac{0.6745\,(x_i - \tilde{x})}{\mathrm{MAD}}, \qquad
                         \mathrm{MAD} = \mathrm{median}\bigl(|x_i - \tilde{x}|\bigr)`,
    iqr: String.raw`\text{flag } x_i \notin [\,Q_1 - k\,\mathrm{IQR},\; Q_3 + k\,\mathrm{IQR}\,],
                    \qquad \mathrm{IQR} = Q_3 - Q_1`,
    grubbs: String.raw`G = \frac{\max_i |x_i - \bar{x}|}{s}`
  };

  const DEFINITIONS = {
    zscore: [
      [String.raw`x_i`, 'the observation being tested'],
      [String.raw`\bar{x}`, 'mean of all observations'],
      [String.raw`s`, 'sample standard deviation, computed with the n\u22121 denominator'],
      [String.raw`n`, 'number of observations'],
      [String.raw`z_i`, 'distance from the mean in standard deviations; flagged when it exceeds the threshold'],
      [String.raw`\;`, 'Both the mean and s are themselves affected by an outlier, so a single extreme value can mask itself in a small sample.']
    ],
    modzscore: [
      [String.raw`\tilde{x}`, 'median of all observations'],
      [String.raw`\mathrm{MAD}`, 'median absolute deviation from the median'],
      [String.raw`0.6745`, 'consistency constant making MAD comparable to a standard deviation for normally distributed data'],
      [String.raw`M_i`, 'robust analogue of the z-score; the conventional cut-off is 3.5 (Iglewicz & Hoaglin)'],
      [String.raw`\;`, 'Median-based, so unlike the z-score it is not dragged by the very points it is testing.']
    ],
    iqr: [
      [String.raw`Q_1, Q_3`, 'first and third quartiles, by linear interpolation between order statistics (the default used by R and NumPy)'],
      [String.raw`\mathrm{IQR}`, 'interquartile range, the spread of the middle half of the data'],
      [String.raw`k`, 'fence multiplier; 1.5 is Tukey\u2019s conventional "outlier" fence, 3.0 marks "far out" points'],
      [String.raw`\;`, 'Distribution-free: it assumes nothing about normality, only that the middle half describes the bulk.']
    ],
    grubbs: [
      [String.raw`G`, 'largest absolute deviation from the mean, in standard deviations'],
      [String.raw`\bar{x},\ s`, 'mean and sample standard deviation of all observations'],
      [String.raw`\alpha`, 'significance level of the test, 0.05 by default'],
      [String.raw`\;`, 'Tests one point at a time and assumes the rest are normally distributed; re-run after removing a flagged value rather than reading several at once.']
    ]
  };

  function renderTheory(method) {
    const host = document.getElementById('theoryContainer');
    if (!host) return;
    const formula = FORMULAS[method];
    if (!formula) { host.innerHTML = ''; return; }

    if (!window.katex) {
      host.innerHTML = '<span class="text-xs text-slate-400">Formula renderer unavailable.</span>';
      return;
    }

    const kx = (tex, display) => {
      try {
        return katex.renderToString(tex, { displayMode: !!display, throwOnError: false, output: 'html' });
      } catch { return tex; }
    };

    // The LaTeX source is kept on the element: rendered output cannot be
    // copied back out as LaTeX, and a formula is often wanted for a methods
    // section.
    const defs = (DEFINITIONS[method] || []).map(([sym, meaning]) =>
      sym.trim() === '\\;'
        ? `<div class="mf-def"><dt></dt><dd class="italic">${meaning}</dd></div>`
        : `<div class="mf-def"><dt>${kx(sym)}</dt><dd>${meaning}</dd></div>`).join('');

    host.innerHTML =
      `<div data-tex="${formula.replace(/"/g, '&quot;')}" title="LaTeX source in the data-tex attribute">${kx(formula, true)}</div>` +
      (defs ? `<div class="mf-defs"><div class="mf-defs-title">Where:</div><dl>${defs}</dl></div>` : '');
  }

  if (methodSelect) methodSelect.addEventListener('change', () => renderTheory(methodSelect.value));
  const theoryHost = document.getElementById('methodTheory');
  if (theoryHost) theoryHost.addEventListener('toggle', () => {
    if (theoryHost.open && methodSelect) renderTheory(methodSelect.value);
  });

});
