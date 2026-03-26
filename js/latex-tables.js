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
    const toastContainer = document.getElementById('toastContainer');

    // # --- 2. Event listeners ---
    // # Executing full pipeline update on state change
    const updateTriggers = [dataInput, envSelect, styleSelect, captionInput, labelInput];
    updateTriggers.forEach(el => el.addEventListener('input', processPipeline));
    alignRadios.forEach(radio => radio.addEventListener('change', processPipeline));

    // # Setting up accordion interaction
    document.querySelectorAll('.accordion-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const isExpanded = btn.getAttribute('aria-expanded') === 'true';
            btn.setAttribute('aria-expanded', !isExpanded);
            document.getElementById(btn.getAttribute('data-target')).classList.toggle('expanded');
        });
    });

    // # --- 3. Data parsing engine ---
    function parseInputData(rawText) {
        if (!rawText.trim()) return [];
        
        const lines = rawText.split('\n');
        const matrix = [];
        let maxCols = 0;

        for (let line of lines) {
            // # Checking if empty line to preserve table structure or skip
            if (line.trim() === '') continue;

            // # I am resolving standard Excel tab-separation and falling back to commas if needed
            const delimiter = line.includes('\t') ? '\t' : (line.includes(',') ? ',' : ' ');
            const row = line.split(delimiter).map(cell => cell.trim());
            
            if (row.length > maxCols) maxCols = row.length;
            matrix.push(row);
        }

        // # I am normalizing column widths across the matrix to prevent LaTeX compilation errors
        return matrix.map(row => {
            while (row.length < maxCols) row.push('');
            return row;
        });
    }

    // # --- 4. HTML optical preview generation ---
    function renderPreview(matrix) {
        if (matrix.length === 0) {
            tablePreview.innerHTML = '<span class="text-slate-400">Paste data to render preview.</span>';
            return;
        }

        const style = styleSelect.value;
        const align = Array.from(alignRadios).find(r => r.checked).value;
        const alignMap = { 'l': 'text-left', 'c': 'text-center', 'r': 'text-right' };
        
        let html = `<table class="preview-table ${style === 'booktabs' ? 'booktabs' : ''}">`;
        
        // # Extracting header row
        const headers = matrix[0];
        html += `<thead><tr>`;
        headers.forEach(h => {
            html += `<th class="${alignMap[align]}">${escapeHtml(h)}</th>`;
        });
        html += `</tr></thead><tbody>`;

        // # Extracting data rows
        for (let i = 1; i < matrix.length; i++) {
            html += `<tr>`;
            matrix[i].forEach(cell => {
                html += `<td class="${alignMap[align]}">${escapeHtml(cell)}</td>`;
            });
            html += `</tr>`;
        }

        html += `</tbody></table>`;
        tablePreview.innerHTML = html;
    }

    // # --- 5. LaTeX compilation engine ---
    function generateLatex(matrix) {
        if (matrix.length === 0) {
            latexOutput.textContent = "Waiting for input matrix...";
            return;
        }

        const env = envSelect.value;
        const style = styleSelect.value;
        const caption = captionInput.value.trim();
        const label = labelInput.value.trim();
        const align = Array.from(alignRadios).find(r => r.checked).value;
        const colCount = matrix[0].length;

        // # Constructing the column specification string
        let colSpec = '';
        if (style === 'grid') {
            colSpec = '|' + Array(colCount).fill(align).join('|') + '|';
        } else {
            colSpec = Array(colCount).fill(align).join('');
            // # I am removing outer padding for strict booktabs standard formatting
            if (style === 'booktabs') colSpec = '@{}' + colSpec + '@{}';
        }

        let latex = `\\begin{${env}}[htbp]\n`;
        latex += `\\centering\n`;
        
        if (caption) latex += `\\caption{${escapeLatex(caption)}}\n`;
        if (label) latex += `\\label{${escapeLatex(label)}}\n`;
        
        latex += `\\begin{tabular}{${colSpec}}\n`;

        // # Applying top structural border
        if (style === 'booktabs') latex += `\\toprule\n`;
        else if (style === 'grid' || style === 'standard') latex += `\\hline\n`;

        // # Constructing the header row
        latex += `    ${matrix[0].map(escapeLatex).join(' & ')} \\\\\n`;

        // # Applying middle structural border
        if (style === 'booktabs') latex += `\\midrule\n`;
        else if (style === 'grid' || style === 'standard') latex += `\\hline\n`;

        // # Constructing data rows
        for (let i = 1; i < matrix.length; i++) {
            latex += `    ${matrix[i].map(escapeLatex).join(' & ')} \\\\\n`;
            if (style === 'grid') latex += `\\hline\n`;
        }

        // # Applying bottom structural border
        if (style === 'booktabs') latex += `\\bottomrule\n`;
        else if (style === 'standard') latex += `\\hline\n`;

        latex += `\\end{tabular}\n`;
        latex += `\\end{${env}}`;

        latexOutput.textContent = latex;
    }

    // # --- 6. Pipeline execution and utilities ---
    function processPipeline() {
        const rawText = dataInput.value;
        const matrix = parseInputData(rawText);
        renderPreview(matrix);
        generateLatex(matrix);
    }

    // # Sanitizing raw text for safe HTML rendering
    function escapeHtml(text) {
        const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
        return text.replace(/[&<>"']/g, m => map[m]);
    }

    // # Sanitizing raw text to prevent LaTeX compilation breaks on reserved characters
    function escapeLatex(text) {
        let sanitized = text.toString();
        sanitized = sanitized.replace(/\\/g, '\\textbackslash{}');
        sanitized = sanitized.replace(/([&%$#_{}])/g, '\\$1');
        sanitized = sanitized.replace(/~/g, '\\textasciitilde{}');
        sanitized = sanitized.replace(/\^/g, '\\textasciicircum{}');
        return sanitized;
    }

    // # Displaying brief visual feedback
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
        if (code === "Waiting for input matrix...") return;

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

    // # Initializing render call to handle potential browser caching
    processPipeline();
});