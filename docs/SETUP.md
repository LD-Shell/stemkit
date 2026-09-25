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

**`file://` does not work.** Sixteen tools load their code as ES modules, which
browsers block outside HTTP. The page renders, every button is dead, and the
console shows a CORS error. Serve over HTTP.

## Test

```bash
npm install
npm test               # 1208 tests, 17 modules
npm run test:coverage  # see docs/COVERAGE.md
node tests/smoke.mjs   # end-to-end against a real install
```

The smoke test catches what unit tests cannot: a broken aggregate export, a
mis-scoped `type` field, a vendored bundle that fails to load. It calls into 15
of the 17 modules; `iso4` and `journals` have no case yet.

## Layout

```
stemkit/
├── *.html                  18 research tools, 3 workflow utilities,
│                           plus index, privacy and 404
├── src/
│   ├── core/               the library: 17 domain modules, no DOM,
│   │                       plus index.js (barrel), node.js (Node entry)
│   │                       and vendor.js (DI)
│   ├── tailwind/input.css  design tokens, shared .stk-* components,
│   │                       hand-written rules that survive a rebuild
│   ├── tools/              per-tool stylesheets, 20 files
│   ├── stemkit-docs.css    shared documentation furniture
│   ├── output.css          generated Tailwind. Do not hand-edit.
│   ├── home.css            landing page
│   └── script-generator.css
├── js/
│   ├── site.js             shared chrome on every page: theme toggle, menu,
│   │                       the tool finder, next steps, and the tool catalogue
│   ├── *.js                one script per tool, DOM wiring only
│   ├── *-slurm.js          adapters for partially converted tools
│   │   *-selection.js
│   └── dependencies/       vendored UMD bundles
├── tests/                  Jest suites plus smoke.mjs
├── abbr/                   ISSN LTWA word list for ISO 4
├── docs/                   setup, stylesheets, coverage
├── paper/                  manuscript, LaTeX and Markdown
├── css/, assets/, sound/   fonts (Inter and Font Awesome are vendored),
│                           icons, sample structures, audio
└── package.json            stemkit-core
```

## Deploy

Static. Copy the directory to any host, or push to GitHub Pages. `CNAME` points
at `stemkit.net`.

Not needed in production, harmless if deployed: `tests/`, `docs/`, `paper/`,
`package.json`, `node_modules/`.

## Publish the library

```bash
npm pack --dry-run     # lists what ships: src/core, four bundles, README, LICENSE
npm publish
```

Bump `version` in `package.json` first; npm never accepts the same version twice.

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
`npm run build:css`. Shared rules go in `src/tailwind/input.css`, documentation
furniture in `src/stemkit-docs.css`, and anything for one page in
`src/tools/<tool>.css`. See `docs/CSS.md`.

**No page fetches anything from another host.** Inter lives in
`css/fonts/inter/` and is declared in `src/tailwind/input.css`; if a page ever
renders in a system font, the build was not run after that file changed.

## Conversion state

| State | Count | Notes |
|---|---|---|
| Computation in `src/core/`, styles in `src/tools/` | 16 | fully converted; the script generator's header, launcher and environment come from `core/slurm` and `core/scheduler` through `js/script-generator-slurm.js` |
| Styles in `src/tools/`, computation still in the page script | 2 | structure inspector (`js/structure-inspector-selection.js` exists but is not applied; its header says why the two parsers do not yet agree) and plot builder |
| Styles in `src/tools/`, no computation to move | 3 | pomodoro, decision, sandbox |

`CONTRIBUTING.md` covers where new code belongs. `CHANGELOG.md` records what
changed, including fixes that alter reported output.
