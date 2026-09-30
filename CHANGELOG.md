# Changelog

Notable changes to STEMKit and `stemkit-core`.

`[output]` marks a change that alters a reported number. Figures produced with an
earlier version are worth re-checking.

## Unreleased

### Added: a curve fitter for any equation

- **Type the equation, not pick a model.** `y = A*exp(-t/tau) + y0`,
  `I(V) = I0*(exp(V/(n*Vt)) - 1)` or `z = a*x + b*y + c`: the page reads it as
  it is typed, shows it typeset, points at the character a mistake is at, and
  sorts the names into variables (matched to data columns by name) and
  parameters. Seventeen presets fill in common models. Parameters take a
  starting value, bounds, or a fixed value; physical constants are offered
  at their CODATA values.
- **The fit runs as you type**, by Levenberg–Marquardt on the untransformed
  data, weighted when an uncertainty column is given, with starting values
  found by the fitter. Each parameter comes with its standard error and 95%
  interval, and the fit with R², adjusted R², RMSE, reduced χ², AIC, BIC and
  the parameter correlations. The numbers match `scipy.optimize.curve_fit` to
  better than 1e-7.
- **The plot is styled on the page and saved as PDF, PNG or SVG**: size,
  fonts, ticks (automatic, every step, a count, or listed with labels), log
  axes, limits, markers, error bars, the fit line, a confidence band, a
  residual panel, legend, grid, frame and colours. The preview follows
  matplotlib's own tick and layout rules, so it shows what the Python script
  will draw.
- **The Python script** (SciPy and matplotlib) is written as you work: the
  same fit and the same figure, with the data embedded or read from a CSV.
- **One workspace.** The equation sits in a bar that stays in view while the
  results scroll, with the models in a searchable menu beside it. Data, model
  and plot style are tabs next to the plot, each marked done or in need of
  attention, and a file can be dropped anywhere on the fitter.
- New core modules: `expression` (parsing, derivatives and LaTeX, with no
  `eval`), `nonlinear-fit`, `fit-python`, `plot-style` and `pdf` (a PDF writer
  for SVG figures). The page no longer loads regression.js; `curve-fitting`
  keeps it for the npm package.

### Added: GROMACS set-up with every .mdp setting explained

- **Four steps, one zip**: System (force field, what is simulated,
  temperature and pressure, thermostat and barostat with a plain guide to
  C-rescale, Parrinello-Rahman and Berendsen, time step and bonds with a
  hydrogen mass repartitioning switch for 4 fs), Stages (energy
  minimisation, NVT, NPT, production, annealing and pulling, each with its
  length, output intervals and restraints, and a timeline with step counts
  and output sizes), Index and Job. Every `.mdp` file is written in full,
  each line with a comment saying why and a link to the GROMACS manual, and
  one download holds `submit.sh`, the `.mdp` files, `index.ndx` and a README.
- **Checked by the real program**: 122 combinations (five force fields,
  every stage, both barostats, with and without hydrogen mass
  repartitioning, and membrane, anisotropic, Nose-Hoover, annealing and
  pulling variants) pass `grompp` from GROMACS 2025 with no warnings beyond
  the ones the file names, and the page's own downloads ran in `mdrun` for an AMBER
  protein, a semi-isotropic membrane, GROMOS, 4 fs with hydrogen mass
  repartitioning, annealing, pulling and a coarse-grained system.
- **Every option, searchable**: all 325 options GROMACS 2025.1 reads, with
  defaults, units, allowed values, the manual's text and a link, settable in
  one file or all of them.
- **Check a file**: paste an existing `.mdp` to see whether grompp will stop
  and why (the checker agrees with grompp on 169 broken files), read it line
  by line, and open it in the builder.
- **Index groups**: drop a `.gro` or `.pdb` to get exactly the groups
  `gmx make_ndx` makes (the one it leaves nameless, for a blank residue name,
  is called `Group`, because GROMACS cannot read `[  ]` back), suggested
  groups (ligand, protein with ligand, pocket,
  membrane, solvent), the temperature-coupling groups for the system with the
  reason, and a group builder; the tc-grps are checked to cover every atom
  once.
- **`submit.sh`** skips stages that already finished and continues from the
  checkpoint, so a job stopped at its wall time can be submitted again; it
  adds `-maxwarn` only for a warning it names.
- New core modules `gromacs-mdp` (tables generated from the GROMACS source by
  `tools/build-gromacs-mdp.mjs`) and `gromacs-ndx`; `npm run check:gromacs`
  and `npm run check:ndx` compare them with an installed GROMACS.

### Added: one plot area and one Python script on every plotting page

