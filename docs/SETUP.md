# Setup

Static site plus a Node library. No build step for the pages; only the Tailwind
utilities are generated.

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

**`file://` does not work.** Fourteen tools load their code as ES modules, which
browsers block outside HTTP. The page renders, every button is dead, and the
console shows a CORS error. Serve over HTTP.

## Test

```bash
npm install
npm test               # 1077 tests, 16 modules
npm run test:coverage  # see docs/COVERAGE.md
node tests/smoke.mjs   # end-to-end against a real install
```

The smoke test catches what unit tests cannot: a broken aggregate export, a
mis-scoped `type` field, a vendored bundle that fails to load. It covers 15 of
16 modules; `iso4` postdates it and has no case yet.

## Layout

```
stemkit/
├── *.html                  18 research tools, 3 workflow utilities,
│                           plus index, privacy and 404
├── src/
│   ├── core/               the library: 16 domain modules, no DOM,
│   │                       plus index.js (barrel) and vendor.js (DI)
│   ├── tools/              per-tool stylesheets, 20 files
│   ├── stemkit-docs.css    shared .stk-* components
│   ├── output.css          generated Tailwind. Do not hand-edit.
│   ├── home.css            landing page
│   └── script-generator.css
├── js/
│   ├── *.js                one script per tool, DOM wiring only
│   ├── *-slurm.js          adapters for partially converted tools
│   │   *-selection.js
│   └── dependencies/       vendored UMD bundles
├── tests/                  Jest suites plus smoke.mjs
├── abbr/                   ISSN LTWA word list for ISO 4
├── docs/                   setup, stylesheets, coverage
├── paper/                  manuscript, LaTeX and Markdown
├── css/, assets/, sound/   fonts, icons, audio
└── package.json            @stemkit/core
```

## Deploy

Static. Copy the directory to any host, or push to GitHub Pages. `CNAME` points
at `stemkit.net`.

Not needed in production, harmless if deployed: `tests/`, `docs/`, `paper/`,
`package.json`, `node_modules/`.

## Gotchas

**`js/dependencies/package.json`** contains one line: `"type": "commonjs"`.

Root `package.json` declares `"type": "module"`, which makes Node parse every
`.js` file below it as an ES module, vendored UMD bundles included. The UMD
factory then takes its browser branch and fails with:

```
Cannot set properties of undefined (setting 'jStat')
```

Delete that file and every Node example in the README breaks on first import.

**`src/output.css`** is generated. Rules added by hand survive until the next
`npm run build:css`. Component styles go in `src/stemkit-docs.css` or
`src/tools/<tool>.css`. See `docs/CSS.md`.

## Conversion state

| State | Count | Notes |
|---|---|---|
| Computation in `src/core/`, styles in `src/tools/` | 14 | fully converted |
| Partially converted via adapters | 2 | `js/*-slurm.js`, `js/*-selection.js` |
| Logic and styles still inline | rest | |

`CONTRIBUTING.md` covers where new code belongs. `CHANGELOG.md` records what
changed, including fixes that alter reported output.
