document.addEventListener("DOMContentLoaded", () => {
    
    // --- 1. State management ---
    let rawData = [];
    let currentData = [];
    let headers = [];

    // --- 2. Interface bindings ---
    const uploadZone = document.getElementById('uploadZone');
    const fileInput = document.getElementById('fileInput');
    const workspace = document.getElementById('workspace');
    
    const themeToggle = document.getElementById('themeToggle');
    themeToggle.addEventListener('click', () => {
        document.documentElement.classList.toggle('dark');
        localStorage.theme = document.documentElement.classList.contains('dark') ? 'dark' : 'light';
    });

    // Binding file drop matrices
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

    // --- 3. Data ingestion pipeline ---
    function handleFile(file) {
        if (!file || !file.name.endsWith('.csv')) {
            showToast('Validation failed. Requires .csv payload.', 'error');
            return;
        }

        document.getElementById('fileName').innerText = file.name;
        
        // Initializing PapaParse to handle large text blobs in chunks
        Papa.parse(file, {
            header: true,
            dynamicTyping: true, 
            skipEmptyLines: true,
            complete: function(results) {
                if (results.errors.length > 0 && results.data.length === 0) {
                    showToast('Fatal error parsing CSV structure.', 'error');
                    return;
                }
                
                // Caching initial state for potential reversion
                rawData = JSON.parse(JSON.stringify(results.data)); 
                currentData = JSON.parse(JSON.stringify(results.data));
                headers = results.meta.fields;
                
                populateColumnSelector();
                renderArrayView();
                
                uploadZone.classList.add('hidden');
                workspace.classList.remove('hidden');
                showToast('Data arrays loaded into memory.', 'success');
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
        thead.innerHTML = '<tr>' + headers.map(h => `<th class="px-4 py-3 font-semibold text-slate-700 dark:text-slate-300 border-r border-slate-200 dark:border-slate-700 last:border-0">${h}</th>`).join('') + '</tr>';
        
        const tbody = document.getElementById('tableBody');
        
        // Limiting view render to 100 rows to preserve UI thread performance
        const previewData = currentData.slice(0, 100);
        
        tbody.innerHTML = previewData.map(row => {
            return '<tr>' + headers.map(h => {
                let val = row[h];
                if (typeof val === 'number' && !Number.isInteger(val)) val = val.toFixed(4);
                return `<td class="px-4 py-2 text-slate-600 dark:text-slate-400 border-r border-slate-100 dark:border-slate-800/50 last:border-0">${val !== null && val !== undefined ? val : '<span class="text-red-500 font-bold italic">NaN</span>'}</td>`;
            }).join('') + '</tr>';
        }).join('');
    }

    // --- 5. Mathematical transformation logic ---
    document.getElementById('applyBtn').addEventListener('click', () => {
        const targetCol = document.getElementById('colSelect').value;
        const operator = document.getElementById('opSelect').value;
        
        const colsToProcess = targetCol === 'all' ? headers : [targetCol];
        let rowsRemoved = 0;

        try {
            if (operator === 'drop_na') {
                const initialLength = currentData.length;
                currentData = currentData.filter(row => {
                    return colsToProcess.every(c => row[c] !== null && row[c] !== undefined && row[c] !== '');
                });
                rowsRemoved = initialLength - currentData.length;
                showToast(`Scrubbed ${rowsRemoved} corrupted rows.`, 'success');
            } else {
                colsToProcess.forEach(colKey => {
                    // I am isolating purely numeric arrays to prevent type coercion faults
                    const vector = currentData.map(row => row[colKey]).filter(v => typeof v === 'number');
                    if (vector.length === 0) return;

                    let min, max, mean, stdDev;

                    // Pre-computing distribution constants for bulk array operations
                    if (operator === 'minmax') {
                        min = Math.min(...vector);
                        max = Math.max(...vector);
                    } else if (operator === 'zscore') {
                        mean = vector.reduce((a, b) => a + b, 0) / vector.length;
                        const variance = vector.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / vector.length;
                        stdDev = Math.sqrt(variance);
                    }

                    // Mutating the data state
                    currentData.forEach(row => {
                        let val = row[colKey];
                        if (typeof val !== 'number') return;
                        
                        if (operator === 'log10' && val > 0) row[colKey] = Math.log10(val);
                        else if (operator === 'ln' && val > 0) row[colKey] = Math.log(val);
                        else if (operator === 'abs') row[colKey] = Math.abs(val);
                        else if (operator === 'minmax' && max !== min) row[colKey] = (val - min) / (max - min);
                        else if (operator === 'zscore' && stdDev !== 0) row[colKey] = (val - mean) / stdDev;
                    });
                });
                showToast(`Mathematical sequence executed.`, 'success');
            }
            renderArrayView();
        } catch (err) {
            console.error(err);
            showToast('Computational fault during transformation.', 'error');
        }
    });

    // --- 6. Data state reversion ---
    document.getElementById('resetDataBtn').addEventListener('click', () => {
        currentData = JSON.parse(JSON.stringify(rawData));
        renderArrayView();
        showToast('Restored arrays to original upload state.', 'info');
    });

    // --- 7. Client-side compilation and export ---
    document.getElementById('exportBtn').addEventListener('click', () => {
        if (currentData.length === 0) return;
        
        const csvString = Papa.unparse(currentData);
        const blob = new Blob([csvString], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        
        const downloadAnchor = document.createElement("a");
        downloadAnchor.setAttribute("href", url);
        downloadAnchor.setAttribute("download", "cleaned_dataset.csv");
        document.body.appendChild(downloadAnchor);
        downloadAnchor.click();
        document.body.removeChild(downloadAnchor);
        
        showToast('Processed dataset extracted to disk.', 'success');
    });

    // --- 8. Notification matrix ---
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