- **The same plot area everywhere**: the Curve Fitter, PLUMED "Analyse a
  run", the XVG Visualizer, the Plot Digitizer, the Plot Builder, the Error
  Bar Generator, the Statistics Calculator and the Outlier Detector share one
  header with the figure's true size, one Style panel (size in inches,
  centimetres, millimetres or pixels; fonts and separate title and tick
  sizes; ticks; grid on either or both axes; markers, lines and colours per
  series; legend; Publication, Presentation, Minimal and Dark presets), PDF,
  PNG and SVG at the true size, and a Python panel. Learn it once.
- **The Python draws the same figure** from your own files (or with the data
  in the script) with matplotlib, and repeats the page's numbers: tests run
  every page's script and compare matplotlib's axis limits with the preview's.
- **PLUMED "Analyse a run"**: six figures (time series, histogram, reweighted
  free energy, the free-energy surface along one variable or as a heatmap
  with contours over two, its convergence, and hill heights), with a script
  that reads COLVAR and HILLS (restarts, cut-off last lines, several walkers)
  and matches the page to 1e-9.
- **Error Bar Generator**: significance brackets from Holm-corrected Welch
  tests, and a pairwise table. **Statistics Calculator**: the script reruns
  the test, checked against the page for all twelve. **Outlier Detector**: a
  chart of the values with the flagged ones and the rule's thresholds.
  **Plot Builder**: error bars, bands, several panels and PDF export.
  **Plot Digitizer**: the digitised series replotted as you click.
- Large data: a 400,000-point scatter redraws in under a second; the script
  reads the file rather than copying a million numbers into itself.
- New core modules: `figure`, `figure-python`, `plot-builder`,
  `error-bars-figure`, `statistics-figure`, `outliers-figure` and
  `plumed-analysis-figures`.

### Added: the Data Cleaner keeps a recipe and writes the pandas script

- **Every action is a step in a recipe** you can undo and redo, switch off,
  edit, reorder where it is safe, and click to see the table at that point,
  with the rows each step leaves. Save the recipe and apply it to another
  file. One-click suggestions for what the page spots.
- **The pandas script** (a plain script or a `clean(df)` function) reads your
  file, repeats each step with a comment saying what it does, and writes a
  file byte-identical to the page's download, checked with pandas 2.1 and 3.0
  on 800 random recipes. New core module `data-cleaning-python`.

### Added: PLUMED workbench

- **Keyword tables for PLUMED 2.9, 2.10 and 2.11**, generated from PLUMED's
  own `syntax.json`, drive the input generator, its version notes and the
  module warnings.
- **Check, explain and open an existing `plumed.dat`**, parsed by PLUMED's
  own rules and tuned on the inputs of PLUMED's regression tests.
- **Atoms from a structure file**: groups, and centres and directions per
  molecule, numbered by position as PLUMED counts them.
- **Analyse a run**: COLVAR gives hill widths and grid bounds; HILLS gives the
  free-energy surface, matching `plumed sum_hills` to nine decimal places, and
  whether the bias has settled; the printed bias reweights other quantities.
  The same analysis comes as a Python script for files on a cluster.
- **Run files that start and continue a job** with one script, for GROMACS
  and LAMMPS: one run, MPI walkers, walkers as separate jobs, and umbrella
  windows. Checked by killing jobs at random for every method and layout.
- Functions, walls, setup lines (`LOAD`, `INCLUDE`, `RESTART`, `FLUSH`) and
  several output files in the generator.

### Changed

- The XVG Visualizer's smoothing is a running mean over N points (the one
  numpy repeats), not a spline; a series on another scale goes in a lower
  panel instead of on a right-hand axis.
- The Plot Builder breaks a line at a blank or text cell, as matplotlib does,
  instead of joining across it; sub- and superscripts are written `$_{…}$`;
  figure sizes run from 1 to 30 inches.
- The Plot Digitizer's CSV gives every series a distinct name.
- The Error Bar Generator's own "Customize plot" controls are replaced by the
  shared Style panel.
- The MD workflow generator's water model defaults to TIP3P, and its
  topology header offers GROMOS 54A7 and Martini 3; the header is a tab of its
  own and is left out of the zip so it cannot overwrite a real `topol.top`.
- The PLUMED sample hills file is the two-variable run (`assets/samples/plumed/HILLS`).
- **`parsePDB` reads the first model of a multi-model PDB**, as GROMACS and
  PLUMED do, and says how many it skipped (`modelCount`, `warnings`); pass
  `{ models: 'all' }` for the old behaviour. It keeps four-letter residue
  names (POPC, TIP3) and residue number 0, and `parseGRO` reads files written
  at any precision. Selections take the box (`box`, `boxVectors`) and measure
  `within:` to the nearest periodic image, matching `gmx select`.

