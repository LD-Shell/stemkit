# CSS extraction

## What changed

Inline `<style>` blocks are removed from the tool pages and replaced by two
kinds of stylesheet:

```
src/stemkit-docs.css      shared documentation styles (.stk-*), used by every tool page
src/tools/<tool>.css      styles specific to one tool
```

Each page links them after the existing Tailwind output:

```html
<link rel="stylesheet" href="src/output.css">
<link rel="stylesheet" href="src/stemkit-docs.css">
<link rel="stylesheet" href="src/tools/xvg-visualizer.css">
```

## Why not put these in `src/output.css`

`output.css` is **generated Tailwind build output** — 69 KB of compiled utility
classes, committed as "Add compiled tailwind stylesheet". Hand-written rules
placed there survive only until the next `npx tailwindcss` run, which
regenerates the file and silently deletes them.

The rules extracted here are hand-written component CSS, not utilities, so they
belong in files the build does not own.

## What the extraction found

The shared documentation block (`.stk-section`, `.stk-card`, `.stk-faq`, and so
on) was copy-pasted into **21 pages** and had drifted into **eight different
versions**. A chip on one page no longer matched the chip on another.

`src/stemkit-docs.css` reconciles these into one file. Where versions
disagreed, the most complete rule was kept, so no page loses styling. A
selector-level diff confirms **zero selectors lost** across all 20 tools.

## Remaining inline `style=` attributes

Two repeated patterns were promoted to `.stk-label` and `.stk-body`. Roughly
five per page remain, and they are left deliberately: each is a one-off nudge
on a single element (`margin-top:1rem`, `max-width:52rem`). Inventing a class
name for a rule used once adds indirection without removing duplication.

Several are near-duplicates that differ only slightly — `margin-bottom:.3rem`
on one page against `.4rem` on another. That is the same drift as the docs
block, at small scale. Unifying them is worthwhile but is a visual change
rather than a refactor, so it is flagged here rather than performed silently.

## Files in this drop

- `src/stemkit-docs.css` — shared, replaces the drifted block on every page
- `src/tools/*.css` — 20 files, one per tool
- `html/*.html` — patched pages for all fourteen converted tools

The remaining 6 CSS files (`plot-builder`, `doi-fetcher`, `script-generator`,
`structure-inspector`, `pomodoro`, `sandbox`, `decision`) are ready to use, but
their pages are not patched:
that edit pairs naturally with each tool's UI rewrite. To apply one by hand,
delete the `<style>` blocks and add the two `<link>` tags shown above.

## Verification performed

- Every selector present inline is present in exactly one new file (0 lost).
- Both patched pages contain zero `<style>` blocks.
- Served over HTTP, every referenced stylesheet, the ES module entry point, and
  the core modules return 200.
