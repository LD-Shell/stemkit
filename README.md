# STEMKit

Browser-based tools for computational chemistry and scientific data work, plus
the tested library underneath them.

Everything runs client-side. Nothing is uploaded, and every tool works offline
once the page has loaded.

**Live site:** <https://stemkit.net>

## What is here

**18 research tools**, in four areas:

- *Data and statistics* | plot digitiser, data cleaner, statistics calculator,
  error-bar generator, outlier detector, curve fitter, plot builder
- *Molecular simulation* | XVG visualiser, structure inspector, coordinate
  manipulator, MD workflow generator for GROMACS, LAMMPS and PLUMED
- *Writing and citations* | BibTeX sanitiser and deduplicator, DOI to BibTeX,
  journal abbreviator with ISO 4 support, LaTeX table builder, equation editor
- *Units* | scientific converter, across energy, length, pressure, dipole,
  polarizability, spectroscopy and temperature

Alongside them are three workflow helpers that are not research tools and are
not part of the scholarly contribution: a Pomodoro timer, a decision matrix,
and a kinetics sandbox.

**`@stemkit/core`** | the computation behind them, as 18 DOM-free ES modules:
parsing, statistics, molecular geometry, unit conversion, curve fitting, script
generation. Importable and scriptable independently of the pages.
See [`src/core/README.md`](src/core/README.md).

## Why the split

The tools are zero-install and client-side, which is good for privacy and bad
for reproducibility: a figure produced by clicking is hard to regenerate six
months later. Putting the computation in a library means the same code path can
be scripted, version-pinned and tested, and it is what makes the numbers
checkable.

That separation found real defects that had shipped: a wavelength conversion
returning a plausible but wrong number, skewness computed against the wrong
standard deviation, and virtual sites in water inflating a system's mass by two
thirds. Each now has a regression test.

## Running it

The site is static.

```bash
git clone https://github.com/LD-Shell/stemkit.git
cd stemkit
python3 -m http.server 8000
```

For the library and its tests:

```bash
npm install
npm test                       # 1075 tests
npm run test:coverage
npm run check:links            # internal and external links
npm run build:css              # after editing src/tailwind/input.css
```

`docs/SETUP.md` covers deployment and layout.

## Documentation

| | |
|---|---|
| [`src/core/README.md`](src/core/README.md) | the library API |
| [`docs/SETUP.md`](docs/SETUP.md) | deployment and repository layout |
| [`docs/COVERAGE.md`](docs/COVERAGE.md) | how to read the coverage report |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | how to contribute, and where code belongs |
| [`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md) | vendored libraries and their licences |
| [`paper/paper.md`](paper/paper.md) | the JOSS submission |

## Citing

See [`paper/paper.md`](paper/paper.md) and `.zenodo.json`.

## Licence

MIT, see [`LICENSE`](LICENSE). Vendored libraries under `js/dependencies/`
keep their own licences; see
[`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md).