### Fixed: GROMACS and PLUMED, cross-checked against the programs

Twelve independent audits ran the tools against GROMACS 2025 (`grompp`,
`mdrun`, `make_ndx`) and PLUMED 2.9, 2.10 and 2.11 and read their source;
every finding was reproduced by at least two of three separate checks before
it was fixed, each with a regression test.

- `[output]` **PLUMED free energies.** A 1D surface taken from a 2D HILLS file
  summed the hills along one variable instead of integrating the other out;
  a restarted run's hills that were read back were dropped as a copy;
  walkers' files joined with `cat` lost most of their hills; hills wider than
  half a periodic axis, ADAPTIVE hills and files without a kernel type were
  summed differently from `plumed sum_hills`; reweighting used one bias column
  and missed the walls, and ran at the global temperature rather than the
  method's own.
- `[output]` **PLUMED run files.** A 4 fs run lost half its hills (the kit's
  time step was never checked against the `.tpr`); LAMMPS MPI walkers were
  identical copies; umbrella windows could all sit at AT = 0; MOVINGRESTRAINT
  work lost the last interval before each checkpoint; OPES never wrote its
  state; GROMACS MPI walkers asked for one rank, which `-multidir` refuses.
- **PLUMED inputs PLUMED rejected or misread**, among them PLANE,
  DIHEDRAL_CORRELATION, ERMSD, PCARMSD and PUCKERING components, DRMSD without
  WHOLEMOLECULES from 2.10, NLIST settings lost under METAD, and several CV
  options; all 311 generated inputs now parse in 2.9, 2.10 and 2.11, and 303
  run on a trajectory. The input checker no longer flags things PLUMED
  accepts, and now catches missing compulsory keywords, undefined references
  and parse failures it missed.
- **GROMACS stages that would have failed:** energy minimisation was given
  GPU flags `mdrun` rejects, as was `-update gpu` with Nose-Hoover or virtual
  sites and `-pme gpu` without PME; conjugate-gradient minimisation from a
  solvated start; thread-MPI and MPI builds got the wrong rank options; file
  names with spaces were not quoted.
- **GROMACS set-up:** GROMOS 54A7 constrains all bonds, as it was
  parametrised (it used h-bonds); Martini 3 pair lists and LINCS follow the
  force field's settings; pulling sets a central PBC atom per group and
  checks the group names; temperature-coupling groups are no longer split
  into baths too small to hold a temperature.
- **The .mdp checker** now stops where grompp stops for AWH, rotation and
  swap set-ups, a group named twice, `sc-r-power` other than 6,
  `fourierspacing` of zero, and more, and no longer stops where grompp does
  not; it reads Unicode spaces, bare CR line ends and hexadecimal numbers as
  grompp does. It agrees with grompp on 169 broken files.
- **Index groups:** element filters no longer read SOD, CLA, POT or CAL as
  sulphur, carbon or phosphorus; CHARMM nucleotides and glycans are not
  cosolvent; selections within a distance respect periodic boundaries.
- Page text that said something false about GROMACS or PLUMED is corrected:
  thermostat and barostat guidance, walker commands, the check command, wall
  offsets, units and version notes.

### Fixed: output

- `[output]` **The Data Cleaner's rounding** used `toFixed`, so 2.675 became
  2.67; it now rounds the number as written (2.68), half away from zero or to
  even as you choose. Its filters no longer treat a missing cell as 0, the log
  of zero or a negative number is now missing rather than left unchanged,
  sorting is by value then text rather than by the browser's locale, a column
  with a blank name is no longer dropped, and `TRUE` or a date stays as
  written.
- `[output]` **Generated PLUMED inputs that PLUMED rejected.** Every
  metadynamics, PBMETAD, OPES and steered-MD input closed its block with
  `... METAD`, which PLUMED refuses. About twenty variables printed or biased
  components that do not exist, such as `cv1` for POSITION or `.s` for
  PATHMSD, which has `.sss`. All 308 generated inputs now parse in
  PLUMED 2.9, 2.10 and 2.11.
- `[output]` **An OPES run continued from the kernels file** and came back
  about 18 kJ/mol off even after a clean stop; it now restarts from the state
  file. With MPI walkers, PBMETAD restarted every walker but the first
  without its bias.
- **Subscripts and superscripts in typeset formulas** were drawn at full size
  on every page with KaTeX: the stylesheet was from a newer release than the
  script.

### Fixed: pages that described the tools wrongly

