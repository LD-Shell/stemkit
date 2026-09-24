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

// A small file with the problems the tool is for: two gaps, a repeated row,
// and a concentration column spanning four orders of magnitude (try log10).
const SAMPLE_NAME = 'sample_measurements.csv';
const SAMPLE_CSV = [
  'sample,temperature_K,yield_pct,concentration_mM,operator',
  'S01,298,45.2,0.12,ana',
  'S02,303,47.9,0.35,ben',
  'S03,308,,1.10,ana',
  'S04,313,53.1,3.40,carl',
  'S05,318,55.8,,ben',
  'S02,303,47.9,0.35,ben',
  'S06,323,58.2,10.5,ana',
  'S07,328,61.0,32.0,carl',
  'S08,333,63.7,98.0,ben',
  'S09,338,66.4,310,ana',
  'S10,343,68.9,950,carl'
].join('\n');

const PREVIEW_ROWS = 200;

document.addEventListener('DOMContentLoaded', () => {

  // --- 1. State ---
  let rawData = [];
  let currentData = [];
  let headers = [];
  let changes = [];

  // --- 2. Bindings ---
  const uploadZone = document.getElementById('uploadZone');
  const fileInput = document.getElementById('fileInput');
  const chooseFileBtn = document.getElementById('chooseFileBtn');
  const loadSampleBtn = document.getElementById('loadSampleBtn');
  const changeFileBtn = document.getElementById('changeFileBtn');
  const workspace = document.getElementById('workspace');
  const colStats = document.getElementById('colStats');
  const colSelect = document.getElementById('colSelect');
  const opSelect = document.getElementById('opSelect');
  const applyBtn = document.getElementById('applyBtn');
  const resetBtn = document.getElementById('resetDataBtn');
  const exportBtn = document.getElementById('exportBtn');
  const exportNote = document.getElementById('exportNote');
  const dataMeta = document.getElementById('dataMeta');
  const changeLog = document.getElementById('changeLog');
  const changeLogEmpty = document.getElementById('changeLogEmpty');
  const previewNote = document.getElementById('previewNote');

  // The drop zone: drag a file on, click anywhere on it, or use its buttons.
  ['dragenter', 'dragover'].forEach(evt => uploadZone.addEventListener(evt, (e) => {
    e.preventDefault();
    uploadZone.classList.add('is-over');
  }));
  uploadZone.addEventListener('dragleave', (e) => {
    if (!uploadZone.contains(e.relatedTarget)) uploadZone.classList.remove('is-over');
  });
  uploadZone.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadZone.classList.remove('is-over');
    if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
  });
  uploadZone.addEventListener('click', (e) => {
    if (!e.target.closest('button')) fileInput.click();
  });
  chooseFileBtn.addEventListener('click', () => fileInput.click());
  loadSampleBtn.addEventListener('click', () => loadText(SAMPLE_CSV, SAMPLE_NAME));
  changeFileBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (e) => {
    if (e.target.files.length) handleFile(e.target.files[0]);
  });

  // --- 3. Ingestion ---
  function handleFile(file) {
    const name = ((file && file.name) || '').toLowerCase();
    if (!file || !/\.(csv|tsv|txt)$/.test(name)) {
      showToast('Choose a .csv, .tsv or .txt file.', 'error');
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => loadText(e.target.result, file.name);
    reader.onerror = () => showToast('Could not read that file.', 'error');
    reader.readAsText(file);
    fileInput.value = '';
  }

  function loadText(text, fileName) {
    const parsed = parseDelimited(text);
    if (parsed.rows.length === 0) {
      showToast('No rows could be read from that file.', 'error');
      return;
    }

    rawData = parsed.rows;
    currentData = parsed.rows.map(r => ({ ...r }));
    headers = parsed.fields;
    changes = [];

    document.getElementById('fileName').textContent = fileName;
    populateColumnSelector();
    renderTable();
    renderColStats();
    renderChanges();
    updateMeta();
    exportNote.textContent = '';

    uploadZone.classList.add('hidden');
    workspace.classList.remove('hidden');
    workspace.classList.add('flex');
  }

  function populateColumnSelector() {
    colSelect.innerHTML = '<option value="all">All columns</option>';
    for (const h of headers) {
      const opt = document.createElement('option');
      opt.value = h;
      opt.textContent = h;
      colSelect.appendChild(opt);
    }
  }

  const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;

  function updateMeta() {
    const p = profileData(currentData, headers);
    const parts = [plural(p.nRows, 'row'), plural(p.nColumns, 'column')];
    if (p.totalMissing) parts.push(plural(p.totalMissing, 'missing value'));
    if (p.duplicateRows) parts.push(plural(p.duplicateRows, 'duplicate row'));
    dataMeta.textContent = parts.join(', ');
  }

  // --- 4. Column statistics ---
  colSelect.addEventListener('change', renderColStats);

  function renderColStats() {
    const col = colSelect.value;
    if (!col || col === 'all') {
      colStats.innerHTML = '';
      colStats.classList.add('hidden');
      return;
    }

    const s = columnStats(currentData, col);
    colStats.classList.remove('hidden');

    if (!s || s.n === 0) {
      colStats.innerHTML =
        `<p class="dc-colstats-none">"${escapeHtml(col)}" has no numeric values ` +
        `(${s ? s.missing : 0} missing).</p>`;
      return;
    }

    const fmt = (x) => (Number.isInteger(x) ? x : x.toPrecision(5));
    const cell = (label, value) =>
      `<div><dt>${label}</dt><dd>${value}</dd></div>`;

    colStats.innerHTML =
      `<p class="dc-colstats-title">Statistics for "${escapeHtml(col)}"</p><dl>` +
      cell('n', s.n) + cell('Missing', s.missing) + cell('Mean', fmt(s.mean)) +
      cell('Median', fmt(s.median)) + cell('SD (σ)', fmt(s.std)) +
      cell('Min', fmt(s.min)) + cell('Max', fmt(s.max)) + '</dl>';
  }

  // --- 5. Operations (delegated to the core) ---
  applyBtn.addEventListener('click', () => {
    const target = colSelect.value;
    const operator = opSelect.value;
    const cols = target === 'all' ? headers : [target];
    const where = target === 'all' ? 'all columns' : `"${target}"`;
    let summary = '';
    let tone = 'success';

    switch (operator) {
      case 'drop_na': {
        const r = dropMissing(currentData, cols);
        currentData = r.rows;
        summary = `Dropped ${plural(r.removed, 'row')} with a missing value in ${where}.`;
        break;
      }
      case 'dedupe': {
        const r = deduplicate(currentData, headers);
        currentData = r.rows;
        summary = `Removed ${plural(r.removed, 'duplicate row')}.`;
        break;
      }
      case 'fill_zero': {
        const r = fillMissing(currentData, cols, 0);
        currentData = r.rows;
        summary = `Filled ${plural(r.filled, 'missing cell')} in ${where} with 0.`;
        break;
      }
      case 'trim': {
        const r = trimWhitespace(currentData, cols);
        currentData = r.rows;
        summary = `Trimmed spaces in ${plural(r.changed, 'cell')}.`;
        break;
      }
      case 'upper':
      case 'lower':
      case 'title': {
        const r = changeCase(currentData, cols, operator);
        currentData = r.rows;
        summary = `Changed the case of ${plural(r.changed, 'cell')}.`;
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
        summary = `Sorted by ${where}.`;
        break;
      }
      case 'log10':
      case 'ln':
      case 'abs':
      case 'minmax':
      case 'zscore': {
        const r = transformColumn(currentData, cols, operator);
        if (r.transformed === 0) {
          showToast(`No numeric values in ${where}.`, 'error');
          return;
        }
        currentData = r.rows;
        const label = opSelect.options[opSelect.selectedIndex].text;
        summary = `${label}: ${plural(r.transformed, 'value')} in ${where}`;
        if (r.skipped > 0) {
          summary += `; ${plural(r.skipped, 'value')} left as is (zero or negative, so no logarithm).`;
          tone = 'info';
        } else {
          summary += '.';
        }
        break;
      }
      default:
        showToast('Unknown operation.', 'error');
        return;
    }

    changes.push(summary);
    exportNote.textContent = '';
    showToast(summary, tone);
    renderTable();
    renderColStats();
    renderChanges();
    updateMeta();
  });

  resetBtn.addEventListener('click', () => {
    currentData = rawData.map(r => ({ ...r }));
    changes = [];
    exportNote.textContent = '';
    renderTable();
    renderColStats();
    renderChanges();
    updateMeta();
    showToast('Back to the file as it was loaded.', 'info');
  });

  function renderChanges() {
    changeLog.innerHTML = changes.map(c => `<li>${escapeHtml(c)}</li>`).join('');
    changeLogEmpty.classList.toggle('hidden', changes.length > 0);
    resetBtn.disabled = changes.length === 0;
  }

  // --- 6. Table ---
  function renderTable() {
    const thead = document.getElementById('tableHead');
    const tbody = document.getElementById('tableBody');

    thead.innerHTML = '<tr>' + headers.map(h =>
      `<th scope="col" class="px-4 py-3 font-semibold text-slate-700 dark:text-slate-300 border-r border-slate-200 dark:border-slate-700 last:border-0">${escapeHtml(h)}</th>`
    ).join('') + '</tr>';

    const limit = Math.min(currentData.length, PREVIEW_ROWS);
    const rows = [];
    for (let i = 0; i < limit; i++) {
      const row = currentData[i];
      const cells = headers.map(h => {
        let v = row[h];
        if (typeof v === 'number' && !Number.isInteger(v)) v = v.toFixed(4);
        const display = (v !== null && v !== undefined && v !== '')
          ? escapeHtml(String(v))
          : '<span class="dc-missing" title="Missing value">–</span>';
        return `<td class="px-4 py-2 text-slate-700 dark:text-slate-300 border-r border-slate-100 dark:border-slate-800/50 last:border-0">${display}</td>`;
      }).join('');
      rows.push(`<tr>${cells}</tr>`);
    }
    tbody.innerHTML = rows.join('');

    previewNote.textContent = currentData.length > limit
      ? `Showing the first ${limit} of ${currentData.length} rows. The download has them all.`
      : `All ${plural(currentData.length, 'row')}.`;
  }

  // --- 7. Export ---
  exportBtn.addEventListener('click', () => {
    if (currentData.length === 0) {
      showToast('There are no rows left to download.', 'error');
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
    exportNote.textContent =
      `Saved cleaned_dataset.csv: ${plural(currentData.length, 'row')}, ` +
      `${plural(changes.length, 'change')} applied.`;
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
      ? 'bg-emerald-50 text-emerald-800 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-300 dark:border-emerald-800'
      : type === 'error'
        ? 'bg-red-50 text-red-800 border-red-200 dark:bg-red-950 dark:text-red-300 dark:border-red-800'
        : 'bg-blue-50 text-blue-800 border-blue-200 dark:bg-slate-900 dark:text-blue-200 dark:border-blue-800';
    toast.className =
      `px-4 py-3 rounded-xl border shadow-lg toast-enter text-sm font-medium transition-all max-w-sm ${colors}`;
    toast.innerText = msg;
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 300);
    }, 3500);
  }
});
