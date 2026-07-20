document.addEventListener("DOMContentLoaded", () => {

    // # --- 1. State and environment ---
    let computedResults = [];
    let currentLevel = 0.95;
    const dataInput     = document.getElementById('dataInput');
    const fileInput     = document.getElementById('fileInput');
    const hasHeaders    = document.getElementById('hasHeaders');
    const calculateBtn  = document.getElementById('calculateBtn');
    const resultsBody    = document.getElementById('resultsBody');
    const exportCsvBtn  = document.getElementById('exportCsvBtn');
    const theoryContainer = document.getElementById('theoryContainer');
    const ciLevelSelect = document.getElementById('ciLevel');   // optional
    const exampleBtn    = document.getElementById('exampleBtn'); // optional
    const ciHeader      = document.getElementById('ciHeader');   // optional

    const EXAMPLE = "Label\tRep1\tRep2\tRep3\nControl\t4.5\t4.2\t4.8\nTreatment 1\t6.1\t6.5\t6.2\nTreatment 2\t8.3\t8.1\t8.9";

    // Render the reference equations (KaTeX) for methodological transparency
    const renderTheory = () => {
        const latex = `
            \\text{Mean: } \\bar{x} = \\frac{1}{n}\\sum x_i \\quad
            \\text{SD: } s = \\sqrt{\\frac{\\sum(x_i - \\bar{x})^2}{n-1}} \\\\[4pt]
            \\text{SEM: } SE = \\frac{s}{\\sqrt{n}} \\quad
            \\text{CI: } \\bar{x} \\pm t^{*}_{\\,\\alpha/2,\\,n-1}\\cdot SE
        `;
        if (typeof katex !== 'undefined' && theoryContainer) {
            katex.render(latex, theoryContainer, { displayMode: true, throwOnError: false });
        }
    };
    renderTheory();

    // # --- 2. Data ingestion ---
    if (fileInput) {
        fileInput.onchange = (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (ev) => { dataInput.value = ev.target.result; };
            reader.readAsText(file);
        };
    }
    if (exampleBtn) {
        exampleBtn.addEventListener('click', () => { dataInput.value = EXAMPLE; calculate(); });
    }
    if (ciLevelSelect) {
        ciLevelSelect.addEventListener('change', () => {
            currentLevel = parseFloat(ciLevelSelect.value) || 0.95;
            if (ciHeader) ciHeader.textContent = `${Math.round(currentLevel * 100)}% CI (±)`;
            if (computedResults.length) calculate(); // recompute with new level
        });
    }

    // # --- 3. Statistical processing ---
    function calculate() {
        const rawText = dataInput.value.trim();
        if (!rawText) return showToast("No data detected.", "error");

        const parsed = Papa.parse(rawText, {
            header: hasHeaders.checked,
            dynamicTyping: true,
            skipEmptyLines: true
        });

        const data = parsed.data;
        if (!data || data.length === 0) return showToast("Could not parse any rows.", "error");

        const fields = parsed.meta.fields || Object.keys(data[0]);
        if (!fields || fields.length < 2) {
            return showToast("Need a label column plus at least one value column.", "error");
        }
        const keyField = fields[0];

        // Pool the replicate values for each group label
        const groupMap = new Map();
        data.forEach(row => {
            const groupKey = row[keyField];
            if (groupKey === null || groupKey === undefined || groupKey === "") return;
            const values = fields.slice(1)
                .map(f => row[f])
                .filter(v => typeof v === 'number' && !isNaN(v));
            if (!groupMap.has(groupKey)) groupMap.set(groupKey, []);
            groupMap.set(groupKey, groupMap.get(groupKey).concat(values));
        });

        const level = currentLevel;
        const p = 1 - (1 - level) / 2; // upper tail prob, e.g. 0.975 for 95%

        computedResults = [];
        groupMap.forEach((vals, key) => {
            if (vals.length === 0) return;
            const n = vals.length;
            const mean = jStat.mean(vals);
            const sd = n > 1 ? jStat.stdev(vals, true) : 0;      // sample SD (n-1)
            const sem = n > 0 ? sd / Math.sqrt(n) : 0;
            const tStar = n > 1 ? jStat.studentt.inv(p, n - 1) : 0;
            const ci = tStar * sem;
            computedResults.push({ key, n, mean, sd, sem, t: tStar, ci, level });
        });

        if (computedResults.length === 0) {
            resultsBody.innerHTML = `<tr><td colspan="7" class="px-4 py-16 text-center text-slate-400">No numeric groups found. Check that the first column holds labels and the rest hold numbers.</td></tr>`;
            exportCsvBtn.disabled = true;
            return;
        }

        renderTable();
        showToast(`Computed statistics for ${computedResults.length} group${computedResults.length > 1 ? "s" : ""}.`, "success");
    }

    calculateBtn.onclick = calculate;

    // # --- 4. Rendering ---
    function renderTable() {
        const pct = Math.round(currentLevel * 100);
        resultsBody.innerHTML = computedResults.map(r => `
            <tr class="hover:bg-slate-50 dark:hover:bg-slate-900/50 transition-colors">
                <td class="px-4 py-3 font-bold text-indigo-600 dark:text-indigo-400 border-r border-slate-100 dark:border-slate-800">${escapeHtml(String(r.key))}</td>
                <td class="px-4 py-3 text-center">${r.n}</td>
                <td class="px-4 py-3 font-mono">${r.mean.toFixed(4)}</td>
                <td class="px-4 py-3 font-mono text-slate-500">${r.sd.toFixed(4)}</td>
                <td class="px-4 py-3 font-mono text-slate-500">${r.sem.toFixed(4)}</td>
                <td class="px-4 py-3 font-mono text-slate-500" title="Student's t critical value, df = n-1">${r.n > 1 ? r.t.toFixed(3) : '—'}</td>
                <td class="px-4 py-3 font-mono font-bold text-emerald-600 dark:text-emerald-400">${r.ci.toFixed(4)}</td>
            </tr>
        `).join('');
        if (ciHeader) ciHeader.textContent = `${pct}% CI (±)`;
        exportCsvBtn.disabled = false;
    }

    // # --- 5. Export ---
    exportCsvBtn.onclick = () => {
        if (!computedResults.length) return;
        const rows = computedResults.map(r => ({
            label: r.key, n: r.n,
            mean: r.mean, sd: r.sd, sem: r.sem,
            t_critical: r.t, ci_level: r.level, ci_half_width: r.ci,
            ci_lower: r.mean - r.ci, ci_upper: r.mean + r.ci
        }));
        const csv = Papa.unparse(rows);
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = "error_analysis_results.csv";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        showToast("Results exported to CSV.", "success");
    };

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, c =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function showToast(msg, type) {
        const toast = document.createElement('div');
        const colors = type === 'success' ? 'bg-emerald-50 text-emerald-800 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-400'
                     : type === 'error'   ? 'bg-red-50 text-red-800 border-red-200 dark:bg-red-900/30 dark:text-red-400'
                     :                      'bg-indigo-50 text-indigo-800 border-indigo-200 dark:bg-indigo-900/30 dark:text-indigo-400';
        toast.className = `px-4 py-3 rounded-xl border shadow-lg toast-enter text-sm font-medium transition-all ${colors}`;
        toast.innerText = msg;
        document.getElementById('toastContainer').appendChild(toast);
        setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 300); }, 3000);
    }
});