- **MD Workflow Generator, PLUMED notes:** they said `D_MAX` gives
  `COORDINATION` linked cells. PLUMED has none for it, in 2.9, 2.10 or 2.11:
  `D_MAX` only brings the switch to zero, and the speed-up is `NLIST`. Linked
  cells belong to multicolvars such as `COORDINATIONNUMBER` and `Q6`, which
  the notes now name. Checked with `plumed driver`: `D_MAX` left a
  two-group `COORDINATION` as slow as before.
- The same notes offered PLUMED 2.9 or 2.10 "next to the CV list"; the menu
  has 2.9, 2.10 and 2.11 and sits in the System and setup panel. They named
  `plumed --version`, which PLUMED refuses, for `plumed info --version`, and
  described the file's header wrongly.

## v0.2.1 — 2026-09-25

Every page's claims were checked against its code. This release fixes what
did not match: bugs where the code was wrong, wording where the page was.

### Fixed: output

- `[output]` **BibTeX: a bare value failed the whole file.** `month = jul`,
  `journal = jcp` or doi.org's `month = Sept` made `parseBibtex` return nothing
  or throw, so the deduplicator rejected typical exports and the output of DOI
  to BibTeX. `@string` and month macros are now expanded, `#` concatenation
  works, and `@article(...)` entries parse.
- `[output]` **BibTeX Sanitizer and Deduplicator rewrote what they kept.** The
  sanitizer turned bare macros and quoted values into braced text; the
  deduplicator's download rebuilt every entry, losing braces such as `{NumPy}`,
  and dropped `@string`, `@preamble` and `@comment` blocks. Unchanged entries
  are now written as they were.
- `[output]` **DOI to BibTeX dropped every field outside its panel** (address,
  school, howpublished), and fetched a DOI from an earlier batch again. Only
  unticked fields are removed now, and repeated DOIs are skipped.
- `[output]` **MD workflow generator: the default pipeline stopped at NVT.**
  `grompp` was given `-t em.cpt`, but energy minimisation writes no
  checkpoint. The topology wrote a second `[ defaults ]`, which grompp
  rejects, and named `opls-aa.ff` for `oplsaa.ff`. `mdrun` now gets `-ntomp`,
  split between `-ntmpi` ranks, and the PLUMED temperature reaches methods
  whose own field is blank. CHARMM36 is marked as a separate download.
- `[output]` **Structure inspector: residue ranges selected nothing.**
  `resi:1-50`, mixed lists such as `1-5,10` and the selection builder's ranges
  now match; `elem:` accepts any case. The label limit counts the atoms being
  labelled, not the whole file, and can be raised whenever it applies.
- `[output]` **XVG visualizer: the Python export failed on CSV and multi-set
  files.** It now passes the delimiter, skips the header row and `&`
  separators, and reads only the rows the page plots. A record with an empty
  field, or with a different number of values from most rows, is skipped and
  reported instead of shifting the columns after it; a comma ending every
  line is allowed. CSV header names label the series.
- `[output]` **Curve fitter:** a row whose x or y value is empty is skipped
  and reported instead of taking y from the wrong column. The exported script no longer
  calls the power fit y-weighted, and the theory panel's logarithmic model
  matches the menu (y = a + b ln x).
- `[output]` **Error bar generator:** the CSV leaves SD, SEM, t, CI and CV%
  blank for a single-replicate group, as the table does, instead of writing 0.

### Fixed: pages that described the tools wrongly

- Removed claims for features that do not exist: cell merging in Visual LaTeX
  Tables, WebGL rendering in the XVG visualizer, colour sweeping in the plot
  digitizer, syntax highlighting in the equation formatter, title-case repair
  in the BibTeX Sanitizer, and reshaping in the data cleaner.
- Corrected descriptions of what the tools do: delimiter detection in LaTeX
  Tables, the journal abbreviator's ISO 4 fallback, DOI lookup through doi.org
  (not Crossref alone), the coordinate manipulator's 5,000-atom preview and
  zero mass for unknown elements, the curve fitter's linearised models, the
  statistics calculator's validation references and APA example, and the
  Pomodoro timer's looped noise.
- The plot digitizer shows the cursor position in data units after
  calibration, which its checking tip already assumed.
- Privacy, home and 404 pages say which two features go online instead of
  "100% local", and no longer claim GDPR compliance by default.
- The 404 page, served at whatever path was missing, lost its styles and
  linked to more missing pages when that path was nested; its links now
  resolve from the site root.
- Structured data no longer shows raw HTML entities.

### Changed: search and speed

