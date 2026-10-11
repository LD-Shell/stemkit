# Changelog

Notable changes to STEMKit and `stemkit-core`.

`[output]` marks a change that alters a reported number. Figures produced with an
earlier version are worth re-checking.

## Unreleased

### Changed

- **Guide sections.** The Plot Builder and the XVG Visualizer set out the text
  under the tool as the other pages do: a "How-to guide" chip, notes in cards
  on a grid, and references in a narrow column. On every page the guide now
  sits in the same column, and the questions are the same width.

## v0.5.0 — 2026-10-10

The Plot Builder draws nine kinds of chart, on a second pair of axes and on a
grid of panels with letters and insets, with fifteen examples to start from;
and a second round of fixes: job arrays, wall times and memory as the
schedulers read them, unit factors from the exact constants, samples that do
not vary, files of several data sets, and duplicates told apart by their DOIs.

### Added: more charts in the Plot Builder

- **Nine kinds of chart.** Each series has a **Chart** menu: line, points,
  step or band (as before, with **Step** new), bars, bars of means, a
  histogram, box plots, violin plots, a heatmap, contours, and a 2D
  histogram. Bars name themselves from a text
  column or sit at the numbers of a numeric one, with an optional Y error;
  a histogram takes its bins and density; box plots group one column by
  another or take one box per column; heatmaps and contours lay a value
  column over X and Y; a 2D histogram counts rows in a grid of equal bins as
  `numpy.histogram2d` does.
- **The script and the exports draw the same charts.** Every kind was run
  through the generated matplotlib script, reading the file and with the
  numbers embedded. The grid of a heatmap, contour or 2D histogram is in the
  script as numbers.
- **A second y axis on the right and x axis on top.** A series card's
  **X axis** and **Y axis** menus put a line, bars or a histogram against a
  y axis on the right (temperature and pressure against time) or an x axis on
  top (wavelength below, wavenumber above), or both. Each has its own label,
  taken from the first series on it, scale, limits and ticks in the Style
  panel, and takes the colour of its series when it has only one. Zooming
  zooms both; one legend lists the series of every axis. The script draws
  them with matplotlib's `twinx` and `twiny`, and the preview, PDF, PNG and
  SVG match it.
- **Bars lying flat, and stacked.** A bar series' **Bars** menu lays it flat:
  the names go up the left axis, the first at the top, and the lengths and
  error bars run along x. **With other bars** stacks it on the stacked series
  before it, values below zero downwards, or stacks them to 100% with each
  value as its share; error bars stand at the end of each bar and the legend
  reads down the stack. Stacked bars may stand on the right axis; bars lying
  flat use the bottom and left axes, and their card says so if a second axis
  was chosen.
- **Bars of means.** A new chart for replicate rows: one bar for each name
  with the mean of its rows and their standard deviation, standard error or
  t-based confidence interval (90, 95 or 99%) as the error bar, and each value
  over its bar if you like. The card counts the values of each name and says
  which have only one. The script reads the value column and works out the
  same means and errors with numpy (scipy for an interval).
- **Histogram options.** Bins as a number, as one of numpy's rules (auto,
  Freedman–Diaconis, Sturges, square root, Scott, Rice, Doane: the same edges
  as `numpy.histogram_bin_edges`, which the script calls by name), or as
  edges you type, checked as you type them; bars as counts, density, fraction
  or percent; and a running total. "auto" is the rule of numpy 2.3 and
  later, which no longer lets the bins get narrower than half the square-root
  rule's; the script counts those bins itself, so an older numpy draws the
  same histogram.
- **Violin plots.** Grouped as box plots are, drawn from the kernel density
  matplotlib's `violinplot` uses (Scott's or Silverman's bandwidth), from the
  smallest value to the largest or further, each violin the same width or all
  the same area, with a box and median, quartile lines or a median line
  inside, and the points. The script works the density out with numpy alone.
- **Box plot options.** Whiskers to the last value within 1.5 × IQR, to the
  smallest and largest value, or within the 5th to 95th or 10th to 90th
  percentiles; a notch at the median; the mean with its 90, 95 or 99%
  interval. On the card and in the Style panel.
- **Fixed: bars placed by numbers were at most 1 wide.** Bars 5 apart were
  drawn as thin lines. A bar's width is now in the units of its axis with no
  upper limit, the builder makes bars four fifths of their closest gap wide
  whatever the gap, and the Style panel's **Bar width** is a share of that
  gap. Bars on names are unchanged.
- **Fixed: a bar with no number widened the x axis** in the preview, where
  matplotlib leaves it out of the limits.
- **An example for each kind of chart.** **More examples**, beside **Load an
  example**, lists twelve built-in data sets with the series that show them
  off: growth curves, two y axes, a top x axis, grouped bars, bars of means,
  stacked bars, histograms, box and violin plots, a heatmap with contours, a
  2D histogram, a step line and two panels. An example takes the place of the
  files and series on the page (it asks first when the files are yours) and
  keeps your plot style. Box plots and violins in two panels now stand over
  each other.
