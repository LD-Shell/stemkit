document.addEventListener('DOMContentLoaded', () => {

    // # --- 1. Internal dictionary ---
    // # A complete implementation would load a larger JSON file asynchronously
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

    // # I am pre-compiling a regex pattern from the dictionary keys for fast multi-matching
    // # Sorting keys by length descending ensures specific titles are matched before generic ones
    const sortedKeys = Object.keys(dictionary).sort((a, b) => b.length - a.length);
    
    // # I am escaping regex special characters in journal names to prevent parsing faults
    const escapedKeys = sortedKeys.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const searchPattern = new RegExp(`\\b(${escapedKeys.join('|')})\\b`, 'gi');

    // # --- 2. Interface bindings ---
    const dataInput = document.getElementById('dataInput');
    const visualOutput = document.getElementById('visualOutput');
    const rawOutput = document.getElementById('rawOutput');
    const btnClear = document.getElementById('btnClear');
    const btnCopyText = document.getElementById('btnCopyText');
    const toggleHighlights = document.getElementById('toggleHighlights');
    const statsLabel = document.getElementById('statsLabel');
    const toastContainer = document.getElementById('toastContainer');

    // # --- 3. Event listeners ---
    dataInput.addEventListener('input', processText);
    toggleHighlights.addEventListener('change', processText);

    btnClear.addEventListener('click', () => {
        dataInput.value = '';
        processText();
    });

    // # --- 4. Processing engine ---
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

        const showHighlights = toggleHighlights.checked;

        // # Executing the replacement pass
        cleanText = cleanText.replace(searchPattern, (match) => {
            changeCount++;
            return dictionary[match.toLowerCase()];
        });

        if (showHighlights) {
            // # I am processing the HTML version separately to inject formatting spans for user visibility
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

    // # --- 5. Utilities ---
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

    // # Executing initial pass
    processText();
});