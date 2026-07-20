/*
 * STEMKit — Weighted Decision Matrix
 * Method: Simple Additive Weighting (SAW), also called the Weighted Sum Model.
 * Each option's score = Sum over criteria of (rating x weight).
 * Author: Olanrewaju M. Daramola. Runs 100% client-side.
 */

// --- 1. State and DOM ---
const btnGenerate     = document.getElementById('btn-generate');
const btnCalculate    = document.getElementById('btn-calculate');
const matrixWrapper   = document.getElementById('matrix-wrapper');
const matrixContainer = document.getElementById('matrix-container');
const resultsContainer= document.getElementById('results-container');
const btnExample      = document.getElementById('btn-example'); // optional

// Score/weight bounds (kept in sync with the input min/max attributes)
const WEIGHT_MIN = 1, WEIGHT_MAX = 5;
const SCORE_MIN  = 1, SCORE_MAX  = 10;

let parsedOptions  = [];
let parsedCriteria = [];

// --- Utilities ---
function esc(s) {
    return String(s).replace(/[&<>"']/g, c => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}
function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

// De-duplicate names case-insensitively while preserving the first spelling/order
function uniqueNames(list) {
    const seen = new Set();
    const out = [];
    for (const item of list) {
        const key = item.toLowerCase();
        if (!seen.has(key)) { seen.add(key); out.push(item); }
    }
    return out;
}

function showError(message) {
    resultsContainer.innerHTML =
        `<div class="text-red-600 dark:text-red-400 font-semibold flex items-center justify-center gap-2">
            <i class="fa-solid fa-triangle-exclamation"></i><span>${esc(message)}</span>
         </div>`;
}

// --- 2. Input parsing and grid generation ---
btnGenerate.addEventListener('click', () => {
    const rawOptions  = document.getElementById('input-options').value;
    const rawCriteria = document.getElementById('input-criteria').value;

    const optRaw  = rawOptions.split(',').map(s => s.trim()).filter(Boolean);
    const critRaw = rawCriteria.split(',').map(s => s.trim()).filter(Boolean);

    parsedOptions  = uniqueNames(optRaw);
    parsedCriteria = uniqueNames(critRaw);

    if (parsedOptions.length < 2)  return showError('Please provide at least 2 distinct options to compare.');
    if (parsedCriteria.length < 1) return showError('Please provide at least 1 criterion to judge by.');

    buildTableUI();

    matrixWrapper.classList.remove('hidden');
    resultsContainer.innerHTML =
        `<h3 class="text-xl font-medium text-slate-500 dark:text-slate-400">Matrix generated &mdash; fill in the scores, then calculate.</h3>`;
    matrixWrapper.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});

function buildTableUI() {
    // Header: one column per criterion, each with a weight input (referenced by INDEX, not name)
    let html = `
        <table class="w-full text-left border-collapse min-w-[600px]">
            <thead>
                <tr class="border-b-2 border-slate-200 dark:border-slate-700">
                    <th class="p-4 font-black text-lg w-1/4">Options</th>`;

    parsedCriteria.forEach((crit, ci) => {
        html += `
            <th class="p-4 align-bottom">
                <span class="block font-bold mb-2">${esc(crit)}</span>
                <div class="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
                    Weight (${WEIGHT_MIN}-${WEIGHT_MAX}):
                    <input type="number" min="${WEIGHT_MIN}" max="${WEIGHT_MAX}" value="3"
                           class="crit-weight w-16 p-2 rounded-lg bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white font-bold outline-none focus:ring-2 focus:ring-indigo-500"
                           data-crit-idx="${ci}" aria-label="Weight for ${esc(crit)}">
                </div>
            </th>`;
    });

    html += `</tr></thead><tbody>`;

    parsedOptions.forEach((opt, oi) => {
        html += `<tr class="border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors">
            <td class="p-4 font-bold text-indigo-600 dark:text-indigo-400 text-lg">${esc(opt)}</td>`;
        parsedCriteria.forEach((crit, ci) => {
            html += `
                <td class="p-4">
                    <div class="flex items-center gap-2">
                        <span class="text-xs text-slate-400">Score (${SCORE_MIN}-${SCORE_MAX}):</span>
                        <input type="number" min="${SCORE_MIN}" max="${SCORE_MAX}" value="5"
                               class="opt-rating w-16 p-2 rounded-lg bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white font-bold outline-none focus:ring-2 focus:ring-indigo-500"
                               data-opt-idx="${oi}" data-crit-idx="${ci}"
                               aria-label="Score of ${esc(opt)} on ${esc(crit)}">
                    </div>
                </td>`;
        });
        html += `</tr>`;
    });

    html += `</tbody></table>`;
    matrixContainer.innerHTML = html;
}

// --- 3. Calculation ---
btnCalculate.addEventListener('click', () => {
    if (!parsedCriteria.length || !parsedOptions.length) return;

    // Read + clamp weights (reflect clamped values back so the user sees corrections)
    const weights = new Array(parsedCriteria.length).fill(WEIGHT_MIN);
    document.querySelectorAll('.crit-weight').forEach(inp => {
        const ci = Number(inp.dataset.critIdx);
        let w = parseFloat(inp.value);
        if (!isFinite(w)) w = WEIGHT_MIN;
        w = clamp(w, WEIGHT_MIN, WEIGHT_MAX);
        inp.value = w;
        weights[ci] = w;
    });

    // Read + clamp ratings, accumulate weighted totals per option index
    const totals    = new Array(parsedOptions.length).fill(0);
    const breakdown = parsedOptions.map(() => []);

    document.querySelectorAll('.opt-rating').forEach(inp => {
        const oi = Number(inp.dataset.optIdx);
        const ci = Number(inp.dataset.critIdx);
        let r = parseFloat(inp.value);
        if (!isFinite(r)) r = SCORE_MIN;
        r = clamp(r, SCORE_MIN, SCORE_MAX);
        inp.value = r;
        const w = weights[ci];
        totals[oi] += r * w;
        breakdown[oi].push({ crit: parsedCriteria[ci], r, w });
    });

    const weightSum   = weights.reduce((a, b) => a + b, 0);
    const maxPossible = weightSum * SCORE_MAX; // if every criterion scored the maximum

    // Rank (descending). Ties share the top spot.
    const order = parsedOptions
        .map((name, i) => ({ name, i, total: totals[i], pct: maxPossible ? (totals[i] / maxPossible) * 100 : 0 }))
        .sort((a, b) => b.total - a.total);

    const topTotal = order.length ? order[0].total : 0;
    const winners  = order.filter(o => Math.abs(o.total - topTotal) < 1e-9).map(o => o.name);

    renderResults(order, winners, maxPossible);
});

function renderResults(order, winners, maxPossible) {
    const isTie = winners.length > 1;
    const headline = winners.map(esc).join(' / ');

    let rows = '';
    order.forEach((o, rank) => {
        const isTop = winners.includes(o.name);
        const pct = o.pct.toFixed(0);
        rows += `
            <div class="text-left">
                <div class="flex justify-between items-baseline mb-1">
                    <span class="font-semibold ${isTop ? 'text-indigo-600 dark:text-indigo-400' : 'text-slate-600 dark:text-slate-300'}">
                        <span class="text-slate-400 font-mono text-xs mr-1">#${rank + 1}</span>${esc(o.name)}
                    </span>
                    <span class="text-sm font-mono text-slate-500 dark:text-slate-400">${o.total.toFixed(1)} / ${maxPossible} (${pct}%)</span>
                </div>
                <div class="h-2.5 w-full bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
                    <div class="h-full rounded-full ${isTop ? 'bg-gradient-to-r from-indigo-500 to-emerald-500' : 'bg-slate-300 dark:bg-slate-600'}"
                         style="width:${Math.max(2, o.pct)}%"></div>
                </div>
            </div>`;
    });

    resultsContainer.innerHTML = `
        <div class="bg-white dark:bg-slate-900 p-6 rounded-2xl shadow-sm border border-slate-200 dark:border-slate-800 w-full max-w-lg mx-auto">
            <h4 class="text-sm font-bold text-slate-400 uppercase tracking-widest mb-1">
                ${isTie ? 'Tied Top Choice' : 'Optimal Choice'}
            </h4>
            <h2 class="text-4xl md:text-5xl font-black text-transparent bg-clip-text bg-gradient-to-r from-indigo-500 to-emerald-500 mb-2 break-words">${headline}</h2>
            <p class="text-xs text-slate-400 mb-6">Scored highest on your weighted criteria${isTie ? ' (multiple options tied)' : ''}.</p>
            <div class="space-y-4 border-t border-slate-100 dark:border-slate-800 pt-5">${rows}</div>
            <button id="btn-copy-summary" class="mt-6 w-full text-sm font-semibold text-indigo-600 dark:text-indigo-400 hover:underline">
                <i class="fa-regular fa-copy mr-1"></i> Copy summary
            </button>
        </div>`;

    const copyBtn = document.getElementById('btn-copy-summary');
    if (copyBtn) {
        copyBtn.addEventListener('click', () => {
            const lines = order.map((o, r) => `${r + 1}. ${o.name}: ${o.total.toFixed(1)}/${maxPossible} (${o.pct.toFixed(0)}%)`);
            const text = `Decision Matrix result\nWinner: ${winners.join(' / ')}\n\n` + lines.join('\n') +
                         `\n\nGenerated with STEMKit Decision Matrix (stemkit.net).`;
            navigator.clipboard.writeText(text).then(() => {
                const origHTML = copyBtn.innerHTML;
                copyBtn.innerHTML = '<i class="fa-solid fa-check mr-1"></i> Copied!';
                setTimeout(() => { copyBtn.innerHTML = origHTML; }, 1800);
            });
        });
    }

    resultsContainer.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// --- 4. Optional example loader ---
if (btnExample) {
    btnExample.addEventListener('click', () => {
        document.getElementById('input-options').value  = 'Job A, Job B, Job C';
        document.getElementById('input-criteria').value = 'Salary, Work-Life Balance, Growth, Commute';
        btnGenerate.click();
    });
}
