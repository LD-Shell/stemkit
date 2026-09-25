/**
 * DOI to BibTeX | UI layer.
 *
 * DOI-list parsing and BibTeX field filtering live in stemkit-core; this file
 * handles fetching and DOM wiring only.
 */
import { filterBibtexFields } from '../src/core/bibtex.js';

document.addEventListener("DOMContentLoaded", () => {

    // ═══════════════════════════════════════════
    // 1. STATE
    // ═══════════════════════════════════════════

    let rawEntries = [];        // Raw bibtex strings returned by the API
    let failedDOIs = [];        // Array of { doi, error } objects
    let selectedDelim = "auto";
    let isFetching = false;

    // BibTeX fields available for toggling
    const ALL_FIELDS = [
        { key: "author",    essential: true  },
        { key: "title",     essential: true  },
        { key: "journal",   essential: true  },
        { key: "year",      essential: true  },
        { key: "volume",    essential: true  },
        { key: "number",    essential: false },
        { key: "pages",     essential: false },
        { key: "publisher", essential: false },
        { key: "doi",       essential: true  },
        { key: "url",       essential: false },
        { key: "abstract",  essential: false },
        { key: "issn",      essential: false },
        { key: "isbn",      essential: false },
        { key: "month",     essential: false },
        { key: "note",      essential: false },
        { key: "keywords",  essential: false },
        { key: "booktitle", essential: true  },
        { key: "editor",    essential: false },
        { key: "edition",   essential: false },
        { key: "series",    essential: false },
    ];
    let enabledFields = new Set(ALL_FIELDS.map(f => f.key));

    // Three real DOIs: a Nature paper, a J. Phys. Chem. C paper given as a
    // doi.org link, and a Science paper.
    const EXAMPLE = [
        "10.1038/s41586-020-2649-2",
        "https://doi.org/10.1021/acs.jpcc.9b03054",
        "10.1126/science.288.5468.1029",
    ].join("\n");


    // ═══════════════════════════════════════════
    // 2. DOM REFERENCES
    // ═══════════════════════════════════════════

    const doiInput          = document.getElementById("doiInput");
    const fetchBtn          = document.getElementById("fetchBtn");
    const bibOutput         = document.getElementById("bibOutput");
    const bibEmpty          = document.getElementById("bibEmpty");
    const entryCountBadge   = document.getElementById("entryCount");
    const failCountBadge    = document.getElementById("failCount");
    const copyBtn           = document.getElementById("copyBtn");
    const downloadBtn       = document.getElementById("downloadBtn");
    const clearBtn          = document.getElementById("clearBtn");
    const retryBtn          = document.getElementById("retryBtn");
    const progressWrapper   = document.getElementById("progressWrapper");
    const progressBar       = document.getElementById("progressBar");
    const progressFill      = document.getElementById("progressFill");
    const progressText      = document.getElementById("progressText");
    const errorReport       = document.getElementById("errorReport");
    const errorReportBody   = document.getElementById("errorReportBody");
    const errorReportTitle  = document.getElementById("errorReportTitle");
    const dedupInfo         = document.getElementById("dedupInfo");
    const dedupText         = document.getElementById("dedupText");
    const statsRow          = document.getElementById("statsRow");
    const fieldsGrid        = document.getElementById("fieldsGrid");
    const fieldsSummary     = document.getElementById("fieldsSummary");

    const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;


    // ═══════════════════════════════════════════
    // 3. SEPARATOR CHIPS
    //
    //  One pressed at a time; the state lives in
    //  aria-pressed, which the stylesheet reads.
    // ═══════════════════════════════════════════

    const delimChips = document.querySelectorAll(".delim-chip");
    delimChips.forEach(chip => {
        chip.addEventListener("click", () => {
            delimChips.forEach(c => c.setAttribute("aria-pressed", String(c === chip)));
            selectedDelim = chip.dataset.delim;
        });
    });


    // ═══════════════════════════════════════════
    // 4. FIELD FILTER PANEL
    // ═══════════════════════════════════════════

    ALL_FIELDS.forEach(f => {
        const lbl = document.createElement("label");
        lbl.className = "field-toggle";
        lbl.innerHTML = `<input type="checkbox" data-field="${f.key}" checked> ${f.key}`;
        fieldsGrid.appendChild(lbl);
    });

    function syncFieldsSummary() {
        if (!fieldsSummary) return;
        const n = enabledFields.size;
        fieldsSummary.textContent = n === ALL_FIELDS.length
            ? `All ${n} kept`
            : `${n} of ${ALL_FIELDS.length} kept`;
    }

    fieldsGrid.addEventListener("change", (e) => {
        const cb = e.target;
        if (!cb.dataset || !cb.dataset.field) return;
        if (cb.checked) enabledFields.add(cb.dataset.field);
        else enabledFields.delete(cb.dataset.field);
        rebuildOutput();
    });

    document.getElementById("selectAllFields").addEventListener("click", () => {
        enabledFields = new Set(ALL_FIELDS.map(f => f.key));
        fieldsGrid.querySelectorAll("input[type='checkbox']").forEach(cb => { cb.checked = true; });
        rebuildOutput();
    });

    document.getElementById("deselectOptional").addEventListener("click", () => {
        enabledFields = new Set(ALL_FIELDS.filter(f => f.essential).map(f => f.key));
        fieldsGrid.querySelectorAll("input[type='checkbox']").forEach(cb => {
            const field = ALL_FIELDS.find(f => f.key === cb.dataset.field);
            cb.checked = field ? field.essential : false;
        });
        rebuildOutput();
    });


    // ═══════════════════════════════════════════
    // 5. DOI PARSING & DEDUPLICATION
    // ═══════════════════════════════════════════

    // A DOI (after any doi.org prefix) starts "10.", has a registrant code,
    // a slash and a suffix, and contains no whitespace.
    const DOI_PREFIX = /^(?:https?:\/\/)?(?:dx\.)?doi\.org\/|^doi:\s*/i;
    const LOOKS_LIKE_DOI = /^10\.\d{4,9}\/\S+$/;

    function parseDOIs(text) {
        let parts;

        if (selectedDelim === "auto") {
            // Split on whitespace, and on a comma or semicolon only where the
            // next DOI begins. Older Wiley DOIs contain a semicolon
            // (…3.0.CO;2-T), which a plain split on ";" would cut in two.
            parts = text.split(/\s+|[,;]+(?=\s*(?:https?:\/\/)?(?:dx\.)?(?:doi\.org\/|doi:\s*)?10\.)/i);
        } else if (selectedDelim === "comma")     parts = text.split(",");
          else if (selectedDelim === "semicolon") parts = text.split(";");
          else if (selectedDelim === "space")     parts = text.split(/\s+/);
          else                                    parts = text.split(/\n/);

        let cleaned = parts
            .map(s => s.trim().replace(DOI_PREFIX, "").trim())
            .filter(Boolean);

        // Auto-detect also drops words that are not DOIs (a pasted
        // reference, "doi:" on its own), rather than asking doi.org for them.
        let skipped = 0;
        if (selectedDelim === "auto") {
            cleaned = cleaned
                .map(s => s.replace(/[,;.]+$/, ""))
                .filter(s => {
                    if (LOOKS_LIKE_DOI.test(s)) return true;
                    skipped++;
                    return false;
                });
        }

        const seen = new Set();
        const unique = [];
        let dupes = 0;

        for (const d of cleaned) {
            const key = d.toLowerCase();
            if (seen.has(key)) { dupes++; continue; }
            seen.add(key);
            unique.push(d);
        }

        return { dois: unique, dupes, skipped };
    }


    // ═══════════════════════════════════════════
    // 6. BIBTEX FIELD FILTERING
    // ═══════════════════════════════════════════

    /**
     * Keep only the fields the user has ticked.
     *
     * Delegates to the core so this shares the tested implementation. The
     * previous local copy scanned line by line, which silently did nothing
     * when a provider returned the whole entry on one line, as the DOI
     * content-negotiation service often does.
     */
    function filterBibtex(bib) {
        return filterBibtexFields(bib, enabledFields);
    }


    // ═══════════════════════════════════════════
    // 7. OUTPUT
    // ═══════════════════════════════════════════

    /** Full rebuild, after a field filter change. */
    function rebuildOutput() {
        bibOutput.value = rawEntries.map(e => filterBibtex(e)).join("\n\n");
        syncFieldsSummary();
        syncOutput();
    }

    /** Stream-append a single entry as it arrives. */
    function streamAppendEntry(rawBib) {
        const filtered = filterBibtex(rawBib);
        if (bibOutput.value.trim() !== "") {
            bibOutput.value += "\n\n";
        }
        bibOutput.value += filtered;
        syncOutput();
        // Auto-scroll to bottom so the user watches entries arrive
        bibOutput.scrollTop = bibOutput.scrollHeight;
    }

    /** The empty state until there is an entry, then the entries. */
    function syncOutput() {
        const n = rawEntries.length;
        entryCountBadge.textContent = n ? plural(n, "entry", "entries") : "";
        bibOutput.hidden = n === 0;
        bibEmpty.hidden = n > 0;
        copyBtn.disabled = n === 0;
        downloadBtn.disabled = n === 0;
        clearBtn.disabled = n === 0 && failedDOIs.length === 0;
    }


    // ═══════════════════════════════════════════
    // 8. SINGLE DOI FETCH
    // ═══════════════════════════════════════════

    async function fetchSingleDOI(doi) {
        const response = await fetch(`https://doi.org/${doi}`, {
            method: "GET",
            headers: { "Accept": "application/x-bibtex; charset=utf-8" },
        });

        if (!response.ok) {
            if (response.status === 404) throw new Error("Not found at doi.org");
            throw new Error(`doi.org answered ${response.status}`);
        }

        return await response.text();
    }


    // ═══════════════════════════════════════════
    // 9. MAIN BATCH FETCH | STREAMING PIPELINE
    //
    //  Each result streams into the textarea the
    //  instant it arrives. No spinner blocks the
    //  output, the user watches entries populate
    //  in real time while the progress bar and
    //  current-DOI label update live.
    // ═══════════════════════════════════════════

    function setProgress(done, total, text) {
        const pct = total ? Math.round((done / total) * 100) : 0;
        progressFill.style.width = `${pct}%`;
        progressBar.setAttribute("aria-valuenow", String(pct));
        progressText.textContent = text;
    }

    async function executeFetch(retryDoisArray) {
        if (isFetching) return;

        const isRetry = Array.isArray(retryDoisArray);
        const inputText = isRetry ? null : doiInput.value.trim();

        if (!isRetry && !inputText) {
            showToast("Paste at least one DOI first.", "error");
            doiInput.focus();
            return;
        }

        const { dois, dupes, skipped } = isRetry
            ? { dois: retryDoisArray, dupes: 0, skipped: 0 }
            : parseDOIs(inputText);

        if (dois.length === 0) {
            showToast("None of that looks like a DOI. A DOI starts with 10., such as 10.1038/s41586-020-2649-2.", "error");
            return;
        }

        // What was left out, and why
        if (!isRetry) {
            const notes = [];
            if (dupes > 0) notes.push(`${plural(dupes, "repeated DOI", "repeated DOIs")}`);
            if (skipped > 0) notes.push(`${plural(skipped, "piece", "pieces")} of text that ${skipped === 1 ? "is" : "are"} not a DOI`);
            dedupInfo.classList.toggle("hidden", notes.length === 0);
            dedupText.textContent = notes.length ? `Skipped ${notes.join(" and ")}.` : "";
        }

        isFetching = true;
        fetchBtn.disabled = true;
        retryBtn.disabled = true;

        // Reset failures for this batch
        failedDOIs = [];
        let fetched = 0;
        const startTime = performance.now();

        progressWrapper.classList.remove("hidden");
        setProgress(0, dois.length, `Starting ${plural(dois.length, "DOI", "DOIs")}…`);

        // Clear input early so the field is ready for more DOIs
        if (!isRetry) doiInput.value = "";

        for (let i = 0; i < dois.length; i++) {
            const doi = dois[i];
            progressText.textContent = `Fetching ${i + 1} of ${dois.length}: ${truncate(doi, 40)}`;

            try {
                const bib = await fetchSingleDOI(doi);
                const trimmed = bib.trim();
                rawEntries.push(trimmed);
                fetched++;
                streamAppendEntry(trimmed);
            } catch (err) {
                // A network failure surfaces as a TypeError with a browser-specific message.
                const reason = err instanceof TypeError ? "Could not reach doi.org" : err.message;
                failedDOIs.push({ doi: doi, error: reason });
                failCountBadge.textContent = `${failedDOIs.length} failed`;
            }

            setProgress(i + 1, dois.length, progressText.textContent);

            // Rate limit: ~150ms between requests to respect Crossref
            if (i < dois.length - 1) await sleep(150);
        }

        // ── Batch complete ──
        const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);
        setProgress(dois.length, dois.length, `Fetched ${fetched} of ${dois.length} in ${elapsed} s`);

        if (failedDOIs.length > 0) {
            failCountBadge.textContent = `${failedDOIs.length} failed`;
            retryBtn.classList.remove("hidden");
            buildErrorReport();
        } else {
            failCountBadge.textContent = "";
            retryBtn.classList.add("hidden");
            errorReport.classList.add("hidden");
        }

        statsRow.classList.remove("hidden");
        statsRow.textContent =
            `Last batch: ${fetched} fetched, ${failedDOIs.length} failed` +
            (dupes ? `, ${plural(dupes, "repeat", "repeats")} skipped` : "") +
            `, in ${elapsed} s.`;

        showToast(`Fetched ${fetched} of ${plural(dois.length, "DOI", "DOIs")} in ${elapsed} s.`,
            failedDOIs.length === 0 ? "success" : "warn");

        isFetching = false;
        fetchBtn.disabled = false;
        retryBtn.disabled = false;
        syncOutput();
        doiInput.focus();

        // Hide the progress bar after a moment
        setTimeout(() => { if (!isFetching) progressWrapper.classList.add("hidden"); }, 2500);
    }


    // ═══════════════════════════════════════════
    // 10. ERROR REPORT
    // ═══════════════════════════════════════════

    function buildErrorReport() {
        errorReport.classList.remove("hidden");
        errorReportTitle.textContent =
            `${plural(failedDOIs.length, "DOI", "DOIs")} could not be fetched`;
        errorReportBody.innerHTML = failedDOIs.map(f =>
            `<div class="error-item border-b border-slate-100 dark:border-slate-800 last:border-0">
                <span class="error-doi text-slate-800 dark:text-slate-200">${escapeHtml(f.doi)}</span>
                <span class="text-red-700 dark:text-red-400 text-xs">${escapeHtml(f.error)}</span>
            </div>`
        ).join("");
    }


    // ═══════════════════════════════════════════
    // 11. EVENT BINDINGS
    // ═══════════════════════════════════════════

    fetchBtn.addEventListener("click", () => executeFetch());

    doiInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
            const lines = doiInput.value.split("\n").filter(l => l.trim());
            if (lines.length <= 1) {
                e.preventDefault();
                executeFetch();
            }
        }
    });

    // Offered twice: in the page head and in the empty bibliography.
    document.querySelectorAll("[data-load-example]").forEach(btn => {
        btn.addEventListener("click", () => {
            doiInput.value = EXAMPLE;
            doiInput.dispatchEvent(new Event("input", { bubbles: true }));
            showToast("Added three example DOIs. Press Fetch BibTeX to look them up.");
            fetchBtn.focus();
        });
    });

    retryBtn.addEventListener("click", () => {
        if (failedDOIs.length === 0) return;
        executeFetch(failedDOIs.map(f => f.doi));
    });

    copyBtn.addEventListener("click", () => {
        if (!bibOutput.value.trim()) return;
        navigator.clipboard.writeText(bibOutput.value).then(() => {
            showToast("Copied the bibliography.", "success");
        }).catch(() => {
            showToast("The browser blocked the clipboard. Select the text and copy it instead.", "error");
        });
    });

    downloadBtn.addEventListener("click", () => {
        if (!bibOutput.value.trim()) return;
        const blob = new Blob([bibOutput.value + "\n"], { type: "text/plain;charset=utf-8;" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.setAttribute("href", url);
        link.setAttribute("download", "references.bib");
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
        showToast("Saved references.bib.", "success");
    });

    clearBtn.addEventListener("click", () => {
        if (isFetching) return;
        const n = rawEntries.length;
        rawEntries = [];
        failedDOIs = [];
        bibOutput.value = "";
        failCountBadge.textContent = "";
        retryBtn.classList.add("hidden");
        errorReport.classList.add("hidden");
        errorReportBody.innerHTML = "";
        dedupInfo.classList.add("hidden");
        statsRow.classList.add("hidden");
        syncOutput();
        showToast(`Removed ${plural(n, "entry", "entries")} from the bibliography.`);
    });


    // ═══════════════════════════════════════════
    // 12. TOASTS (the shared .stk-toast component)
    // ═══════════════════════════════════════════

    function showToast(msg, type = "info") {
        const container = document.getElementById("toastContainer");
        if (!container) return;
        const toast = document.createElement("div");
        toast.className = "stk-toast" + (type === "success" ? " stk-toast-ok"
            : type === "error" ? " stk-toast-danger" : type === "warn" ? " stk-toast-warn" : "");
        toast.setAttribute("role", type === "error" ? "alert" : "status");
        const icon = document.createElement("i");
        icon.className = "fa-solid " + (type === "success" ? "fa-circle-check"
            : type === "error" || type === "warn" ? "fa-triangle-exclamation" : "fa-circle-info");
        icon.setAttribute("aria-hidden", "true");
        const body = document.createElement("span");
        body.textContent = msg;
        toast.append(icon, body);
        container.appendChild(toast);
        setTimeout(() => toast.remove(), type === "error" ? 5000 : 3000);
    }


    // ═══════════════════════════════════════════
    // 13. UTILITY HELPERS
    // ═══════════════════════════════════════════

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function escapeHtml(str) {
        const div = document.createElement("div");
        div.textContent = str;
        return div.innerHTML;
    }

    function truncate(str, max) {
        return str.length > max ? str.slice(0, max) + "…" : str;
    }

    syncFieldsSummary();
    syncOutput();
});
