# Refactor recovery notes

Changes made while restoring features lost between `stemkit` and
`stemkit-complete`. Two of these are correctness bugs; the rest are
UI features whose markup survived the refactor but whose wiring did not.

## Correctness bugs in `src/core/units.js`

**1. Reciprocal units ignored the `inverse` flag.**
`wl_nm` (wavelength) lost its `inverse: true` marker, and `convert()` had no
branch for it. Wavelength conversions therefore returned a plausible-looking
but badly wrong number rather than failing: a 532 nm laser line converted to
`0.0000532 cm-1` instead of `18797 cm-1`.

`convert()` now inverts on the way into the base and on the way out:

    const base = f.inverse ? f.factor / value : value / f.factor;
    return t.inverse ? t.factor / base : base * t.factor;

**2. The kBT energy-equivalent scales were missing.**
`kt_kj`, `kt_kcal` and `kt_mev` returned `NaN`. Restored in
`convertTemperature()` using exact SI 2019 constants, and cross-checked
against the independent `convertKT()` helper (agreement to 1e-12).

Both bugs passed the existing 975-test suite. `tests/units.test.js` now has 17
further tests covering reciprocal behaviour, kBT round-trips, and metadata
integrity.

## API additions

Restoring the `temperature` category broke three database-integrity tests,
correctly: affine units have no conversion factor and no base unit.

- `listCategories()` now returns only multiplicative categories.
- `listAllCategories()` returns every category, for UI use.
- `isAffine(category)` reports whether a category converts by offset.

The refactor's decision to keep `symbol`/`name` free of markup was preserved.
Marked-up forms live alongside as `symbolHtml`/`nameHtml`, so the core stays
presentation-neutral while the pages can still render `E<sub>h</sub>`.

## Restored unit metadata

All 11 categories and 70 units, including `color`, `icon`, `desc` (tooltip
text), `note`, and the whole `temperature` category. All 64 factors shared
with the refactored file were verified identical before merging.

## Restored UI features

- **scientific-converter**, the JS targeted a two-dropdown DOM that does not
  exist; the page is a live conversion matrix. UI layer rewritten against the
  actual markup, with all arithmetic delegated to the core.
- **stats-calculator**, tutorial banner, its dismissal (persisted in
  `localStorage`), and the six sample datasets.
- **error-bar-generator**, KaTeX theory panel, the eleven-entry definition
  list, and the plot reset button.
- **plot-digitizer**, zoom toolbar and resolution note, ctrl/cmd + wheel
  zoom, the live Plotly preview, and the transparent-background export option.
- **bibtex-deduplicator**, file upload, the unique-works counter, the
  resolution progress label, and the styled empty-state panel.
- **curve-fitter**, file upload.
- **journal-abbreviator**, the seven-citation example, which deliberately
  covers a lowercase journal name, a colon in a title, a "The ..." prefix, and
  a journal absent from the dictionary.
- **coordinate-manipulator**, box provenance reporting (CRYST1 record vs.
  `.gro` file vs. padded bounding box), which affects what an export means.
- **latex-tables**, the Markdown export button its handler was already
  looking for.
- **data-cleaner**, reset button ID corrected (`resetBtn` -> `resetDataBtn`).
- **bibtex-sanitizer**, confirmation toast on loading the sample.

## Verification

- 992 tests pass (975 original, unmodified, plus 17 new).
- Every `.js` file parses as an ES module.
- Cross-check of `getElementById`/`querySelector` against the HTML: no broken
  references, and no interactive element left unwired.
- Every page loads without error under jsdom. Remaining jsdom warnings are
  environment limitations (no canvas, no MathLive); `js/sandbox.js` is
  byte-identical to the pre-refactor version.

## Second audit pass

A further comparison of the original against this build | checking event-handler
wiring, interaction signals, output/export features, and CSS selectors
independently, found two more regressions, now fixed.

**Display precision in the scientific converter.** The refactor routed output
through the core `formatValue`, which works in significant figures. The
original formatted in decimal places. Because the converter exists to show
high-precision constants, this silently truncated them: one hartree displayed
as `219474.63 cm-1` rather than `219474.6313632`. The underlying `convert()`
was returning full precision throughout; only the display was short. The
converter now formats with its own rule matching the original (exponential
outside 1e-4..1e7, otherwise up to eight decimal places, trailing zeros
trimmed). The core `formatValue` was deliberately left alone, since it is
tested and relied on elsewhere.

**Sample-data hint cue.** In curve-fitter and error-bar-generator, an empty
input used to pulse the sample buttons once to show where to start, stopping at
the first keystroke. The animation survived in CSS but nothing triggered it.
Restored in both.

**Custom abbreviation rules were not persisted.** journal-abbreviator kept
user-defined rules in `localStorage` across sessions; the refactor rebuilt the
engine on edit but never saved or restored. Persistence is restored, with the
write scheduled before the rebuild so a rendering error cannot lose the user's
rules.

### Checked and found correct (no change needed)

- **latex-formatter theme toggle**, appeared dropped, but the refactor removed
  a duplicate handler that was double-binding and cancelling itself out. The
  page's shared inline script owns theming and persists the preference.
- **plot-digitizer calibration buttons**, bound through a `CALIB_BUTTONS`
  loop rather than individually.
- **`buildEngine` in `src/core/journals.js`**, investigated after a suspected
  iteration fault; it is correct. The built-in dictionary supplies
  `[name, abbreviation]` pairs and the function consumes them properly. All 200
  entries load, and the awkward cases (leading "The", `&` versus "and", a colon
  in the title, an unknown journal) all resolve correctly.
- **Seven tools are byte-identical to the original**: decision, doi-fetcher,
  pomodoro, sandbox, plot-builder, structure-inspector, script-generator.
- **outlier-detector** additionally supports Grubbs; **xvg-visualizer**'s Grace
  metadata parsing tolerates more spacing variants than before;
  **data-cleaner** retains every operation.
- **Every CSS selector** defined in the original inline `<style>` blocks is
  present in the extracted stylesheets.

## Pre-existing bug found while testing (not a refactor regression)

**structure-inspector: the busy overlay could never be dismissed.**

