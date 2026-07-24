# Setup

This archive is the **complete STEMKit site**, not a patch. Unzip it, serve it,
and every tool works.

## Run the site

```bash
cd stemkit
python3 -m http.server 8000
```

Open `http://localhost:8000/` in a browser.

Note the module name: it is `http.server`, one word, with a dot. Not `https`.
Use `python3` explicitly — on many systems plain `python` is still Python 2.
Pick a port above 1024; anything below needs root.

**Opening the HTML files directly will not work.** Fourteen of the tools load
their code as ES modules, and browsers block those under `file://` for security
reasons. The page will render but every button will be dead, with a CORS error
in the browser console and nothing visible on the page itself. Serve over HTTP
and it works.

## Run the tests

```bash
npm install
npm test               # 1075 tests
node tests/smoke.mjs   # 15 end-to-end checks
```

The smoke test exercises one path through every core module against the real
install, which catches problems a unit test cannot: a broken aggregate export,
a misconfigured module type, or a vendored bundle that fails to load.

## Layout

```
stemkit/
├── *.html                  21 tools, plus index, privacy, 404 and 5 previews
├── index.html              landing page
├── src/
│   ├── core/               the tested library — 15 modules, no DOM dependency
│   ├── tools/              per-tool stylesheets, one per tool
│   ├── stemkit-docs.css    shared documentation styles
│   ├── output.css          compiled Tailwind — generated, do not hand-edit
│   ├── home.css            landing-page styles
│   └── script-generator.css
├── js/
│   ├── *.js                one script per tool
│   ├── *-slurm.js          adapters for the partially converted tools
│   │   *-selection.js
│   └── dependencies/       vendored third-party bundles (UMD)
├── tests/                  Jest suites plus the smoke test
├── docs/                   these notes
├── paper/                  JOSS manuscript and ChemRxiv preprint
├── css/, assets/, sound/   fonts, icons, audio
└── package.json            @stemkit/core
```

## Deploying

The site is static. Copy the directory to any web host, or push to GitHub Pages
— `CNAME` already points at `stemkit.net`.

`tests/`, `docs/`, `paper/`, `package.json`, and `node_modules/` are not needed
in production, but they are harmless if deployed.

## Two files that look unimportant and are not

**`js/dependencies/package.json`** contains one line: `"type": "commonjs"`.

The root `package.json` declares `"type": "module"`, which tells Node to parse
every `.js` file beneath it as an ES module — including the vendored UMD
bundles. When that happens the UMD factory takes its browser branch and fails
with `Cannot set properties of undefined (setting 'jStat')`. Without this file
every Node example in the README breaks on the first import.

**`src/output.css`** is compiled Tailwind output. Hand-written rules added there
survive only until the next `npx tailwindcss` run. Component styles belong in
`src/stemkit-docs.css` or `src/tools/<tool>.css`.

## What changed from the original

Fourteen tools have had their logic extracted into `src/core/` and their inline
`<style>` blocks moved into `src/tools/`. Two more are partially converted
through adapters. The rest are untouched. See `docs/INTEGRATION.md` for the
tool-by-tool breakdown and `docs/CSS-REFACTOR.md` for the stylesheet work.

Three fixes change reported output, so figures made with earlier versions are
worth re-checking:

- **Statistics** — skewness, kurtosis and every D'Agostino normality p-value
  shift slightly, because the standardised moments now use the population
  standard deviation as their definition requires. ANOVA p-values that
  previously printed as `0` now show their true magnitude.
- **Structure tools** — molecular weights and centres of mass change for
  metalloproteins and for any structure containing numeric-prefixed hydrogens.
  Element inference was previously wrong for those atoms: haem iron was given
  the mass of fluorine.
- **`latex-formatter`** — this tool did not run at all before. The original
  script had a syntax error and never parsed.

## Reading the coverage report

Two entries in the coverage table look like gaps and are not.

`src/core/index.js` reports 0% statements. It is a re-export barrel with no
logic of its own, so there is nothing for a unit test to execute; what matters
about it is that every name it claims to export actually resolves. That is what
`tests/smoke.mjs` checks, by importing the aggregate and asserting each export
is defined. A unit test would raise the percentage without testing anything
more.

`src/core/vendor.js` reports about 41%. The uncovered lines are the failure
branches of dependency injection: the paths taken when a vendored library is
absent or the wrong shape. They are exercised in the browser only when
something has gone wrong, and covering them fully would mean asserting the
wording of error messages rather than behaviour.

Neither is a coverage gap in the code that computes results. Everything under
`src/core/` that produces a number is covered.