- Plotly, 3Dmol and the other libraries load without holding up the first
  paint, which came after a 3.6 MB download on the plotting pages. The plot
  builder no longer shifts while Plotly loads.
- Titles and descriptions fit in search results; the share image is a JPEG
  with its size and alt text; the privacy page and the structure inspector
  have the preview tags and structured data the other pages have.

### Removed

- `home-sections-preview.html`, a scratch page still served with invented
  testimonials.

## v0.2.0 — 2026-09-25

Four fixes below change what a tool reports; they are marked `[output]`.
The rest is layout, controls and wording. In `stemkit-core` the only change
to an existing function is the chi-squared tail below; everything else there
is new.

### Fixed: numbers and figures

- `[output]` **Error bar generator: statistics under the wrong headings.** Since
  the move onto `stemkit-core` the table printed its cells in another order
  than its headings: the CI half-width under Median, the median under IQR, the
  IQR under CV, the CV under Min/Max, the minimum under t\*, and t\* not at all.
  The statistics were computed correctly; a value read off the table was
  another statistic. Every "Customize plot" control was also dead.
- `[output]` **Coordinate manipulator: centre readout and rotation pivot.** The
  "Geometric centre" readout was the bounding-box midpoint, so a centred
  structure read (0.104, -0.588, 0.002); it is now `geometricCentre`, the point
  centring uses. The "Rotate about" choice was never read, so every rotation
  used the default pivot; it is now honoured and named in the `gmx editconf`
  note. Rotations about the default pivot are unchanged.
- `[output]` **`chiSquaredUpperTail` lost the far tail.** It was
  `1 - lowRegGamma`, so `chi2.sf(100, 5)` = 5.3e-20 came back as the 5e-324
  floor and `chi2.sf(60, 1)` was 0.5% low. The upper incomplete gamma is now
  evaluated by its continued fraction where the subtraction fails; matches
  `scipy.stats.chi2.sf` to 1e-10 relative out to 8e-104. The df = 2 case the
  normality test uses already had an exact closed form and is unchanged; the
  new Kruskal-Wallis test was the first caller with more degrees of freedom.
- `[output]` **Plot builder: sizes meant what they said only on screen.** "Scale
  (DPI)" was a 1-4x multiplier and the PNG carried no resolution, so it placed
  two to four times too large; the matplotlib script sized the figure at
  px/100 in with fonts in points, making its text 1.39x larger than the
  preview's, and `bbox_inches='tight'` then cropped it to another size. A
  figure is now width x height in in, cm, mm or px at 72-600 dpi with text in
  points, and the preview, PNG (tagged with its dpi), SVG and script produce
  the same figure: seven configurations compared by overlay, matplotlib 3.6.3.

### Added: statistics (`core/statistics`, 80 tests, suite 1208)

- `descriptives`, `boxPlotStats`, `leastSquaresLine`; `oneSampleTTest`,
  `oneSampleWilcoxon`, `spearmanCorrelation` (Bonett-Wright interval),
  `kruskalWallis`, `welchAnova`; post-hoc `tukeyHSD`, `gamesHowell` and
  `dunnTest` with `adjustPValues` (Holm by default) and `qUpperTail`;
  `recommendTest`. Each is validated against SciPy 1.11.4 or statsmodels, or
  against its formula where SciPy has none, with the call in the test.
- The statistics calculator offers twelve tests grouped by design, a per-group
  descriptive table (CSV, Markdown, LaTeX booktabs), a plot of the data (box
  plots with points and mean CI, paired lines, scatter with the fitted line;
  SVG and PNG), pairwise tables after three or more groups, and a "Which
  test?" suggestion it never applies on its own. Data is read as it is pasted.

### Changed: structure inspector, plot builder, XVG visualizer

- Structure inspector: on-canvas view controls (hold-to-rotate pad and
  trackball, zoom rail, X/Y/Z views, fit, auto-spin), Find by residue, chain,
  atom, element or species with suggestions, stepping and "only matches", a
  species list with one-click hide water and ions, and the simulation box from
  GRO, PDB CRYST1, CIF and VASP drawn and labelled, toggled with `B`. `F` now
  fits; fullscreen moved to `Shift+F`. Selection style "Hide" now hides, and
  unbonded atoms (ions) show in stick and line styles.
- Plot builder: the preview redraws as settings change; there is no Render
  button. Size presets, axis limits, tick direction, frame, legend positions,
  line styles and markers; Okabe-Ito default colours.
- XVG visualizer: a series can go on a second y-axis, mirrored in the Python
  export with `twinx()`; the X column is no longer offered as a series.

### Changed: the site

