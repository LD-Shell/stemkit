# Stylesheets

Three sources. Which one a rule belongs in depends on who owns the file.

| File | Owner | Hand-edit? |
|---|---|---|
| `src/output.css` | Tailwind build | No. Regenerated. |
| `src/stemkit-docs.css` | you | Yes. Shared `.stk-*` components. |
| `src/tools/<tool>.css` | you | Yes. One tool only. |

Pages link them in that order, so a per-tool rule overrides a shared one:

```html
<link rel="stylesheet" href="src/output.css">
<link rel="stylesheet" href="src/stemkit-docs.css">
<link rel="stylesheet" href="src/tools/xvg-visualizer.css">
```

## Do not put component CSS in `src/output.css`

It is generated Tailwind output, around 69 KB of compiled utilities. Anything
added by hand is deleted, silently, by the next build:

```bash
npm run build:css     # after editing src/tailwind/input.css
npm run watch:css     # rebuild on change
```

## `src/stemkit-docs.css`

Holds `.stk-section`, `.stk-card`, `.stk-faq` and relatives, the "How to use" and
FAQ furniture every tool page carries.

These were originally copy-pasted per page across 21 pages and had drifted into
eight versions, so a chip on one page no longer matched the chip on another. This
file is the single reconciled copy; where versions disagreed, the most complete
rule won.

## Inline `style` attributes

Around five per page remain, deliberately. Each is a one-off nudge on a single
element (`margin-top:1rem`, `max-width:52rem`). A class name for a rule used once
adds indirection without removing duplication.

Known wart: some are near-duplicates differing only slightly, such as
`margin-bottom:.3rem` on one page against `.4rem` on another. Unifying them
changes rendered spacing, so it is a design decision, not a refactor. Left open.

## Conversion state

20 stylesheets in `src/tools/`. Six tool pages still carry their own inline
`<style>` block:

- `decision.html`
- `doi-fetcher.html`
- `plot-builder.html`
- `pomodoro.html`
- `sandbox.html`
- `structure-inspector.html`

To convert one: delete its `<style>` block, add the two `<link>` tags above.
Pairs naturally with other work on the page.

`404.html` also has an inline block. It is not a tool and does not need one.
`script-generator.html` uses `src/script-generator.css`, not `src/tools/`.
