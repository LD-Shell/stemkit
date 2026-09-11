# STEMKit

[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.21543112.svg)](https://doi.org/10.5281/zenodo.21543112)

Browser tools for computational chemistry, plus `@stemkit/core`, the tested
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

Opening the HTML files over `file://` will not work. Fourteen tools load ES
modules, which browsers block outside HTTP.

Use the library:

```bash
npm install
npm test                        # 1128 tests, 17 modules
node tests/smoke.mjs            # end-to-end against a real install
```

```js
import { parseXvg, columnStats } from '@stemkit/core';

const { matrix, headers } = parseXvg(readFileSync('rmsd.xvg', 'utf8'));
console.log(columnStats(matrix.map(r => r[1])));
```

## npm scripts

| Script | Does |
|---|---|
| `npm test` | Jest, 1128 tests |
| `npm run test:coverage` | coverage report (see `docs/COVERAGE.md`) |
| `npm run check:links` | internal and external link check |
| `npm run check:links:internal` | internal only, no network |
| `npm run build:css` | rebuild Tailwind after editing `src/tailwind/input.css` |
| `npm run watch:css` | same, on change |

## What is here

18 research tools:

| Area | Tools |
|---|---|
| Data and statistics | plot digitiser, data cleaner, statistics calculator, error-bar generator, outlier detector, curve fitter, plot builder |
| Molecular simulation | XVG visualiser, structure inspector, coordinate manipulator, MD workflow generator (GROMACS, LAMMPS, PLUMED) |
| Writing and citations | BibTeX sanitiser, BibTeX deduplicator, DOI to BibTeX, journal abbreviator (ISO 4), LaTeX table builder, equation editor |
| Units | scientific converter: energy, length, pressure, dipole, polarizability, spectroscopy, temperature |

Three further pages are workflow helpers, not research tools, and are not part
of the scholarly contribution: Pomodoro timer, decision matrix, kinetics
sandbox.

`@stemkit/core` holds the computation: 17 DOM-free domain modules, plus an
aggregate export (`index.js`) and a dependency-injection layer (`vendor.js`).
API reference in [`src/core/README.md`](src/core/README.md).

## Why the computation is a separate library

Client-side tools are good for privacy and bad for reproducibility: a figure
produced by clicking is hard to regenerate six months later. Moving the
computation into an importable library makes the same code path scriptable,
version-pinnable and testable.

It also surfaced defects that had shipped:

- wavelength conversion returned a plausible but wrong number
- skewness used the sample, not population, standard deviation
- virtual sites in water inflated system mass by 67%
- adjusted G1 fed into the D'Agostino-Pearson transform, 21% error in K2 at n = 10

Each now has a regression test. Full list in [`CHANGELOG.md`](CHANGELOG.md).

## Docs

| File | Covers |
|---|---|
| [`src/core/README.md`](src/core/README.md) | library API |
| [`docs/SETUP.md`](docs/SETUP.md) | layout, deployment, gotchas |
| [`docs/COVERAGE.md`](docs/COVERAGE.md) | reading the coverage report |
| [`docs/CSS.md`](docs/CSS.md) | stylesheets and where rules belong |
| [`CHANGELOG.md`](CHANGELOG.md) | changes, including output-affecting fixes |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | contributing, and where code belongs |
| [`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md) | vendored library licences |
| [`paper/`](paper/) | manuscript, LaTeX and Markdown |

## Citing

```
10.5281/zenodo.21543112
```

Resolves to the current release. Machine-readable metadata in
[`CITATION.cff`](CITATION.cff).

## Licence

MIT, see [`LICENSE`](LICENSE). Vendored libraries under `js/dependencies/` keep
their own licences: [`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md).
