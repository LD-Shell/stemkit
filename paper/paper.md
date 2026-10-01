---
title: 'STEMKit: browser tools and a tested JavaScript library for computational chemistry'
tags:
  - JavaScript
  - computational chemistry
  - molecular dynamics
  - GROMACS
  - LAMMPS
  - PLUMED
  - statistics
  - reproducibility
authors:
  - name: Olanrewaju M. Daramola
    orcid: 0009-0006-3327-2047
    affiliation: 1
affiliations:
  - name: Independent Researcher
    index: 1
date: 4 October 2026
bibliography: paper.bib
---

# Summary

STEMKit is a set of 18 research tools that run in a web browser, together with
`stemkit-core`, the JavaScript library that does their computation. The tools
cover the routine work around molecular simulation and data analysis: reading
GROMACS and PLUMED output, inspecting and transforming structures, writing and
checking GROMACS, LAMMPS and PLUMED inputs and job scripts, statistics with
assumption checks, fitting any typed equation, building figures, cleaning
tabular data, and preparing references and tables. Every computation runs on
the user's machine: files are read locally and never uploaded. The same library
runs under Node.js, and the plotting and data tools write the Python script
(NumPy, SciPy, matplotlib or pandas) that repeats what was done on the page, so
an interactive result can be reproduced, version-pinned and placed under
version control.

# Statement of need

Much of a computational chemist's time is spent between the simulation engine
and the paper: checking that a trajectory has equilibrated, comparing
replicates, digitising a published figure, setting up and checking the inputs
for the next run, and formatting the results. Python environments serve this
well for researchers who script, but they must be installed and maintained, and
managed workstations often forbid both. Web services remove the installation but
require uploading data that may be unpublished, embargoed or confidential.
Desktop programs avoid both problems but are hard to script, so their results
are hard to reproduce.

STEMKit is for the researcher who needs a correct answer without installing
anything and without sending data elsewhere, and who still wants the result to
be reproducible. Its simulation set-up tools serve two groups: those learning
GROMACS [@abraham2015], LAMMPS [@thompson2022] or PLUMED [@tribello2014;
@plumed2019], who need to know what each setting does and why, and experienced
users who want an input checked before a queued job fails on it.

# State of the field

MDAnalysis [@michaud-agrawal2011mdanalysis] and MDTraj [@mcgibbon2015mdtraj]
provide programmatic trajectory analysis in Python. CHARMM-GUI
[@jo2008charmmgui] builds simulation inputs through a web service, which
requires uploading the structure. WebPlotDigitizer [@rohatgi_webplotdigitizer]
digitises figures in the browser. The simulation programs check their own
inputs, but only where they are installed, and their messages assume
familiarity with the program. General statistics and plotting are well served
by SciPy [@virtanen2020], statsmodels [@seabold2010], pandas [@mckinney2010]
and matplotlib [@hunter2007].

STEMKit does not replace these. It brings the checks the simulation programs
make, an explanation of every setting with a link to the program's manual, and
validated statistics, fitting and plotting into one application that needs
nothing installed and keeps data local. Where an established library exists,
STEMKit treats it as the reference its results must agree with, not as a
dependency, which keeps the tools usable offline.

# Software design

The pages are thin: they read the form, call the library and draw the result.
The computation lives in `stemkit-core`, 42 domain modules that use no browser
interfaces (\autoref{fig:architecture}). Four vendored libraries (jStat, Papa
Parse, regression.js and bibtex-parse-js) are supplied to the modules at start-up
rather than imported, so the same code runs in the browser, where the page
registers them, and under Node.js, where the package's entry point does. The
library is published on npm, and each release is archived on Zenodo.

![Architecture of STEMKit. Both hosts run the same core modules; the only
code specific to each host is the call that registers the vendored
libraries.\label{fig:architecture}](figures/architecture.png){ width=90% }

Re-implementing numerical methods in JavaScript is only worthwhile if the
results are right, so the design is built around agreement with independent
implementations rather than with STEMKit's own expectations. Statistics are
compared with SciPy and statsmodels; fits with `scipy.optimize.curve_fit`; the
generated figure scripts are run under matplotlib, and their axis limits are
compared with the browser's preview; and the data cleaner's pandas scripts must
produce the page's output cell for cell. The simulation tools are compared with
the programs themselves:

- every preset of the GROMACS set-up passes `grompp` of releases 2022 to 2025;
- the LAMMPS input checker agrees with LAMMPS on 806 example inputs and 479
  deliberately broken copies, and the generated workflows run in LAMMPS;
- the PLUMED inputs are parsed by PLUMED 2.9, 2.10 and 2.11.

Reference data are generated from the programs' own sources rather than typed
by hand: the GROMACS option tables, the PLUMED keyword tables and the LAMMPS
command reference. The 4371 tests run in continuous integration on three
Node.js versions and with Python installed, so the scripts are checked too. A
Content-Security-Policy on every page lets the browser itself refuse any
request except the two that users make explicitly: a DOI lookup and a
Protein Data Bank download.

# Research impact statement

STEMKit was first released in 2026, so its uptake cannot yet be measured. Its
contribution to research is in four places. It makes analysis possible where
data may not leave the machine. It makes browser results reproducible, through
the scripts it writes and the version-pinned library behind them. It makes
reported numbers more trustworthy: the validation exposed defects that had
altered results in earlier versions, among them $p$-values floored at zero,
the mass of haem iron taken as fluorine's, small-sample rank tests reported
as significant when the exact test is not, and force-unit conversions off by
factors of 10 and 25. Each is corrected, covered by a test, and marked in the
changelog so that affected figures can be re-checked. And it lowers the cost
of setting up simulations correctly, by explaining every GROMACS, LAMMPS and
PLUMED setting it writes and checking existing inputs before they are run.

# AI usage disclosure

The author conceived STEMKit and set its scope and design: which tools to
build, what each must do, the methods they use, and the independent references
and programs each must agree with. The author also tested the tools and decided
what was released. Claude (Anthropic), used through Claude Code, assisted with
the implementation, writing code, tests and documentation to the author's
specifications, and helped draft and revise this paper. Correctness does not
rest on the model: every numerical routine is tested against an independent
reference or against the programs themselves, those tests run in continuous
integration, and the author reviewed the results. The author takes full
responsibility for the software and this paper.

# Acknowledgements

I thank the maintainers of jStat, Papa Parse, regression.js, bibtex-parse-js,
Plotly, KaTeX, MathLive and 3Dmol.js, whose libraries STEMKit builds on, and the
GROMACS, LAMMPS and PLUMED developers, whose source code and documentation the
bundled reference tables are generated from.

# References
