/**
 * STEMKit page chrome, shared by every page.
 *
 * - the theme toggle (the saved choice is applied earlier, by the inline
 *   script in each <head>, so the page never paints in the wrong theme)
 * - the mobile menu
 * - "Find a tool": a searchable list of every tool, opened from the header
 *   button, Ctrl/Cmd+K, or "/" outside a text field
 * - "Next steps": links to the tools that usually follow this one, rendered
 *   into <section data-stk-next> near the foot of each tool page
 *
 * TOOLS below is the site's one catalogue. The finder, the home page search,
 * the next-step links and the 404 suggestions all read it, and
 * tools/check-chrome.mjs fails if a name here disagrees with the home page
 * card or the tool's own <h1>.
 *
 * Loaded as a classic script at the end of <body>, before any tool module, so
 * its theme listener runs first and a tool that redraws a chart on the same
 * click sees the new class already in place.
 */
(function () {
  'use strict';

  var root = document.documentElement;

  var CATS = [
    { key: 'data', label: 'Data' },
    { key: 'comp', label: 'Compute' },
    { key: 'pub', label: 'Writing' },
    { key: 'focus', label: 'Focus' }
  ];

  var TOOLS = [
    // ---- Data ----
    { id: 'plot-digitizer', name: 'Plot Digitizer', cat: 'data', icon: 'fa-crosshairs',
      desc: 'Extract data points from a graph image by clicking or tracing curves, then export the numbers as CSV.',
      tags: 'digitise digitize graph figure image extract points data trace curve png jpeg screenshot paper literature',
      next: [['curve-fitter', 'Fit a model to the points you extracted'],
             ['plot-builder', 'Redraw them as a publication figure'],
             ['data-cleaner', 'Tidy or transform the exported CSV']] },
    { id: 'data-cleaner', name: 'Data Cleaner', cat: 'data', icon: 'fa-broom',
      desc: 'Clean, normalize and log-transform messy CSV datasets, then download the tidied file.',
      tags: 'csv tsv clean tidy normalize normalise log transform scale standardize missing nan null reshape long wide preprocess',
      next: [['outlier-detector', 'Flag anomalies before you analyse'],
             ['stats-calculator', 'Test the cleaned groups for differences'],
             ['plot-builder', 'Plot the cleaned columns']] },
    { id: 'stats-calculator', name: 'Statistics Calculator', cat: 'data', icon: 'fa-calculator',
      desc: 'Run t-tests, ANOVA, correlation and non-parametric tests with effect sizes, CIs and assumption checks.',
      tags: 't-test ttest welch student paired anova correlation pearson mann-whitney wilcoxon p-value pvalue significance effect size cohen confidence interval normality levene statistics stats',
      next: [['error-bar-generator', 'Summarise each group with error bars'],
             ['outlier-detector', 'Check for outliers that sway the test'],
             ['latex-tables', 'Typeset the results table in LaTeX']] },
    { id: 'error-bar-generator', name: 'Error Bar Generator', cat: 'data', icon: 'fa-chart-column',
      desc: 'Compute mean, SD, SEM, median, IQR and confidence intervals per group, then plot and export error bars.',
      tags: 'mean sd standard deviation sem standard error confidence interval ci median iqr replicate error bars bar chart group summary',
      next: [['stats-calculator', 'Test whether the groups differ'],
             ['plot-builder', 'Combine the summary with other series'],
             ['latex-tables', 'Put the summary table in your manuscript']] },
    { id: 'outlier-detector', name: 'Outlier Detector', cat: 'data', icon: 'fa-filter',
      desc: 'Flag anomalies with Z-scores, Tukey’s IQR fences or the robust modified Z-score.',
      tags: 'outlier anomaly tukey iqr quartile z-score zscore modified mad robust spike clean',
      next: [['data-cleaner', 'Remove or transform the flagged rows'],
             ['stats-calculator', 'Rerun the test with and without them'],
             ['error-bar-generator', 'Summarise the cleaned groups']] },
    { id: 'curve-fitter', name: 'Curve Fitter', cat: 'data', icon: 'fa-wave-square',
      desc: 'Fit linear, polynomial, exponential, power or log models and read off coefficients, R² and RMSE.',
      tags: 'fit fitting regression least squares linear polynomial exponential power log model coefficients r2 rmse equation',
      next: [['plot-builder', 'Draw the data and the model together'],
             ['latex-formatter', 'Typeset the fitted equation'],
             ['stats-calculator', 'Compare groups or correlate variables']] },
    { id: 'plot-builder', name: 'Plot Builder', cat: 'data', icon: 'fa-chart-area',
      desc: 'Overlay multiple datasets in one figure, style it fully, and export PNG/SVG or matplotlib code.',
      tags: 'plot chart graph figure publication overlay svg png matplotlib python export axis',
      next: [['xvg-visualizer', 'Read GROMACS .xvg series directly'],
             ['curve-fitter', 'Fit a model to one of the series'],
             ['error-bar-generator', 'Add group means with error bars']] },
    { id: 'xvg-visualizer', name: 'XVG Visualizer', cat: 'data', icon: 'fa-file-csv',
      desc: 'Plot GROMACS .xvg and CSV logs interactively; select columns, smooth, and export the figure or Python code.',
      tags: 'xvg gromacs gmx energy rmsd rmsf gyrate radius of gyration temperature pressure density g(r) rdf timeseries trajectory csv plumed colvar plot',
      next: [['outlier-detector', 'Spot spikes in a series'],
             ['stats-calculator', 'Compare equilibrated windows'],
             ['plot-builder', 'Overlay several runs in one figure']] },

    // ---- Compute ----
    { id: 'structure-inspector', name: 'Structure Inspector', cat: 'comp', icon: 'fa-cube',
      desc: 'Render PDB, CIF, GRO, XYZ and more in 3D; select atoms, measure geometry and export a figure.',
      tags: 'pdb cif mmcif gro xyz mol2 sdf 3d viewer molecule protein structure atoms selection distance angle measure rcsb 3dmol webgl',
      next: [['coordinate-manipulator', 'Translate, rotate or re-box it'],
             ['script-generator', 'Write the batch script for the run'],
             ['xvg-visualizer', 'Plot the analysis output']] },
    { id: 'coordinate-manipulator', name: 'Coordinate Manipulator', cat: 'comp', icon: 'fa-arrows-up-down-left-right',
      desc: 'Translate, rotate and re-box PDB, GRO and XYZ coordinates, and convert between the formats.',
      tags: 'pdb gro xyz coordinates translate rotate center centre box rebox convert format vector',
      next: [['structure-inspector', 'Check the result in 3D'],
             ['script-generator', 'Write the batch script for the system'],
             ['scientific-converter', 'Convert length and energy units']] },
    { id: 'scientific-converter', name: 'Scientific Converter', cat: 'comp', icon: 'fa-bolt',
      desc: 'Convert energy, length, pressure, dipole, polarizability, spectroscopic and temperature units against CODATA values.',
      tags: 'unit units convert conversion hartree ev kcal kcal/mol kj kj/mol kjmol wavenumber cm-1 nm angstrom bohr debye pressure bar atm temperature kelvin dipole polarizability spectroscopy codata energy',
      next: [['structure-inspector', 'Measure distances and angles'],
             ['latex-formatter', 'Typeset the values in an equation'],
             ['xvg-visualizer', 'Plot energies from a run']] },
    { id: 'script-generator', name: 'MD Workflow Generator', cat: 'comp', icon: 'fa-terminal',
      desc: 'Build batch scripts for GROMACS and LAMMPS on SLURM, PBS, LSF or Grid Engine, and write PLUMED inputs.',
      tags: 'slurm pbs openpbs lsf sge grid engine sbatch qsub hpc cluster batch job script submit gromacs lammps plumed metadynamics md simulation workflow gpu',
      next: [['coordinate-manipulator', 'Prepare the starting coordinates'],
             ['xvg-visualizer', 'Plot energy, RMSD and other output'],
             ['structure-inspector', 'Inspect the final frames']] },

    // ---- Writing ----
    { id: 'latex-formatter', name: 'Equation Formatter', cat: 'pub', icon: 'fa-square-root-variable',
      desc: 'Build LaTeX equations and matrices visually with a live preview, then copy the code.',
      tags: 'latex equation math formula katex mathlive matrix symbols tex',
      next: [['latex-tables', 'Build the tables for the same paper'],
             ['bibtex-sanitizer', 'Clean up the bibliography'],
             ['scientific-converter', 'Check a unit conversion']] },
    { id: 'latex-tables', name: 'Visual LaTeX Tables', cat: 'pub', icon: 'fa-table-cells',
      desc: 'Paste a table from Excel, edit and merge cells visually, and copy clean LaTeX (booktabs) output.',
      tags: 'latex table tabular booktabs excel spreadsheet csv markdown merge cells',
      next: [['latex-formatter', 'Typeset equations for the same paper'],
             ['stats-calculator', 'Produce the statistics to report'],
             ['bibtex-sanitizer', 'Tidy the references']] },
    { id: 'doi-fetcher', name: 'DOI to BibTeX', cat: 'pub', icon: 'fa-cloud-arrow-down',
      desc: 'Paste DOIs and get ready-to-use BibTeX entries resolved from Crossref.',
      tags: 'doi bibtex bib citation cite reference crossref fetch resolve bibliography',
      next: [['bibtex-sanitizer', 'Normalise the fetched entries'],
             ['bibtex-deduplicator', 'Merge them into your library'],
             ['journal-abbreviator', 'Abbreviate the journal names']] },
    { id: 'bibtex-deduplicator', name: 'BibTeX Deduplicator', cat: 'pub', icon: 'fa-copy',
      desc: 'Scan a .bib library and merge duplicate entries by DOI and title.',
      tags: 'bibtex bib duplicate duplicates dedupe merge library references citation bibliography zotero mendeley',
      next: [['bibtex-sanitizer', 'Clean fields and title casing'],
             ['journal-abbreviator', 'Abbreviate the journal names'],
             ['doi-fetcher', 'Fetch missing entries by DOI']] },
    { id: 'bibtex-sanitizer', name: 'BibTeX Sanitizer', cat: 'pub', icon: 'fa-broom',
      desc: 'Fix messy BibTeX exports: standardize capitalization, repair braces and clean fields.',
      tags: 'bibtex bib clean sanitize sanitise capitalization capitalisation braces fields citation bibliography google scholar zotero',
      next: [['bibtex-deduplicator', 'Merge duplicate entries'],
             ['journal-abbreviator', 'Abbreviate the journal names'],
             ['doi-fetcher', 'Fetch more entries by DOI']] },
    { id: 'journal-abbreviator', name: 'Journal Abbreviator', cat: 'pub', icon: 'fa-spell-check',
      desc: 'Convert full journal names to their ISO 4 / CASSI standard abbreviations.',
      tags: 'journal abbreviation abbreviate iso 4 iso4 ltwa cassi citation reference bibliography',
      next: [['bibtex-sanitizer', 'Clean the rest of each entry'],
             ['bibtex-deduplicator', 'Merge duplicate entries'],
             ['doi-fetcher', 'Fetch entries by DOI']] },

    // ---- Focus ----
    { id: 'pomodoro', name: 'Ambient Pomodoro', cat: 'focus', icon: 'fa-stopwatch',
      desc: 'A focus timer with adjustable ambient sounds like rain and cafe noise for deep work.',
      tags: 'pomodoro timer focus study break ambient rain cafe noise productivity',
      next: [['decision', 'Settle a choice before the next session'],
             ['sandbox', 'Take a short visual break']] },
    { id: 'decision', name: 'Decision Matrix', cat: 'focus', icon: 'fa-code-branch',
      desc: 'Weigh options against criteria in a scored matrix to rank your best choice.',
      tags: 'decision matrix weighted criteria choose choice compare options score rank',
      next: [['pomodoro', 'Start a focused session'],
             ['sandbox', 'Take a short visual break']] },
    { id: 'sandbox', name: 'Kinetic Sandbox', cat: 'focus', icon: 'fa-atom',
      desc: 'An interactive fluid and particle physics playground, a calm visual break.',
      tags: 'particle fluid physics simulation sandbox playground relax break',
      next: [['pomodoro', 'Get back to a focused session']] }
  ];

  var byId = {};
  TOOLS.forEach(function (t) { byId[t.id] = t; });
  var catLabel = {};
  CATS.forEach(function (c) { catLabel[c.key] = c.label; });

  // Resolve links against this script's own location, so they work from any
  // page depth (the 404 page is served at arbitrary paths) and under a subpath.
  var base = (function () {
    var s = document.currentScript && document.currentScript.src;
    return s ? s.replace(/js\/site\.js(?:[?#].*)?$/, '') : '';
  })();
  function href(id) { return base + id + '.html'; }

  var here = (location.pathname.split('/').pop() || 'index.html').replace(/\.html$/, '');
  var current = byId[here] || null;

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /**
   * Every word of the query must appear in the tool's name, description,
   * search terms or category. Hyphens are optional ("ttest" finds "t-test").
   * Name hits rank above search-term hits, which rank above description hits.
   */
  function match(query) {
    var words = String(query || '').toLowerCase().trim().split(/\s+/).filter(Boolean);
    if (!words.length) return TOOLS.slice();
    var scored = [];
    TOOLS.forEach(function (t, order) {
      var name = t.name.toLowerCase();
      var tags = t.tags.toLowerCase();
      var desc = t.desc.toLowerCase();
      var cat = catLabel[t.cat].toLowerCase();
      var score = 0;
      for (var i = 0; i < words.length; i++) {
        var w = words[i], bare = w.replace(/-/g, '');
        var has = function (h) { return h.indexOf(w) !== -1 || h.replace(/-/g, '').indexOf(bare) !== -1; };
        if (has(name)) score += name.indexOf(w) === 0 ? 40 : 25;
        else if (has(tags)) score += 12;
        else if (has(desc)) score += 5;
        else if (has(cat)) score += 3;
        else return;
      }
      scored.push({ t: t, s: score, o: order });
    });
    scored.sort(function (a, b) { return b.s - a.s || a.o - b.o; });
    return scored.map(function (x) { return x.t; });
  }

  // ---------------------------------------------------------------- theme
  function syncThemeButtons() {
    var dark = root.classList.contains('dark');
    document.querySelectorAll('.themeToggle').forEach(function (b) {
      b.setAttribute('aria-pressed', String(dark));
    });
  }
  function setTheme(dark, remember) {
    root.classList.toggle('dark', dark);
    root.classList.toggle('light', !dark);
    if (remember) { try { localStorage.theme = dark ? 'dark' : 'light'; } catch (e) { /* private mode */ } }
    syncThemeButtons();
  }
  document.querySelectorAll('.themeToggle').forEach(function (b) {
    b.addEventListener('click', function () {
      setTheme(!root.classList.contains('dark'), true);
      b.classList.remove('is-turning'); void b.offsetWidth; b.classList.add('is-turning');
      setTimeout(function () { b.classList.remove('is-turning'); }, 400);
    });
  });
  syncThemeButtons();
  // Follow the system setting live until the visitor picks one here.
  if (window.matchMedia) {
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    var onScheme = function (e) {
      var stored = null;
      try { stored = localStorage.theme; } catch (err) { /* private mode */ }
      if (!stored) setTheme(e.matches, false);
    };
    if (mq.addEventListener) mq.addEventListener('change', onScheme);
  }

  // ---------------------------------------------------------- mobile menu
  var menuBtn = document.getElementById('mobile-menu-btn');
  var menu = document.getElementById('mobile-menu');
  var menuIcon = document.getElementById('menu-icon');
  function setMenu(open) {
    if (!menuBtn || !menu) return;
    menu.classList.toggle('hidden', !open);
    if (menuIcon) {
      menuIcon.classList.toggle('fa-bars', !open);
      menuIcon.classList.toggle('fa-xmark', open);
    }
    menuBtn.setAttribute('aria-expanded', String(open));
    menuBtn.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
  }
  if (menuBtn && menu) {
    menuBtn.addEventListener('click', function () { setMenu(menu.classList.contains('hidden')); });
    menu.querySelectorAll('a, button').forEach(function (el) {
      el.addEventListener('click', function () { setMenu(false); });
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !menu.classList.contains('hidden')) { setMenu(false); menuBtn.focus(); }
    });
  }

  // Mark the header link for the section this tool belongs to.
  if (current) {
    document.querySelectorAll('[data-stk-cat="' + current.cat + '"]').forEach(function (a) {
      a.classList.add('is-current');
    });
  }

  // --------------------------------------------------------- tool finder
  var isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  document.querySelectorAll('[data-stk-find-kbd]').forEach(function (k) {
    k.textContent = isMac ? '⌘K' : 'Ctrl K';
  });

  var dialog, input, list, options = [], active = -1;

  function iconChip(t, cls) {
    return '<span class="' + cls + '"><i class="fa-solid ' + t.icon + '" aria-hidden="true"></i></span>';
  }

  function buildFinder() {
    dialog = document.createElement('dialog');
    dialog.className = 'stk-finder';
    dialog.setAttribute('aria-label', 'Find a tool');
    dialog.innerHTML =
      '<div class="stk-finder-box">' +
        '<div class="stk-finder-field">' +
          '<i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>' +
          '<input type="text" role="combobox" aria-expanded="true" aria-controls="stk-finder-list"' +
          ' aria-autocomplete="list" aria-label="Find a tool" autocomplete="off" spellcheck="false"' +
          ' placeholder="Find a tool: try xvg, t-test or bibtex">' +
          '<button type="button" class="stk-finder-close" aria-label="Close">Esc</button>' +
        '</div>' +
        '<ul id="stk-finder-list" class="stk-finder-list" role="listbox" aria-label="Tools"></ul>' +
        '<div class="stk-finder-foot" aria-hidden="true">' +
          '<span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>Enter</kbd> open</span><span><kbd>Esc</kbd> close</span>' +
        '</div>' +
      '</div>';
    document.body.appendChild(dialog);
    input = dialog.querySelector('input');
    list = dialog.querySelector('ul');

    input.addEventListener('input', function () { render(input.value); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
      else if (e.key === 'Enter' && active >= 0) {
        e.preventDefault();
        var a = options[active].querySelector('a');
        if (e.metaKey || e.ctrlKey) window.open(a.href, '_blank', 'noopener');
        else location.href = a.href;
      }
    });
    dialog.querySelector('.stk-finder-close').addEventListener('click', closeFinder);
    // A click on the backdrop lands on the <dialog> itself.
    dialog.addEventListener('click', function (e) { if (e.target === dialog) closeFinder(); });
    list.addEventListener('mousemove', function (e) {
      var li = e.target.closest('[role="option"]');
      if (li) setActive(options.indexOf(li), false);
    });
  }

  function render(query) {
    var q = String(query || '').trim();
    var results = match(q);
    list.innerHTML = '';
    options = [];
    if (!results.length) {
      list.innerHTML = '<li class="stk-finder-empty" role="presentation">No tools match “' + esc(q) +
        '”. Try a file type (xvg, pdb, bib) or a task (fit, convert, cite).</li>';
      setActive(-1);
      return;
    }
    var lastCat = null;
    results.forEach(function (t) {
      if (!q && t.cat !== lastCat) {
        lastCat = t.cat;
        var h = document.createElement('li');
        h.className = 'stk-finder-group';
        h.setAttribute('role', 'presentation');
        h.textContent = catLabel[t.cat];
        list.appendChild(h);
      }
      var li = document.createElement('li');
      li.id = 'stk-finder-' + t.id;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', 'false');
      li.className = 'stk-finder-opt';
      li.innerHTML =
        '<a href="' + href(t.id) + '" tabindex="-1">' +
          iconChip(t, 'stk-finder-ico') +
          '<span class="stk-finder-txt"><span class="stk-finder-name">' + esc(t.name) + '</span>' +
          '<span class="stk-finder-desc">' + esc(t.desc) + '</span></span>' +
          (t === current ? '<span class="stk-finder-tag">This page</span>'
                         : '<span class="stk-finder-tag">' + catLabel[t.cat] + '</span>') +
        '</a>';
      list.appendChild(li);
      options.push(li);
    });
    setActive(0);
  }

  function setActive(i, scroll) {
    if (active >= 0 && options[active]) options[active].setAttribute('aria-selected', 'false');
    active = i;
    if (i < 0 || !options[i]) { input.removeAttribute('aria-activedescendant'); return; }
    options[i].setAttribute('aria-selected', 'true');
    input.setAttribute('aria-activedescendant', options[i].id);
    if (scroll !== false) options[i].scrollIntoView({ block: 'nearest' });
  }
  function move(d) {
    if (!options.length) return;
    setActive((active + d + options.length) % options.length);
  }

  function openFinder() {
    if (!dialog) buildFinder();
    if (dialog.open) { input.focus(); return; }
    setMenu(false);
    input.value = '';
    render('');
    dialog.showModal();
    input.focus();
  }
  function closeFinder() { if (dialog && dialog.open) dialog.close(); }

  document.querySelectorAll('[data-stk-find]').forEach(function (b) {
    b.addEventListener('click', openFinder);
  });

  function typing(el) {
    if (!el) return false;
    var tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'MATH-FIELD' || el.isContentEditable;
  }
  document.addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      if (dialog && dialog.open) closeFinder(); else openFinder();
      return;
    }
    // On the home page "/" belongs to the search box in the hero.
    if (e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey && !typing(e.target) &&
        !document.getElementById('toolSearch') && !(dialog && dialog.open)) {
      e.preventDefault();
      openFinder();
    }
  });

  // ---------------------------------------------------------- next steps
  var nextHost = document.querySelector('[data-stk-next]');
  if (nextHost && current && current.next && current.next.length) {
    nextHost.innerHTML =
      '<div class="stk-next-wrap">' +
        '<h2 class="stk-next-title">Next steps</h2>' +
        '<p class="stk-next-sub">Tools that pick up where this one leaves off.</p>' +
        '<div class="stk-next-grid">' +
          current.next.map(function (n) {
            var t = byId[n[0]];
            if (!t) return '';
            return '<a class="stk-next-card" href="' + href(t.id) + '">' +
                     iconChip(t, 'stk-next-ico') +
                     '<span class="stk-next-txt"><span class="stk-next-name">' + esc(t.name) + '</span>' +
                     '<span class="stk-next-why">' + esc(n[1]) + '</span></span>' +
                     '<i class="fa-solid fa-arrow-right stk-next-go" aria-hidden="true"></i>' +
                   '</a>';
          }).join('') +
        '</div>' +
      '</div>';
    nextHost.hidden = false;
  }

  // --------------------------------------------------------------- steps
  // Numbered panels follow the visitor's progress without any code in the
  // tool: each panel names, in data-stk-done, what "done" looks like, and the
  // page is re-read whenever something changes. See .stk-stepn in
  // src/tailwind/input.css for the rule syntax.
  var stepPanels = Array.prototype.slice.call(document.querySelectorAll('[data-stk-step]'))
    .sort(function (a, b) { return +a.getAttribute('data-stk-step') - +b.getAttribute('data-stk-step'); });
  var revealables = Array.prototype.slice.call(document.querySelectorAll('[data-stk-reveal]'));

  function shown(el) {
    if (!el || el.hidden || el.closest('[hidden]') || !el.getClientRects().length) return false;
    return getComputedStyle(el).visibility !== 'hidden';
  }
  function holds(rules) {
    return rules.split(',').some(function (rule) {
      var i = rule.indexOf(':');
      var kind = rule.slice(0, i).trim();
      var el = document.querySelector(rule.slice(i + 1).trim());
      if (!el) return false;
      if (kind === 'filled') return String(el.value || '').trim() !== '';
      if (kind === 'visible') return shown(el);
      if (kind === 'hidden') return !shown(el);
      if (kind === 'text') return shown(el) && el.textContent.trim() !== '';
      return false;
    });
  }
  function syncSteps() {
    var seenOpen = false;
    stepPanels.forEach(function (p) {
      var rule = p.getAttribute('data-stk-done');
      var done = !!rule && holds(rule);
      var state = done ? 'done' : (seenOpen ? 'pending' : 'current');
      if (!done) seenOpen = true;
      var prev = p.getAttribute('data-stk-state');
      if (state === prev) return;
      p.setAttribute('data-stk-state', state);
      p.classList.remove('stk-just-done');
      // Animate a step the visitor just completed, not one done on arrival.
      if (state === 'done' && prev) { void p.offsetWidth; p.classList.add('stk-just-done'); }
    });
    revealables.forEach(function (el) {
      var now = shown(el);
      if (now && el._stkShown === false) {
        el.classList.remove('stk-reveal'); void el.offsetWidth; el.classList.add('stk-reveal');
      }
      el._stkShown = now;
    });
  }
  if (stepPanels.length || revealables.length) {
    var queued = false;
    var queue = function () {
      if (queued) return;
      queued = true;
      requestAnimationFrame(function () { queued = false; syncSteps(); });
    };
    syncSteps();
    ['input', 'change', 'click', 'keyup', 'drop'].forEach(function (t) { document.addEventListener(t, queue, true); });
    new MutationObserver(queue).observe(document.body, {
      subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'hidden', 'style']
    });
    revealables.forEach(function (el) {
      el.addEventListener('animationend', function () { el.classList.remove('stk-reveal'); });
    });
  }

  window.STEMKit = {
    refreshSteps: stepPanels.length ? syncSteps : function () {},
    tools: TOOLS,
    categories: CATS,
    byId: byId,
    href: href,
    match: match,
    openFinder: openFinder
  };
})();
