/**
 * DOI to BibTeX | UI layer.
 *
 * Reading the pasted list of DOIs, the address a DOI resolves at, the check
 * that a reply is BibTeX, and BibTeX field removal live in stemkit-core; this
 * file handles the requests and DOM wiring.
 */
import {
    dropBibtexFields, parseDoiList, normaliseDoi, doiUrl, looksLikeBibtex
} from '../src/core/bibtex.js';


// ═══════════════════════════════════════════
// ONE DOI: THE REQUEST
//
//  No page is needed for this part, so it is
//  exported and tested on its own.
// ═══════════════════════════════════════════

/** How long one request may take, reply included. */
export const REQUEST_TIMEOUT_MS = 20000;
/** How many times a DOI is asked for again after "429 Too Many Requests". */
export const RATE_LIMIT_RETRIES = 2;
/** The first wait when a 429 does not say how long; each later one doubles. */
export const RATE_LIMIT_WAIT_S = 10;
/** The longest wait that is sat out. Asked for more, the DOI fails at once. */
export const RATE_LIMIT_MAX_WAIT_S = 60;

/** Why a DOI could not be fetched, as a sentence for the failure report. */
export class DoiError extends Error {
    /** @param {string} message  @param {{rateLimited?:boolean}} [flags] */
    constructor(message, { rateLimited = false } = {}) {
        super(message);
        this.name = "DoiError";
        /** The server was still limiting requests when the tries ran out. */
        this.rateLimited = rateLimited;
    }
}

/**
 * The wait a Retry-After header asks for, in whole seconds, or null when
 * there is no header or it cannot be read. The header holds either a number
 * of seconds or an HTTP date (RFC 9110, section 10.2.3).
 *
 * @param {string|null} value
 * @param {number} [now]  Milliseconds since the epoch.
 * @returns {number|null}
 */
export function retryAfterSeconds(value, now = Date.now()) {
    const text = String(value ?? "").trim();
    if (!text) return null;
    if (/^\d+$/.test(text)) return Number(text);
    // Every form of HTTP date starts with the name of the day. Date.parse
    // alone would also take "1.5" for a date.
    const at = /^[A-Za-z]{3}/.test(text) ? Date.parse(text) : NaN;
    return Number.isNaN(at) ? null : Math.max(0, Math.ceil((at - now) / 1000));
}

/** "45 s", "2 minutes" */
export function spellSeconds(seconds) {
    if (seconds < 90) return `${seconds} s`;
    return `${Math.round(seconds / 60)} minutes`;
}

/**
 * Who sent a reply. doi.org passes a lookup on to the agency that registered
 * the DOI (Crossref, DataCite, …), and the reply the page reads is the last
 * one, so an error is the agency's more often than doi.org's.
 */
function answeredBy(response) {
    try { return new URL(response.url).hostname || "The server"; } catch { return "The server"; }
}

/**
 * Fetch the BibTeX entry of one DOI.
 *
 * Resolves with the entry, trimmed. Rejects with a `DoiError` whose message
 * says what happened: no reply in time, no reply the browser could read, a
 * status other than 200, or a reply that is not BibTeX (agencies answer an
 * unknown format with a web page and status 200, or with nothing).
 *
 * On 429 the DOI is asked for again, up to `retries` times, after the wait
 * the reply's Retry-After header asks for. A reply from another site shows
 * that header only when the site allows it (Access-Control-Expose-Headers),
 * and Crossref's does not, so without one the wait is `RATE_LIMIT_WAIT_S`,
 * doubled each time. If the tries run out, or the wait asked for is longer
 * than `RATE_LIMIT_MAX_WAIT_S`, the error has `rateLimited` set.
 *
 * @param {string} doi  A bare DOI.
 * @param {object} [options]
 * @param {Function} [options.fetch]      Stands in for `fetch` in tests.
 * @param {Function} [options.sleep]      `(ms) => Promise`, likewise.
 * @param {number}   [options.timeoutMs]
 * @param {number}   [options.retries]
 * @param {Function} [options.onWait]     Called before each wait, with
 *        `{ who, seconds, asked, attempt, retries }`; `asked` says whether
 *        the server named the wait.
 * @param {Function} [options.onRetry]    Called when a wait is over.
 * @returns {Promise<string>}
 */
