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
  chooseBest,
  serialiseLibrary,
  getField,
  missingFields
} from '../src/core/bibtex.js';

// bibtexParse is loaded as a UMD global by the page's <script> tags.
registerFromGlobals();

// Five real papers' worth of entries, as a merged export looks: NumPy twice
// (one with a doi.org link for its DOI), SciPy twice (one with no DOI, so it
// is matched on its title), and Matplotlib once.
const EXAMPLE = `@article{harris2020numpy,
  title = {Array programming with {NumPy}},
  author = {Harris, Charles R. and Millman, K. Jarrod and van der Walt, St{\\'e}fan J.},
  journal = {Nature},
  volume = {585},
  pages = {357--362},
  year = {2020},
  doi = {10.1038/s41586-020-2649-2}
}

@article{Harris_2020,
  title = {Array programming with NumPy},
  author = {Harris, Charles R. and Millman, K. Jarrod},
  journal = {Nature},
  year = {2020},
  doi = {https://doi.org/10.1038/s41586-020-2649-2}
}

@article{virtanen2020scipy,
  title = {{SciPy} 1.0: fundamental algorithms for scientific computing in {Python}},
  author = {Virtanen, Pauli and Gommers, Ralf and Oliphant, Travis E.},
  journal = {Nature Methods},
  volume = {17},
  pages = {261--272},
  year = {2020},
  doi = {10.1038/s41592-019-0686-2}
}

@article{scipy2020,
  title = {SciPy 1.0: Fundamental Algorithms for Scientific Computing in Python},
  author = {Virtanen, P. and others},
  journal = {Nat. Methods},
  year = {2020}
}

@article{hunter2007matplotlib,
  title = {Matplotlib: A {2D} graphics environment},
  author = {Hunter, John D.},
  journal = {Computing in Science \\& Engineering},
  volume = {9},
  number = {3},
  pages = {90--95},
  year = {2007},
  doi = {10.1109/MCSE.2007.55}
}`;

