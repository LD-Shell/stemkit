/*
 * STEMKit | Weighted Decision Matrix
 * Method: Simple Additive Weighting (SAW), also called the Weighted Sum Model.
 * Each option's score = Sum over criteria of (rating x weight).
 * Author: Olanrewaju M. Daramola. Runs 100% client-side.
 *
 * The page is three steps: list the options and criteria, weight and score
 * them in the matrix, read the ranking. js/site.js follows the steps from
 * what is on screen (the matrix, the ranking), so nothing here drives them.
 *
 * The rules (what a field counts as, how totals are ranked and tied, what the
 * page says) are plain functions, exported for the tests; the page code below
 * them runs only in a browser.
 */

// --- 1. Rules ---
// Score/weight bounds (the fields take their min and max from these), and what
// a new field holds, which is also what a field left blank counts as.
export const WEIGHT = { min: 1, max: 5, start: 3 };
export const SCORE  = { min: 1, max: 10, start: 5 };

/**
 * What a field counts as. A field with no number in it counts as the value
 * it started with, and a number outside the range as the nearest end of it.
 * `why` says which of those happened: 'blank', 'low', 'high', or null when
 * the number was used as typed.
 */
export function readEntry(text, range) {
    const v = parseFloat(text);
    if (!isFinite(v)) return { value: range.start, why: 'blank' };
    if (v < range.min) return { value: range.min, why: 'low' };
    if (v > range.max) return { value: range.max, why: 'high' };
    return { value: v, why: null };
}

/**
 * How far apart two totals over `terms` criteria can be when they are equal
 * on paper. Each weight and score is a decimal read to the nearest double,
 * each product is rounded once and each of the terms - 1 additions once
 * more, so a computed total is within gamma(terms + 2) = (terms + 2) u /
 * (1 - (terms + 2) u) of the exact one, relative to it, with u = 2^-53
 * (Higham, Accuracy and Stability of Numerical Algorithms, 2nd ed., sec.
 * 3.1; every term is positive, so the bound is relative to the total). Two
 * such totals differ by at most twice that, about (terms + 2) EPSILON; the
 * factor 2 below covers the second-order terms. Totals a person can tell
 * apart differ by many orders of magnitude more.
 */
export function tieTolerance(a, b, terms) {
    return 2 * (terms + 2) * Number.EPSILON * Math.max(Math.abs(a), Math.abs(b));
}

/**
 * Rank the options by weighted sum. scores[i][j] is option i on criterion j.
 * Options whose totals are equal within tieTolerance share a rank, the next
 * rank skips as many places as were shared (1, 1, 3), and tied options stay
 * in the order they were entered and show the total of the first of them.
 */
export function rankOptions(names, weights, scores) {
    const weightSum   = weights.reduce((a, b) => a + b, 0);
    const maxPossible = weightSum * SCORE.max; // if every criterion scored the maximum
    const totals = names.map((_, i) => weights.reduce((sum, w, j) => sum + scores[i][j] * w, 0));

    const byTotal = names.map((_, i) => i).sort((a, b) => totals[b] - totals[a] || a - b);
    const rows = [];
    for (let at = 0; at < byTotal.length;) {
        const lead = totals[byTotal[at]];
        let end = at + 1;
        while (end < byTotal.length &&
               lead - totals[byTotal[end]] <= tieTolerance(lead, totals[byTotal[end]], weights.length)) end++;
        const group = byTotal.slice(at, end).sort((a, b) => a - b);
        const total = totals[group[0]];
        for (const i of group) {
            rows.push({
                name: names[i], index: i, rank: at + 1, tied: group.length > 1,
                total, pct: maxPossible ? (total / maxPossible) * 100 : 0
            });
        }
        at = end;
    }
    return { rows, maxPossible, winners: rows.filter(r => r.rank === 1) };
}

/** A total as it is shown: two decimals at most, none it does not need. */
export const fmt = n => String(+n.toFixed(2));

