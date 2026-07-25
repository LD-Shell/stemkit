# Changelog

Notable changes to STEMKit and `@stemkit/core`. Entries that alter a reported
number are marked **[output change]**, because a figure produced with an earlier
version may need re-checking.

## Unreleased

### Fixed: numerical correctness

- **[output change] Standardised moments used the wrong denominator.** Skewness
  and kurtosis are defined against the population standard deviation; the
  implementation used the Bessel-corrected sample value, deflating skewness by
  `((n-1)/n)^(3/2)`, about 15% at n = 10. Both moments feed the
  D'Agostino–Pearson statistic, so every normality p-value the tools reported
  was affected.
- **[output change] Upper-tail probabilities underflowed to zero.** Tails were
  computed as `1 - cdf(x)`, which cancels completely once the CDF rounds to
  unity in double precision. A one-way ANOVA at F = 377.545 on 2 and 21 degrees
  of freedom reported p = 0 instead of 3.4611747382914e-17. Tails now use the
  complementary incomplete beta and gamma forms, and an asymptotic expansion
  takes over beyond |z| ≈ 8 where the vendored `erfc` underflows.
- **[output change] Element inference misassigned metals and hydrogens.** Haem
  iron was given the mass of fluorine (18.998 Da rather than 55.845 Da),
  selenomethionine selenium the mass of sulfur, and numeric-prefixed hydrogens
  (`1HB`, `2HG1`) no mass at all. Molecular weights and centres of mass for
  metalloproteins were wrong as a result.
- **[output change] Unidentified atoms borrowed carbon's mass.** `atomicMass`
  returned a 12.011 default for anything it could not identify. The common case
  was badly wrong: TIP4P and TIP5P water carry a massless charge site, so every
  water in a solvated system was reported at 30.03 Da instead of 18.015, a 67%
  overstatement, or 120 kDa of mass that does not exist across 10,000 waters.
  Three outcomes are now distinct: a recognised element returns its standard
  atomic weight, a recognised virtual site (`MW`, `LP`, `DUM`, `MCH3`, `MNH3`
  and relatives) returns zero because that is its mass, and anything else
  returns zero and is recorded so it can be named rather than folded silently
  into the total.
- **[output change] Reciprocal units ignored the `inverse` flag.** `wl_nm`
  (wavelength) had lost its marker and `convert()` had no branch for it, so a
  532 nm laser line converted to 0.0000532 cm⁻¹ instead of 18797 cm⁻¹.
  `convert()` now inverts both entering and leaving the base unit.
- **[output change] kBT energy-equivalent scales returned `NaN`.** `kt_kj`,
  `kt_kcal` and `kt_mev` are restored in `convertTemperature()` using exact
  SI 2019 constants, cross-checked against the independent `convertKT()` helper
  to 1e-12.
- **[output change] Atomic weights updated to CIAAW 2024.** Most entries
  differed only in rounding, but four were wrong rather than imprecise:
  zirconium 91.224 → 91.222, gadolinium 157.25 → 157.249, lutetium
  174.97 → 174.96669, and argon 39.948 → 39.95 (argon's standard weight is the
  interval [39.792, 39.963]; 39.948 is an older single figure still in
  circulation). Values are now carried at published precision with their source
  cited. Fourteen elements whose isotopic composition varies measurably use the
  conventional abridged value; technetium uses the mass number of its
  longest-lived isotope. Elements with no standard weight are omitted rather
  than guessed, so an atom of one is reported as unidentified.
- **`latex-formatter` never ran.** An unclosed `forEach` callback in the
  theme-toggle handler raised `SyntaxError: missing ) after argument list`, so
  the script never parsed and the tool was dead in production. The duplicate
  theme toggle is removed; the page's shared inline script already handles
  theming and the second handler cancelled it out.
- **The structure-inspector busy overlay could never be dismissed.**
  `#busyOverlay` is styled by an id selector setting `display:flex`, while the
  script hid it by toggling the `.hidden` class. Id specificity (1,0,0) outranks
  class (0,1,0), so the spinner stayed on screen and swallowed mouse input to
  the 3D canvas. Fixed with `#busyOverlay.hidden { display:none }`.