- **`stemkit-core`:** `plot-builder` gains `CHART_KINDS`, `gridFromXyz`,
  `histogram2d`, `boxGroups`, `suggestColumns` and `axisChoices`; `readTable`
  also returns each cell's text (`texts`). `figure` gains the series fields
  `xAxis` and `yAxis`, the panel fields `y2Label`, `y2Scale`, `y2Lim`,
  `y2Ticks`, `y2Color` and their `x2` counterparts, and `hasAxis`. For the
  charts above, `figure` gains the `violin` kind; `orientation`, `stack`,
  per-bar `bottom` and `replicates` on bars; `normalise`, `cumulative` and
  rule names for `bins` on histograms; `notch` and percentile `whis` on
  boxes; the panel field `yCategories`; and `histogramBinEdges`,
  `histogramHeights`, `numpySum`, `kdeBandwidth`, `gaussianKde`,
  `violinStats`, `groupMeans`, `barData` and `legendOrder`. `plot-builder`
  gains `parseEdges`, `replicateGroups`, `histogramOptions`, `EXAMPLES`,
  `builderExample` and `exampleState`.

### Added: panels on a grid, shared axes, gaps, letters and insets

- **A grid of panels.** The Plot Builder's Series tab has a **Layout**
  section with the rows and columns of the figure, and each series' **Panel**
  menu names the cells ("Row 2, column 1"). In one column nothing changes:
  the panels stack, share the x axis, and an empty one is left out. On a grid
  every panel has an x axis of its own, with its own label, scale, limits and
  ticks in the Style panel; the widths of the columns and the heights of the
  rows are set there too, and the title stands over the whole grid.
- **Shared axes.** The x axis shared down each column or by all the panels,
  the y axis along each row or by all: one scale and one range for the group,
  and tick labels and axis labels on its outer panels only, as
  `plt.subplots(sharex=..., sharey=...)` draws them.
- **The gap between panels.** The space between stacked panels was
  matplotlib's own and could not be changed: 3 pt of padding on each side of
  every panel, 6 pt between two, plus the room for whatever sticks out of a
  panel, mostly half the height of its first and last tick labels. **Gap
  between rows** and **Gap between columns** now set it in points, in the
  Layout section and in the Style panel; left empty it is matplotlib's. At 0,
  panels that share an axis share an edge: the line between them is drawn
  once, and the tick marks and tick labels that would reach across it are
  left out. The script sets the padding and spacing of matplotlib's layout
  engine, and the margin at the figure's edge stays as it was.
- **Panel letters.** (a), (b) and so on in reading order, written as (a), a,
  a), A or (A), inside the top left corner of each panel or outside it, from
  any starting letter, bold or not, at a size of their own; any panel may
  have a text of its own instead. Outside, they are counted in the margins.
- **Insets.** **Add an inset** draws a small panel inside another, with a
  series of its own, placed and sized as shares of its panel. **Mark what it
  enlarges** draws the box of the inset's limits on the panel and two lines
  to the inset's corners (matplotlib's `inset_axes` and
  `indicate_inset_zoom`). An inset takes no room in the layout.
- **Zoom, fit and read-out in every panel.** Dragging in a panel of a grid
  sets the limits of the axes that panel shares; dragging in an inset sets
  what the inset shows, and double-clicking it fits its data again.
- **The script and the exports.** A grid with a panel in every cell is one
  `plt.subplots(rows, cols, ...)`; cells left empty or panels spanning several
  cells make a GridSpec. The preview lays grids out as matplotlib's
  constrained layout does (a margin for each column and row from what its
  panels need, colour bars beside their panels, legends outside), and was
  compared with matplotlib on grids, spans, gaps, letters and insets, on light
  and dark backgrounds: the panels land within a pixel or two.
- **Three more examples:** a 2 by 2 grid with shared axes and letters, three
  spectra stacked with no gap, and a curve with a zoomed inset. The stacked
  bars example now has its legend beside the plot instead of over the bars.
- **The Style panel with many panels.** Past four panels the labels are
  shown one panel at a time, and past five axes the axis is chosen from a
  list; a shared axis is set once for the panels that share it.
- **Fixed: a legend larger than its panel.** matplotlib makes room around a
  panel for a legend that does not fit inside it; the preview did not, so a
  short panel with a long legend was drawn larger than the saved figure had
  it.
- **Fixed: setting one panel's label froze every panel's.** Editing any
  field of a panel in the Style panel copied the labels, scales, limits and
  ticks of all the panels into the style, where they hid the labels of the
  next file. Only the field that was set is kept now.