/** "A", "A and B", "A, B and C". */
export function listNames(names) {
    if (names.length < 3) return names.join(' and ');
    return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** The ranks in order, to tell whether an edit changed the ranking. */
export const rankingKey = result => result.rows.map(r => `${r.rank}:${r.index}`).join(' ');

/** The ranking in one sentence: who is first, or who is tied, and the score. */
export function resultSentence(result) {
    const { rows, winners, maxPossible } = result;
    if (!rows.length) return '';
    const score = `${fmt(winners[0].total)} of ${fmt(maxPossible)}`;
    const pct = `${winners[0].pct.toFixed(0)}%`;
    if (winners.length === 1) return `${winners[0].name} ranks first with ${score} (${pct}).`;
    if (winners.length === rows.length && rows.length > 2) {
        return `All ${rows.length} options are tied, each with ${score} (${pct}).`;
    }
    return `${listNames(winners.map(w => w.name))} are tied for first, each with ${score} (${pct}).`;
}

/** The ranking as plain text, for the clipboard. */
export function summaryText(result) {
    const { rows, winners, maxPossible } = result;
    const lines = rows.map(r =>
        `${r.rank}. ${r.name}: ${fmt(r.total)}/${fmt(maxPossible)} (${r.pct.toFixed(0)}%)${r.tied ? ', tied' : ''}`);
    return `Decision Matrix result\n${winners.length > 1 ? 'Tied for first' : 'First choice'}: ` +
           `${listNames(winners.map(w => w.name))}\n\n${lines.join('\n')}\n\n` +
           `Generated with STEMKit Decision Matrix (stemkit.net).`;
}

const NOTE_LIMIT = 3; // entries named in a note before "and n more"

function listed(parts, total) {
    const more = total - parts.length;
    return listNames(more > 0 ? [...parts, `${more} more`] : parts);
}

/**
 * What to say about entries that were not used as typed. Each entry is
 * { label, raw, used, why, range }. With `written` they have been corrected
 * in the fields (Rank the options does that); without it the fields still
 * hold what was typed and the ranking uses the nearest end of the range.
 */
export function correctionNote(entries, { written }) {
    if (!entries.length) return '';
    const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
    const span = e => `${e.range.min} to ${e.range.max}`;
    if (entries.length === 1) {
        const e = entries[0];
        if (e.why === 'blank') {
            return `${cap(e.label)} had no number in it, so it ${written ? 'was set to' : 'counts as'} ${e.used}, the value it started with.`;
        }
        return written
            ? `${cap(e.label)} was ${e.raw}, outside the range of ${span(e)}, so it was set to ${e.used}.`
            : `${cap(e.label)} is ${e.raw}, outside the range of ${span(e)}, so it counts as ${e.used}.`;
    }
    const shown = entries.slice(0, NOTE_LIMIT);
    if (written) {
        const parts = shown.map(e => `${e.label} from ${e.why === 'blank' ? 'no number' : e.raw} to ${e.used}`);
        return `${entries.length} entries were corrected and are outlined in the matrix: ${listed(parts, entries.length)}.`;
    }
    const parts = shown.map(e => `${e.label} (${e.why === 'blank' ? 'no number' : e.raw}, counted as ${e.used})`);
    return `${entries.length} entries are outside their range and count as the nearest end of it: ${listed(parts, entries.length)}.`;
}

// --- 2. The page ---
if (typeof document !== 'undefined') {

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
const noteBox          = $('dm-note');
const noteText         = $('dm-note-text');
const resultsPanel     = $('results-panel');
const resultsContainer = $('results-container');
const statusBox        = $('dm-status');

let parsedOptions  = [];
let parsedCriteria = [];
let announced = { key: '', top: '' }; // rankingKey of the ranking last read out, and of its first place
const corrected = new Map(); // field -> what Rank the options changed in it

// --- Utilities ---
function esc(s) {
    return String(s).replace(/[&<>"']/g, c => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}
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

/**
 * Read a sentence out after `delay` ms. The region is emptied first, so the
 * same sentence is read again when Rank the options is pressed twice, and a
 * later call replaces one still waiting, so nothing is read out halfway
 * through typing a number. `say` gives the sentence when the time comes.
 */
let announceTimer = 0;
function announce(say, delay) {
    clearTimeout(announceTimer);
    statusBox.textContent = '';
    if (say) announceTimer = setTimeout(() => { statusBox.textContent = say(); }, delay);
}

// --- Input parsing and grid generation ---
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
    announced = { key: '', top: '' };
    corrected.clear();
    showNote('');
    announce(null);
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
                    <input type="number" min="${WEIGHT.min}" max="${WEIGHT.max}" step="any" value="${WEIGHT.start}" inputmode="decimal"
                           class="dm-num crit-weight" data-crit-idx="${ci}" aria-label="Weight of ${esc(crit)}, ${WEIGHT.min} to ${WEIGHT.max}">
                </label>
            </th>`;
    });

    html += `</tr></thead><tbody>`;

    parsedOptions.forEach((opt, oi) => {
        html += `<tr><th scope="row" class="dm-opt">${esc(opt)}</th>`;
        parsedCriteria.forEach((crit, ci) => {
            html += `
                <td>
                    <input type="number" min="${SCORE.min}" max="${SCORE.max}" step="any" value="${SCORE.start}" inputmode="decimal"
                           class="dm-num opt-rating" data-opt-idx="${oi}" data-crit-idx="${ci}"
                           aria-label="Score of ${esc(opt)} on ${esc(crit)}, ${SCORE.min} to ${SCORE.max}">
                </td>`;
        });
        html += `</tr>`;
    });

    html += `</tbody></table>`;
    matrixContainer.innerHTML = html;
}

// --- Calculation ---
function showNote(text) {
    noteText.textContent = text;
    noteBox.hidden = !text;
}

/**
 * Mark a field: 'invalid' while it holds a number outside its range,
 * 'corrected' once Rank the options has replaced what it held, or nothing.
 * A corrected field is no longer invalid, so it only points at the note.
 */
function mark(field, state) {
    if (state === 'invalid') field.setAttribute('aria-invalid', 'true');
    else field.removeAttribute('aria-invalid');
    field.classList.toggle('is-corrected', state === 'corrected');
    if (state) field.setAttribute('aria-describedby', noteBox.id);
    else field.removeAttribute('aria-describedby');
}

/**
 * Read the matrix (see readEntry for what a field counts as). With writeBack,
 * entries that were not used as typed are corrected in the fields, marked,
 * and described under the matrix; while the visitor is still typing, the
 * fields are left alone and a number outside its range is marked invalid
 * instead. Returns the weights, the scores, and the sentence about what
 * was corrected.
 */
function readMatrix(writeBack) {
    if (writeBack) corrected.clear();
    const outside = [];

    const read = (inp, range, label) => {
        const raw = inp.value.trim();
        const { value, why } = readEntry(raw, range);
        const entry = { label, raw, used: value, why, range };
        const off = why === 'low' || why === 'high';
        if (why && writeBack) {
            inp.value = value;
            corrected.set(inp, entry);
        } else if (off) {
            outside.push(entry);
        }
        mark(inp, corrected.has(inp) ? 'corrected' : (off ? 'invalid' : null));
        return value;
    };

    const weights = new Array(parsedCriteria.length).fill(WEIGHT.start);
    document.querySelectorAll('.crit-weight').forEach(inp => {
        const ci = Number(inp.dataset.critIdx);
        weights[ci] = read(inp, WEIGHT, `weight of ${parsedCriteria[ci]}`);
    });

    const scores = parsedOptions.map(() => new Array(parsedCriteria.length).fill(SCORE.start));
    document.querySelectorAll('.opt-rating').forEach(inp => {
        const oi = Number(inp.dataset.optIdx);
        const ci = Number(inp.dataset.critIdx);
        scores[oi][ci] = read(inp, SCORE, `score of ${parsedOptions[oi]} on ${parsedCriteria[ci]}`);
    });

    const changed = correctionNote([...corrected.values()], { written: true });
    showNote([changed, correctionNote(outside, { written: false })].filter(Boolean).join(' '));
    return { weights, scores, changed };
}

/**
 * Rank the options and show the ranking. It is read out when it was asked
 * for (writeBack), or once typing has paused and the order is not the one
 * last read out. The region is empty in between, so it never holds a score
 * the card no longer shows.
 */
function rank({ writeBack }) {
    if (!parsedCriteria.length || !parsedOptions.length) return;
    const { weights, scores, changed } = readMatrix(writeBack);
    const result = rankOptions(parsedOptions, weights, scores);
    renderResults(result);

    const key = rankingKey(result);
    const top = rankingKey({ rows: result.winners });
    if (writeBack) {
        const sentence = [changed, resultSentence(result)].filter(Boolean).join(' ');
        announced = { key, top };
        announce(() => sentence, 100);
    } else {
        announce(() => {
            if (key === announced.key) return '';
            const below = top === announced.top ? ' The order below first place changed.' : '';
            announced = { key, top };
            return resultSentence(result) + below;
        }, 700);
    }
}

btnCalculate.addEventListener('click', () => {
    rank({ writeBack: true });
    resultsPanel.scrollIntoView({ behavior: scrollBehaviour(), block: 'nearest' });
});

// A number outside its range is marked as it is typed, and once ranked, the
// ranking follows the matrix as it is edited. A field that was corrected
// stops being marked as soon as it is edited again.
matrixContainer.addEventListener('input', e => {
    corrected.delete(e.target);
    if (resultsPanel.hidden) readMatrix(false);
    else rank({ writeBack: false });
});

function renderResults(result) {
    const { rows, winners, maxPossible } = result;
    const isTie = winners.length > 1;
    const top = winners[0];

    // value carries the shared rank, so the list is numbered 1, 1, 3 as shown.
    const items = rows.map(r => `
            <li value="${r.rank}" class="${r.rank === 1 ? 'is-top' : ''}">
                <div class="dm-rank-row">
                    <span class="dm-rank-name"><b>${r.rank}</b> ${esc(r.name)}${r.tied ? ' <span class="dm-tied">tied</span>' : ''}</span>
                    <span class="dm-rank-score">${fmt(r.total)} of ${fmt(maxPossible)} (${r.pct.toFixed(0)}%)</span>
                </div>
                <div class="dm-bar" aria-hidden="true"><span style="width:${Math.max(2, r.pct)}%"></span></div>
            </li>`).join('');

    resultsContainer.innerHTML = `
        <p class="dm-result-label">${isTie ? 'Tied for first' : 'First choice'}</p>
        <p class="dm-result-name">${esc(listNames(winners.map(w => w.name)))}</p>
        <p class="dm-result-sub">${isTie ? 'Each scored' : 'Scored'} ${fmt(top.total)} of a possible ${fmt(maxPossible)} on your weights (${top.pct.toFixed(0)}%).</p>
        <ol class="dm-rank">${items}</ol>
        <button type="button" id="btn-copy-summary" class="stk-btn stk-btn-sm dm-copy">
            <i class="fa-regular fa-copy" aria-hidden="true"></i><span>Copy the ranking</span>
        </button>`;
    resultsPanel.hidden = false;

    const copyBtn = $('btn-copy-summary');
    copyBtn.addEventListener('click', () => {
        const label = copyBtn.querySelector('span');
        navigator.clipboard.writeText(summaryText(result)).then(() => {
            label.textContent = 'Copied';
            setTimeout(() => { label.textContent = 'Copy the ranking'; }, 1800);
        }, () => {
            label.textContent = 'The browser blocked the clipboard';
            setTimeout(() => { label.textContent = 'Copy the ranking'; }, 2500);
        });
    });
}

// --- Example ---
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

}
