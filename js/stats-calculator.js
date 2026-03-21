document.addEventListener("DOMContentLoaded", () => {
    
    // --- State Management ---
    let parsedData = {};
    let variables = [];

    // --- DOM Elements ---
    const dataInput = document.getElementById('dataInput');
    const fileInput = document.getElementById('fileInput');
    const parseBtn = document.getElementById('parseBtn');
    const dataMeta = document.getElementById('dataMeta');
    
    const testType = document.getElementById('testType');
    const var1 = document.getElementById('var1');
    const var2 = document.getElementById('var2');
    const runTestBtn = document.getElementById('runTestBtn');
    
    const resultsContainer = document.getElementById('resultsContainer');
    const statLabel = document.getElementById('statLabel');
    const statValue = document.getElementById('statValue');
    const pValueEl = document.getElementById('pValue');
    const pubSummary = document.getElementById('pubSummary');
    const copyBtn = document.getElementById('copyBtn');
    const theoryContainer = document.getElementById('theoryContainer');

    // --- Theme Toggle ---
    document.getElementById('themeToggle').addEventListener('click', () => {
        document.documentElement.classList.toggle('dark');
        localStorage.theme = document.documentElement.classList.contains('dark') ? 'dark' : 'light';
    });

    // --- File Upload Handling ---
    fileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (event) => {
            dataInput.value = event.target.result;
            parseData();
        };
        reader.readAsText(file);
    });

    // --- Data Parsing Pipeline ---
    parseBtn.addEventListener('click', parseData);

    function parseData() {
        const rawText = dataInput.value.trim();
        if (!rawText) {
            showToast("Please input some data first.", "error");
            return;
        }

        Papa.parse(rawText, {
            header: true,
            dynamicTyping: true,
            skipEmptyLines: true,
            complete: function(results) {
                if (results.errors.length > 0 && results.data.length === 0) {
                    showToast("Error parsing data structure. Ensure headers are present.", "error");
                    return;
                }

                variables = results.meta.fields;
                parsedData = {};
                
                variables.forEach(v => parsedData[v] = []);

                let rowCount = 0;
                results.data.forEach(row => {
                    variables.forEach(v => {
                        if (typeof row[v] === 'number') {
                            parsedData[v].push(row[v]);
                        }
                    });
                    rowCount++;
                });

                dataMeta.innerText = `${rowCount} Rows • ${variables.length} Variables`;
                updateDropdowns();
                showToast("Data parsed successfully.", "success");
            }
        });
    }

    function updateDropdowns() {
        var1.innerHTML = '';
        var2.innerHTML = '';
        
        variables.forEach(v => {
            var1.add(new Option(v, v));
            var2.add(new Option(v, v));
        });

        if (variables.length > 1) {
            var2.selectedIndex = 1;
        }

        var1.disabled = false;
        var2.disabled = false;
        runTestBtn.disabled = false;
    }

    // --- Statistical Calculation Engine ---
    runTestBtn.addEventListener('click', () => {
        const type = testType.value;
        const v1 = var1.value;
        const v2 = var2.value;

        const array1 = parsedData[v1];
        const array2 = parsedData[v2];

        if (!array1 || !array1.length || !array2 || !array2.length) {
            showToast("Selected variables do not contain valid numeric data.", "error");
            return;
        }

        resultsContainer.classList.remove('hidden');

        try {
            if (type === 'ttest_ind') runIndependentTTest(v1, v2, array1, array2);
            else if (type === 'ttest_pair') runPairedTTest(v1, v2, array1, array2);
            else if (type === 'anova') runANOVA(v1, v2, array1, array2);
            else if (type === 'pearson') runPearson(v1, v2, array1, array2);
            
            renderTheory(type);
        } catch (error) {
            console.error(error);
            showToast("A mathematical error occurred. Check data for variance/length mismatch.", "error");
        }
    });

    // 1. Independent t-test (Corrected for robust pooled variance)
    function runIndependentTTest(name1, name2, arr1, arr2) {
        const n1 = arr1.length;
        const n2 = arr2.length;
        
        const mean1 = jStat.mean(arr1);
        const mean2 = jStat.mean(arr2);
        
        const var1 = jStat.variance(arr1, true); 
        const var2 = jStat.variance(arr2, true);

        const pooledVar = ((n1 - 1) * var1 + (n2 - 1) * var2) / (n1 + n2 - 2);
        const standardError = Math.sqrt(pooledVar * (1 / n1 + 1 / n2));
        
        const tScore = (mean1 - mean2) / standardError;
        const df = n1 + n2 - 2;
        
        const pVal = jStat.studentt.cdf(-Math.abs(tScore), df) * 2;

        renderResults("t", tScore, pVal);
        pubSummary.value = `An independent-samples t-test was conducted to compare ${name1} and ${name2}. There was a ${pVal < 0.05 ? 'significant' : 'non-significant'} difference in the scores for ${name1} (M=${mean1.toFixed(2)}, SD=${Math.sqrt(var1).toFixed(2)}) and ${name2} (M=${mean2.toFixed(2)}, SD=${Math.sqrt(var2).toFixed(2)}); t(${df}) = ${tScore.toFixed(3)}, p = ${formatPValue(pVal)}.`;
    }

    // 2. Paired T-Test
    function runPairedTTest(name1, name2, arr1, arr2) {
        if (arr1.length !== arr2.length) {
            showToast("Paired t-tests require arrays of equal length.", "error");
            return;
        }
        
        const diffs = arr1.map((val, i) => val - arr2[i]);
        const meanDiff = jStat.mean(diffs);
        const stdevDiff = jStat.stdev(diffs, true);
        const df = diffs.length - 1;
        
        const tScore = meanDiff / (stdevDiff / Math.sqrt(diffs.length));
        let pVal = jStat.studentt.cdf(-Math.abs(tScore), df) * 2;

        renderResults("t", tScore, pVal);
        pubSummary.value = `A paired-samples t-test was conducted to compare ${name1} and ${name2}. There was a ${pVal < 0.05 ? 'significant' : 'non-significant'} difference in the scores; t(${df}) = ${tScore.toFixed(3)}, p = ${formatPValue(pVal)}.`;
    }

    // 3. One-Way ANOVA
    function runANOVA(name1, name2, arr1, arr2) {
        const fScore = jStat.anovaftest(arr1, arr2);
        const dfBetween = 1; 
        const dfWithin = (arr1.length + arr2.length) - 2;
        const pVal = 1 - jStat.centralF.cdf(fScore, dfBetween, dfWithin);

        renderResults("F", fScore, pVal);
        pubSummary.value = `A one-way ANOVA was conducted to compare the effect of conditions on the dependent variable. An analysis of variance showed that the effect was ${pVal < 0.05 ? 'significant' : 'not significant'}, F(${dfBetween}, ${dfWithin}) = ${fScore.toFixed(3)}, p = ${formatPValue(pVal)}.`;
    }

    // 4. Pearson Correlation
    function runPearson(name1, name2, arr1, arr2) {
        if (arr1.length !== arr2.length) {
            showToast("Correlations require arrays of equal length.", "error");
            return;
        }

        const r = jStat.corrcoeff(arr1, arr2);
        const n = arr1.length;
        
        const tScore = r * Math.sqrt((n - 2) / (1 - r * r));
        const df = n - 2;
        const pVal = jStat.studentt.cdf(-Math.abs(tScore), df) * 2;

        renderResults("r", r, pVal);
        pubSummary.value = `A Pearson product-moment correlation was computed to assess the relationship between ${name1} and ${name2}. There was a ${pVal < 0.05 ? 'significant' : 'non-significant'} correlation between the two variables, r(${df}) = ${r.toFixed(3)}, p = ${formatPValue(pVal)}.`;
    }

    // --- Output Rendering Helpers ---
    function renderResults(statisticName, statisticValue, pValue) {
        statLabel.innerText = `${statisticName}-Statistic`;
        statValue.innerText = isNaN(statisticValue) ? "Error" : statisticValue.toFixed(4);
        
        if (isNaN(pValue)) {
            pValueEl.innerText = "Error";
            pValueEl.className = "text-2xl font-black text-red-600";
        } else {
            pValueEl.innerText = formatPValue(pValue);
            pValueEl.className = pValue < 0.05 
                ? "text-2xl font-black text-emerald-600 dark:text-emerald-400" 
                : "text-2xl font-black text-slate-600 dark:text-slate-400";
        }
    }

    function formatPValue(p) {
        if (p < 0.001) return "< .001";
        return p.toFixed(3);
    }

    // --- Mathematical Theory Injection ---
    function renderTheory(testType) {
        let latexString = "";
        
        if (testType === 'ttest_ind') {
            latexString = `
                \\text{Pooled Variance: } s_p^2 = \\frac{(n_1-1)s_1^2 + (n_2-1)s_2^2}{n_1+n_2-2} \\\\ \\\\
                \\text{T-Statistic: } t = \\frac{\\bar{x}_1 - \\bar{x}_2}{s_p \\sqrt{\\frac{1}{n_1} + \\frac{1}{n_2}}}
            `;
        } else if (testType === 'ttest_pair') {
            latexString = `
                \\text{Mean Difference: } \\bar{d} = \\frac{1}{n}\\sum_{i=1}^{n} d_i \\\\ \\\\
                \\text{T-Statistic: } t = \\frac{\\bar{d}}{s_d / \\sqrt{n}}
            `;
        } else if (testType === 'anova') {
            latexString = `
                \\text{F-Statistic: } F = \\frac{\\text{MS}_{between}}{\\text{MS}_{within}} \\\\ \\\\
                \\text{MS}_{between} = \\frac{\\sum n_i(\\bar{x}_i - \\bar{x})^2}{k-1}
            `;
        } else if (testType === 'pearson') {
            latexString = `
                \\text{Correlation Coefficient: } r = \\frac{\\sum (x_i - \\bar{x})(y_i - \\bar{y})}{\\sqrt{\\sum (x_i - \\bar{x})^2 \\sum (y_i - \\bar{y})^2}} \\\\ \\\\
                \\text{T-Statistic for p-value: } t = r \\sqrt{\\frac{n-2}{1-r^2}}
            `;
        }

        katex.render(latexString, theoryContainer, {
            displayMode: true,
            throwOnError: false
        });
    }

    // --- UI Interactions ---
    copyBtn.addEventListener('click', () => {
        pubSummary.select();
        document.execCommand('copy');
        showToast("Summary copied to clipboard.", "info");
    });

    function showToast(msg, type) {
        const container = document.getElementById('toastContainer');
        const toast = document.createElement('div');
        const colors = type === 'success' ? 'bg-emerald-50 text-emerald-800 border-emerald-200' : 
                       type === 'error' ? 'bg-red-50 text-red-800 border-red-200' : 
                       'bg-blue-50 text-blue-800 border-blue-200';
        
        toast.className = `px-4 py-3 rounded-xl border shadow-lg toast-enter text-sm font-medium transition-all ${colors}`;
        toast.innerText = msg;
        toast.style.animation = "slideIn 0.3s forwards";
        
        container.appendChild(toast);
        setTimeout(() => {
            toast.style.opacity = '0';
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }
});