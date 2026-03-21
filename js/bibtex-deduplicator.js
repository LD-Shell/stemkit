document.addEventListener("DOMContentLoaded", () => {
    
    // --- State Management ---
    let parsedEntries = [];
    let duplicateGroups = [];
    let resolvedEntries = [];

    // --- DOM Elements ---
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

    // --- Theme Toggle ---
    document.getElementById('themeToggle').addEventListener('click', () => {
        document.documentElement.classList.toggle('dark');
        localStorage.theme = document.documentElement.classList.contains('dark') ? 'dark' : 'light';
    });

    // --- File Handling ---
    fileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (event) => {
            bibInput.value = event.target.result;
            scanForDuplicates();
        };
        reader.readAsText(file);
    });

    scanBtn.addEventListener('click', scanForDuplicates);

    // --- BibTeX Parsing and Matrix Generation ---
    function scanForDuplicates() {
        const rawBib = bibInput.value.trim();
        if (!rawBib) {
            showToast("Please input BibTeX data first.", "error");
            return;
        }

        try {
            // Using bibtexParseJs to convert raw strings into JSON objects
            parsedEntries = bibtexParse.toJSON(rawBib);
        } catch (error) {
            console.error(error);
            showToast("Syntax error in BibTeX formatting. Please check for missing brackets.", "error");
            return;
        }

        if (parsedEntries.length === 0) {
            showToast("No valid BibTeX entries detected.", "error");
            return;
        }

        totalEntriesCount.innerText = parsedEntries.length;
        findDuplicates(parsedEntries);
    }

    function findDuplicates(entries) {
        const titleMap = new Map();
        const doiMap = new Map();
        duplicateGroups = [];
        resolvedEntries = [];

        // Identifying duplicates through strict mathematical mapping
        entries.forEach((entry, index) => {
            let isDuplicate = false;
            
            // Extract attributes safely handling casing
            const tags = entry.entryTags || {};
            const doi = (tags.DOI || tags.doi || "").trim().toLowerCase();
            const rawTitle = tags.TITLE || tags.title || "";
            // Normalize title: lowercase, strip punctuation and excessive whitespace
            const title = rawTitle.toLowerCase().replace(/[{}]/g, '').replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();

            let targetGroup = null;

            // Priority 1: DOI Matching (most accurate)
            if (doi && doiMap.has(doi)) {
                targetGroup = doiMap.get(doi);
                isDuplicate = true;
            } 
            // Priority 2: Title Matching
            else if (title && titleMap.has(title)) {
                targetGroup = titleMap.get(title);
                isDuplicate = true;
            }

            if (isDuplicate && targetGroup) {
                targetGroup.push({ originalIndex: index, data: entry });
            } else {
                // Not currently a duplicate, initialize new groups
                const newGroup = [{ originalIndex: index, data: entry }];
                if (doi) doiMap.set(doi, newGroup);
                if (title) titleMap.set(title, newGroup);
                // Temporarily push to resolved. If it becomes a duplicate group later, we will handle it.
                resolvedEntries.push(entry); 
            }
        });

        // Filter maps to find arrays with length > 1
        const uniqueGroups = new Set();
        
        doiMap.forEach(group => {
            if (group.length > 1) uniqueGroups.add(group);
        });
        
        titleMap.forEach(group => {
            if (group.length > 1) uniqueGroups.add(group);
        });

        duplicateGroups = Array.from(uniqueGroups);

        // Remove the original items of duplicate groups from the resolved pool
        duplicateGroups.forEach(group => {
            const firstItemIndex = group[0].originalIndex;
            resolvedEntries = resolvedEntries.filter(e => entries.indexOf(e) !== firstItemIndex);
        });

        renderDiagnostics();
    }

    // --- UI Rendering ---
    function renderDiagnostics() {
        diagnosticsCard.classList.remove('hidden');
        duplicateCount.innerText = duplicateGroups.length;
        
        if (duplicateGroups.length === 0) {
            emptyState.innerHTML = `
                <i class="fa-solid fa-check-circle text-6xl mb-4 text-emerald-500"></i>
                <p class="font-medium text-emerald-600 dark:text-emerald-400">Library is clean. No duplicates found.</p>
            `;
            emptyState.classList.remove('hidden');
            conflictList.innerHTML = '';
            autoResolveBtn.classList.add('hidden');
            exportBtn.disabled = false;
        } else {
            emptyState.classList.add('hidden');
            autoResolveBtn.classList.remove('hidden');
            exportBtn.disabled = true; // Force user to resolve before export
            renderConflictList();
            showToast(`Detected ${duplicateGroups.length} conflicting groups.`, "info");
        }
    }

    function renderConflictList() {
        conflictList.innerHTML = '';

        duplicateGroups.forEach((group, groupIndex) => {
            const groupDiv = document.createElement('div');
            groupDiv.className = 'duplicate-group bg-slate-50 dark:bg-slate-900 border border-red-200 dark:border-red-900/50 rounded-xl p-4';
            
            const header = document.createElement('div');
            header.className = 'flex justify-between items-center mb-3 border-b border-slate-200 dark:border-slate-800 pb-2';
            header.innerHTML = `<span class="text-xs font-bold text-red-600 dark:text-red-400 uppercase tracking-widest">Conflict #${groupIndex + 1}</span>`;
            groupDiv.appendChild(header);

            const optionsGrid = document.createElement('div');
            optionsGrid.className = 'grid grid-cols-1 md:grid-cols-2 gap-4';

            group.forEach((item) => {
                const tags = item.data.entryTags;
                const title = tags.TITLE || tags.title || "No Title";
                const author = tags.AUTHOR || tags.author || "Unknown Author";
                const year = tags.YEAR || tags.year || "N/A";
                const key = item.data.citationKey;

                const card = document.createElement('div');
                card.className = 'bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-lg p-3 flex flex-col justify-between';
                card.innerHTML = `
                    <div>
                        <div class="text-xs font-mono text-slate-400 mb-1">Key: ${key}</div>
                        <h4 class="text-sm font-bold text-slate-800 dark:text-slate-200 mb-1 leading-tight">${title.replace(/[{}]/g, '')}</h4>
                        <p class="text-xs text-slate-500 mb-2">${author} (${year})</p>
                    </div>
                    <button class="keep-btn w-full py-1.5 bg-slate-100 dark:bg-slate-800 hover:bg-indigo-600 hover:text-white dark:hover:bg-indigo-600 transition-colors rounded text-xs font-bold border border-slate-200 dark:border-slate-700 hover:border-transparent mt-2">
                        Keep This Entry
                    </button>
                `;

                card.querySelector('.keep-btn').addEventListener('click', () => {
                    resolveConflict(groupIndex, item.data);
                });

                optionsGrid.appendChild(card);
            });

            groupDiv.appendChild(optionsGrid);
            conflictList.appendChild(groupDiv);
        });
    }

    // --- State Resolution ---
    function resolveConflict(groupIndex, selectedEntry) {
        resolvedEntries.push(selectedEntry);
        
        const groupNodes = document.querySelectorAll('.duplicate-group');
        if (groupNodes[groupIndex]) {
            groupNodes[groupIndex].classList.add('resolved');
        }

        checkCompletion();
    }

    autoResolveBtn.addEventListener('click', () => {
        duplicateGroups.forEach((group, index) => {
            const groupNodes = document.querySelectorAll('.duplicate-group');
            if (groupNodes[index] && !groupNodes[index].classList.contains('resolved')) {
                resolveConflict(index, group[0].data); // Automatically keep the first appearance
            }
        });
    });

    function checkCompletion() {
        const resolvedCount = document.querySelectorAll('.duplicate-group.resolved').length;
        if (resolvedCount === duplicateGroups.length) {
            exportBtn.disabled = false;
            showToast("All conflicts resolved. Ready for export.", "success");
        }
    }

    // --- Client-Side Serialization & Export ---
    exportBtn.addEventListener('click', () => {
        let outputString = "";

        // Reconstructing BibTeX formatting
        resolvedEntries.forEach(entry => {
            outputString += `@${entry.entryType}{${entry.citationKey},\n`;
            
            const tags = entry.entryTags;
            const keys = Object.keys(tags);
            
            keys.forEach((key, index) => {
                outputString += `  ${key} = {${tags[key]}}${index < keys.length - 1 ? ',' : ''}\n`;
            });
            
            outputString += `}\n\n`;
        });

        const blob = new Blob([outputString], { type: 'text/plain;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.setAttribute("href", url);
        link.setAttribute("download", "cleaned_references.bib");
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);

        showToast("Cleaned bibliography exported.", "success");
    });

    // --- Utility Notification Handler ---
    function showToast(msg, type) {
        const container = document.getElementById('toastContainer');
        const toast = document.createElement('div');
        const colors = type === 'success' ? 'bg-emerald-50 text-emerald-800 border-emerald-200' : 
                       type === 'error' ? 'bg-red-50 text-red-800 border-red-200' : 
                       'bg-indigo-50 text-indigo-800 border-indigo-200';
        
        toast.className = `px-4 py-3 rounded-xl border shadow-lg toast-enter text-sm font-medium transition-all ${colors}`;
        toast.innerHTML = `<i class="fa-solid ${type==='success' ? 'fa-check-circle' : type==='error' ? 'fa-triangle-exclamation' : 'fa-info-circle'} mr-2"></i> ${msg}`;
        
        container.appendChild(toast);
        setTimeout(() => {
            toast.style.opacity = '0';
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }
});