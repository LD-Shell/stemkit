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

Modules marked none under Needs below work without registration.

Every module is also exported whole, as a namespace (`Stats`, `LammpsInput`,
`GromacsMdp` and so on, 43 in all) and by path (`stemkit-core/lammps-input`).
Names too general to export flat, or used by two modules, are reached that way:
`LammpsInput.parseInput`, `CurveFitting.generateMatplotlibCode`, and
`DataCleaning.columnStats` (population SD; the flat `columnStats` is
xvg-parser's sample SD). A path import skips `node.js`, so it registers
nothing: import `stemkit-core` first, or call `registerVendor`.

## Modules

| Module | Purpose | Needs |
|---|---|---|
| `xvg-parser` | GROMACS/Grace `.xvg` and other numeric tables; the XVG Visualizer's figure and its script | none |
| `statistics` | Descriptives, t-tests, classic and Welch's ANOVA, Pearson and Spearman correlation, non-parametrics, post-hoc comparisons, assumption checks, test choice | jStat |
| `outliers` | Z-score, modified Z-score, Tukey IQR, Grubbs' test | jStat |
| `curve-fitting` | Preset models (linear, polynomial, exponential, power, logarithmic) with goodness-of-fit and adequacy checks | regression.js |
| `expression` | Parsing typed equations (`y = A*exp(-t/tau) + y0`) into a syntax tree: variables and parameters sorted, exact derivatives, LaTeX and text, with no `eval` | none |
| `nonlinear-fit` | Levenberg–Marquardt fitting of any typed equation, with automatic starting values, bounds, fixed parameters, weights, standard errors, confidence intervals and bands; matches `scipy.optimize.curve_fit` | none |
| `fit-python` | The Python script (SciPy `curve_fit` and matplotlib) that repeats a fit and draws its figure | none |
| `plot-style` | One description of a fitted plot's look, shared by the browser preview and the matplotlib script | none |
| `figure` | One description of a figure (panels, lines, points, error bars, bars, histograms, box plots, heatmaps, contours, brackets), shared by the browser preview and the script | none |
| `plot-builder` | The Plot Builder's CSV reading (as Python's `csv` and `float()` read it) and its figure | none |
| `figure-python` | The matplotlib script that draws a figure description, reading the data from the user's files or embedding it | none |
| `pdf` | A PDF writer: vector pages from SVG, or a JPEG page | none |
| `structure` | PDB/GRO/XYZ parsing, centre of mass, R<sub>g</sub>, rotations, format conversion | none |
| `slurm` | SLURM batch-script generation for GROMACS and LAMMPS | none |
| `scheduler` | Directive headers, environment variables and launchers for SLURM, PBS Pro / OpenPBS, LSF and Grid Engine | none |
| `plumed` | PLUMED input generation, version gating, CV validation | none |
| `plumed-catalogue` | The builder's curated actions, fields, starting values and notes | none |
| `plumed-syntax` | PLUMED 2.9, 2.10 and 2.11 keyword tables, generated from PLUMED's own `syntax.json` | none |
| `plumed-parse` | Reading an existing PLUMED input: parse, check, explain, and open it in the builder | none |
| `plumed-atoms` | Atom lists, groups and per-molecule centres from a structure file | none |
| `plumed-analysis` | COLVAR and HILLS reading, hill width and grid suggestions, free-energy surfaces matching `sum_hills`, reweighting | none |
| `plumed-analysis-figures` | The analysis figures (time series, histograms, free-energy surfaces, convergence, hill heights) and the Python that repeats them from the run's files | none |
| `plumed-run` | Run files that start and continue a job: walkers, umbrella windows, restarts | none |
| `zip` | Uncompressed zip archives of text files | none |
| `gromacs-mdp` | Every GROMACS 2025.1 `.mdp` option with its manual text and link; reading, checking as grompp does, explaining and writing `.mdp` files | none |
| `gromacs-ndx` | GROMACS index groups: `make_ndx` defaults, custom groups, tc-grps checks | none |
| `lammps-reference` | Every LAMMPS 29 Aug 2024 command and style: kind, package, accelerated variants, syntax, keywords, defaults, a one-line summary and the manual link; the unit styles | none |
| `lammps-input` | Reading LAMMPS inputs as LAMMPS parses them; checking them as LAMMPS runs them (also a chain of stages through restart files); explaining every line in the input's units | none |
| `lammps-data` | Reading LAMMPS data files: counts, box, types, charges, water model, SHAKE types, suggested groups | none |
| `lammps-workflow` | A whole LAMMPS run: force-field presets, minimise/NVT/NPT/production inputs chained by restart files, the job block that continues after a wall-time stop, README | none |
| `selection` | Atom selection language, spatial neighbour queries | none |
| `units` | 64 units in 10 categories, plus temperature; CODATA 2018 / SI 2019 | none |
| `data-cleaning` | Tabular cleaning, deduplication, imputation, profiling | Papa Parse |
| `data-cleaning-python` | The pandas script that repeats a cleaning recipe, with the same output file | none |
| `latex` | LaTeX/Markdown table generation and text escaping | none |
| `bibtex` | Parsing, union-find deduplication, field sanitising | bibtex-parse-js |
| `digitizer` | Pixel-to-data mapping for figure digitisation; the digitised series' figure and its script | none |
| `journals` | Whole-title journal abbreviation from a dictionary | none |
| `iso4` | ISO 4 word-level abbreviation from the ISSN LTWA | none |
| `error-bars` | Group summaries, SD/SEM/CI, Holm-corrected pairwise tests | jStat |
| `error-bars-figure` | The Error Bar Generator's figure (bars or means with SD, SEM or CI, the replicates, Holm-corrected Welch brackets) and the Python that recomputes and draws it | jStat |
| `statistics-figure` | The Statistics Calculator's figure for each test (box plots with the points and the mean's interval, pair lines, the μ₀ line, scatter with the least-squares line) and the Python that runs the test again and draws it | none |
| `outliers-figure` | The Outlier Detector's figure (the values by row, the flagged ones, the rule's lines) and the Python that flags them again, runs Grubbs' test and draws it | none |

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

