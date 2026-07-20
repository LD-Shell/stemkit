document.addEventListener('DOMContentLoaded', () => {

    // =========================================================================
    // 1. Matching engine
    // -------------------------------------------------------------------------
    // The dictionary lives in js/journal-data.js (window.STEMKIT_JOURNALS) as
    // simple ["Full Name", "Abbrev."] pairs — edit that file to add journals.
    // Users can also add rules at runtime via the "Custom abbreviations" panel
    // (persisted in localStorage, custom rules override built-ins).
    //
    // From each name the engine derives ONE canonical key and ONE regex
    // fragment that tolerate: a leading "The", "&" vs "and", optional colons/
    // commas, hyphen vs en/em dash, and any whitespace (including line wraps).
    // =========================================================================

    const CUSTOM_STORE_KEY = 'stemkit-journal-custom-rules';

    // Canonical form used to look up a matched string in the dictionary.
    function normKey(s) {
        return s.toLowerCase()
            .replace(/&/g, ' and ')
            .replace(/[\u2013\u2014-]/g, ' ')   // dashes -> space
            .replace(/[:,.]/g, ' ')             // punctuation -> space
            .replace(/\s+/g, ' ')
            .trim()
            .replace(/^the /, '');
    }

    // Regex fragment for one journal name (leading "The" is handled globally).
    function toPatternPart(name) {
        const canonical = name.replace(/^the\s+/i, '');
        return canonical
            .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            .replace(/\s*[-\u2013\u2014]\s*/g, '\x01')
            .replace(/\s*&\s*/g, '\x02')
            .replace(/[:,]/g, '\x03')
            .replace(/\s+/g, '\\s+')
            .replace(/\x01/g, '(?:\\s*[-\\u2013\\u2014]\\s*|\\s+)')
            .replace(/\x02/g, '\\s+(?:&|and)\\s+')
            .replace(/\x03/g, '[:,]?');
    }

    // "Full Journal Name = Abbrev." per line; '#' starts a comment line.
    function parseCustomRules(text) {
        const rules = [];
        (text || '').split(/\r?\n/).forEach(line => {
            const t = line.trim();
            if (!t || t.startsWith('#')) return;
            const i = t.indexOf('=');
            if (i < 1) return;
            const name = t.slice(0, i).trim();
            const abbr = t.slice(i + 1).trim();
            if (name && abbr) rules.push([name, abbr]);
        });
        return rules;
    }

    let lookup = {};            // normKey -> abbreviation
    let searchPattern = null;   // compiled regex over all names
    let builtinCount = 0;
    let customCount = 0;

    function rebuildEngine(customText) {
        const builtin = Array.isArray(window.STEMKIT_JOURNALS) ? window.STEMKIT_JOURNALS : [];
        const custom = parseCustomRules(customText);

        lookup = {};
        const displayNames = new Map();   // normKey -> display name (dedup)

        // Custom rules are added last so they override built-in entries.
        [...builtin, ...custom].forEach(([name, abbr]) => {
            if (!name || !abbr) return;
            const key = normKey(name);
            if (!key) return;
            lookup[key] = abbr;
            displayNames.set(key, name);
        });

        builtinCount = builtin.length;
        customCount = custom.length;

        // Longest names first so full titles beat any embedded shorter title.
        const parts = [...displayNames.values()]
            .sort((a, b) => b.length - a.length)
            .map(toPatternPart);

        searchPattern = parts.length
            ? new RegExp(`\\b(?:the\\s+)?(?:${parts.join('|')})\\b`, 'gi')
            : null;
    }

    // Heuristic: flag likely journal titles the dictionary does NOT know, so
    // nothing silently slips through ("N Unknown" in the stats badge).
    const SUSPECT_TITLE = new RegExp(
        '\\b(?:(?:International|European|American|Annual|Canadian|Australian|Applied|Russian|Chinese|Japanese)\\s+)?' +
        '(?:Journal|Proceedings|Transactions|Annals|Reviews?)\\s+(?:of|in|on)\\s+(?:the\\s+)?' +
        '[A-Z][\\w&-]*(?:\\s+(?:(?:of|and|in|for|the)\\s+)?[A-Z][\\w&-]*){0,6}',
        'g'
    );

    // =========================================================================
    // 2. Interface bindings
    // =========================================================================
    const dataInput = document.getElementById('dataInput');
    const visualOutput = document.getElementById('visualOutput');
    const rawOutput = document.getElementById('rawOutput');
    const btnClear = document.getElementById('btnClear');
    const btnCopyText = document.getElementById('btnCopyText');
    const btnExample = document.getElementById('btnExample');       // optional
    const toggleHighlights = document.getElementById('toggleHighlights');
    const statsLabel = document.getElementById('statsLabel');
    const toastContainer = document.getElementById('toastContainer');
    const customRules = document.getElementById('customRules');     // optional
    const dictLabel = document.getElementById('dictLabel');         // optional

    const EXAMPLE = [
        "Smith, J.; Doe, A. Journal of the American Chemical Society 2024, 146, 1122.",
        "Lee, K. et al. Physical Review Letters 2023, 130, 045501.",
        "Patel, R. Chemical Communications 2022, 58, 8890.",
        "Nguyen, T. energy & environmental science 2021, 14, 4561.",
        "Garcia, M. The Journal of Chemical Physics 2020, 153, 044302.",
        "Zhou, L. Journal of Physics: Condensed Matter 2019, 31, 275901.",
        "Okafor, C. Journal of Imaginary Results 2018, 3, 12."
    ].join("\n");

    // =========================================================================
    // 3. Event listeners
    // =========================================================================
    dataInput.addEventListener('input', processText);
    toggleHighlights.addEventListener('change', processText);

    btnClear.addEventListener('click', () => {
        dataInput.value = '';
        processText();
    });

    if (btnExample) {
        btnExample.addEventListener('click', () => {
            dataInput.value = EXAMPLE;
            processText();
        });
    }

    if (customRules) {
        // Restore saved rules, rebuild (debounced) on edit.
        try {
            const saved = localStorage.getItem(CUSTOM_STORE_KEY);
            if (saved) customRules.value = saved;
        } catch (e) { /* storage unavailable — run without persistence */ }

        let debounce = null;
        customRules.addEventListener('input', () => {
            clearTimeout(debounce);
            debounce = setTimeout(() => {
                try { localStorage.setItem(CUSTOM_STORE_KEY, customRules.value); } catch (e) {}
                rebuildEngine(customRules.value);
                updateDictLabel();
                processText();
            }, 250);
        });
    }

    // =========================================================================
    // 4. Processing engine
    // =========================================================================
    function escapeHtml(text) {
        const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
        return text.replace(/[&<>"']/g, m => map[m]);
    }

    // Render an unmatched segment, optionally flagging suspected unknown titles.
    function renderPlainSegment(text, flagUnknown) {
        if (!flagUnknown) return { html: escapeHtml(text), unknown: 0 };
        let html = '';
        let last = 0;
        let unknown = 0;
        let m;
        SUSPECT_TITLE.lastIndex = 0;
        while ((m = SUSPECT_TITLE.exec(text)) !== null) {
            html += escapeHtml(text.slice(last, m.index));
            html += `<span class="hl-unknown" title="Not in the dictionary — verify against CASSI, or add it as a custom rule">${escapeHtml(m[0])}</span>`;
            unknown++;
            last = m.index + m[0].length;
        }
        html += escapeHtml(text.slice(last));
        return { html, unknown };
    }

    // Single pass over the RAW text: builds the plain-text result and the
    // highlighted HTML together, escaping only AFTER matching — so names
    // containing "&" (e.g. "ACS Applied Materials & Interfaces") work.
    function processText() {
        const input = dataInput.value;

        if (!input.trim()) {
            visualOutput.textContent = "Waiting for input...";
            rawOutput.value = "";
            statsLabel.textContent = "0 Changes";
            return;
        }

        const showHighlights = toggleHighlights.checked;
        let changeCount = 0;
        let unknownCount = 0;
        let clean = "";
        const html = [];
        let lastIndex = 0;
        let m;

        if (searchPattern) {
            searchPattern.lastIndex = 0;
            while ((m = searchPattern.exec(input)) !== null) {
                const matchStr = m[0];
                const before = input.slice(lastIndex, m.index);
                const replacement = lookup[normKey(matchStr)];

                const seg = renderPlainSegment(before, showHighlights);
                html.push(seg.html);
                unknownCount += seg.unknown;
                clean += before;

                if (replacement === undefined ||
                    replacement.toLowerCase() === matchStr.toLowerCase()) {
                    // Identity entries (Nature, Small, ...) or lookup miss:
                    // leave the text exactly as written, count nothing.
                    clean += matchStr;
                    html.push(escapeHtml(matchStr));
                } else {
                    clean += replacement;
                    html.push(
                        showHighlights
                            ? `<span class="hl-change" title="Original: ${escapeHtml(matchStr)}">${escapeHtml(replacement)}</span>`
                            : escapeHtml(replacement)
                    );
                    changeCount++;
                }

                lastIndex = m.index + matchStr.length;
                if (matchStr.length === 0) searchPattern.lastIndex++; // safety
            }
        }

        const tail = input.slice(lastIndex);
        const tailSeg = renderPlainSegment(tail, showHighlights);
        clean += tail;
        html.push(tailSeg.html);
        unknownCount += tailSeg.unknown;

        visualOutput.innerHTML = html.join("");
        rawOutput.value = clean;
        statsLabel.textContent =
            `${changeCount} ${changeCount === 1 ? "Change" : "Changes"}` +
            (unknownCount ? ` · ${unknownCount} Unknown` : "");
    }

    function updateDictLabel() {
        if (!dictLabel) return;
        dictLabel.textContent = `${builtinCount} built-in` +
            (customCount ? ` · ${customCount} custom` : '');
    }

    // =========================================================================
    // 5. Utilities
    // =========================================================================
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

    btnCopyText.addEventListener('click', () => {
        const text = rawOutput.value;
        if (!text) return;
        navigator.clipboard.writeText(text).then(() => {
            showToast('Abbreviated text copied to clipboard!');
            const originalHTML = btnCopyText.innerHTML;
            btnCopyText.innerHTML = '<i class="fa-solid fa-check"></i> Copied!';
            btnCopyText.classList.replace('bg-pink-600', 'bg-emerald-600');
            setTimeout(() => {
                btnCopyText.innerHTML = originalHTML;
                btnCopyText.classList.replace('bg-emerald-600', 'bg-pink-600');
            }, 2000);
        });
    });

    // =========================================================================
    // Initial build + pass
    // =========================================================================
    rebuildEngine(customRules ? customRules.value : '');
    updateDictLabel();
    processText();
});
