# Third-party licences

STEMKit runs entirely in the browser and vendors its runtime libraries under
`js/dependencies/` rather than fetching them from a CDN, so that a page works
offline and a given release always pairs with the exact library build it was
tested against.

Each bundle remains under its own licence, reproduced by its upstream project.
None of them is modified; the files are the published distributions.

| Library | Version | Licence | Project |
|---|---|---|---|
| Plotly.js | 2.27.0 | MIT | https://github.com/plotly/plotly.js |
| Chart.js | 4.5.1 | MIT | https://github.com/chartjs/Chart.js |
| KaTeX | 0.16.9 | MIT | https://github.com/KaTeX/KaTeX |
| MathLive | 0.94.8 | MIT | https://github.com/arnog/mathlive |
| Papa Parse | 5.4.1 | MIT | https://github.com/mholt/PapaParse |
| jStat | 1.9.6 | MIT | https://github.com/jstat/jstat |
| regression.js | 2.0.1 | MIT | https://github.com/Tom-Alexander/regression-js |
| 3Dmol.js | not yet pinned | BSD-3-Clause | https://github.com/3dmol/3Dmol.js |
| bibtexParse | not yet pinned | MIT | https://github.com/ORCID/bibtexParse |

**Note on versions.** Five bundles record their version in the file header.
jStat and regression.js do not, but the vendored files are byte-for-byte
identical to the published `dist` builds of 1.9.6 and 2.0.1 respectively, which
pins them exactly.

3Dmol.js and bibtexParse remain unpinned: neither matches the current release,
so both are older builds. The version is left unasserted rather than guessed.
To settle each, compare the checksum against successive published versions:

    npm pack 3dmol@<version> && tar xzf 3dmol-<version>.tgz
    md5sum package/build/3Dmol-min.js js/dependencies/3Dmol-min.js

**Note on licences.** Every licence above is taken from the package's registry
metadata or its repository, not inferred from the code.

## Fonts and icons

| Asset | Licence | Source |
|---|---|---|
| Font Awesome (free tier) | CC BY 4.0 (icons), SIL OFL 1.1 (fonts), MIT (code) | https://fontawesome.com |
| Inter | SIL OFL 1.1 | https://rsms.me/inter/ |
| KaTeX fonts | SIL OFL 1.1 | bundled with KaTeX |

## Data

The ISSN List of Title Word Abbreviations, if present at
`abbr/abbreviation.csv`, is published by the ISSN International Centre under
its own terms and is **not** covered by this project's licence. See
`abbr/README.md`. Standard atomic weights are taken from CIAAW's published
tables and are cited in `src/core/structure.js`.

## STEMKit itself

Everything outside `js/dependencies/` is MIT licensed; see `LICENSE`.
