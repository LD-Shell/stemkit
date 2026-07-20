/*
 * STEMKit — CSV Data Cleaner & Column Transformer
 * Parsing via PapaParse. All processing happens in the browser (in RAM).
 * Author: Olanrewaju M. Daramola.
 *
 * Note on standardization: Z-Score uses the POPULATION standard deviation
 * (divide by N), matching scikit-learn's StandardScaler. Tools such as pandas
 * default to the SAMPLE standard deviation (divide by N-1); values will differ
 * slightly for small samples. This is documented on the page.
 */
document.addEventListener("DOMContentLoaded", () => {

    // --- 1. State ---
    let rawData = [];
    let currentData = [];
    let headers = [];

    // --- 2. Interface bindings ---
    const uploadZone = document.getElementById('uploadZone');
    const fileInput  = document.getElementById('fileInput');
    const workspace  = document.getElementById('workspace');
    const colStats   = document.getElementById('colStats'); // optional

    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(evt => {
        uploadZone.addEventListener(evt, (e) => { e.preventDefault(); e.stopPropagation(); }, false);
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

    // --- 3. Data ingestion ---
    function handleFile(file) {
        const name = (file && file.name || '').toLowerCase();
        const ok = /\.(csv|tsv|txt)$/.test(name);
        if (!file || !ok) {
            showToast('Please choose a .csv, .tsv or .txt file.', 'error');
            return;
        }
        document.getElementById('fileName').innerText = file.name;

        Papa.parse(file, {
            header: true,
            dynamicTyping: true,
            skipEmptyLines: true,
            delimiter: "",        // let PapaParse auto-detect comma vs tab
            complete: function (results) {
                if ((!results.data || results.data.length === 0)) {
                    showToast('No rows could be parsed from that file.', 'error');
                    return;
                }
                rawData     = JSON.parse(JSON.stringify(results.data));
                currentData = JSON.parse(JSON.stringify(results.data));
                headers     = (results.meta.fields || []).filter(h => h !== null && h !== undefined && h !== '');

                populateColumnSelector();
                renderArrayView();
                if (colStats) { colStats.innerHTML = ''; colStats.classList.add('hidden'); }

                uploadZone.classList.add('hidden');
                workspace.classList.remove('hidden');
                showToast('Dataset loaded into memory.', 'success');
            },
            error: function () {
                showToast('Fatal error reading the file.', 'error');
            }
        });
        fileInput.value = '';
    }

    // --- 4. View construction ---
    function populateColumnSelector() {
        const colSelect = document.getElementById('colSelect');
        colSelect.innerHTML = '<option value="all">-- All Numeric Columns --</option>';
        headers.forEach(header => {
            const opt = document.createElement('option');
            opt.value = header;
            opt.innerText = header;
            colSelect.appendChild(opt);
        });
    }

    function renderArrayView() {
        document.getElementById('dataMeta').innerText = `${currentData.length} Rows • ${headers.length} Columns`;

        const thead = document.getElementById('tableHead');
        thead.innerHTML = '<tr>' + headers.map(h =>
            `<th class="px-4 py-3 font-semibold text-slate-700 dark:text-slate-300 border-r border-slate-200 dark:border-slate-700 last:border-0">${escapeHtml(h)}</th>`
        ).join('') + '</tr>';

        const tbody = document.getElementById('tableBody');
        const previewData = currentData.slice(0, 100);

        tbody.innerHTML = previewData.map(row => {
            return '<tr>' + headers.map(h => {
                let val = row[h];
                if (typeof val === 'number' && !Number.isInteger(val)) val = val.toFixed(4);
                const isMissing = (val === null || val === undefined || val === '');
                return `<td class="px-4 py-2 text-slate-600 dark:text-slate-400 border-r border-slate-100 dark:border-slate-800/50 last:border-0">${
                    isMissing ? '<span class="text-red-500 font-bold italic">NaN</span>' : escapeHtml(String(val))
                }</td>`;
            }).join('') + '</tr>';
        }).join('');
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, c =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    // --- 5. Column statistics (shown when a single column is selected) ---
    function numericVector(colKey) {
        return currentData.map(r => r[colKey]).filter(v => typeof v === 'number' && isFinite(v));
    }
    function renderColStats() {
        if (!colStats) return;
        const colKey = document.getElementById('colSelect').value;
        if (colKey === 'all') { colStats.innerHTML = ''; colStats.classList.add('hidden'); return; }

        const vec = numericVector(colKey);
        const total = currentData.length;
        const missing = total - vec.length;

        if (vec.length === 0) {
            colStats.classList.remove('hidden');
        colStats.innerHTML = `<span class="text-slate-400">“${escapeHtml(colKey)}” has no numeric values (${missing} missing).</span>`;
            return;
        }
        const n = vec.length;
        const mean = vec.reduce((a, b) => a + b, 0) / n;
        const variance = vec.reduce((a, b) => a + (b - mean) ** 2, 0) / n; // population
        const std = Math.sqrt(variance);
        const sorted = [...vec].sort((a, b) => a - b);
        const median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
        const fmt = x => Number.isInteger(x) ? x : x.toPrecision(5);

        const cell = (label, value) =>
            `<div class="px-2"><span class="block text-[10px] uppercase tracking-wider text-slate-400">${label}</span>
             <span class="font-mono font-semibold">${value}</span></div>`;

        colStats.classList.remove('hidden');
        colStats.innerHTML =
            cell('n', n) + cell('missing', missing) + cell('mean', fmt(mean)) +
            cell('median', fmt(median)) + cell('std (σ)', fmt(std)) +
            cell('min', fmt(sorted[0])) + cell('max', fmt(sorted[n - 1]));
    }

    const colSelectEl = document.getElementById('colSelect');
    if (colSelectEl) colSelectEl.addEventListener('change', renderColStats);

    // --- 6. Transformations ---
    document.getElementById('applyBtn').addEventListener('click', () => {
        const targetCol = document.getElementById('colSelect').value;
        const operator  = document.getElementById('opSelect').value;
        const colsToProcess = targetCol === 'all' ? headers : [targetCol];

        try {
            if (operator === 'drop_na') {
                const initialLength = currentData.length;
                currentData = currentData.filter(row =>
                    colsToProcess.every(c => row[c] !== null && row[c] !== undefined && row[c] !== '')
                );
                showToast(`Removed ${initialLength - currentData.length} rows with missing values.`, 'success');

            } else if (operator === 'dedupe') {
                const initialLength = currentData.length;
                const seen = new Set();
                currentData = currentData.filter(row => {
                    const key = JSON.stringify(headers.map(h => row[h]));
                    if (seen.has(key)) return false;
                    seen.add(key);
                    return true;
                });
                showToast(`Removed ${initialLength - currentData.length} duplicate rows.`, 'success');

            } else {
                let touched = 0;
                colsToProcess.forEach(colKey => {
                    const vector = numericVector(colKey);
                    if (vector.length === 0) return;

                    let min, max, mean, stdDev;
                    if (operator === 'minmax') {
                        min = Math.min(...vector); max = Math.max(...vector);
                    } else if (operator === 'zscore') {
                        mean = vector.reduce((a, b) => a + b, 0) / vector.length;
                        const variance = vector.reduce((a, b) => a + (b - mean) ** 2, 0) / vector.length;
                        stdDev = Math.sqrt(variance);
                    }

                    currentData.forEach(row => {
                        let val = row[colKey];
                        if (typeof val !== 'number' || !isFinite(val)) return;

                        if (operator === 'log10') { if (val > 0) row[colKey] = Math.log10(val); }
                        else if (operator === 'ln') { if (val > 0) row[colKey] = Math.log(val); }
                        else if (operator === 'abs') { row[colKey] = Math.abs(val); }
                        else if (operator === 'minmax') { row[colKey] = (max === min) ? 0 : (val - min) / (max - min); }
                        else if (operator === 'zscore') { row[colKey] = (stdDev !== 0) ? (val - mean) / stdDev : 0; }
                    });
                    touched++;
                });
                if (touched === 0) showToast('No numeric data found in the selected column(s).', 'error');
                else showToast('Transformation applied.', 'success');
            }
            renderArrayView();
            renderColStats();
        } catch (err) {
            console.error(err);
            showToast('Error during transformation.', 'error');
        }
    });

    // --- 7. Reset ---
    document.getElementById('resetDataBtn').addEventListener('click', () => {
        currentData = JSON.parse(JSON.stringify(rawData));
        renderArrayView();
        renderColStats();
        showToast('Restored dataset to the original upload.', 'info');
    });

    // --- 8. Export ---
    document.getElementById('exportBtn').addEventListener('click', () => {
        if (currentData.length === 0) { showToast('Nothing to export.', 'error'); return; }
        const csvString = Papa.unparse(currentData);
        const blob = new Blob([csvString], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.setAttribute("href", url);
        a.setAttribute("download", "cleaned_dataset.csv");
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        showToast('Cleaned dataset downloaded.', 'success');
    });

    // --- 9. Toasts ---
    function showToast(msg, type) {
        const container = document.getElementById('toastContainer');
        const toast = document.createElement('div');
        const colors = type === 'success' ? 'bg-emerald-50 text-emerald-800 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-400' :
                       type === 'error'   ? 'bg-red-50 text-red-800 border-red-200 dark:bg-red-900/30 dark:text-red-400' :
                                            'bg-indigo-50 text-indigo-800 border-indigo-200 dark:bg-indigo-900/30 dark:text-indigo-400';
        toast.className = `px-4 py-3 rounded-xl border shadow-lg toast-enter text-sm font-medium transition-all ${colors}`;
        toast.innerHTML = `<i class="fa-solid ${type === 'success' ? 'fa-check-circle' : type === 'error' ? 'fa-triangle-exclamation' : 'fa-info-circle'} mr-2"></i> ${escapeHtml(msg)}`;
        container.appendChild(toast);
        setTimeout(() => {
            toast.style.opacity = '0';
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }
});
