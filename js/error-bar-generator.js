document.addEventListener("DOMContentLoaded", () => {
    
    // # --- 1. State and environment ---
    let computedResults = [];
    const dataInput = document.getElementById('dataInput');
    const fileInput = document.getElementById('fileInput');
    const hasHeaders = document.getElementById('hasHeaders');
    const calculateBtn = document.getElementById('calculateBtn');
    const resultsBody = document.getElementById('resultsBody');
    const exportCsvBtn = document.getElementById('exportCsvBtn');
    const theoryContainer = document.getElementById('theoryContainer');

    // Rendering KaTeX equations for methodological transparency
    const renderTheory = () => {
        const latex = `
            \\text{Mean: } \\bar{x} = \\frac{\\sum x_i}{n} \\quad 
            \\text{SD: } s = \\sqrt{\\frac{\\sum(x_i - \\bar{x})^2}{n-1}} \\\\ \\\\
            \\text{SEM: } SE = \\frac{s}{\\sqrt{n}} \\quad 
            \\text{95\\% CI: } \\bar{x} \\pm (t^* \\cdot SE)
        `;
        if (typeof katex !== 'undefined') {
            katex.render(latex, theoryContainer, { displayMode: true });
        }
    };
    renderTheory();

    // # --- 2. Data ingestion ---
    fileInput.onchange = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => { dataInput.value = ev.target.result; };
        reader.readAsText(file);
    };

    // # --- 3. Statistical processing ---
    calculateBtn.onclick = () => {
        const rawText = dataInput.value.trim();
        if (!rawText) return showToast("No data detected", "error");

        const groupMap = new Map();
        
        // Parsing CSV structure and converting types
        const parsed = Papa.parse(rawText, {
            header: hasHeaders.checked,
            dynamicTyping: true,
            skipEmptyLines: true
        });

        const data = parsed.data;
        const fields = parsed.meta.fields || Object.keys(data[0]);
        const keyField = fields[0]; 

        // I am grouping the raw replicates to construct accurate variance estimates
        data.forEach(row => {
            const groupKey = row[keyField];
            if (groupKey === null || groupKey === undefined) return;

            const values = fields.slice(1)
                .map(f => row[f])
                .filter(v => typeof v === 'number' && !isNaN(v));

            if (!groupMap.has(groupKey)) groupMap.set(groupKey, []);
            groupMap.set(groupKey, groupMap.get(groupKey).concat(values));
        });

        // Computing statistics per group
        computedResults = [];
        groupMap.forEach((vals, key) => {
            if (vals.length === 0) return;

            const n = vals.length;
            const mean = jStat.mean(vals);
            const sd = n > 1 ? jStat.stdev(vals, true) : 0;
            const sem = sd / Math.sqrt(n);
            
            // I am using the inverse Student's t-distribution for accurate 95% CI bounds
            const ci = n > 1 ? jStat.studentt.inv(0.975, n - 1) * sem : 0;

            computedResults.push({ key, n, mean, sd, sem, ci });
        });

        renderTable();
        showToast(`Calculated errors for ${computedResults.length} points.`, "success");
    };

    // # --- 4. User interface rendering ---
    function renderTable() {
        resultsBody.innerHTML = computedResults.map(r => `
            <tr class="hover:bg-slate-50 dark:hover:bg-slate-900/50 transition-colors">
                <td class="px-4 py-3 font-bold text-indigo-600 dark:text-indigo-400 border-r border-slate-100 dark:border-slate-800">${r.key}</td>
                <td class="px-4 py-3 text-center">${r.n}</td>
                <td class="px-4 py-3 font-mono">${r.mean.toFixed(4)}</td>
                <td class="px-4 py-3 font-mono text-slate-500">${r.sd.toFixed(4)}</td>
                <td class="px-4 py-3 font-mono text-slate-500">${r.sem.toFixed(4)}</td>
                <td class="px-4 py-3 font-mono font-bold text-emerald-600 dark:text-emerald-400">${r.ci.toFixed(4)}</td>
            </tr>
        `).join('');
        exportCsvBtn.disabled = false;
    }

    // # --- 5. Export utilities ---
    exportCsvBtn.onclick = () => {
        const csv = Papa.unparse(computedResults);
        const blob = new Blob([csv], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = "error_analysis_results.csv";
        a.click();
    };

    function showToast(msg, type) {
        const toast = document.createElement('div');
        toast.className = `px-4 py-3 rounded-xl border shadow-lg text-sm font-medium transition-all ${
            type === 'success' ? 'bg-emerald-50 text-emerald-800 border-emerald-200' : 'bg-red-50 text-red-800 border-red-200'
        }`;
        toast.innerText = msg;
        document.getElementById('toastContainer').appendChild(toast);
        setTimeout(() => toast.remove(), 3000);
    }
});