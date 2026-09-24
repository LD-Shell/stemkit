/*
 * STEMKit | Weighted Decision Matrix
 * Method: Simple Additive Weighting (SAW), also called the Weighted Sum Model.
 * Each option's score = Sum over criteria of (rating x weight).
 * Author: Olanrewaju M. Daramola. Runs 100% client-side.
 *
 * The page is three steps: list the options and criteria, weight and score
 * them in the matrix, read the ranking. js/site.js follows the steps from
 * what is on screen (the matrix, the ranking), so nothing here drives them.
 */

// --- 1. State and DOM ---
const $ = id => document.getElementById(id);
const btnGenerate      = $('btn-generate');
const btnCalculate     = $('btn-calculate');
const btnExample       = $('btn-example');
const inputOptions     = $('input-options');
const inputCriteria    = $('input-criteria');
const errorBox         = $('dm-error');
const errorText        = $('dm-error-text');
const matrixEmpty      = $('matrix-empty');
const matrixWrapper    = $('matrix-wrapper');
const matrixContainer  = $('matrix-container');
const resultsPanel     = $('results-panel');
const resultsContainer = $('results-container');

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
const scrollBehaviour = () =>
    (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');

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

/** Say what is wrong next to the field it concerns; null clears it. */
function showError(message, field) {
    [inputOptions, inputCriteria].forEach(el => el.removeAttribute('aria-invalid'));
    if (!message) { errorBox.hidden = true; errorText.textContent = ''; return; }
    errorText.textContent = message;
    errorBox.hidden = false;
    if (field) { field.setAttribute('aria-invalid', 'true'); field.focus(); }
}

// --- 2. Input parsing and grid generation ---
btnGenerate.addEventListener('click', () => {
    const optRaw  = inputOptions.value.split(',').map(s => s.trim()).filter(Boolean);
    const critRaw = inputCriteria.value.split(',').map(s => s.trim()).filter(Boolean);

    const options  = uniqueNames(optRaw);
    const criteria = uniqueNames(critRaw);

    if (options.length < 2) {
        return showError('List at least two different options, separated by commas.', inputOptions);
    }
    if (criteria.length < 1) {
        return showError('List at least one criterion to judge the options by.', inputCriteria);
    }
    showError(null);

    parsedOptions = options;
    parsedCriteria = criteria;
    buildTableUI();

    matrixEmpty.hidden = true;
    matrixWrapper.hidden = false;
    // A new matrix makes any earlier ranking stale.
    resultsPanel.hidden = true;
    resultsContainer.innerHTML = '';
    matrixWrapper.scrollIntoView({ behavior: scrollBehaviour(), block: 'nearest' });
});

// Enter in either field builds the matrix.
[inputOptions, inputCriteria].forEach(el => el.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); btnGenerate.click(); }
}));

function buildTableUI() {
    // Header: one column per criterion, each with a weight input (referenced by INDEX, not name)
    let html = `
        <table class="dm-table">
            <thead>
                <tr>
                    <th scope="col" class="dm-corner">Option</th>`;

    parsedCriteria.forEach((crit, ci) => {
        html += `
            <th scope="col">
                <span class="dm-crit">${esc(crit)}</span>
                <label class="dm-weight">Weight
                    <input type="number" min="${WEIGHT_MIN}" max="${WEIGHT_MAX}" value="3" inputmode="numeric"
                           class="dm-num crit-weight" data-crit-idx="${ci}" aria-label="Weight of ${esc(crit)}, ${WEIGHT_MIN} to ${WEIGHT_MAX}">
                </label>
            </th>`;
    });

    html += `</tr></thead><tbody>`;

    parsedOptions.forEach((opt, oi) => {
        html += `<tr><th scope="row" class="dm-opt">${esc(opt)}</th>`;
        parsedCriteria.forEach((crit, ci) => {
            html += `
                <td>
                    <input type="number" min="${SCORE_MIN}" max="${SCORE_MAX}" value="5" inputmode="numeric"
                           class="dm-num opt-rating" data-opt-idx="${oi}" data-crit-idx="${ci}"
                           aria-label="Score of ${esc(opt)} on ${esc(crit)}, ${SCORE_MIN} to ${SCORE_MAX}">
                </td>`;
        });
        html += `</tr>`;
    });

    html += `</tbody></table>`;
    matrixContainer.innerHTML = html;
}

// --- 3. Calculation ---
/**
 * Read the matrix and rank the options. With writeBack, out-of-range entries
 * are corrected in the fields so the visitor sees what was used; while they
 * are still typing, the fields are left alone.
 */