document.addEventListener('DOMContentLoaded', () => {

  // --- 1. State ---
  let parsedEntries = [];
  let conflictGroups = [];
  let keptSingletons = [];
  let scanned = false;
  const resolutions = {};

  // --- 2. Bindings ---
  const bibInput = document.getElementById('bibInput');
  const fileInput = document.getElementById('fileInput');
  const scanBtn = document.getElementById('scanBtn');
  const clearBtn = document.getElementById('clearBtn');
  const exportBtn = document.getElementById('exportBtn');
  const exportedNote = document.getElementById('exportedNote');
  const diagnosticsCard = document.getElementById('diagnosticsCard');
  const conflictList = document.getElementById('conflictList');
  const emptyState = document.getElementById('emptyState');
  const allResolved = document.getElementById('allResolved');
  const allResolvedText = document.getElementById('allResolvedText');
  const totalEntriesCount = document.getElementById('totalEntriesCount');
  const duplicateCount = document.getElementById('duplicateCount');
  const uniqueCount = document.getElementById('uniqueCount');
  const progressLabel = document.getElementById('progressLabel');
  const autoResolveBtn = document.getElementById('autoResolveBtn');

  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  // --- 3. Input ---
  function syncInputButtons() {
    const has = bibInput.value.trim() !== '';
    scanBtn.disabled = !has;
    clearBtn.disabled = !has && !scanned;
  }
  bibInput.addEventListener('input', syncInputButtons);

  // Offered twice: in the page head and in the empty step 2.
  document.querySelectorAll('[data-load-example]').forEach(btn => {
    btn.addEventListener('click', () => {
      bibInput.value = EXAMPLE;
      syncInputButtons();
      showToast('Loaded five example entries. Press Scan for duplicates.');
      scanBtn.focus();
    });
  });

  clearBtn.addEventListener('click', () => {
    bibInput.value = '';
    resetResults();
    syncInputButtons();
    bibInput.focus();
  });

  // Reading a .bib from disk fills the same textarea the paste path uses, so
  // everything downstream is identical whichever way the data arrived.
  fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      bibInput.value = event.target.result;
      syncInputButtons();
      // Set from a callback, not typed: tell the step badges.
      if (window.STEMKit) window.STEMKit.refreshSteps();
      showToast(`Loaded ${file.name}. Press Scan for duplicates.`, 'success');
    };
    reader.onerror = () => showToast('Could not read that file.', 'error');
    reader.readAsText(file);
    fileInput.value = '';
  });

  // --- 4. Scan (delegated to the core) ---
  scanBtn.addEventListener('click', scanForDuplicates);

  function resetResults() {
    scanned = false;
    parsedEntries = [];
    conflictGroups = [];
    keptSingletons = [];
    Object.keys(resolutions).forEach(k => delete resolutions[k]);
    conflictList.innerHTML = '';
    conflictList.hidden = true;
    emptyState.hidden = false;
    allResolved.hidden = true;
    exportedNote.hidden = true;
    autoResolveBtn.classList.add('hidden');
    diagnosticsCard.classList.add('hidden');
  }

  function scanForDuplicates() {
    const raw = bibInput.value.trim();
    if (!raw) return;

    const parsed = parseBibtex(raw);
    if (parsed.error) return showToast(parsed.error, 'error');
    if (parsed.entries.length === 0) {
      return showToast('No BibTeX entries found. Each should start like @article{key, …}.', 'error');
    }

    resetResults();
    scanned = true;
    parsedEntries = parsed.entries;

    const result = findDuplicates(parsedEntries);
    conflictGroups = result.groups;
    keptSingletons = result.singletons;

    totalEntriesCount.textContent = parsedEntries.length;
    duplicateCount.textContent = result.duplicateCount;
    uniqueCount.textContent = keptSingletons.length + conflictGroups.length;

    if (parsed.strippedBlocks > 0) {
      showToast(`Skipped ${plural(parsed.strippedBlocks, '@string, @comment or @preamble block', '@string, @comment and @preamble blocks')}.`);
    }

    emptyState.hidden = true;
    renderConflictList();
    diagnosticsCard.classList.remove('hidden');
    updateProgress();
    syncInputButtons();
  }

  // --- 5. Groups ---
  function renderConflictList() {
    conflictList.innerHTML = '';
    const total = conflictGroups.length;
    conflictList.hidden = total === 0;
    autoResolveBtn.classList.toggle('hidden', total === 0);

    conflictGroups.forEach((group, gi) => {
      const wrapper = document.createElement('div');
      wrapper.className = 'dd-group';
      wrapper.setAttribute('role', 'group');
      wrapper.setAttribute('aria-labelledby', `dd-g${gi}`);

      const heading = document.createElement('p');
      heading.className = 'dd-group-title';
      heading.id = `dd-g${gi}`;
      heading.textContent = `Group ${gi + 1} of ${total}: ${plural(group.members.length, 'entry', 'entries')} for one work`;
      wrapper.appendChild(heading);

      const grid = document.createElement('div');
      grid.className = 'grid gap-3 md:grid-cols-2';

      // The most complete entry is marked so a user scanning quickly has a
      // sensible default rather than having to compare fields by eye.
      const best = chooseBest(group.members);

      for (const member of group.members) {
        const entry = member.data;
        const tags = entry.entryTags || {};
        const missing = missingFields(entry);
        const where = [getField(tags, 'journal') || getField(tags, 'booktitle'), getField(tags, 'year')]
          .filter(Boolean).join(', ');

        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'dd-card' + (entry === best ? ' is-best' : '');
        card.setAttribute('aria-pressed', String(resolutions[gi] === entry));
        card.innerHTML = `
          <span class="dd-card-head">
            <span class="dd-key">${escapeHtml(entry.citationKey)}</span>
            ${entry === best ? '<span class="stk-badge stk-badge-accent">Most complete</span>' : ''}
          </span>
          <span class="dd-title">${escapeHtml(getField(tags, 'title') || 'No title')}</span>
          <span class="dd-author">${escapeHtml(getField(tags, 'author') || 'No author')}</span>
          ${where ? `<span class="dd-meta">${escapeHtml(where)}</span>` : ''}
          <span class="dd-meta">${getField(tags, 'doi') ? 'Has a DOI' : 'No DOI'}${missing.length ? `; missing ${escapeHtml(missing.join(', '))}` : ''}</span>
          <span class="dd-keep" aria-hidden="true"><i class="fa-solid fa-circle-check"></i> Kept</span>`;

        card.addEventListener('click', () => {
          resolutions[gi] = entry;
          for (const sib of grid.children) sib.setAttribute('aria-pressed', String(sib === card));
          wrapper.classList.add('is-resolved');
          updateProgress();
        });

        grid.appendChild(card);
      }

      if (resolutions[gi]) wrapper.classList.add('is-resolved');
      wrapper.appendChild(grid);
      conflictList.appendChild(wrapper);
    });
  }

  autoResolveBtn.addEventListener('click', () => {
    conflictGroups.forEach((group, gi) => {
      resolutions[gi] = chooseBest(group.members);
    });
    renderConflictList();
    updateProgress();
    showToast('Kept the most complete entry in every group.', 'success');
  });

  function updateProgress() {
    const resolved = Object.keys(resolutions).length;
    const total = conflictGroups.length;
    const unique = keptSingletons.length + total;
    const done = scanned && resolved >= total;

    progressLabel.textContent = !scanned ? ''
      : total === 0 ? 'Nothing to choose: no entry has a duplicate.'
      : `${resolved} of ${plural(total, 'group', 'groups')} resolved.`;

    allResolved.hidden = !done;
    allResolvedText.textContent = total === 0
      ? `No duplicates: all ${plural(parsedEntries.length, 'entry is', 'entries are')} unique.`
      : `Every group has an entry kept. The clean file will hold ${plural(unique, 'entry', 'entries')}.`;

    exportBtn.disabled = !done;
    // A choice changed after a download: that file is out of date.
    exportedNote.hidden = true;
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

  exportBtn.addEventListener('click', () => {
    const finalList = buildFinalList();
    if (finalList.length === 0) return showToast('There is nothing to download.', 'error');

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

    exportedNote.textContent = `Saved cleaned_references.bib with ${plural(finalList.length, 'entry', 'entries')}.`;
    exportedNote.hidden = false;
  });

  // --- 7. Utilities ---
  function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // Toasts use the shared .stk-toast component.
  function showToast(msg, type = 'info') {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = 'stk-toast' +
      (type === 'success' ? ' stk-toast-ok' : type === 'error' ? ' stk-toast-danger' : '');
    toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
    const icon = document.createElement('i');
    icon.className = 'fa-solid ' + (type === 'success' ? 'fa-circle-check'
      : type === 'error' ? 'fa-triangle-exclamation' : 'fa-circle-info');
    icon.setAttribute('aria-hidden', 'true');
    const body = document.createElement('span');
    body.textContent = msg;
    toast.append(icon, body);
    container.appendChild(toast);
    setTimeout(() => toast.remove(), type === 'error' ? 5000 : 3000);
  }

  syncInputButtons();
});