- **DOI-to-BibTeX field filtering did nothing.** The filter was applied to a
  copy that was then discarded.
- **Coordinate Manipulator accepted files but never loaded them.** The UI layer
  targeted a DOM that does not exist.

### Fixed: documentation of the fitting models

An earlier description of the vendored regression.js fits was wrong, and the
error had reached the in-app formula panel, the exported Python, and two tests
that asserted it:

- **Logarithmic is not a log-space fit.** `y = a + b·ln x` is linear in its
  parameters, so regressing y on ln x is ordinary least squares on untransformed
  y: transforming the predictor introduces no bias in the response. Verified
  numerically: no nearby parameter pair fits the original scale better. It has
  been removed from `LINEARISED_MODELS`.
- **Power regresses ln y on ln x, unweighted,** so its residuals really are in
  log space and small y values carry more influence than a direct fit gives them.
- **Exponential also works in log space but weights each point by y,** which is
  the standard correction for log-transform bias and keeps the result closer to
  a direct non-linear fit. For exponential and power, parameter pairs fitting
  roughly 29% and 36% better on the original scale do exist.
- **Untransformable points are not dropped.** `validateForModel` refuses the
  dataset with a message naming the requirement: exponential needs every y > 0,
  power every x > 0 and y > 0, logarithmic only x > 0.

### Added

- **ISO 4 journal abbreviation, in two tiers.** `journals` maps a complete
  title to its complete abbreviation, which is exact but covers only titles
  someone has entered. `iso4` applies the ISSN List of Title Word Abbreviations word by
  word, so any title can be abbreviated. Tier 1 runs first and tier 2 handles
  whatever it does not recognise.
- **Molecular weight now shows its working.** A "how?" link opens a breakdown:
  each element, its atom count, the weight used and its contribution, totalled,
  with massless sites and unidentified atoms stated separately rather than left
  to be inferred from a total that does not match the atom count. The same
  breakdown downloads as CSV with a header recording the source file, method,
  weight set and exclusions. `massBreakdown` lives in the core and is tested for
  full atom accounting and agreement with `centreOfMass`.
- **Equivalent `gmx editconf` command** for coordinate-manipulator operations,
  verified against `editconf.cpp`. Note that `-box` centres silently.
- **Triclinic simulation cell support**, including cell outline rendering and
  correct handling of rotation and periodicity.
- **Undo and redo** in the coordinate manipulator.
- **Grubbs' test p-value** reported by the outlier detector alongside the flag
  count, with an explanation when the MAD fallback was used.
- **Explicit WebGL requirement handling** in the structure inspector, which
  needs WebGL rather than a discrete GPU.
- `listAllCategories()` and `isAffine(category)` in `units`. `listCategories()`
  now returns only multiplicative categories, since affine units have no
  conversion factor or base unit. Marked-up unit forms live alongside the plain
  ones as `symbolHtml`/`nameHtml`, keeping the core presentation-neutral.
- Full unit metadata: 11 categories and 70 units, including the `temperature`
  category. All 64 factors shared with the previous table were verified
  identical before merging.

### Changed

- Computation extracted from the page scripts into `src/core/` as DOM-free ES
  modules, tested independently and importable under Node.js. See
  `CONTRIBUTING.md` for where code belongs.
- Inline `<style>` blocks moved out of the tool pages into `src/tools/` and
  `src/stemkit-docs.css`. See `docs/CSS.md`.
- Plot digitizer: native `alert()` dialogs replaced, the resolution note no
  longer covers the figure, and the Python export script is emitted as intended.
- PNG exports render at the same sharpness as the screen.
- Measurement labels no longer stack on every redraw.
- Custom abbreviation rules persist across sessions.

### Notes

Two audio files referenced by the Pomodoro timer still need to be added.

---

This changelog was condensed from a longer development log kept during the
extraction of `src/core/`. The full narrative, including the audit passes and
per-tool verification steps, remains in the repository's git history.