- One brand accent (Prussian blue) and a benzene logo replace indigo and
  seven per-tool colours; favicons and the social card are redrawn.
- One header on every page, with "Find a tool" (Ctrl/Cmd+K or `/`), "Next
  steps" under each tool, and a shared catalogue in `js/site.js` that
  `npm run check:chrome` holds the pages to. The 404 page's own list, which
  offered three tools that do not exist, is gone.
- Every tool opens on the same page head, numbered panels show live progress,
  and file loaders share one size. A saved or system dark theme now applies
  on every page (it was lost on 18 of 21 tools). Text contrast meets WCAG AA
  in both themes. Explainer formulas are all typeset by KaTeX from TeX, and
  the explainers share one type scale.
- The home page leads with search and a file-type lookup; invented
  testimonials and a 4.9-star rating in the structured data are removed.
- The plot digitizer's preview loaded Plotly from `cdn.plot.ly`, the last
  request any page made to another host; it uses the vendored copy.
- The privacy page says which two features contact another service (DOI
  lookup at doi.org, PDB fetch from RCSB).

### Added: `stemkit-core`

- **On npm as `stemkit-core`**, renamed from `@stemkit/core`, which was never
  published. Under Node the package entry (`core/node.js`) registers the four
  bundled libraries, so a script no longer calls `registerVendor`. The package
  has no dependencies.
- **`core/scheduler`**: directive headers, environment-variable names, launch
  prefixes and submit commands for SLURM, PBS Professional / OpenPBS, LSF and
  Grid Engine, sharing `core/slurm`'s validation. The SLURM path delegates to
  `core/slurm` unchanged. 51 tests; the module count is 17.

### Changed: MD workflow generator

- Scheduler selector (SLURM, PBS Pro / OpenPBS, LSF, Grid Engine). The engine
  blocks follow the choice: launcher, job and array variables, working
  directory, log paths and the submit command. Anything site-specific
  (queue names, parallel environment, GPU resource names, memory units) is
  marked as such inside the generated script.
- The `#SBATCH` header now comes from `core/slurm` through
  `js/script-generator-slurm.js`, as that adapter's header always intended;
  output for the same inputs is byte-identical.
- Download buttons for `submit.sh`, `topol.top` and `plumed.dat`; settings
  persist between visits and can be exported and imported as JSON; a resource
  summary (cores, GPUs, core-hours, array tasks in flight) under the cluster
  form; syntax colouring of the generated script.

### Changed: structure inspector

- Application shell: the viewer fills the space under the navigation, the
  side panel scrolls on its own, can be resized by dragging or with the arrow
  keys and collapsed, and remembers its width, state and last open tab.
- Viewer toolbar and keyboard shortcuts (`R` reset, `S` spin, `M` measure,
  `H` hydrogens, `L` labels, `F` fit, `Shift+F` fullscreen, `?` shortcut sheet,
  `Esc`).
- Files can be dropped anywhere on the page; large files report read
  progress; a file that fails to parse names the file and the reason and
  returns to the upload zone. The PDB fetch distinguishes a missing entry
  from a network failure.
- Two bundled samples (`assets/samples/`), generated from textbook geometry
  so the demonstration works offline.
- PNG export offers a transparent background and shows the output size in
  pixels; very large exports warn rather than fail.

### Changed: coordinate manipulator

- The workspace is built from the shared components: panels with plain
  headings instead of a per-card colour theme, labels above their controls,
  the system statistics as a key/value list with tabular figures, the box and
  `editconf` notes as callouts, and a viewer toolbar over the canvas.
- Empty state with two bundled samples and the accepted formats as chips; a
  file can be dropped anywhere on the page.
- Undo and redo are a toolbar with keyboard shortcuts; on a phone the viewer
  comes first, then the controls, then the output buffer, with no sideways
  scrolling at 375 px.
- Parsing, geometry, unit handling and the written files are untouched: the
  same operations on the same structure produce byte-identical PDB, GRO and
  XYZ output and the same `gmx editconf` command as the previous version.

### Changed: every page

- All stylesheets, fonts and scripts are served from the repository. Inter is
  vendored (variable weight, SIL OFL 1.1) and is now applied as the body
  face, which it never was: the pages requested it from Google Fonts and
  rendered in the system font. The structure inspector loaded Tailwind from a
  CDN and threw `tailwind is not defined` offline. Favicons are relative.
- Design tokens and shared components in `src/tailwind/input.css`
  (`docs/CSS.md`). Visible keyboard focus, `prefers-reduced-motion`, no text
  below 11 px, reference tables and code blocks that scroll inside their box
  on phones rather than widening the page.
