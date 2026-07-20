document.addEventListener('DOMContentLoaded', () => {

    // # --- 1. Interface bindings ---
    const dataInput = document.getElementById('dataInput');
    const envSelect = document.getElementById('envSelect');
    const styleSelect = document.getElementById('styleSelect');
    const captionInput = document.getElementById('captionInput');
    const labelInput = document.getElementById('labelInput');
    const alignRadios = document.getElementsByName('align');

    const tablePreview = document.getElementById('tablePreview');
    const latexOutput = document.getElementById('latexOutput');
    const btnCopyCode = document.getElementById('btnCopyCode');
    const btnDownload = document.getElementById('btnDownload'); // optional
    const btnExample = document.getElementById('btnExample');   // optional
    const toastContainer = document.getElementById('toastContainer');

    const PLACEHOLDER = "Waiting for input matrix...";
    const EXAMPLE = "Material\tBand gap (eV)\tRole\nSilicon\t1.12\tSemiconductor\nGaAs\t1.42\tSemiconductor\nDiamond\t5.47\tInsulator";

    // # --- 2. Event listeners ---
    [dataInput, envSelect, styleSelect, captionInput, labelInput].forEach(el => el.addEventListener('input', processPipeline));
    Array.from(alignRadios).forEach(radio => radio.addEventListener('change', processPipeline));

    document.querySelectorAll('.accordion-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const isExpanded = btn.getAttribute('aria-expanded') === 'true';
            btn.setAttribute('aria-expanded', !isExpanded);
            document.getElementById(btn.getAttribute('data-target')).classList.toggle('expanded');
        });
    });

    if (btnExample) btnExample.addEventListener('click', () => { dataInput.value = EXAMPLE; processPipeline(); });

    function parseInputData(rawText) {
    if (!rawText.trim()) return [];

    // 1. Detect the global delimiter (prefer tab, then comma, then space)
    const delimiter = rawText.includes('\t') ? '\t' : (rawText.includes(',') ? ',' : ' ');

    const matrix = [];
    let currentRow = [];
    let currentCell = '';
    let insideQuotes = false;

    // 2. Read the text character by character
    for (let i = 0; i < rawText.length; i++) {
        const char = rawText[i];
        const nextChar = rawText[i + 1];

        if (char === '"') {
            // Excel escapes literal quotes by doubling them ("")
            if (insideQuotes && nextChar === '"') {
                currentCell += '"';
                i++; // Skip the second quote so we don't process it twice
            } else {
                // Toggle our state machine: entering or exiting a quoted cell
                insideQuotes = !insideQuotes;
            }
        } else if (char === delimiter && !insideQuotes) {
            // We hit a delimiter OUTSIDE of quotes -> End of the cell
            currentRow.push(currentCell.trim());
            currentCell = '';
        } else if ((char === '\n' || char === '\r') && !insideQuotes) {
            // We hit a newline OUTSIDE of quotes -> End of the row
            if (char === '\r' && nextChar === '\n') i++; // Handle Windows \r\n
            
            currentRow.push(currentCell.trim());
            matrix.push(currentRow);
            
            // Reset for the next row
            currentRow = [];
            currentCell = '';
        } else {
            // Just a normal character (or a newline INSIDE quotes)
            currentCell += char;
        }
    }

    // 3. Catch the very last cell/row if the text didn't end with a newline
    if (currentCell !== '' || currentRow.length > 0) {
        currentRow.push(currentCell.trim());
        matrix.push(currentRow);
    }

    // 4. Cleanup: Remove completely empty rows and pad missing columns
    const cleanMatrix = matrix.filter(row => row.some(cell => cell !== ''));
    
    let maxCols = 0;
    cleanMatrix.forEach(row => {
        if (row.length > maxCols) maxCols = row.length;
    });

    return cleanMatrix.map(row => {
        while (row.length < maxCols) row.push('');
        return row;
    });
    }
    
    // # --- 4. HTML preview ---
    function renderPreview(matrix) {
        if (matrix.length === 0) {
            tablePreview.innerHTML = '<span class="text-slate-400">Paste data to render preview.</span>';
            return;
        }
        const style = styleSelect.value;
        const align = Array.from(alignRadios).find(r => r.checked).value;
        const alignMap = { 'l': 'text-left', 'c': 'text-center', 'r': 'text-right' };
        let html = `<table class="preview-table ${style === 'booktabs' ? 'booktabs' : ''}">`;
        html += `<thead><tr>`;
        matrix[0].forEach(h => { html += `<th class="${alignMap[align]}">${escapeHtml(h)}</th>`; });
        html += `</tr></thead><tbody>`;
        for (let i = 1; i < matrix.length; i++) {
            html += `<tr>`;
            matrix[i].forEach(cell => { html += `<td class="${alignMap[align]}">${escapeHtml(cell)}</td>`; });
            html += `</tr>`;
        }
        html += `</tbody></table>`;
        tablePreview.innerHTML = html;
    }

    // # --- 5. LaTeX generation ---
    function generateLatex(matrix) {
        if (matrix.length === 0) {
            latexOutput.textContent = PLACEHOLDER;
            return;
        }
        const env = envSelect.value;
        const style = styleSelect.value;
        const caption = captionInput.value.trim();
        const label = labelInput.value.trim();
        const align = Array.from(alignRadios).find(r => r.checked).value;
        const colCount = matrix[0].length;

        // Column spec
        let colSpec;
        if (style === 'grid') {
            colSpec = '|' + Array(colCount).fill(align).join('|') + '|';
        } else {
            colSpec = Array(colCount).fill(align).join('');
            if (style === 'booktabs') colSpec = '@{}' + colSpec + '@{}';
        }

        // Required-package reminders (as comments) so the snippet compiles as-is
        const pkgs = [];
        if (style === 'booktabs') pkgs.push('\\usepackage{booktabs}');
        if (env === 'sidewaystable') pkgs.push('\\usepackage{rotating}');
        let latex = '';
        if (pkgs.length) latex += pkgs.map(p => `% Requires: ${p}`).join('\n') + '\n';

        latex += `\\begin{${env}}[htbp]\n\\centering\n`;
        if (caption) latex += `\\caption{${escapeLatex(caption)}}\n`;
        if (label) latex += `\\label{${escapeLatex(label)}}\n`;
        latex += `\\begin{tabular}{${colSpec}}\n`;

        if (style === 'booktabs') latex += `\\toprule\n`;
        else if (style === 'grid' || style === 'standard') latex += `\\hline\n`;

        latex += `    ${matrix[0].map(escapeLatex).join(' & ')} \\\\\n`;

        if (style === 'booktabs') latex += `\\midrule\n`;
        else if (style === 'grid' || style === 'standard') latex += `\\hline\n`;

        for (let i = 1; i < matrix.length; i++) {
            latex += `    ${matrix[i].map(escapeLatex).join(' & ')} \\\\\n`;
            if (style === 'grid') latex += `\\hline\n`;
        }

        if (style === 'booktabs') latex += `\\bottomrule\n`;
        else if (style === 'standard') latex += `\\hline\n`;

        latex += `\\end{tabular}\n\\end{${env}}`;
        latexOutput.textContent = latex;
    }

    // # --- 6. Pipeline + utils ---
    function processPipeline() {
        const matrix = parseInputData(dataInput.value);
        renderPreview(matrix);
        generateLatex(matrix);
    }

    function escapeHtml(text) {
        const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
        return text.replace(/[&<>"']/g, m => map[m]);
    }

    // Single-pass escaping: replace() scans the ORIGINAL string, so the braces
    // inserted by \textbackslash{} etc. are never themselves re-escaped (the old
    // two-step version produced broken \textbackslash\{\} for any cell with a "\").
    function escapeLatex(text) {
        const map = {
            '&': '\\&', '%': '\\%', '$': '\\$', '#': '\\#', '_': '\\_',
            '{': '\\{', '}': '\\}',
            '~': '\\textasciitilde{}', '^': '\\textasciicircum{}', '\\': '\\textbackslash{}'
        };
        return text.toString().replace(/[&%$#_{}~^\\]/g, c => map[c]);
    }

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
        const code = latexOutput.textContent;
        if (!code || code === PLACEHOLDER) return;
        navigator.clipboard.writeText(code).then(() => {
            showToast('LaTeX syntax copied to clipboard!');
            const originalHTML = btnCopyCode.innerHTML;
            btnCopyCode.innerHTML = '<i class="fa-solid fa-check"></i> Copied!';
            btnCopyCode.classList.replace('bg-teal-600', 'bg-emerald-600');
            setTimeout(() => {
                btnCopyCode.innerHTML = originalHTML;
                btnCopyCode.classList.replace('bg-emerald-600', 'bg-teal-600');
            }, 2000);
        });
    });

    if (btnDownload) {
        btnDownload.addEventListener('click', () => {
            const code = latexOutput.textContent;
            if (!code || code === PLACEHOLDER) { showToast('Nothing to download yet.'); return; }
            const blob = new Blob([code], { type: 'text/plain;charset=utf-8;' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = 'table.tex';
            document.body.appendChild(a); a.click(); document.body.removeChild(a);
            URL.revokeObjectURL(url);
            showToast('Saved as table.tex');
        });
    }

    processPipeline();
});