export async function fetchBibtex(doi, options = {}) {
    const {
        fetch: request = globalThis.fetch,
        sleep = pause,
        timeoutMs = REQUEST_TIMEOUT_MS,
        retries = RATE_LIMIT_RETRIES,
        onWait = () => {},
        onRetry = () => {},
    } = options;

    for (let attempt = 0; ; attempt++) {
        // One clock for the whole exchange: a reply can stall after its
        // headers, so the body is read before the timer is stopped.
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        let response;
        let body = "";
        try {
            response = await request(doiUrl(doi), {
                method: "GET",
                headers: { "Accept": "application/x-bibtex; charset=utf-8" },
                signal: controller.signal,
            });
            if (response.ok) body = await response.text();
        } catch (err) {
            if (controller.signal.aborted) {
                throw new DoiError(`No reply within ${spellSeconds(Math.round(timeoutMs / 1000))}.`);
            }
            // A failed connection, a reply without permission for this page to
            // read it, and a host the page may not contact all arrive as the
            // same TypeError, with a message that differs by browser.
            if (globalThis.navigator && globalThis.navigator.onLine === false) {
                throw new DoiError("The browser is offline.");
            }
            throw new DoiError("No reply the browser could read. The connection failed, or the agency " +
                "that registered this DOI does not answer lookups from a web page.");
        } finally {
            clearTimeout(timer);
        }

        const who = answeredBy(response);

        if (response.status === 429) {
            const named = retryAfterSeconds(response.headers.get("Retry-After"));
            const seconds = named ?? RATE_LIMIT_WAIT_S * 2 ** attempt;
            if (seconds > RATE_LIMIT_MAX_WAIT_S) {
                throw new DoiError(`${who} is limiting requests (429) and asked for a wait of ` +
                    `${spellSeconds(seconds)}. Try again after that.`, { rateLimited: true });
            }
            if (attempt >= retries) {
                throw new DoiError(`${who} is limiting requests (429), and still was after ` +
                    `${retries === 1 ? "1 more try" : `${retries} more tries`}. Try again in a few minutes.`,
                    { rateLimited: true });
            }
            const wait = { who, seconds, asked: named !== null, attempt: attempt + 1, retries };
            onWait(wait);
            await sleep(seconds * 1000);
            onRetry(wait);
            continue;
        }

        if (!response.ok) {
            if (response.status === 404) {
                throw new DoiError(who === "doi.org"
                    ? "doi.org does not know this DOI (404). Check it for a typing mistake."
                    : `${who} has no record of this DOI (404).`);
            }
            if (response.status === 406) {
                throw new DoiError(`${who} cannot give this DOI as BibTeX (406).`);
            }
            throw new DoiError(`${who} answered ${response.status}` +
                `${response.statusText ? ` ${response.statusText}` : ""}.`);
        }

        const text = body.trim();
        if (!text) throw new DoiError(`${who} sent an empty reply.`);
        if (!looksLikeBibtex(text)) {
            throw new DoiError(text[0] === "<"
                ? `${who} sent a web page, not BibTeX.`
                : `${who} sent a reply that is not a BibTeX entry.`);
        }
        return text;
    }
}

function pause(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}