- The six pages that still carried inline `<style>` blocks use
  `src/tools/<tool>.css`. Ten per-tool stylesheets contained stray keyframe
  bodies outside any `@keyframes` rule, left by the earlier extraction; the
  shared stylesheet set the two- and three-column documentation grid and
  then reset it to one column, which every tool stylesheet patched with its
  own media query. Both fixed at the source.

## v0.1.1 — 2026-07-25

### Fixed: numerics

- `[output]` **Skewness and kurtosis used the sample SD, not the population SD.**
  Deflated skewness by `((n-1)/n)^(3/2)`, about 15% at n = 10. Both moments feed
  D'Agostino-Pearson, so every normality p-value was affected.
- `[output]` **Adjusted G1 was fed into the D'Agostino-Pearson transform.** The
  transforms are defined on the biased moment ratios `sqrt(b1) = m3/m2^(3/2)` and
  `b2 = m4/m2^2`. `skewness()` returns the sample-size-adjusted G1, and that was
  passed in. At n = 10 this gave K2 = 0.4521 against scipy's 0.3724, a 21% error.
  `dagostinoNormality()` now uses an internal unadjusted moment; `skewness()`
  still reports G1, which is the right statistic to publish and matches
  `scipy.stats.skew(bias=False)`. K2 now matches `scipy.stats.normaltest` to 12
  significant figures for 8 <= n <= 47.

  The test asserting this had its tolerance loosened to 3 decimal places and the
  residual attributed to "a marginally different kurtosis transform" in scipy.
  The reference value was scipy's, and correct. Tightened to 12 places with two
  regression tests at the n where the conventions diverge most.
- `[output]` **Upper tails computed as `1 - cdf(x)`, which cancels to zero.**
  ANOVA at F = 377.545, df 2 and 21, reported p = 0 instead of 3.46e-17. Now uses
  the complementary incomplete beta and gamma; an asymptotic expansion takes over
  past |z| ~ 8 where the vendored `erfc` underflows.
- `[output]` **Element inference misassigned metals and prefixed hydrogens.**
  Haem iron got fluorine's mass (18.998 Da, not 55.845). Selenomethionine
  selenium got sulfur's. `1HB`-style hydrogens got none. Metalloprotein masses
  and centres of mass were wrong.
- `[output]` **Unidentified atoms borrowed carbon's mass** (12.011 default).
  Worst case: TIP4P/TIP5P water carries a massless charge site, so every water in
  a solvated system read 30.03 Da instead of 18.015. That is +67% per water, or
  120 kDa of nonexistent mass across 10,000 waters. Three outcomes are now
  distinct: known element returns its weight; known virtual site (`MW`, `LP`,
  `DUM`, `MCH3`, `MNH3` and relatives) returns zero, because that is its mass;
  anything else returns zero and is recorded so it can be named.
- `[output]` **Reciprocal units ignored the `inverse` flag.** `wl_nm` lost its
  marker and `convert()` had no branch for it, so 532 nm converted to
  0.0000532 cm-1 instead of 18797 cm-1. `convert()` now inverts both entering and
  leaving the base unit.
- `[output]` **kBT scales returned `NaN`.** `kt_kj`, `kt_kcal`, `kt_mev` restored
  in `convertTemperature()` using exact SI 2019 constants. Cross-checked against
  `convertKT()` to 1e-12.
- `[output]` **Atomic weights updated to CIAAW 2024.** Four were wrong, not just
  rounded: Zr 91.224 to 91.222, Gd 157.25 to 157.249, Lu 174.97 to 174.96669,
  Ar 39.948 to 39.95. Argon's standard weight is the interval
  [39.792, 39.963]; 39.948 is an older single figure still in circulation. Values
  now carried at published precision with the source cited. Fourteen elements
  with variable isotopic composition use the abridged value; Tc uses the mass
  number of its longest-lived isotope; elements without a standard weight are
  omitted, so their atoms report as unidentified rather than get a fabricated
  mass.

- `[output]` **Piconewton and newton factors truncated to 7 digits.** `1.660539`
  where the CODATA-derived value is `1.66053906717`. Every other factor in the
  table carries 12 to 13 digits.

### Fixed: bugs

- **`latex-formatter` never ran.** Unclosed `forEach` in the theme-toggle handler
  threw `SyntaxError: missing ) after argument list`, so the script never parsed
  and the tool was dead in production. Duplicate theme toggle removed; the shared
  inline script already handles theming and the second handler cancelled it out.
- **structure-inspector busy overlay could not be dismissed.** `#busyOverlay` set
  `display:flex` by id; the script hid it by toggling `.hidden`. Id specificity
  (1,0,0) beats class (0,1,0), so the spinner stayed up and swallowed mouse input
  to the 3D canvas. Fixed with `#busyOverlay.hidden { display:none }`.
