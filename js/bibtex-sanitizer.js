/*
 * STEMKit — BibTeX Sanitizer
 * Author: Olanrewaju M. Daramola
 *
 * A dependency-free, brace-aware BibTeX cleaner. Unlike a naive regex, the field
 * reader below tracks brace depth, so values that contain nested braces
 * (e.g. title = {A study of {NaCl} crystals}) are parsed correctly rather than
 * being truncated at the first inner "}".
 *
 * Everything runs in the browser; nothing is uploaded.
 */
document.addEventListener('DOMContentLoaded', () => {

    // --- 1. Interface bindings ---
    const dataInput = document.getElementById('dataInput');
    const bibOutput = document.getElementById('bibOutput');
    const btnCopyCode = document.getElementById('btnCopyCode');
    const btnDownload = document.getElementById('btnDownload');       // optional
    const btnLoadExample = document.getElementById('btnLoadExample'); // optional
    const toastContainer = document.getElementById('toastContainer');
    const statsLabel = document.getElementById('statsLabel');

    // Rule toggles
    const optProtectTitle = document.getElementById('optProtectTitle');
    const optFixPages = document.getElementById('optFixPages');
    const optAlignEquals = document.getElementById('optAlignEquals');
    const stripOpts = document.querySelectorAll('.strip-opt');

    const PLACEHOLDER = "Processed syntax will appear here...";

    const EXAMPLE = `@article{smith2024,
  title={An analysis of {NaCl} molecular dynamics},
  author={Smith, John and Doe, Jane},
  journal={Journal of Physics},
  volume={12},
  pages={100-110},
  year={2024},
  doi={10.1000/example},
  url={https://tracking-link.example.com/abc},
  urldate={2024-05-01},
  abstract={A very long abstract that bloats the .bib file and is rarely needed for typesetting...},
  keywords={molecular dynamics; sodium chloride},
  file={:C\\:/papers/smith2024.pdf:PDF}
}`;

    // --- 2. Event listeners ---
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

    // --- 3. Brace-aware field reader ---
    // Given the inside of an entry (between the first "," after the key and the
    // final "}"), returns an ordered list of { key, value } pairs.
    function readFields(content) {
        const fields = [];
        let i = 0;
        const n = content.length;

        const isKeyChar = (c) => /[A-Za-z0-9_:\-\.]/.test(c);

        while (i < n) {
            // Skip separators / whitespace.
            while (i < n && /[\s,]/.test(content[i])) i++;
            if (i >= n) break;

            // Read the key.
            let key = '';
            while (i < n && isKeyChar(content[i])) { key += content[i]; i++; }
            if (!key) { i++; continue; }

            while (i < n && /\s/.test(content[i])) i++;
            if (content[i] !== '=') {
                // Malformed field — skip to the next comma.
                while (i < n && content[i] !== ',') i++;
                continue;
            }
            i++; // consume '='
            while (i < n && /\s/.test(content[i])) i++;

            let value = '';
            if (content[i] === '{') {
                let depth = 0;
                for (; i < n; i++) {
                    const c = content[i];
                    if (c === '{') { depth++; if (depth === 1) continue; }
                    else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
                    value += c;
                }
            } else if (content[i] === '"') {
                i++; // consume opening quote
                let depth = 0;
                for (; i < n; i++) {
                    const c = content[i];
                    if (c === '{') depth++;
                    else if (c === '}') depth--;
                    else if (c === '"' && depth === 0) { i++; break; }
                    value += c;
                }
            } else {
                // Bare value (number or string macro) up to the next comma.
                while (i < n && content[i] !== ',') { value += content[i]; i++; }
                value = value.trim();
            }

            fields.push({ key: key.toLowerCase(), value: value });
        }
        return fields;
    }

    // --- 4. Pipeline ---
    function processPipeline() {
        const rawText = dataInput.value;
        if (!rawText.trim()) {
            bibOutput.textContent = PLACEHOLDER;
            statsLabel.textContent = "Waiting for input...";
            return;
        }

        const fieldsToStrip = Array.from(stripOpts)
            .filter(opt => opt.checked)
            .map(opt => opt.value.toLowerCase());

        let processedEntries = 0;
        let fieldsRemoved = 0;

        // Split into blocks at each "@type{".
        const blocks = rawText.split(/(?=@\w+\s*\{)/g);
        let sanitizedText = '';

        blocks.forEach(block => {
            if (!block.trim().startsWith('@')) {
                sanitizedText += block; // preamble / stray text
                return;
            }

            // Pass through @string / @preamble / @comment unchanged.
            const typeMatch = block.match(/^@(\w+)/);
            const entryType = typeMatch ? typeMatch[1].toLowerCase() : '';
            if (['string', 'preamble', 'comment'].includes(entryType)) {
                sanitizedText += block;
                return;
            }

            const headerMatch = block.match(/(@\w+\s*\{\s*[^,]+,)/);
            if (!headerMatch) {
                sanitizedText += block;
                return;
            }

            processedEntries++;

            const header = headerMatch[1];
            const body = block.substring(header.length);
            const lastBraceIndex = body.lastIndexOf('}');
            const content = lastBraceIndex >= 0 ? body.substring(0, lastBraceIndex) : body;
            const tail = lastBraceIndex >= 0 ? body.substring(lastBraceIndex) : '}';

            let fields = readFields(content);

            // Apply rules.
            fields = fields.filter(f => {
                if (fieldsToStrip.includes(f.key)) { fieldsRemoved++; return false; }
                return true;
            });

            fields.forEach(f => {
                // Page dash normalisation: any hyphen/en-dash/em-dash run between
                // digits becomes the LaTeX en-dash "--". Idempotent.
                if (optFixPages.checked && (f.key === 'pages' || f.key === 'page')) {
                    f.value = f.value.replace(/(\d)\s*[-\u2013\u2014]+\s*(\d)/g, '$1--$2');
                }

                // Title casing protection: wrap the whole value in an extra brace
                // pair so bibliography styles won't re-case it. (See UI note: best
                // practice is usually to brace only the specific words that need
                // it — this is the blunt, whole-title version.)
                if (optProtectTitle.checked && (f.key === 'title' || f.key === 'booktitle')) {
                    f.value = f.value.replace(/^\s*\{+\s*/, '').replace(/\s*\}+\s*$/, '').trim();
                    f.value = `{${f.value}}`;
                }
            });

            // Reconstruct.
            let entryOutput = `${header}\n`;
            let maxKeyLength = 0;
            if (optAlignEquals.checked && fields.length > 0) {
                maxKeyLength = Math.max(...fields.map(f => f.key.length));
            }

            fields.forEach((f, index) => {
                const paddedKey = optAlignEquals.checked ? f.key.padEnd(maxKeyLength, ' ') : f.key;
                const isLast = index === fields.length - 1;
                entryOutput += `  ${paddedKey} = {${f.value}}${isLast ? '' : ','}\n`;
            });

            entryOutput += `${tail}\n`;
            sanitizedText += entryOutput;
        });

        bibOutput.textContent = sanitizedText.trim();
        statsLabel.textContent = `Parsed: ${processedEntries} | Stripped: ${fieldsRemoved}`;
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

    btnCopyCode.addEventListener('click', () => {
        const code = bibOutput.textContent;
        if (code === PLACEHOLDER) return;

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

    if (btnDownload) {
        btnDownload.addEventListener('click', () => {
            const code = bibOutput.textContent;
            if (!code || code === PLACEHOLDER) { showToast('Nothing to download yet.'); return; }
            const blob = new Blob([code + '\n'], { type: 'text/plain;charset=utf-8;' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'sanitized.bib';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            showToast('Downloaded sanitized.bib');
        });
    }

    if (btnLoadExample) {
        btnLoadExample.addEventListener('click', () => {
            dataInput.value = EXAMPLE;
            processPipeline();
            showToast('Loaded a sample entry.');
        });
    }

    // Initial parse (in case the browser restored text).
    processPipeline();
});
