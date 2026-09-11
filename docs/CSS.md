# Stylesheets

Three sources. Which one a rule belongs in depends on who owns the file.

| File | Owner | Hand-edit? |
|---|---|---|
| `src/output.css` | Tailwind build | No. Regenerated. |
| `src/tailwind/input.css` | you | Yes. Tokens, base rules, shared `.stk-*` components. |
| `src/stemkit-docs.css` | you | Yes. The "How to use" and FAQ furniture. |
| `src/tools/<tool>.css` | you | Yes. One tool only. |

Pages link them in this order, so a per-tool rule overrides a shared one:

```html
<link rel="stylesheet" href="src/output.css">
<link rel="stylesheet" href="src/stemkit-docs.css">
<link rel="stylesheet" href="src/tools/xvg-visualizer.css">
```

## Do not put component CSS in `src/output.css`

It is generated Tailwind output. Anything added by hand is deleted, silently,
by the next build:

```bash
npm run build:css     # after editing src/tailwind/input.css
npm run watch:css     # rebuild on change
```

Hand-written rules go in `src/tailwind/input.css` instead. Rules placed
between the `@tailwind` directives are emitted in that position, which is how
the file is organised: base rules before `@tailwind components`, shared
components between `components` and `utilities`, and the longhand utilities
after. Because the components sit before the utilities layer, a utility on the
same element still wins (`class="stk-btn w-full"`).

## Tokens

`src/tailwind/input.css` declares the palette, radii, shadows and control
heights as custom properties on `:root`, with a `.dark` block that overrides
the colours. Hand-written CSS reads them (`var(--stk-border)`,
`var(--stk-accent)`) rather than repeating hex values, so most rules no longer
need a `.dark` twin.

A tool page may re-point the accent tokens on `body` from its own stylesheet.
The coordinate manipulator is purple and the script generator rose; the shared
components pick the colour up without further rules:

```css
body { --stk-accent: #e11d48; --stk-accent-hover: #be123c; --stk-accent-text: #be123c; }
```

The tokens are the place to change a colour site-wide. Changing one changes
every page, which is the point, so look at a few pages afterwards.

## Shared components

`.stk-btn` (with `-primary`, `-ghost`, `-soft`, `-danger`, `-sm`, `-icon`),
`.stk-input` / `.stk-select` / `.stk-textarea`, `.stk-field` with `.stk-hint`
and `.stk-error`, `.stk-check`, `.stk-switch` (a `<button role="switch">`),
`.stk-range`, `.stk-seg`, `.stk-tabs` / `.stk-tab`, `.stk-panel` with its
header, body and footer, `.stk-group`, `.stk-disclosure` (a `<details>`),
`.stk-toolbar`, `.stk-kv`, `.stk-badge`, `.stk-code`, `.stk-callout`,
`.stk-drop`, `.stk-toasts` / `.stk-toast`, `.stk-modal`, `.stk-key`,
`.stk-table-wrap`, and the app-shell classes `.stk-shell`, `.stk-shell-pane`,
`.stk-shell-main`, `.stk-shell-tall`. Each is documented where it is defined.

Prefer these over a new per-tool class. When a tool needs something they do
not cover, add a rule to its own stylesheet using the tokens.

## Fonts

Inter is vendored under `css/fonts/inter/` (variable weight, latin subset,
SIL OFL 1.1, licence alongside) and declared with `@font-face` in
`input.css`; `tailwind.config.js` puts it at the front of `fontFamily.sans`.
No page loads a stylesheet, font or script from another host, so a page
renders the same offline as online. Font Awesome and the KaTeX fonts were
already vendored under `css/`.

## `src/stemkit-docs.css`

Holds `.stk-section`, `.stk-card`, `.stk-faq` and relatives, the "How to use"
and FAQ furniture every tool page carries.

These were originally copy-pasted per page across 21 pages and had drifted into
eight versions, so a chip on one page no longer matched the chip on another.
This file is the single reconciled copy; where versions disagreed, the most
complete rule won.

Two rules there deserve a note. The two- and three-column `.stk-grid` variants
apply from 768 px up; the per-tool stylesheets used to repeat that media query
because the shared file set the column count unconditionally and then reset
it. And below 768 px the reference tables (`.stk-table`, `.stk-syntax`) scroll
inside their own box, which is what stops a wide table from making the whole
page scroll sideways on a phone.

## Inline `style` attributes

Around five per page remain, deliberately. Each is a one-off nudge on a single
element (`margin-top:1rem`, `max-width:52rem`). A class name for a rule used once
adds indirection without removing duplication.

Known wart: some are near-duplicates differing only slightly, such as
`margin-bottom:.3rem` on one page against `.4rem` on another. Unifying them
changes rendered spacing, so it is a design decision, not a refactor. Left open.

## Conversion state

Every tool page links the three stylesheets above and carries no inline
`<style>` block. `404.html` keeps its own small block: it is not a tool and
does not need a stylesheet of its own. `home-sections-preview.html` is a
scratch page for the landing sections and keeps its block for the same
reason. `script-generator.html` uses `src/script-generator.css`, not
`src/tools/`.
