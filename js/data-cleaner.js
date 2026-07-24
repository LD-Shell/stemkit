/**
 * CSV Data Cleaner | UI layer.
 *
 * Parsing, cleaning operations, numeric transforms, and column statistics live
 * in @stemkit/core; this file handles DOM wiring and the table preview.
 *
 * Standardisation convention: the Z-score transform uses the *population*
 * standard deviation, matching scikit-learn's StandardScaler. Pandas defaults
 * to the sample (n-1) form, so values differ slightly for small samples.
 */
import { registerFromGlobals } from '../src/core/vendor.js';
import {
  parseDelimited,
  toCSV,
  columnStats,
  dropMissing,
  deduplicate,
  fillMissing,
  trimWhitespace,
  changeCase,
  sortByColumn,
  transformColumn,
  profileData
} from '../src/core/data-cleaning.js';

// Papa Parse is loaded as a UMD global by the page's <script> tags.
registerFromGlobals();

document.addEventListener('DOMContentLoaded', () => {

  // --- 1. State ---
  let rawData = [];
  let currentData = [];
  let headers = [];

  // --- 2. Bindings ---
  const uploadZone = document.getElementById('uploadZone');
  const fileInput = document.getElementById('fileInput');
  const workspace = document.getElementById('workspace');
  const colStats = document.getElementById('colStats');
  const colSelect = document.getElementById('colSelect');
  const opSelect = document.getElementById('opSelect');
  const applyBtn = document.getElementById('applyBtn');
  const resetBtn = document.getElementById('resetDataBtn');
  const exportBtn = document.getElementById('exportBtn');
  const dataMeta = document.getElementById('dataMeta');

  ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(evt => {
    uploadZone.addEventListener(evt, (e) => {
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

  // --- 3. Ingestion ---
  function handleFile(file) {
    const name = ((file && file.name) || '').toLowerCase();
    if (!file || !/\.(csv|tsv|txt)$/.test(name)) {
      showToast('Please choose a .csv, .tsv or .txt file.', 'error');
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      const parsed = parseDelimited(e.target.result);

      if (parsed.rows.length === 0) {
        showToast('No rows could be parsed from that file.', 'error');
        return;
      }

      rawData = parsed.rows;
      currentData = parsed.rows.map(r => ({ ...r }));
      headers = parsed.fields;

      populateColumnSelector();
      renderTable();
      updateMeta();

      uploadZone.classList.add('hidden');
      workspace.classList.remove('hidden');

      const fileNameEl = document.getElementById('fileName');
      if (fileNameEl) fileNameEl.innerText = file.name;
    };
    reader.readAsText(file);
    fileInput.value = '';
  }

  function populateColumnSelector() {
    if (!colSelect) return;
    colSelect.innerHTML = '<option value="all">All columns</option>';
    for (const h of headers) {
      const opt = document.createElement('option');
      opt.value = h;
      opt.textContent = h;
      colSelect.appendChild(opt);
    }
  }

  function updateMeta() {
    if (!dataMeta) return;
    const p = profileData(currentData, headers);
    dataMeta.innerText =
      `${p.nRows} rows • ${p.nColumns} columns` +
      (p.totalMissing ? ` • ${p.totalMissing} missing` : '') +
      (p.duplicateRows ? ` • ${p.duplicateRows} duplicate` : '');
  }

  // --- 4. Column statistics ---
  if (colSelect) colSelect.addEventListener('change', renderColStats);

  function renderColStats() {
    if (!colStats) return;
    const col = colSelect.value;

    if (col === 'all') {
      colStats.innerHTML = '';
      colStats.classList.add('hidden');
      return;
    }

    const s = columnStats(currentData, col);
    colStats.classList.remove('hidden');

    if (!s || s.n === 0) {
      colStats.innerHTML =
        `<span class="text-slate-400">"${escapeHtml(col)}" has no numeric ` +
        `values (${s ? s.missing : 0} missing).</span>`;
      return;
    }

    const fmt = (x) => (Number.isInteger(x) ? x : x.toPrecision(5));
    const cell = (label, value) =>
      `<div class="px-2"><span class="block text-[10px] uppercase tracking-wider text-slate-400">${label}</span>
       <span class="font-mono font-semibold">${value}</span></div>`;

    colStats.innerHTML =
      cell('n', s.n) + cell('missing', s.missing) + cell('mean', fmt(s.mean)) +
      cell('median', fmt(s.median)) + cell('std (σ)', fmt(s.std)) +
      cell('min', fmt(s.min)) + cell('max', fmt(s.max));
  }

  // --- 5. Operations (delegated to the core) ---
  if (applyBtn) applyBtn.addEventListener('click', () => {
    const target = colSelect.value;
    const operator = opSelect.value;
    const cols = target === 'all' ? headers : [target];

    switch (operator) {
      case 'drop_na': {
        const r = dropMissing(currentData, cols);
        currentData = r.rows;
        showToast(`Removed ${r.removed} rows with missing values.`, 'success');
        break;
      }
      case 'dedupe': {
        const r = deduplicate(currentData, headers);
        currentData = r.rows;
        showToast(`Removed ${r.removed} duplicate rows.`, 'success');
        break;
      }
      case 'fill_zero': {
        const r = fillMissing(currentData, cols, 0);
        currentData = r.rows;
        showToast(`Filled ${r.filled} missing cells with 0.`, 'success');
        break;
      }
      case 'trim': {
        const r = trimWhitespace(currentData, cols);
        currentData = r.rows;
        showToast(`Trimmed ${r.changed} cells.`, 'success');
        break;
      }
      case 'upper':
      case 'lower':
      case 'title': {
        const r = changeCase(currentData, cols, operator);
        currentData = r.rows;
        showToast(`Changed case in ${r.changed} cells.`, 'success');
        break;
      }
      case 'sort_asc':
      case 'sort_desc': {
        if (target === 'all') {
          showToast('Choose a single column to sort by.', 'error');
          return;
        }
        currentData = sortByColumn(currentData, target,
          { descending: operator === 'sort_desc' });
        showToast(`Sorted by "${target}".`, 'success');
        break;
      }
      case 'log10':
      case 'ln':
      case 'abs':
      case 'minmax':
      case 'zscore': {
        const r = transformColumn(currentData, cols, operator);
        currentData = r.rows;
        if (r.transformed === 0) {
          showToast('No numeric data found in the selected column(s).', 'error');
        } else if (r.skipped > 0) {
          showToast(
            `Transformed ${r.transformed} values; skipped ${r.skipped} ` +
            `non-positive value(s), which have no logarithm.`,
            'info'
          );
        } else {
          showToast('Transformation applied.', 'success');
        }
        break;
      }
      default:
        showToast('Unknown operation.', 'error');
        return;
    }

    renderTable();
    renderColStats();
    updateMeta();
  });

  if (resetBtn) resetBtn.addEventListener('click', () => {
    currentData = rawData.map(r => ({ ...r }));
    renderTable();
    renderColStats();
    updateMeta();
    showToast('Restored dataset to the original upload.', 'info');
  });

  // --- 6. Table ---
  function renderTable() {
    const thead = document.getElementById('tableHead');
    const tbody = document.getElementById('tableBody');
    if (!thead || !tbody) return;

    thead.innerHTML = '<tr>' + headers.map(h =>
      `<th class="px-4 py-3 font-semibold text-slate-700 dark:text-slate-300 border-r border-slate-200 dark:border-slate-700 last:border-0">${escapeHtml(h)}</th>`
    ).join('') + '</tr>';

    const limit = Math.min(currentData.length, 200);
    const rows = [];
    for (let i = 0; i < limit; i++) {
      const row = currentData[i];
      const cells = headers.map(h => {
        let v = row[h];
        if (typeof v === 'number' && !Number.isInteger(v)) v = v.toFixed(4);
        const display = (v !== null && v !== undefined && v !== '')
          ? escapeHtml(String(v))
          : '<span class="text-slate-300 dark:text-slate-600">, </span>';
        return `<td class="px-4 py-2 text-slate-600 dark:text-slate-400 border-r border-slate-100 dark:border-slate-800/50 last:border-0">${display}</td>`;
      }).join('');
      rows.push(`<tr>${cells}</tr>`);
    }
    tbody.innerHTML = rows.join('');
  }

  // --- 7. Export ---
  if (exportBtn) exportBtn.addEventListener('click', () => {
    if (currentData.length === 0) {
      showToast('Nothing to export.', 'error');
      return;
    }
    const csv = toCSV(currentData, { fields: headers });
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'cleaned_dataset.csv';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    showToast('Cleaned dataset downloaded.', 'success');
  });

  // --- 8. Utilities ---
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function showToast(msg, type) {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    const colors = type === 'success'
      ? 'bg-emerald-50 text-emerald-800 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-400'
      : type === 'error'
        ? 'bg-red-50 text-red-800 border-red-200 dark:bg-red-900/30 dark:text-red-400'
        : 'bg-indigo-50 text-indigo-800 border-indigo-200 dark:bg-indigo-900/30 dark:text-indigo-400';
    toast.className =
      `px-4 py-3 rounded-xl border shadow-lg toast-enter text-sm font-medium transition-all ${colors}`;
    toast.innerText = msg;
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }
});