`#busyOverlay` is styled by an id selector that sets `display:flex`, while the
script hides it by toggling the `.hidden` utility class. An id selector
(specificity 1,0,0) outranks a class selector (0,1,0), so `display:flex` won
and the overlay stayed on screen permanently, covering the viewer with a
spinner reading "Working…". Because the overlay sits inside the workspace , 
which is itself hidden until a structure loads, the symptom only appeared
*after* loading a PDB, and the overlay also swallowed mouse input to the 3D
canvas.

Fixed by giving the hidden state id+class specificity:

    #busyOverlay.hidden { display:none }

Verified against all three builds: the overlay computes to `display:flex` while
carrying `.hidden` in both the original `stemkit` and the refactored
`stemkit-complete`, and to `display:none` here. The same rule was added to
`src/tools/structure-inspector.css` so the extracted stylesheet stays correct
if that page is ever switched over to it.

Note that `structure-inspector.html`, `js/structure-inspector.js` and
`js/dependencies/3Dmol-min.js` are otherwise byte-identical across all three
builds, which is what identifies this as a pre-existing defect rather than
something the refactor introduced.

## New: ISO 4 abbreviation from the ISSN LTWA

The Journal Abbreviator now works in two tiers.

**Tier 1, dictionary.** `js/journal-data.js` maps ~200 whole journal titles to
whole abbreviations. Exact, but limited to titles someone has entered.

**Tier 2, ISO 4.** `src/core/iso4.js` implements ISO 4 against the ISSN List
of Title Word Abbreviations, which maps individual title *words* (mostly stems)
to abbreviations. Any title can then be abbreviated by rule.

These are different kinds of data and are not interchangeable: pointing the
old whole-title matcher at the LTWA would match almost nothing, because a row
like `chemi-` is a stem, not a journal name. The engine implements the rules
that turn stems into a title abbreviation, stop-word removal, longest-match
stem lookup, suffix and infix patterns, `n.a.` entries, hyphenated compounds,
language filtering and capitalisation.

Tier 1 runs first and tier 2 handles what it did not recognise. Rather than
duplicating the replacement pipeline, ISO 4 results are folded back in as
ordinary `[title, abbreviation]` rules, so highlighting, counting and
substitution stay in one code path.

The word list is a drop-in file at `abbr/abbreviation.csv`, documented in
`abbr/README.md`. It is not redistributed here. Without it the tool behaves
exactly as before, reporting unrecognised titles as unknown; the load is
asynchronous so it never blocks first paint.

Rules implemented, with tests in `tests/iso4.test.js` (36 cases):

- A single-word title is not abbreviated.
- Articles and conjunctions are always dropped; a preposition is dropped
  except as the first word, where it is kept ("From Zero to Hero").
- A lone `&` is treated as the conjunction it stands for.
- Latin locutions such as "in vitro" survive stop-word removal intact.
- The longest matching pattern wins; an exact entry beats a stem.
- `n.a.` is recognised-but-unabbreviated, tracked separately from a miss.
- Unmatched words are left alone and reported.

The loader sniffs tab/comma/semicolon delimiters, handles quoted fields and a
byte-order mark, and counts malformed rows rather than throwing, so the file
works as downloaded or after a spreadsheet round-trip.

Known limit, documented in `abbr/README.md`: ISO 4 expects a cataloguer not to
abbreviate personal or place names, and nothing in the word list marks them.
Tier-2 output is a strong draft rather than a citation-ready answer, which is
why every substitution is reported.

### Verified against the real ISSN export

The engine was subsequently checked against the actual 56,520-row LTWA
download rather than a fixture, which turned up four format details the
public documentation does not state, all now handled and covered by tests:

- the file is comma-separated, not tab-separated;
- "not abbreviated" is an empty column, not the literal `n.a.`;
- languages are spelled out in English rather than given as ISO 639 codes;
- multilingual rules are tagged "Multiple languages", not `mul`.

The last of these was a real defect: because `mul` was assumed, every
multilingual rule was being filtered away whenever a language was requested,
which silently cost 1,355 rules including common stems such as `biolog-`.

All 56,519 rules parse with none skipped, in roughly 0.5 s to parse and index.
Twelve well-known titles abbreviate exactly as ISO 4 prescribes, including
*Proc. Natl. Acad. Sci.* and *J. Phys.: Condens. Matter*. See `abbr/README.md`
for why language filtering is available but deliberately unused.

## Bugs found from user-reported symptoms

**Missing Tailwind arbitrary-value utilities (root cause of several layout
complaints).** Six pages use classes such as `h-[calc(100vh-80px)]`,
`lg:h-[calc(100vh-120px)]` and `min-h-[520px]`. Those are generated on demand
by the Tailwind JIT compiler, but this build ships a pre-compiled stylesheet
and the pages do not load the Tailwind CDN, so fifteen such classes resolved to
nothing. The `<main>` element then had no height and collapsed, and any child
using `absolute inset-0` (the upload overlay on several tools) escaped its
container and painted over the documentation below it. That is the overlap
visible on the XVG Visualizer, and the same missing rules are why the Plot
Builder's panel never became independently scrollable with the plot held in
view. All fifteen are now written out longhand in `src/output.css`.

**Plot Digitizer: the Python script never appeared.** The modal is revealed by
adding an `.open` class, and every other tool that uses this pattern defines a
matching `#id.open { display:flex }` rule, `plot-digitizer.css` did not. The
script was generated correctly and then displayed behind `display:none`.

**Plot Digitizer: the resolution note covered the figure.** It had been placed
over the canvas, where it obstructed exactly the area being clicked during
manual digitising. Moved into the calibration panel, which is where the rest of
the calibration state already lives.

**Plot Digitizer: native `alert()` dialogs.** This was the only tool still
using blocking browser alerts; the rest use styled toasts. Three calls
replaced, with the shared toast container, styling and animation added to match.

**Coordinate Manipulator: files were accepted but never loaded.** The refactor
moved the click and drag handlers from the dashed drop area onto the
surrounding section. Because the file input sits inside that section, the
synthetic click from `fileInput.click()` bubbled back into the same handler and
re-opened the picker, losing the change event; drag feedback was also being
painted on a borderless element in the wrong colour. Handlers moved back to
`#dropArea`, with a guard against the self-triggering click.

