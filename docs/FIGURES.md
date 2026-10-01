# Figures

Every plotting page shows its figures the same way: one plot area with the
same header (title, size of the saved figure, the page's own switches, Style,
PDF, PNG, SVG), the same preview of the figure at its saved size, the same
style panel and the same Python panel. The preview draws what matplotlib
will draw from the script, down to the tick positions and the legend's place.
The scripts run on matplotlib 3.6 and later; the preview follows the newest
rules (3.11), and [matplotlib versions](#matplotlib-versions) lists what an
older matplotlib draws differently.

| File | What it is |
|---|---|
| `src/core/figure.js` | The figure description: normalising, the person's style over the page's description, colours, colormaps, box and histogram numbers. No DOM. |
| `src/core/figure-python.js` | The matplotlib script for a description (`figureScript`), and the pieces it is made of. No DOM. |
| `js/figure-plot.js` | The preview (`buildFigure`, `renderFigure`), the export (`exportFigure`), the style panel (`createFigureStylePanel`) and the plot area (`mountFigure`). |
| `js/python-panel.js` | The Python panel (`createPythonPanel`), shared with the tools that write scripts. |
| `src/tools/figure.css` | The plot area, the preview's frame, the panel and the style drawer. |
| `js/fit-plot.js`, `src/core/fit-python.js` | The Curve Fitter's layer on top: its style object becomes a description, its script draws the figure with the shared pieces. |

## A page adopts the component

The page links the styles and Plotly, gives the plot area a host (and, if it
likes, a host for the Python panel), and calls `update` whenever its data
change.

```html
<script defer src="js/dependencies/plotly.min.js"></script>
<link rel="stylesheet" href="src/tools/figure.css">
<link rel="stylesheet" href="src/tools/python-panel.css">

<section id="plot" aria-label="Collective variable"></section>
<div id="python"></div>
```

```js
import { mountFigure } from './figure-plot.js';

const STYLE_KEY = 'stemkit.my-page.figure';
let stored = {};
try { stored = JSON.parse(localStorage.getItem(STYLE_KEY) || '{}'); } catch (e) { stored = {}; }

const plot = mountFigure(document.getElementById('plot'), {
  title: 'Collective variable',
  style: stored,                                      // the person's look, from the last visit
  onStyleChange: (style) => { try { localStorage.setItem(STYLE_KEY, JSON.stringify(style)); } catch (e) {} },
  empty: { title: 'Your run will appear here', text: 'Load a COLVAR file.' },
  toggles: [{ id: 'showMean', label: 'Running mean', checked: true, onChange: (on) => { state.mean = on; redraw(); } }],
  python: {
    host: document.getElementById('python'),
    filename: 'colvar_plot.py',
    sources: [{ id: 'files', label: 'Read COLVAR' }, { id: 'embed', label: 'Data in the script' }],
    files: { colvar: { file: 'COLVAR', format: 'table' } }
  }
});

function redraw() {
  plot.update({
    xLabel: 'Time (ps)',
    export: { filename: 'colvar' },
    panels: [{
      yLabel: '$d$ (nm)',
      series: [
        { id: 'cv', kind: 'line', label: 'Distance',
          x: { values: time, source: 'colvar', column: 'time', name: 'time' },
          y: { values: d1, source: 'colvar', column: 'd1', name: 'd1' } },
        { id: 'mean', kind: 'line', label: 'Running mean', lineStyle: 'dashed', show: state.mean, x: time, y: mean }
      ]
    }]
  });
}
```

That is all a page needs. The component draws, sizes and notes the figure,
keeps the Style button, the panel and the exports working, writes the script
into the Python panel on every change, and hands back:

| Call | Does |
|---|---|
| `update(figure or null)` | Draws a new description; `null` shows the empty stage. Returns a promise of the drawing's `info`. |
| `setStyle(style)`, `getStyle()` | The person's look, a partial object (see below): restore it, or read it to store. |
| `export('pdf' \| 'png' \| 'svg')` | Saves the figure (the buttons do this). |
| `openStyle()`, `openStyle({ series: id })`, `closeStyle()` | Shows the style panel (the Style button does this); with a series id, opens its Series group on that series. The panel alone: `createFigureStylePanel(...).showSeries(id)`. |
| `setToggle(id, { checked, hidden, disabled })` | Updates one of the header's switches. |
| `setTitle(text)` | A new title for the header; the style drawer's title ("Style: <title>") follows. Option `styleTitle` (text, or `(figure) => text`, asked again on each `update`) sets the drawer's title outright. |
| `info()`, `figure()`, `script()` | The last drawing's info, the figure as drawn (normalised, style applied), the script. |
| `destroy()` | Removes what the component made. |
| `element` | The host. |

Other options of `mountFigure(host, options)`: `titleId`; `styleDrawer: { side: 'left' }` for a page whose figure sits on the right (the drawer then opens on the left; a phone still gets the sheet from the bottom); `framed: false`
inside a page's own panel (no card); `styleHost`, an element to hold the style
panel (a tab or a side column; without one the panel opens in a drawer, a
sheet from the bottom on a phone); `onStyle`, to do something else when Style
is pressed; `maxScale` (a number, or a function), the largest enlargement of
a small figure; `label`, what the figure shows, for screen readers;
`onExport(result, error, format)`, for a toast; `onDraw(info)`;
`stylePanel: false`, when the page styles the figure itself and passes
complete descriptions (the Curve Fitter does this, with the shared panel in
its Style tab and `onStyle` opening it).

Also `title` (the header's; 'Plot' by default), `figure` (a first description
to draw), `styleButtonId`, and `empty.icon` and
`empty.action: { label, icon, id, onClick }` (a button on the empty stage).
`python` also takes `title`, `headingLevel`, `source` (the source shown
first), `onSourceChange(id)`, `note` (text, or `(figure, source) => html`, for
the line under the script), `empty`, `header` (passed to `figureScript`) and
`create` (a `createPythonPanel` to use instead).

The page may also write the header and the empty stage in its HTML, so they
show before any script has run: when the host already holds a `.fg-h`, the
component takes the parts it finds (`.fg-size`, `[data-fg-style]`,
`.fg-export [data-export]`, `.fg-stage`, `.fg-empty`, `.fg-figure`,
`.fg-notes`, the `.fg-toggle` inputs) instead of making them. See the plot
section of `curve-fitter.html`.

`python.filename` pins the file name the Python panel shows; without it the
panel shows `python.initialFilename` (or `figure.py`) until there is a figure,
then the figure's export name with `.py`.

The Python panel's sources are the ids `'embed'` (every number in the script)
and `'files'` (fields that name a column of one of `python.files` are read from
the person's file; the rest are embedded). Make `'files'` the first source when
the data are large: 100 000 points embedded make a 3 MB script, and every stage
(normalising, the preview, the script) takes a million points in a second or
so. For a script the page writes itself, pass `python.script(figure, source) =>
text`; for code the figure needs first (a free-energy surface computed from
HILLS, say), pass `python.prelude` (lines) and `python.imports`, and give the
fields that use it `{ values, py: 'fes' }`.

`figureScript(figure, options)` takes the following. `python` passes on
`files`, `header`, `imports` and `prelude`, and `data` from the chosen source.
For `after` or `names`, write the script with `python.script`, as the Error Bar
Generator does.

- `data: 'embed' | 'files'`, `files: { <source id>: { file, format: 'csv' | 'table', delimiter } }`
- `header` (the first comment lines), `imports` (more import lines); the
  header's "Needs …" line lists what the script imports
- A script of a large data set embedded is written once: its numbers are
  kept by content, so a style change rewrites the script in a fraction of the
  time (1.6 million numbers: 0.65 s the first time, about 0.15 s after). The
  Python panel shows a script of megabytes after the edits settle.
- `prelude`: Python lines in the Data section. The section is written in this
  order: the file readers and the data read or embedded; then the prelude,
  which may use them; then the lines worked out from the fields (a histogram's
  `np.histogram`, a box plot's list of groups), which may use names the
  prelude defined.
- `after`: Python lines (or `(axes) => lines`, given the panels' axes names,
  top first: `['ax']`, `['ax', 'ax_bias']` …) written after every panel's
  series and before the colour bars and the Axes section, for annotations the
  prelude worked out (brackets from tests recomputed in Python, say). In scope
  there: `fig`, the axes names, `np`, `plt`, `matplotlib`, `ticker`, `stats`
  when a box plot shows its mean, every data name of the Data section, and
  whatever the prelude defined. The script never takes a name the prelude or
  `after` assigns (or one listed in `options.names`): a series with the id
  `fit` is drawn as `fit_2` when the prelude has a `fit`, and the box plot's
  loop uses `_position`, `_values`, `_mean`, `_half` and `_jitter`. The header's
  "Needs …" line lists every package the script imports, the page's
  `imports`, prelude and `after` included. What they draw counts for matplotlib's
  autoscaling as any `ax.plot` does, but the preview does not see it: put the
  same annotation in the description too (a `bracket` or `text` series), or
  set `yLim`.

## The description

Everything is optional; `normaliseFigure` fills in the rest, as
`normalisePlotStyle` does for a plot style, and every look field means what it
means in `src/core/plot-style.js`.

```js
{
  // The look of the whole figure (plot-style's fields and defaults)
  width: 6.4, height: 4.8, dpi: 300,                    // inches; dpi for PNG
  sizeUnit: 'in',                                       // in | cm | mm | px: how the panel shows the size (px at dpi)
  fontFamily: 'sans-serif', fontSize: 11,               // axis labels; ticks 1 pt smaller, title 1 pt larger
  titleSize: null, tickSize: null,                      // points of their own; null follows fontSize
  title: '', background: '#ffffff', foreground: '#1a1a1a',
  legend: { show: true, position: 'best', frame: true, fontSize: 10, title: '', columns: 1 },
  grid: { show: false, minor: false, color: '#b0b0b0', alpha: 0.5, style: 'solid', width: 0.6,
          axis: 'both' },                               // both | x (lines at the x ticks) | y
  spines: { top: true, right: true, width: 0.8 },
  export: { format: 'pdf', filename: 'figure', transparent: false, tight: true },
  colormap: 'viridis',                                  // for images and contours without their own

  // The x axis, shared by the panels
  xLabel: '', xScale: 'linear', xLim: [null, null], xTicks: { /* as plot-style */ },
  xCategories: null,                                    // ['Control', 'Drug A']: groups at 0, 1 …

  // Panels, top to bottom
  panels: [{
    id: 'main', name: '',                               // name: how the style panel calls it
    ratio: 1,                                           // height relative to the others
    yLabel: '', yScale: 'linear', yLim: [null, null], yTicks: { /* as plot-style */ },
    legend: { show: null, position: null, order: [] },  // null: the figure's; order: series ids first
    series: [ /* see below */ ]
  }]
}
```

Text follows matplotlib's rule: maths between `$` signs (`'$\\Delta G$ (kcal/mol)'`).

### Series

Every series has `id` (give one: the person's style is kept by id; any
text, dots and spaces included), `kind`,
`show`, `label` (the legend's text; empty: not in the legend), `legend`
(false: never in the legend), `color`, `alpha` and `zorder` (the script's
drawing order; the preview draws in the order given). A series with no colour
takes the next of the cycle, as matplotlib's property cycle does; a series
with a colour of its own does not use one up, so a page that sets
`color: '#e8590c'` on one series and leaves the next to the cycle gets that
colour twice: set every colour, or none. Series are
drawn in the order given, except that heatmaps and contours are always drawn
first (under everything, as Plotly draws them).

A data field is an array of numbers, or
`{ values, name, source, column, py }`: `values` is what the preview draws,
`name` the Python name to embed them under, `source`/`column` the file and
column the script reads them from (a header or a PLUMED `#! FIELDS` name, or a
number from 0), `py` a Python expression already defined by the prelude.

| kind | Data | Look | Python |
|---|---|---|---|
| `line` | `x`, `y` | `lineWidth` 1.5, `lineStyle` solid · dashed · dotted · dashdot, `marker` (none), `size` 6, `step` pre · mid · post | `ax.plot` |
| `scatter` | `x`, `y` | `marker` o · s · ^ · v · D · x · + · ., `size` 6, `edgeColor`, `edgeWidth` 1 | `ax.plot(..., linestyle='none')` |
| `errorbar` | `x`, `y`, `yerr` and/or `xerr`: one array (symmetric) or `[below, above]` | as scatter (`marker` may be `none`), `errorWidth` 1, `capSize` 0 (points either side), `lineStyle` (none; set one to join the points, `lineWidth` 1.5) | `ax.errorbar` |
| `band` | `x`, `lower`, `upper` | `alpha` 0.2, `edgeWidth` 0; gaps (NaN) split it | `ax.fill_between` |
| `bar` | `y` (heights), `x` (positions; default 0, 1, 2 …), `yerr` | `width` 0.8 of a place, shared by the bars of a panel standing side by side (`group: false` to overlap); `bottom` 0; `edgeColor`, `edgeWidth` 0; `capSize` 3, `errorWidth`, `errorColor` (the foreground) | `ax.bar` |
| `histogram` | `values` and `bins` (a number, or the edges), `density`; or `counts` and `edges` | `histtype` stepfilled · step · bar, `alpha` 0.6, `edgeColor`, `edgeWidth` | `np.histogram`, then `ax.stairs` (or `ax.bar`) |
| `box` | `groups`: arrays, or `{ values, position }` | `width` 0.5, `whis` 1.5, `fliers` (outliers), `points` (each value, spread the same way every time), `pointSize` 4, `jitter` 0.3 of the width, `mean` (the mean and its Student's t interval at `level` 0.95), `meanOffset`, `faceAlpha` 0.25, `medianColor`, `lineWidth` 1 | `ax.boxplot(patch_artist=True)`, `scipy.stats` for the interval |
| `heatmap` | `x`, `y` (cell centres), `z` (rows along y: `z[j][i]` at `x[i]`, `y[j]`); from a file listed point by point, `z: { values, source, column, x, y }` (the columns of z, x and y) | `colormap`, `vmin`, `vmax` (null: the data's), `colorbar: { show: true, label }` | `ax.pcolormesh(shading='nearest')`, `fig.colorbar` |
| `contour` | as heatmap | `filled`, `levels` (about this many, or the list), `colors` (one colour for the lines, the foreground by default; `null`, or a `colormap` of the series' own: the colormap), `lineWidth` 0.8 (0 for filled), `lineStyle`, `colorbar` (filled only) | `ax.contour` / `ax.contourf` |
| `hline`, `vline` | `y` / `x` | `lineWidth` 1, `lineStyle` dashed, colour the foreground | `ax.axhline` / `ax.axvline` |
| `axline` | `points: [[x0, y0], [x1, y1]]`, or one point and `slope` | as hline | `ax.axline` |
| `text` | `x`, `y`, `text` | `coords` data · axes, `ha` left · center · right, `va` baseline · bottom · center · top, `fontSize`, `rotation` 0 · 90 | `ax.text` |
| `bracket` | `x1`, `x2`, `y` (its foot), `height` (default 2.5% of the panel's data), `text` ('*', 'n.s.' …) | `lineWidth` 1, `fontSize` | `ax.plot` and `ax.text` |

Colour: the default cycle is `#1f5c96 #e8590c #0f9d76 #b87a00 #d55181
#2f8f2f #7b61c9 #d64545` on a light figure and the same hues stepped for a
dark one (`colorCycle(background)`); adjacent pairs are at least ΔE 8 apart
for deutan, protan and tritan readers and 18 for everyone else, and each has
3:1 contrast on the figure's background. Past three series on one scatter,
give each its own marker too. Colormaps: `viridis`, `cividis`, `plasma`,
`magma`, `inferno`, `turbo`, `coolwarm`, `RdBu_r`, `RdYlBu_r`, `Blues`,
`Greys`, matplotlib's own tables.

### The style panel

The figure panel opens on the background, then three look presets and a
reset, then the Curve Fitter's groups, in its order: Figure, Title and labels,
Axes and ticks, then Series (one series at a time) and Panels (heights, with
two or more), then Legend, Grid, Frame and Export.

**Background.** Four swatches in one row, a radio group (arrow keys move and
choose): White, Transparent, Dark and Custom, each a little plot on its
ground. One click switches in any direction:

- White: background `#ffffff`, text and lines `#1a1a1a`, grid `#b0b0b0`.
- Dark: background `#0f172a`, text and lines `#e2e8f0`, grid `#64748b`.
- Transparent: no background in the preview or in any export (a PNG with
  alpha, an SVG and a PDF with no page or axes fill, and the script's
  `savefig(..., transparent=True)` whatever the format). It asks for the ink:
  dark text and lines (for light slides and pages), or light text and lines
  (for dark slides). The preview then shows the figure over checks in the
  colours of that ground, which are never saved, and the header shows a
  Transparent badge by the size.
- Custom: a background and a text-and-lines colour; the ink follows the
  background (dark or light, whichever has more contrast) until it is set by
  hand.

Series with a colour of the default cycle move to the same hue of the other
cycle when the ground turns dark or light, and back; so White after Dark (or
after a transparent page in light ink) is exactly White again, and a style
that only went there and back is empty. Stored styles need nothing new: the
choice is read from `background`, `foreground` and `export.transparent`
(`backgroundChoice(look)`), so a style saved with the old Dark preset shows as
Dark. The same functions are in `src/core/figure.js` for a page or a test:
`withBackground(style, figure, choice, { ink, background, foreground })`,
`backgroundChoice(look)`, `readableInk(background)` and `BACKGROUNDS`.

Presets change the look only (never the background): Publication,
Presentation and Minimal. Sizes: single column, double column, slide, square
(4 × 4 in) and the default; width and height typed in in, cm, mm or px (px at
the PNG resolution), kept in inches. Title and tick-label sizes of their own;
grid lines at both axes' ticks or one; the PNG resolution always in view (the
header's PNG button uses it whatever the format). Error-bar series the page
joins with a line get its style and width. `showSeries(id)` opens the Series
group on one series and `open(group)` any group.

A page whose description is its own style (the Curve Fitter's plot style)
passes `absorb(change)`: every change is handed to it as a partial style,
which it folds into its own and answers with the new description. Such a page
may also pass `page: { read, put }` for fields of its own (paths `page.…`,
made with the kit in `seriesOptions(q).extra(kit)` or `groups(kit)`),
`seriesOptions(q)` (false to leave a series out, or the fields it offers, its
name, placeholders), `fixedPanels` (panels whose y label, axis and height it
sets), `omit` (fields not to offer), `seriesTitle`, `summaries(sums)` and
`onReset()`. The panel is rebuilt only when the panels or series change,
keeping the open groups and the focus.

### The person's style

The style panel edits a partial object laid over the page's description
(`applyStyle(figure, style)`); fields it does not name keep the page's values,
so new data keep the person's choices. Its shape:

```js
{ width, height, …, xLabel, xScale, xLim, xTicks, …,      // any figure look field
  panels: [{ yLabel, yScale, yLim, yTicks, ratio, legend }],   // by index
  series: { cv: { color, label, lineWidth, marker, … } } }    // by id
```

`cleanStyle(style)` drops anything that is not look, for a stored style.
The colours the cycle gives are settled on the page's description first, so
recolouring one series never moves the others.

## What the preview cannot show exactly

The preview lays out the figure as matplotlib does, with matplotlib's rules
ported (locators, formatters, constrained layout and colour bars, the "best"
legend, autoscaling with sticky edges, contour levels, colormap lookups, box
statistics, histogram bins). Checked against matplotlib by
`tests/figure-python.test.js`, which runs the scripts of thirteen figures and
compares matplotlib's axis limits, ticks, tick labels and legend places with
the preview's: lines with a band, steps, reference lines and a note; error
bars in x and y with a diagonal and a two-column legend; grouped bars with
error bars and a bracket; box plots with points and means; histograms; a
heatmap with contours and a colour bar; filled contours at chosen levels; a
log x axis shared by two panels; log axes over many decades and over one;
error bars and bars on log axes; "best" legends beside a band and beside a
note; and two panels of a time series on log axes. Each page's figure tests
compare the axis limits of its own figures. What differs:

- Text is measured from the browser's fonts; matplotlib snaps text to device
  pixels at the output's dpi, so a legend or a label can sit a pixel away.
- TeX: stacked fractions are shown as a/b, roots without the bar, no
  accents (`\hat`, `\bar`); an unknown command is shown as typed. The notes
  under the figure say so.
- Plotly's triangles are a little wider and flatter than matplotlib's; the
  preview matches their area.
- Contours are traced by Plotly on the same grid: the lines agree, the
  smallest loops can differ by a fraction of a cell, and where the grid has
  gaps (NaN) the bands are trimmed a little differently.
- Heatmaps are drawn by Plotly in the preview (on a log x axis the cells are
  placed approximately) and as vector cells in the exports.
- Text placed on the axes is drawn above the legend, since Plotly draws all
  text above shapes; the script gives such text `zorder=6`, above the
  legend's 5, so that matplotlib agrees.
- Colour bars exist for heatmaps and filled contours, one per panel; line
  contours have none.
- One y axis per panel: there is no twin (right-hand) y axis. Two measures of
  different scale go in two panels sharing x.
- Lines a script draws through `after` are not in the preview.
- Lines longer than about four points per pixel are thinned in the preview to
  the lowest and highest point of each pixel column (the same drawing); the
  script keeps every point.
- Markers past 4 000 in a series are drawn once per device pixel of the render
  target (the preview at its own scale and the screen's pixel ratio; a PNG at
  its dpi; PDF and SVG as at 600 dpi): a marker whose centre falls in a pixel
  that already holds one of the same series (with error bars of the same
  lengths) is left out, which draws the same picture. In the preview a cloud
  still denser than about 20 000 markers a series is matched on a coarser grid
  of a few device pixels, so that a redraw takes well under a second (400 000
  points: about 0.6 s in Chrome, where Plotly took some 20 s). The script keeps
  every point.
- On dense data (hundreds of thousands of points) the "best" legend can land
  one place away from matplotlib's: hundreds of points sit on the legend's
  edge, and a pixel of font metrics tips the count. Past 20 000 points the
  preview counts a location as a tie when its count is within 0.2% of the
number of points of the fewest, and takes the
  first in matplotlib's order, which agrees more often; set the position when
  it matters.

## The pages

Every plotting page shows its figures through the component. What each
draws, where its description is built, and what its Python reads:

| Page | Figures | Built in | Python |
|---|---|---|---|
| Curve Fitter | The data with error bars, the fitted curve, its confidence band, and the residuals in a panel below; the page's own switches (Residuals, Confidence band) in the header; the shared figure panel in the Style tab, editing the fit's plot style (`createStylePanel` in `js/fit-plot.js`): data points, fit line and confidence band are its series, with error bars, the curve's points and the band's level beside them, and a Residuals group; `openStyle({ series: 'data' \| 'fit' \| 'band' \| 'residuals' })` opens the tab there | `js/fit-plot.js` (`fitFigure`), `src/core/fit-python.js` | Fits the model again with `curve_fit` and draws with the shared pieces; embeds the data or reads the page's CSV |
| PLUMED "Analyse a run" | Six figures: the COLVAR time series, a histogram, the reweighted FES, the 1D or 2D FES with contours and a colour bar, convergence over time, hill heights | `src/core/plumed-analysis-figures.js` | Reads COLVAR and HILLS itself, with `analyse_plumed.py`'s functions in the prelude |
| XVG Visualizer | Lines and markers from an .xvg; any column switched to the lower panel, sharing x; a running mean (`numpy.convolve` in the script); Grace escapes as mathematics (`\xa\f{}` as $\alpha$, `\S2\N` as a superscript) | `xvgFigure` in `src/core/xvg-parser.js` | Reads the .xvg with `np.loadtxt`, or holds the numbers (up to 60 000; a larger file is read instead) |
| Plot Builder | A rail with Data, Series and Style tabs beside the shared plot area; several CSV files; series as line, points or both, with error bars, bands and panels; Log x and Log y switches in the header; drag to zoom, double-click to fit and hover values on top of the shared preview (the builder's own) | `src/core/plot-builder.js` | Reads each CSV by its header (Python's csv and float rules) or embeds it; PDF, PNG and SVG from the header |
| Plot Digitizer | The digitised datasets as lines and markers, one panel or stacked; the plot area under the workspace | `digitizerFigure` in `src/core/digitizer.js` | Reads the CSV the page saves, or holds the points |
| Error Bar Generator | Bars or points with SD, SEM or CI, the replicates, and Holm-corrected Welch brackets | `src/core/error-bars-figure.js` | Embeds the replicates and computes the tests in the prelude; the brackets are drawn through `after` |
| Statistics Calculator | Box plots with the points and the mean with its interval, pair lines, the μ₀ line, scatter with the least-squares line | `src/core/statistics-figure.js` | Runs the test again, then draws |
| Outlier Detector | The values by row, the flagged ones marked, and the rule's centre and threshold lines (a Threshold lines switch in the header) | `src/core/outliers-figure.js` | Reads the column from the person's CSV or holds the values; flags them by the page's rule, runs Grubbs' test with scipy and prints what it found, then draws |

## matplotlib versions

The scripts run on matplotlib 3.6 and later. Where matplotlib has changed its
rules, the preview follows the newest, 3.11, and the script says so in its
header: `# Needs numpy and matplotlib 3.6 or later (3.11 or later to match the
preview).` Two differences the script removes itself, so every version draws
the same:

- A log x axis shared by panels whose data reach 0 or below starts at the
  smallest positive x of all the panels from 3.8 on; 3.6 and 3.7 took the top
  panel's alone (the lower one's 0.01 against the top one's 0.25 starts the
  axis at 0.007 rather than 0.21). The script tells every panel the shared
  value (`axes.update_datalim`) before it sets the scale.
- From 3.8 to 3.10, error bars drawn on an axis that is already logarithmic
  have their limits taken in log units (`vlines` and `hlines` go through
  `Collection.get_datalim`, mended in 3.11), so the axis can miss the data.
  The script sets the log scales once everything is drawn.

The rest cannot be set from the script, and an older matplotlib draws them its
own way:

| Before | What it draws differently |
|---|---|
| 3.11 | A log axis that spans more decades than it has room to label ticks other decades (3.11 ticks as many as fit, on multiples of the stride; 3.8 to 3.10 took `decades // numticks + 1` from below the view, 3.6 and 3.7 `(decades + 1) // numticks + 1`). A log axis with at most one decade tick inside labels some of its minor ticks from 3.11 on (before, only when it spanned at most one decade): an axis from 4 to 60 labels 4, 6, 20, 30, 40 and 60 as well as 10, where 3.10 labels 10 alone. |
| 3.9 | The "best" legend leaves bands (`fill_between`) and text on the axes out of its count, so it can sit over them. A sticky edge (a bar's base) just beyond the data stops the margin when it is within 1e-5 of the axis's largest value, not of its range. |
| 3.8 | Minor ticks on a linear axis (minor ticks or a minor grid on) leave out one that falls exactly on an end of the axis, as the 5% margins often make one. |
| 3.7 | The "best" legend counts a histogram's steps and a box by their boxes, not their outlines; a line contour with no level inside the data is drawn at the lowest value. |

matplotlib 3.11's wheels also render text with a newer FreeType: labels sit
up to a pixel away from where 3.10 puts them, which the preview, measuring
the browser's fonts, cannot tell apart anyway. And `fill_between` returns a
`FillBetweenPolyCollection` (a `PolyCollection`) from 3.10 on.

## Checking a page

`npm test` runs `tests/figure.test.js`, `tests/figure-plot.test.js` and
`tests/figure-python.test.js`, and each page's figure tests (`xvg-figure`,
`digitizer-figure`, `plot-builder`, `error-bars-figure`, `statistics-figure`,
`outliers-figure` and `plumed-analysis-figures`, each
`tests/<name>.test.js`). When python3 with numpy, scipy and matplotlib is
installed, they run the scripts and check what matplotlib draws against the
preview; without it they are skipped. The tests run the `python3` first on
the PATH (the data-cleaning tests take `STEMKIT_PYTHON` first), so to check
another matplotlib, put a virtual environment's `bin` first:

```sh
python3 -m venv /tmp/mpl && /tmp/mpl/bin/pip install numpy scipy matplotlib pandas
PATH=/tmp/mpl/bin:$PATH npm test
```

Ticks and labels on log axes are compared with matplotlib 3.11 and later
only, minor ticks on linear axes with 3.8 and later, and "best" legends with
3.9 and later; axis limits with every version. CI runs `npm test` with the
current numpy, scipy, matplotlib and pandas, and with matplotlib 3.6.3 (numpy
1.26.4, scipy 1.11.4, pandas 2.1.4, as Ubuntu 24.04 has them); checked by
hand with 3.6.3, 3.7.5, 3.8.4, 3.9.4, 3.10.9 and 3.11.2.

For a page, open it at 1280 and 390 px wide in both themes. Check the console
for errors, the page for sideways overflow and the text for contrast. Then
export a PNG from the page, run the page's script, and compare the two side
by side.
