/**
 * BibTeX Deduplicator | UI layer.
 *
 * Parsing, union-find duplicate detection, completeness scoring, and
 * serialisation live in stemkit-core; this file handles DOM wiring and
 * conflict resolution.
 */
import { registerFromGlobals } from '../src/core/vendor.js';
import {
  parseBibtex,
  findDuplicates,
  chooseBest,
  serialiseLibrary,
  getField,
  normaliseDoi,
  isDoi,
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
  // The text the results on the page were made from. Once the text in step 1
  // differs from it, the results are out of date: they stay on the page,
  // marked as such, and nothing can be chosen or downloaded until the text is
  // scanned again (or put back as it was).
  let scannedText = '';
  let stale = false;
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
  const scanError = document.getElementById('scanError');
  const resultsPanel = document.getElementById('resultsPanel');
  const staleNote = document.getElementById('staleNote');
  const rescanBtn = document.getElementById('rescanBtn');
  const lookAlikes = document.getElementById('lookAlikes');
  const lookAlikesTitle = document.getElementById('lookAlikesTitle');
  const lookAlikesList = document.getElementById('lookAlikesList');

  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  // --- 3. Input ---
  function syncInputButtons() {
    const text = bibInput.value.trim();
    const has = text !== '';
    scanBtn.disabled = !has;
    rescanBtn.disabled = !has;
    clearBtn.disabled = !has && !scanned;
    setStale(scanned && text !== scannedText);
  }
  bibInput.addEventListener('input', syncInputButtons);

  // Scanning a large library again on every keystroke would be slow, and
  // would throw away the choices already made. So the results of the last
  // scan stay, dimmed and switched off, with a note saying why.
  function setStale(now) {
    if (now === stale) return;
    stale = now;
    staleNote.hidden = !stale;
    resultsPanel.classList.toggle('is-stale', stale);
    diagnosticsCard.classList.toggle('is-stale', stale);
    autoResolveBtn.disabled = stale;
    for (const card of conflictList.querySelectorAll('.dd-card')) card.disabled = stale;
    updateProgress();
  }

  function showScanError(message) {
    const note = document.createElement('p');
    note.className = 'stk-callout stk-callout-danger';
    const icon = document.createElement('i');
    icon.className = 'fa-solid fa-triangle-exclamation';
    icon.setAttribute('aria-hidden', 'true');
    const body = document.createElement('span');
    body.textContent = message;
    note.append(icon, body);
    // #scanError is an alert that is always in the page: what is put into it
    // is read out.
    scanError.replaceChildren(note);
  }
  const clearScanError = () => scanError.replaceChildren();

  // Offered twice: in the page head and in the empty step 2.
  document.querySelectorAll('[data-load-example]').forEach(btn => {
    btn.addEventListener('click', () => {
      bibInput.value = EXAMPLE;
      clearScanError();
      syncInputButtons();
      showToast('Loaded five example entries. Press Scan for duplicates.');
      scanBtn.focus();
    });
  });

  clearBtn.addEventListener('click', () => {
    bibInput.value = '';
    clearScanError();
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
      clearScanError();
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

  // The note that the results are out of date has its own Scan again. It
  // goes away with the note, so the focus is sent on: to the first choice,
  // to the download when there is nothing to choose, or back to the text
  // when the scan failed.
  rescanBtn.addEventListener('click', () => {
    const ok = scanForDuplicates();
    const next = !ok ? bibInput : conflictList.querySelector('.dd-card') || exportBtn;
    next.focus();
  });

  function resetResults() {
    scanned = false;
    scannedText = '';
    parsedEntries = [];
    conflictGroups = [];
    keptSingletons = [];
    Object.keys(resolutions).forEach(k => delete resolutions[k]);
    conflictList.innerHTML = '';
    conflictList.hidden = true;
    lookAlikesList.innerHTML = '';
    lookAlikes.hidden = true;
    lookAlikes.open = false;
    emptyState.hidden = false;
    allResolved.hidden = true;
    exportedNote.hidden = true;
    progressLabel.textContent = '';
    exportBtn.disabled = true;
    autoResolveBtn.classList.add('hidden');
    diagnosticsCard.classList.add('hidden');
    setStale(false);
  }

  // A scan that fails leaves nothing of the scan before it: groups and
  // counts made from another text would read as the result of this one.
  function scanFailed(reason) {
    const hadResults = scanned;
    resetResults();
    syncInputButtons();
    showScanError(`Nothing was scanned. ${/[.!?]$/.test(reason) ? reason : reason + '.'}` +
      (hadResults ? ' The results of the earlier scan have been cleared.' : ''));
    return false;
  }

  /** Scan the text in step 1. True when there are results to show. */
  function scanForDuplicates() {
    const raw = bibInput.value.trim();
    if (!raw) return false;

    const parsed = parseBibtex(raw);
    if (parsed.error) return scanFailed(parsed.error);
    if (parsed.entries.length === 0) {
      return scanFailed('No BibTeX entries were found: each should start like @article{key, …}.');
    }

    clearScanError();
    resetResults();
    scanned = true;
    scannedText = raw;
    parsedEntries = parsed.entries;

    const result = findDuplicates(parsedEntries);
    conflictGroups = result.groups;
    keptSingletons = result.singletons;

    totalEntriesCount.textContent = parsedEntries.length;
    duplicateCount.textContent = result.duplicateCount;
    uniqueCount.textContent = keptSingletons.length + conflictGroups.length;

    // They are not entries, so they are not compared, but the download keeps
    // them: the kept entries may use the @string macros.
    if (parsed.strippedBlocks > 0) {
      showToast(`The download keeps the ${plural(parsed.strippedBlocks, '@string, @comment or @preamble block', '@string, @comment and @preamble blocks')}.`);
    }

    emptyState.hidden = true;
    renderConflictList();
    renderLookAlikes(result.lookAlikes);
    diagnosticsCard.classList.remove('hidden');
    updateProgress();
    syncInputButtons();
    return true;
  }

  // --- 5. Groups ---
  // Only a value that is a DOI counts as one when entries are compared, so
  // the card says when a doi field holds something else.
  const doiLabel = (value) => isDoi(value) ? 'Has a DOI'
    : value.trim() ? 'The doi field is not a DOI' : 'No DOI';

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
        card.disabled = stale;
        card.innerHTML = `
          <span class="dd-card-head">
            <span class="dd-key">${escapeHtml(entry.citationKey || 'No key')}</span>
            ${entry === best ? '<span class="stk-badge stk-badge-accent">Most complete</span>' : ''}
          </span>
          <span class="dd-title">${escapeHtml(getField(tags, 'title') || 'No title')}</span>
          <span class="dd-author">${escapeHtml(getField(tags, 'author') || 'No author')}</span>
          ${where ? `<span class="dd-meta">${escapeHtml(where)}</span>` : ''}
          <span class="dd-meta">${doiLabel(getField(tags, 'doi'))}${missing.length ? `; missing ${escapeHtml(missing.join(', '))}` : ''}</span>
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

  // Entries that share a title but carry different DOIs are not grouped: a
  // DOI identifies a work. They are listed, since one of them with no DOI
  // may still be a copy of another.
  function renderLookAlikes(sets) {
    lookAlikesList.innerHTML = '';
    lookAlikes.hidden = sets.length === 0;
    if (sets.length === 0) return;

    const entries = sets.reduce((n, set) => n + set.members.length, 0);
    lookAlikesTitle.textContent =
      `${plural(sets.length, 'title is', 'titles are')} shared by entries with different DOIs ` +
      `(${plural(entries, 'entry', 'entries')}). They were not grouped.`;

    for (const set of sets) {
      const item = document.createElement('li');
      const title = document.createElement('span');
      title.className = 'dd-alike-title';
      title.textContent = getField(set.members[0].data.entryTags || {}, 'title') || 'No title';
      const list = document.createElement('ul');
      for (const member of set.members) {
        const tags = member.data.entryTags || {};
        const doi = getField(tags, 'doi');
        const row = document.createElement('li');
        const key = document.createElement('span');
        key.className = 'dd-key';
        key.textContent = member.data.citationKey || 'No key';
        row.append(key, ` ${isDoi(doi) ? normaliseDoi(doi) : 'no DOI'}`);
        list.appendChild(row);
      }
      item.append(title, list);
      lookAlikesList.appendChild(item);
    }
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
    const done = scanned && !stale && resolved >= total;

    progressLabel.textContent = !scanned ? ''
      : stale ? 'Out of date: the text in step 1 has changed since this scan. Scan again to download.'
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
    // The file is written from the text that was scanned, so it is only
    // offered while that is still the text in step 1.
    if (!scanned || stale) return;
    const finalList = buildFinalList();
    if (finalList.length === 0) return showToast('There is nothing to download.', 'error');

    // The entries are the parser's own objects in source order, so the core
    // writes the scanned text with the other entries cut out: kept entries,
    // @string blocks and comments are exactly as they were.
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
