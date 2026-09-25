# stemkit-core

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

```bash
npm install stemkit-core
```

Node.js 18 or later. The package has no dependencies: the four libraries some
modules call are bundled with it (see below).

To work on the library, clone the repository, a complete runnable site;
`docs/SETUP.md` covers the layout.

## Quick start

```js
import { parseXvg, columnStats, extractColumn } from 'stemkit-core';
import { readFileSync } from 'node:fs';

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

**Node.js:** importing `stemkit-core` resolves to `node.js`, which registers
all four before anything runs, so there is nothing to set up:

```js
import { independentTTest } from 'stemkit-core';

const t = independentTTest(control, treated);
console.log(`t(${t.df.toFixed(2)}) = ${t.t.toFixed(3)}, p = ${t.p.toExponential(3)}`);
```

`registerVendor({ jStat: ... })` replaces any of them, for example with a
different build.

**Browser**, the `<script>` tags already installed the globals:

```js
import { registerFromGlobals } from './src/core/index.js';
registerFromGlobals();
```

Modules needing no registration: `xvg-parser`, `structure`, `selection`,
`slurm`, `scheduler`, `plumed`, `digitizer`, `latex`, `units`, `journals`,
`iso4`.

## Modules

| Module | Purpose | Needs |
|---|---|---|
| `xvg-parser` | GROMACS/Grace `.xvg` and PLUMED `COLVAR` parsing | none |
| `statistics` | Descriptives, t-tests, classic and Welch's ANOVA, Pearson and Spearman correlation, non-parametrics, post-hoc comparisons, assumption checks, test choice | jStat |
| `outliers` | Z-score, modified Z-score, Tukey IQR, Grubbs' test | jStat |
| `curve-fitting` | Least-squares fitting with goodness-of-fit and adequacy checks | regression.js |
| `structure` | PDB/GRO/XYZ parsing, centre of mass, R<sub>g</sub>, rotations, format conversion | none |
| `slurm` | SLURM batch-script generation for GROMACS and LAMMPS | none |
| `scheduler` | Directive headers, environment variables and launchers for SLURM, PBS Pro / OpenPBS, LSF and Grid Engine | none |
| `plumed` | PLUMED input generation, version gating, CV validation | none |
| `selection` | Atom selection language, spatial neighbour queries | none |
| `units` | 64 units in 10 categories, plus temperature; CODATA 2018 / SI 2019 | none |
| `data-cleaning` | Tabular cleaning, deduplication, imputation, profiling | Papa Parse |
| `latex` | LaTeX/Markdown table generation and text escaping | none |
| `bibtex` | Parsing, union-find deduplication, field sanitising | bibtex-parse-js |
| `digitizer` | Pixel-to-data mapping for figure digitisation | none |
| `journals` | Whole-title journal abbreviation from a dictionary | none |
| `iso4` | ISO 4 word-level abbreviation from the ISSN LTWA | none |
| `error-bars` | Group summaries, SD/SEM/CI, Holm-corrected pairwise tests | jStat |

## Worked examples

### MD trajectory analysis

```js
import { parseXvg, extractColumn, columnStats } from 'stemkit-core';

const { matrix, headers } = parseXvg(readFileSync('rmsd.xvg', 'utf8'));
headers.slice(1).forEach((name, i) => {
  const s = columnStats(extractColumn(matrix, i + 1));
  console.log(`${name}: ${s.mean.toFixed(4)} ± ${s.std.toFixed(4)} nm`);
});
```

### Structure geometry

```js
import { parsePDB, structureStats, radiusOfGyration } from 'stemkit-core';

const { atoms } = parsePDB(readFileSync('protein.pdb', 'utf8'));
const stats = structureStats(atoms);
console.log(`${stats.nAtoms} atoms, ${stats.nResidues} residues`);
console.log(`MW ${stats.totalMass.toFixed(1)} Da, Rg ${radiusOfGyration(atoms).toFixed(2)} Å`);
```

### HPC submission script

```js
import { generateScript } from 'stemkit-core';

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

The same request for another scheduler: `buildHeader` translates the
directives, `launcher` and `envVars` give the matching launch prefix and
variable names, and `submitCommand` says how the file is submitted (`bsub <
submit.sh` for LSF, which reads `#BSUB` lines from standard input only).

```js
import { buildHeader, launcher, submitCommand } from 'stemkit-core';

const { script, warnings } = buildHeader({
  scheduler: 'pbs', engine: 'lammps', jobName: 'melt',
  nodes: 2, tasksPerNode: 16, walltime: '1-12:00:00', memory: '64G'
});
// #PBS -l select=2:ncpus=16:mpiprocs=16:ompthreads=1:mem=64gb
// #PBS -l place=scatter
// #PBS -l walltime=36:00:00
console.log(launcher('pbs'));         // mpirun -np $(wc -l < "$PBS_NODEFILE")
console.log(submitCommand('pbs'));    // qsub submit.sh
```

### Statistics with assumption checks

```js
import { independentTTest, leveneTest, dagostinoNormality } from 'stemkit-core';

const t = independentTTest(control, treated);          // Welch by default
console.log(`d = ${t.d.toFixed(2)}, 95% CI [${t.ci.map(v => v.toFixed(2))}]`);

console.log(leveneTest([control, treated]).ok ? 'Equal variances tenable' : 'Variances differ');
console.log(dagostinoNormality(control).ok ? 'Normality tenable' : 'Consider Mann–Whitney');
```