function rank({ writeBack }) {
    if (!parsedCriteria.length || !parsedOptions.length) return;

    const weights = new Array(parsedCriteria.length).fill(WEIGHT_MIN);
    document.querySelectorAll('.crit-weight').forEach(inp => {
        const ci = Number(inp.dataset.critIdx);
        let w = parseFloat(inp.value);
        if (!isFinite(w)) w = WEIGHT_MIN;
        w = clamp(w, WEIGHT_MIN, WEIGHT_MAX);
        if (writeBack) inp.value = w;
        weights[ci] = w;
    });

    // Read + clamp ratings, accumulate weighted totals per option index
    const totals = new Array(parsedOptions.length).fill(0);
    document.querySelectorAll('.opt-rating').forEach(inp => {
        const oi = Number(inp.dataset.optIdx);
        const ci = Number(inp.dataset.critIdx);
        let r = parseFloat(inp.value);
        if (!isFinite(r)) r = SCORE_MIN;
        r = clamp(r, SCORE_MIN, SCORE_MAX);
        if (writeBack) inp.value = r;
        totals[oi] += r * weights[ci];
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
}

btnCalculate.addEventListener('click', () => {
    rank({ writeBack: true });
    resultsPanel.scrollIntoView({ behavior: scrollBehaviour(), block: 'nearest' });
});

// Once ranked, the ranking follows the matrix as it is edited.
matrixContainer.addEventListener('input', () => {
    if (!resultsPanel.hidden) rank({ writeBack: false });
});

const fmt = n => (Number.isInteger(n) ? String(n) : n.toFixed(1));

function renderResults(order, winners, maxPossible) {
    const isTie = winners.length > 1;
    const top = order[0];

    const rows = order.map((o, rank) => {
        const isTop = winners.includes(o.name);
        return `
            <li class="${isTop ? 'is-top' : ''}">
                <div class="dm-rank-row">
                    <span class="dm-rank-name"><b>${rank + 1}</b> ${esc(o.name)}</span>
                    <span class="dm-rank-score">${fmt(o.total)} of ${maxPossible} (${o.pct.toFixed(0)}%)</span>
                </div>
                <div class="dm-bar" aria-hidden="true"><span style="width:${Math.max(2, o.pct)}%"></span></div>
            </li>`;
    }).join('');

    resultsContainer.innerHTML = `
        <p class="dm-result-label">${isTie ? 'Tied for first' : 'First choice'}</p>
        <p class="dm-result-name">${winners.map(esc).join(' and ')}</p>
        <p class="dm-result-sub">${isTie ? 'Each scored' : 'Scored'} ${fmt(top.total)} of a possible ${maxPossible} on your weights (${top.pct.toFixed(0)}%).</p>
        <ol class="dm-rank">${rows}</ol>
        <button type="button" id="btn-copy-summary" class="stk-btn stk-btn-sm dm-copy">
            <i class="fa-regular fa-copy" aria-hidden="true"></i><span>Copy the ranking</span>
        </button>`;
    resultsPanel.hidden = false;

    const copyBtn = $('btn-copy-summary');
    copyBtn.addEventListener('click', () => {
        const lines = order.map((o, r) => `${r + 1}. ${o.name}: ${fmt(o.total)}/${maxPossible} (${o.pct.toFixed(0)}%)`);
        const text = `Decision Matrix result\n${isTie ? 'Tied for first' : 'First choice'}: ${winners.join(' and ')}\n\n` +
                     lines.join('\n') + `\n\nGenerated with STEMKit Decision Matrix (stemkit.net).`;
        const label = copyBtn.querySelector('span');
        navigator.clipboard.writeText(text).then(() => {
            label.textContent = 'Copied';
            setTimeout(() => { label.textContent = 'Copy the ranking'; }, 1800);
        }, () => {
            label.textContent = 'The browser blocked the clipboard';
            setTimeout(() => { label.textContent = 'Copy the ranking'; }, 2500);
        });
    });
}

// --- 4. Example ---
// Three job offers, weighted and scored so the ranking is close enough to be
// worth reading: B wins on balance and commute, C on growth.
const EXAMPLE = {
    options: ['Job A', 'Job B', 'Job C'],
    criteria: ['Salary', 'Work-life balance', 'Growth', 'Commute'],
    weights: [4, 3, 5, 2],
    scores: [[9, 4, 6, 5], [6, 8, 7, 8], [7, 6, 9, 3]]
};
btnExample.addEventListener('click', () => {
    inputOptions.value  = EXAMPLE.options.join(', ');
    inputCriteria.value = EXAMPLE.criteria.join(', ');
    btnGenerate.click();
    document.querySelectorAll('.crit-weight').forEach(inp => {
        inp.value = EXAMPLE.weights[Number(inp.dataset.critIdx)];
    });
    document.querySelectorAll('.opt-rating').forEach(inp => {
        inp.value = EXAMPLE.scores[Number(inp.dataset.optIdx)][Number(inp.dataset.critIdx)];
    });
    btnCalculate.focus({ preventScroll: true });
});
