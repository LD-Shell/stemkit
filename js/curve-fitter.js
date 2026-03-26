document.addEventListener('DOMContentLoaded', () => {

    // --- 1. Interface Bindings ---
    const dataInput = document.getElementById('dataInput');
    const modelSelect = document.getElementById('modelSelect');
    const btnFit = document.getElementById('btnFit');
    const plotContainer = document.getElementById('plotContainer');
    const equationOutput = document.getElementById('equationOutput');
    const r2Value = document.getElementById('r2Value');
    const btnCopyEquation = document.getElementById('btnCopyEquation');
    const toastContainer = document.getElementById('toastContainer');

    let currentEquationString = "";

    // --- 2. Event Listeners ---
    btnFit.addEventListener('click', processRegression);

    // Theme change observer for Plotly re-render
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
            
            // Supporting space, tab, or comma separated X/Y columns
            const tokens = line.trim().split(/[\s,]+/).filter(Boolean);
            if (tokens.length >= 2) {
                const x = parseFloat(tokens[0]);
                const y = parseFloat(tokens[1]);
                if (!isNaN(x) && !isNaN(y)) {
                    matrix.push([x, y]);
                }
            }
        }
        
        // Sort array by X value to ensure continuous line plotting
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

        // Utilizing regression.js to compute the optimal least-squares fit
        try {
            switch (model) {
                case 'linear':
                    result = regression.linear(rawData, { precision: 6 });
                    formatEquation(result.equation, 'linear');
                    break;
                case 'exponential':
                    // Exponential requires strictly positive Y values due to internal log transformation
                    if (rawData.some(point => point[1] <= 0)) throw new Error("Exponential models require y > 0");
                    result = regression.exponential(rawData, { precision: 6 });
                    formatEquation(result.equation, 'exponential');
                    break;
                case 'power':
                    if (rawData.some(point => point[0] <= 0 || point[1] <= 0)) throw new Error("Power models require x > 0 and y > 0");
                    result = regression.power(rawData, { precision: 6 });
                    formatEquation(result.equation, 'power');
                    break;
                case 'logarithmic':
                    if (rawData.some(point => point[0] <= 0)) throw new Error("Logarithmic models require x > 0");
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
            }
        } catch (err) {
            showToast(`Math Error: ${err.message}`);
            return;
        }

        r2Value.textContent = result.r2.toFixed(4);
        renderPlot(rawData, result);
    }

    // --- 5. Equation Formatter ---
    // Transforms the raw coefficient arrays into clean, academic typography
    function formatEquation(eq, type) {
        let displayHTML = "";
        let copyString = "";

        // Standardize output notation dynamically based on the requested model
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

    // --- 6. Plotting Engine ---
    function renderPlot(rawData, resultData) {
        const isDark = document.documentElement.classList.contains('dark');
        const fontColor = isDark ? '#cbd5e1' : '#334155';
        const gridColor = isDark ? '#334155' : '#e2e8f0';

        // Separate X/Y for the raw scatter points
        const rawX = rawData.map(p => p[0]);
        const rawY = rawData.map(p => p[1]);

        // To generate a smooth visual curve, we generate a high-density artificial array 
        // using the math formula provided by the regression output
        const minX = Math.min(...rawX);
        const maxX = Math.max(...rawX);
        const curveX = [];
        const curveY = [];
        
        const steps = 100;
        const stepSize = (maxX - minX) / steps;
        
        for (let i = 0; i <= steps; i++) {
            const x = minX + (i * stepSize);
            // We pass the artificial X through the regression object's internal predictor
            const predicted = resultData.predict(x);
            if (predicted && !isNaN(predicted[1])) {
                curveX.push(x);
                curveY.push(predicted[1]);
            }
        }

        const rawTrace = {
            x: rawX,
            y: rawY,
            mode: 'markers',
            type: 'scatter',
            name: 'Raw Data',
            marker: { size: 8, color: '#94a3b8' } // Slate color for raw data
        };

        const fitTrace = {
            x: curveX,
            y: curveY,
            mode: 'lines',
            type: 'scatter',
            name: 'Fitted Model',
            line: { color: '#10b981', width: 3 } // Emerald color for the curve
        };

        const layout = {
            plot_bgcolor: 'transparent',
            paper_bgcolor: 'transparent',
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

    // --- 7. Utilities ---
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

        navigator.clipboard.writeText(currentEquationString).then(() => {
            showToast('Mathematical formula copied to clipboard!');
            
            const originalHTML = btnCopyEquation.innerHTML;
            btnCopyEquation.innerHTML = 'Copied!';
            
            setTimeout(() => {
                btnCopyEquation.innerHTML = originalHTML;
            }, 2000);
        });
    });

    // Render an initial empty plot state so it doesn't look blank
    renderPlot([[0,0]], { predict: () => [0,0] });

});