The suite comprises 3705 tests across all 42 domain modules (`src/core` also holds the aggregate
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
- **SciPy 1.11.4** `curve_fit` and `scipy.stats.t`, nonlinear fits (weighted,
  with absolute sigma, with a fixed parameter), their standard errors and
  confidence bands, and t quantiles; the generated Python scripts are run and
  their figures inspected with **matplotlib 3.6.3**
- **PLUMED 2.9, 2.10 and 2.11**, every generated input parsed by the real
  program; hill sums checked against `plumed sum_hills`
- **GROMACS 2025**, index files written by `gmx make_ndx` and selections by
  `gmx select`, compared byte for byte; `grompp`'s verdicts on generated and
  broken `.mdp` files
- **LAMMPS 29 Aug 2024**, `read_data` on every data file of the LAMMPS
  examples, every style `lmp -h` lists, the checker's verdict on every example
  input and on broken copies, and the workflow's inputs run stage by stage
- **pandas**, the cleaning scripts run and their output compared with the
  page's, cell by cell
- **`scipy.constants`**, every CODATA conversion factor
- **Physical invariants**, water's molecular weight and centre of mass,
  rotation-matrix orthonormality, distance preservation under rotation,
  round-trip fidelity for every file format

## Numerical notes

Four places where the obvious implementation gives a wrong number, and what
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
for metalloproteins. The resolution here is checked against 25 real atom names.

**Uncertainties of a nonlinear fit.** `fitModel` follows `curve_fit`: the
covariance is (JᵀWJ)⁻¹ scaled by the reduced chi-square, unless the
uncertainties are declared absolute. It uses exact derivatives of the typed
equation where `curve_fit` uses forward differences, so the two agree to
better than 1e-7 in the values and to about 1e-6 in the standard errors and
bands, the size of the forward-difference error. The Student's t quantiles
behind the intervals keep full precision at any number of degrees of
freedom: the plain difference of two log-gammas they need is already off by
about 1e-9 at two million.

One caveat is inherited rather than fixed: `regression.js` fits the
exponential and power models by **linearisation**, minimising error in log
space rather than the original units, and weights the exponential fit by y
(the power fit is unweighted). The logarithmic model is linear in its
parameters and is fitted by ordinary least squares. For the doubling series
(1, 2.0), (2, 4.1), (3, 8.2), (4, 16.1), (5, 32.3) the weighted exponential fit
gives a rate of 0.690216, where unweighted log-space least squares gives
0.693167 (the series was generated from ln 2 = 0.693147). Neither is wrong,
but they answer different questions.
`fitCurve` sets a `linearised` flag so callers can surface it; for
publication-grade nonlinear fits, use `fitModel`, which fits the untransformed
data by Levenberg–Marquardt.

## Citation

Cite the archived release, DOI
[10.5281/zenodo.21543112](https://doi.org/10.5281/zenodo.21543112), which
resolves to the current version. `CITATION.cff` in the repository has the full
metadata.

## Licence

MIT; see `LICENSE`. The four bundled libraries keep their own MIT licences:
`js/dependencies/LICENSES.md`.
