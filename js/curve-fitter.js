/*
 * STEMKit — Non-Linear Curve Fitter
 * Uses regression.js for least-squares fitting and Plotly for rendering.
 * Author: Olanrewaju M. Daramola. Runs 100% client-side.
 *
 * Honesty note: exponential, power and logarithmic models are fitted by
 * LINEARIZING the data (least squares on log/transformed variables), which is
 * the standard regression.js behaviour. This is not identical to a true
 * non-linear least-squares fit in the original space and can bias parameters
 * when data spans several orders of magnitude. R-squared is reported on the
 * original data. See the reference links on the page.
 */
document.addEventListener('DOMContentLoaded', () => {

    // --- 1. Interface Bindings ---
    const dataInput       = document.getElementById('dataInput');
    const modelSelect     = document.getElementById('modelSelect');
    const btnFit          = document.getElementById('btnFit');
    const btnExample      = document.getElementById('btnExample');   // optional
    const plotContainer   = document.getElementById('plotContainer');
    const equationOutput  = document.getElementById('equationOutput');
    const r2Value         = document.getElementById('r2Value');
    const fitMeta         = document.getElementById('fitMeta');       // optional
    const btnCopyEquation = document.getElementById('btnCopyEquation');
    const toastContainer  = document.getElementById('toastContainer');

    let currentEquationString = "";
    let currentSummary = "";

    // Number of free parameters per model (used for the overfitting guard)
    const PARAM_COUNT = {
        linear: 2, exponential: 2, power: 2, logarithmic: 2,
        polynomial2: 3, polynomial3: 4
    };

    const EXAMPLE = `0.5\t1.6\n1.0\t2.9\n1.5\t4.4\n2.0\t7.0\n2.5\t10.1\n3.0\t14.8\n3.5\t20.9\n4.0\t29.0`;

    // --- 2. Event Listeners ---
    btnFit.addEventListener('click', processRegression);
    // Example datasets tuned to each model type (load only — user clicks Compute Fit).
    const SAMPLES = {
        linear:      { model: 'linear',      data: "1\t2.1\n2\t4.3\n3\t5.9\n4\t8.2\n5\t9.8\n6\t12.1\n7\t14.0\n8\t15.9" },
        exponential: { model: 'exponential', data: "0.5\t1.6\n1.0\t2.9\n1.5\t4.4\n2.0\t7.0\n2.5\t10.1\n3.0\t14.8\n3.5\t20.9\n4.0\t29.0" },
        power:       { model: 'power',       data: "1\t2.0\n2\t5.7\n3\t10.4\n4\t16.0\n5\t22.4\n6\t29.4\n7\t37.0\n8\t45.3" },
        logarithmic: { model: 'logarithmic', data: "1\t0.2\n2\t2.1\n3\t3.3\n4\t4.1\n5\t4.8\n6\t5.3\n7\t5.8\n8\t6.2" },
        polynomial2: { model: 'polynomial2', data: "-4\t18.1\n-3\t9.8\n-2\t4.2\n-1\t1.1\n0\t0.2\n1\t1.0\n2\t4.1\n3\t9.2\n4\t16.3" }
    };
    const sampleWrap = document.querySelector('.cf-samples');
    document.querySelectorAll('.cf-chip').forEach(chip => chip.addEventListener('click', () => {
        const s = SAMPLES[chip.getAttribute('data-sample')];
        if (!s) return;
        dataInput.value = s.data;
        modelSelect.value = s.model;
        if (sampleWrap) sampleWrap.classList.remove('hint');
        // Don't auto-run — nudge the Fit button instead.
        btnFit.classList.add('cf-pulse');
        setTimeout(() => btnFit.classList.remove('cf-pulse'), 1600);
        btnFit.scrollIntoView({ behavior: 'smooth', block: 'center' });
        showToast('Example loaded — press Compute Fit.');
    }));
    // File upload — reads a CSV/TXT/DAT/TSV into the textarea (same parser handles it).
    const btnUpload = document.getElementById('btnUpload');
    const fileInput = document.getElementById('fileInput');
    if (btnUpload && fileInput) {
        btnUpload.addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (ev) => {
                dataInput.value = ev.target.result;
                if (sampleWrap) sampleWrap.classList.remove('hint');
                btnFit.classList.add('cf-pulse');
                setTimeout(() => btnFit.classList.remove('cf-pulse'), 1600);
                showToast(`Loaded ${file.name} — press Compute Fit.`);
            };
            reader.onerror = () => showToast('Could not read that file.');
            reader.readAsText(file);
            fileInput.value = '';
        });
    }
    // Hint the example chips while the input is empty.
    if (sampleWrap && dataInput && !dataInput.value.trim()) {
        sampleWrap.classList.add('hint');
        dataInput.addEventListener('input', () => sampleWrap.classList.remove('hint'), { once: true });
    }

    // Re-render on theme change so the plot colours track light/dark mode
    const themeObserver = new MutationObserver(() => {
        if (dataInput.value.trim() !== '') processRegression();
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

    // --- 3. Parsing Engine ---
    function parseInputData(rawText) {
        if (!rawText.trim()) return [];
        const lines = rawText.split('\n');
        const matrix = [];
        for (let line of lines) {
            if (line.trim() === '') continue;
            const tokens = line.trim().split(/[\s,]+/).filter(Boolean);
            if (tokens.length >= 2) {
                const x = parseFloat(tokens[0]);
                const y = parseFloat(tokens[1]);
                if (!isNaN(x) && !isNaN(y)) matrix.push([x, y]);
            }
        }
        return matrix.sort((a, b) => a[0] - b[0]);
    }

    // --- 4. Regression Engine ---
    function processRegression() {
        const rawData = parseInputData(dataInput.value);
        if (rawData.length < 2) {
            showToast("Please provide at least 2 valid data points.");
            return;
        }

        const model = modelSelect.value;
        let result;

        try {
            switch (model) {
                case 'linear':
                    result = regression.linear(rawData, { precision: 6 });
                    formatEquation(result.equation, 'linear');
                    break;
                case 'exponential':
                    if (rawData.some(p => p[1] <= 0)) throw new Error("Exponential models require every y > 0");
                    result = regression.exponential(rawData, { precision: 6 });
                    formatEquation(result.equation, 'exponential');
                    break;
                case 'power':
                    if (rawData.some(p => p[0] <= 0 || p[1] <= 0)) throw new Error("Power models require every x > 0 and y > 0");
                    result = regression.power(rawData, { precision: 6 });
                    formatEquation(result.equation, 'power');
                    break;
                case 'logarithmic':
                    if (rawData.some(p => p[0] <= 0)) throw new Error("Logarithmic models require every x > 0");
                    result = regression.logarithmic(rawData, { precision: 6 });
                    formatEquation(result.equation, 'logarithmic');
                    break;
                case 'polynomial2':
                    result = regression.polynomial(rawData, { order: 2, precision: 6 });
                    formatEquation(result.equation, 'polynomial2');
                    break;
                case 'polynomial3':
                    result = regression.polynomial(rawData, { order: 3, precision: 6 });
                    formatEquation(result.equation, 'polynomial3');
                    break;
                default:
                    throw new Error("Unknown model");
            }
        } catch (err) {
            showToast(`Math Error: ${err.message}`);
            return;
        }

        const r2 = (typeof result.r2 === 'number' && isFinite(result.r2)) ? result.r2 : NaN;
        r2Value.textContent = isNaN(r2) ? '—' : r2.toFixed(4);

        // RMSE on the original data, computed from the model's own predictions
        let sse = 0, n = 0;
        rawData.forEach(([x, y]) => {
            const p = result.predict(x);
            if (p && isFinite(p[1])) { sse += (y - p[1]) ** 2; n++; }
        });
        const rmse = n ? Math.sqrt(sse / n) : NaN;

        updateFitMeta(rawData.length, PARAM_COUNT[model], model, r2, rmse);
        renderPlot(rawData, result);
        lastFit = { model, eq: result.equation, r2, rmse, data: rawData };
    }
    let lastFit = null;

    // --- 5. Fit-quality meta + overfitting guard ---
    function updateFitMeta(nPoints, nParams, model, r2, rmse) {
        currentSummary =
            `R2 = ${isNaN(r2) ? 'n/a' : r2.toFixed(4)}, ` +
            `RMSE = ${isNaN(rmse) ? 'n/a' : rmse.toPrecision(4)}, n = ${nPoints}`;

        if (!fitMeta) return;

        let warn = "";
        if (nPoints < nParams) {
            warn = `Under-determined: ${nPoints} points cannot fix ${nParams} parameters.`;
        } else if (nPoints === nParams) {
            warn = `Exact fit: with ${nPoints} points a ${nParams}-parameter model passes through every point, so R² ≈ 1 is not evidence of a good model.`;
        } else if (nPoints <= nParams + 1) {
            warn = `Very few points for this model — R² is optimistic. Add more data if you can.`;
        }

        const rmseTxt  = isNaN(rmse) ? 'n/a' : rmse.toPrecision(4);
        const linNote  = ['exponential', 'power', 'logarithmic'].includes(model)
            ? ` &middot; fitted via linearization (log-space least squares)` : '';

        fitMeta.innerHTML =
            `<span class="font-mono">n = ${nPoints} points &middot; RMSE = ${rmseTxt}${linNote}</span>` +
            (warn ? `<span class="block mt-1 text-amber-500 dark:text-amber-400"><i class="fa-solid fa-triangle-exclamation mr-1"></i>${warn}</span>` : '');
    }

    // --- 6. Equation Formatter ---
    function formatEquation(eq, type) {
        let displayHTML = "";
        let copyString = "";

        if (type === 'linear') {
            displayHTML = `y = ${eq[0]}x ${eq[1] >= 0 ? '+' : '-'} ${Math.abs(eq[1])}`;
            copyString = displayHTML;
        } else if (type === 'exponential') {
            displayHTML = `y = ${eq[0]} &middot; e<sup>${eq[1]}x</sup>`;
            copyString = `y = ${eq[0]} * e^(${eq[1]}x)`;
        } else if (type === 'power') {
            displayHTML = `y = ${eq[0]} &middot; x<sup>${eq[1]}</sup>`;
            copyString = `y = ${eq[0]} * x^(${eq[1]})`;
        } else if (type === 'logarithmic') {
            displayHTML = `y = ${eq[0]} ${eq[1] >= 0 ? '+' : '-'} ${Math.abs(eq[1])} &middot; ln(x)`;
            copyString = `y = ${eq[0]} ${eq[1] >= 0 ? '+' : '-'} ${Math.abs(eq[1])} * ln(x)`;
        } else if (type === 'polynomial2') {
            displayHTML = `y = ${eq[0]}x<sup>2</sup> ${eq[1] >= 0 ? '+' : '-'} ${Math.abs(eq[1])}x ${eq[2] >= 0 ? '+' : '-'} ${Math.abs(eq[2])}`;
            copyString = `y = ${eq[0]}x^2 ${eq[1] >= 0 ? '+' : '-'} ${Math.abs(eq[1])}x ${eq[2] >= 0 ? '+' : '-'} ${Math.abs(eq[2])}`;
        } else if (type === 'polynomial3') {
            displayHTML = `y = ${eq[0]}x<sup>3</sup> ${eq[1] >= 0 ? '+' : '-'} ${Math.abs(eq[1])}x<sup>2</sup> ${eq[2] >= 0 ? '+' : '-'} ${Math.abs(eq[2])}x ${eq[3] >= 0 ? '+' : '-'} ${Math.abs(eq[3])}`;
            copyString = `y = ${eq[0]}x^3 ${eq[1] >= 0 ? '+' : '-'} ${Math.abs(eq[1])}x^2 ${eq[2] >= 0 ? '+' : '-'} ${Math.abs(eq[2])}x ${eq[3] >= 0 ? '+' : '-'} ${Math.abs(eq[3])}`;
        }

        equationOutput.innerHTML = displayHTML;
        currentEquationString = copyString;
    }

    // --- 7. Plotting Engine ---
    function renderPlot(rawData, resultData) {
        const isDark = document.documentElement.classList.contains('dark');
        const fontColor = isDark ? '#cbd5e1' : '#334155';
        const gridColor = isDark ? '#334155' : '#e2e8f0';

        const rawX = rawData.map(p => p[0]);
        const rawY = rawData.map(p => p[1]);

        const minX = Math.min(...rawX);
        const maxX = Math.max(...rawX);
        const curveX = [];
        const curveY = [];

        const steps = 100;
        const stepSize = (maxX - minX) / steps;

        for (let i = 0; i <= steps; i++) {
            const x = minX + (i * stepSize);
            const predicted = resultData.predict(x);
            if (predicted && !isNaN(predicted[1]) && isFinite(predicted[1])) {
                curveX.push(x);
                curveY.push(predicted[1]);
            }
        }

        const rawTrace = {
            x: rawX, y: rawY, mode: 'markers', type: 'scatter', name: 'Raw Data',
            marker: { size: 8, color: '#94a3b8' }
        };
        const fitTrace = {
            x: curveX, y: curveY, mode: 'lines', type: 'scatter', name: 'Fitted Model',
            line: { color: '#10b981', width: 3 }
        };
        const layout = {
            plot_bgcolor: 'transparent', paper_bgcolor: 'transparent',
            font: { family: 'Inter, system-ui, sans-serif', color: fontColor },
            xaxis: { gridcolor: gridColor, zerolinecolor: gridColor },
            yaxis: { gridcolor: gridColor, zerolinecolor: gridColor },
            margin: { t: 40, r: 40, b: 40, l: 60 },
            showlegend: true,
            legend: { orientation: "h", yanchor: "bottom", y: 1.02, xanchor: "right", x: 1 }
        };
        const config = { responsive: true, displaylogo: false };
        Plotly.react(plotContainer, [rawTrace, fitTrace], layout, config);
    }

    // --- 8. Utilities ---
    function showToast(message) {
        const toast = document.createElement('div');
        toast.className = 'bg-slate-800 text-white text-xs font-bold px-4 py-2 rounded-lg shadow-xl transform transition-all duration-300 translate-y-[-20px] opacity-0';
        toast.innerText = message;
        toastContainer.appendChild(toast);
        requestAnimationFrame(() => {
            toast.classList.remove('translate-y-[-20px]', 'opacity-0');
            toast.classList.add('translate-y-0', 'opacity-100');
        });
        setTimeout(() => {
            toast.classList.remove('translate-y-0', 'opacity-100');
            toast.classList.add('translate-y-[-20px]', 'opacity-0');
            setTimeout(() => toast.remove(), 300);
        }, 2000);
    }

    btnCopyEquation.addEventListener('click', () => {
        if (!currentEquationString) return;
        const payload = currentSummary
            ? `${currentEquationString}\n${currentSummary}`
            : currentEquationString;
        navigator.clipboard.writeText(payload).then(() => {
            showToast('Equation and fit statistics copied to clipboard!');
            const originalHTML = btnCopyEquation.innerHTML;
            btnCopyEquation.innerHTML = 'Copied!';
            setTimeout(() => { btnCopyEquation.innerHTML = originalHTML; }, 2000);
        });
    });

    // --- matplotlib code export ---
    function genCurveCode() {
        if (!lastFit) return "# Fit a model first, then click Python again.";
        const { model, eq, r2, data } = lastFit;
        const xs = data.map(p => p[0]), ys = data.map(p => p[1]);
        const P = n => (+n).toString();
        let fnBody, label;
        if (model === 'linear')            { fnBody = `${P(eq[0])} * x + ${P(eq[1])}`;                       label = `y = ${P(eq[0])}x + ${P(eq[1])}`; }
        else if (model === 'exponential')  { fnBody = `${P(eq[0])} * np.exp(${P(eq[1])} * x)`;               label = `y = ${P(eq[0])}·e^(${P(eq[1])}x)`; }
        else if (model === 'power')        { fnBody = `${P(eq[0])} * np.power(x, ${P(eq[1])})`;             label = `y = ${P(eq[0])}·x^${P(eq[1])}`; }
        else if (model === 'logarithmic')  { fnBody = `${P(eq[0])} + ${P(eq[1])} * np.log(x)`;               label = `y = ${P(eq[0])} + ${P(eq[1])}·ln(x)`; }
        else if (model === 'polynomial2')  { fnBody = `${P(eq[0])}*x**2 + ${P(eq[1])}*x + ${P(eq[2])}`;      label = `quadratic fit`; }
        else if (model === 'polynomial3')  { fnBody = `${P(eq[0])}*x**3 + ${P(eq[1])}*x**2 + ${P(eq[2])}*x + ${P(eq[3])}`; label = `cubic fit`; }

        let c = `import numpy as np\nimport matplotlib.pyplot as plt\n\n`;
        c += `# --- Your data ---\n`;
        c += `x = np.array([${xs.join(', ')}])\n`;
        c += `y = np.array([${ys.join(', ')}])\n\n`;
        c += `# --- Fitted ${model} model (from STEMKit, R\u00b2 = ${isNaN(r2) ? 'n/a' : r2.toFixed(4)}) ---\n`;
        c += `def model(x):\n    return ${fnBody}\n\n`;
        c += `xfit = np.linspace(x.min(), x.max(), 200)\n`;
        c += `yfit = model(xfit)\n\n`;
        c += `# --- Plot ---\n`;
        c += `fig, ax = plt.subplots(figsize=(7, 5), dpi=150)\n`;
        c += `ax.scatter(x, y, color='#94a3b8', s=40, label='Data', zorder=3)\n`;
        c += `ax.plot(xfit, yfit, color='#10b981', lw=2.5, label='${label}')\n`;
        c += `ax.set_xlabel('x')\nax.set_ylabel('y')\n`;
        c += `ax.legend(frameon=True)\n`;
        c += `ax.spines['top'].set_visible(False)\nax.spines['right'].set_visible(False)\n`;
        c += `fig.tight_layout()\nfig.savefig('fit.png', dpi=300, bbox_inches='tight')\nplt.show()\n`;
        return c;
    }
    const cfCodeModal = document.getElementById('cfCodeModal');
    const cfCodeBlock = document.getElementById('cfCodeBlock');
    const btnPy = document.getElementById('btnPython');
    if (btnPy) btnPy.addEventListener('click', () => {
        cfCodeBlock.textContent = genCurveCode();
        cfCodeModal.classList.add('open');
    });
    const cfClose = document.getElementById('cfCloseCode');
    if (cfClose) cfClose.addEventListener('click', () => cfCodeModal.classList.remove('open'));
    if (cfCodeModal) cfCodeModal.addEventListener('click', e => { if (e.target === cfCodeModal) cfCodeModal.classList.remove('open'); });
    const cfCopy = document.getElementById('cfCopyCode');
    if (cfCopy) cfCopy.addEventListener('click', () => {
        navigator.clipboard.writeText(cfCodeBlock.textContent).then(() => showToast('matplotlib code copied!'));
    });

    // Render an initial empty plot state so it doesn't look blank
    renderPlot([[0, 0]], { predict: () => [0, 0] });
});
