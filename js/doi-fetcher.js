document.addEventListener("DOMContentLoaded", () => {
    
    // --- State Management ---
    let entryCount = 0;

    // --- DOM Elements ---
    const doiInput = document.getElementById('doiInput');
    const fetchBtn = document.getElementById('fetchBtn');
    const bibOutput = document.getElementById('bibOutput');
    const loadingOverlay = document.getElementById('loadingOverlay');
    const entryCountBadge = document.getElementById('entryCount');
    
    const copyBtn = document.getElementById('copyBtn');
    const downloadBtn = document.getElementById('downloadBtn');
    const clearBtn = document.getElementById('clearBtn');

    // --- Theme Toggle ---
    document.getElementById('themeToggle').addEventListener('click', () => {
        document.documentElement.classList.toggle('dark');
        localStorage.theme = document.documentElement.classList.contains('dark') ? 'dark' : 'light';
    });

    // Allow pressing "Enter" in the input field to trigger the fetch
    doiInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            executeFetch();
        }
    });

    fetchBtn.addEventListener('click', executeFetch);

    // --- Fetch Pipeline ---
    async function executeFetch() {
        const rawInput = doiInput.value.trim();
        
        if (!rawInput) {
            showToast("Please enter a valid DOI string.", "error");
            return;
        }

        // Clean the DOI string (Removes https://doi.org/ or dx.doi.org/ prefixes)
        const cleanDOI = rawInput.replace(/^(https?:\/\/)?(dx\.)?doi\.org\//i, '').trim();

        fetchBtn.disabled = true;
        loadingOverlay.classList.remove('hidden');

        try {
            // Using standard Content Negotiation to ask doi.org for BibTeX format
            const response = await fetch(`https://doi.org/${cleanDOI}`, {
                method: 'GET',
                headers: {
                    'Accept': 'application/x-bibtex; charset=utf-8'
                }
            });

            if (!response.ok) {
                if (response.status === 404) {
                    throw new Error("DOI not found in the global registry.");
                } else {
                    throw new Error(`Server returned status: ${response.status}`);
                }
            }

            const bibtexData = await response.text();
            
            // Append the new entry to the output area
            if (bibOutput.value.trim() !== "") {
                bibOutput.value += "\n\n";
            }
            bibOutput.value += bibtexData.trim();
            
            entryCount++;
            entryCountBadge.innerText = `${entryCount} ${entryCount === 1 ? 'Entry' : 'Entries'}`;
            
            doiInput.value = ''; // Clear input for the next DOI
            showToast("Citation successfully retrieved.", "success");

        } catch (error) {
            console.error(error);
            showToast(error.message, "error");
        } finally {
            fetchBtn.disabled = false;
            loadingOverlay.classList.add('hidden');
            doiInput.focus();
        }
    }

    // --- Utility Controls ---
    copyBtn.addEventListener('click', () => {
        if (!bibOutput.value.trim()) {
            showToast("Nothing to copy.", "error");
            return;
        }
        bibOutput.select();
        document.execCommand('copy');
        showToast("Bibliography copied to clipboard.", "info");
        // Deselect text
        window.getSelection().removeAllRanges();
    });

    downloadBtn.addEventListener('click', () => {
        if (!bibOutput.value.trim()) {
            showToast("Bibliography is empty.", "error");
            return;
        }
        const blob = new Blob([bibOutput.value], { type: 'text/plain;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.setAttribute("href", url);
        link.setAttribute("download", "references.bib");
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        showToast("Saved as references.bib", "success");
    });

    clearBtn.addEventListener('click', () => {
        bibOutput.value = '';
        entryCount = 0;
        entryCountBadge.innerText = `0 Entries`;
        showToast("Workspace cleared.", "info");
    });

    // --- Notification System ---
    function showToast(msg, type) {
        const container = document.getElementById('toastContainer');
        const toast = document.createElement('div');
        
        const colors = type === 'success' ? 'bg-emerald-50 text-emerald-800 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-400' : 
                       type === 'error' ? 'bg-red-50 text-red-800 border-red-200 dark:bg-red-900/30 dark:text-red-400' : 
                       'bg-indigo-50 text-indigo-800 border-indigo-200 dark:bg-indigo-900/30 dark:text-indigo-400';
        
        toast.className = `px-4 py-3 rounded-xl border shadow-lg toast-enter text-sm font-medium transition-all ${colors}`;
        toast.innerHTML = `<i class="fa-solid ${type==='success' ? 'fa-check-circle' : type==='error' ? 'fa-triangle-exclamation' : 'fa-info-circle'} mr-2"></i> ${msg}`;
        
        container.appendChild(toast);
        setTimeout(() => {
            toast.style.opacity = '0';
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }
});