### Group comparisons, post-hoc tests and choosing a test

```js
import {
  descriptives, recommendTest, welchAnova, gamesHowell,
  kruskalWallis, dunnTest, spearmanCorrelation, oneSampleTTest
} from 'stemkit-core';

const groups = [placebo, low, high];
const names = ['Placebo', 'Low', 'High'];

// One row per group: n, mean, SD, SEM, 95% CI of the mean, median, Q1, Q3, IQR, min, max.
groups.map(g => descriptives(g));

// Advice, not a decision: the test, a one-line reason and the checks behind it.
const { test, reason } = recommendTest({ design: 'independent', groups, names });
// 'welch-anova', "Low looks normal (D'Agostino p = .848); Placebo and High have too few
// values to check (under 8); the variances differ (Levene p = .005), which Welch's ANOVA allows for."

const w = welchAnova(groups);                 // F, df1, df2, p, eta squared
gamesHowell(groups).comparisons               // { i, j, diff, t, df, pAdjusted, ci } per pair

const kw = kruskalWallis(groups);             // tie-corrected H, p, epsilon squared, mean ranks
dunnTest(groups).comparisons                  // { i, j, meanRankDiff, z, p, pAdjusted }, Holm by default

spearmanCorrelation(dose, response);          // rho, p, Bonett-Wright CI
oneSampleTTest(titrations, 0.1);              // against a certified value
```

| Function | Returns | Convention |
|---|---|---|
| `descriptives(a, {conf})` | n, mean, sd, sem, ci, median, q1, q3, iqr, min, max | type 7 quartiles; t interval; NaN spread for n = 1 |
| `boxPlotStats(a, {whisker})` | quartiles, whisker ends, outliers | Tukey: whiskers to the last value within 1.5 IQR |
| `leastSquaresLine(x, y)` | slope, intercept | OLS of y on x |
| `oneSampleTTest(a, mu0, {conf})` | t, df, p, d, ci of the mean and of the difference | two-sided |
| `oneSampleWilcoxon(a, mu0)` | W, z, p, effect r | signed-rank on a − mu0; normal approximation |
| `spearmanCorrelation(x, y, {conf})` | rho, t, p, ci | average ranks for ties; t approximation; Fisher z with the Bonett-Wright variance |
| `kruskalWallis(groups)` | H, df, p, epsilonSquared, meanRanks | tie-corrected; chi-squared approximation |
| `welchAnova(groups)` | F, df1, df2, p, etaSquared | Welch (1951) |
| `tukeyHSD(groups, {conf})` | per pair: diff, q, pAdjusted, ci | Tukey-Kramer; pooled MS, so equal variances |
| `gamesHowell(groups, {conf})` | per pair: diff, t, df, pAdjusted, ci | per-pair SE and Welch df |
| `dunnTest(groups, {adjust})` | per pair: meanRankDiff, z, p, pAdjusted | joint ranks, tie-corrected; Holm by default |
| `adjustPValues(p, method)` | adjusted p-values | 'holm', 'bonferroni' or 'none' |
| `qUpperTail(q, k, df)` | P(Q ≥ q), studentized range | jStat's port of R's ptukey, about 1e-9 absolute |
| `recommendTest({design, groups, names})` | test, reason, normality, levene | rules stated in the source; advice only |

Pairwise results index groups by position (`i < j`), and `diff` is group `i`
minus group `j`. Tukey's and Games-Howell's p-values and intervals are
simultaneous for the whole family, so `pAdjusted` needs no further correction.

## Testing

```bash
npm test                # full suite
npm run test:coverage   # with coverage
```

The suite comprises 1208 tests across all 17 domain modules (`src/core` also holds the aggregate
export, the Node entry and the injection layer, which carry no domain logic). Numerical results are validated against
independent references rather than against the implementation itself:

- **SciPy 1.17.1**, t-tests, ANOVA, Pearson, Mann–Whitney, Wilcoxon, Levene,
  D'Agostino, quantiles
- **SciPy 1.11.4**, one-sample t, one-sample Wilcoxon, Spearman, Kruskal–Wallis,
  the chi-squared and studentized-range tails, Tukey HSD, descriptives; with
  **statsmodels 0.14.1** for Welch's ANOVA and Holm's adjustment and
  **matplotlib 3.6.3** for box-plot whiskers. Games–Howell and Dunn's test,
  which SciPy lacks, are checked against their formulas evaluated with
  `scipy.stats`
- **NumPy**, `polyfit` coefficients, descriptive statistics
- **`scipy.constants`**, every CODATA conversion factor
- **Physical invariants**, water's molecular weight and centre of mass,
  rotation-matrix orthonormality, distance preservation under rotation,
  round-trip fidelity for every file format

## Numerical notes

Three places where the obvious implementation gives a wrong number, and what
the library does instead. Each has a regression test.

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
perturbed doubling series it returns 0.690216 where unweighted log-OLS
gives ln 2 = 0.69315. Neither is wrong, but they answer different questions.
`fitCurve` sets a `linearised` flag so callers can surface it; for
publication-grade nonlinear fits, use Levenberg–Marquardt on untransformed data.

## Citation

Cite the archived release, DOI
[10.5281/zenodo.21543112](https://doi.org/10.5281/zenodo.21543112), which
resolves to the current version. `CITATION.cff` in the repository has the full
metadata.

## Licence

MIT; see `LICENSE`. The four bundled libraries keep their own MIT licences:
`js/dependencies/LICENSES.md`.
