# STEMKit

[![CI](https://github.com/LD-Shell/stemkit/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/LD-Shell/stemkit/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/stemkit-core?label=npm)](https://www.npmjs.com/package/stemkit-core)
[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.21543112.svg)](https://doi.org/10.5281/zenodo.21543112)

Browser tools for computational chemistry, plus `stemkit-core`, the tested
library underneath them.

All computation is client-side. No uploads, no accounts, no install. Tools work
offline once the page loads.

Live: <https://stemkit.net>

## Quick start

Serve the site (static, no build step):

```bash
git clone https://github.com/LD-Shell/stemkit.git
cd stemkit
python3 -m http.server 8000     # then open http://localhost:8000/
```

Opening the HTML files over `file://` will not work. Seventeen tools load ES
modules, which browsers block outside HTTP.

Use the library, from npm (Node 18 or later, no dependencies):

```bash
npm install stemkit-core
```

```js
import { readFileSync } from 'node:fs';
import { parseXvg, extractColumn, columnStats } from 'stemkit-core';

const { matrix } = parseXvg(readFileSync('rmsd.xvg', 'utf8'));
console.log(columnStats(extractColumn(matrix, 1)));
```

Run the tests, from a clone:

```bash
npm install
npm test                        # 4381 tests, 44 modules
node tests/smoke.mjs            # end-to-end against a real install
```

## npm scripts

| Script | Does |
|---|---|
| `npm test` | Jest, 4381 tests |
| `npm run test:coverage` | coverage report (see `docs/COVERAGE.md`) |
| `npm run check:links` | internal and external link check |
| `npm run check:links:internal` | internal only, no network |
| `npm run check:chrome` | shared header, theme script, tool names, footer version and CSP agree across pages |
| `npm run build:csp`, `check:csp` | write or check each page's Content-Security-Policy (run `build:csp` after editing an inline script) |
| `npm run build:css` | rebuild Tailwind after editing `src/tailwind/input.css` |
| `npm run watch:css` | same, on change |
| `npm run build:sitemap` | regenerate `sitemap.xml` from the pages |
| `npm run check:sitemap` | fail if `sitemap.xml` is out of date |
| `npm run check:gromacs`, `check:ndx` | compare the `.mdp` checker and index groups with an installed GROMACS (`GMX_BIN`) |
| `npm run check:plumed` | compare the PLUMED input reader with installed PLUMED versions (`PLUMED_BINS`) |
| `npm run check:lammps`, `check:lammps-data`, `check:lammps-workflow` | compare the LAMMPS input checker, data-file reader and workflow builder with an installed LAMMPS (`LMP_BIN`) |
| `npm run build:lammps-docs` | regenerate the LAMMPS reference tables from a LAMMPS source tree |

## What is here

18 research tools:

| Area | Tools |
|---|---|
| Data and statistics | plot digitiser, data cleaner, statistics calculator, error-bar generator, outlier detector, curve fitter, plot builder |
| Molecular simulation | XVG visualiser, structure inspector, coordinate manipulator, MD workflow generator (GROMACS, LAMMPS, PLUMED) |
| Writing and citations | BibTeX sanitiser, BibTeX deduplicator, DOI to BibTeX, journal abbreviator (ISO 4), visual LaTeX tables, equation formatter |
| Units | scientific converter: energy, length, time, force, pressure, dipole, charge, polarizability, spectroscopy, temperature, heat capacity |

Three further pages are workflow helpers, not research tools, and are not part
of the scholarly contribution: Pomodoro timer, decision matrix, kinetics
sandbox.

`stemkit-core` holds the computation: 42 DOM-free domain modules, plus an
aggregate export (`index.js`), a Node entry (`node.js`), a
dependency-injection layer (`vendor.js`) and the release version
(`version.js`).
API reference in [`src/core/README.md`](src/core/README.md).

## Who it is for

Researchers in computational chemistry and the experimental sciences who need
a correct answer without installing anything or uploading their data: checking
a trajectory, comparing replicates, fitting a model, digitising a figure,
setting up and checking GROMACS, LAMMPS and PLUMED inputs, and preparing
figures, tables and references. Every tool writes, or is backed by, code that
repeats its result, so what was done in the browser can be reproduced.

## Why the computation is a separate library

Client-side tools are good for privacy and bad for reproducibility: a figure
produced by clicking is hard to regenerate six months later. Moving the
computation into an importable library makes the same code path scriptable,
version-pinnable and testable.

## Docs

| File | Covers |
|---|---|
| [`src/core/README.md`](src/core/README.md) | library API |
| [`docs/SETUP.md`](docs/SETUP.md) | layout, deployment, gotchas |
| [`docs/COVERAGE.md`](docs/COVERAGE.md) | reading the coverage report |
| [`docs/CSS.md`](docs/CSS.md) | stylesheets and where rules belong |
| [`docs/FIGURES.md`](docs/FIGURES.md) | the shared plot area and Python script on every plotting page |
| [`CHANGELOG.md`](CHANGELOG.md) | changes, including output-affecting fixes |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | contributing, and where code belongs |
| [`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md) | licences of vendored libraries and of the GROMACS, PLUMED and LAMMPS reference data |
| [`paper/`](paper/) | the JOSS paper (`paper.md`) and the preprint (`preprint.tex`, `preprint.md`, `preprint.pdf`) |

## Contributing and support

Report a bug or ask a question in the
[issue tracker](https://github.com/LD-Shell/stemkit/issues). Contributions are
welcome: [`CONTRIBUTING.md`](CONTRIBUTING.md) explains where code belongs, how
to run the tests and what a pull request should contain, and
[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) applies to every space of the project.

## Citing

```
10.5281/zenodo.21543112
```

Resolves to the current release. Machine-readable metadata in
[`CITATION.cff`](CITATION.cff).

## Licence

MIT, see [`LICENSE`](LICENSE). Vendored libraries under `js/dependencies/` keep
their own licences: [`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md).
