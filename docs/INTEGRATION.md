# Integration guide

How to drop this into your existing STEMKit checkout.

## 1. Copy the files

Everything preserves your repository's layout, so paths map one-to-one:

```
src/core/*.js          → src/core/          (new — the extracted library)
tests/*.js             → tests/             (new — the test suite)
js/*.js                → js/                (replaces 14 tool scripts, plus 2 adapters)
src/stemkit-docs.css   → src/               (new — shared docs styles)
src/tools/*.css        → src/tools/         (new — 20 per-tool stylesheets)
html/*.html            → repository root    (replaces 14 existing pages)
js/dependencies/package.json → js/dependencies/   (new — see §4, important)
package.json           → repository root
README.md, LICENSE     → repository root
```

Your `src/` already holds CSS; `src/core/` sits alongside it and nothing is
overwritten. The vendored bundles in `js/dependencies/` are unchanged and are
not included in this archive — only the new `package.json` beside them.

## 2. Install and test

```bash
npm install
npm test
```

Expect 701 passing tests across 12 modules.

## 3. HTML changes

Four pages are supplied pre-patched in `html/` — copy them over the originals
and no manual edit is needed. For any *other* tool you convert later, the edit
is to add `type="module"` to its script tag:

```html
<!-- BEFORE -->
<script src="js/xvg-visualizer.js" defer></script>

<!-- AFTER -->
<script type="module" src="js/xvg-visualizer.js"></script>
```

Two notes:

- `defer` is redundant — module scripts defer by default. Remove it.
- Leave the vendored `<script>` tags (Plotly, Papa, jStat) exactly as they are,
  and **before** the module script. They install the globals that
  `registerFromGlobals()` picks up.

## 4. The `js/dependencies/package.json` file

This one-line file matters more than it looks. The root `package.json` declares
`"type": "module"`, which tells Node to parse *every* `.js` file under the
repository as an ES module — including the vendored UMD bundles. When that
happens, the UMD factory takes its browser branch and fails with:

```
TypeError: Cannot set properties of undefined (setting 'jStat')
```

Scoping `"type": "commonjs"` to that directory restores the CommonJS branch, so
`createRequire` loads them correctly. Without it, every Node example in the
README fails on the first import.

## 5. Serving locally

ES modules are blocked by CORS under `file://`. Use any static server:

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000/xvg-visualizer.html`.

## 6. Conversion status

**Fourteen tools are fully converted**, each with its logic in `src/core/`, its
styles in `src/tools/`, and a pre-patched page in `html/`:

`xvg-visualizer`, `outlier-detector`, `curve-fitter`, `error-bar-generator`,
`plot-digitizer`, `latex-tables`, `latex-formatter`, `bibtex-sanitizer`,
`bibtex-deduplicator`, `journal-abbreviator`, `scientific-converter`,
`data-cleaner`, `stats-calculator`, `coordinate-manipulator`.

**Two tools are partially converted**, each via a drop-in adapter carrying its
own application instructions in the file header:

- `script-generator` — `js/script-generator-slurm.js` replaces the `#SBATCH`
  header builder. The remaining ~2,700 lines (the PLUMED collective-variable
  builder and the MDP stage forms) are unchanged.
- `structure-inspector` — `js/structure-inspector-selection.js` replaces the
  selection parser and spatial grid. The remaining ~2,400 lines of 3Dmol
  rendering, measurement, and trajectory playback are unchanged.

Both were split this way deliberately: the extractable logic is the part that
benefits from testing, and rewriting several thousand lines of rendering code
carries a real risk of a subtle visual regression for no gain.

**Three tools are not converted** and have nothing to extract — `pomodoro`,
`sandbox`, and `decision` are UI-only.

**Two tools keep their original scripts** but now have core support available:

- `doi-fetcher` — `parseDoiList` and `filterBibtexFields` are extracted and
  tested in `src/core/bibtex.js`. The rest of that file is network I/O against
  the DOI resolver, with retry and rate-limit handling, which is not usefully
  unit-testable without a mock server.
- `plot-builder` — almost entirely Plotly trace and layout configuration. There
  is no numerical logic worth extracting; converting it would move DOM code
  from one file to another.

## 7. A bug found along the way

`js/latex-formatter.js` in the original repository **does not parse**. An
unclosed `forEach` callback in the theme-toggle handler produces
`SyntaxError: missing ) after argument list`, so the script never ran and the
tool was dead in production. The rewritten file fixes it; the duplicate theme
toggle is removed entirely, since the page's shared inline script already
handles theming and the second handler cancelled it out.

## 7. Behavioural changes to expect

The rewrites are not purely structural. Three fixes change output:

- **Statistics** — skewness, kurtosis, and every D'Agostino normality p-value
  change slightly (the population/sample standard-deviation fix). ANOVA
  p-values that previously displayed as `0` now show their true magnitude.
- **Structure tools** — molecular weights and centres of mass change for
  metalloproteins and any structure with numeric-prefixed hydrogens, because
  element inference was previously wrong for those atoms.
- **Outlier detector** — now reports a Grubbs' test p-value alongside the flag
  count, and explains when the MAD fallback was used.

If you have figures or numbers generated by the old code, they are worth
re-checking against the new output.
