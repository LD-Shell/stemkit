document.addEventListener("DOMContentLoaded", () => {
    
    // # --- 1. State initialization ---
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
    
    const scanBtn = document.getElementById('scanBtn');
    const exportCleanBtn = document.getElementById('exportCleanBtn');
    const exportFlaggedBtn = document.getElementById('exportFlaggedBtn');

    document.querySelectorAll('.themeToggle').forEach(btn => btn.addEventListener('click', () => {
        document.documentElement.classList.toggle('dark');
        localStorage.theme = document.documentElement.classList.contains('dark') ? 'dark' : 'light';
    });

    // # Binding drag and drop events
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        uploadZone.addEventListener(eventName, (e) => { e.preventDefault(); e.stopPropagation(); }, false);
    });

    uploadZone.addEventListener('dragover', () => uploadZone.classList.add('border-indigo-500'));
    uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('border-indigo-500'));
    
    uploadZone.addEventListener('drop', (e) => {
        uploadZone.classList.remove('border-indigo-500');
        if (e.dataTransfer.files.length) {
            handleFile(e.dataTransfer.files[0]);
        }
    });

    uploadZone.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (e) => {
        if (e.target.files.length) {
            handleFile(e.target.files[0]);
        }
    });

    // # --- 3. Dynamic parameter text ---
    thresholdSlider.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value).toFixed(1);
        thresholdValue.innerText = val;
        updateMethodHint(methodSelect.value, val);
    });

    methodSelect.addEventListener('change', (e) => {
        const method = e.target.value;
        if (method === 'zscore') {
            thresholdSlider.min = 1;
            thresholdSlider.max = 5;
            thresholdSlider.value = 3;
            thresholdValue.innerText = '3.0';
        } else {
            thresholdSlider.min = 0.5;
            thresholdSlider.max = 3;
            thresholdSlider.value = 1.5;
            thresholdValue.innerText = '1.5';
        }
        updateMethodHint(method, thresholdSlider.value);
    });

    function updateMethodHint(method, threshold) {
        if (method === 'zscore') {
            methodHint.innerText = `Flags values where the absolute Z-Score is greater than ${threshold}. Best for normally distributed data.`;
        } else {
            methodHint.innerText = `Flags values outside Q1 - (${threshold} * IQR) and Q3 + (${threshold} * IQR). Best for skewed distributions.`;
        }
    }

    // # --- 4. Data parsing ---
    function handleFile(file) {
        if (!file || !file.name.endsWith('.csv')) {
            showToast('Please upload a valid .csv topology.', 'error');
            return;
        }

        document.getElementById('fileName').innerText = file.name;
        
        Papa.parse(file, {
            header: true,
            dynamicTyping: true, 
            skipEmptyLines: true,
            complete: function(results) {
                if (results.errors.length > 0 && results.data.length === 0) {
                    showToast('Fatal error parsing CSV structure.', 'error');
                    return;
                }
                
                rawData = results.data;
                headers = results.meta.fields;
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

    function populateColumnSelector() {
        colSelect.innerHTML = '';
        headers.forEach(header => {
            const opt = document.createElement('option');
            opt.value = header;
            opt.innerText = header;
            colSelect.appendChild(opt);
        });
    }

    // # --- 5. Anomaly detection logic ---
    scanBtn.addEventListener('click', () => {
        const targetCol = colSelect.value;
        const method = methodSelect.value;
        const threshold = parseFloat(thresholdSlider.value);
        
        outlierIndices.clear();

        // # I am isolating the numeric vector to prevent coercion faults during variance calculations
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
            showToast('Insufficient valid numeric data to compute variance.', 'error');
            return;
        }

        if (method === 'zscore') {
            // # I am calculating parametric statistics for normal distributions
            const mean = jStat.mean(numericVector);
            const stdev = jStat.stdev(numericVector, true); 

            numericVector.forEach((val, i) => {
                const z = Math.abs((val - mean) / stdev);
                if (z > threshold) {
                    outlierIndices.add(indexMap[i]);
                }
            });
        } else if (method === 'iqr') {
            // # I am calculating the interquartile range to establish non-parametric fences
            const quartiles = jStat.quartiles(numericVector);
            const q1 = quartiles[0];
            const q3 = quartiles[2];
            const iqr = q3 - q1;
            
            const lowerBound = q1 - (threshold * iqr);
            const upperBound = q3 + (threshold * iqr);

            numericVector.forEach((val, i) => {
                if (val < lowerBound || val > upperBound) {
                    outlierIndices.add(indexMap[i]);
                }
            });
        }

        outlierCountEl.innerText = outlierIndices.size;
        renderArrayView();
        
        if (outlierIndices.size > 0) {
            exportCleanBtn.disabled = false;
            exportFlaggedBtn.disabled = false;
            showToast(`${outlierIndices.size} anomalies isolated.`, 'success');
        } else {
            exportCleanBtn.disabled = true;
            exportFlaggedBtn.disabled = true;
            showToast('No statistical outliers detected under current parameters.', 'info');
        }
    });

    // # --- 6. View construction ---
    function renderArrayView() {
        const thead = document.getElementById('tableHead');
        thead.innerHTML = '<tr>' + headers.map(h => `<th class="px-4 py-3 font-semibold text-slate-700 dark:text-slate-300 border-r border-slate-200 dark:border-slate-700 last:border-0">${h}</th>`).join('') + '</tr>';
        
        const tbody = document.getElementById('tableBody');
        
        // # I am limiting the view to 200 rows to ensure UI rendering does not lock the main thread
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
                tdHtml += `<td class="px-4 py-2 ${textClass} border-r border-slate-100 dark:border-slate-800/50 last:border-0">${val !== null && val !== undefined ? val : 'NaN'}</td>`;
            });
            
            rowsHtml += `<tr class="${rowClass}">${tdHtml}</tr>`;
        }
        
        tbody.innerHTML = rowsHtml;
    }

    // # --- 7. Output compilation ---
    exportCleanBtn.addEventListener('click', () => {
        const cleanData = rawData.filter((_, i) => !outlierIndices.has(i));
        triggerDownload(cleanData, 'scrubbed_dataset.csv');
    });

    exportFlaggedBtn.addEventListener('click', () => {
        const flaggedData = rawData.filter((_, i) => outlierIndices.has(i));
        triggerDownload(flaggedData, 'isolated_anomalies.csv');
    });

    function triggerDownload(dataArray, filename) {
        if (dataArray.length === 0) return;
        const csvString = Papa.unparse(dataArray);
        const blob = new Blob([csvString], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.setAttribute("href", url);
        link.setAttribute("download", filename);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        showToast(`Exported ${filename}`, 'success');
    }

    // # --- 8. Notification utility ---
    function showToast(msg, type) {
        const container = document.getElementById('toastContainer');
        const toast = document.createElement('div');
        
        const colors = type === 'success' ? 'bg-emerald-50 text-emerald-800 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-400' : 
                       type === 'error' ? 'bg-red-50 text-red-800 border-red-200 dark:bg-red-900/30 dark:text-red-400' : 
                       'bg-indigo-50 text-indigo-800 border-indigo-200 dark:bg-indigo-900/30 dark:text-indigo-400';
        
        toast.className = `px-4 py-3 rounded-xl border shadow-lg toast-enter text-sm font-medium transition-all ${colors}`;
        toast.innerHTML = `<i class="fa-solid ${type==='success' ? 'fa-check-circle' : type==='error' ? 'fa-triangle-exclamation' : 'fa-info-circle'} mr-2"></i> ${msg}`;
        
        container.appendChild(toast);
        setTimeout(() => {
            toast.style.opacity = '0';
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }
});