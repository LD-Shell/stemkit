# @stemkit/core

The computational core of [STEMKit](https://stemkit.net), the parsers,
numerical routines, and generators behind its browser tools, extracted into
pure ES modules with no DOM dependency.

Everything here runs identically in a browser and under Node.js, so an
analysis you prototype in the web UI can be re-run headlessly in a script, a
notebook, or a CI pipeline.

## Why a separate core

The browser tools are deliberately zero-install and client-side: your data
never leaves your machine. That is good for privacy but bad for
reproducibility, because a figure produced by clicking is hard to regenerate
six months later. Extracting the computation into an importable library means
the same code path can be scripted, version-pinned, and tested.

## Installation

The repository is a complete, runnable site; `docs/SETUP.md` covers deployment
and the layout in more detail.

```bash
git clone https://github.com/LD-Shell/stemkit.git
cd stemkit
npm install
```

## Quick start

Several modules have no third-party dependency and work immediately:

```js
import { parseXvg, columnStats, extractColumn } from './src/core/index.js';
import { readFileSync } from 'fs';

const result = parseXvg(readFileSync('rmsd.xvg', 'utf8'));
console.log(result.title);        // "RMSD & Radius of Gyration"
console.log(result.headers);      // ["Time (ps)", "Backbone RMSD", "Rg"]
console.log(result.rowCount);     // 10001

const rmsd = extractColumn(result.matrix, 1);
console.log(columnStats(rmsd));   // { n, min, max, mean, std }
```

## Vendored dependencies

Statistics, curve fitting, CSV parsing, and BibTeX handling delegate to four
vendored UMD bundles in `js/dependencies/`. UMD cannot be bound by a plain ES
import, and `createRequire` is a hard resolution failure in a browser, so the
core takes them by **injection** instead: it declares what it needs and each
host supplies it.

**Node.js:**

```js
import { createRequire } from 'module';
import { registerVendor, independentTTest } from './src/core/index.js';

const require = createRequire(import.meta.url);
registerVendor({
  jStat: require('./js/dependencies/jstat.min.js'),
  Papa: require('./js/dependencies/papaparse.min.js'),
  regression: require('./js/dependencies/regression.min.js'),
  bibtexParse: require('./js/dependencies/bibtexParse.min.js')
});

const t = independentTTest(control, treated);
console.log(`t(${t.df.toFixed(2)}) = ${t.t.toFixed(3)}, p = ${t.p.toExponential(3)}`);
```

**Browser**, the `<script>` tags already installed the globals:

```js
import { registerFromGlobals } from './src/core/index.js';
registerFromGlobals();
```

Modules needing no registration: `xvg-parser`, `structure`, `slurm`,
`digitizer`, `latex`, `units`.

## Modules

| Module | Purpose | Needs |
|---|---|---|
| `xvg-parser` | GROMACS/Grace `.xvg` and PLUMED `COLVAR` parsing |, |
| `statistics` | t-tests, ANOVA, correlation, non-parametrics, assumption checks | jStat |
| `outliers` | Z-score, modified Z-score, Tukey IQR, Grubbs' test | jStat |
| `curve-fitting` | Least-squares fitting with goodness-of-fit and adequacy checks | regression.js |
| `structure` | PDB/GRO/XYZ parsing, centre of mass, R<sub>g</sub>, rotations, format conversion |, |
| `slurm` | SLURM batch-script generation for GROMACS and LAMMPS |, |
| `plumed` | PLUMED input generation, version gating, CV validation |, |
| `selection` | Atom selection language, spatial neighbour queries |, |
| `units` | 64 units across 10 categories, CODATA 2018 / SI 2019 |, |
| `data-cleaning` | Tabular cleaning, deduplication, imputation, profiling | Papa Parse |
| `latex` | LaTeX/Markdown table generation and text escaping |, |
| `bibtex` | Parsing, union-find deduplication, field sanitising | bibtex-parse-js |
| `digitizer` | Pixel-to-data mapping for figure digitisation |, |
| `error-bars` | Group summaries, SD/SEM/CI, Holm-corrected pairwise tests | jStat |

## Worked examples

### MD trajectory analysis

```js
import { parseXvg, extractColumn, columnStats } from './src/core/index.js';

const { matrix, headers } = parseXvg(readFileSync('rmsd.xvg', 'utf8'));
headers.slice(1).forEach((name, i) => {
  const s = columnStats(extractColumn(matrix, i + 1));
  console.log(`${name}: ${s.mean.toFixed(4)} ± ${s.std.toFixed(4)} nm`);
});
```

### Structure geometry

```js
import { parsePDB, structureStats, radiusOfGyration } from './src/core/index.js';

const { atoms } = parsePDB(readFileSync('protein.pdb', 'utf8'));
const stats = structureStats(atoms);
console.log(`${stats.nAtoms} atoms, ${stats.nResidues} residues`);
console.log(`MW ${stats.totalMass.toFixed(1)} Da, Rg ${radiusOfGyration(atoms).toFixed(2)} Å`);
```

### HPC submission script

```js
import { generateScript } from './src/core/index.js';

const { script, warnings } = generateScript({
  engine: 'gromacs', jobName: 'prod_md', partition: 'gpu',
  nodes: 1, gpus: 1, cpusPerTask: 16,
  walltime: '24:00:00', memory: '32G',
  modules: ['gcc/11.3', 'cuda/12.1', 'gromacs/2023.3'],
  tpr: 'md.tpr', deffnm: 'md', maxh: 23.5
});

warnings.forEach(w => console.warn(`[${w.level}] ${w.message}`));
writeFileSync('submit.sh', script);
```

### Statistics with assumption checks

```js
import { independentTTest, leveneTest, dagostinoNormality } from './src/core/index.js';

const t = independentTTest(control, treated);          // Welch by default
console.log(`d = ${t.d.toFixed(2)}, 95% CI [${t.ci.map(v => v.toFixed(2))}]`);

console.log(leveneTest([control, treated]).ok ? 'Equal variances tenable' : 'Variances differ');
console.log(dagostinoNormality(control).ok ? 'Normality tenable' : 'Consider Mann–Whitney');
```

## Testing

```bash
npm test                # full suite
npm run test:coverage   # with coverage
```

The suite comprises 1075 tests across all 15 domain modules (`src/core` also holds the aggregate
export and the injection layer, which carry no domain logic). Numerical results are validated against
independent references rather than against the implementation itself:

- **SciPy 1.17.1**, t-tests, ANOVA, Pearson, Mann–Whitney, Wilcoxon, Levene,
  D'Agostino, quantiles, Holm correction
- **NumPy**, `polyfit` coefficients, descriptive statistics
- **`scipy.constants`**, every CODATA conversion factor
- **Physical invariants**, water's molecular weight and centre of mass,
  rotation-matrix orthonormality, distance preservation under rotation,
  round-trip fidelity for every file format

## Numerical notes

Three issues surfaced during extraction that affect published output. All are
fixed here and covered by regression tests.

**Standardised moments.** Skewness and kurtosis are defined against the
*population* standard deviation. Using the sample (n−1) value deflates
skewness by ((n−1)/n)^(3/2) (about 15% at n = 10) and propagates into any
normality test built on it.

**Tail p-values.** Computing an upper tail as `1 - cdf(x)` cancels
catastrophically once the CDF rounds to 1.0 in double precision: an ANOVA
result of p ≈ 3.5 × 10⁻¹⁷ is reported as exactly 0. The complementary
incomplete beta and gamma forms are used instead, preserving full relative
precision. Beyond |z| ≈ 8 the vendored `erfc` underflows, and a documented
asymptotic expansion takes over.

**Element inference.** PDB atom names are ambiguous: `CA` is C-alpha in a
protein and calcium in an ion record. Naïve rules mis-assign heme iron (`FE`
in `HEM`) and selenomethionine selenium, and drop numeric-prefixed hydrogens
(`1HB`, `2HG1`) entirely, giving wrong molecular weights and centres of mass
for metalloproteins. The resolution here is checked against 40 real atom names.

One caveat is inherited rather than fixed: `regression.js` fits exponential,
power, and logarithmic models by **linearisation**, minimising error in log
space rather than the original units, and weights that fit by y. For a clean
doubling series it returns a growth rate of 0.69022 where unweighted log-OLS
gives ln 2 = 0.69315. Neither is wrong, but they answer different questions.
`fitCurve` sets a `linearised` flag so callers can surface it; for
publication-grade nonlinear fits, use Levenberg–Marquardt on untransformed data.

## Citation

If this software contributes to work you publish, please cite the JOSS paper
(see `paper/paper.md`).

## Licence

MIT | see `LICENSE`.
