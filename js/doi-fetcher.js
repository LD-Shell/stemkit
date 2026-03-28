document.addEventListener("DOMContentLoaded", () => {

    // ═══════════════════════════════════════════
    // 1. STATE
    // ═══════════════════════════════════════════

    let rawEntries = [];        // Raw bibtex strings returned by the API
    let failedDOIs = [];        // Array of { doi, error } objects
    let selectedDelim = null;
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


    // ═══════════════════════════════════════════
    // 2. DOM REFERENCES
    // ═══════════════════════════════════════════

    const doiInput          = document.getElementById("doiInput");
    const fetchBtn          = document.getElementById("fetchBtn");
    const bibOutput         = document.getElementById("bibOutput");
    const entryCountBadge   = document.getElementById("entryCount");
    const failCountBadge    = document.getElementById("failCount");
    const copyBtn           = document.getElementById("copyBtn");
    const downloadBtn       = document.getElementById("downloadBtn");
    const clearBtn          = document.getElementById("clearBtn");
    const retryBtn          = document.getElementById("retryBtn");
    const progressWrapper   = document.getElementById("progressWrapper");
    const progressFill      = document.getElementById("progressFill");
    const progressText      = document.getElementById("progressText");
    const loadingOverlay    = document.getElementById("loadingOverlay");
    const errorReport       = document.getElementById("errorReport");
    const errorReportToggle = document.getElementById("errorReportToggle");
    const errorReportBody   = document.getElementById("errorReportBody");
    const errorReportTitle  = document.getElementById("errorReportTitle");
    const errorArrow        = document.getElementById("errorArrow");
    const dedupInfo         = document.getElementById("dedupInfo");
    const dedupText         = document.getElementById("dedupText");
    const statsRow          = document.getElementById("statsRow");
    const fieldsGrid        = document.getElementById("fieldsGrid");
    const fieldsTrigger     = document.getElementById("fieldsTrigger");
    const fieldsBody        = document.getElementById("fieldsBody");
    const fieldsArrow       = document.getElementById("fieldsArrow");


    // ═══════════════════════════════════════════
    // 3. DELIMITER CHIP SELECTION
    // ═══════════════════════════════════════════

    const delimChips = document.querySelectorAll(".delim-chip");
    delimChips.forEach(chip => {
        chip.addEventListener("click", () => {
            delimChips.forEach(c => {
                c.classList.remove("bg-indigo-100", "dark:bg-indigo-900/50", "text-indigo-700", "dark:text-indigo-400", "border-indigo-200", "dark:border-indigo-800", "active");
                c.classList.add("bg-slate-100", "dark:bg-slate-800", "text-slate-600", "dark:text-slate-300", "border-slate-200", "dark:border-slate-700");
            });
            chip.classList.remove("bg-slate-100", "dark:bg-slate-800", "text-slate-600", "dark:text-slate-300", "border-slate-200", "dark:border-slate-700");
            chip.classList.add("bg-indigo-100", "dark:bg-indigo-900/50", "text-indigo-700", "dark:text-indigo-400", "border-indigo-200", "dark:border-indigo-800", "active");
            selectedDelim = chip.dataset.delim;
        });
    });


    // ═══════════════════════════════════════════
    // 4. FIELD FILTER PANEL
    // ═══════════════════════════════════════════

    fieldsTrigger.addEventListener("click", () => {
        const isOpen = fieldsBody.style.maxHeight && fieldsBody.style.maxHeight !== "0px";
        if (isOpen) {
            fieldsBody.style.maxHeight = "0px";
            fieldsArrow.style.transform = "";
        } else {
            fieldsBody.style.maxHeight = (fieldsBody.scrollHeight + 50) + "px";
            fieldsArrow.style.transform = "rotate(180deg)";
        }
    });

    ALL_FIELDS.forEach(f => {
        const lbl = document.createElement("label");
        lbl.className = "field-toggle";
        lbl.innerHTML = `<input type="checkbox" data-field="${f.key}" checked> ${f.key}`;
        fieldsGrid.appendChild(lbl);
    });

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
    // 5. ERROR REPORT TOGGLE
    // ═══════════════════════════════════════════

    errorReportToggle.addEventListener("click", () => {
        errorReportBody.classList.toggle("open");
        if (errorArrow) {
            errorArrow.style.transform = errorReportBody.classList.contains("open") ? "rotate(180deg)" : "";
        }
    });


    // ═══════════════════════════════════════════
    // 6. DOI PARSING & DEDUPLICATION
    // ═══════════════════════════════════════════

    function parseDOIs(text) {
        let parts;

        if (selectedDelim === "auto") {
            if (text.includes(";"))       parts = text.split(";");
            else if (text.includes(","))  parts = text.split(",");
            else                          parts = text.split(/\n/);
        } else if (selectedDelim === "comma")     parts = text.split(",");
          else if (selectedDelim === "semicolon") parts = text.split(";");
          else if (selectedDelim === "space")     parts = text.split(/\s+/);
          else                                    parts = text.split(/\n/);

        const cleaned = parts
            .map(s => s.trim())
            .filter(Boolean)
            .map(s => s.replace(/^(https?:\/\/)?(dx\.)?doi\.org\//i, "").trim())
            .filter(Boolean);

        const seen = new Set();
        const unique = [];
        let dupes = 0;

        for (const d of cleaned) {
            const key = d.toLowerCase();
            if (seen.has(key)) { dupes++; continue; }
            seen.add(key);
            unique.push(d);
        }

        return { dois: unique, dupes };
    }


    // ═══════════════════════════════════════════
    // 7. BIBTEX FIELD FILTERING
    // ═══════════════════════════════════════════

    function filterBibtex(bib) {
        const lines = bib.split("\n");
        const filtered = [];
        let skipping = false;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const fieldMatch = line.match(/^\s*(\w+)\s*=/);

            if (fieldMatch) {
                const fieldName = fieldMatch[1].toLowerCase();
                if (enabledFields.has(fieldName)) {
                    skipping = false;
                    filtered.push(line);
                } else {
                    skipping = true;
                }
            } else if (skipping) {
                if (line.trim() === "}" || line.trim() === "") {
                    skipping = false;
                    filtered.push(line);
                }
            } else {
                filtered.push(line);
            }
        }

        return filtered.join("\n").replace(/\n{3,}/g, "\n\n").trim();
    }


    // ═══════════════════════════════════════════
    // 8. OUTPUT — Full rebuild (field filter changes)
    // ═══════════════════════════════════════════

    function rebuildOutput() {
        bibOutput.value = rawEntries.map(e => filterBibtex(e)).join("\n\n");
        syncEntryCount();
    }


    // ═══════════════════════════════════════════
    // 9. OUTPUT — Stream-append a single entry
    // ═══════════════════════════════════════════

    function streamAppendEntry(rawBib) {
        const filtered = filterBibtex(rawBib);
        if (bibOutput.value.trim() !== "") {
            bibOutput.value += "\n\n";
        }
        bibOutput.value += filtered;

        // Auto-scroll to bottom so user watches entries arrive
        bibOutput.scrollTop = bibOutput.scrollHeight;
        syncEntryCount();
    }

    function syncEntryCount() {
        entryCountBadge.innerText = `${rawEntries.length} ${rawEntries.length === 1 ? "Entry" : "Entries"}`;
    }


    // ═══════════════════════════════════════════
    // 10. SINGLE DOI FETCH
    // ═══════════════════════════════════════════

    async function fetchSingleDOI(doi) {
        const response = await fetch(`https://doi.org/${doi}`, {
            method: "GET",
            headers: { "Accept": "application/x-bibtex; charset=utf-8" },
        });

        if (!response.ok) {
            if (response.status === 404) throw new Error("DOI not found in the global registry.");
            throw new Error(`Server returned status: ${response.status}`);
        }

        return await response.text();
    }


    // ═══════════════════════════════════════════
    // 11. MAIN BATCH FETCH — STREAMING PIPELINE
    //
    //  Each result streams into the textarea the
    //  instant it arrives. No spinner blocks the
    //  output — the user watches entries populate
    //  in real time while the progress bar and
    //  current-DOI label update live.
    // ═══════════════════════════════════════════

    async function executeFetch(retryDoisArray) {
        if (isFetching) return;

        const isRetry = Array.isArray(retryDoisArray);
        const inputText = isRetry ? null : doiInput.value.trim();

        if (!isRetry && !inputText) {
            showToast("Please enter at least one DOI.", "error");
            return;
        }

        if (!selectedDelim) {
            showToast("Please select how your DOIs are separated.", "error");
            // Briefly highlight the delimiter row
            const row = document.getElementById("delimRow");
            if (row) {
                row.style.outline = "2px solid #ef4444";
                row.style.outlineOffset = "4px";
                row.style.borderRadius = "12px";
                setTimeout(() => { row.style.outline = ""; row.style.outlineOffset = ""; }, 2000);
            }
            return;
        }

        const { dois, dupes } = isRetry
            ? { dois: retryDoisArray, dupes: 0 }
            : parseDOIs(inputText);

        if (dois.length === 0) {
            showToast("No valid DOIs found.", "error");
            return;
        }

        // Dedup notice
        if (dupes > 0) {
            dedupInfo.classList.remove("hidden");
            dedupText.textContent = `${dupes} duplicate DOI${dupes > 1 ? "s" : ""} removed.`;
        } else if (!isRetry) {
            dedupInfo.classList.add("hidden");
        }

        // Lock UI — but do NOT show the blocking spinner overlay
        isFetching = true;
        fetchBtn.disabled = true;
        loadingOverlay.classList.add("hidden");

        // Reset failures for this batch
        failedDOIs = [];
        let fetched = 0;
        const startTime = performance.now();

        // Show progress bar
        progressWrapper.classList.remove("hidden");
        progressFill.style.width = "0%";
        progressText.textContent = `0 / ${dois.length} — starting…`;

        // Clear input early so the field is ready for more DOIs
        if (!isRetry) doiInput.value = "";

        // ── Stream loop ──
        for (let i = 0; i < dois.length; i++) {
            const doi = dois[i];

            // Live: show which DOI is currently being fetched
            progressText.textContent = `${i + 1} / ${dois.length} — ${truncate(doi, 40)}`;

            try {
                const bib = await fetchSingleDOI(doi);
                const trimmed = bib.trim();
                rawEntries.push(trimmed);
                fetched++;

                // ★ STREAM: append this entry to the output textarea immediately
                streamAppendEntry(trimmed);

            } catch (err) {
                failedDOIs.push({ doi: doi, error: err.message });

                // Live: update fail badge as errors happen
                failCountBadge.classList.remove("hidden");
                failCountBadge.innerText = `${failedDOIs.length} Failed`;
            }

            // Progress bar
            progressFill.style.width = `${((i + 1) / dois.length) * 100}%`;

            // Rate limit: ~150ms between requests to respect Crossref
            if (i < dois.length - 1) await sleep(150);
        }

        // ── Batch complete ──
        const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);
        progressText.textContent = `${dois.length} / ${dois.length} — done in ${elapsed}s`;

        // Final failure UI
        if (failedDOIs.length > 0) {
            failCountBadge.classList.remove("hidden");
            failCountBadge.innerText = `${failedDOIs.length} Failed`;
            retryBtn.classList.remove("hidden");
            buildErrorReport();
        } else {
            failCountBadge.classList.add("hidden");
            retryBtn.classList.add("hidden");
            errorReport.classList.add("hidden");
        }

        // Stats row
        statsRow.classList.remove("hidden");
        document.getElementById("statFetched").textContent = fetched;
        document.getElementById("statFailed").textContent  = failedDOIs.length;
        document.getElementById("statDupes").textContent   = dupes;
        document.getElementById("statTime").textContent    = elapsed + "s";

        // Summary toast
        const toastType = failedDOIs.length === 0 ? "success" : "info";
        showToast(`${fetched} of ${dois.length} citations retrieved in ${elapsed}s.`, toastType);

        // Unlock UI
        isFetching = false;
        fetchBtn.disabled = false;
        doiInput.focus();

        // Fade out the progress bar after a moment
        setTimeout(() => { progressWrapper.classList.add("hidden"); }, 2500);
    }


    // ═══════════════════════════════════════════
    // 12. ERROR REPORT BUILDER
    // ═══════════════════════════════════════════

    function buildErrorReport() {
        errorReport.classList.remove("hidden");
        errorReportTitle.textContent = `${failedDOIs.length} failed`;
        errorReportBody.innerHTML = failedDOIs.map(f =>
            `<div class="error-item border-b border-slate-100 dark:border-slate-800 last:border-0">
                <span class="error-doi text-slate-800 dark:text-slate-200">${escapeHtml(f.doi)}</span>
                <span class="text-red-500 dark:text-red-400 text-xs whitespace-nowrap flex-shrink-0">${escapeHtml(f.error)}</span>
            </div>`
        ).join("");
    }


    // ═══════════════════════════════════════════
    // 13. EVENT BINDINGS
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

    retryBtn.addEventListener("click", () => {
        if (failedDOIs.length === 0) return;
        const retryDois = failedDOIs.map(f => f.doi);
        executeFetch(retryDois);
    });

    copyBtn.addEventListener("click", () => {
        if (!bibOutput.value.trim()) {
            showToast("Nothing to copy.", "error");
            return;
        }
        navigator.clipboard.writeText(bibOutput.value).then(() => {
            showToast("Bibliography copied to clipboard.", "info");
        }).catch(() => {
            bibOutput.select();
            document.execCommand("copy");
            window.getSelection().removeAllRanges();
            showToast("Bibliography copied to clipboard.", "info");
        });
    });

    downloadBtn.addEventListener("click", () => {
        if (!bibOutput.value.trim()) {
            showToast("Bibliography is empty.", "error");
            return;
        }
        const blob = new Blob([bibOutput.value], { type: "text/plain;charset=utf-8;" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.setAttribute("href", url);
        link.setAttribute("download", "references.bib");
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
        showToast("Saved as references.bib", "success");
    });

    clearBtn.addEventListener("click", () => {
        rawEntries = [];
        failedDOIs = [];
        bibOutput.value = "";
        entryCountBadge.innerText = "0 Entries";
        failCountBadge.classList.add("hidden");
        retryBtn.classList.add("hidden");
        errorReport.classList.add("hidden");
        errorReportBody.innerHTML = "";
        dedupInfo.classList.add("hidden");
        statsRow.classList.add("hidden");
        showToast("Workspace cleared.", "info");
    });


    // ═══════════════════════════════════════════
    // 14. TOAST NOTIFICATION SYSTEM
    // ═══════════════════════════════════════════

    function showToast(msg, type) {
        const container = document.getElementById("toastContainer");
        const toast = document.createElement("div");

        const colorMap = {
            success: "bg-emerald-50 text-emerald-800 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-400",
            error:   "bg-red-50 text-red-800 border-red-200 dark:bg-red-900/30 dark:text-red-400",
            info:    "bg-indigo-50 text-indigo-800 border-indigo-200 dark:bg-indigo-900/30 dark:text-indigo-400",
        };
        const iconMap = {
            success: "fa-check-circle",
            error:   "fa-triangle-exclamation",
            info:    "fa-info-circle",
        };

        const colors = colorMap[type] || colorMap.info;
        const icon = iconMap[type] || iconMap.info;

        toast.className = `px-4 py-3 rounded-xl border shadow-lg toast-enter text-sm font-medium transition-all ${colors}`;
        toast.innerHTML = `<i class="fa-solid ${icon} mr-2"></i> ${escapeHtml(msg)}`;

        container.appendChild(toast);
        setTimeout(() => {
            toast.style.opacity = "0";
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }


    // ═══════════════════════════════════════════
    // 15. UTILITY HELPERS
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

});
