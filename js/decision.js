// # --- 1. State and DOM ---
// Caching DOM elements
const btnGenerate = document.getElementById('btn-generate');
const btnCalculate = document.getElementById('btn-calculate');
const matrixWrapper = document.getElementById('matrix-wrapper');
const matrixContainer = document.getElementById('matrix-container');
const resultsContainer = document.getElementById('results-container');

// # Initializing state variables for parsed inputs
let parsedOptions = [];
let parsedCriteria = [];

// # --- 2. Input parsing and grid generation ---
btnGenerate.addEventListener('click', () => {
    // Parsing inputs by comma, trimming whitespace, and filtering empty strings
    const rawOptions = document.getElementById('input-options').value;
    const rawCriteria = document.getElementById('input-criteria').value;

    parsedOptions = rawOptions.split(',').map(item => item.trim()).filter(item => item !== '');
    parsedCriteria = rawCriteria.split(',').map(item => item.trim()).filter(item => item !== '');

    // Validating input arrays
    if (parsedOptions.length < 2) return alert("Please provide at least 2 options to compare.");
    if (parsedCriteria.length < 1) return alert("Please provide at least 1 criteria to judge by.");

    buildTableUI();
    
    // Revealing matrix area
    matrixWrapper.classList.remove('hidden');
    resultsContainer.innerHTML = `<h3 class="text-xl font-medium text-slate-500">Matrix generated. Fill out the scores below!</h3>`;
});

function buildTableUI() {
    // Building table header with criteria and weight inputs
    let tableHTML = `
        <table class="w-full text-left border-collapse min-w-[600px]">
            <thead>
                <tr class="border-b-2 border-slate-200 dark:border-slate-700">
                    <th class="p-4 font-black text-lg w-1/4">Options</th>`;
    
    parsedCriteria.forEach(crit => {
        tableHTML += `
            <th class="p-4 align-bottom">
                <span class="block font-bold mb-2">${crit}</span>
                <div class="flex items-center gap-2 text-sm text-slate-500">
                    Weight (1-5):
                    <input type="number" min="1" max="5" value="1" 
                           class="crit-weight w-16 p-2 rounded-lg bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white font-bold outline-none" 
                           data-criteria="${crit}">
                </div>
            </th>`;
    });
    
    tableHTML += `</tr></thead><tbody>`;

    // Building option rows with rating inputs
    parsedOptions.forEach(opt => {
        tableHTML += `<tr class="border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors">
            <td class="p-4 font-bold text-indigo-600 dark:text-indigo-400 text-lg">${opt}</td>`;
        
        parsedCriteria.forEach(crit => {
            tableHTML += `
                <td class="p-4">
                    <div class="flex items-center gap-2">
                        <span class="text-xs text-slate-400">Score (1-10):</span>
                        <input type="number" min="1" max="10" value="5" 
                               class="opt-rating w-16 p-2 rounded-lg bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white font-bold outline-none" 
                               data-option="${opt}" data-criteria="${crit}">
                    </div>
                </td>`;
        });
        tableHTML += `</tr>`;
    });

    tableHTML += `</tbody></table>`;
    matrixContainer.innerHTML = tableHTML;
}

// # --- 3. Mathematical execution ---
btnCalculate.addEventListener('click', () => {
    const weights = {};
    const scores = {};
    const breakdowns = {}; 

    // Extracting criteria weights
    document.querySelectorAll('.crit-weight').forEach(input => {
        weights[input.dataset.criteria] = parseFloat(input.value) || 1; 
    });

    // Calculating scores
    document.querySelectorAll('.opt-rating').forEach(input => {
        const opt = input.dataset.option;
        const crit = input.dataset.criteria;
        const rating = parseFloat(input.value) || 0;
        const weight = weights[crit];
        
        const calculatedValue = rating * weight;

        if (!scores[opt]) {
            scores[opt] = 0;
            breakdowns[opt] = [];
        }

        scores[opt] += calculatedValue;
        breakdowns[opt].push(`${rating}x${weight}`);
    });

    // Identifying optimal choice
    const winner = Object.keys(scores).reduce((a, b) => scores[a] > scores[b] ? a : b);

    // Rendering result UI
    let breakdownHTML = `
        <div class="bg-white dark:bg-slate-900 p-6 rounded-2xl shadow-sm border border-slate-200 dark:border-slate-800 w-full max-w-lg mx-auto mb-4">
            <h4 class="text-sm font-bold text-slate-400 uppercase tracking-widest mb-2">Optimal Choice</h4>
            <h2 class="text-5xl font-black text-transparent bg-clip-text bg-gradient-to-r from-indigo-500 to-emerald-500 mb-6">${winner}</h2>
            <div class="text-left space-y-3 border-t border-slate-100 dark:border-slate-800 pt-4">`;

    for (const [opt, totalScore] of Object.entries(scores)) {
        const mathString = breakdowns[opt].join(' + ');
        const isWinner = opt === winner;
        
        breakdownHTML += `
            <div class="flex justify-between items-center ${isWinner ? 'font-bold text-indigo-600 dark:text-indigo-400' : 'text-slate-500'}">
                <span>${opt}</span>
                <span class="text-sm font-mono bg-slate-100 dark:bg-slate-800 px-2 py-1 rounded">
                    (${mathString}) = ${totalScore}
                </span>
            </div>`;
    }

    breakdownHTML += `</div></div>`;
    resultsContainer.innerHTML = breakdownHTML;
    
    // Scrolling to results
    document.getElementById('results-container').scrollIntoView({ behavior: 'smooth', block: 'center' });
});