- **DOI-to-BibTeX field filtering did nothing.** Filter applied to a copy that
  was then discarded.
- **Coordinate Manipulator accepted files but never loaded them.** UI layer
  targeted a DOM that does not exist.

### Fixed: docs for the fitting models

An earlier description of the vendored regression.js fits was wrong. The error
had reached the in-app formula panel, the exported Python, and two tests that
asserted it.

| Model | Regresses | Weighted | Log-space bias |
|---|---|---|---|
| logarithmic | y on ln x | no | none |
| power | ln y on ln x | no | yes |
| exponential | ln y on x | by y | reduced |

- **Logarithmic is not a log-space fit.** `y = a + b*ln x` is linear in its
  parameters, so regressing y on ln x is OLS on untransformed y. Transforming the
  predictor introduces no bias in the response. Verified numerically: no nearby
  parameter pair fits the original scale better. Removed from
  `LINEARISED_MODELS`.
- **Power is unweighted,** so its residuals really are in log space and small y
  values carry more influence than a direct fit gives them.
- **Exponential weights by y,** the standard log-transform bias correction, which
  keeps it closer to a direct non-linear fit. For exponential and power,
  parameter pairs fitting ~29% and ~36% better on the original scale do exist.
  Note that on an *exactly* exponential series the weighting is irrelevant: the
  log-space residuals are zero and every variant recovers ln 2. The divergence
  needs perturbed data. On `[[1,2.0],[2,4.1],[3,8.2],[4,16.1],[5,32.3]]` the
  weighted fit gives 0.690216 against 0.693167 unweighted.
- **Untransformable points are not dropped.** `validateForModel` refuses the
  dataset and names the requirement: exponential needs every y > 0, power every
  x > 0 and y > 0, logarithmic only x > 0.

### Added

- **ISO 4 journal abbreviation, two tiers.** `journals` maps a whole title to its
  whole abbreviation: exact, but only for titles already entered. `iso4` applies
  the ISSN LTWA word by word, so any title can be abbreviated. Tier 1 runs first;
  tier 2 takes what it does not recognise.
- **Molecular weight shows its working.** A `how?` link opens a per-element
  breakdown: atom count, weight used, contribution, total. Massless sites and
  unidentified atoms are listed separately rather than inferred from a total that
  does not match the atom count. Downloads as CSV with a header recording source
  file, method, weight set and exclusions. `massBreakdown` lives in the core and
  is tested for full atom accounting and agreement with `centreOfMass`.
- **Equivalent `gmx editconf` command** for coordinate-manipulator operations,
  verified against `editconf.cpp`. Note `-box` centres silently.
- **Triclinic cell support:** outline rendering, correct rotation and periodicity.
- **Undo and redo** in the coordinate manipulator.
- **Grubbs' p-value** in the outlier detector, alongside the flag count, with an
  explanation when the MAD fallback was used.
- **Explicit WebGL check** in the structure inspector. It needs WebGL, not a
  discrete GPU.
- `listAllCategories()` and `isAffine(category)` in `units`. `listCategories()`
  now returns multiplicative categories only, since affine units have no
  conversion factor or base unit. Marked-up unit forms live alongside plain ones
  as `symbolHtml` and `nameHtml`, keeping the core presentation-neutral.
- Full unit metadata: 11 categories, 70 units, including `temperature`. All 64
  factors shared with the previous table verified identical before merging.

### Changed

- Computation extracted from page scripts into `src/core/` as DOM-free ES
  modules, tested independently and importable under Node. See `CONTRIBUTING.md`.
- Inline `<style>` blocks moved into `src/tools/` and `src/stemkit-docs.css`. See
  `docs/CSS.md`.
- Plot digitizer: native `alert()` dialogs replaced; resolution note no longer
  covers the figure; Python export script actually emitted.
- PNG exports match on-screen sharpness.
- Measurement labels no longer stack on redraw.
- Custom abbreviation rules persist across sessions.

### Docs

- `vendor.js` claimed a resolution failure "cannot be guarded with try/catch".
  True of a static `import`; `await import()` rejects catchably. Scoped, with the
  reason injection is still preferred (the bundles must be available
  synchronously).

### Known issues

- Two audio files referenced by the Pomodoro timer are missing.
- `iso4` has no `tests/smoke.mjs` case and is the lowest-covered domain module.

---

Condensed from a longer development log kept during the extraction of
`src/core/`. Full narrative, including audit passes and per-tool verification, is
in the git history.
