---
# SoftwareX (Original Software Publication) manuscript, Markdown source.
# Structure follows the SoftwareX article template Version 6 (March 2026);
# preprint.tex in this directory is the elsarticle version of the same text.
#
# Convert to the submission .docx with:
#   pandoc paper.md --bibliography=paper.bib --citeproc \
#          --csl=elsevier-with-titles.csl -o paper.docx
title: "STEMKit: A client-side toolkit for computational chemistry and scientific data analysis"
author:
  - name: Olanrewaju M. Daramola
    orcid: 0009-0006-3327-2047
    affiliation: Independent Researcher
    email: lanrelangmuir@gmail.com
    corresponding: true
date: 25 September 2026
keywords:
  - computational chemistry
  - molecular dynamics
  - client-side computation
  - GROMACS
  - reproducibility
  - data privacy
bibliography: paper.bib
---

# STEMKit: A client-side toolkit for computational chemistry and scientific data analysis

**Olanrewaju M. Daramola**
Independent Researcher
ORCID: [0009-0006-3327-2047](https://orcid.org/0009-0006-3327-2047)
Corresponding author: lanrelangmuir@gmail.com

## Abstract

STEMKit is a suite of 18 browser-based tools for computational chemistry and
scientific data analysis, built on `stemkit-core`, a JavaScript library
of parsing and numerical routines with no DOM dependency. All computation runs
inside the user's own browser: the data analysed never leaves it, no account is
required and nothing is installed, so the tools stay usable for unpublished or
confidential data. The same modules run under Node.js, so an interactive
analysis can be captured as a version-pinned script. The 17 domain modules carry
1208 tests validated against SciPy, NumPy, statsmodels
and physical invariants rather than against the implementation itself. That
validation exposed four defects that had been altering reported results, among
them *p*-values floored at zero and the mass of haem iron taken as fluorine's.
All four are corrected and covered by regression tests.

## Keywords

Computational chemistry; molecular dynamics; client-side computation; GROMACS;
reproducibility; data privacy

## Metadata

| Nr | Code metadata description | Metadata |
| --- | --- | --- |
| C1 | Current code version | v0.2.0 |
| C2 | Permanent link to code/repository used for this code version | <https://github.com/LD-Shell/stemkit> ; archived on Zenodo under the concept DOI `10.5281/zenodo.21543112`, which resolves to the current release |
| C3 | Legal code license | MIT License |
| C4 | Code versioning system used | git |
| C5 | Software code languages, tools and services used | JavaScript (ECMAScript 2020 modules), HTML5, CSS3; Node.js; Jest; Tailwind CSS |
| C6 | Compilation requirements, operating environments and dependencies | Browser tools: any current browser supporting ECMAScript modules and the `FileReader` API; no installation and no build step. Library: Node.js ≥ 18; on npm as `stemkit-core`. No runtime dependencies: jStat, Papa Parse, regression.js and bibtex-parse-js are vendored and bundled. `npm install` in a clone adds only the development dependencies (Jest, Tailwind CSS) |
| C7 | If available, link to developer documentation/manual | <https://github.com/LD-Shell/stemkit#readme>; per-module API documentation in `src/core/README.md`; hosted tools at <https://stemkit.net> |
| C8 | Support email for questions | lanrelangmuir@gmail.com (issue tracker: <https://github.com/LD-Shell/stemkit/issues>) |

## 1. Motivation and significance

The software landscape of computational chemistry is well served at its
extremes. Simulation engines such as GROMACS [@abraham2015] and LAMMPS
[@thompson2022] are mature, extensively validated, and actively maintained;
analysis frameworks such as MDAnalysis [@michaud-agrawal2011mdanalysis] provide
comprehensive programmatic access to trajectory data. Between these poles lies a
substantial volume of routine work that neither category serves comfortably.

Consider the interval between completing a simulation and reporting it. A
researcher must inspect the RMSD to confirm equilibration, extract a radius of
gyration, convert a structure between the nanometre convention of GROMACS and
the ångström convention of the Protein Data Bank, compare replicate measurements
statistically, digitise a figure from a paper for comparison, abbreviate journal
titles in a reference list, and compose a scheduler script requesting an
appropriate resource allocation. None of these operations is intellectually
demanding. All of them are error-prone when performed by hand, and all of them
are performed repeatedly.

### 1.1 The friction problem

Three classes of solution exist, and each imposes a characteristic cost.

*Local scripting.* A Python environment with MDAnalysis, NumPy and SciPy
addresses every task listed above and is the correct instrument for sustained
analytical work. Its cost is environmental. Managed institutional workstations
frequently prohibit package installation; conda environments drift; and a script
written six months ago may no longer execute against the current interpreter.
For a researcher whose primary expertise lies in chemistry rather than software
engineering, this cost is not negligible.

*Web services.* Server-side tools eliminate installation entirely but require
data transmission. For unpublished results, material subject to a
confidentiality agreement, or work under embargo, this is frequently prohibited
outright. Even where permitted, the transfer creates a record whose retention
policy the researcher does not control.

*Desktop applications.* Graphical applications avoid both problems but introduce
a third: they are difficult to script. An analysis performed by clicking cannot
readily be re-executed, version-controlled, or subjected to continuous
integration. In practice such an analysis is difficult to reproduce, even when
every step was recorded at the time.

### 1.2 The client-side position

Modern browsers provide a capable computational environment. The `FileReader`
API grants access to local files without transmission, and JavaScript engines are
fast enough for the data volumes involved: under Node.js the parser sustains
roughly 700,000 rows per second, reading a two-million-row, 53 MB `.xvg` in
2.9 s, and parses a million-atom PDB and returns its centre of mass in 1.3 s. The
ceiling is memory rather than arithmetic, since `FileReader` materialises the
whole file as a string; inputs of a few hundred megabytes are practical, and
beyond that a streaming reader would be required. ECMAScript
modules make it possible to organise that code properly, instead of accumulating
scripts.

STEMKit is built around these constraints. No server participates in the
computation, so there is nothing to which data could be transmitted and users
are not asked to take a privacy policy on trust. Two features make a network
request, and only when asked to: the DOI lookup sends the DOIs entered to
doi.org to retrieve their bibliographic records, and the structure inspector can
fetch an entry from the Protein Data Bank by its four-character identifier.
Neither sends a file or a result. Every asset is vendored in the
repository: no content-delivery network, no analytics, no telemetry, so not even
a request log is generated elsewhere, and a local clone runs with the network
disconnected. The reproducibility property
derives from a separate architectural decision: the numerical core is extracted
into modules with no dependency on the browser, so the identical code that
executes behind the interface also executes under Node.js.

### 1.3 Experimental setting

The software is used in two ways, which share one implementation.
Interactively, the user opens a tool page at <https://stemkit.net> (or a local
clone) and selects a local file (a GROMACS `.xvg` series, a PDB or `.gro`
structure, a CSV of replicate measurements) and reads the result in the page.
The file is read through `FileReader`; it is never uploaded. Programmatically,
the same routines are imported from `stemkit-core` in a Node.js script, which
is the path taken once an exploratory analysis is to be fixed, version-pinned
and re-run. The four plotting tools (the XVG visualiser, plot builder, curve
fitter and plot digitiser) additionally emit a standalone matplotlib script that
regenerates the figure from the original data file, so an interactive result can
be reproduced offline without the browser.

Related work is cited where the corresponding functionality is described in
Section 2: GROMACS [@abraham2015] and LAMMPS [@thompson2022] for the trajectory
and job-script formats, PLUMED [@tribello2014] for collective-variable output,
MDAnalysis [@michaud-agrawal2011mdanalysis] as the reference framework for
trajectory analysis, 3Dmol.js [@rego2015], whose atom-selection syntax the
`selection` module mirrors, SciPy [@virtanen2020], NumPy [@harris2020] and
statsmodels [@seabold2010] as the validation references for the numerics, and
the primary statistical literature [@welch1947; @welch1951; @spearman1904;
@kruskal1952; @tukey1949; @kramer1956; @games1976; @dunn1964; @dagostino1973;
@brown1974; @holm1979; @iglewicz1993; @grubbs1969; @bonett2000] for the
implemented tests. Conversion factors follow CODATA 2018
[@tiesinga2021], and the numerical treatment of tail probabilities follows
standard practice for the incomplete beta and gamma functions [@press2007].

## 2. Software description

The 18 research tools are the subject of this paper. Three further browser
utilities (a Pomodoro timer, a decision matrix and a kinetics sandbox) are
distributed from the same repository as general workflow aids; they are not part
of the scholarly contribution and are not described here, though they share the
presentation layer and so appear in the page counts below.

### 2.1 Software architecture

The original implementation followed the pattern common to browser tooling: each
of the 21 tool pages consisted of an HTML document paired with a single JavaScript
file combining event handling, rendering and computation. This arrangement is
expedient during development and progressively obstructive thereafter.
Computational logic entangled with DOM manipulation cannot be tested without a
browser, cannot be reused across tools, and cannot be invoked from a script.

The refactoring applied the *strangler fig* pattern: for each tool, the
mathematical and parsing logic was extracted into a pure module beneath
`src/core/`, a test suite was written against the extracted module, and the
original file was then reduced to DOM wiring that imports the new functions. The
user-visible interface is unchanged; the computation beneath it is now
independently addressable. Figure 1 shows the resulting layering and Table 1
enumerates the modules.

```
┌───────────────────────────────┐   ┌───────────────────────────────┐
│        Browser host           │   │         Node.js host          │
│  21 static HTML/CSS pages     │   │  user analysis scripts        │
│  DOM wiring only;             │   │  1208-test Jest suite;        │
│  FileReader input             │   │  smoke test                   │
│  UMD bundles via <script>     │   │  UMD bundles: createRequire   │
└───────────────┬───────────────┘   └───────────────┬───────────────┘
                │                                   │
                └─────────────────┬─────────────────┘
                                  ▼
        ┌─────────────────────────────────────────────────┐
        │                 stemkit-core                    │
        │  17 DOM-free domain modules, aggregated by      │
        │  src/core/index.js                              │
        └─────────────────────────┬───────────────────────┘
                                  ▼
        ┌─────────────────────────────────────────────────┐
        │            Vendor injection layer               │
        │  registerVendor() · registerFromGlobals()       │
        └─────────────────────────┬───────────────────────┘
                                  ▼
        ┌─────────────────────────────────────────────────┐
        │             Vendored UMD bundles                │
        │  jStat · Papa Parse · regression.js ·           │
        │  bibtex-parse-js                                │
        └─────────────────────────────────────────────────┘
```

**Figure 1.** Architecture of STEMKit. Both hosts execute the identical core
modules; the only environment-specific code is the registration call that
supplies the vendored libraries.

**Table 1.** Modules of `stemkit-core`. Vendored dependencies are supplied by
injection; modules marked *none* operate without any third-party code.

| Module | Domain | Tests | Dependency |
| --- | --- | ---: | --- |
| `statistics` | Inferential and descriptive statistics | 164 | jStat |
| `bibtex` | Reference deduplication, sanitising | 102 | bibtex-parse-js |
| `structure` | Molecular geometry, PDB/GRO/XYZ | 100 | none |
| `curve-fitting` | Least-squares regression | 77 | regression.js |
| `xvg-parser` | GROMACS/PLUMED trajectory data | 77 | none |
| `units` | Physical unit conversion | 73 | none |
| `plumed` | PLUMED input generation | 72 | none |
| `selection` | Atom selection, spatial queries | 67 | none |
| `slurm` | SLURM job scripts, resource checks | 61 | none |
| `latex` | Table generation and escaping | 59 | none |
| `error-bars` | Group summaries, error bars | 57 | jStat |
| `journals` | Whole-title journal abbreviation | 53 | none |
| `data-cleaning` | Tabular transformation | 51 | Papa Parse |
| `outliers` | Anomaly detection | 51 | jStat |
| `scheduler` | Scheduler directives and launchers | 51 | none |
| `digitizer` | Figure digitisation | 49 | none |
| `iso4` | ISO 4 word-level abbreviation (LTWA) | 44 | none |
| **Total** | | **1208** | |

Four third-party libraries are vendored within the repository: jStat for
statistical distributions, Papa Parse for delimited-text parsing, regression.js
for curve fitting, and bibtex-parse-js for reference parsing. Each is
distributed as a Universal Module Definition (UMD) bundle, which detects its
host at run time and either assigns `module.exports` under CommonJS or attaches
a global to `window` in a browser. Neither path is reachable from a plain
ECMAScript module: a UMD file contains no `export` statements, so a direct
import yields no bindings, while `import { createRequire } from 'module'`, the conventional Node.js
workaround, constitutes a hard *resolution* failure in a
browser. A static import resolves before any code executes, so the failure
cannot be caught; the dynamic form `await import()` does reject catchably, but
injection was preferred because the vendored libraries must be available
synchronously. Rather than branch on the execution environment
inside every module, which would render the core untestable in one of its two
targets, the library declares the libraries it requires and each host registers
them at initialisation: under Node.js the package's entry point, in a browser
the page (Section 2.3). Modules request their dependencies lazily,
at the point of use rather than at import time, so importing any module never
fails merely because an unrelated library has not yet been registered.

One consequence merits explicit note, as it is a common failure mode. A
repository declaring `"type": "module"` instructs Node.js to parse every `.js`
file beneath it as an ECMAScript module, including the vendored UMD bundles;
under that interpretation the UMD factory takes its browser branch and fails.
Scoping `"type": "commonjs"` to the dependency directory alone restores correct
behaviour.

The test suite comprises 1208 tests across the 17 domain modules, with 94.5%
statement and 97.9% line coverage of `src/core/`. Its governing
principle is that numerical results are validated against *independent*
references rather than against the implementation under test, since a test
written from the same source as the code confirms only internal consistency.
Reference values were obtained from SciPy [@virtanen2020] for t-tests, ANOVA,
post-hoc comparisons, correlation, non-parametric tests, quantiles and the
studentised range distribution; from statsmodels [@seabold2010] for Welch's
ANOVA and multiple-comparison correction; from NumPy [@harris2020] for
regression coefficients and descriptive statistics;
from `scipy.constants` for every unit conversion factor; and from physical invariants for structural geometry, specifically the
molecular weight and
centre of mass of water, the orthonormality of rotation matrices, the
preservation of interatomic distances under rotation, and round-trip fidelity
through every supported file format. An end-to-end smoke test additionally
exercises one representative path through fifteen of the seventeen modules against
a real installation, detecting the class of failure that unit tests cannot: a broken
aggregate export, a misconfigured module type declaration, or a vendored bundle
that fails to load.

### 2.2 Software functionalities

Table 2 maps each tool to the modules it calls; the subsections below describe
the numerics grouped by domain.

**Table 2.** The 18 research tools and the core modules behind them. Three
further pages (Pomodoro timer, decision matrix, kinetics sandbox) are workflow
aids and are excluded.

| Tool | Module(s) | Purpose |
| --- | --- | --- |
| XVG visualiser | `xvg-parser` | Plot GROMACS/PLUMED series with recovered axis metadata |
| Structure inspector | none (page script) | Geometry, mass breakdown, atom selection and search by residue or species, simulation box, 3D view |
| Coordinate manipulator | `structure` | Translate, rotate, re-box; PDB/GRO/XYZ interconversion |
| MD workflow generator | `slurm`, `scheduler` | Batch scripts for GROMACS and LAMMPS on four schedulers; PLUMED input |
| Statistics calculator | `statistics` | t-tests, one-way and Welch ANOVA with post-hoc comparisons, correlation, non-parametric tests, assumption checks, test recommendation |
| Error-bar generator | `error-bars` | Group summaries, error bars, significance annotation |
| Outlier detector | `outliers` | Tukey fences, modified $Z$-score, Grubbs' test |
| Curve fitter | `curve-fitting` | Least-squares fits with model-adequacy warnings |
| Plot digitiser | `digitizer` | Pixel-to-data recovery with log-axis and uncertainty handling |
| Plot builder | none (page script) | Publication figures at a set print size and resolution, with matplotlib script export |
| Data cleaner | `data-cleaning` | Delimited-text repair, type inference, reshaping |
| Scientific converter | `units` | 64 units in ten categories plus temperature, CODATA-sourced |
| BibTeX sanitiser | `bibtex` | Field normalisation and escaping |
| BibTeX deduplicator | `bibtex` | Union-find over normalised DOIs and titles |
| DOI to BibTeX | `bibtex` | Lookup at doi.org with field filtering |
| Journal abbreviator | `journals`, `iso4` | Whole-title dictionary, then ISO 4 word-level fallback |
| Visual LaTeX tables | `latex` | LaTeX and Markdown tables with correct escaping |
| Equation formatter | `latex` | Formula entry and LaTeX output |

Two tools still compute in their page scripts, the structure inspector and
the plot builder, as does the MD workflow generator's PLUMED form. The
`selection` and `plumed` modules are tested extractions of the inspector's
selection language and of that PLUMED input generation; the pages do not
call them yet.


#### 2.2.1 Trajectory and collective-variable data

GROMACS writes analysis output in the Grace format, in which `@` directives carry
the plot title, axis labels and per-series legends alongside the numeric records.
A parser that skips all non-numeric lines discards precisely the metadata
identifying which column holds which observable; `xvg-parser` recovers it with
the matrix. Malformed records are counted and reported rather than silently
dropped, so a truncated trajectory is visible instead of quietly shortening the
analysis. Two further details of the format are handled
explicitly: the Grace multi-set separator `&` is treated as a delimiter rather
than parsed as data, and records containing `NaN` or `Infinity` are rejected
whole, since one non-finite entry would otherwise contaminate every downstream
statistic.

PLUMED [@tribello2014] writes `COLVAR` files whose `#!` headers follow a
different convention but share Grace's comment character, so the same parser
handles both without modification. An explicit test verifies this rather than
leaving it to assumption.

#### 2.2.2 Structure files and molecular geometry

The `structure` module parses the three coordinate formats in routine use for
classical simulation: PDB and GROMACS `.gro`, both fixed-column, and
whitespace-delimited XYZ. Fixed-column parsing is essential rather than pedantic:
a residue name may legitimately be blank, and a whitespace-splitting parser would
silently shift every subsequent field on that line. Unit handling is explicit
throughout: PDB and XYZ express coordinates in ångström, `.gro` uses nanometres,
and every parse result carries its unit. Silently mixing the two is the most
direct route to a structure that is wrong by a factor of ten.

Assigning an element to each atom is a prerequisite for any mass-weighted
quantity, and PDB atom names are ambiguous by construction: `CA` denotes the
α-carbon in a protein residue and calcium in an ion record. The resolution
implemented here proceeds in five stages.

1. An explicit element column, where present, takes priority.
2. A leading digit is a hydrogen-count prefix (`1HB`, `2HG1`) and is stripped
   before the symbol is read.
3. An unambiguous two-letter metal (`FE`, `ZN`, `SE`) is recognised wherever it
   appears, including within a host residue such as haem or selenomethionine.
4. Otherwise, a two-letter prefix whose second character is uppercase is a PDB
   remoteness indicator, and only the first letter is the element: `CA` in a
   protein residue is Cα.
5. As a final fallback, a two-letter symbol is trusted when the residue shares
   its name, the convention for monatomic ions.

Stages 2 and 3 correct defects present in the original implementation
(Section 2.2.5). The resolution is validated against 40 atom names drawn from
real structures, covering protein backbone and side-chain atoms, nucleic acid
atoms, water, monatomic ions and metal centres. On this basis the module
computes the geometric centroid, the mass-weighted centre of mass, the
axis-aligned bounding box, and the radius of gyration

$$
R_g = \sqrt{\frac{\sum_i m_i \left| \mathbf{r}_i - \mathbf{R} \right|^2}
                 {\sum_i m_i}},
\qquad
\mathbf{R} = \frac{\sum_i m_i \mathbf{r}_i}{\sum_i m_i},
$$

together with rigid-body rotation about an arbitrary pivot using intrinsic
$Z$–$Y$–$X$ Euler angles. Velocities present in a `.gro` file rotate with the
frame but are never translated, so a round trip through rotation and export
preserves the kinetic state.

#### 2.2.3 Statistics, outliers and curve fitting

The `statistics` module implements the one-sample, paired, Welch's
[@welch1947] and Student's t-tests, one-way ANOVA and Welch's ANOVA
[@welch1951], Pearson and Spearman [@spearman1904] correlation, and the
Mann–Whitney $U$, Wilcoxon signed-rank and Kruskal–Wallis [@kruskal1952] tests.
Welch's test is the default for independent samples, as it does not assume equal
variances and loses negligible power when they are in fact equal. Every parametric test reports an effect size and, where
standard, a confidence interval. Assumptions are checked and surfaced rather
than presumed: normality by the D'Agostino–Pearson $K^2$ omnibus test
[@dagostino1973], and homogeneity of variance by the median-centred
Brown–Forsythe variant of Levene's test [@brown1974], chosen for its markedly
greater robustness to non-normality than the original mean-centred formulation.
`recommendTest` turns those checks into advice: from the design (independent,
paired, one-sample or association) and the assumption checks it names the test
to use and states why, and the caller decides whether to follow it. After a test
on three or more groups, pairwise comparisons follow the same logic: Tukey's HSD
in the Tukey–Kramer form for unequal group sizes [@tukey1949; @kramer1956] after
ANOVA, Games–Howell [@games1976] after Welch's ANOVA, and Dunn's rank-sum test
[@dunn1964] with the Holm adjustment [@holm1979] after Kruskal–Wallis. Every
analysis is accompanied by per-group descriptive statistics and a plot of the
data. Table 3 maps each computed quantity to its numerical method and validation
reference.

**Table 3.** Numerical methods and validation references.

| Quantity | Method | Validated against |
| --- | --- | --- |
| Student / Welch $t$, $p$ | Regularised incomplete beta $I_x(a,b)$ | `scipy.stats.ttest_ind` |
| One-sample $t$ | Regularised incomplete beta $I_x(a,b)$ | `scipy.stats.ttest_1samp` |
| Welch–Satterthwaite $\nu$ | Closed form | SciPy, hand calculation |
| One-way ANOVA $F$, $p$ | Sum-of-squares decomposition; $I_x$ tail | `scipy.stats.f_oneway` |
| Welch's ANOVA $F$, $p$ | Precision-weighted means [@welch1951]; $I_x$ tail | statsmodels `anova_oneway` |
| Tukey HSD | Studentised range, Tukey–Kramer standard errors | `scipy.stats.tukey_hsd` |
| Games–Howell | Studentised range, per-pair Welch df | Formula, `scipy.stats.studentized_range` |
| Pearson $r$, CI | Fisher $z$ transform | `scipy.stats.pearsonr` |
| Spearman $\rho$, CI | Pearson on average ranks; Bonett–Wright interval [@bonett2000] | `scipy.stats.spearmanr` |
| Mann–Whitney $U$ | Tie-corrected normal approximation | `scipy.stats.mannwhitneyu` |
| Kruskal–Wallis $H$ | Tie-corrected; $\chi^2$ tail | `scipy.stats.kruskal` |
| Dunn's test | Rank-sum $z$, Holm adjustment | Formula, statsmodels `multipletests` |
| Wilcoxon $W$ | Signed-rank, zeros discarded | `scipy.stats.wilcoxon` |
| D'Agostino–Pearson $K^2$ | $\sqrt{b_1}$ [@dagostino1970] and $b_2$ [@anscombe1983] transforms | `scipy.stats.normaltest` |
| Levene $W$ | Brown–Forsythe (median-centred) | `scipy.stats.levene` |
| Quantiles | Linear interpolation (type 7) | `numpy.percentile` |
| Multiple comparisons | Holm–Bonferroni [@holm1979] | statsmodels `multipletests` |
| Grubbs $G$ | Inverted $t$ critical value | `scipy.stats.t.ppf` |
| Modified $Z$-score | Median/MAD, 0.6745 scaling [@iglewicz1993] | `numpy` |
| Least-squares fitting | Normal equations (regression.js) | `numpy.polyfit` |

Upper-tail probabilities are computed through the complementary form of the
incomplete beta and gamma functions rather than as $1 - F(x)$. The two
expressions are algebraically identical; numerically they are not. Once $F(x)$
rounds to unity in double precision, the subtraction cancels completely and the
result is exactly zero. The consequence is not academic. For the one-way ANOVA
used in the test suite ($F = 377.545$ on 2 and 21 degrees of freedom), the naive
form returns $p = 0$, whereas

$$
p = I_{\frac{d_2}{d_2 + d_1 F}}\!\left(\tfrac{d_2}{2}, \tfrac{d_1}{2}\right)
  = 3.4611747382894255 \times 10^{-17},
$$

reproducing `scipy.stats.f.sf` to full double precision. A continuous test statistic cannot
produce $p = 0$, so that value in published output indicates a numerical fault
rather than an unusually strong effect. The same treatment is applied to the
Student $t$, $\chi^2$ and normal tails; for $\chi^2$ the upper incomplete gamma
function is evaluated directly, by its continued fraction [@press2007], wherever
the subtraction would cancel. Beyond $|z| = 8$ the vendored `erfc`
underflows and a documented asymptotic expansion takes over, accurate to
$3.5 \times 10^{-6}$ relative at the switchover and $1.6 \times 10^{-10}$ by
$z = 30$; at $z = 38$ it returns $5.8 \times 10^{-316}$, where
`2*scipy.stats.norm.sf(38)` has already underflowed. Its own floor lies near
$z = 38.5$, and that bound rather than any general principle is what limits how
small a reported $p$ can be.

One limitation of `curve-fitting` is documented rather than fixed, and it applies
to two of the three transformed models rather than to all of them. The vendored regression.js
library fits the *power* model by regressing $\ln y$ on $\ln x$ unweighted, so
the residuals minimised are those in logarithmic space and small $y$ values
carry more influence than a direct fit would give them. The *exponential* model
also works in log space but weights each point by $y$, which is the standard
correction for log-transform bias and keeps the result closer to a direct
non-linear fit. The *logarithmic* model carries none of this bias: it regresses
$y$ on $\ln x$, so only the predictor is transformed and the residuals
minimised are those in $y$, exactly as for any model linear in its parameters.
Where the bias does apply it is material. On an exactly doubling series the
distinction vanishes, since the log-space residuals are identically zero and
every least-squares variant recovers $\ln 2$; it appears only once the data are
perturbed. For the series (1, 2.0), (2, 4.1), (3, 8.2), (4, 16.1), (5, 32.3) the
weighted fit returns 0.690216 against 0.693167 for unweighted log-space least
squares, with $\ln 2 = 0.693147$ as the generating value: a difference of 0.4% in
the rate constant. Neither value is incorrect,
since they answer different questions, but the gap matters when a rate constant
is reported. `fitCurve` therefore exposes a
`linearised` flag, true for the exponential and power models only, so callers
may surface the distinction; users requiring publication-grade non-linear fits
are directed to Levenberg–Marquardt optimisation on untransformed data. A
dataset containing points a model cannot transform is refused with a message naming the requirement (exponential needs every $y > 0$,
power every $x > 0$ and $y > 0$, logarithmic only $x > 0$) rather than having the
offending points silently dropped.

#### 2.2.4 Digitisation, unit conversion and authoring utilities

Recovering numerical values from a published figure requires a two-point affine
calibration per axis. On a logarithmic axis the interpolation must be performed
in logarithmic space,

$$
v(p) = 10^{\,\log_{10} v_1
        + \dfrac{(p - p_1)\left(\log_{10} v_2 - \log_{10} v_1\right)}{p_2 - p_1}},
$$

because a decade occupies a constant pixel distance there. Treating a
logarithmic axis linearly is the most frequent source of error in figure
digitisation, and it produces values that are plausible rather than obviously
wrong. The module additionally reports the data-space uncertainty corresponding
to a one-pixel positioning error, since the precision of a digitised point is
set by the resolution of the figure and not by the number of decimal places the
export happens to print.

Sixty-four units across ten categories are supported, each defined by its ratio
to a category base unit, so conversion reduces to
$x_{\mathrm{to}} = x_{\mathrm{from}} \cdot f_{\mathrm{to}} / f_{\mathrm{from}}$.
This keeps the table linear rather than quadratic in the number of units and
renders every entry independently checkable against its cited source; factors
are CODATA 2018 values [@tiesinga2021], validated against `scipy.constants` from
SciPy 1.17.1, which ships the 2022 adjustment; the two agree to a relative
$10^{-10}$, far below the tolerance of any conversion the tools perform. Temperature is handled separately, since the Celsius and
Fahrenheit scales are affine rather than multiplicative.

Composing a scheduler script correctly requires knowledge that is
engine-specific and easily misapplied, and two aspects dominate the resulting
waste of allocation. First, the resource model differs by engine: GROMACS is
threaded and requires one MPI rank per node with many CPUs per task, whereas
LAMMPS [@thompson2022] is MPI-parallel and requires many ranks per node.
Emitting the wrong shape either idles most of a node or oversubscribes it.

Second, and less widely appreciated, the SLURM `--mem` directive in an array job
specifies memory *per task*, not per job: a request of 32 GB across a
hundred-task array asks the scheduler for 3.2 TB concurrently. The generator
computes the true in-flight total and reports it. Generated scripts include
checkpoint-resume logic, so a requeued job continues from its last checkpoint
rather than silently restarting from $t = 0$, a failure mode that consumes an
entire allocation while appearing to succeed. Warnings are returned as
structured objects rather than formatted strings, leaving presentation to the
caller.

A single resource request is emitted for any of four schedulers, SLURM, PBS
Professional/OpenPBS, LSF and Grid Engine, because the same allocation is
expressed by different directives, environment variables and launch commands on
each; values that are site-dependent, among them the queue name, the name of
the parallel environment and the resource under which GPUs are requested, are
marked as such in the generated script rather than guessed.

The remaining modules support manuscript preparation: LaTeX and Markdown
table generation with correct escaping, ISO-4 journal title abbreviation, and
BibTeX deduplication by union-find over normalised DOIs and titles.

#### 2.2.5 Defects exposed by extraction

Separating computation from presentation subjected the numerical code to
independent verification for the first time, and four defects were identified
that had propagated into reported output. First, skewness and kurtosis are
defined against the *population* standard deviation,

$$
G_1 = \frac{\sqrt{n(n-1)}}{n-2}
      \cdot \frac{1}{n}\sum_{i=1}^{n}
      \left(\frac{x_i - \bar{x}}{\sigma_{\mathrm{pop}}}\right)^{\!3},
\qquad
\sigma_{\mathrm{pop}} = \sqrt{\frac{1}{n}\sum_i (x_i - \bar{x})^2},
$$

whereas the original implementation used the Bessel-corrected sample standard
deviation, deflating skewness by a factor of $\left((n-1)/n\right)^{3/2}$,
approximately 15% at $n = 10$. Because both moments feed the D'Agostino–Pearson
statistic, every normality $p$-value the tool reported was affected. Second, all
upper-tail probabilities were computed by subtraction and floored at zero for
strong effects. Third, haem iron was assigned the mass of fluorine (18.998 Da
rather than 55.845 Da), selenomethionine selenium the mass of sulfur, and
numeric-prefixed hydrogens no mass at all, so molecular weights and centres of
mass computed for metalloproteins were correspondingly wrong. Fourth, the
D'Agostino–Pearson transformations are defined on the biased moment ratios
$\sqrt{b_1} = m_3/m_2^{3/2}$ and $b_2 = m_4/m_2^2$, but the sample-size-adjusted
$G_1$ above was passed into the skewness transform instead. The adjustment
inflates $\sqrt{b_1}$ by exactly $\sqrt{n(n-1)}/(n-2)$: a factor of 1.247 at
$n = 8$, 1.186 at $n = 10$ and 1.039 at $n = 40$. The error therefore vanishes
on symmetric data and grows with skew. Because that factor exceeds unity for
every $n$, the inflated statistic is always the larger and the reported $p$
always the smaller, so the bias is systematically anti-conservative rather than
merely noisy: the verdict at $\alpha = 0.05$ can only ever move from retaining
normality to rejecting it, which is precisely the branch that redirects a user
from Welch's test to Mann-Whitney. This defect is instructive because an
independent reference was already in place and already disagreed: the
discrepancy had been absorbed by loosening the assertion to three decimal places
and attributing the residual to a difference in SciPy's kurtosis transform; that
transform is identical, and the fixture was nearly symmetric ($g_1 = -0.0063$),
so the inflation multiplied approximately zero. The reference was correct and
the implementation was not. $K^2$ now agrees with SciPy to twelve significant
figures across $8 \leq n \leq 1000$, the full range over which the $S_U$
approximation is tabulated [@dagostino1973] and the provenance of the module's
$n \geq 8$ guard, while `skewness()` continues to report $G_1$, which is the
right statistic to publish and matches `scipy.stats.skew(bias=False)`.

Each defect is
corrected and covered by a regression test. Users who generated figures with
earlier versions of these tools should re-check any reported skewness, normality
$p$-value, or metalloprotein mass.

### 2.3 Sample code snippets analysis

Listing 1 contains the whole of the environment-specific code
in the library. The package's Node.js entry point registers the vendored
bundles, and a browser page registers the globals its script tags installed;
after that the identical modules run unchanged in both, and a script needs no
registration of its own.

```javascript
// Node.js: src/core/node.js, the package entry
// under Node, loads the bundles.
import { createRequire } from 'node:module';
import { registerVendor } from './vendor.js';

const require = createRequire(import.meta.url);
const dep = (f) => require('../../js/dependencies/' + f);
registerVendor({
  jStat: dep('jstat.min.js'),
  Papa: dep('papaparse.min.js'),
  regression: dep('regression.min.js'),
  bibtexParse: dep('bibtexParse.min.js')
});
export * from './index.js';

// Browser: the <script> tags set the globals.
import { registerFromGlobals } from './src/core/index.js';
registerFromGlobals();
```

**Listing 1.** Registration of the vendored libraries by the Node.js entry
point and in the browser.

## 3. Illustrative examples

The example below is the post-simulation triage that motivated the toolkit:
confirm that a production run has equilibrated, characterise the final
structure, test a replicate comparison and queue a continuation. Every step is
available interactively as a tool page; the scripted form is shown because it is
the reproducible one.

Listing 2 reads a GROMACS RMSD series. The parser returns the numeric matrix
together with the title and per-series legends recovered from the `@`
directives, so each column is reported under its own observable name rather than
by index.

```javascript
import { parseXvg, extractColumn, columnStats } from 'stemkit-core';
import { readFileSync } from 'fs';

const { matrix, headers, title } = parseXvg(readFileSync('rmsd.xvg', 'utf8'));
// title   -> "RMSD & Radius of Gyration"
// headers -> ["Time (ps)", "Backbone RMSD", "Rg"]

headers.slice(1).forEach((name, i) => {
  const s = columnStats(extractColumn(matrix, i + 1));
  console.log(`${name}: ${s.mean.toFixed(4)} +/- ${s.std.toFixed(4)} nm`);
});
```

**Listing 2.** Parsing a GROMACS RMSD trajectory and summarising each series.

Listing 3 takes the final coordinates and computes the mass-weighted centre of
mass and radius of gyration. Because the input is a `.gro` file its coordinates
are in nanometres, and the conversion to ångström is requested explicitly rather
than assumed.

```javascript
import { parseStructure, centreOfMass, radiusOfGyration, convert }
  from 'stemkit-core';

const frame = parseStructure(readFileSync('final.gro', 'utf8'), 'gro');
const com = centreOfMass(frame.atoms);   // {x, y, z} in nm, and the total mass
const rg  = radiusOfGyration(frame.atoms); // nm, mass-weighted about the COM

console.log(`Rg = ${convert(rg, 'length', 'nm', 'angstrom').toFixed(2)} A`);
```

**Listing 3.** Geometry of the final frame, with an explicit unit conversion.

Listing 4 compares two sets of replicate measurements. `recommendTest` runs the
assumption checks before any test and names the one they point to, with its
reason, so a violated assumption is visible at the point of use rather than
discovered later; here a failed normality check in one group points to
Mann–Whitney. The recommendation is advice, and the caller runs the test.

```javascript
import { recommendTest, independentTTest, mannWhitneyU } from 'stemkit-core';

const advice = recommendTest({ design: 'independent',
                               groups: [wildType, mutant],
                               names: ['wild type', 'mutant'] });
console.log(advice.reason);   // why this test, e.g. which group is not normal

const r = advice.test === 'mann-whitney'
  ? mannWhitneyU(wildType, mutant)        // r.U, r.p, r.rankBiserial
  : independentTTest(wildType, mutant);   // Welch: r.t, r.df, r.p, r.g, r.ci
```

**Listing 4.** A replicate comparison guided by the assumption checks.

Finally, Listing 5 generates the submission script for the continuation run. The
engine argument selects the GROMACS resource shape (one rank per node, many CPUs per task) and
the returned warnings report the true in-flight memory total
for the array as well as any request the scheduler is likely to reject.

```javascript
import { generateScript } from 'stemkit-core';

const { script, warnings } = generateScript({
  engine: 'gromacs', jobName: 'prod_md', partition: 'gpu',
  nodes: 1, gpus: 1, cpusPerTask: 16,
  walltime: '24:00:00', memory: '32G',
  modules: ['gcc/11.3', 'cuda/12.1', 'gromacs/2023.3'],
  tpr: 'md.tpr', deffnm: 'md', maxh: 23.5
});

warnings.forEach(w => console.warn(`[${w.level}] ${w.message}`));
```

**Listing 5.** Generating a GROMACS submission script with resource warnings.

The same four steps through the browser produce identical numbers, since they
call the same functions. The plotting steps also emit a matplotlib script that
regenerates the figure from the original data.

## 4. Impact

The architecture's most direct effect is on work that server-based tools cannot
do at all. Where upload is prohibited, the relevant comparison is not with a
faster tool but with doing the calculation by hand.

For research questions already being pursued, the improvement is in
reproducibility and in the reliability of the numbers. Extracting the
computation into modules that run unchanged under Node.js means that an analysis
first explored by clicking can be captured as a script, version-pinned and
placed under continuous integration without being rewritten in another language, which is the step at which
reproducibility is most often lost. The emitted matplotlib
scripts close the same loop for figures. Independently of that, the validation
strategy raises the floor: every reported statistic is checked against SciPy,
NumPy or statsmodels rather than against the author's own expectations, and the test suite is
intended to be run by users evaluating the software, not solely by its
maintainer, since a library whose numerical claims cannot be checked by its
users offers reproducibility only in principle.

The defects found during extraction (Section 2.2.5) carry a wider lesson, and
are the most useful outcome of this work. All four had survived in software
that ran without error and produced plausible numbers. Three would not have
been caught by testing the code against expectations derived from the same
source; each surfaced only when results were compared with an independent
implementation. The fourth is the more uncomfortable case, because the
independent comparison had already been made and had already disagreed: the
tolerance was widened until the test passed and the residual was explained
away. An independent reference is necessary but not sufficient. A disagreement
with one must be treated as a defect until shown otherwise, and a loosened
tolerance is where that demonstration usually fails to happen. A 15% error in a
reported skewness is not visible by inspection,
and neither is a $p$-value floored at zero, which looks like a very strong
result. Authors of scientific software, particularly of the small,
in-house analysis code that is rarely reviewed, would be well advised to check their
numerics against an independent implementation before reporting output.

In daily practice, the change is the removal of a setup step from tasks that
previously carried one. Checking whether an RMSD has converged, or whether a
replicate difference survives an assumption check, becomes an operation
performed at the moment the question arises rather than one deferred until an
environment is available. The tools are also usable in teaching and in shared
computing environments where installation is not an option, since a URL is the
only prerequisite.

STEMKit is released under the MIT licence, hosted at <https://stemkit.net>,
developed in the open at <https://github.com/LD-Shell/stemkit> and archived on
Zenodo with the persistent identifier
[10.5281/zenodo.21543112](https://doi.org/10.5281/zenodo.21543112) [@stemkit2026], which resolves to the
current release. The software was first archived in July 2026 and published on
npm with version 0.2.0, so adoption data (downloads, unique users, citing
publications) does not yet exist. The arguments above are accordingly claims about what the
design makes possible, not evidence of uptake, and should be read as such. The
software is not used in a commercial setting and has not led to a spin-off
company; the client-side design does, however, make it directly applicable to
industrial research groups whose data-handling policies preclude uploading
results to a third-party service.

## 5. Conclusions

STEMKit is a suite of 18 browser-based tools for computational chemistry built on
a tested, dependency-injected JavaScript core of 17 modules. The architecture
addresses three constraints simultaneously that existing tooling addresses only
in pairs: it requires no installation, transmits no data and remains scriptable.

Both properties are structural rather than contractual: computation occurs
entirely within the browser, and the modules behind the interface are the ones
that run under Node.js. The 1208-test suite validates every numerical result
against an independent reference, and the four defects that this
strategy exposed (deflated standardised moments, tail probabilities floored at
zero, misassigned elements in metalloproteins, and an adjusted moment fed into a
transform defined on the unadjusted one) are documented, corrected and covered by
regression tests. Future work will extend format
coverage in the trajectory and structure modules and replace the two log-space
fits with a Levenberg–Marquardt implementation on untransformed data.

## Declaration of generative AI use

Claude (Anthropic) was used in preparing this manuscript (restructuring an
earlier draft into the present template, correcting reported figures against the
test suite, drafting and revising prose, and reviewing the numerical claims) and
in developing the software, including the browser interface and several of the
statistical routines added in version 0.2.0. Every numerical routine is validated
against an independent reference as described in Section 2.1. The author takes
full responsibility for the software and for the content of this manuscript. The
tool is not an author and bears no responsibility for the content.

## Acknowledgements

I thank the maintainers of jStat, Papa Parse, regression.js, Plotly, KaTeX and
3Dmol.js, whose libraries STEMKit builds upon.

## Declaration of competing interest

The author declares no competing financial or non-financial interests.

## References

<!-- Rendered by pandoc --citeproc from paper.bib. SoftwareX numbers references
     in order of first appearance, so a numeric CSL style (for example
     elsevier-with-titles.csl) renders in-text citations as [1], [2], ... -->
