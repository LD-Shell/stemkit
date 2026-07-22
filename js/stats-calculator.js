document.addEventListener("DOMContentLoaded", () => {

    /* ============================================================
       STEMKit Statistical Calculator — rigorous engine
       ------------------------------------------------------------
       Design notes
       - Core statistics are computed explicitly from well-defined
         formulas; jStat is used only for distribution CDFs/inverses
         (Student t, central F, standard normal).
       - Independent-samples default is WELCH'S t-test (does not assume
         equal variances). Student's pooled t is offered separately, and
         Levene's test flags when the equal-variance assumption fails.
       - ANOVA is a genuine one-way ANOVA across k >= 2 groups.
       - Every parametric test reports an effect size and, where standard,
         a 95% confidence interval. Normality (D'Agostino K^2) and, for
         group comparisons, homogeneity of variance (Levene) are checked
         and surfaced as assumption warnings with a non-parametric
         alternative suggested when appropriate.
       References for the formulas are in the Method & References section
       of the page.
       ============================================================ */

    // # --- 1. State ---
    let parsedData = {};
    let variables = [];

    const dataInput = document.getElementById('dataInput');
    const fileInput = document.getElementById('fileInput');
    const parseBtn = document.getElementById('parseBtn');
    const dataMeta = document.getElementById('dataMeta');

    const formatSelect = document.getElementById('formatSelect');
    const longControls = document.getElementById('longControls');
    const valueColSelect = document.getElementById('valueColSelect');
    const groupColSelect = document.getElementById('groupColSelect');
    let activeFormat = 'wide';

    const testType = document.getElementById('testType');
    const var1 = document.getElementById('var1');
    const var2 = document.getElementById('var2');
    const groupSelect = document.getElementById('groupSelect');       // multi-select for ANOVA (k groups)
    const twoVarRow = document.getElementById('twoVarRow');
    const groupRow = document.getElementById('groupRow');
    const runTestBtn = document.getElementById('runTestBtn');

    const resultsContainer = document.getElementById('resultsContainer');
    const statLabel = document.getElementById('statLabel');
    const statValue = document.getElementById('statValue');
    const pValueEl = document.getElementById('pValue');
    const effectLabel = document.getElementById('effectLabel');
    const effectValue = document.getElementById('effectValue');
    const ciBox = document.getElementById('ciBox');
    const assumptionsBox = document.getElementById('assumptionsBox');
    const pubSummary = document.getElementById('pubSummary');
    const copyBtn = document.getElementById('copyBtn');
    const theoryContainer = document.getElementById('theoryContainer');

    // # --- 2. Small statistics library (explicit, testable) ---
    const S = {
        mean: (a) => a.reduce((s, x) => s + x, 0) / a.length,
        // sample variance (n-1)
        variance(a) {
            const m = S.mean(a);
            return a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1);
        },
        sd: (a) => Math.sqrt(S.variance(a)),
        median(a) {
            const b = [...a].sort((x, y) => x - y);
            const n = b.length, mid = Math.floor(n / 2);
            return n % 2 ? b[mid] : (b[mid - 1] + b[mid]) / 2;
        },
        skewness(a) {
            const n = a.length, m = S.mean(a), sd = S.sd(a);
            if (sd === 0) return 0;
            const g1 = a.reduce((s, x) => s + Math.pow((x - m) / sd, 3), 0) / n;
            // bias-corrected (Fisher-Pearson)
            return Math.sqrt(n * (n - 1)) / (n - 2) * g1;
        },
        kurtosis(a) {
            const n = a.length, m = S.mean(a), sd = S.sd(a);
            if (sd === 0) return 0;
            const m4 = a.reduce((s, x) => s + Math.pow((x - m) / sd, 4), 0) / n;
            return m4 - 3; // excess kurtosis
        },
        // ranks with average ties (1-based)
        ranks(a) {
            const idx = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]);
            const r = new Array(a.length);
            let i = 0;
            while (i < idx.length) {
                let j = i;
                while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
                const avg = (i + j) / 2 + 1; // average rank (1-based)
                for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
                i = j + 1;
            }
            return r;
        }
    };

    // # --- 3. Distribution helpers via jStat ---
    const D = {
        tTwoSided: (t, df) => jStat.studentt.cdf(-Math.abs(t), df) * 2,
        tCrit: (df, conf = 0.95) => jStat.studentt.inv(1 - (1 - conf) / 2, df),
        fUpper: (f, d1, d2) => 1 - jStat.centralF.cdf(f, d1, d2),
        zTwoSided: (z) => 2 * (1 - jStat.normal.cdf(Math.abs(z), 0, 1)),
        chiUpper: (x, df) => 1 - jStat.chisquare.cdf(x, df)
    };

    // # --- 4. Assumption tests ---

    // D'Agostino-Pearson K^2 omnibus normality test.
    // Returns { K2, p, ok } where ok = fail-to-reject normality at .05.
    function dagostinoNormality(a) {
        const n = a.length;
        if (n < 8) return { K2: NaN, p: NaN, ok: null, note: "n < 8: normality not testable" };
        const b1 = S.skewness(a);
        const b2 = S.kurtosis(a) + 3; // convert excess -> raw kurtosis

        // Skewness test (D'Agostino 1970)
        const Y = b1 * Math.sqrt((n + 1) * (n + 3) / (6 * (n - 2)));
        const beta2 = 3 * (n * n + 27 * n - 70) * (n + 1) * (n + 3) /
                      ((n - 2) * (n + 5) * (n + 7) * (n + 9));
        const W2 = -1 + Math.sqrt(2 * (beta2 - 1));
        const delta = 1 / Math.sqrt(0.5 * Math.log(W2));
        const alpha = Math.sqrt(2 / (W2 - 1));
        const Zb1 = delta * Math.log(Y / alpha + Math.sqrt((Y / alpha) ** 2 + 1));

        // Kurtosis test (Anscombe-Glynn)
        const meanB2 = 3 * (n - 1) / (n + 1);
        const varB2 = 24 * n * (n - 2) * (n - 3) / ((n + 1) ** 2 * (n + 3) * (n + 5));
        const x = (b2 - meanB2) / Math.sqrt(varB2);
        const sqrtBeta1 = 6 * (n * n - 5 * n + 2) / ((n + 7) * (n + 9)) *
                          Math.sqrt(6 * (n + 3) * (n + 5) / (n * (n - 2) * (n - 3)));
        const A = 6 + 8 / sqrtBeta1 * (2 / sqrtBeta1 + Math.sqrt(1 + 4 / (sqrtBeta1 ** 2)));
        const term = (1 - 2 / A) / (1 + x * Math.sqrt(2 / (A - 4)));
        const Zb2 = ((1 - 2 / (9 * A)) - Math.cbrt(term)) / Math.sqrt(2 / (9 * A));

        const K2 = Zb1 * Zb1 + Zb2 * Zb2;
        const p = D.chiUpper(K2, 2);
        return { K2, p, ok: p > 0.05, note: null };
    }

    // Levene's test (Brown-Forsythe variant, using median) for k groups.
    function leveneTest(groups) {
        const k = groups.length;
        const N = groups.reduce((s, g) => s + g.length, 0);
        // Z_ij = |x_ij - median_i|
        const Z = groups.map(g => {
            const med = S.median(g);
            return g.map(x => Math.abs(x - med));
        });
        const Zbar = Z.map(z => S.mean(z));
        const Zgrand = S.mean(Z.flat());
        let num = 0, den = 0;
        for (let i = 0; i < k; i++) {
            num += Z[i].length * (Zbar[i] - Zgrand) ** 2;
            for (const zij of Z[i]) den += (zij - Zbar[i]) ** 2;
        }
        const W = ((N - k) / (k - 1)) * (num / den);
        const p = D.fUpper(W, k - 1, N - k);
        return { W, df1: k - 1, df2: N - k, p, ok: p > 0.05 };
    }

    // # --- 1b. Built-in tutorial datasets ---
    // Each embeds the raw CSV plus how to run it (format, test, and which
    // variables/groups to select) so a click fills, parses, selects and runs.
    const SAMPLES = {
        welch: {
            label: "Two groups (t-test)",
            desc: "Control vs Treatment — a clear, significant difference.",
            format: "wide", test: "ttest_welch", v1: "Control", v2: "Treatment",
            csv: `Control,Treatment
23.1,28.4
22.8,29.1
24.2,27.9
23.5,30.2
22.9,28.8
23.8,29.5
24.1,28.1
23.3,30.7
22.6,29.3
23.9,28.6`
        },
        anova: {
            label: "Three groups (ANOVA)",
            desc: "Placebo / LowDose / HighDose — increasing means.",
            format: "wide", test: "anova", groups: ["Placebo", "LowDose", "HighDose"],
            csv: `Placebo,LowDose,HighDose
5.2,6.8,9.1
4.9,7.1,8.7
5.5,6.5,9.4
5.1,7.3,8.9
4.8,6.9,9.2
5.3,7.0,8.6
5.0,6.7,9.5
5.4,7.2,8.8`
        },
        paired: {
            label: "Before / after (paired t)",
            desc: "Repeated measures on the same subjects.",
            format: "wide", test: "ttest_pair", v1: "Before", v2: "After",
            csv: `Before,After
120,112
135,128
128,119
142,133
118,115
150,139
133,124
127,121
145,138
122,116`
        },
        pearson: {
            label: "Correlation (Pearson)",
            desc: "Height vs weight — strong positive relationship.",
            format: "wide", test: "pearson", v1: "Height_cm", v2: "Weight_kg",
            csv: `Height_cm,Weight_kg
158,52
162,55
168,61
171,64
175,68
180,74
165,58
177,71
183,79
160,54`
        },
        longtidy: {
            label: "Long / tidy format",
            desc: "One value column split by a group label (R / pandas style).",
            format: "long", test: "anova", valueCol: "score", groupCol: "method", groups: ["A", "B", "C"],
            csv: `score,method
78,A
82,A
75,A
80,A
85,B
88,B
83,B
90,B
92,C
95,C
89,C
97,C`
        },
        nonparam: {
            label: "Outliers → non-parametric",
            desc: "Skewed data: the t-test is fooled, Mann–Whitney isn't.",
            format: "wide", test: "mannwhitney", v1: "GroupX", v2: "GroupY",
            csv: `GroupX,GroupY
1.1,2.0
1.2,2.1
1.0,1.9
1.3,2.2
1.1,2.0
1.2,15.5
1.0,1.8
14.8,2.1
1.1,2.0
1.2,18.2`
        }
    };

    // Group the tutorial chips by test family for the banner.
    const SAMPLE_GROUPS = [
        { heading: "t-tests", keys: ["welch", "paired"] },
        { heading: "ANOVA", keys: ["anova"] },
        { heading: "Correlation", keys: ["pearson"] },
        { heading: "Formats & robustness", keys: ["longtidy", "nonparam"] }
    ];

    function loadSample(key) {
        const s = SAMPLES[key];
        if (!s) return;
        // 1) fill data + format, then parse (synchronous for string input)
        if (formatSelect) formatSelect.value = s.format;
        dataInput.value = s.csv;
        parseData();

        // 2) for long format, choose the value/group columns then re-pivot
        if (s.format === 'long') {
            if (s.valueCol) valueColSelect.value = s.valueCol;
            if (s.groupCol) groupColSelect.value = s.groupCol;
            buildLongGroups();
        }

        // 3) select the test and its variables/groups
        testType.value = s.test;
        syncSelectorVisibility();
        if (s.test === 'anova') {
            const wanted = s.groups || variables;
            Array.from(groupSelect.options).forEach(o => { o.selected = wanted.includes(o.value); });
        } else {
            if (s.v1 && [...var1.options].some(o => o.value === s.v1)) var1.value = s.v1;
            if (s.v2 && [...var2.options].some(o => o.value === s.v2)) var2.value = s.v2;
        }

        // 4) set up complete — the user reviews and runs it themselves.
        //    Hide any prior result so a stale one isn't shown before they run,
        //    then guide their eye to the primed Run button.
        if (resultsContainer) resultsContainer.classList.add('hidden');
        if (runTestBtn) {
            runTestBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
            runTestBtn.classList.add('run-pulse');
            setTimeout(() => runTestBtn.classList.remove('run-pulse'), 1600);
        }
        showToast(`Loaded "${s.label}" — press Run Analysis to see the result.`, "info");
    }

    // Wire up tutorial banner (buttons carry data-sample) + dismissal.
    function initTutorialBanner() {
        document.querySelectorAll('[data-sample]').forEach(btn => {
            btn.addEventListener('click', () => loadSample(btn.getAttribute('data-sample')));
        });
        const banner = document.getElementById('tutorialBanner');
        const dismiss = document.getElementById('tutorialDismiss');
        const reopen = document.getElementById('tutorialReopen');
        if (dismiss && banner) dismiss.addEventListener('click', () => {
            banner.style.display = 'none';
            if (reopen) reopen.style.display = 'inline-flex';
            try { localStorage.statsTutorialDismissed = '1'; } catch (e) {}
        });
        if (reopen && banner) reopen.addEventListener('click', () => {
            banner.style.display = '';
            reopen.style.display = 'none';
            try { localStorage.removeItem('statsTutorialDismissed'); } catch (e) {}
        });
        // respect prior dismissal
        try {
            if (localStorage.statsTutorialDismissed === '1' && banner) {
                banner.style.display = 'none';
                if (reopen) reopen.style.display = 'inline-flex';
            }
        } catch (e) {}
    }

    // # --- 5. Parsing pipeline ---
    fileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (event) => { dataInput.value = event.target.result; parseData(); };
        reader.readAsText(file);
    });

    parseBtn.addEventListener('click', parseData);

    // Raw parse cache so the Long-format selectors can re-pivot without re-reading the textarea.
    let rawRows = [];        // array of row objects from Papa
    let rawFields = [];      // all header names
    let numericFields = [];  // fields that are mostly numeric
    let categoricalFields = []; // fields that look like group labels

    function classifyFields(rows, fields) {
        const numeric = [], categorical = [];
        fields.forEach(f => {
            let nNum = 0, nNonEmpty = 0;
            const distinct = new Set();
            rows.forEach(r => {
                const v = r[f];
                if (v === null || v === undefined || v === '') return;
                nNonEmpty++;
                if (typeof v === 'number' && !isNaN(v)) nNum++;
                distinct.add(v);
            });
            if (nNonEmpty === 0) return;
            const numericRatio = nNum / nNonEmpty;
            if (numericRatio >= 0.8) numeric.push(f);
            // a grouping column: mostly non-numeric OR a numeric code with few distinct levels
            if (numericRatio < 0.8 || (distinct.size >= 2 && distinct.size <= Math.max(10, rows.length / 3)))
                categorical.push(f);
        });
        return { numeric, categorical };
    }

    function parseData() {
        const rawText = dataInput.value.trim();
        if (!rawText) { showToast("Please input some data first.", "error"); return; }

        Papa.parse(rawText, {
            header: true, dynamicTyping: true, skipEmptyLines: true,
            delimitersToGuess: ['\t', ',', ';', '|', ' '],
            complete: function (results) {
                if (results.errors.length > 0 && results.data.length === 0) {
                    showToast("Error parsing data. Ensure the first row is a header.", "error");
                    return;
                }
                rawRows = results.data;
                rawFields = (results.meta.fields || []).filter(f => f && String(f).trim() !== '');
                const cls = classifyFields(rawRows, rawFields);
                numericFields = cls.numeric;
                categoricalFields = cls.categorical;

                // Auto-detect format: "long" if there's exactly one numeric column and
                // at least one categorical (grouping) column. Otherwise "wide".
                const chosen = formatSelect ? formatSelect.value : 'auto';
                let mode = chosen;
                if (chosen === 'auto') {
                    mode = (numericFields.length === 1 && categoricalFields.some(c => !numericFields.includes(c)))
                        ? 'long' : 'wide';
                }
                activeFormat = mode;

                if (mode === 'long') {
                    setupLongControls();
                    buildLongGroups(); // fills parsedData from value/group columns
                } else {
                    buildWideGroups();
                }

                showToast(`Parsed as ${mode === 'long' ? 'long / tidy' : 'wide'} format.`, "success");
            }
        });
    }

    // Wide format: each numeric column is its own variable/group.
    function buildWideGroups() {
        if (longControls) longControls.style.display = 'none';
        variables = [];
        parsedData = {};
        numericFields.forEach(v => {
            const arr = rawRows.map(r => r[v]).filter(x => typeof x === 'number' && !isNaN(x));
            if (arr.length) { parsedData[v] = arr; variables.push(v); }
        });
        dataMeta.innerText = `${rawRows.length} rows • ${variables.length} numeric column${variables.length === 1 ? '' : 's'} (wide)`;
        updateDropdowns();
    }

    // Long/tidy format: one value column split by the levels of a group column.
    function buildLongGroups() {
        const valueCol = valueColSelect.value;
        const groupCol = groupColSelect.value;
        if (!valueCol || !groupCol || valueCol === groupCol) {
            showToast("Pick distinct value and group columns.", "error");
            return;
        }
        parsedData = {};
        variables = [];
        const order = [];
        rawRows.forEach(r => {
            const val = r[valueCol];
            const grp = r[groupCol];
            if (grp === null || grp === undefined || grp === '') return;
            if (typeof val !== 'number' || isNaN(val)) return;
            const key = String(grp);
            if (!(key in parsedData)) { parsedData[key] = []; order.push(key); }
            parsedData[key].push(val);
        });
        variables = order.filter(k => parsedData[k].length > 0);
        dataMeta.innerText = `${rawRows.length} rows • ${variables.length} group${variables.length === 1 ? '' : 's'} of "${valueCol}" by "${groupCol}" (long)`;
        updateDropdowns();
    }

    // Build/refresh the Long-format value/group selectors.
    function setupLongControls() {
        if (!longControls) return;
        longControls.style.display = '';
        valueColSelect.innerHTML = '';
        groupColSelect.innerHTML = '';

        // Value column candidates: numeric fields (fall back to all fields).
        const valueCandidates = numericFields.length ? numericFields : rawFields.slice();
        valueCandidates.forEach(f => valueColSelect.add(new Option(f, f)));
        valueColSelect.selectedIndex = 0;
        const chosenValue = valueColSelect.value;

        // Group column candidates: any field that is NOT the chosen value column.
        // Prefer non-numeric (true label) columns; fall back to any other column.
        const nonNumeric = rawFields.filter(f => !numericFields.includes(f) && f !== chosenValue);
        const groupCandidates = (nonNumeric.length ? nonNumeric : rawFields.filter(f => f !== chosenValue));
        (groupCandidates.length ? groupCandidates : rawFields).forEach(f => groupColSelect.add(new Option(f, f)));
        groupColSelect.selectedIndex = 0;
    }

    function updateDropdowns() {
        var1.innerHTML = ''; var2.innerHTML = ''; groupSelect.innerHTML = '';
        variables.forEach(v => {
            var1.add(new Option(v, v));
            var2.add(new Option(v, v));
            const opt = new Option(`${v} (n=${parsedData[v].length})`, v);
            opt.selected = true;
            groupSelect.add(opt);
        });
        if (variables.length > 1) var2.selectedIndex = 1;
        var1.disabled = false; var2.disabled = false;
        groupSelect.disabled = false; runTestBtn.disabled = false;
    }

    // Toggle which selector is visible based on test type
    function syncSelectorVisibility() {
        const isAnova = testType.value === 'anova';
        twoVarRow.style.display = isAnova ? 'none' : '';
        groupRow.style.display = isAnova ? '' : 'none';
    }
    testType.addEventListener('change', syncSelectorVisibility);

    // Re-parse when the format override changes; re-pivot when long columns change.
    if (formatSelect) formatSelect.addEventListener('change', () => { if (rawRows.length) parseData(); });
    if (valueColSelect) valueColSelect.addEventListener('change', () => { if (activeFormat === 'long') buildLongGroups(); });
    if (groupColSelect) groupColSelect.addEventListener('change', () => { if (activeFormat === 'long') buildLongGroups(); });

    // # --- 6. Test runner ---
    function executeTest() {
        const type = testType.value;
        // Always show the formula for the selected test first, so the theory never
        // goes stale even if the data validation below fails.
        renderTheory(type === 'anova' ? 'anova' : type);
        try {
            if (type === 'anova') {
                const chosen = Array.from(groupSelect.selectedOptions).map(o => o.value);
                if (chosen.length < 2) { showToast("Select at least two groups for ANOVA.", "error"); return; }
                const groups = chosen.map(v => parsedData[v]);
                if (groups.some(g => !g || g.length < 2)) { showToast("Each group needs >= 2 numeric values.", "error"); return; }
                resultsContainer.classList.remove('hidden');
                runANOVA(chosen, groups);
                return;
            }

            const v1 = var1.value, v2 = var2.value;
            const a1 = parsedData[v1], a2 = parsedData[v2];
            if (!a1 || !a1.length || !a2 || !a2.length) {
                showToast("Selected variables contain no valid numeric data.", "error"); return;
            }
            resultsContainer.classList.remove('hidden');

            if (type === 'ttest_welch') runIndependentT(v1, v2, a1, a2, false);
            else if (type === 'ttest_ind') runIndependentT(v1, v2, a1, a2, true);
            else if (type === 'ttest_pair') runPairedT(v1, v2, a1, a2);
            else if (type === 'pearson') runPearson(v1, v2, a1, a2);
            else if (type === 'mannwhitney') runMannWhitney(v1, v2, a1, a2);
            else if (type === 'wilcoxon') runWilcoxon(v1, v2, a1, a2);
        } catch (err) {
            console.error(err);
            showToast("A mathematical error occurred. Check data for variance/length issues.", "error");
        }
    }
    runTestBtn.addEventListener('click', executeTest);

    // ---- Independent t-test: Welch (default) or Student pooled ----
    function runIndependentT(n1Name, n2Name, arr1, arr2, pooled) {
        const n1 = arr1.length, n2 = arr2.length;
        const m1 = S.mean(arr1), m2 = S.mean(arr2);
        const v1 = S.variance(arr1), v2 = S.variance(arr2);
        const diff = m1 - m2;

        let se, df, method;
        if (pooled) {
            const sp2 = ((n1 - 1) * v1 + (n2 - 1) * v2) / (n1 + n2 - 2);
            se = Math.sqrt(sp2 * (1 / n1 + 1 / n2));
            df = n1 + n2 - 2;
            method = "Student's independent-samples t-test (pooled variance)";
        } else {
            se = Math.sqrt(v1 / n1 + v2 / n2);
            // Welch-Satterthwaite df
            df = Math.pow(v1 / n1 + v2 / n2, 2) /
                 (Math.pow(v1 / n1, 2) / (n1 - 1) + Math.pow(v2 / n2, 2) / (n2 - 1));
            method = "Welch's independent-samples t-test (unequal variances)";
        }
        const t = diff / se;
        const p = D.tTwoSided(t, df);

        // Cohen's d (pooled SD regardless, standard for effect size)
        const sPooled = Math.sqrt(((n1 - 1) * v1 + (n2 - 1) * v2) / (n1 + n2 - 2));
        const d = diff / sPooled;
        // Hedges' g small-sample correction
        const J = 1 - 3 / (4 * (n1 + n2) - 9);
        const g = d * J;

        // 95% CI for the mean difference
        const tc = D.tCrit(df, 0.95);
        const ciLo = diff - tc * se, ciHi = diff + tc * se;

        renderResults("t", t, p, "Cohen's d", d);
        renderCI(`95% CI for mean difference: [${ciLo.toFixed(3)}, ${ciHi.toFixed(3)}]  (Hedges' g = ${g.toFixed(3)})`);

        // Assumptions
        const norm1 = dagostinoNormality(arr1), norm2 = dagostinoNormality(arr2);
        const lev = leveneTest([arr1, arr2]);
        const warns = [];
        if (norm1.ok === false || norm2.ok === false)
            warns.push({ level: 'warn', text: `Normality (D'Agostino K²) is questionable for ${norm1.ok === false ? n1Name : ''}${(norm1.ok === false && norm2.ok === false) ? ' & ' : ''}${norm2.ok === false ? n2Name : ''}. Consider the Mann–Whitney U test.` });
        if (lev.ok === false && pooled)
            warns.push({ level: 'warn', text: `Levene's test is significant (W=${lev.W.toFixed(2)}, p=${fmtP(lev.p)}): variances differ. Prefer Welch's t-test over the pooled version.` });
        if (lev.ok !== false && !pooled)
            warns.push({ level: 'ok', text: `Levene's test not significant (p=${fmtP(lev.p)}): equal-variance assumption is tenable; Student's pooled t would also be valid.` });
        renderAssumptions(warns, `Levene W(${lev.df1}, ${lev.df2}) = ${lev.W.toFixed(3)}, p = ${fmtP(lev.p)} · Normality p: ${n1Name}=${fmtP(norm1.p)}, ${n2Name}=${fmtP(norm2.p)}`);

        const dInterp = interpretD(Math.abs(d));
        pubSummary.value =
`${cap(method)} compared ${n1Name} (M = ${m1.toFixed(2)}, SD = ${Math.sqrt(v1).toFixed(2)}, n = ${n1}) and ${n2Name} (M = ${m2.toFixed(2)}, SD = ${Math.sqrt(v2).toFixed(2)}, n = ${n2}). The difference was ${p < 0.05 ? 'statistically significant' : 'not statistically significant'}, t(${df.toFixed(2)}) = ${t.toFixed(3)}, p = ${fmtP(p)}, 95% CI [${ciLo.toFixed(2)}, ${ciHi.toFixed(2)}], Cohen's d = ${d.toFixed(2)} (${dInterp}).`;
    }

    // ---- Paired t-test ----
    function runPairedT(n1Name, n2Name, arr1, arr2) {
        const paired = alignPairs(arr1, arr2);
        if (paired.a.length < 2) { showToast("Paired tests need >= 2 complete pairs.", "error"); return; }
        const d = paired.a.map((v, i) => v - paired.b[i]);
        const n = d.length;
        const md = S.mean(d), sd = S.sd(d);
        const se = sd / Math.sqrt(n);
        const t = md / se, df = n - 1;
        const p = D.tTwoSided(t, df);

        const dz = md / sd; // Cohen's d_z for paired design
        const tc = D.tCrit(df, 0.95);
        const ciLo = md - tc * se, ciHi = md + tc * se;

        renderResults("t", t, p, "Cohen's dz", dz);
        renderCI(`95% CI for mean difference: [${ciLo.toFixed(3)}, ${ciHi.toFixed(3)}]  (n = ${n} pairs)`);

        const normD = dagostinoNormality(d);
        const warns = [];
        if (normD.ok === false)
            warns.push({ level: 'warn', text: `Normality of the differences is questionable (D'Agostino p=${fmtP(normD.p)}). Consider the Wilcoxon signed-rank test.` });
        else if (normD.ok === true)
            warns.push({ level: 'ok', text: `Differences are consistent with normality (D'Agostino p=${fmtP(normD.p)}).` });
        renderAssumptions(warns, `Test operates on ${n} paired differences.`);

        pubSummary.value =
`A paired-samples t-test compared ${n1Name} and ${n2Name} (n = ${n} pairs). The mean difference was ${md.toFixed(2)} (SD = ${sd.toFixed(2)}); the effect was ${p < 0.05 ? 'statistically significant' : 'not statistically significant'}, t(${df}) = ${t.toFixed(3)}, p = ${fmtP(p)}, 95% CI [${ciLo.toFixed(2)}, ${ciHi.toFixed(2)}], Cohen's dz = ${dz.toFixed(2)} (${interpretD(Math.abs(dz))}).`;
    }

    // ---- One-way ANOVA across k groups ----
    function runANOVA(names, groups) {
        const k = groups.length;
        const N = groups.reduce((s, g) => s + g.length, 0);
        const grand = S.mean(groups.flat());
        let ssB = 0, ssW = 0;
        groups.forEach(g => {
            const m = S.mean(g);
            ssB += g.length * (m - grand) ** 2;
            g.forEach(x => ssW += (x - m) ** 2);
        });
        const dfB = k - 1, dfW = N - k;
        const msB = ssB / dfB, msW = ssW / dfW;
        const F = msB / msW;
        const p = D.fUpper(F, dfB, dfW);

        const ssT = ssB + ssW;
        const eta2 = ssB / ssT;                       // eta-squared
        const omega2 = (ssB - dfB * msW) / (ssT + msW); // omega-squared (less biased)

        renderResults("F", F, p, "η²", eta2);
        renderCI(`η² = ${eta2.toFixed(3)}, ω² = ${omega2.toFixed(3)} · groups: ${names.join(', ')}`);

        // Assumptions
        const lev = leveneTest(groups);
        const norms = groups.map(g => dagostinoNormality(g));
        const anyNonNormal = norms.some(x => x.ok === false);
        const warns = [];
        if (lev.ok === false)
            warns.push({ level: 'warn', text: `Levene's test is significant (W=${lev.W.toFixed(2)}, p=${fmtP(lev.p)}): group variances differ. Consider Welch's ANOVA or a Kruskal–Wallis test.` });
        else
            warns.push({ level: 'ok', text: `Levene's test not significant (p=${fmtP(lev.p)}): homogeneity of variance is tenable.` });
        if (anyNonNormal)
            warns.push({ level: 'warn', text: `At least one group departs from normality (D'Agostino). With small, unequal groups consider a non-parametric alternative.` });
        renderAssumptions(warns, `Levene W(${lev.df1}, ${lev.df2}) = ${lev.W.toFixed(3)}, p = ${fmtP(lev.p)}`);

        const groupDesc = names.map((nm, i) => `${nm} (M=${S.mean(groups[i]).toFixed(2)}, SD=${S.sd(groups[i]).toFixed(2)}, n=${groups[i].length})`).join('; ');
        pubSummary.value =
`A one-way ANOVA compared ${k} groups: ${groupDesc}. The effect was ${p < 0.05 ? 'statistically significant' : 'not statistically significant'}, F(${dfB}, ${dfW}) = ${F.toFixed(3)}, p = ${fmtP(p)}, η² = ${eta2.toFixed(3)} (${interpretEta(eta2)}), ω² = ${omega2.toFixed(3)}.${p < 0.05 && k > 2 ? ' Post-hoc pairwise comparisons (e.g. Tukey HSD) are recommended to locate the differences.' : ''}`;
    }

    // ---- Pearson correlation ----
    function runPearson(n1Name, n2Name, arr1, arr2) {
        const paired = alignPairs(arr1, arr2);
        if (paired.a.length < 3) { showToast("Correlation needs >= 3 complete pairs.", "error"); return; }
        const x = paired.a, y = paired.b, n = x.length;
        const mx = S.mean(x), my = S.mean(y);
        let sxy = 0, sxx = 0, syy = 0;
        for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
        const r = sxy / Math.sqrt(sxx * syy);
        const df = n - 2;
        const t = r * Math.sqrt(df / (1 - r * r));
        const p = D.tTwoSided(t, df);

        // Fisher z 95% CI for r
        const z = 0.5 * Math.log((1 + r) / (1 - r));
        const sez = 1 / Math.sqrt(n - 3);
        const zc = jStat.normal.inv(0.975, 0, 1);
        const rLo = Math.tanh(z - zc * sez), rHi = Math.tanh(z + zc * sez);

        renderResults("r", r, p, "r²", r * r);
        renderCI(`95% CI for r: [${rLo.toFixed(3)}, ${rHi.toFixed(3)}]  ·  r² = ${(r * r).toFixed(3)} (${(100 * r * r).toFixed(1)}% shared variance)`);

        const normX = dagostinoNormality(x), normY = dagostinoNormality(y);
        const warns = [];
        if (normX.ok === false || normY.ok === false)
            warns.push({ level: 'warn', text: `One or both variables depart from normality. Pearson's r assumes bivariate normality for its p-value; consider Spearman's ρ for monotonic, non-normal relationships.` });
        renderAssumptions(warns, `Normality p: ${n1Name}=${fmtP(normX.p)}, ${n2Name}=${fmtP(normY.p)} · n=${n} pairs`);

        pubSummary.value =
`A Pearson product–moment correlation assessed the relationship between ${n1Name} and ${n2Name} (n = ${n}). The correlation was ${p < 0.05 ? 'statistically significant' : 'not statistically significant'}, r(${df}) = ${r.toFixed(3)}, p = ${fmtP(p)}, 95% CI [${rLo.toFixed(2)}, ${rHi.toFixed(2)}]; r² = ${(r * r).toFixed(3)} indicates ${(100 * r * r).toFixed(1)}% shared variance (${interpretR(Math.abs(r))}).`;
    }

    // ---- Mann–Whitney U (independent, non-parametric) ----
    function runMannWhitney(n1Name, n2Name, arr1, arr2) {
        const n1 = arr1.length, n2 = arr2.length;
        const combined = arr1.concat(arr2);
        const r = S.ranks(combined);
        const R1 = r.slice(0, n1).reduce((s, x) => s + x, 0);
        const U1 = R1 - n1 * (n1 + 1) / 2;
        const U2 = n1 * n2 - U1;
        const U = Math.min(U1, U2);

        // Normal approximation with tie correction
        const muU = n1 * n2 / 2;
        // tie correction
        const counts = {};
        combined.forEach(v => counts[v] = (counts[v] || 0) + 1);
        const N = n1 + n2;
        const tieTerm = Object.values(counts).reduce((s, t) => s + (t ** 3 - t), 0);
        const sigmaU = Math.sqrt(n1 * n2 / 12 * ((N + 1) - tieTerm / (N * (N - 1))));
        const zc = (U - muU + 0.5 * Math.sign(muU - U)) / sigmaU; // continuity-corrected
        const z = (U - muU) / sigmaU;
        const p = D.zTwoSided(z);

        // Rank-biserial effect size
        const rb = 1 - (2 * U) / (n1 * n2);

        renderResults("U", U, p, "rank-biserial r", rb);
        renderCI(`z = ${z.toFixed(3)} (normal approximation${tieTerm ? ', tie-corrected' : ''}) · medians: ${n1Name}=${S.median(arr1).toFixed(2)}, ${n2Name}=${S.median(arr2).toFixed(2)}`);
        renderAssumptions([{ level: 'ok', text: `Non-parametric: no normality assumption. Tests whether one distribution is stochastically shifted relative to the other.` }], `n₁=${n1}, n₂=${n2}. Normal approximation used; for very small n consult exact U tables.`);

        pubSummary.value =
`A Mann–Whitney U test compared ${n1Name} (Mdn = ${S.median(arr1).toFixed(2)}, n = ${n1}) and ${n2Name} (Mdn = ${S.median(arr2).toFixed(2)}, n = ${n2}). The difference was ${p < 0.05 ? 'statistically significant' : 'not statistically significant'}, U = ${U.toFixed(1)}, z = ${z.toFixed(3)}, p = ${fmtP(p)}, rank-biserial r = ${rb.toFixed(2)}.`;
    }

    // ---- Wilcoxon signed-rank (paired, non-parametric) ----
    function runWilcoxon(n1Name, n2Name, arr1, arr2) {
        const paired = alignPairs(arr1, arr2);
        const diffs = paired.a.map((v, i) => v - paired.b[i]).filter(d => d !== 0);
        const n = diffs.length;
        if (n < 1) { showToast("No non-zero differences to test.", "error"); return; }
        const absRanks = S.ranks(diffs.map(Math.abs));
        let Wpos = 0, Wneg = 0;
        diffs.forEach((d, i) => { if (d > 0) Wpos += absRanks[i]; else Wneg += absRanks[i]; });
        const W = Math.min(Wpos, Wneg);

        const muW = n * (n + 1) / 4;
        const sigmaW = Math.sqrt(n * (n + 1) * (2 * n + 1) / 24);
        const z = (W - muW) / sigmaW;
        const p = D.zTwoSided(z);
        const rb = Math.abs(z) / Math.sqrt(n); // matched-pairs rank-biserial (approx via z)

        renderResults("W", W, p, "effect r (z/√n)", rb);
        renderCI(`z = ${z.toFixed(3)} (normal approximation) · n = ${n} non-zero differences`);
        renderAssumptions([{ level: 'ok', text: `Non-parametric paired test: assumes symmetric distribution of differences, not normality.` }], `Zeros dropped; normal approximation used (recommended for n ≳ 20).`);

        pubSummary.value =
`A Wilcoxon signed-rank test compared ${n1Name} and ${n2Name} (n = ${n} non-zero differences). The difference was ${p < 0.05 ? 'statistically significant' : 'not statistically significant'}, W = ${W.toFixed(1)}, z = ${z.toFixed(3)}, p = ${fmtP(p)}, effect r = ${rb.toFixed(2)}.`;
    }

    // # --- 7. Helpers ---
    function alignPairs(a, b) {
        // Pair by index up to the shorter length (both already numeric-filtered per column).
        const n = Math.min(a.length, b.length);
        return { a: a.slice(0, n), b: b.slice(0, n) };
    }
    const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
    function fmtP(p) {
        if (isNaN(p)) return "n/a";
        if (p < 0.001) return "< .001";
        return p.toFixed(3).replace(/^0/, '');
    }
    function interpretD(d) {
        if (d < 0.2) return "negligible"; if (d < 0.5) return "small";
        if (d < 0.8) return "medium"; return "large";
    }
    function interpretEta(e) {
        if (e < 0.01) return "negligible"; if (e < 0.06) return "small";
        if (e < 0.14) return "medium"; return "large";
    }
    function interpretR(r) {
        if (r < 0.1) return "negligible"; if (r < 0.3) return "weak";
        if (r < 0.5) return "moderate"; return "strong";
    }

    // # --- 8. Output rendering ---
    function renderResults(statName, statVal, pVal, effName, effVal) {
        statLabel.innerText = `${statName}-Statistic`;
        statValue.innerText = isNaN(statVal) ? "Error" : (+statVal.toFixed(4)).toString();
        if (isNaN(pVal)) {
            pValueEl.innerText = "Error";
            pValueEl.className = "text-2xl font-black text-red-600";
        } else {
            pValueEl.innerText = fmtP(pVal);
            pValueEl.className = pVal < 0.05
                ? "text-2xl font-black text-emerald-600 dark:text-emerald-400"
                : "text-2xl font-black text-slate-600 dark:text-slate-400";
        }
        if (effectLabel && effectValue) {
            effectLabel.innerHTML = effName;
            effectValue.innerText = isNaN(effVal) ? "--" : (+effVal.toFixed(3)).toString();
        }
    }
    function renderCI(text) { if (ciBox) { ciBox.innerHTML = `<i class="fa-solid fa-arrows-left-right-to-line mr-1" style="color:#6366f1"></i> ${text}`; ciBox.style.display = 'block'; } }
    function renderAssumptions(warns, footer) {
        if (!assumptionsBox) return;
        const rows = warns.map(w => {
            const icon = w.level === 'warn'
                ? '<i class="fa-solid fa-triangle-exclamation ico-warn"></i>'
                : '<i class="fa-solid fa-circle-check ico-ok"></i>';
            return `<div class="assume-row">${icon}<span>${w.text}</span></div>`;
        }).join('');
        assumptionsBox.innerHTML =
            `<div class="assume-title"><i class="fa-solid fa-clipboard-check"></i> Assumption checks</div>
             <div class="assume-rows">${rows || '<span class="assume-none">No assumption warnings.</span>'}</div>
             ${footer ? `<div class="assume-foot">${footer}</div>` : ''}`;
        assumptionsBox.style.display = 'block';
    }

    function renderTheory(t) {
        // Formulas and the variable legend are rendered with KaTeX (self-hosted).
        // Each definition's symbol is a small inline KaTeX snippet so it matches
        // the formula above exactly.
        const FORMULAS = {
            ttest_welch: String.raw`\begin{aligned}
                t &= \frac{\bar{x}_1 - \bar{x}_2}{\sqrt{\dfrac{s_1^2}{n_1} + \dfrac{s_2^2}{n_2}}} \\[10pt]
                \nu &= \frac{\left(\dfrac{s_1^2}{n_1}+\dfrac{s_2^2}{n_2}\right)^2}
                          {\dfrac{(s_1^2/n_1)^2}{n_1-1}+\dfrac{(s_2^2/n_2)^2}{n_2-1}}
            \end{aligned}`,
            ttest_ind: String.raw`\begin{aligned}
                s_p^2 &= \frac{(n_1-1)s_1^2 + (n_2-1)s_2^2}{n_1+n_2-2} \\[8pt]
                t &= \frac{\bar{x}_1 - \bar{x}_2}{s_p \sqrt{\dfrac{1}{n_1} + \dfrac{1}{n_2}}},
                \qquad d = \frac{\bar{x}_1-\bar{x}_2}{s_p}
            \end{aligned}`,
            ttest_pair: String.raw`\begin{aligned}
                \bar{d} &= \frac{1}{n}\sum_{i=1}^{n} d_i \\[6pt]
                t &= \frac{\bar{d}}{s_d / \sqrt{n}}, \qquad d_z = \frac{\bar{d}}{s_d}
            \end{aligned}`,
            anova: String.raw`\begin{aligned}
                F &= \frac{MS_{\text{between}}}{MS_{\text{within}}}
                   = \frac{SS_B/(k-1)}{SS_W/(N-k)} \\[6pt]
                \eta^2 &= \frac{SS_B}{SS_B+SS_W}
            \end{aligned}`,
            pearson: String.raw`\begin{aligned}
                r &= \frac{\sum (x_i-\bar{x})(y_i-\bar{y})}
                          {\sqrt{\sum (x_i-\bar{x})^2 \; \sum (y_i-\bar{y})^2}} \\[6pt]
                t &= r\sqrt{\frac{n-2}{1-r^2}}
            \end{aligned}`,
            mannwhitney: String.raw`\begin{aligned}
                U_1 &= R_1 - \frac{n_1(n_1+1)}{2} \\[6pt]
                z &= \frac{U - \mu_U}{\sigma_U}, \qquad \mu_U = \frac{n_1 n_2}{2}
            \end{aligned}`,
            wilcoxon: String.raw`\begin{aligned}
                W &= \min(W_+,\, W_-) \\[6pt]
                z &= \frac{W - \frac{n(n+1)}{4}}{\sqrt{\dfrac{n(n+1)(2n+1)}{24}}}
            \end{aligned}`
        };

        // Variable legend: [ LaTeX symbol , plain-text meaning ] per test.
        const DEFS = {
            ttest_welch: [
                [`t`, `test statistic`],
                [`\\bar{x}_1,\\ \\bar{x}_2`, `sample means of the two groups`],
                [`s_1^2,\\ s_2^2`, `sample variances (n\u1D62\u22121 denominator)`],
                [`n_1,\\ n_2`, `sample sizes`],
                [`\\nu`, `Welch\u2013Satterthwaite degrees of freedom`]
            ],
            ttest_ind: [
                [`t`, `test statistic`],
                [`s_p^2`, `pooled variance (assumes equal variances)`],
                [`\\bar{x}_1,\\ \\bar{x}_2`, `sample means`],
                [`s_1^2,\\ s_2^2`, `sample variances`],
                [`n_1,\\ n_2`, `sample sizes; df = n\u2081+n\u2082\u22122`],
                [`d`, `Cohen\u2019s d effect size`]
            ],
            ttest_pair: [
                [`d_i`, `difference for pair i (x\u1D62 \u2212 y\u1D62)`],
                [`\\bar{d}`, `mean of the paired differences`],
                [`s_d`, `standard deviation of the differences`],
                [`n`, `number of pairs; df = n\u22121`],
                [`d_z`, `Cohen\u2019s d for paired data`]
            ],
            anova: [
                [`F`, `test statistic (ratio of variances)`],
                [`MS_{\\text{between}}`, `mean square between groups = SS_B/(k\u22121)`],
                [`MS_{\\text{within}}`, `mean square within groups = SS_W/(N\u2212k)`],
                [`SS_B,\\ SS_W`, `between- and within-group sums of squares`],
                [`k,\\ N`, `number of groups; total observations`],
                [`\\eta^2`, `eta squared, proportion of variance explained`]
            ],
            pearson: [
                [`r`, `Pearson correlation coefficient (\u22121 to 1)`],
                [`x_i,\\ y_i`, `paired observations`],
                [`\\bar{x},\\ \\bar{y}`, `means of x and y`],
                [`n`, `number of pairs; df = n\u22122`],
                [`t`, `statistic used to test whether r \u2260 0`]
            ],
            mannwhitney: [
                [`U`, `Mann\u2013Whitney statistic (min of U\u2081, U\u2082)`],
                [`R_1`, `sum of ranks in group 1`],
                [`n_1,\\ n_2`, `group sizes`],
                [`\\mu_U,\\ \\sigma_U`, `mean and SD of U under the null`],
                [`z`, `normal approximation used for the p-value`]
            ],
            wilcoxon: [
                [`W`, `Wilcoxon signed-rank statistic`],
                [`W_+,\\ W_-`, `sums of positive / negative signed ranks`],
                [`n`, `number of non-zero differences`],
                [`z`, `normal approximation used for the p-value`]
            ]
        };

        if (!theoryContainer) return;
        const formula = FORMULAS[t];
        const defs = DEFS[t];
        if (!formula) { theoryContainer.innerHTML = ''; return; }

        const kx = (tex, display) => {
            if (!window.katex) return null;
            try { return katex.renderToString(tex, { displayMode: !!display, throwOnError: false, output: "html" }); }
            catch (e) { return null; }
        };

        const formulaHtml = kx(formula, true);
        if (formulaHtml === null) {
            theoryContainer.innerHTML = '<span class="text-slate-400 text-sm">Formula renderer unavailable.</span>';
            return;
        }

        let defsHtml = '';
        if (defs) {
            const items = defs.map(([sym, meaning]) => {
                const symHtml = kx(sym, false) || sym;
                return `<div class="mf-def"><dt>${symHtml}</dt><dd>${meaning}</dd></div>`;
            }).join('');
            defsHtml = `<div class="mf-defs"><div class="mf-defs-title">Where:</div><dl>${items}</dl></div>`;
        }
        theoryContainer.innerHTML = formulaHtml + defsHtml;
    }

    copyBtn.addEventListener('click', () => {
        pubSummary.select();
        navigator.clipboard.writeText(pubSummary.value).then(
            () => showToast("Summary copied to clipboard.", "info"),
            () => { document.execCommand('copy'); showToast("Summary copied.", "info"); }
        );
    });

    // Documentation engine tabs (Method & References)
    document.querySelectorAll('.doc-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            const key = tab.getAttribute('data-doc-tab');
            document.querySelectorAll('.doc-tab').forEach(x => x.classList.toggle('active', x === tab));
            document.querySelectorAll('.doc-pane').forEach(pane => pane.classList.toggle('active', pane.getAttribute('data-doc-pane') === key));
        });
    });

    function showToast(msg, type) {
        const container = document.getElementById('toastContainer');
        const toast = document.createElement('div');
        const colors = type === 'success' ? 'bg-emerald-50 text-emerald-800 border-emerald-200 dark:bg-emerald-900/40 dark:text-emerald-200 dark:border-emerald-800' :
                       type === 'error' ? 'bg-red-50 text-red-800 border-red-200 dark:bg-red-900/40 dark:text-red-200 dark:border-red-800' :
                       'bg-blue-50 text-blue-800 border-blue-200 dark:bg-blue-900/40 dark:text-blue-200 dark:border-blue-800';
        toast.className = `px-4 py-3 rounded-xl border shadow-lg toast-enter text-sm font-medium transition-all ${colors}`;
        toast.innerText = msg;
        toast.style.animation = "slideIn 0.3s forwards";
        container.appendChild(toast);
        setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 300); }, 3000);
    }

    // initial selector visibility
    syncSelectorVisibility();
    initTutorialBanner();
});
