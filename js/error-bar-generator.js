document.addEventListener("DOMContentLoaded", () => {

    /* ============================================================
       STEMKit Error Bar Generator
       - Descriptive stats per group: n, mean, SD, SEM, median, IQR,
         CV, min/max, t*, and CI half-width at the chosen level.
       - SVG bar chart with error bars, toggling SD / SEM / CI.
       - Non-overlapping-CI significance cue between groups.
       - PNG + SVG export of the plot; CSV export of the table.
       - Formulas via KaTeX (renderToString + output:html, aligned).
       ============================================================ */

    // # --- 1. State + DOM ---
    let computedResults = [];
    let currentLevel = 0.95;
    let errorMode = 'ci';   // 'sd' | 'sem' | 'ci'
    let sigFigs = 4;

    const dataInput      = document.getElementById('dataInput');
    const fileInput      = document.getElementById('fileInput');
    const hasHeaders     = document.getElementById('hasHeaders');
    const calculateBtn   = document.getElementById('calculateBtn');
    const resultsBody    = document.getElementById('resultsBody');
    const exportCsvBtn   = document.getElementById('exportCsvBtn');
    const theoryContainer= document.getElementById('theoryContainer');
    const ciLevelSelect  = document.getElementById('ciLevel');
    const ciHeader       = document.getElementById('ciHeader');
    const decimalsSelect = document.getElementById('decimals');

    // plot elements (optional; guarded)
    const plotHost       = document.getElementById('plotHost');
    const plotEmpty      = document.getElementById('plotEmpty');
    const errModeTabs    = document.querySelectorAll('[data-errmode]');
    const exportPngBtn   = document.getElementById('exportPngBtn');
    const exportSvgBtn   = document.getElementById('exportSvgBtn');
    const sigNote        = document.getElementById('sigNote');
    // Built-in sample datasets (mirror the standalone test CSVs).
    const SAMPLES = {
        basic:   "Label,Rep1,Rep2,Rep3,Rep4\nControl,4.5,4.2,4.8,4.6\nLow Dose,6.1,6.5,6.2,6.3\nHigh Dose,8.3,8.1,8.9,8.5",
        overlap: "Group,M1,M2,M3,M4\nAlpha,10.2,9.1,11.5,8.8\nBeta,10.8,9.6,12.1,9.4\nGamma,11.1,10.2,12.4,9.9",
        many:    "Sample,Trial1,Trial2,Trial3\npH 4,2.1,2.3,2.0\npH 5,3.4,3.6,3.5\npH 6,5.8,6.0,5.9\npH 7,8.2,8.5,8.1\npH 8,6.1,5.9,6.3\npH 9,3.2,3.0,3.4",
        ragged:  "Condition,V1,V2,V3,V4,V5\nBaseline,12.1,12.4,11.9\nStress,18.2,17.9,18.5,18.1,18.3\nRecovery,14.0,14.3",
        negative:"Region,Q1,Q2,Q3,Q4\nNorth,-2.5,-1.8,-3.1,-2.2\nEquator,0.5,-0.3,1.1,-0.8\nSouth,3.2,2.8,3.6,3.0",
        messy:   "Label,Rep1,Rep2,Rep3\n\nControl,4.5,4.2,4.8\n\nTreatment,6.1,6.5,6.2\n\nNotes: run on 2026-03-01,,,"
    };

    // # --- 2. Small stats helpers ---
    const S = {
        mean: a => a.reduce((s, x) => s + x, 0) / a.length,
        sd(a) { if (a.length < 2) return 0; const m = S.mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); },
        median(a) { const b = [...a].sort((x, y) => x - y); const n = b.length, m = n >> 1; return n % 2 ? b[m] : (b[m - 1] + b[m]) / 2; },
        quantile(a, q) {
            const b = [...a].sort((x, y) => x - y); if (b.length === 1) return b[0];
            const pos = (b.length - 1) * q, base = Math.floor(pos), rest = pos - base;
            return b[base + 1] !== undefined ? b[base] + rest * (b[base + 1] - b[base]) : b[base];
        }
    };

    // # --- 3. Theory (KaTeX, robust) ---
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
        if (typeof katex !== 'undefined') {
            const kxBlock = tex => { try { return katex.renderToString(tex, { displayMode: true, throwOnError: false, output: "html" }); } catch (e) { return '<span class="text-slate-400 text-sm">Formula unavailable.</span>'; } };
            theoryContainer.innerHTML =
                `<div class="mf-block-label">Central tendency &amp; inference</div>${kxBlock(texMain)}
                 <div class="mf-block-label" style="margin-top:1rem;">Spread &amp; robustness</div>${kxBlock(texSpread)}`;
            renderDefs();
        }
    }
    function renderDefs() {
        const defs = [
            [`\\bar{x}`, `group mean`],
            [`\\tilde{x}`, `median \u2014 middle value; robust to outliers`],
            [`n`, `number of replicates in the group`],
            [`s`, `sample standard deviation (n\u22121 denominator)`],
            [`\\mathrm{SEM}`, `standard error of the mean = s / \u221an`],
            [`Q_1,\\ Q_3`, `first and third quartiles (25th, 75th percentiles)`],
            [`\\mathrm{IQR}`, `interquartile range = Q\u2083 \u2212 Q\u2081; spread of the middle 50%`],
            [`\\mathrm{CV}`, `coefficient of variation \u2014 SD relative to the mean, as a %`],
            [`x_{\\min},\\ x_{\\max}`, `smallest and largest replicate values`],
            [`t^{*}_{\\alpha/2,\\,n-1}`, `Student\u2019s t critical value at the chosen level, df = n\u22121`],
            [`\\mathrm{CI}`, `confidence interval; half-width = t* \u00d7 SEM`]
        ];
        const kx = tex => { try { return katex.renderToString(tex, { throwOnError: false, output: "html" }); } catch (e) { return tex; } };
        const items = defs.map(([s, m]) => `<div class="mf-def"><dt>${kx(s)}</dt><dd>${m}</dd></div>`).join('');
        const host = document.getElementById('theoryDefs');
        if (host) host.innerHTML = `<div class="mf-defs"><div class="mf-defs-title">Where:</div><dl>${items}</dl></div>`;
    }
    renderTheory();

    // # --- 4. Ingestion ---
    if (fileInput) fileInput.onchange = (e) => {
        const file = e.target.files[0]; if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => { dataInput.value = ev.target.result; };
        reader.readAsText(file);
    };
    const sampleChips = document.querySelectorAll('.eb-chip');
    const samplesWrap = document.querySelector('.eb-samples');
    function loadSample(key) {
        const csv = SAMPLES[key];
        if (!csv) return;
        dataInput.value = csv;
        if (hasHeaders) hasHeaders.value = 'auto';  // all samples work with auto-detect
        // Don't auto-run — let the user press Calculate. Clear any stale results.
        computedResults = [];
        if (resultsBody) resultsBody.innerHTML = `<tr><td colspan="11" class="px-4 py-16 text-center text-slate-400">Example loaded — press <strong>Calculate Metrics</strong> to compute.</td></tr>`;
        if (plotHost) plotHost.innerHTML = '';
        if (plotEmpty) plotEmpty.style.display = '';
        if (sigNote) sigNote.style.display = 'none';
        if (exportCsvBtn) exportCsvBtn.disabled = true;
        if (samplesWrap) samplesWrap.classList.remove('hint');
        if (calculateBtn) {
            calculateBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
            calculateBtn.classList.add('run-pulse');
            setTimeout(() => calculateBtn.classList.remove('run-pulse'), 1600);
        }
        showToast("Example loaded — press Calculate Metrics.", "info");
    }
    sampleChips.forEach(chip => chip.addEventListener('click', () => loadSample(chip.getAttribute('data-sample'))));

    // Nudge first-time users toward the samples when the textarea starts empty.
    if (samplesWrap && dataInput && !dataInput.value.trim()) {
        samplesWrap.classList.add('hint');
        dataInput.addEventListener('input', () => samplesWrap.classList.remove('hint'), { once: true });
    }
    if (ciLevelSelect) ciLevelSelect.addEventListener('change', () => {
        currentLevel = parseFloat(ciLevelSelect.value) || 0.95;
        if (ciHeader) ciHeader.textContent = `${Math.round(currentLevel * 100)}% CI (±)`;
        if (computedResults.length) calculate();
    });
    if (decimalsSelect) decimalsSelect.addEventListener('change', () => {
        sigFigs = parseInt(decimalsSelect.value, 10) || 4;
        if (computedResults.length) { renderTable(); }
    });
    errModeTabs.forEach(tab => tab.addEventListener('click', () => {
        errorMode = tab.getAttribute('data-errmode');
        errModeTabs.forEach(t => t.classList.toggle('errmode-active', t === tab));
        if (computedResults.length) drawPlot();
    }));

    // Plot customization controls — each writes to plotOpts and redraws live.
    function bindOpt(id, key, kind) {
        const el = document.getElementById(id);
        if (!el) return;
        const handler = () => {
            if (kind === 'bool') plotOpts[key] = el.checked;
            else if (kind === 'num') plotOpts[key] = parseFloat(el.value);
            else plotOpts[key] = el.value;
            if (computedResults.length) drawPlot();
        };
        // checkboxes + selects → 'change'; text inputs + range sliders → 'input' (live)
        if (kind === 'bool' || el.tagName === 'SELECT') el.addEventListener('change', handler);
        else { el.addEventListener('input', handler); el.addEventListener('change', handler); }
    }
    bindOpt('optTitle', 'title', 'text');
    bindOpt('optYLabel', 'yLabel', 'text');
    bindOpt('optBarStyle', 'barStyle', 'text');
    bindOpt('optPalette', 'palette', 'text');
    bindOpt('optBarWidth', 'barWidth', 'num');
    bindOpt('optBarRadius', 'barRadius', 'num');
    bindOpt('optBarOpacity', 'barOpacity', 'num');
    bindOpt('optCapWidth', 'capWidth', 'num');
    bindOpt('optYMin', 'yMinOverride', 'text');
    bindOpt('optYMax', 'yMaxOverride', 'text');
    bindOpt('optGridlines', 'gridlines', 'bool');
    bindOpt('optShowN', 'showN', 'bool');
    bindOpt('optShowValues', 'showValues', 'bool');
    bindOpt('optShowLegend', 'showLegend', 'bool');

    // reflect range slider values in their little number badges
    ['optBarWidth', 'optBarRadius', 'optBarOpacity', 'optCapWidth'].forEach(id => {
        const el = document.getElementById(id), out = document.getElementById(id + 'Val');
        if (el && out) { const sync = () => out.textContent = el.value; el.addEventListener('input', sync); sync(); }
    });

    const resetPlotBtn = document.getElementById('resetPlotBtn');
    if (resetPlotBtn) resetPlotBtn.addEventListener('click', () => {
        Object.assign(plotOpts, {
            title: '', yLabel: '', barStyle: 'fill', barWidth: 55, barRadius: 3, barOpacity: 85,
            capWidth: 12, gridlines: true, showN: true, showValues: false, showLegend: false,
            palette: 'default', yMinOverride: '', yMaxOverride: ''
        });
        // reset the controls to match
        const set = (id, v, prop = 'value') => { const el = document.getElementById(id); if (el) el[prop] = v; };
        set('optTitle', ''); set('optYLabel', ''); set('optBarStyle', 'fill'); set('optPalette', 'default');
        set('optBarWidth', 55); set('optBarRadius', 3); set('optBarOpacity', 85); set('optCapWidth', 12);
        set('optYMin', ''); set('optYMax', '');
        set('optGridlines', true, 'checked'); set('optShowN', true, 'checked');
        set('optShowValues', false, 'checked'); set('optShowLegend', false, 'checked');
        ['optBarWidth', 'optBarRadius', 'optBarOpacity', 'optCapWidth'].forEach(id => {
            const el = document.getElementById(id), out = document.getElementById(id + 'Val'); if (el && out) out.textContent = el.value;
        });
        if (computedResults.length) drawPlot();
        showToast("Plot style reset to defaults.", "info");
    });

    // # --- 5. Compute ---
    function calculate() {
        const rawText = dataInput.value.trim();
        if (!rawText) return showToast("No data detected.", "error");

        // Always parse WITHOUT header mode so we get raw arrays, then decide for
        // ourselves whether the first row is a header. This is robust to whichever
        // way the data is arranged and doesn't depend on a fragile checkbox.
        const parsed = Papa.parse(rawText, { header: false, dynamicTyping: true, skipEmptyLines: true });
        let rows = (parsed.data || []).filter(r => Array.isArray(r) && r.some(c => c !== null && c !== ""));
        if (rows.length === 0) return showToast("Could not parse any rows.", "error");
        if (rows[0].length < 2) return showToast("Each row needs a label plus at least one value.", "error");

        // Decide whether the first row is a header of column names.
        // A header row is one whose value cells (columns 2+) are all non-numeric,
        // while at least one later row has numeric values there. The checkbox acts
        // as an explicit override when the user knows better.
        const isNum = v => typeof v === 'number' && !isNaN(v);
        const rowValuesNonNumeric = r => r.slice(1).every(c => !isNum(c));
        const rowHasNumericValues = r => r.slice(1).some(isNum);

        let firstRowIsHeader;
        const mode = hasHeaders.value || 'auto';
        if (mode === 'yes') firstRowIsHeader = true;
        else if (mode === 'no') firstRowIsHeader = false;
        else { // auto-detect
            firstRowIsHeader = rows.length > 1 && rowValuesNonNumeric(rows[0]) && rows.slice(1).some(rowHasNumericValues);
        }

        const dataRows = firstRowIsHeader ? rows.slice(1) : rows;
        if (dataRows.length === 0) return showToast("No data rows found beneath the header.", "error");

        // Group by first-column label; pool the numeric values from the rest.
        const groupMap = new Map();
        let skippedRows = 0;
        dataRows.forEach(row => {
            let groupKey = row[0];
            if (groupKey === null || groupKey === undefined || groupKey === "") { skippedRows++; return; }
            groupKey = String(groupKey);
            const values = row.slice(1).filter(isNum);
            if (values.length === 0) { skippedRows++; return; }
            if (!groupMap.has(groupKey)) groupMap.set(groupKey, []);
            groupMap.set(groupKey, groupMap.get(groupKey).concat(values));
        });

        if (groupMap.size === 0) {
            resultsBody.innerHTML = `<tr><td colspan="11" class="px-4 py-16 text-center text-slate-400">No numeric groups found. Put a text label in the first column and numeric replicates in the rest — or toggle the header setting.</td></tr>`;
            exportCsvBtn.disabled = true;
            if (plotEmpty) plotEmpty.style.display = '';
            if (plotHost) plotHost.innerHTML = '';
            if (sigNote) sigNote.style.display = 'none';
            return;
        }

        const level = currentLevel;
        const p = 1 - (1 - level) / 2;

        computedResults = [];
        groupMap.forEach((vals, key) => {
            if (vals.length === 0) return;
            const n = vals.length;
            const mean = S.mean(vals);
            const sd = n > 1 ? S.sd(vals) : 0;
            const sem = n > 0 ? sd / Math.sqrt(n) : 0;
            const tStar = n > 1 ? jStat.studentt.inv(p, n - 1) : 0;
            const ci = tStar * sem;
            const median = S.median(vals);
            const q1 = S.quantile(vals, 0.25), q3 = S.quantile(vals, 0.75);
            const iqr = q3 - q1;
            const cv = mean !== 0 ? (sd / Math.abs(mean)) * 100 : 0;
            const min = Math.min(...vals), max = Math.max(...vals);
            computedResults.push({ key, n, mean, sd, sem, t: tStar, ci, level, median, q1, q3, iqr, cv, min, max });
        });

        renderTable();
        drawPlot();
        renderSignificance();
        let msg = `Computed statistics for ${computedResults.length} group${computedResults.length > 1 ? "s" : ""}.`;
        if (skippedRows > 0) msg += ` (${skippedRows} row${skippedRows > 1 ? "s" : ""} skipped — no label or no numbers.)`;
        showToast(msg, "success");
    }
    calculateBtn.onclick = calculate;

    // # --- 6. Table ---
    function fmt(x) { return Number.isFinite(x) ? (+x.toFixed(sigFigs)).toString() : "—"; }
    function renderTable() {
        const pct = Math.round(currentLevel * 100);
        resultsBody.innerHTML = computedResults.map(r => `
            <tr class="hover:bg-slate-50 dark:hover:bg-slate-900/50 transition-colors">
                <td class="px-3 py-3 font-bold text-indigo-600 dark:text-indigo-400 border-r border-slate-100 dark:border-slate-800">${escapeHtml(String(r.key))}</td>
                <td class="px-3 py-3 text-center">${r.n}</td>
                <td class="px-3 py-3 font-mono">${fmt(r.mean)}</td>
                <td class="px-3 py-3 font-mono text-slate-500">${fmt(r.sd)}</td>
                <td class="px-3 py-3 font-mono text-slate-500">${fmt(r.sem)}</td>
                <td class="px-3 py-3 font-mono text-slate-500">${fmt(r.median)}</td>
                <td class="px-3 py-3 font-mono text-slate-500">${fmt(r.iqr)}</td>
                <td class="px-3 py-3 font-mono text-slate-500" title="Coefficient of variation">${fmt(r.cv)}%</td>
                <td class="px-3 py-3 font-mono text-slate-400">${fmt(r.min)}/${fmt(r.max)}</td>
                <td class="px-3 py-3 font-mono text-slate-500" title="Student's t critical value, df = n-1">${r.n > 1 ? fmt(r.t) : '—'}</td>
                <td class="px-3 py-3 font-mono font-bold text-emerald-600 dark:text-emerald-400">${fmt(r.ci)}</td>
            </tr>
        `).join('');
        if (ciHeader) ciHeader.textContent = `${pct}% CI (±)`;
        exportCsvBtn.disabled = false;
    }

    // # --- 7. Significance (non-overlapping CI heuristic) ---
    function renderSignificance() {
        if (!sigNote) return;
        const withCI = computedResults.filter(r => r.n > 1 && r.ci > 0);
        if (withCI.length < 2) { sigNote.style.display = 'none'; return; }
        const pairs = [];
        for (let i = 0; i < withCI.length; i++) for (let j = i + 1; j < withCI.length; j++) {
            const a = withCI[i], b = withCI[j];
            const aLo = a.mean - a.ci, aHi = a.mean + a.ci, bLo = b.mean - b.ci, bHi = b.mean + b.ci;
            const overlap = aLo <= bHi && bLo <= aHi;
            if (!overlap) pairs.push(`${a.key} vs ${b.key}`);
        }
        const pct = Math.round(currentLevel * 100);
        if (pairs.length) {
            sigNote.className = 'sig-note sig-yes';
            sigNote.innerHTML = `<i class="fa-solid fa-circle-check"></i> Non-overlapping ${pct}% CIs (suggestive of a significant difference): <strong>${pairs.map(escapeHtml).join(', ')}</strong>. This is a visual heuristic — confirm with a formal test (t-test / ANOVA).`;
        } else {
            sigNote.className = 'sig-note sig-no';
            sigNote.innerHTML = `<i class="fa-solid fa-circle-info"></i> All ${pct}% CIs overlap, so no pair shows a clear difference by the non-overlap heuristic. Note: overlapping CIs do <em>not</em> prove groups are equal — use a formal test.`;
        }
        sigNote.style.display = 'block';
    }

    // # --- 8. SVG plot ---
    const PLOT = { w: 720, h: 440, ml: 64, mr: 24, mt: 28, mb: 84 };
    function currentError(r) { return errorMode === 'sd' ? r.sd : errorMode === 'sem' ? r.sem : r.ci; }
    function errorLabel() { return errorMode === 'sd' ? 'SD' : errorMode === 'sem' ? 'SEM' : `${Math.round(currentLevel * 100)}% CI`; }

    function niceTicks(min, max, count = 5) {
        const span = (max - min) || 1;
        const step0 = span / count;
        const mag = Math.pow(10, Math.floor(Math.log10(step0)));
        const norm = step0 / mag;
        const step = (norm >= 5 ? 5 : norm >= 2 ? 2 : 1) * mag;
        const start = Math.floor(min / step) * step;
        const end = Math.ceil(max / step) * step;
        const ticks = [];
        for (let v = start; v <= end + 1e-9; v += step) ticks.push(+v.toFixed(10));
        return ticks;
    }

    // Plot options (customizable via the UI)
    const plotOpts = {
        title: '',
        yLabel: '',            // '' → auto ("Mean ± <error>")
        barStyle: 'fill',      // 'fill' | 'outline'
        barWidth: 55,          // % of band
        barRadius: 3,
        barOpacity: 85,        // %
        capWidth: 12,
        gridlines: true,
        showN: true,
        showValues: false,     // value label atop each bar
        showLegend: false,
        palette: 'default',
        yMinOverride: '',      // '' → auto
        yMaxOverride: ''
    };

    const PALETTES = {
        default: ['#6366f1', '#10b981', '#f59e0b', '#ec4899', '#06b6d4', '#8b5cf6', '#ef4444', '#84cc16'],
        blue:    ['#1e3a8a', '#2563eb', '#3b82f6', '#60a5fa', '#93c5fd', '#bfdbfe', '#1d4ed8', '#38bdf8'],
        viridis: ['#440154', '#414487', '#2a788e', '#22a884', '#7ad151', '#fde725', '#35b779', '#31688e'],
        warm:    ['#7c2d12', '#c2410c', '#ea580c', '#f59e0b', '#eab308', '#dc2626', '#db2777', '#f97316'],
        gray:    ['#1f2937', '#374151', '#4b5563', '#6b7280', '#9ca3af', '#d1d5db', '#111827', '#e5e7eb']
    };

    function drawPlot() {
        if (!plotHost) return;
        if (!computedResults.length) { plotHost.innerHTML = ''; if (plotEmpty) plotEmpty.style.display = ''; return; }
        if (plotEmpty) plotEmpty.style.display = 'none';

        const data = computedResults;
        const errs = data.map(currentError);
        let yMin = Math.min(0, ...data.map((r, i) => r.mean - errs[i]));
        let yMax = Math.max(...data.map((r, i) => r.mean + errs[i]));
        if (yMax === yMin) yMax = yMin + 1;
        const ticks = niceTicks(yMin, yMax, 5);
        yMin = Math.min(yMin, ticks[0]); yMax = Math.max(yMax, ticks[ticks.length - 1]);
        // user overrides
        const oMin = parseFloat(plotOpts.yMinOverride), oMax = parseFloat(plotOpts.yMaxOverride);
        if (Number.isFinite(oMin)) yMin = oMin;
        if (Number.isFinite(oMax)) yMax = oMax;
        if (yMax <= yMin) yMax = yMin + 1;
        const drawTicks = niceTicks(yMin, yMax, 5).filter(t => t >= yMin - 1e-9 && t <= yMax + 1e-9);

        // dynamic top margin if a title is present
        const hasTitle = plotOpts.title.trim().length > 0;
        const mt = PLOT.mt + (hasTitle ? 28 : 0) + (plotOpts.showLegend ? 22 : 0);
        const { w, h, ml, mr, mb } = PLOT;
        const plotW = w - ml - mr, plotH = h - mt - mb;
        const yScale = v => mt + plotH - ((v - yMin) / (yMax - yMin)) * plotH;
        const n = data.length;
        const band = plotW / n;
        const barW = Math.min(120, band * (plotOpts.barWidth / 100));

        const palette = PALETTES[plotOpts.palette] || PALETTES.default;
        const isDark = document.documentElement.classList.contains('dark');
        const axis = isDark ? '#94a3b8' : '#64748b';
        const grid = isDark ? 'rgba(148,163,184,.18)' : 'rgba(148,163,184,.25)';
        const txt = isDark ? '#e2e8f0' : '#1e293b';
        const bg = isDark ? '#0f172a' : '#ffffff';
        const opacity = plotOpts.barOpacity / 100;

        let svg = `<svg id="ebSvg" xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="Inter, system-ui, sans-serif">`;
        svg += `<rect x="0" y="0" width="${w}" height="${h}" fill="${bg}"/>`;

        // title
        if (hasTitle) svg += `<text x="${ml + plotW / 2}" y="26" text-anchor="middle" font-size="16" font-weight="700" fill="${txt}">${escapeXml(plotOpts.title)}</text>`;

        // gridlines + y ticks
        drawTicks.forEach(t => {
            const y = yScale(t);
            if (plotOpts.gridlines) svg += `<line x1="${ml}" y1="${y}" x2="${w - mr}" y2="${y}" stroke="${grid}" stroke-width="1"/>`;
            svg += `<text x="${ml - 10}" y="${y + 4}" text-anchor="end" font-size="12" fill="${axis}">${(+t.toFixed(6)).toString()}</text>`;
        });
        // axes
        svg += `<line x1="${ml}" y1="${mt}" x2="${ml}" y2="${mt + plotH}" stroke="${axis}" stroke-width="1.5"/>`;
        const baseY = yScale(Math.max(yMin, Math.min(0, yMax)));
        svg += `<line x1="${ml}" y1="${baseY}" x2="${w - mr}" y2="${baseY}" stroke="${axis}" stroke-width="1.5"/>`;

        data.forEach((r, i) => {
            const cx = ml + band * i + band / 2;
            const e = currentError(r);
            const yTop = yScale(r.mean);
            const color = palette[i % palette.length];
            const bx = cx - barW / 2, by = Math.min(yTop, baseY), bh = Math.abs(baseY - yTop);
            // bar (filled or outline)
            if (plotOpts.barStyle === 'outline') {
                svg += `<rect x="${bx}" y="${by}" width="${barW}" height="${bh}" rx="${plotOpts.barRadius}" fill="none" stroke="${color}" stroke-width="2.5" opacity="${opacity}"/>`;
            } else {
                svg += `<rect x="${bx}" y="${by}" width="${barW}" height="${bh}" rx="${plotOpts.barRadius}" fill="${color}" opacity="${opacity}"/>`;
            }
            // error bar
            if (e > 0) {
                const yHi = yScale(r.mean + e), yLo = yScale(r.mean - e);
                const cap = Math.min(plotOpts.capWidth, barW / 2);
                svg += `<line x1="${cx}" y1="${yHi}" x2="${cx}" y2="${yLo}" stroke="${txt}" stroke-width="1.6"/>`;
                svg += `<line x1="${cx - cap}" y1="${yHi}" x2="${cx + cap}" y2="${yHi}" stroke="${txt}" stroke-width="1.6"/>`;
                svg += `<line x1="${cx - cap}" y1="${yLo}" x2="${cx + cap}" y2="${yLo}" stroke="${txt}" stroke-width="1.6"/>`;
            }
            // value label atop bar
            if (plotOpts.showValues) {
                const vy = yScale(r.mean + (e > 0 ? e : 0)) - 6;
                svg += `<text x="${cx}" y="${vy}" text-anchor="middle" font-size="11" fill="${txt}" font-weight="600">${fmt(r.mean)}</text>`;
            }
            // x label
            const label = String(r.key);
            svg += `<text x="${cx}" y="${mt + plotH + 20}" text-anchor="middle" font-size="12" fill="${txt}" font-weight="600">${escapeXml(label.length > 16 ? label.slice(0, 15) + '…' : label)}</text>`;
            if (plotOpts.showN) svg += `<text x="${cx}" y="${mt + plotH + 36}" text-anchor="middle" font-size="10" fill="${axis}">n=${r.n}</text>`;
        });

        // legend (top)
        if (plotOpts.showLegend) {
            let lx = ml, ly = hasTitle ? 44 : 22;
            data.forEach((r, i) => {
                const color = palette[i % palette.length];
                const label = String(r.key);
                svg += `<rect x="${lx}" y="${ly - 9}" width="11" height="11" rx="2" fill="${color}" opacity="${opacity}"/>`;
                svg += `<text x="${lx + 16}" y="${ly}" font-size="11" fill="${txt}">${escapeXml(label.length > 14 ? label.slice(0, 13) + '…' : label)}</text>`;
                lx += 22 + Math.min(label.length, 14) * 6.6 + 14;
            });
        }

        // axis titles
        svg += `<text x="${ml + plotW / 2}" y="${h - 10}" text-anchor="middle" font-size="12" fill="${axis}" font-weight="600">Group</text>`;
        const yl = plotOpts.yLabel.trim() || `Mean ± ${errorLabel()}`;
        svg += `<text transform="translate(18 ${mt + plotH / 2}) rotate(-90)" text-anchor="middle" font-size="12" fill="${axis}" font-weight="600">${escapeXml(yl)}</text>`;
        svg += `</svg>`;
        plotHost.innerHTML = svg;
    }

    // redraw on theme toggle so colors track light/dark
    document.querySelectorAll('.themeToggle').forEach(btn =>
        btn.addEventListener('click', () => { if (computedResults.length) setTimeout(drawPlot, 30); }));

    // # --- 9. Exports ---
    function downloadBlob(blob, name) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = name;
        document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
    }
    if (exportSvgBtn) exportSvgBtn.onclick = () => {
        const svg = document.getElementById('ebSvg'); if (!svg) return showToast("Nothing to export yet.", "error");
        const src = '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(svg);
        downloadBlob(new Blob([src], { type: 'image/svg+xml;charset=utf-8' }), 'error_bar_plot.svg');
        showToast("Plot exported as SVG.", "success");
    };
    if (exportPngBtn) exportPngBtn.onclick = () => {
        const svg = document.getElementById('ebSvg'); if (!svg) return showToast("Nothing to export yet.", "error");
        const W = PLOT.w, H = PLOT.h, scale = 3;
        // Ensure the serialized SVG carries explicit width/height so the raster
        // image has a defined intrinsic size (otherwise it can crop/scale wrong).
        const clone = svg.cloneNode(true);
        clone.setAttribute('width', W);
        clone.setAttribute('height', H);
        const src = '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(clone);
        const img = new Image();
        img.width = W; img.height = H;
        const svgBlob = new Blob([src], { type: 'image/svg+xml;charset=utf-8' });
        const url = URL.createObjectURL(svgBlob);
        img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = W * scale; canvas.height = H * scale;
            const ctx = canvas.getContext('2d');
            // paint background first (guards against transparent PNG on some browsers)
            ctx.fillStyle = document.documentElement.classList.contains('dark') ? '#0f172a' : '#ffffff';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            URL.revokeObjectURL(url);
            canvas.toBlob(b => { downloadBlob(b, 'error_bar_plot.png'); showToast("Plot exported as PNG (3× resolution).", "success"); });
        };
        img.onerror = () => { URL.revokeObjectURL(url); showToast("PNG export failed in this browser; try SVG.", "error"); };
        img.src = url;
    };

    exportCsvBtn.onclick = () => {
        if (!computedResults.length) return;
        const rows = computedResults.map(r => ({
            label: r.key, n: r.n, mean: r.mean, sd: r.sd, sem: r.sem,
            median: r.median, q1: r.q1, q3: r.q3, iqr: r.iqr, cv_percent: r.cv,
            min: r.min, max: r.max, t_critical: r.t, ci_level: r.level,
            ci_half_width: r.ci, ci_lower: r.mean - r.ci, ci_upper: r.mean + r.ci
        }));
        downloadBlob(new Blob([Papa.unparse(rows)], { type: 'text/csv;charset=utf-8;' }), "error_analysis_results.csv");
        showToast("Results exported to CSV.", "success");
    };

    // # --- 10. Utilities ---
    function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
    function escapeXml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c])); }

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
