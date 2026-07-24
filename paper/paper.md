---
title: 'STEMKit: A client-side toolkit for computational chemistry and scientific data analysis'
tags:
  - JavaScript
  - computational chemistry
  - molecular dynamics
  - GROMACS
  - PLUMED
  - data analysis
  - reproducibility
  - privacy
authors:
  - name: Olanrewaju M. Daramola
    orcid: 0009-0006-3327-2047
    affiliation: 1
affiliations:
  - name: Independent Researcher
    index: 1
date: 23 July 2026
bibliography: paper.bib
---

# Summary

STEMKit is a collection of 21 browser-based tools for computational chemistry
and scientific data analysis, together with `@stemkit/core`, the dependency-free
JavaScript library that implements their numerical and parsing routines. The
tools cover molecular dynamics trajectory analysis, structure-file manipulation,
statistical testing, curve fitting, figure digitisation, unit conversion, HPC
job-script generation, and reference management.

Every computation runs in the user's own browser. No data is uploaded, no
account is required, and nothing is installed. Because the same code is
importable under Node.js, an analysis explored interactively can be re-run
headlessly, pinned to a version, and placed under continuous integration.

# Statement of need

Routine computational chemistry involves a large amount of small, awkward work
that sits between the major software packages: reading a GROMACS `.xvg` file to
check whether an RMSD has converged, converting a structure from nanometres to
ångström, computing a centre of mass, checking whether a difference between two
sets of replicates is significant, or writing a SLURM script that requests the
right resources. None of this is difficult, but each task carries enough
friction — an environment to configure, a dependency to install, a script to
locate from six months ago — that it is often done by hand, and therefore
inconsistently.

The existing options each impose a cost. Local Python tooling
[@michaud-agrawal2011mdanalysis] is powerful but requires
an environment that not every user can create, particularly on managed
institutional machines. Web services remove the installation barrier but require
uploading data, which is frequently unacceptable for unpublished results or
material under a confidentiality agreement. Graphical desktop applications solve
both problems but are difficult to script and therefore difficult to reproduce.

STEMKit sits between these options: no installation, no data transmission, and
a scriptable core. All computation is client-side JavaScript, so there is no
server to send data to and no privacy policy to trust. The same modules run
under Node.js, which means a workflow prototyped by clicking can be captured as
a script without being rewritten.

# Functionality

## Molecular dynamics utilities

The `xvg-parser` module reads the Grace-format files that GROMACS [@abraham2015]
writes for every analysis tool — RMSD, radius of gyration, hydrogen bonds,
energy terms — recovering the title, axis labels, and per-series legends from
the `@` directives alongside the numeric matrix. The same parser handles PLUMED
[@tribello2014] `COLVAR` output, whose `#!` header lines follow a different
convention but occupy the same comment space. Malformed records are counted and
reported rather than silently dropped, so a truncated trajectory is visible
rather than quietly shortening the analysis.

The `structure` module parses PDB, GROMACS `.gro`, and XYZ coordinate files and
provides centre of mass, radius of gyration, bounding box, Euler rotations, and
conversion between all three formats. Unit handling is explicit throughout: PDB
and XYZ are ångström, `.gro` is nanometre, and every parse result carries its
unit so that conversion is always deliberate.

Element identity is inferred from PDB atom names using a resolution that
distinguishes the alpha carbon `CA` in a protein residue from the calcium ion
`CA`, identifies metals such as heme iron in a host residue, and handles the
numeric-prefixed hydrogen names (`1HB`, `2HG1`) that constitute a substantial
fraction of the atoms in a hydrogen-containing structure. Misassignment here
propagates directly into molecular weight and centre of mass.

## Statistical analysis

The `statistics` module implements Welch's and Student's t-tests, paired t-tests,
one-way ANOVA, Pearson correlation, Mann–Whitney U, and Wilcoxon signed-rank,
each reporting an effect size and, where standard, a confidence interval.
Assumption checks are surfaced rather than assumed: D'Agostino–Pearson K² for
normality [@dagostino1971] and the median-centred Brown–Forsythe variant of
Levene's test for homogeneity of variance [@brown1974], with a non-parametric
alternative suggested when an assumption fails.

Tail probabilities are computed through the complementary incomplete beta and
gamma functions, not as `1 - cdf(x)`. The two forms are algebraically identical.
Numerically they are not: once the CDF rounds to unity in double precision the
subtraction cancels completely, and a strong effect that should report
p ≈ 3 × 10⁻¹⁷ reports exactly zero.

## Workflow tools

Remaining modules cover Tukey and Iglewicz–Hoaglin outlier detection
[@iglewicz1993] with Grubbs' test [@grubbs1969], least-squares curve fitting with
model-adequacy warnings, pixel-to-data digitisation of published figures with
correct logarithmic-axis handling, unit conversion across 64 units in ten
categories using CODATA 2018 values [@tiesinga2021], SLURM script generation for
GROMACS and LAMMPS [@thompson2022], LaTeX and Markdown table generation, and
BibTeX deduplication via union-find over normalised DOIs and titles.

# Implementation and testing

`@stemkit/core` comprises fifteen domain modules with no DOM dependency,
alongside an aggregate export and a dependency-injection layer. Four
third-party libraries — jStat, Papa Parse, regression.js, and bibtex-parse-js —
are vendored as UMD bundles and supplied through a dependency-injection layer,
so the identical core runs in the browser (taking the globals installed by
`<script>` tags) and under Node.js (via `createRequire`) without an
environment branch inside any module.

The suite comprises 975 tests. Numerical results are validated against
independent references rather than against the implementation: SciPy
[@virtanen2020] for the inferential statistics, quantiles, and multiple-comparison
correction; NumPy [@harris2020] for regression coefficients and descriptive
statistics; `scipy.constants` for every conversion factor; and physical
invariants — the molecular weight and centre of mass of water, orthonormality of
rotation matrices, preservation of interatomic distances under rotation, and
round-trip fidelity for each supported file format.

Extraction surfaced several numerical defects in the original implementation
that had affected reported output. Standardised moments were computed against
the sample rather than the population standard deviation, deflating skewness by
approximately 15% at n = 10 and propagating into every normality test built on
it. Upper-tail probabilities underflowed to zero as described above. Element
inference misassigned heme iron and selenomethionine selenium and discarded
numeric-prefixed hydrogens, yielding incorrect masses for metalloproteins. Each
is fixed and covered by a regression test.

One inherited limitation is documented rather than fixed: regression.js fits
exponential, power, and logarithmic models by log-space linearisation with
y-weighting, which is not the maximum-likelihood fit under additive Gaussian
noise. For a clean doubling series it returns a growth rate of 0.69022 where
unweighted log-space least squares gives ln 2 = 0.69315. `fitCurve` exposes a
`linearised` flag so that callers can surface the distinction; users requiring
publication-grade nonlinear fits are directed to Levenberg–Marquardt on
untransformed data.

# Acknowledgements

We thank the maintainers of jStat, Papa Parse, regression.js, Plotly, KaTeX, and
3Dmol.js, whose libraries STEMKit builds upon.

# References
