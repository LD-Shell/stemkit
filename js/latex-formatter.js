// # --- 1. Environment initialization ---
document.addEventListener("DOMContentLoaded", () => {
    
    // Caching DOM nodes
    const mathField = document.getElementById('mathField');
    const latexInput = document.getElementById('latexInput');
    const katexPreview = document.getElementById('katexPreview');
    const syntaxStatus = document.getElementById('syntaxStatus');
    
    const matrixRows = document.getElementById('matrixRows');
    const matrixCols = document.getElementById('matrixCols');
    const matrixStyle = document.getElementById('matrixStyle');
    const generateMatrixBtn = document.getElementById('generateMatrixBtn');
    const copyLatexBtn = document.getElementById('copyLatexBtn');

    // Binding theme preferences
    document.querySelectorAll('.themeToggle').forEach(btn => btn.addEventListener('click', () => {
        document.documentElement.classList.toggle('dark');
        localStorage.theme = document.documentElement.classList.contains('dark') ? 'dark' : 'light';
    });

    // # --- 2. Bidirectional data binding ---
    
    // Synchronizing visual editor output to raw text area
    mathField.addEventListener('input', () => {
        const rawLatex = mathField.getValue('latex');
        if (latexInput.value !== rawLatex) {
            latexInput.value = rawLatex;
            compileKaTeX(rawLatex);
        }
    });

    // Synchronizing manual raw text edits back to visual editor
    latexInput.addEventListener('input', (e) => {
        const rawLatex = e.target.value;
        mathField.setValue(rawLatex, { suppressChangeNotifications: true });
        compileKaTeX(rawLatex);
    });

    // # --- 3. Syntax compilation and error handling ---
    function compileKaTeX(latexString) {
        if (!latexString.trim()) {
            katexPreview.innerHTML = '';
            updateStatus(true);
            return;
        }

        try {
            // I am compiling the string via KaTeX and catching syntax faults to prevent silent failures
            katex.render(latexString, katexPreview, {
                displayMode: true,
                throwOnError: true,
                strict: false
            });
            updateStatus(true);
        } catch (err) {
            katexPreview.innerHTML = `<span class="text-red-500 font-mono text-sm">${err.message}</span>`;
            updateStatus(false);
        }
    }

    function updateStatus(isValid) {
        if (isValid) {
            syntaxStatus.innerHTML = '<i class="fa-solid fa-check mr-1"></i> Valid Syntax';
            syntaxStatus.className = 'text-xs font-bold text-emerald-500';
        } else {
            syntaxStatus.innerHTML = '<i class="fa-solid fa-triangle-exclamation mr-1"></i> Compilation Error';
            syntaxStatus.className = 'text-xs font-bold text-red-500';
        }
    }

    // Initializing state
    latexInput.value = mathField.getValue('latex');
    compileKaTeX(latexInput.value);

    // # --- 4. Matrix boilerplate generator ---
    generateMatrixBtn.addEventListener('click', () => {
        const rows = parseInt(matrixRows.value) || 3;
        const cols = parseInt(matrixCols.value) || 3;
        const style = matrixStyle.value;

        let matrixLatex = `\\begin{${style}}\n`;
        
        // Iterating through dimensions to construct tabular syntax
        for (let r = 1; r <= rows; r++) {
            let rowContent = [];
            for (let c = 1; c <= cols; c++) {
                rowContent.push(`x_{${r}${c}}`);
            }
            matrixLatex += `  ${rowContent.join(' & ')} ${r < rows ? '\\\\' : ''}\n`;
        }
        
        matrixLatex += `\\end{${style}}`;

        // Appending matrix to active operational string
        const currentLatex = latexInput.value.trim();
        const newLatex = currentLatex ? `${currentLatex} = ${matrixLatex}` : matrixLatex;
        
        latexInput.value = newLatex;
        mathField.setValue(newLatex, { suppressChangeNotifications: true });
        compileKaTeX(newLatex);
        
        showToast(`Generated ${rows}x${cols} ${style}.`, 'info');
    });

    // # --- 5. Export utilities ---
    copyLatexBtn.addEventListener('click', () => {
        const content = latexInput.value;
        if (!content) {
            showToast("Workspace is empty.", "error");
            return;
        }
        
        // Stripping MathLive spacing artifacts before pushing to clipboard
        const cleanedContent = content.replace(/\u200B/g, ''); 
        
        navigator.clipboard.writeText(cleanedContent).then(() => {
            showToast("LaTeX string copied to clipboard.", "success");
        }).catch(err => {
            console.error(err);
            showToast("Clipboard access denied.", "error");
        });
    });

    // # --- 6. Notification system ---
    function showToast(msg, type) {
        const container = document.getElementById('toastContainer');
        const toast = document.createElement('div');
        
        const colors = type === 'success' ? 'bg-emerald-50 text-emerald-800 border-emerald-200 dark:bg-emerald-900/30' : 
                       type === 'error' ? 'bg-red-50 text-red-800 border-red-200 dark:bg-red-900/30' : 
                       'bg-indigo-50 text-indigo-800 border-indigo-200 dark:bg-indigo-900/30';
        
        toast.className = `px-4 py-3 rounded-xl border shadow-lg toast-enter text-sm font-medium transition-all ${colors}`;
        toast.innerHTML = `<i class="fa-solid ${type==='success'?'fa-check-circle':type==='error'?'fa-triangle-exclamation':'fa-info-circle'} mr-2"></i> ${msg}`;
        
        container.appendChild(toast);
        setTimeout(() => {
            toast.style.opacity = '0';
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }
});