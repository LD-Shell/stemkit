/**
 * BibTeX Deduplicator | UI layer.
 *
 * Parsing, union-find duplicate detection, completeness scoring, and
 * serialisation live in @stemkit/core; this file handles DOM wiring and
 * conflict resolution.
 */
import { registerFromGlobals } from '../src/core/vendor.js';
import {
  parseBibtex,
  findDuplicates,
  completenessScore,
  chooseBest,
  serialiseLibrary,
  getField,
  missingFields
} from '../src/core/bibtex.js';

// bibtexParse is loaded as a UMD global by the page's <script> tags.
registerFromGlobals();

document.addEventListener('DOMContentLoaded', () => {

  // --- 1. State ---
  let parsedEntries = [];
  let conflictGroups = [];
  let keptSingletons = [];
  const resolutions = {};

  // --- 2. Bindings ---
  const bibInput = document.getElementById('bibInput');
  const fileInput = document.getElementById('fileInput');
  const scanBtn = document.getElementById('scanBtn');
  const exportBtn = document.getElementById('exportBtn');
  const diagnosticsCard = document.getElementById('diagnosticsCard');
  const conflictList = document.getElementById('conflictList');
  const emptyState = document.getElementById('emptyState');
  const totalEntriesCount = document.getElementById('totalEntriesCount');
  const duplicateCount = document.getElementById('duplicateCount');
  const uniqueCount = document.getElementById('uniqueCount');
  const progressLabel = document.getElementById('progressLabel');
  const autoResolveBtn = document.getElementById('autoResolveBtn');

  document.querySelectorAll('.accordion-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const expanded = btn.getAttribute('aria-expanded') === 'true';
      btn.setAttribute('aria-expanded', !expanded);
      const target = document.getElementById(btn.getAttribute('data-target'));
      if (target) target.classList.toggle('expanded');
    });
  });

  // --- 3. Scan (delegated to the core) ---
  if (scanBtn) scanBtn.addEventListener('click', scanForDuplicates);

  function scanForDuplicates() {
    const raw = bibInput.value.trim();
    if (!raw) return showToast('Please input BibTeX data first.', 'error');

    const parsed = parseBibtex(raw);

    if (parsed.error) {
      showToast(parsed.error, 'error');
      return;
    }
    if (parsed.entries.length === 0) {
      showToast('No valid BibTeX entries detected.', 'error');
      return;
    }

    parsedEntries = parsed.entries;
    Object.keys(resolutions).forEach(k => delete resolutions[k]);

    const result = findDuplicates(parsedEntries);
    conflictGroups = result.groups;
    keptSingletons = result.singletons;

    if (totalEntriesCount) totalEntriesCount.innerText = parsedEntries.length;
    if (duplicateCount) duplicateCount.innerText = result.duplicateCount;
    if (uniqueCount) {
      uniqueCount.innerText = keptSingletons.length + conflictGroups.length;
    }

    if (parsed.strippedBlocks > 0) {
      showToast(
        `Skipped ${parsed.strippedBlocks} @string/@comment/@preamble block(s).`,
        'info'
      );
    }

    renderConflictList();
    if (diagnosticsCard) diagnosticsCard.classList.remove('hidden');
    updateProgress();
  }

  // --- 4. Conflict rendering ---
  function renderConflictList() {
    if (!conflictList) return;
    conflictList.innerHTML = '';

    if (conflictGroups.length === 0) {
      // The page ships a dedicated empty-state panel; using it keeps the
      // initial placeholder from lingering behind the result.
      if (emptyState) {
        emptyState.innerHTML =
          '<i class="fa-solid fa-circle-check text-6xl mb-4 text-emerald-500"></i>' +
          '<p class="font-medium text-emerald-600 dark:text-emerald-400">' +
          'Library is clean. No duplicates found.</p>';
        emptyState.classList.remove('hidden');
      } else {
        conflictList.innerHTML =
          '<div class="text-center py-10 text-slate-400 text-sm">' +
          'No duplicates found, every entry is unique.</div>';
      }
      if (autoResolveBtn) autoResolveBtn.classList.add('hidden');
      if (exportBtn) exportBtn.disabled = false;
      return;
    }

    if (emptyState) emptyState.classList.add('hidden');
    if (autoResolveBtn) autoResolveBtn.classList.remove('hidden');

    conflictGroups.forEach((group, gi) => {
      const wrapper = document.createElement('div');
      wrapper.className =
        'border border-slate-200 dark:border-slate-700 rounded-xl p-4 mb-4';

      const heading = document.createElement('div');
      heading.className = 'text-xs font-bold uppercase tracking-wider text-slate-400 mb-3';
      heading.textContent = `Conflict ${gi + 1}, ${group.members.length} entries`;
      wrapper.appendChild(heading);

      const grid = document.createElement('div');
      grid.className = 'grid gap-3 md:grid-cols-2';

      // The most complete entry is marked so a user scanning quickly has a
      // sensible default rather than having to compare fields by eye.
      const best = chooseBest(group.members);

      for (const member of group.members) {
        const entry = member.data;
        const isBest = entry === best;
        const card = document.createElement('div');
        card.className =
          'p-3 rounded-lg border cursor-pointer transition-colors text-xs ' +
          (isBest
            ? 'border-emerald-300 dark:border-emerald-700 bg-emerald-50/50 dark:bg-emerald-900/10'
            : 'border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800');

        const tags = entry.entryTags || {};
        const missing = missingFields(entry);

        card.innerHTML = `
          <div class="font-bold text-indigo-600 dark:text-indigo-400 mb-1">
            ${escapeHtml(entry.citationKey)}${isBest ? ' <span class="text-emerald-600">· most complete</span>' : ''}
          </div>
          <div class="text-slate-600 dark:text-slate-400 mb-1">
            ${escapeHtml(getField(tags, 'author') || 'No author')}
          </div>
          <div class="text-slate-500 dark:text-slate-500 mb-1">
            ${escapeHtml(getField(tags, 'title') || 'No title')}
          </div>
          <div class="font-mono text-[10px] text-slate-400">
            ${escapeHtml(getField(tags, 'journal') || '')} ${escapeHtml(getField(tags, 'year') || '')}
            ${getField(tags, 'doi') ? '· DOI' : ''}
            · score ${completenessScore(entry)}
          </div>
          ${missing.length ? `<div class="text-[10px] text-amber-600 mt-1">missing: ${missing.join(', ')}</div>` : ''}
        `;

        card.addEventListener('click', () => {
          resolutions[gi] = entry;
          for (const sib of grid.children) {
            sib.classList.remove('ring-2', 'ring-indigo-500');
          }
          card.classList.add('ring-2', 'ring-indigo-500');
          updateProgress();
        });

        grid.appendChild(card);
      }

      wrapper.appendChild(grid);
      conflictList.appendChild(wrapper);
    });
  }

  // --- 5. Resolution ---
  if (autoResolveBtn) autoResolveBtn.addEventListener('click', () => {
    conflictGroups.forEach((group, gi) => {
      resolutions[gi] = chooseBest(group.members);
    });
    renderConflictList();
    // Re-mark the chosen cards after the rebuild.
    conflictGroups.forEach((group, gi) => {
      const cards = conflictList.children[gi];
      if (!cards) return;
      const idx = group.members.findIndex(m => m.data === resolutions[gi]);
      const grid = cards.querySelector('.grid');
      if (grid && grid.children[idx]) {
        grid.children[idx].classList.add('ring-2', 'ring-indigo-500');
      }
    });
    updateProgress();
    showToast('Kept the most complete entry in every conflict.', 'success');
  });

  function updateProgress() {
    const resolved = Object.keys(resolutions).length;
    const total = conflictGroups.length;
    if (progressLabel) {
      progressLabel.innerText = total === 0
        ? 'Nothing to resolve.'
        : `${resolved} of ${total} conflicts resolved`;
    }
    if (exportBtn) exportBtn.disabled = total > 0 && resolved < total;
  }

  // --- 6. Export ---
  function buildFinalList() {
    const indexOf = new Map();
    parsedEntries.forEach((e, i) => indexOf.set(e, i));

    const chosen = conflictGroups.map((g, gi) =>
      resolutions[gi] || chooseBest(g.members));

    return [...keptSingletons, ...chosen]
      .filter(Boolean)
      .sort((a, b) => (indexOf.get(a) ?? 0) - (indexOf.get(b) ?? 0));
  }

  if (exportBtn) exportBtn.addEventListener('click', () => {
    const finalList = buildFinalList();
    if (finalList.length === 0) return showToast('Nothing to export.', 'error');

    const output = serialiseLibrary(finalList);
    const blob = new Blob([output], { type: 'text/plain;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'cleaned_references.bib';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    showToast(`Exported ${finalList.length} unique entries.`, 'success');
  });

  // --- 7. Utilities ---
  function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function showToast(msg, type) {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    const colors = type === 'success'
      ? 'bg-emerald-50 text-emerald-800 border-emerald-200 dark:bg-emerald-900/30'
      : type === 'error'
        ? 'bg-red-50 text-red-800 border-red-200 dark:bg-red-900/30'
        : 'bg-indigo-50 text-indigo-800 border-indigo-200 dark:bg-indigo-900/30';
    toast.className =
      `px-4 py-3 rounded-xl border shadow-lg toast-enter text-sm font-medium transition-all ${colors}`;
    toast.innerText = msg;
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  // Reading a .bib from disk fills the same textarea the paste path uses, so
  // everything downstream is identical whichever way the data arrived.
  if (fileInput) fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      bibInput.value = event.target.result;
      showToast(`Loaded ${file.name}.`, 'success');
    };
    reader.onerror = () => showToast('Could not read that file.', 'error');
    reader.readAsText(file);
    fileInput.value = '';
  });

});