**FAQ questions were torn apart mid-sentence.** `.stk-faq > summary` was a flex
container with `justify-content:space-between`, which makes every text run and
inline tag its own flex item, so a question containing `<sup>3</sup>` had its
three fragments pushed to opposite ends of the row. It is now a block, with
`position:relative` to give the absolutely positioned +/− marker a containing
block it previously lacked.

**Stats Calculator: formula symbols were never defined.** Each test renders its
formula with KaTeX, but nothing explained what the symbols meant. The
stylesheet already carried the `.mf-defs` rules for a definition list, so the
glossary had been designed and then lost rather than never written.

A "Where:" list is now rendered beneath every formula, with per-test
definitions rather than one shared glossary, the same letter does not mean the
same thing across tests. In the paired t-test `n` counts pairs, elsewhere it
counts observations; `W` is a signed-rank sum for Wilcoxon and nothing like the
`U` of Mann–Whitney. All seven tests are covered: Welch (5 terms), pooled
Student (5), paired (6), ANOVA (7), Pearson (5), Mann–Whitney (6) and
Wilcoxon (4).

The theory panel also used to render only when a test was *run*. It now renders
as soon as a test is selected, which is when the formula and its terms are most
useful, while deciding whether it is the right test.

## Viewer shell, and why the arbitrary-value patch was not enough

Adding the missing Tailwind arbitrary utilities fixed most of the collapsed
layouts, but not the Plot Builder. The reason is escaping: a class like
`lg:h-[calc(100vh-120px)]` compiles to the selector

    .lg\:h-\[calc\(100vh-120px\)\]

and those escaped parentheses do not survive every CSS parser. Checking the
parsed rules of `output.css` showed the simple arbitrary values
(`.min-h-\[520px\]`, `.lg\:w-\[450px\]`) landing while every `calc()` one
was dropped. When that happens the shell loses its height, collapses, and the
documentation underneath is painted over the settings panel.

Rather than depend on that, the panel-and-viewport layout now has plain class
names in `src/output.css`:

- `.stk-shell`, fills the space under the nav and clips its own overflow;
- `.stk-shell-pane`, the side panel, scrolling independently;
- `.stk-shell-main`, the viewport, which stays put;
- `.stk-shell-tall`, variant for tools whose viewport starts at the nav.

Applied to the Plot Builder, XVG Visualizer and Coordinate Manipulator. The
last of these had been carrying an inline `min-height` where the others used
`height`, which is why its spacing never matched.

## Structure Inspector

**Measurement labels stacked on every redraw.** `redrawMeasurements()` removed
its shapes but never its labels, then added a fresh label over the old one, so
each change of decimals, units or zoom left another copy behind, the overlap
visible as a garbled "131°04°". Label rendering now belongs solely to
`updateLabels()`, which clears the viewer before re-adding; `redrawMeasurements`
only records the label data.

**PNG exports were softer than the screen.** The exporter set `canvas.width`
directly, but 3Dmol sizes its drawing buffer from the *container*, so the next
`viewer.resize()` recomputed it and discarded the multiplier entirely. The
container is now scaled instead, parked off-screen while oversized so the page
does not jump, and restored in a `finally` block. Because 3Dmol multiplies the
container size by the device pixel ratio, the exported file lands at
scale x dpr, which is what makes it match and then exceed on-screen sharpness.

## Coordinate Manipulator: the UI layer targeted a DOM that does not exist

Fixing the file picker only revealed the larger problem: the tool opened its
workspace and then showed nothing, zero atoms, empty statistics, "awaiting
structure".

The refactored `js/coordinate-manipulator.js` had been written against an
invented DOM. Twelve of the element ids it looked for are absent from the page:
`systemStats`, `outputArea`, `fileName`, `unitNote`, `boxNote`, `warningBox`,
`btnRotate`, `btnTranslate`, `btnCentre`, `btnCentreMass`, `btnReset` and
`btnCopy`. The pre-refactor file matches the markup exactly, so this was
introduced by the rewrite, the same failure as the Scientific Converter.

The UI layer is now bound to the ids the page actually has. Two of these were
not simple renames:

- the statistics panel is five individual fields (`statAtomCount`,
  `statGeoCenter`, `statMassCenter`, `statMolWeight`, `statBoundingBox`), not
  one block to fill with `innerHTML`, so each is written separately;
- centring is one button plus a mode select (`centerMode`), not a separate
  button per method.

Verified end to end for both formats: a four-atom PDB reports 4 atoms, a
molecular weight of 54.03 Da and the correct centroid, with the centre of mass
properly offset from it; a `.gro` file reports its atoms in nm and picks up its
box from the file. Translation and centring both move the reported centres as
expected.

### The audit script was missing this class of bug

Earlier passes reported no broken references for this file. They were wrong:
the checker only recognised `document.getElementById(...)` and
`querySelector('#...')`, and this file reaches the DOM through a one-line
helper, `const $ = (id) => document.getElementById(id)`. Every `$('someId')`
call was invisible to it.

The checker now resolves that helper as well, which is how all twelve were
found at once. Worth remembering when auditing the remaining tools: a clean
report is only as good as the patterns the script knows about.

## LaTeX Formatter keypress sounds

