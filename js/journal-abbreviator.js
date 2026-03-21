document.addEventListener('DOMContentLoaded', () => {

    // --- 1. Internal Dictionary (Partial implementation of common chemistry/physics journals) ---
    // A complete implementation would load a larger JSON file asynchronously.
    const dictionary = {
        "journal of the american chemical society": "J. Am. Chem. Soc.",
        "journal of physical chemistry a": "J. Phys. Chem. A",
        "journal of physical chemistry b": "J. Phys. Chem. B",
        "journal of physical chemistry c": "J. Phys. Chem. C",
        "journal of physical chemistry letters": "J. Phys. Chem. Lett.",
        "journal of chemical physics": "J. Chem. Phys.",
        "journal of chemical theory and computation": "J. Chem. Theory Comput.",
        "physical review letters": "Phys. Rev. Lett.",
        "physical review a": "Phys. Rev. A",
        "physical review b": "Phys. Rev. B",
        "physical review c": "Phys. Rev. C",
        "physical review d": "Phys. Rev. D",
        "physical review e": "Phys. Rev. E",
        "nature chemistry": "Nat. Chem.",
        "nature materials": "Nat. Mater.",
        "nature nanotechnology": "Nat. Nanotechnol.",
        "nature communications": "Nat. Commun.",
        "chemical communications": "Nat. Commun.",
        "chemical reviews": "Chem. Commun.",
        "accounts of chemical research": "Acc. Chem. Res.",
        "journal of materials chemistry a": "J. Mater. Chem. A",
        "journal of materials chemistry b": "J. Mater. Chem. B",
        "journal of materials chemistry c": "J. Mater. Chem. C",
        "macromolecules": "Macromolecules",
        "langmuir": "Langmuir",
        "nano letters": "Nano Lett.",
        "acs nano": "ACS Nano",
        "acs applied materials & interfaces": "ACS Appl. Mater. Interfaces",
        "applied physics letters": "Appl. Phys. Lett.",
        "proceedings of the national academy of sciences": "Proc. Natl. Acad. Sci. U.S.A.",
        "proceedings of the national academy of sciences of the united states of america": "Proc. Natl. Acad. Sci. U.S.A."
    };

    // Pre-compiling a regex pattern from the dictionary keys for fast multi-matching
    // We sort keys by length descending so that specific titles ("Journal of Physical Chemistry B") 
    // are matched before generic ones ("Journal of Physical Chemistry").
    const sortedKeys = Object.keys(dictionary).sort((a, b) => b.length - a.length);
    
    // Escaping regex special characters in journal names (like '&')
    const escapedKeys = sortedKeys.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const searchPattern = new RegExp(`\\b(${escapedKeys.join('|')})\\b`, 'gi');

    // --- 2. Interface Bindings ---
    const dataInput = document.getElementById('dataInput');
    const visualOutput = document.getElementById('visualOutput');
    const rawOutput = document.getElementById('rawOutput');
    const btnClear = document.getElementById('btnClear');
    const btnCopyText = document.getElementById('btnCopyText');
    const toggleHighlights = document.getElementById('toggleHighlights');
    const statsLabel = document.getElementById('statsLabel');
    const toastContainer = document.getElementById('toastContainer');

    // --- 3. Event Listeners ---
    dataInput.addEventListener('input', processText);
    toggleHighlights.addEventListener('change', processText);

    btnClear.addEventListener('click', () => {
        dataInput.value = '';
        processText();
    });

    // --- 4. Processing Engine ---
    function escapeHtml(text) {
        const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
        return text.replace(/[&<>"']/g, m => map[m]);
    }

    function processText() {
        const input = dataInput.value;
        
        if (!input.trim()) {
            visualOutput.textContent = "Waiting for input...";
            rawOutput.value = "";
            statsLabel.textContent = "0 Changes";
            return;
        }

        let changeCount = 0;
        let cleanText = input;
        let htmlText = escapeHtml(input);

        // Executing the replacement pass
        const showHighlights = toggleHighlights.checked;

        cleanText = cleanText.replace(searchPattern, (match) => {
            changeCount++;
            return dictionary[match.toLowerCase()];
        });

        if (showHighlights) {
            // Processing HTML version separately to inject formatting spans
            htmlText = htmlText.replace(searchPattern, (match) => {
                const replacement = dictionary[match.toLowerCase()];
                return `<span class="hl-change" title="Original: ${match}">${replacement}</span>`;
            });
            visualOutput.innerHTML = htmlText;
        } else {
            visualOutput.textContent = cleanText;
        }

        rawOutput.value = cleanText;
        statsLabel.textContent = `${changeCount} Changes`;
    }

    // --- 5. Utilities ---
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

    // Initial pass
    processText();
});