if (typeof document !== "undefined") document.addEventListener("DOMContentLoaded", () => {

    // ═══════════════════════════════════════════
    // 1. STATE
    // ═══════════════════════════════════════════

    let rawEntries = [];        // Raw bibtex strings, as they were sent
    let fetchedDOIs = new Set(); // Normalised DOIs already in rawEntries
    let failedDOIs = [];        // Array of { doi, error } objects
    let selectedDelim = "auto";
    let isFetching = false;

    // Fields the panel offers to remove. A field not listed here, such as
    // address, school or howpublished, is always kept.
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
        const removed = ALL_FIELDS.length - enabledFields.size;
        fieldsSummary.textContent = removed === 0
            ? "None removed"
            : `${plural(removed, "field", "fields")} removed`;
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
    // 5. BIBTEX FIELD FILTERING
    // ═══════════════════════════════════════════

    /**
     * Remove the fields the user has unticked, and nothing else.
     *
     * Delegates to the core so this shares the tested implementation, which
     * reads the entry rather than its lines: the DOI content-negotiation
     * service often returns a whole entry on one line.
     */
    function filterBibtex(bib) {
        const unticked = ALL_FIELDS.map(f => f.key).filter(k => !enabledFields.has(k));
        return dropBibtexFields(bib, unticked);
    }


    // ═══════════════════════════════════════════
    // 6. OUTPUT
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
    // 7. MAIN BATCH FETCH | STREAMING PIPELINE
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

        // The core reads the list, so the page and the package have one rule
        // for what a DOI looks like and how it may be written.
        const parsed = isRetry
            ? { dois: retryDoisArray, duplicates: 0, skipped: 0 }
            : parseDoiList(inputText, selectedDelim);
        const { duplicates: dupes, skipped } = parsed;

        if (parsed.dois.length === 0) {
            showToast("None of that looks like a DOI. A DOI starts with 10., such as 10.1038/s41586-020-2649-2.", "error");
            return;
        }

        // A DOI fetched in an earlier batch is already in the bibliography;
        // fetching it again would only add a second copy.
        const dois = parsed.dois.filter(d => !fetchedDOIs.has(normaliseDoi(d)));
        const already = parsed.dois.length - dois.length;

        // What was left out, and why
        if (!isRetry) {
            const notes = [];
            if (dupes > 0) notes.push(`${plural(dupes, "repeated DOI", "repeated DOIs")}`);
            if (already > 0) notes.push(`${plural(already, "DOI", "DOIs")} already in the bibliography`);
            if (skipped > 0) notes.push(`${plural(skipped, "piece", "pieces")} of text that ${skipped === 1 ? "is" : "are"} not a DOI`);
            dedupInfo.classList.toggle("hidden", notes.length === 0);
            dedupText.textContent = notes.length ? `Skipped ${listJoin(notes)}.` : "";
        }

        if (dois.length === 0) {
            showToast(already === 1
                ? "That DOI is already in the bibliography."
                : "All of those DOIs are already in the bibliography.");
            doiInput.value = "";
            doiInput.focus();
            return;
        }

        isFetching = true;
        fetchBtn.disabled = true;
        retryBtn.disabled = true;

        // Reset failures for this batch, and what the page still shows of the
        // last one: its count, its report and (unless this is the retry) its
        // Retry button would otherwise sit beside the new batch until it ends.
        failedDOIs = [];
        failCountBadge.textContent = "";
        errorReport.classList.add("hidden");
        if (!isRetry) retryBtn.classList.add("hidden");
        let fetched = 0;
        let notTried = 0;
        const startTime = performance.now();

        progressWrapper.classList.remove("hidden");
        setProgress(0, dois.length, `Starting ${plural(dois.length, "DOI", "DOIs")}…`);

        // Clear input early so the field is ready for more DOIs
        if (!isRetry) doiInput.value = "";

        for (let i = 0; i < dois.length; i++) {
            const doi = dois[i];
            const fetching = `Fetching ${i + 1} of ${dois.length}: ${truncate(doi, 40)}`;
            progressText.textContent = fetching;

            try {
                const bib = await fetchBibtex(doi, {
                    // Told to slow down: say who asked, how long the wait is
                    // and what happens after it.
                    onWait: ({ who, seconds, asked, attempt, retries }) => {
                        progressText.textContent =
                            `${who} is limiting requests. Waiting ${asked ? `the ${spellSeconds(seconds)} it asked for` : spellSeconds(seconds)}` +
                            `, then trying ${truncate(doi, 40)} again (retry ${attempt} of ${retries}).`;
                    },
                    onRetry: () => { progressText.textContent = fetching; },
                });
                rawEntries.push(bib);
                fetchedDOIs.add(normaliseDoi(doi));
                fetched++;
                streamAppendEntry(bib);
            } catch (err) {
                failedDOIs.push({ doi: doi, error: err.message });

                // Still limited after the waits: asking for the rest now would
                // only add to the load, and each would wait and fail the same
                // way. They are listed as not tried, for Retry failed.
                if (err.rateLimited) {
                    for (const rest of dois.slice(i + 1)) {
                        failedDOIs.push({ doi: rest, error: "Not tried: the batch stopped when requests were limited." });
                        notTried++;
                    }
                }
                failCountBadge.textContent = `${failedDOIs.length} failed`;
            }

            setProgress(i + 1, dois.length, progressText.textContent);
            if (notTried > 0) break;

            // A short pause between requests, to go easy on doi.org and the
            // registration agencies behind it
            if (i < dois.length - 1) await pause(150);
        }

        // ── Batch complete ──
        const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);
        const tried = dois.length - notTried;
        setProgress(tried, dois.length, notTried
            ? `Stopped after ${tried} of ${dois.length}: requests are being limited. Fetched ${fetched} in ${elapsed} s`
            : `Fetched ${fetched} of ${dois.length} in ${elapsed} s`);

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
            `Last batch: ${fetched} fetched, ${failedDOIs.length - notTried} failed` +
            (notTried ? `, ${notTried} not tried` : "") +
            (dupes ? `, ${plural(dupes, "repeat", "repeats")} skipped` : "") +
            (already ? `, ${already} already in the bibliography` : "") +
            `, in ${elapsed} s.`;

        showToast(notTried
            ? `Stopped early: requests are being limited. Fetched ${fetched} of ${plural(dois.length, "DOI", "DOIs")}. Wait a few minutes, then press Retry failed.`
            : `Fetched ${fetched} of ${plural(dois.length, "DOI", "DOIs")} in ${elapsed} s.`,
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
    // 8. ERROR REPORT
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
    // 9. EVENT BINDINGS
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
        fetchedDOIs = new Set();
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
    // 10. TOASTS (the shared .stk-toast component)
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
    // 11. UTILITY HELPERS
    // ═══════════════════════════════════════════

    function escapeHtml(str) {
        const div = document.createElement("div");
        div.textContent = str;
        return div.innerHTML;
    }

    /** "a", "a and b", "a, b and c" */
    function listJoin(items) {
        return items.length < 2 ? items.join("")
            : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
    }

    function truncate(str, max) {
        return str.length > max ? str.slice(0, max) + "…" : str;
    }

    syncFieldsSummary();
    syncOutput();
});
