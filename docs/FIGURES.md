# Figures

Every plotting page shows its figures the same way: one plot area with the
same header (title, size of the saved figure, the page's own switches, Style,
PDF, PNG, SVG), the same preview of the figure at its saved size, the same
style panel and the same Python panel. The preview draws what matplotlib 3.6
will draw from the script, down to the tick positions and the legend's place.

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

Other options of `mountFigure(host, options)`: `titleId`; `styleDrawer: { side: 'left' }` for a page whose figure sits on the right (the drawer then opens on the left; a phone still gets the sheet from the bottom); `framed: false`
inside a page's own panel (no card); `styleHost`, an element to hold the style
panel (a tab or a side column; without one the panel opens in a drawer, a
sheet from the bottom on a phone); `onStyle`, to do something else when Style
is pressed; `maxScale` (a number, or a function), the largest enlargement of
a small figure; `label`, what the figure shows, for screen readers;
`onExport(result, error, format)`, for a toast; `onDraw(info)`;
`stylePanel: false`, when the page styles the figure itself and passes
complete descriptions (the Curve Fitter does this).

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

`figureScript(figure, options)` (and so `python`) takes:

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
(false: never in the legend), `color` and `alpha`. A series with no colour
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
| `errorbar` | `x`, `y`, `yerr` and/or `xerr`: one array (symmetric) or `[below, above]` | as scatter (`marker` may be `none`), `errorWidth` 1, `capSize` 0 (points either side), `lineStyle` none to join the points | `ax.errorbar` |
| `band` | `x`, `lower`, `upper` | `alpha` 0.2, `edgeWidth` 0; gaps (NaN) split it | `ax.fill_between` |
| `bar` | `y` (heights), `x` (positions; default 0, 1, 2 …), `yerr` | `width` 0.8 of a place, shared by the bars of a panel standing side by side (`group: false` to overlap); `bottom` 0; `edgeColor`, `edgeWidth` 0; `capSize` 3, `errorWidth`, `errorColor` (the foreground) | `ax.bar` |
| `histogram` | `values` and `bins` (a number, or the edges), `density`; or `counts` and `edges` | `histtype` stepfilled · step · bar, `alpha` 0.6, `edgeColor`, `edgeWidth` | `np.histogram`, then `ax.stairs` (or `ax.bar`) |
| `box` | `groups`: arrays, or `{ values, position }` | `width` 0.5, `whis` 1.5, `fliers` (outliers), `points` (each value, spread the same way every time), `pointSize` 4, `jitter` 0.3 of the width, `mean` (the mean and its Student's t interval at `level` 0.95), `meanOffset`, `faceAlpha` 0.25, `medianColor`, `lineWidth` 1 | `ax.boxplot(patch_artist=True)`, `scipy.stats` for the interval |
| `heatmap` | `x`, `y` (cell centres), `z` (rows along y: `z[j][i]` at `x[i]`, `y[j]`); from a file listed point by point, `z: { values, source, column, x, y }` (the columns of z, x and y) | `colormap`, `vmin`, `vmax` (null: the data's), `colorbar: { show: true, label }` | `ax.pcolormesh(shading='nearest')`, `fig.colorbar` |
| `contour` | as heatmap | `filled`, `levels` (about this many, or the list), `colors` (one colour for lines; none: the colormap), `lineWidth` 0.8 (0 for filled), `lineStyle`, `colorbar` (filled only) | `ax.contour` / `ax.contourf` |
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

The figure panel has the Curve Fitter's groups, in its order: Figure, Title
and labels, Axes and ticks, then Series (one series at a time) and Panels
(heights, with two or more), then Legend, Grid, Frame and Export. Presets:
Publication, Presentation, Minimal and Dark (background `#0f172a`, text
`#e2e8f0`; series with a colour of the light cycle move to the same hue
stepped for a dark ground). Sizes: single column, double column, slide,
square (4 × 4 in) and the default; width and height typed in in, cm, mm or px
(px at the PNG resolution), kept in inches. Title and tick-label sizes of
their own; grid lines at both axes' ticks or one; the PNG resolution always in
view (the header's PNG button uses it whatever the format). Error-bar series
the page joins with a line get its style and width. The Curve Fitter's own
panel keeps its fields as they were; its style object takes `grid.axis`,
`titleSize` and `tickSize` too, which its preview and script honour.

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
statistics, histogram bins). Checked against matplotlib for the demo's nine
figures (heatmap with contours and colour bar, grouped bars with error bars
and brackets, box plots with points and means, two panels of a time series,
histograms, error bars in x and y with a diagonal, filled contours at chosen
levels, log axes with a two-column legend, and a dark figure) and by the
tests, which run the scripts and compare matplotlib's axis limits with the
preview's. What differs:

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
  preview counts locations within 0.2% of the fewest as a tie and takes the
  first in matplotlib's order, which agrees more often; set the position when
  it matters.

## The pages

Every plotting page now shows its figures through the component. What each
draws, where its description is built, and what its Python reads:

| Page | Figures | Built in | Python |
|---|---|---|---|
| Curve Fitter | The data with error bars, the fitted curve, its confidence band, and the residuals in a panel below; the page's own switches (Residuals, Confidence band) in the header, its own style panel (the fit's groups) in the Style tab | `js/fit-plot.js` (`fitFigure`), `src/core/fit-python.js` | Fits the model again with `curve_fit` and draws with the shared pieces; embeds the data or reads the page's CSV |
| PLUMED "Analyse a run" | Six figures: the COLVAR time series, a histogram, the reweighted FES, the 1D or 2D FES with contours and a colour bar, convergence over time, hill heights | `src/core/plumed-analysis-figures.js` | Reads COLVAR and HILLS itself, with `analyse_plumed.py`'s functions in the prelude |
| XVG Visualizer | Lines and markers from an .xvg; the series once on a right-hand axis now in a lower panel sharing x; a running mean (`numpy.convolve` in the script); Grace escapes as text | `xvgFigure` in `src/core/xvg-parser.js` | Reads the .xvg with `np.loadtxt` |
| Plot Builder | A rail with Data, Series and Style tabs beside the shared plot area; several CSV files; series as line, points or both, with error bars, bands and panels; Log x and Log y switches in the header; drag to zoom, double-click to fit and hover values on top of the shared preview (the builder's own) | `src/core/plot-builder.js` | Reads each CSV by its header (Python's csv and float rules) or embeds it; PDF, PNG and SVG from the header |
| Plot Digitizer | The digitised datasets as lines and markers, one panel or stacked; the plot area under the workspace | `digitizerFigure` in `src/core/digitizer.js` | Reads the page's own CSV |
| Error Bar Generator | Bars or points with SD, SEM or CI, the replicates, and Holm-corrected Welch brackets | `src/core/error-bars-figure.js` | Embeds the replicates and computes the tests in the prelude; the brackets are drawn through `after` |
| Statistics Calculator | Box plots with the points and the mean with its interval, pair lines, the μ₀ line, scatter with the least-squares line | `src/core/statistics-figure.js` | Runs the test again, then draws |
| Outlier Detector | New: the values by row, the flagged ones marked, and the threshold lines | `src/core/outliers-figure.js` | Embeds the values |

## Checking a page

`npm test` runs `tests/figure.test.js`, `tests/figure-plot.test.js` and
`tests/figure-python.test.js` (the last runs the scripts when Python with
numpy, scipy and matplotlib 3.6 is installed, and checks the axis limits
against the preview's). For a page: the headless sweep (errors, overflow,
contrast at 1280 and 390 px in both themes), then export a PNG from the page
and run the page's script, and compare the two side by side.
