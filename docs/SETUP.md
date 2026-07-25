# Setup

STEMKit is a static site with a tested JavaScript library underneath it. There
is no build step for the pages; only the Tailwind utilities are generated.

## Run the site

```bash
git clone https://github.com/LD-Shell/stemkit.git
cd stemkit
python3 -m http.server 8000
```

Open `http://localhost:8000/`.

The module name is `http.server` — one word, with a dot, not `https`. Use
`python3` explicitly, since plain `python` is still Python 2 on many systems.
Pick a port above 1024; anything below needs root.

**Opening the HTML files directly does not work.** Fourteen of the tools load
their code as ES modules, and browsers block those under `file://`. The page
renders but every button is dead, with a CORS error in the console and nothing
visible on the page itself. Serving over HTTP fixes it.

## Run the tests

```bash
npm install
npm test               # 1075 tests across 16 modules
npm run test:coverage
node tests/smoke.mjs   # end-to-end checks against a real install
```

The smoke test exercises one path per module against the real install, catching
problems a unit test cannot: a broken aggregate export, a misconfigured module
type, or a vendored bundle that fails to load. It currently covers 15 of the 16
domain modules — `iso4` was split out of `journals` after the smoke test was
written and has no case yet.

`docs/COVERAGE.md` explains the two entries in the coverage table that look like
gaps and are not.

## Layout

```
stemkit/
├── *.html                  21 tools, plus index, privacy and 404
├── src/
│   ├── core/               the tested library — 16 domain modules, no DOM
│   │                       dependency, plus index.js and vendor.js
│   ├── tools/              per-tool stylesheets
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
├── abbr/                   ISSN LTWA word list for ISO 4 abbreviation
├── docs/                   setup, stylesheets, coverage
├── paper/                  SoftwareX manuscript (LaTeX and Markdown)
├── css/, assets/, sound/   fonts, icons, audio
└── package.json            @stemkit/core
```

## Deploying

The site is static. Copy the directory to any web host, or push to GitHub Pages
— `CNAME` already points at `stemkit.net`.

`tests/`, `docs/`, `paper/`, `package.json` and `node_modules/` are not needed in
production, though they are harmless if deployed.

## Two files that look unimportant and are not

**`js/dependencies/package.json`** contains one line: `"type": "commonjs"`.

The root `package.json` declares `"type": "module"`, which tells Node to parse
every `.js` file beneath it as an ES module — including the vendored UMD
bundles. When that happens the UMD factory takes its browser branch and fails
with `Cannot set properties of undefined (setting 'jStat')`. Without this file
every Node example in the README breaks on the first import.

**`src/output.css`** is compiled Tailwind output. Hand-written rules added there
survive only until the next `npm run build:css`. Component styles belong in
`src/stemkit-docs.css` or `src/tools/<tool>.css`; see `docs/CSS.md`.

## Conversion state

Fourteen tools have their computation in `src/core/` and their styles in
`src/tools/`. Two more are partially converted through adapters
(`js/*-slurm.js`, `js/*-selection.js`). The remainder still hold their logic and
styles inline. `CONTRIBUTING.md` describes where new code belongs; `CHANGELOG.md`
records what changed, including the fixes that alter reported output.
