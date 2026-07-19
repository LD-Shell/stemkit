/*
 * STEMKit — BibTeX Reference Deduplicator
 * Author: Olanrewaju M. Daramola
 *
 * Matching strategy (documented for transparency):
 *   1. DOI match  — two entries are treated as the same work if they share a
 *                   normalised DOI (case-folded, with any doi.org/dx.doi.org
 *                   prefix stripped). DOIs are globally unique identifiers, so
 *                   this is the most reliable signal. See https://www.doi.org/
 *   2. Title match — entries are also merged if their normalised titles match
 *                   (lower-cased, LaTeX braces/commands removed, punctuation and
 *                   redundant whitespace stripped). This catches duplicates where
 *                   one copy is missing a DOI, which is common when merging
 *                   libraries exported from different databases.
 *
 * DOI and title links are merged transitively with a union-find structure, so a
 * chain such as A(doi)=B(title)=C is correctly collapsed into a single conflict.
 *
 * All processing runs locally in the browser. No entry ever leaves the device.
 */
document.addEventListener("DOMContentLoaded", () => {

    // --- State ---
    let parsedEntries = [];
    let conflictGroups = [];   // [{ members: [{originalIndex, data}] }]  (size > 1)
    let keptSingletons = [];   // entries that were unique (auto-kept)
    let resolutions = {};      // groupIndex -> selected entry object

    // --- DOM ---
    const fileInput = document.getElementById('fileInput');
    const bibInput = document.getElementById('bibInput');
    const scanBtn = document.getElementById('scanBtn');

    const diagnosticsCard = document.getElementById('diagnosticsCard');
    const totalEntriesCount = document.getElementById('totalEntriesCount');
    const duplicateCount = document.getElementById('duplicateCount');
    const exportBtn = document.getElementById('exportBtn');

    const emptyState = document.getElementById('emptyState');
    const conflictList = document.getElementById('conflictList');
    const autoResolveBtn = document.getElementById('autoResolveBtn');

    // --- File handling ---
    fileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (event) => {
            bibInput.value = event.target.result;
            scanForDuplicates();
        };
        reader.readAsText(file);
        // Allow re-uploading the same filename to re-trigger a scan.
        fileInput.value = '';
    });

    scanBtn.addEventListener('click', scanForDuplicates);

    // --- Helpers ---
    function normaliseDoi(raw) {
        return (raw || "")
            .trim()
            .toLowerCase()
            .replace(/^https?:\/\/(dx\.)?doi\.org\//, '')
            .replace(/\s+/g, '');
    }

    function normaliseTitle(raw) {
        return (raw || "")
            .toLowerCase()
            .replace(/[{}]/g, '')          // LaTeX grouping braces
            .replace(/\$[^$]*\$/g, '')     // inline math
            .replace(/\\[a-z]+/gi, '')     // LaTeX commands e.g. \emph
            .replace(/[^\w\s]/g, '')       // punctuation
            .replace(/\s+/g, ' ')
            .trim();
    }

    // --- Parse & scan ---
    function scanForDuplicates() {
        const rawBib = bibInput.value.trim();
        if (!rawBib) {
            showToast("Please input BibTeX data first.", "error");
            return;
        }

        try {
            parsedEntries = bibtexParse.toJSON(rawBib);
        } catch (error) {
            console.error(error);
            showToast("Syntax error in BibTeX. Check for missing brackets or commas.", "error");
            return;
        }

        // Keep only true reference entries (skip @string / @preamble / @comment).
        parsedEntries = parsedEntries.filter(e => e && e.entryTags && e.citationKey);

        if (parsedEntries.length === 0) {
            showToast("No valid BibTeX entries detected.", "error");
            return;
        }

        totalEntriesCount.innerText = parsedEntries.length;
        findDuplicates(parsedEntries);
    }

    // --- Union-find duplicate detection ---
    function findDuplicates(entries) {
        conflictGroups = [];
        keptSingletons = [];
        resolutions = {};

        const parent = new Array(entries.length);
        for (let i = 0; i < entries.length; i++) parent[i] = i;

        const find = (x) => {
            while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
            return x;
        };
        const union = (a, b) => {
            const ra = find(a), rb = find(b);
            if (ra !== rb) parent[rb] = ra;
        };

        const doiOwner = new Map();
        const titleOwner = new Map();

        entries.forEach((entry, i) => {
            const tags = entry.entryTags || {};
            const doi = normaliseDoi(tags.DOI || tags.doi || "");
            const title = normaliseTitle(tags.TITLE || tags.title || "");

            if (doi) {
                if (doiOwner.has(doi)) union(doiOwner.get(doi), i);
                else doiOwner.set(doi, i);
            }
            if (title) {
                if (titleOwner.has(title)) union(titleOwner.get(title), i);
                else titleOwner.set(title, i);
            }
        });

        // Collect connected components in original order.
        const components = new Map();
        entries.forEach((entry, i) => {
            const root = find(i);
            if (!components.has(root)) components.set(root, []);
            components.get(root).push(i);
        });

        components.forEach((members) => {
            if (members.length > 1) {
                conflictGroups.push({
                    members: members.map(i => ({ originalIndex: i, data: entries[i] }))
                });
            } else {
                keptSingletons.push(entries[members[0]]);
            }
        });

        // Stable ordering by first appearance.
        conflictGroups.sort((a, b) => a.members[0].originalIndex - b.members[0].originalIndex);

        renderDiagnostics();
    }

    // --- Diagnostics + list ---
    function renderDiagnostics() {
        diagnosticsCard.classList.remove('hidden');

        // "Duplicates" here means redundant entries that will be removed:
        // total minus the number of works that survive (singletons + one per group).
        const survivors = keptSingletons.length + conflictGroups.length;
        const redundant = parsedEntries.length - survivors;
        duplicateCount.innerText = redundant;

        if (conflictGroups.length === 0) {
            emptyState.innerHTML = `
                <i class="fa-solid fa-circle-check text-6xl mb-4 text-emerald-500"></i>
                <p class="font-medium text-emerald-600 dark:text-emerald-400">Library is clean. No duplicates found.</p>
            `;
            emptyState.classList.remove('hidden');
            conflictList.innerHTML = '';
            autoResolveBtn.classList.add('hidden');
            exportBtn.disabled = false;
        } else {
            emptyState.classList.add('hidden');
            autoResolveBtn.classList.remove('hidden');
            exportBtn.disabled = true; // resolve before export
            renderConflictList();
            showToast(`Found ${conflictGroups.length} conflict group${conflictGroups.length > 1 ? 's' : ''} (${redundant} redundant entr${redundant === 1 ? 'y' : 'ies'}).`, "info");
        }
    }

    function renderConflictList() {
        conflictList.innerHTML = '';

        // Progress indicator.
        const progress = document.createElement('div');
        progress.id = 'resolveProgress';
        progress.className = 'text-xs font-semibold text-slate-500 dark:text-slate-400 mb-1';
        conflictList.appendChild(progress);
        updateProgress();

        conflictGroups.forEach((group, groupIndex) => {
            const groupDiv = document.createElement('div');
            groupDiv.className = 'duplicate-group bg-slate-50 dark:bg-slate-900 border border-red-200 dark:border-red-900/50 rounded-xl p-4';
            groupDiv.dataset.groupIndex = groupIndex;

            const header = document.createElement('div');
            header.className = 'flex justify-between items-center mb-3 border-b border-slate-200 dark:border-slate-800 pb-2';
            header.innerHTML = `
                <span class="text-xs font-bold text-red-600 dark:text-red-400 uppercase tracking-widest">Conflict #${groupIndex + 1}</span>
                <span class="text-[10px] font-mono text-slate-400">${group.members.length} copies</span>
            `;
            groupDiv.appendChild(header);

            const optionsGrid = document.createElement('div');
            optionsGrid.className = 'grid grid-cols-1 md:grid-cols-2 gap-4';

            group.members.forEach((item) => {
                const tags = item.data.entryTags || {};
                const title = tags.TITLE || tags.title || "No Title";
                const author = tags.AUTHOR || tags.author || "Unknown Author";
                const year = tags.YEAR || tags.year || "N/A";
                const doi = tags.DOI || tags.doi || "";
                const key = item.data.citationKey;

                const card = document.createElement('div');
                card.className = 'bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-lg p-3 flex flex-col justify-between';
                card.innerHTML = `
                    <div>
                        <div class="text-xs font-mono text-slate-400 mb-1">Key: ${escapeHtml(key)}</div>
                        <h4 class="text-sm font-bold text-slate-800 dark:text-slate-200 mb-1 leading-tight">${escapeHtml(title.replace(/[{}]/g, ''))}</h4>
                        <p class="text-xs text-slate-500 mb-1">${escapeHtml(author)} (${escapeHtml(String(year))})</p>
                        ${doi ? `<p class="text-[10px] font-mono text-slate-400 mb-2 truncate">DOI: ${escapeHtml(doi)}</p>` : ''}
                    </div>
                    <button class="keep-btn w-full py-1.5 bg-slate-100 dark:bg-slate-800 hover:bg-indigo-600 hover:text-white dark:hover:bg-indigo-600 transition-colors rounded text-xs font-bold border border-slate-200 dark:border-slate-700 hover:border-transparent mt-2">
                        Keep This Entry
                    </button>
                `;

                card.querySelector('.keep-btn').addEventListener('click', () => {
                    resolveConflict(groupIndex, item.data, card);
                });

                optionsGrid.appendChild(card);
            });

            groupDiv.appendChild(optionsGrid);
            conflictList.appendChild(groupDiv);
        });
    }

    function updateProgress() {
        const el = document.getElementById('resolveProgress');
        if (el) {
            const done = Object.keys(resolutions).length;
            el.textContent = `Resolved ${done} of ${conflictGroups.length} conflicts`;
        }
    }

    // --- Resolution ---
    function resolveConflict(groupIndex, selectedEntry, chosenCard) {
        resolutions[groupIndex] = selectedEntry;

        const groupNode = conflictList.querySelector(`.duplicate-group[data-group-index="${groupIndex}"]`);
        if (groupNode) {
            groupNode.classList.add('resolved');
            // Highlight the chosen card for clarity.
            groupNode.querySelectorAll('.keep-btn').forEach(b => {
                b.classList.remove('bg-indigo-600', 'text-white');
                b.textContent = 'Keep This Entry';
            });
            if (chosenCard) {
                const btn = chosenCard.querySelector('.keep-btn');
                if (btn) { btn.classList.add('bg-indigo-600', 'text-white'); btn.textContent = 'Kept ✓'; }
            }
        }

        updateProgress();
        checkCompletion();
    }

    autoResolveBtn.addEventListener('click', () => {
        conflictGroups.forEach((group, index) => {
            if (resolutions[index] === undefined) {
                const groupNode = conflictList.querySelector(`.duplicate-group[data-group-index="${index}"]`);
                const firstCard = groupNode ? groupNode.querySelector('.bg-white, .dark\\:bg-slate-950') : null;
                resolveConflict(index, group.members[0].data, firstCard);
            }
        });
    });

    function checkCompletion() {
        if (Object.keys(resolutions).length === conflictGroups.length) {
            exportBtn.disabled = false;
            showToast("All conflicts resolved. Ready for export.", "success");
        }
    }

    // --- Serialize & export (order-preserving) ---
    function buildFinalList() {
        const chosenByIndex = new Map(); // originalIndex -> entry (for conflict winners)
        conflictGroups.forEach((group, gi) => {
            const winner = resolutions[gi];
            if (!winner) return;
            const member = group.members.find(m => m.data === winner) || group.members[0];
            chosenByIndex.set(member.originalIndex, winner);
        });

        const singletonSet = new Set(keptSingletons);
        const emittedWinners = new Set();
        const final = [];

        parsedEntries.forEach((entry, i) => {
            if (singletonSet.has(entry)) {
                final.push(entry);
            } else if (chosenByIndex.has(i)) {
                const winner = chosenByIndex.get(i);
                if (!emittedWinners.has(winner)) {
                    emittedWinners.add(winner);
                    final.push(winner);
                }
            }
        });
        return final;
    }

    function serializeEntry(entry) {
        const type = entry.entryType || 'misc';
        const key = entry.citationKey || '';
        const tags = entry.entryTags || {};
        const keys = Object.keys(tags);

        let out = `@${type}{${key},\n`;
        keys.forEach((k, index) => {
            out += `  ${k} = {${tags[k]}}${index < keys.length - 1 ? ',' : ''}\n`;
        });
        out += `}\n\n`;
        return out;
    }

    exportBtn.addEventListener('click', () => {
        const finalList = buildFinalList();
        const outputString = finalList.map(serializeEntry).join('');

        const blob = new Blob([outputString], { type: 'text/plain;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.setAttribute("href", url);
        link.setAttribute("download", "cleaned_references.bib");
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);

        showToast(`Exported ${finalList.length} unique entries.`, "success");
    });

    // --- Utilities ---
    function escapeHtml(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function showToast(msg, type) {
        const container = document.getElementById('toastContainer');
        const toast = document.createElement('div');
        const colors = type === 'success' ? 'bg-emerald-50 text-emerald-800 border-emerald-200' :
                       type === 'error' ? 'bg-red-50 text-red-800 border-red-200' :
                       'bg-indigo-50 text-indigo-800 border-indigo-200';

        toast.className = `px-4 py-3 rounded-xl border shadow-lg toast-enter text-sm font-medium transition-all ${colors}`;
        toast.innerHTML = `<i class="fa-solid ${type === 'success' ? 'fa-circle-check' : type === 'error' ? 'fa-triangle-exclamation' : 'fa-circle-info'} mr-2"></i> ${msg}`;

        container.appendChild(toast);
        setTimeout(() => {
            toast.style.opacity = '0';
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }
});
