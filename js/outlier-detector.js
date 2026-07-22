document.addEventListener("DOMContentLoaded", () => {

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
    const exampleBtn = document.getElementById('exampleBtn'); // optional

    const scanBtn = document.getElementById('scanBtn');
    const exportCleanBtn = document.getElementById('exportCleanBtn');
    const exportFlaggedBtn = document.getElementById('exportFlaggedBtn');

    // NOTE: dark-mode toggling is handled by the shared inline script in the page.
    // (A duplicate handler was removed from here — it double-bound the toggle and
    //  was also syntactically broken, which stopped this whole script from loading.)

    // # Drag and drop
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        uploadZone.addEventListener(eventName, (e) => { e.preventDefault(); e.stopPropagation(); }, false);
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

    // # --- 3. Threshold / method parameter text ---
    const METHOD_DEFAULTS = {
        zscore:    { min: 1,   max: 5, step: 0.1, value: 3   },
        iqr:       { min: 0.5, max: 3, step: 0.1, value: 1.5 },
        modzscore: { min: 2,   max: 6, step: 0.1, value: 3.5 },
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
            methodHint.innerText = `Flags values where the absolute Z-Score exceeds ${threshold}. Assumes roughly normal data.`;
        } else if (method === 'modzscore') {
            methodHint.innerText = `Flags values where the modified Z-Score (median/MAD based) exceeds ${threshold}. Robust to existing outliers; 3.5 is the Iglewicz–Hoaglin default.`;
        } else {
            methodHint.innerText = `Flags values outside Q1 − ${threshold}×IQR and Q3 + ${threshold}×IQR (Tukey fences). Good for skewed data.`;
        }
    }

    // # --- 4. Data parsing ---
    function handleFile(file) {
        const name = (file && file.name || '').toLowerCase();
        if (!file || !/\.(csv|tsv|txt)$/.test(name)) {
            showToast('Please choose a .csv, .tsv or .txt file.', 'error');
            return;
        }
        document.getElementById('fileName').innerText = file.name;

        Papa.parse(file, {
            header: true,
            dynamicTyping: true,
            skipEmptyLines: true,
            delimiter: "",
            complete: function (results) {
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
                document.getElementById('dataMeta').innerText = `${rawData.length} Rows • ${headers.length} Columns`;
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
        document.getElementById('dataMeta').innerText = `${rawData.length} Rows • ${headers.length} Columns`;
        showToast('Example dataset loaded — try a scan.', 'info');
    }
    if (exampleBtn) exampleBtn.addEventListener('click', loadExample);

    function populateColumnSelector() {
        colSelect.innerHTML = '';
        headers.forEach(header => {
            const opt = document.createElement('option');
            opt.value = header;
            opt.innerText = header;
            colSelect.appendChild(opt);
        });
    }

    // # --- 5. Statistics helpers ---
    function median(sortedAsc) {
        const n = sortedAsc.length;
        if (n === 0) return NaN;
        return n % 2 ? sortedAsc[(n - 1) / 2] : (sortedAsc[n / 2 - 1] + sortedAsc[n / 2]) / 2;
    }

    // # --- 6. Detection ---
    scanBtn.addEventListener('click', () => {
        const targetCol = colSelect.value;
        const method = methodSelect.value;
        const threshold = parseFloat(thresholdSlider.value);
        outlierIndices.clear();

        const numericVector = [];
        const indexMap = [];
        rawData.forEach((row, i) => {
            const val = row[targetCol];
            if (typeof val === 'number' && !isNaN(val)) {
                numericVector.push(val);
                indexMap.push(i);
            }
        });

        if (numericVector.length < 4) {
            showToast('Need at least 4 numeric values in the selected column.', 'error');
            return;
        }

        if (method === 'zscore') {
            const mean = jStat.mean(numericVector);
            const stdev = jStat.stdev(numericVector, true); // sample SD
            if (stdev === 0) { showToast('Standard deviation is zero — no spread to flag.', 'info'); }
            numericVector.forEach((val, i) => {
                const z = stdev ? Math.abs((val - mean) / stdev) : 0;
                if (z > threshold) outlierIndices.add(indexMap[i]);
            });

        } else if (method === 'modzscore') {
            // Iglewicz–Hoaglin modified Z-score: robust, median/MAD based
            const sorted = [...numericVector].sort((a, b) => a - b);
            const med = median(sorted);
            const absDev = numericVector.map(v => Math.abs(v - med));
            const mad = median([...absDev].sort((a, b) => a - b));
            let scoreOf;
            if (mad > 0) {
                scoreOf = v => 0.6745 * (v - med) / mad;
            } else {
                // Fallback when >50% of values are identical: use mean absolute deviation
                const meanAD = absDev.reduce((a, b) => a + b, 0) / absDev.length;
                scoreOf = v => meanAD ? (v - med) / (1.253314 * meanAD) : 0;
            }
            numericVector.forEach((val, i) => {
                if (Math.abs(scoreOf(val)) > threshold) outlierIndices.add(indexMap[i]);
            });

        } else { // iqr
            const q = jStat.quartiles(numericVector);
            const iqr = q[2] - q[0];
            const lower = q[0] - threshold * iqr;
            const upper = q[2] + threshold * iqr;
            numericVector.forEach((val, i) => {
                if (val < lower || val > upper) outlierIndices.add(indexMap[i]);
            });
        }

        outlierCountEl.innerText = outlierIndices.size;
        renderArrayView();

        const has = outlierIndices.size > 0;
        exportCleanBtn.disabled = !has;
        exportFlaggedBtn.disabled = !has;
        if (has) showToast(`${outlierIndices.size} outlier${outlierIndices.size > 1 ? 's' : ''} flagged.`, 'success');
        else showToast('No outliers detected with the current settings.', 'info');
    });

    // # --- 7. Table view ---
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
            const rowClass = isOutlier ? 'outlier-row' : '';
            let tdHtml = '';
            headers.forEach(h => {
                let val = row[h];
                if (typeof val === 'number' && !Number.isInteger(val)) val = val.toFixed(4);
                const textClass = isOutlier ? 'text-red-700 dark:text-red-400 font-bold' : 'text-slate-600 dark:text-slate-400';
                const display = (val !== null && val !== undefined) ? escapeHtml(String(val)) : 'NaN';
                tdHtml += `<td class="px-4 py-2 ${textClass} border-r border-slate-100 dark:border-slate-800/50 last:border-0">${display}</td>`;
            });
            rowsHtml += `<tr class="${rowClass}">${tdHtml}</tr>`;
        }
        tbody.innerHTML = rowsHtml;
    }

    // # --- 8. Export ---
    exportCleanBtn.addEventListener('click', () => {
        triggerDownload(rawData.filter((_, i) => !outlierIndices.has(i)), 'scrubbed_dataset.csv');
    });
    exportFlaggedBtn.addEventListener('click', () => {
        triggerDownload(rawData.filter((_, i) => outlierIndices.has(i)), 'isolated_anomalies.csv');
    });

    function triggerDownload(dataArray, filename) {
        if (!dataArray.length) return;
        const csvString = Papa.unparse(dataArray);
        const blob = new Blob([csvString], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.setAttribute("href", url);
        link.setAttribute("download", filename);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
        showToast(`Exported ${filename}`, 'success');
    }

    // # --- 9. Toasts ---
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
