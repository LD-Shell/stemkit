document.addEventListener('DOMContentLoaded', () => {

    // --- 1. Interface Bindings ---
    const dataInput = document.getElementById('dataInput');
    const bibOutput = document.getElementById('bibOutput');
    const btnCopyCode = document.getElementById('btnCopyCode');
    const toastContainer = document.getElementById('toastContainer');
    const statsLabel = document.getElementById('statsLabel');

    // Rule toggles
    const optProtectTitle = document.getElementById('optProtectTitle');
    const optFixPages = document.getElementById('optFixPages');
    const optAlignEquals = document.getElementById('optAlignEquals');
    const stripOpts = document.querySelectorAll('.strip-opt');

    // --- 2. Event Listeners ---
    const updateTriggers = [dataInput, optProtectTitle, optFixPages, optAlignEquals, ...Array.from(stripOpts)];
    updateTriggers.forEach(el => el.addEventListener('input', processPipeline));
    updateTriggers.forEach(el => el.addEventListener('change', processPipeline));

    // Accordion logic
    document.querySelectorAll('.accordion-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const isExpanded = btn.getAttribute('aria-expanded') === 'true';
            btn.setAttribute('aria-expanded', !isExpanded);
            document.getElementById(btn.getAttribute('data-target')).classList.toggle('expanded');
        });
    });

    // --- 3. Custom BibTeX Parser & Sanitizer ---
    function processPipeline() {
        const rawText = dataInput.value;
        if (!rawText.trim()) {
            bibOutput.textContent = "Processed syntax will appear here...";
            statsLabel.textContent = "Waiting for input...";
            return;
        }

        // Determine fields to strip
        const fieldsToStrip = Array.from(stripOpts).filter(opt => opt.checked).map(opt => opt.value.toLowerCase());
        
        let processedEntries = 0;
        let fieldsRemoved = 0;

        // Splitting by '@' to isolate individual entries. 
        // This is a robust client-side approach that avoids complex nested bracket regex failures.
        const blocks = rawText.split(/(?=@\w+\s*\{)/g);
        let sanitizedText = '';

        blocks.forEach(block => {
            if (!block.trim().startsWith('@')) {
                // Preserving preamble or comments outside entries
                sanitizedText += block;
                return;
            }

            processedEntries++;

            // Extracting the header (e.g., @article{smith2024,) and the body
            const headerMatch = block.match(/(@\w+\s*\{\s*[^,]+,)/);
            if (!headerMatch) {
                sanitizedText += block;
                return;
            }

            const header = headerMatch[1];
            let body = block.substring(header.length);
            
            // Finding the final closing brace for the entry
            const lastBraceIndex = body.lastIndexOf('}');
            let content = body.substring(0, lastBraceIndex);
            const tail = body.substring(lastBraceIndex);

            // Parsing individual fields within the entry body
            // This regex captures key-value pairs, handling both {...} and "..." value enclosures
            const fieldRegex = /^\s*([a-zA-Z0-9_:-]+)\s*=\s*(?:\{([\s\S]*?)\}|"([\s\S]*?)")\s*(?:,|$)/gm;
            let fields = [];
            let match;
            
            while ((match = fieldRegex.exec(content)) !== null) {
                const key = match[1].toLowerCase();
                let value = match[2] !== undefined ? match[2] : match[3];

                // Execute Field Stripping
                if (fieldsToStrip.includes(key)) {
                    fieldsRemoved++;
                    continue; 
                }

                // Execute Page Dash Correction
                if (optFixPages.checked && (key === 'pages' || key === 'page')) {
                    // Replaces single hyphens between numbers with standard LaTeX en-dash (--)
                    value = value.replace(/(\d+)\s*-\s*(\d+)/g, '$1--$2');
                }

                // Execute Title Capitalization Protection
                if (optProtectTitle.checked && (key === 'title' || key === 'booktitle')) {
                    // Strips existing double braces to prevent recursive nesting upon multiple passes
                    value = value.replace(/^\{+/, '').replace(/\}+$/, '');
                    // Wraps the entire title value in double braces for strict LaTeX preservation
                    value = `{${value}}`;
                }

                fields.push({ key: key, value: value });
            }

            // Reconstructing the entry
            let entryOutput = `${header}\n`;
            
            // Calculating optimal padding for the equal signs if alignment is enabled
            let maxKeyLength = 0;
            if (optAlignEquals.checked && fields.length > 0) {
                maxKeyLength = Math.max(...fields.map(f => f.key.length));
            }

            fields.forEach((f, index) => {
                let paddedKey = f.key;
                if (optAlignEquals.checked) {
                    paddedKey = f.key.padEnd(maxKeyLength, ' ');
                }
                
                const isLast = index === fields.length - 1;
                // Formatting standard field output
                entryOutput += `  ${paddedKey} = {${f.value}}${isLast ? '' : ','}\n`;
            });

            entryOutput += `${tail}\n`;
            sanitizedText += entryOutput;
        });

        bibOutput.textContent = sanitizedText.trim();
        statsLabel.textContent = `Parsed: ${processedEntries} | Stripped: ${fieldsRemoved}`;
    }

    // --- 4. Utilities ---
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

    btnCopyCode.addEventListener('click', () => {
        const code = bibOutput.textContent;
        if (code === "Processed syntax will appear here...") return;

        navigator.clipboard.writeText(code).then(() => {
            showToast('Sanitized BibTeX copied to clipboard!');
            
            const originalHTML = btnCopyCode.innerHTML;
            btnCopyCode.innerHTML = '<i class="fa-solid fa-check"></i> Copied!';
            btnCopyCode.classList.replace('bg-sky-600', 'bg-emerald-600');
            
            setTimeout(() => {
                btnCopyCode.innerHTML = originalHTML;
                btnCopyCode.classList.replace('bg-emerald-600', 'bg-sky-600');
            }, 2000);
        });
    });

    // Run initial parse in case data was restored from browser cache
    processPipeline();
});