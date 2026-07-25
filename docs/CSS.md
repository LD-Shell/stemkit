# Stylesheets

Styles come from three places, and which one a rule belongs in depends on who
owns the file.

```
src/output.css            compiled Tailwind utilities: generated, never hand-edited
src/stemkit-docs.css      shared documentation components (.stk-*), used by every tool page
src/tools/<tool>.css      styles specific to one tool
```

Each tool page links them in that order, so a per-tool rule can override a
shared one:

```html
<link rel="stylesheet" href="src/output.css">
<link rel="stylesheet" href="src/stemkit-docs.css">
<link rel="stylesheet" href="src/tools/xvg-visualizer.css">
```

## Why component CSS is not in `src/output.css`

`output.css` is generated Tailwind build output, around 69 KB of compiled
utility classes. A hand-written rule placed there survives only until the next
`npm run build:css`, which regenerates the file and deletes the addition
silently. Hand-written component CSS therefore lives in files the build does not
own.

Rebuild the utilities with:

```bash
npm run build:css     # after editing src/tailwind/input.css
npm run watch:css     # rebuild on change while developing
```

## The shared documentation block

`.stk-section`, `.stk-card`, `.stk-faq` and their relatives were originally
copy-pasted into each of the 21 pages, and had drifted into eight different
versions: a chip on one page no longer matched the chip on another.
`src/stemkit-docs.css` is the single reconciled copy. Where versions disagreed
the most complete rule was kept, so no page lost styling.

## Remaining inline `style` attributes

Two repeated patterns were promoted to `.stk-label` and `.stk-body`. Roughly
five inline attributes per page remain and are deliberate: each is a one-off
nudge on a single element, such as `margin-top:1rem` or `max-width:52rem`.
Inventing a class name for a rule used once adds indirection without removing
duplication.

Some of these are near-duplicates that differ only slightly:
`margin-bottom:.3rem` on one page against `.4rem` on another. That is the same
drift as the documentation block, at small scale. Unifying them would change
the rendered spacing, so it is a visual decision rather than a refactor and is
left open.

## Coverage

Six tool stylesheets exist for pages that still carry their own inline
`<style>` block: `plot-builder`, `doi-fetcher`, `script-generator`,
`structure-inspector`, `pomodoro`, `sandbox` and `decision`. Switching one over
means deleting its `<style>` block and adding the two `<link>` tags above; that
edit pairs naturally with any other work on the page.
