# Setup

Static site plus a Node library. No build step for the pages. The Tailwind
utilities are generated, and so are a few committed files: `sitemap.xml` and the
GROMACS, PLUMED and LAMMPS reference tables in `src/core/`.

## Serve

```bash
git clone https://github.com/LD-Shell/stemkit.git
cd stemkit
python3 -m http.server 8000
```

Open <http://localhost:8000/>.

- Module name is `http.server`. One word, with a dot. Not `https`.
- Use `python3`. Plain `python` is still Python 2 on many systems.
- Port above 1024, or you need root.

**`file://` does not work.** Seventeen tools load their code as ES modules, which
browsers block outside HTTP. The page renders, every button is dead, and the
console shows a CORS error. Serve over HTTP.

## Test

```bash
npm install
npm test               # 3705 tests, 43 modules
npm run test:coverage  # see docs/COVERAGE.md
node tests/smoke.mjs   # end-to-end against a real install
```

The smoke test catches what unit tests cannot: a broken aggregate export, a
mis-scoped `type` field, a vendored bundle that fails to load. It calls into 28
of the 43 modules; `iso4`, `journals`, `pdf`, `zip`, `lammps-reference`, the
per-page figure modules and the PLUMED modules beyond `plumed` have no case yet.

Node 18 or later. CI (`.github/workflows/ci.yml`) runs `npm test` and the smoke
test on Node 18, 22 and 24, then `npm run check:chrome`, `check:links:internal`
and `check:sitemap`. Some suites also run the real programs when they are
installed (Python, `plumed`, and LAMMPS and GROMACS through `LMP_BIN` and
`GMX_BIN`); without them those tests are skipped.

## Layout

```
stemkit/
├── *.html                  18 research tools, 3 workflow utilities,
│                           plus index, privacy and 404
├── src/
│   ├── core/               the library, no DOM: 43 modules (vendor.js, the
│   │                       DI boundary, is one), index.js (barrel), node.js
│   │                       (Node entry), and the tables the GROMACS, PLUMED
│   │                       and LAMMPS modules read (eight files and
│   │                       plumed-syntax/)
│   ├── tailwind/input.css  design tokens, shared .stk-* components,
│   │                       hand-written rules that survive a rebuild
│   ├── tools/              stylesheets, 25 files: one per tool (20), the
│   │                       shared figure and Python panels (figure.css,
│   │                       python-panel.css, fit-plot.css), and the
│   │                       GROMACS and LAMMPS tabs (gromacs.css, lammps.css)
│   ├── stemkit-docs.css    shared documentation furniture
│   ├── output.css          generated Tailwind. Do not hand-edit.
│   ├── home.css            the footer directory on every page, and the
│   │                       landing page (hm-*)
│   └── script-generator.css
├── js/
│   ├── site.js             shared chrome on every page: theme toggle, menu,
│   │                       the tool finder, next steps, and the tool catalogue
│   ├── *.js                one script per tool, the page's DOM wiring
│   ├── figure-plot.js      the shared plot area, style panel and export
│   │   python-panel.js     (docs/FIGURES.md); the shared Python panel
│   ├── script-generator-*  the MD workflow generator's GROMACS, PLUMED,
│   │                       LAMMPS and scheduler parts; the *-model.js
│   │                       files hold no DOM, so the tests run them in Node
│   ├── structure-inspector-selection.js
│   │                       selection adapter, not yet applied
│   └── dependencies/       vendored UMD bundles
├── tests/                  Jest suites plus smoke.mjs
├── tools/                  build and check scripts behind the npm scripts
├── .github/workflows/      CI: tests on Node 18, 22 and 24, site checks
├── abbr/                   ISSN LTWA word list for ISO 4
├── docs/                   setup, stylesheets, figures, coverage
├── paper/                  manuscript, LaTeX and Markdown
├── css/, assets/, sound/   fonts (Inter and Font Awesome are vendored),
│                           icons, sample files, audio
└── package.json            stemkit-core
```

## Deploy

Static. Copy the directory to any host, or push to GitHub Pages. `CNAME` points
at `stemkit.net`.

Not needed in production, harmless if deployed: `tests/`, `docs/`, `paper/`,
`tools/`, `.github/`, `run-tests.sh`, `package.json`, `node_modules/`.

## Publish the library

```bash
npm pack --dry-run     # lists what ships: src/core, four bundles with their
                       # package.json and LICENSES.md, README, LICENSE
npm publish
```

Bump `version` in `package.json` first; npm never accepts the same version twice.
`npm publish` runs `npm test` and the smoke test first (`prepublishOnly`).

## Gotchas

**`js/dependencies/package.json`** sets `"type": "commonjs"`, with a comment
saying why.

Root `package.json` declares `"type": "module"`, which makes Node parse every
`.js` file below it as an ES module, vendored UMD bundles included. The UMD
factory then takes its browser branch and fails with:

```
Cannot set properties of undefined (setting 'jStat')
```

Delete that file and every Node example in the README breaks on first import.

**`src/output.css`** is generated. Rules added by hand survive until the next
`npm run build:css`. Shared rules go in `src/tailwind/input.css`, documentation
furniture in `src/stemkit-docs.css`, and anything for one page in
`src/tools/<tool>.css`. See `docs/CSS.md`.

**No page loads a stylesheet, font or script from another host.** Inter lives
in `css/fonts/inter/` and is declared in `src/tailwind/input.css`; if a page
ever renders in a system font, the build was not run after that file changed.
The only requests to other hosts are the two the privacy page names, made when
a person asks: DOI to BibTeX asks doi.org, and the Structure Inspector fetches a
PDB entry from RCSB.

## Conversion state

| State | Count | Notes |
|---|---|---|
| Computation in `src/core/`, styles in `src/tools/` | 17 | fully converted; the MD workflow generator takes its job header from `core/scheduler` through `js/script-generator-slurm.js`, its launcher and environment from `core/scheduler` directly, and its GROMACS, PLUMED and LAMMPS tabs from the `gromacs-*`, `plumed-*` and `lammps-*` modules |
| Styles in `src/tools/`, computation still in the page script | 1 | structure inspector (`js/structure-inspector-selection.js` exists but is not applied; its header says why the two parsers do not yet agree) |
| Styles in `src/tools/`, no computation to move | 3 | pomodoro, decision, sandbox |

`CONTRIBUTING.md` covers where new code belongs. `CHANGELOG.md` records what
changed, including fixes that alter reported output.