MathLive plays a sound on each keypress, looking the files up by name under
`MathfieldElement.soundsDirectory`. The mapping is now set in
`js/latex-formatter.js`:

    default  -> sound/hee-hee.mp3      (MathLive's "standard" keypress)
    delete   -> sound/fahhh.mp3
    return   -> sound/hee-hee.mp3
    spacebar -> sound/hee-hee.mp3

Configured from our own code rather than by editing
`js/dependencies/mathlive.min.js`, so the vendored bundle stays untouched and
can still be upgraded.

`return` and `spacebar` are pointed at the same file deliberately: MathLive
defaults them to `keypress-return.wav` and `keypress-spacebar.wav`, which do
not exist in `sound/`, so leaving them alone would request a missing file on
every press.

**The two audio files still need to be added.** `sound/` currently holds only
`cafe.mp3` and `rain.mp3`; until `hee-hee.mp3` and `fahhh.mp3` are placed
there, keypresses will simply be silent. The configuration is wrapped in a
try/catch so a missing or unloadable sound can never stop the editor working.

## DOI to BibTeX: field filtering did nothing

Unticking a field left it in the output. The filter walked the entry line by
line, keying off `^\s*(\w+)\s*=`, which only sees a field when it starts its
own line. The DOI content-negotiation service frequently returns the whole
entry on a single line:

    @article{Ito_2020, title={A study}, volume={27}, ISSN={1600-5775}, url={...} }

Nothing in that matches the pattern, so every field was passed through
untouched and the panel appeared to have no effect. The same failure occurred
whenever a provider merely put two fields on one line.

`filterBibtexFields` in `src/core/bibtex.js` now scans the entry rather than
its lines: it reads the type and citation key, then each field in turn,
handling brace-delimited values with nesting (`{A study of {NaCl}}`), quoted
values, and bare ones (`year = 2020`, `month = jul`). Text outside an entry,
such as `@string` definitions, is passed through. Output is normalised to one
field per line, which keeps a filtered single-line entry readable.

`js/doi-fetcher.js` had its own copy of the old logic and is now a module that
imports the core function, so there is one tested implementation rather than
two. Thirteen regression tests cover the layouts that were failing.

## Coordinate Manipulator: empty preview (regression from the shell change)

The preview pane rendered nothing for GRO input while the file still exported
correctly. The cause was the viewer-shell change in the previous round, not the
parser.

That page originally carried an inline `style="min-height: calc(100vh - 80px)"`
on `<main>`. Replacing it with `.stk-shell-tall` changed two things at once:
`min-height` became a fixed `height`, and the rule sat inside a
`@media (min-width: 1024px)` block. A fixed height caps the panel, so the
preview (a `flex-grow` child with `overflow-auto`) had no room left to render
into; and below 1024px the container had no height at all, which is the same
collapse that lets an `absolute inset-0` upload overlay escape.

Both shell variants are now outside any media query, matching the unprefixed
markup they replaced, and are split by intent:

- `.stk-shell-tall`, fixed height, for a tool holding a viewport in view;
- `.stk-shell-min`, minimum height, for a text tool whose content grows the
  page. The Coordinate Manipulator uses this one.

`.stk-shell` for the Plot Builder stays desktop-scoped, which is correct: that
markup was `lg:` prefixed to begin with.

### On the "unrecognised element symbol" warning

Not a fault. GROMACS virtual sites, `MW` in TIP4P water, and likewise `LP`,
`DUM`, `MCH3`, have no element, so `elementSymbol` reads "M" and
`atomicMass` reports it rather than silently substituting carbon. The warning
is doing its job; it simply fires on every TIP4P system. Left as is by request.

### Note on the tool's dependencies

The Coordinate Manipulator uses no third-party library: it imports only
`src/core/structure.js` and has no `<canvas>`. It is a text tool | parse,
transform, re-emit, and shows a stats panel and a text preview. 3Dmol is used
by the Structure Inspector, which is a different tool.

## LaTeX Formatter: stray \dot on load, and silent keypresses

**The `\dot` artifact.** The starting equation contained `\dots`, which
MathLive 0.94.8 does not implement, the bundle has no reference to it at all,
while `\ldots` and `\cdots` are both present. Meeting an unknown command the
parser takes the longest one it recognises, which is `\dot` (the accent), and
leaves the trailing `s` behind. Changed to `\ldots`, which is the correct
command for a horizontal ellipsis here in any case.

**Why the sounds could not be heard.** Two independent reasons.

The first is structural. Inside MathLive the keypress sound is played only for
a command carrying a `feedback` flag, and that flag is set by the on-screen
maths keyboard, the same branch that fires haptic vibration. Ordinary
keystrokes take a different path, so on a desktop with a physical keyboard the
sound never fires, whatever files are configured. The formatter now plays the
sound itself on `keydown`: `Backspace` and `Delete` get the delete sound,
everything else the standard one, and modifier shortcuts stay silent. Each
keystroke plays its own audio node so fast typing overlaps rather than cutting
the previous sound short, and both autoplay refusals and missing files are
swallowed rather than logged on every press.

The MathLive configuration is kept as well, so the on-screen keyboard stays in
step with physical typing.

The second reason still stands: **`sound/hee-hee.mp3` and `sound/fahhh.mp3` do
not exist.** The folder holds only `cafe.mp3` and `rain.mp3`. Until those two
files are added, typing stays silent, the wiring is correct but there is
nothing to play.

## Structure Inspector: WebGL requirement handled explicitly

3Dmol draws through WebGL, and `$3Dmol.createViewer` was called with no guard,
after the workspace had already replaced the upload screen. Where WebGL is
unavailable that left an empty panel and no explanation | indistinguishable
from the file having failed to load.

A cached probe now runs *before* the workspace is revealed. Without WebGL the
user stays on the upload screen and is told what is wrong and what usually
fixes it. `createViewer` is additionally wrapped, because a context can still
be refused after the probe passes, most often when too many WebGL contexts
are already open across tabs, in which case the workspace is rolled back
rather than left blank.

Worth stating plainly, since it is easy to assume otherwise: the requirement is
**WebGL, not a discrete GPU**. Integrated graphics are fine, and browsers fall
back to software rendering (slower, still correct) when no hardware path is
available. It fails only where WebGL itself is off or absent | hardware
acceleration disabled, some virtual machines and remote desktop sessions,
locked-down enterprise policies, or a very old browser.

## Coordinate Manipulator: 3D view and viewport layout

The tool now renders the structure with 3Dmol, the same vendored build the
Structure Inspector uses, alongside the existing text preview.

The model is rebuilt from `state.atoms` inside `renderOutput`, which is the one
place every path already converges on: file load, each transformation, and a
change of export format. That means the view always shows the coordinates that
would be exported rather than the ones that were loaded, without scattering
refresh calls through the transform handlers.

Coordinates are converted to Angstrom on the way in, since 3Dmol reads PDB in
Angstrom and a `.gro` file is in nanometres, passing the raw values would
render the structure a factor of ten too small.

Above 20,000 atoms only the first 20,000 are drawn and the panel says so.
Rebuilding a larger model on every rotation costs more than the view is worth,
and the export is unaffected either way.

The view degrades rather than breaking. Missing WebGL, a 3Dmol build that
failed to load, or a refused context each leave a short explanation in place of
the canvas, and transformations and export continue to work.

### Layout

The workspace is now a viewport-height shell on desktop, so both panels scroll
within it instead of the page growing:

- Transformation Engine, `.stk-shell-main`, so the column may shrink and its
  existing inner list scrolls;
- Structure View, takes the remaining height;
- Data Buffer Preview, a fixed 240px beneath the view, scrolling internally.

Below the desktop breakpoint the shell does not apply and the panels stack and
scroll with the page as before.

### Upload screen spacing brought back in line

The Coordinate Manipulator's upload screen sat taller than the other tools'.
The markup was not the cause: its `#uploadZone` and `#dropArea` are identical
to the XVG Visualizer's apart from the accent colour. The difference was on
`<main>`, `min-height` rather than `height`, so the element grew past the
viewport and the `absolute inset-0` overlay stretched with it.

`min-height` had been introduced earlier to stop a fixed height from crushing
the preview pane. That is no longer needed: the workspace now carries its own
bounded height through `.stk-shell` and its panels scroll internally, so the
page can go back to matching the others. Both now resolve to
`height: calc(100vh - 80px); min-height: 520px`.

With nothing using it, `.stk-shell-min` has been dropped rather than left in
the stylesheet as dead code.

## Stray "Esc" badge on the Structure Inspector

Two different rules were both named `.stk-kbd`. In `home.css` it styles the
hint parked inside the home-page search box, `position:absolute; right:1rem;
top:50%`. In each tool's documentation it styles an inline keyboard badge.
Since `home.css` loads after a tool's own styles and the two selectors have
equal specificity, source order handed it to the absolute-positioned rule: the
six shortcut badges (R, M, H, L, S, Esc) were all pinned to the same spot,
stacked, leaving one visible.

The home-page rule is now scoped to `#searchHint`, the element it was written
for. All six badges render inline again.

## Toast placement

Seven pages positioned their toast container `top-5 left-1/2`, directly over
the navigation bar, so a message overlapped the menu and was hard to read. The
other ten already used `bottom-6 right-6`. All seventeen now match the latter.

## Resizable structure view

How much space the 3D view deserves depends on the structure and on the task,
so the split between it and the Data Buffer Preview is now draggable. The
preview keeps a concrete height and the view takes the remainder, which is
what lets the preview scroll internally rather than pushing the page taller.

The handle is keyboard operable (arrow keys, Shift for a coarser step) and
clamps so neither panel can be squeezed out of existence. Because a WebGL
canvas is sized from its container, the viewer is told to resize once the drag
settles rather than on every frame.

## Link audit

Every internal link and anchor across the 29 pages was checked: file targets,
same-page anchors and cross-page fragments. Two hits were false positives in
`404.html`, a root-absolute `/index.html`, which resolves once deployed, and a
fragment of JavaScript matched by the scan. **No broken internal links.**

The 99 distinct external links are all well formed. They have not been checked
live; that needs a network pass and is worth repeating periodically, since the
GROMACS manual, NIST and scikit-learn all reorganise their documentation from
time to time.

## Link checking

`tools/check-links.mjs` checks internal file targets, same-page anchors,
cross-page fragments and external URLs. No dependencies; Node 18 or newer.

    npm run check:links              everything
    npm run check:links:internal     skip the network
    node tools/check-links.mjs --json

It exits non-zero when something is broken, so it can gate a release.

Script and style bodies are stripped before scanning. Inline scripts build URLs
by concatenation, and a naive `href` scan reports those fragments as broken
links, that was the one false positive in the earlier manual pass.

External checks try HEAD and fall back to GET, because several documentation
hosts answer HEAD with 403 or 405 while serving the page normally. Redirects
are followed and reported separately from failures: they still work, but a 301
today is often a 404 next year, and the GROMACS, NIST and scikit-learn
documentation all move around.

### Current state

**Internal: 29 pages, 152 distinct links, none broken.**

**External: 96 links, not verified live here.** This environment allows
outbound requests only to a small allowlist, so 94 of them returned the
proxy's 403 rather than a real status. The two that could be reached , 
both github.com, returned 200, which confirms the checker's network path
works; running it outside the sandbox will check all 96 properly. Two
were verified by other means:

- `https://github.com/NatLabRockies/HPC/.../lammps/README.md`, 200
- `https://github.com/Tom-Alexander/regression-js`, 200
- `https://users.rcc.uchicago.edu/~tszasz/rccdocs/software/applications/lammps/index.html`
 , resolves, but its content dates from around 2014 and UChicago now
  publishes current documentation at `docs.rcc.uchicago.edu`. Live, but worth
  repointing.

## Data Buffer Preview would not scroll

The preview panel was given `h-[240px]`, but only `min-h-[240px]` was defined
in the stylesheet, this build has no JIT step, so every Tailwind arbitrary
value has to be authored by hand. With no height the panel grew to fit the
whole buffer, so it never scrolled internally, the page scrolled instead, and
the structure view was squeezed into whatever was left.

An earlier audit reported no missing utilities because it matched substrings,
and `h-\[240px\]` is a substring of `min-h-\[240px\]`. Checking with word
boundaries showed the gap. The panel now uses a named class,
`.stk-preview-pane`, which cannot fail this way.

## Triclinic simulation cells

A solvated system is normally built in a rhombic dodecahedron or truncated
octahedron rather than a rectangular box, and both are triclinic. A `.gro`
file then carries nine box components and a PDB CRYST1 record carries angles
other than 90.

Both were being discarded. The GRO parser kept `boxTokens.slice(0, 3)` and
dropped the six off-diagonal terms; CRYST1 was read for lengths only. Both
writers were hardcoded to match, `90.00 90.00 90.00` on every CRYST1 record
and three components on every GRO box line. Loading a dodecahedral system and
exporting it therefore returned a rectangular one: not a formatting
difference, a different system.

Now:

- `boxVectorsFromAngles` and `anglesFromBoxVectors` convert between the two
  conventions, honouring the lower-triangular form GROMACS requires;
- `isTriclinic` reports whether a cell has any off-diagonal component;
- both parsers keep the full cell, exposed as `boxVectors`;
- GRO output writes nine components for a triclinic cell and three otherwise;
- CRYST1 carries the real angles, and the true **edge lengths**, for a
  dodecahedron the third edge is 50 A long while the cell is only 35.4 A deep,
  so the diagonal stored in `box` is the wrong number to write there.

Editing the box lengths by hand clears the stored vectors, since typing three
lengths describes a rectangular cell.

Nine tests cover the conversions, both parsers, both writers, and a full
gro to pdb and back round-trip that reproduces the original vectors.

## Adjusting the split between the view and the text

The drag handle sat between the two panels but was an 8px bar carrying a thin
grey line, inside a 16px gap, easy to miss entirely, and invisible while the
preview had no height and the layout was collapsed.

It is now a labelled pill reading "Drag to resize", with a grip icon, that
highlights on hover and on keyboard focus. Alongside dragging:

- **Arrow keys** adjust the split when the handle has focus; Shift takes a
  coarser step.
- **Double-click** returns to the default, so a user who has dragged somewhere
  unhelpful is not left hunting for the original proportion by eye.
- The chosen split is remembered between visits. Storage may be unavailable,
  in which case it simply starts at the default; a stored value of zero, which
  is what a browser reports before layout has run, is ignored rather than
  applied.

Both panels have floors, so neither can be dragged out of existence, and the
WebGL canvas is told to resize once the drag settles rather than on every
frame.

## Preview cap, cell outline, and a note on rotation

**Showing every row.** The preview cap was 400, which hid most of even a small
system. It is now 5,000 (enough that a typical structure is shown whole) and
a "Show all" control lifts it entirely. The cap exists because the preview is
re-formatted on every redraw, so on a large system it is the cost of each
transformation rather than a one-off; the wording now also makes clear that the
export has always contained every atom regardless.

**Cell outline.** The simulation cell is drawn as twelve dashed edges, with a
toggle. It is built from the cell vectors rather than 3Dmol's unit-cell helper
because the cell may be triclinic: a rhombic dodecahedron is a parallelepiped,
and drawing it as a cuboid would misrepresent where the periodic images sit.
The outline starts at the origin, which is where GROMACS places the cell, so a
structure translated away from the origin appears outside it, which is worth
seeing rather than hiding.

**Rotation and periodicity.** The transformations are rigid-body, so bond
lengths, angles and dihedrals are preserved exactly, and `rotateAtoms` applies
the same rotation to velocities where a `.gro` file carries them. What is *not*
rotated is the cell, and the cell defines the lattice. For an isolated molecule
that does not matter; for a periodic system the images no longer tile as they
did. A rotation on a structure that has a box now says so, because the result
is a starting geometry to re-solvate from rather than a drop-in replacement for
the original frame.

## Equivalent `gmx editconf` command

The Coordinate Manipulator overlaps heavily with `gmx editconf`, which every
GROMACS user already has. Rather than pretend otherwise, it now writes out the
command that reproduces what was set up on screen, so the same result can go
into a script and be recorded in a workflow. Set it up visually, check it, copy
the command.

Translations, rotations and centring are tracked as a net effect | editconf
takes one `-translate` and one `-rotate`, not a history, and reset when the
structure is reloaded or restored.

Differences between the two are stated rather than smoothed over, because a
command that looks right and behaves differently is worse than none:

- **Units.** editconf works in nanometres; a translation entered against an
  angstrom source is converted, and says so.
- **Rotation origin.** This tool rotates about the geometric centre, editconf
  about the origin. A rotation without a preceding centring is flagged.
- **Centre of mass.** `-center` moves the geometric centre; editconf has no
  centre-of-mass equivalent, so choosing that mode is called out.
- **Operation order.** editconf applies its operations in a fixed order, so a
  translate-then-rotate sequence cannot be replayed exactly and is flagged.
- **Formats.** editconf reads gro, g96, pdb, brk, ent, esp and tpr, and writes
  all but tpr. `.xyz` is neither, so rather than emit a command that would
  fail, the panel says so and suggests converting first.
- **Cell.** A cubic cell is written as `-bt cubic -box <L>`, which is the
  single value editconf expects; a triclinic cell as `-bt triclinic` with
  `-box a b c` and `-angles`, in the (bc, ac, ab) order editconf uses.

### Verified against editconf.cpp

The generator was first written from the manual page, which leaves the
operation order unstated. Reading the source settled it and corrected three
things.

**Order.** `editconf.cpp` applies scale, then `-translate`, then `-rotate`,
then the box, and `-center` last. The earlier warning had this backwards: it
flagged translate-before-rotate, which is exactly what editconf does and
replays perfectly, while saying nothing about rotate-before-translate, which
editconf cannot express at all. That is now the case that is flagged, with the
suggestion to split it into two commands.

**`-box` centres silently.** At editconf.cpp:786, giving `-box` or `-d` sets
`bCenter` unless `-c` was named explicitly. Setting a box in this tool moves
nothing, so a command with `-box` and no centring would have produced a
centred structure the tool had left alone. `-noc` is now added in that case.

**Rotation.** `rotate_conf` is called on coordinates and velocities together,
confirming velocities are rotated, which matches `rotateAtoms`. It rotates
about the origin, so a rotation alone also displaces the structure. Because
`-center` runs *after* `-rotate`, adding `-center 0 0 0` cancels exactly that
displacement, which is what makes the two agree; the note now says so rather
than vaguely suggesting centring first.

`center_conf` shifts by `center - geom_cent`, confirming `-center` works on the
geometric centre and that the centre-of-mass caveat is real.

### The preview shows the whole buffer

The cap is gone: however large the file, the preview holds every row and can be
scrolled to the last atom. Two things make that affordable.

**Caching.** The formatted text is kept against a signature of what it was
built from, a revision counter bumped on every coordinate change, plus the
output format, source unit and cell. A redraw where none of those changed
reuses the text instead of rebuilding it, which is the common case: toggling
the cell outline or resizing the split no longer costs anything.

**Deferred formatting.** Above twenty thousand atoms the work is handed to a
later task rather than done inside the click handler. Measured on this machine,
formatting takes about 250 ms at 30,000 atoms, 0.9 s at 200,000 and 5 s at a
million; doing that synchronously would freeze the page with no indication why.
The row count and a "formatting" note are painted first and the text replaces
them when ready. A newer request supersedes an older one by token, so a slow
build cannot land after a faster one and show stale coordinates.

Verified at 30,212 atoms (1.45 MB, complete, last line a real atom record) and
at 200,000 (9.6 MB, with the placeholder appearing immediately rather than the
page blocking).

The row count now sits under the preview heading, so the size of the buffer is
visible without scrolling to find out.

## The stylesheet was unbuildable, and 275 classes did nothing

A button reading "Show first 5,000" rendered as dark text on a dark background.
The cause was not the colour chosen but that `text-slate-200` was not in the
stylesheet at all, so the label fell back to inherited colour while the
background applied normally.

`src/output.css` was a committed Tailwind build with no config, no source file
and no way to regenerate it. Any class introduced after it was generated simply
had no effect. Checking every class used on every page against the stylesheets
that page actually loads found **275 undefined classes**.

The fix is a real build rather than more hand-written rules:

- `tailwind.config.js` scans `*.html`, `js/**/*.js` and `src/**/*.js`, the JS
  matters because several tools build markup in template strings, and a class
  that only appears there still has to survive the purge;
- `src/tailwind/input.css` holds the three Tailwind layers followed by the
  hand-written rules, so a rebuild cannot silently drop them;
- `npm run build:css` regenerates `src/output.css`, `npm run watch:css` for
  development.

That took 275 undefined classes down to 45, of which 12 are KaTeX internals
supplied by its own stylesheet, 7 are JS state hooks that are meant to carry no
styling, and most of the rest are fragments my scan picked out of template
strings. One was a genuine mistake: `text-md`, which is not a Tailwind class , 
the scale runs `text-sm`, `text-base`, `text-lg`. Corrected to `text-base` in
the two pages using it.

The "Show all" control is back, now that its label is legible: white on
slate-700 with a border, toggling between the first 5,000 rows and the whole
buffer.

Worth noting for anyone maintaining this: the stylesheet is now generated, so
edit `src/tailwind/input.css` and rebuild rather than editing
`src/output.css` directly.

## Undo

Each transformation records the coordinates as they were before it ran, and
Undo restores them. There is a button beside Reset Angles and a Ctrl/Cmd+Z
shortcut, which is ignored while a field has focus so it does not fight the
browser's own undo in a text box.

Snapshots rather than inverse operations. Inverting would use less memory, but
the inverse of an intrinsic Z-Y-X rotation is the transpose applied in the
opposite order, and the rounding from repeated undo and redo would slowly move
atoms. A snapshot cannot drift.

Coordinates are held in `Float64Array`s rather than cloned atom objects: only
the numbers change, and a 30,000-atom system costs about 0.7 MB a step that way
against several times that as an array of objects. Velocities are captured too
when the file has them, so undoing a rotation restores the rotated velocities
as well.

The stack is bounded by total bytes rather than by a step count | 64 MB, capped
at 25 steps, so a small structure keeps a long history and a very large one
keeps a short one instead of exhausting memory. Loading a new file clears it.

Each snapshot also carries the record of what had been applied, along with the
cell, because the `gmx editconf` panel is derived from that: undoing a rotation
removes `-rotate` from the generated command rather than leaving it describing
a state that no longer exists.

## Redo

Undo now has a matching Redo: a button beside it, Ctrl/Cmd+Shift+Z, and Ctrl+Y
for anyone who reaches for that instead. Undo pushes the state it is leaving
onto a forward stack, so the two are symmetric and neither loses information.

Starting a new transformation clears the forward history, which is what every
editor does, keeping it would let Redo jump to a state that no longer follows
from the current one. Both buttons disable when their stack is empty and name
the step they would apply.

## Attribution

The author's name appeared twice on every tool page: once as a byline under the
tool description and again in the references block. It now appears once, in the
footer, alongside the copyright line and linked to the author's profile.

`footer.py` generates the footer for all pages, so the change was made there as
well as in the pages it had already written, otherwise the next run would have
put the old line back.

The `stk-credit` line in the references keeps its useful half, that the tool
runs entirely in the browser and no data leaves the device, without repeating
the name. The `author` fields in each page's JSON-LD and `<meta name="author">`
are left alone: they are not visible, and they are what a citation or search
engine reads.

## Mass accounting, and showing the working

**Unidentified atoms no longer borrow carbon's mass.** `atomicMass` returned
`DEFAULT_MASS` (12.011) for anything it could not identify. That is silent in
the total and wrong in both directions, and it was badly wrong for the common
case: TIP4P and TIP5P water carry a massless charge site, so every water in a
solvated system was reported at 30.03 Da instead of 18.015, a 67%
overstatement, or 120 kDa of mass that does not exist across 10,000 waters.

Three outcomes are now distinct:

- a recognised element returns its standard atomic weight;
- a recognised virtual site (`MW`, `LP`, `DUM`, `MCH3`, `MNH3` and relatives)
  returns zero, because that is its mass;
- anything else returns zero and is recorded, so it can be named rather than
  quietly folded into the total.

**The working is shown.** A single number is easy to trust and hard to check,
so the Molecular Weight figure has a "how?" link opening a breakdown: each
element, how many atoms of it, the weight used, and what it contributes,
totalled. Below it, anything excluded from the sum is stated | massless sites
and unidentified atoms, with counts, rather than left to be inferred from a
total that does not match the atom count.

The same working downloads as CSV, with a header recording the source file,
the method, the weight set and what was excluded, so it can go into a methods
section or be checked against a topology.

`massBreakdown` lives in the core and is tested: that every atom is accounted
for as counted, massless or unidentified; that the subtotals sum to the
reported total; and that the total agrees with `centreOfMass`.

## Em dashes replaced

Em dashes are gone from every page, script, stylesheet, test and document,
620 of them across 76 files. Only the vendored libraries in
`js/dependencies/` still contain any, and those are left alone.

A blanket swap to a pipe would have read badly, because most were grammatical
breaks rather than separators: "Fields that do not affect typesetting | such as
abstract" is worse than the comma it deserves. The replacement is chosen by
context:

- a pair bracketing an aside becomes parentheses, so "Add multiple traces, even
  from different files, to overlay them" keeps its structure;
- a dash introducing "or", "and", "such as", "for example" and the like becomes
  a comma;
- a short label against a short value becomes a pipe, which is where the
  character genuinely fits: "MD Workflow Generator | GROMACS, LAMMPS & PLUMED",
  "200 built-in + 1 custom | 201 unique";
- anything else becomes a comma.

### A note on the method

The first attempt also tidied doubled punctuation, which is safe in prose and
destructive in code. `setAttribute('aria-expanded', !expanded)` and
`[...base, ...extra]` both look like a comma before sentence punctuation, and
collapsing them broke nine files. The tidying was dropped rather than made
cleverer: em dashes only ever occur inside strings and comments, so replacing
the character alone cannot change behaviour, and a syntax check across every
script now confirms it.

## Atomic weights brought up to CIAAW 2024

The weights table was checked element by element against the published CIAAW
Standard Atomic Weights 2024. Most entries differed only in how far they were
rounded, but four were wrong rather than imprecise:

- **zirconium** 91.224, now 91.222,
- **gadolinium** 157.25, now 157.249,
- **lutetium** 174.97, now 174.96669 - all three revised by CIAAW in 2024;
- **argon** 39.948, now 39.95. Argon's standard atomic weight is an interval,
  [39.792, 39.963], and 39.948 is the older single figure that still circulates.

The table now carries the published values at full precision rather than
rounded to four or five figures, and cites its source.

Fourteen elements have no single recommended value because their isotopic
composition varies measurably in natural materials; CIAAW publishes an interval
and the conventional abridged value is used. Technetium has no stable isotope
and so no standard weight at all: the mass number of its longest-lived isotope
stands in, which is the usual convention for a structure file that contains
one. Every other element without a standard weight is omitted rather than
guessed at, so an atom of one is reported as unidentified instead of being
given a fabricated mass.

Four tests pin the values most likely to be reintroduced from a stale source.

## Reference links corrected

- 3Dmol atom selection: `/doc/types/AtomSelectionSpec.html` was wrong, the page
  is at `/doc/AtomSelectionSpec.html`.
- Amber: the versioned `doc12/Amber.pdf` now points at `Manuals.php`, which
  tracks the current release rather than one particular version.

## Formulas for the outlier detector and curve fitter

Both tools named their methods without ever showing what they compute, which
left the conventions in use unverifiable. Both now render the formula with
KaTeX, followed by a definition of every symbol, in a disclosure beside the
method selector. KaTeX is loaded only on these two pages, since it is not free
and most tools have no equations to justify it.

**Outlier detector.** The three methods differ in ways that change which points
are flagged, so each carries its own constants and its own caveat: that the
z-score is computed from a mean and standard deviation the outlier itself
affects; that the modified z-score is median-based and so is not; that the
quartiles are taken by linear interpolation, which is R's and NumPy's default
but not the only definition in use, and that the fence multiplier is Tukey's
1.5 rather than something derived.

**Curve fitter.** Two assumptions were worth surfacing. Exponential, power and
logarithmic fits are not least squares on the data as given: they are
linearised in log space first, which minimises a different quantity, weights
small y values more heavily, and drops points that cannot be transformed. And
RMSE divides by n rather than by the residual degrees of freedom, so it is not
an unbiased estimate of the error variance. R-squared is stated as being
computed on the original scale, not the transformed one, since for a linearised
fit those give different numbers.

The LaTeX source of each formula is kept in a `data-tex` attribute. Rendered
KaTeX cannot be copied back out as LaTeX, and the formula is often wanted for a
methods section.

### Correction: the logarithmic model is not linearised

Checking the earlier claim against the vendored library found it wrong for one
of the three models, and the error predated the formula panel.

`LINEARISED_MODELS` listed exponential, power and logarithmic. Only the first
two transform y. `y = a + b ln x` is linear in its parameters, so regressing y
on ln x is ordinary least squares on the untransformed y: transforming the
predictor introduces no bias in the response. Verified numerically - no nearby
parameter pair fits the original scale better, which is what least squares
guarantees and a transformed fit does not. For exponential and power, parameters
fitting roughly 29% and 36% better do exist.

The wrong entry was surfacing an inaccurate note on the fit summary and in the
exported Python, and two existing tests asserted it. Both have been corrected.

A second claim was also wrong: points that cannot be transformed are not
silently dropped. `validateForModel` rejects the dataset with a message naming
the requirement, which is better behaviour than described. The panel now says
so.

### Correction: the three curve models are not fitted alike

An earlier summary lumped exponential, power and logarithmic together as
"linearised in log space". Reading the vendored regression.js shows they differ,
and the panel now describes each on its own terms:

- **logarithmic** regresses y on ln x. Only x is transformed, so the residuals
  minimised are the ones in y, exactly as for any linear model. It is not a
  log-space fit of y and carries none of that bias.
- **power** regresses ln y on ln x, unweighted, so the residuals really are in
  log space and small y values carry more influence than a direct fit gives
  them.
- **exponential** also works in log space but weights each point by y. That
  weighting is the standard correction for log-transform bias, so the result
  stays close to a direct non-linear fit rather than being skewed toward small
  values.

The constraints differ too, and a point that fails one causes the fit to be
refused with a message rather than being dropped: exponential needs every
y > 0, power needs every x > 0 and y > 0, logarithmic needs only x > 0.

RMSE dividing by n and R-squared being computed on the original scale were both
checked against the source and are stated correctly.
