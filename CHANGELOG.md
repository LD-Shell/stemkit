# Changelog

Notable changes to STEMKit and `@stemkit/core`.

`[output]` marks a change that alters a reported number. Figures produced with an
earlier version are worth re-checking.

## Unreleased

### Fixed: numerics

- `[output]` **Skewness and kurtosis used the sample SD, not the population SD.**
  Deflated skewness by `((n-1)/n)^(3/2)`, about 15% at n = 10. Both moments feed
  D'Agostino-Pearson, so every normality p-value was affected.
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

### Known issues

- Two audio files referenced by the Pomodoro timer are missing.
- `iso4` has no `tests/smoke.mjs` case and is the lowest-covered domain module.

---

Condensed from a longer development log kept during the extraction of
`src/core/`. Full narrative, including audit passes and per-tool verification, is
in the git history.