- **`stemkit-core`:** `figure` gains `layout` (`rows`, `cols`,
  `widthRatios`, `heightRatios`), `sharex`, `sharey`, `panelGap` and
  `panelLabels`; the panel fields `row`, `col`, `rowSpan`, `colSpan`, `inset`,
  `letter`, and `xLabel`, `xScale`, `xLim`, `xTicks` and `xCategories` of its
  own (the figure's are the defaults); and `panelLetters`, `panelEdges`,
  `layoutPads`, `isStack` and `titledPanel`. `figure-python` gains
  `gridLines`, `insetLines` and `gapLines`. `plot-builder` gains
  `builderLayout` and `builderPanels`, and an example may bring a `layout`
  and a `style`.

### Fixed: output

- `[output]` **MD Workflow Generator, LAMMPS check.** `round()` of a negative
  half went away from zero (`round(-2.5)` gave -3; LAMMPS gives -2), and
  `$(...)` could print `-0` where LAMMPS prints `0`. The checker follows
  LAMMPS's own arithmetic.
- `[output]` **MD Workflow Generator, job arrays.** A list such as
  `1-5,10-15%2` was counted as five tasks with no limit, and `10-1` and
  `1-10:0` were accepted. Arrays are read as sbatch reads them: values and
  ranges separated by commas, a step after a colon, one `%` limit at the end,
  each index counted once; what sbatch refuses is refused, with the reason.
- `[output]` **MD Workflow Generator, wall time.** `2-12`, `1-12:30`, `120:00`
  and `100:00:00`, all of which sbatch takes, were replaced by 24:00:00. Every
  form sbatch documents is read. A field outside its usual range (99:99:99) is
  accepted, as Slurm accepts it, with a warning that says what it adds up to.
- `[output]` **MD Workflow Generator, memory.** A value that is not a size
  went into `--mem` unchecked, and a bare number meant megabytes for SLURM and
  nothing for PBS, LSF and Grid Engine. One reader serves all four schedulers:
  a bare number is megabytes everywhere and is written with its unit.
- `[output]` **Scientific Converter, constants.** The length table used the
  1986 Bohr radius while the force table used the 2018 one, and the atomic
  pressure, 1/R, dipole and polarizability factors were rounded. Every factor
  is now worked out from the exact SI constants and the CODATA 2018 Bohr
  radius and Hartree energy, so the tables cannot disagree: 1 nm is
  18.89726125 a0 (was 18.89725989) and 1 Eh/a0³ is 2.942102e+8 bar (was
  2.942105e+8). Each factor is checked against `scipy.constants`.
- `[output]` **Scientific Converter, typed numbers.** "1,5" was read as 15,
  and "0x10" and "Infinity" were taken as numbers. Commas now count only as
  thousands separators where they cannot be anything else (`1,234.5`,
  `1,234,567`); anything ambiguous or not a decimal number is refused with a
  note beside the field, and the other fields are cleared, not left showing
  the last result. A result of exactly 0 is shown as 0; it left its field
  blank, so 273.15 K gave no Celsius value.
- `[output]` **`stemkit-core`, `convert`.** A value converted to its own unit
  comes back exactly (7.5 kJ/mol gave 7.499999999999999), and exact ratios
  come out exact.
- `[output]` **Statistics Calculator, values all alike.** Six values of 0.1
  have no spread, but their mean is not 0.1 in binary and the sums took the
  rounding for data: two such groups gave *t* = -1.2e16 and *p* = 3e-82. The
  variance of equal values is now exactly zero, the independent t-test says
  the statistic is undefined when neither group varies, and pairs that differ
  by the same amount as written (0.2 against 0.1, 0.3 against 0.2) count as a
  constant difference.
- `[output]` **Outlier Detector, constant columns.** A column of one repeated
  value such as 0.1 was scored from the same rounding and given a Grubbs
  statistic. It is reported as having no spread. When the MAD or the
  interquartile range is zero the flags are those the method defines, and the
  page and the script now say what they mean.
- `[output]` **Error Bar Generator, significance level.** Brackets and
  highlighted pairs used 0.05 at every confidence level; they use 1 minus the
  level chosen. The stars keep their thresholds of 0.05, 0.01 and 0.001.
- `[output]` **Error Bar Generator, cells left as text.** `+5` and `1e16`
  were dropped without a word; they are read. A decimal comma (`6,1`), a
  number too large to hold (`1e400`) and other text are counted and shown
  under the data. Two groups of equal values were compared from rounding
  noise; such a pair is no longer tested, and is named.
- `[output]` **Error Bar Generator, p-values.** 0.0099 was printed as
  "p = 0.010" beside `**`, which means below 0.01. A p-value is given the
  digits it needs not to round onto a threshold.
- `[output]` **Curve Fitter, confidence band note.** The note that the band is
  hidden behind the fit line assumed a plot area 0.77 of the figure's height,
  so it could appear while a sliver of the band showed. It uses the panel as
  drawn and measures the band across the curve.
- **Curve Fitter, a fit that runs away.** Fitting `A*exp(-x/tau)` to rising
  data reported tau = 3e12 as an ordinary converged fit. The page and
  `fitModel` now say that a parameter has run away, or that the curve follows
  the data no better than their mean, and what to try. Fits that behave are
  unchanged in every digit.
- `[output]` **XVG Visualizer, files of several data sets.** Sets separated by
  `&` were joined into one line, and the legend of `s1` named a column of the
  first set. Each set is a series under its own legend, numbered as Grace
  numbers them, in the plot and in the script.
- `[output]` **XVG Visualizer, labels and numbers.** `\"` cut a label short
  and `\#{110000}` stopped the page; both are read as Grace reads them. A row
  holding `0x10` was plotted as 16; it is skipped and counted, as
  `numpy.loadtxt` would refuse it. With the data hidden under a running mean,
  the limit on data written into the script was not applied.
- `[output]` **BibTeX Deduplicator, the same title under different DOIs.** Two
  entries titled "Editorial", each with its own DOI, were reported as
  duplicates. Entries whose DOIs differ are not grouped, and a title that two
  or more DOIs share links nothing; those entries are listed under the groups
  as look-alikes. A `doi` field that does not hold a DOI counts as none.
- `[output]` **BibTeX tools, ways of writing a DOI.** `doi:10.…`,
  `www.doi.org`, `dx.doi.org` and links without `https://`, with or without a
  query string, now match the bare DOI.
- **BibTeX Deduplicator.** A scan that fails clears the results of the one
  before and says what failed. Editing the text after a scan marks the results
  as out of date and switches the download off until the library is scanned
  again; the download used to write the library as it was at the scan.
- **DOI to BibTeX.** DOIs in brackets, in quotes, at the end of a sentence
  and in `www.doi.org` links are found. A request that takes longer than 20 s
  is given up with a message, a "too many requests" reply is waited out and
  tried twice more before the batch stops, and a reply that is a web page or
  empty is reported as a failure. The messages name the host that answered.
- `[output]` **Decision Matrix, ties.** Options with equal totals were
  numbered 1 and 2, in an order that followed rounding. They share a rank
  (1, 1, 3), stay in the order entered and are marked as tied; totals show
  two decimals. **Rank the options** names the entries it corrected to the
  range, and a screen reader hears one sentence with the result, not the
  whole card at every keystroke.
### Changed: accessibility

- **Method tabs** on the Scientific Converter, the Statistics Calculator and
  the MD Workflow Generator, and the generator's engine tabs, follow the ARIA
  tabs pattern: one tab stop, the arrow keys, Home and End, each panel named
  by its tab.
- **Scientific Converter.** The definition and source of each unit were shown
  on hover only; they are on a button that works from the keyboard and by
  touch.
- **Upload CSV** on the Error Bar Generator and the Statistics Calculator can
  be reached and opened from the keyboard.

### Changed: tooling

- **Sitemap.** `lastmod` is the date of each page's last commit; it was the
  file's modification time, which stamps a fresh clone with today's date and
  left July dates on pages changed since. `npm run check:sitemap` fails when a
  date is older than its page's last commit.
- **`npm run check:chrome`** fails for a page that is neither in the catalogue
  nor in its list of pages that are not tools, and for a tool page whose
  title, description or JSON-LD name is another tool's.
- **CI** also runs the tests on Python 3.15 with the current numpy, scipy,
  matplotlib and pandas.
- **`stemkit-core`:** `slurm` gains `parseArraySpec`, `parseWallTime`,
  `resolveWallTime`, `resolveMemory` and `slurmMemory`; `units` gains
  `CONSTANTS`; `bibtex` gains `isDoi`, `doiUrl` and `looksLikeBibtex`,
  `parseDoiList` returns `skipped` and `findDuplicates` returns `lookAlikes`;
  `error-bars` gains `readCell`, and `computeGroups` returns what it could
  not read; `xvg-parser` returns each set as a block; `bandVisibility` takes
  the panel as drawn as a fourth argument; `fitModel` warns of a parameter
  that has run away; `detectOutliers` returns `degenerate` and a `warning`.

## v0.4.0 — 2026-10-10

Turning a structure by hand in the Coordinate Manipulator, video tutorials on
the tool pages, and a round of fixes: the `gmx editconf` command, BibTeX
entries the reader used to lose, and inputs at the edges (groups that do not
vary, blank fields, very long columns).

### Added: turning a structure by hand in the Coordinate Manipulator

- **Turn molecule.** The view takes a choice of what dragging turns: the view,
  as before, or the molecule, with the cell and the axes staying where they
  are. The three angle fields follow the drag and the view follows the
  fields, so a rotation is seen before it is applied; **Rotate** applies it
  and **Reset** drops it. A dragged rotation is kept to a tenth of a degree,
  so the angles shown are the rotation applied.
- **What the rotation is.** The panel shows the rotation matrix, the single
  turn about one axis it amounts to, and the angle between the structure's
  long axis (or the normal of a flat one) and x, y and z, now and after the
  turn. **Lay the long axis along** x, y or z sets the smallest rotation that
  does it.
- **Every step as equations and as Python.** Rotations, translations and
  centrings are recorded in order. Under the workspace they are written out
  as equations, each with its matrix or vector and then the one transform
  `r' = M r + d` they add up to, with the LaTeX to copy, and as a script that
  repeats them: on the file with MDAnalysis, or on any array with NumPy. Both
  scripts are run in the tests against the page's own coordinates.
- **The cell and the axes are drawn over the view**, as the Structure
  Inspector draws its box: lines of a constant width, heavier towards the
  viewer, with the x, y and z axes in the corner and the structure's own axis
  through it.

### Added: video tutorials

- **Fifteen tools show a narrated video tutorial** in their "How to use"
  section (the Statistics Calculator, which has none, under its heading), with
  a **Watch the tutorial** link at the top of the page; the home page shows the
  tour. The videos are collected in the
  [STEMKit Tutorials playlist](https://www.youtube.com/playlist?list=PLAqgfbqFf32M).
- **Nothing is fetched from YouTube until play is pressed.** The thumbnails are
  served from the site (`assets/tutorials/`); the player comes from
  `youtube-nocookie.com`, opens inline with captions off, and keeps a link to
  the video on youtube.com. `tools/build-csp.mjs` allows the player's frame on
  the pages with a video, and no others. The privacy page says so.

### Added: why a confidence band cannot be seen

- **Curve Fitter.** With **Confidence band** switched on and nothing to see, a
  note under the plot now says why: the parameters are not independent (as in
  `y = a*b*x`), so the band cannot be worked out, or the band is thinner than
  the fit line and hidden behind it.
- **`stemkit-core`: `bandVisibility(model, style, fit)`** in `plot-style` makes
  the same call, with the same sentence, for a script.

### Changed

- `[output]` **Coordinate Manipulator, `gmx editconf -rotate`.** After several
  rotations the command added the angles axis by axis, which is not the
  rotation that was applied. It now gives the angles of the one rotation the
  steps add up to.
- **Coordinate Manipulator.** The angle fields return to zero once a rotation
  is applied, **Rotate** and **Translate** do nothing with nothing typed, and
  the output buffer and the editconf command can be scrolled from the
  keyboard.

### Changed: accessibility

Every page was checked with axe against WCAG 2.2 A and AA, in both themes.

- **Links** in the reference lists and credit lines are underlined, so they
  are not told from the text around them by colour alone.
- **Scrolling regions** take keyboard focus: the LaTeX table preview and
  source, the Outlier Detector's table, and the Coordinate Manipulator's
  output buffer and command.
- **Plot Digitizer.** A series is picked with a radio button of its own in
  each row; the row, which holds the colour and name fields, was itself the
  control. The arrow keys move between series.
- **Targets of 24 px** for the Plot Digitizer's colour swatches and the
  Scientific Converter's copy buttons.
- **Error Bar Generator.** The equations on the page no longer carry
  `aria-pressed`, which the chart's buttons had passed on to them.
- The notes in two reference lists are at the list's full contrast, and the
  icon named in the Scientific Converter's text is announced as an image.

### Fixed: output

- `[output]` **Visual LaTeX Tables, labels.** A label with an underscore, such
  as the page's own example `tab:my_table`, was escaped like text
  (`tab:my\_table`), which stops LaTeX with "Missing \endcsname inserted". The
  key is now written as typed.
- `[output]` **BibTeX Deduplicator, emphasised words.** Titles that differed
  only in a word inside `\emph{…}`, `\textit{…}` and the like were reported as
  duplicates: the command took the word with it once the braces were gone.
- `[output]` **BibTeX Deduplicator, commands and formulae in titles.** The
  same happened with any other command, so `\ce{NaCl}` and `\ce{KCl}` made two
  titles one, as did titles that differed only in a formula, and titles in a
  script other than Latin that shared their digits. Titles are now compared as
  they are written in the file: a command around text is dropped and its text
  kept, a command that is text (`\LaTeX`) keeps its name, a formula keeps what
  it says, and letters of every script count. Accents are folded, so
  `Schr\"odinger` and `Schrödinger` are the same word, and `$\alpha$` matches
  `α`.
- `[output]` **BibTeX Sanitizer, commands with capitals.** `\LaTeX` in a title
  became `\{LaTeX}`, which prints a stray brace. It is now `{\LaTeX}`.
- `[output]` **BibTeX Sanitizer, commands with arguments, and formulae.**
  `\SI{5}{\nano\metre}` became `{\SI}{5}{\nano\metre}`, which does not
  compile. A command with a capital in its name is now braced together with
  its arguments, `{\SI{5}{\nano\metre}}`, and a formula with a capital is
  braced whole, `{$\Delta G$}`, where `$T$` used to be left to be lowercased.
  Text inside braces is left alone at any depth, and the letters `\AA`, `\O`
  and `\L` are no longer braced, which split the word they were in. The
  result is checked against BibTeX itself in the tests.
- `[output]` **Curve Fitter, which name is the variable.** In
  `signal = A*exp(-time/tau) + c` the offset `c` was taken for the variable.
  Whole words now come before single letters, and a guessed name that is not a
  data column gives way to one that is, so the Hill model on the
  Michaelis–Menten sample varies in `S` and no longer asks for a column `n`.
- **Structure Inspector.** `not:` on a range (`not:z:20-25`) matched nothing;
  it now selects everything outside the range. `Toggle surface` could not
  remove a surface, and changing its type, opacity or colour drew another on
  top; the surface is now replaced.
- `[output]` **Coordinate Manipulator, the `gmx editconf` command.** editconf
  translates, then rotates about the origin, and centres last of all. The
  command put `-center 0 0 0` beside `-translate` after "centre, then
  translate", so editconf undid the move; and for a structure turned about its
  own centre it relied on a note saying that adding `-center 0 0 0` would make
  the two agree, which holds only when the centre is already at the origin. The
  command now lands on the page's coordinates whatever the order of the steps:
  `-center` names where the geometric centre ends up, or `-translate` is the
  move as it has to be made before the rotation. A centring on the centre of
  mass, which editconf cannot do, is given as the geometric centre it leaves.
  **`stemkit-core`: `editconfPlacement(steps, finalCentre)`** in `structure`
  works these out, and is tested against editconf's order of operations.
- **Coordinate Manipulator, typed numbers.** A padding of 0% was read as the
  default 10%, so a box could not be fitted tight to the molecule. A distance
  or an angle that is not a number was applied as 0 without a word; the field
  is now marked, named in a message, and nothing is applied.
- `[output]` **BibTeX tools, entries the reader lost.** A quoted value holding
  a quote in braces, `title = "Outer {"}quoted{"} text"`, was cut at the inner
  quote and every field after it dropped, so the Deduplicator compared and
  showed a damaged entry. An entry with an empty key (`@article{,`, as JabRef
  writes one that has none) was left out of the count and the comparison while
  staying in the download; it is now an entry like any other, shown as
  "No key". In the DOI lookup, removing or keeping fields rewrote an entry
  from the fields read so far, so a value the reader cannot follow
  (`pages = 100 - 110`) took the rest of the entry with it; such an entry is
  now left exactly as it is.
- `[output]` **Statistics Calculator, one-way ANOVA of groups that do not
  vary.** With every group constant (`1, 1, 1` against `2, 2, 2`) the
  within-group variance is zero; the page reported F as not available with
  *p* = 1, "not significant". It now says the test is undefined and why, as the
  t-tests and Welch's ANOVA already did. **`stemkit-core`:** `oneWayAnova`
  returns `F` and `p` as NaN with a `note` in that case, and
  `fUpperTail(Infinity, …)` is 0, not 1.
- **DOI to BibTeX.** The "1 failed" count, the error report and the Retry
  button of one batch stayed on the page while the next batch ran. They are
  cleared when a batch starts.
- `[output]` **Decision Matrix, blank fields.** A weight left blank counted as
  1 and a score left blank as 1, the lowest of each, though the fields start at
  3 and 5. A blank field now counts as the value it started with, and
  **Calculate** writes that value back into it.
- **Very long columns.** About 150,000 values in one group stopped the Error
  Bar Generator with "Maximum call stack size exceeded", and the same limit
  stood in the Statistics Calculator's summary of a sample, the Data Cleaner's
  column transforms, an index-group range and the Structure
  Inspector's solvation of a large solute. All take columns of any length now,
  and the Error Bar Generator no longer slows with the square of the number of
  rows when each row holds one value.

## v0.3.0 — 2026-10-01

Whole MD runs set up and checked: GROMACS and LAMMPS inputs with every line
explained and checked against the programs themselves, and a PLUMED
workbench. Also a curve fitter for any equation, one plot area and Python
script on every plotting page, the Data Cleaner's pandas script, and
continuous integration.

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
  the parameter correlations. The fitted values match
  `scipy.optimize.curve_fit` to better than 1e-7, and the standard errors and
  confidence band to about 1e-6.
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
  and plot style are tabs next to the plot; Data and Model are marked done or
  in need of attention, and a file can be dropped anywhere on the fitter.
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
  one download holds `submit.sh`, the `.mdp` files, `index.ndx` when the
  groups were built, the PLUMED input when a stage runs with PLUMED, and a
  README.
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

- **The GROMACS version you run**: 2025, 2024, 2023 or 2022. The `.mdp`
  files leave out options that release does not read, and the checker applies
  its options, defaults and checks. Every preset passes `grompp` 2022.6,
  2023.5, 2024.6 and 2025.0; Martini 3 and hydrogen mass repartitioning used
  to write options that arrived in 2024, so grompp 2023 stopped on them.

### Added: one plot area and one Python script on every plotting page

- **The same plot area everywhere**: the Curve Fitter, PLUMED "Analyse a
  run", the XVG Visualizer, the Plot Digitizer, the Plot Builder, the Error
  Bar Generator, the Statistics Calculator and the Outlier Detector share one
  header with the figure's true size, one Style panel (size in inches,
  centimetres, millimetres or pixels; fonts and separate title and tick
  sizes; ticks; grid on either or both axes; markers, lines and colours per
  series; legend; a background: white, transparent with dark or light text
  and lines, dark, or your own colour; Publication, Presentation and Minimal
  presets), PDF, PNG and SVG at the true size, and a Python panel. Learn it
  once.
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
- New core modules: `plumed-syntax`, `plumed-parse`, `plumed-atoms`,
  `plumed-analysis` and `plumed-run`; the MD Workflow Generator's PLUMED form
  now calls `plumed`, so the page and the package write the same input.
  `npm run check:plumed` hands every generated input to installed PLUMED
  builds; `npm run build:plumed-syntax` regenerates the tables.

### Added: LAMMPS set-up with every input line explained

- **The LAMMPS tab works like the GROMACS one**: System (a data file, a
  lattice or a restart; force-field presets for CHARMM36, CHARMM22/27, AMBER,
  OPLS-AA, COMPASS/PCFF (class II), TIP3P, SPC/E and TIP4P/2005 water, EAM
  (one element, alloy and Finnis-Sinclair), Tersoff, Stillinger-Weber, ReaxFF
  and a Lennard-Jones fluid in reduced units, or your own lines;
  thermostat, barostat, time step, SHAKE or RATTLE, cut-offs), Stages
  (minimise, NVT, NPT, production, with restraints and output), Groups and
  Job. It writes `in.system`, `in.settings` and one input per stage chained
  by restart files, `submit.sh` and a README, with a note on every line that
  has a choice in it, and one zip holds them all. A job stopped by its wall
  time ends cleanly and carries on from its newest restart when submitted
  again; PLUMED attaches with `fix plumed`.
- **A data file is read in the browser**: counts, box, atom types with
  their elements and charges, the water model and its geometry, the types
  SHAKE holds, CMAP crossterms, net charge and density, and groups for water,
  ions and the solute. It agrees with LAMMPS 29 Aug 2024 on 1081 of 1081 files
  and broken copies (a build with 17 packages).
- **Check an input you already have**: every line explained in the input's
  own units, with a link to the LAMMPS manual, and the line LAMMPS would stop
  on. It agrees with LAMMPS 29 Aug 2024 on every example input and broken copy
  compared, quoting LAMMPS's own message: 806 examples and 479 broken copies
  with a build of 17 packages, 804 and 480 with one of 32 (ASPHERE, BODY, GPU,
  KIM, PLUMED, REPLICA and others).
- **Every command and style, searchable**: kind, package, accelerated
  variants, syntax, keywords and defaults, with a summary in plain words and
  the manual link. The tables hold facts only (LAMMPS is GPL-2.0).
- **Run in LAMMPS**: every preset ran through minimise, NVT, NPT and
  production on 2 MPI ranks, including stopped and continued runs with and
  without PLUMED.
- New core modules: `lammps-reference`, `lammps-input`, `lammps-data` and
  `lammps-workflow`; `npm run check:lammps`, `check:lammps-data` and
  `check:lammps-workflow` compare them with an installed LAMMPS (`LMP_BIN`),
  and `npm run build:lammps-docs` regenerates the reference tables from a
  LAMMPS source tree.

### Added: continuous integration

- GitHub Actions runs the tests and the smoke test on Node 18, 22 and 24, and
  the site checks, on every push to main and every pull request. The README
  shows its status, the npm version and the Zenodo DOI. The smoke test now
  reaches 28 of the 44 modules.
- A second job installs Python and runs the tests that check the scripts with
  matplotlib, twice: on current releases, and on matplotlib 3.6.3 with Ubuntu
  24.04's numpy, scipy and pandas.

### Added: smaller pieces

- **A background for every figure**: white, transparent (with dark or light
  text and lines), dark, or your own colour, for any export format; it
  replaces the Dark preset.
- New core module `zip`: uncompressed zip archives of text files, used by the
  MD Workflow Generator's "Download all".
- **The version on every page**: the footer names the release and its date
  and links to this changelog; `src/core/version.js` exports the same.
- **A Content-Security-Policy on every page**, so the browser itself refuses
  anything from another host; inline scripts are allowed by hash only. The
  only exceptions are the DOI registration agencies DOI to BibTeX asks and the
  RCSB PDB the Structure Inspector fetches from.

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
- The footer carries a new credit line, written as `.mdp` lines.
- The Statistics Calculator says, with references, that choosing a test from
  a normality test on the same data is contested, and the suggestion links to
  how it is made.
- The Journal Abbreviator marks results from the ISO 4 rules apart from the
  built-in list, so you know which to check.
- The unit converter loads its own module only, not the whole library.
- `robots.txt` no longer hides the stylesheets and scripts from search engines,
  and the home page's canonical address is the site's root.
- `[output]` **`parsePDB` reads the first model of a multi-model PDB**, as
  GROMACS and PLUMED do, and says how many it skipped (`modelCount`,
  `warnings`); pass `{ models: 'all' }` for the old behaviour. It keeps
  four-letter residue names (POPC, TIP3) and residue number 0, and `parseGRO`
  reads files written at any precision. Selections take the box (`box`,
  `boxVectors`) and measure `within:` to the nearest periodic image, matching
  `gmx select`.

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
- `[output]` **PLUMED units.** Switching-function cut-offs (R_0 and D_0 of
  SMAC, FCCUBIC, ANGLES, CONTACTMAP and INPLANEDISTANCES) did not follow
  UNITS LENGTH, so `R_0=0.5` silently meant 0.5 Å. Restraint, wall,
  moving-restraint and ABMD values (AT, KAPPA, SLOPE, OFFSET, TO) now follow
  a change of UNITS like the grid and SIGMA do; the same bias written in
  nm with kJ/mol and in the page's Å with kcal/mol gives the same energy in
  PLUMED 2.11 to 1e-12. Counts start on grids sized from their atom lists (the
  old 0–20 grid made PLUMED stop on larger counts), and changing the biased
  component resets its starting values.
- **GROMACS pulling:** with a structure loaded, the page works out the
  distance between pull groups as grompp does and says when grompp will stop
  because it exceeds 0.49 of the box, with the fix; it agrees with grompp
  within 0.0015 nm.
- **GROMACS launch** (the page and `generateScript`): the thread-MPI `gmx`
  gets `-ntmpi 1` (it started a rank per visible core and oversubscribed
  shared nodes), and a job without GPUs gets `-nb cpu` (it took a GPU the node
  showed but the job did not ask for). On the page, threads are pinned with
  `-pin auto` rather than `-pin on`, which pinned from core 0 whatever the
  scheduler gave. A placeholder 1 Å `CRYST1` line is read as no box.

### Fixed: output

- `[output]` **Force conversions.** eV/Å was off by a factor of 10 and
  Hartree/Bohr by about 25: 1 eV/Å gave 96.5 kJ mol⁻¹ nm⁻¹ instead of 964.9,
  and 1 Eₕ/a₀ gave 3.35×10⁻⁹ N instead of 8.24×10⁻⁸. The other units were
  right. A test now derives every force unit from the energy and length
  tables.
- `[output]` **Small-sample rank tests.** Mann–Whitney and Wilcoxon used only
  the normal approximation, so complete separation of triplicates gave
  p = .0495 where the exact test cannot go below .10. They now follow SciPy's
  defaults: exact p for Mann–Whitney without ties when a group has 8 or fewer
  values, and for Wilcoxon without ties or zeros up to 50 pairs; an exact
  permutation test for Wilcoxon with ties or zeros up to 13 pairs; and the
  normal approximation otherwise, now with the tie correction to Wilcoxon's
  variance. The result says which was used, and the Python script asks SciPy
  for the same. Far-tail p-values (below about 1e-5) of the normal
  approximation are now accurate.
- `[output]` **Figure scripts on current matplotlib.** On matplotlib 3.8 and
  later a shared log x axis with data at or below 0 started lower than the
  preview showed (0.007 instead of 0.21 in one case), and on 3.8 to 3.10 error
  bars on a log axis set wrong limits. The scripts now give the same axis
  limits on every matplotlib from 3.6 to 3.11, and the preview follows 3.11's
  ticks and legend placement.
- **ISO 4 abbreviations.** The rules dropped section letters ("Journal of
  Physics A" → "J. Phys.") and misread hyphenated LTWA patterns ("Phase
  Transitions" → "-ph. Transitions"). They now agree with the built-in list on
  169 of 184 titles (150 before), never produce a malformed word, and the 15
  differences left are ones where the official abbreviation departs from
  ISO 4.
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
  PATHMSD, which has `.sss`. All 311 generated inputs now parse in
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
