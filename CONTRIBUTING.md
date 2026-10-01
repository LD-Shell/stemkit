# Contributing to STEMKit

Thanks for taking an interest. This covers how to get set up, what a change
should look like, and where to ask for help.

## Getting help or reporting a problem

Open an issue: <https://github.com/LD-Shell/stemkit/issues>

For a bug, the useful things to include are what you did, what you expected,
what happened, and the browser you saw it in. If a tool mishandled a file, a
small sample that reproduces it is worth more than a description; strip it down
to the few rows or atoms that still show the problem.

Security-sensitive reports are better sent privately through the repository's
security advisory page than filed as a public issue.

## Setting up

    git clone https://github.com/LD-Shell/stemkit.git
    cd stemkit
    npm install
    npm test

You need Node 18 or later.

The site is static, so any local server will serve it:

    python3 -m http.server 8000

There is no build step for the pages themselves. Styles are generated: run
`npm run build:css` after editing `src/tailwind/input.css`, and after using a
Tailwind class no page used before, since the build keeps only the classes it
finds. Do not edit `src/output.css` directly, as the next build overwrites it.

## Where code belongs

The split matters more than anything else here.

`src/core/` holds the computation: parsing, statistics, geometry, unit
conversion, fitting, and the GROMACS, PLUMED and LAMMPS inputs. It touches no
DOM, has no side effects, and most of the tests are for it. `js/` holds the
page scripts, which read the DOM, call the core and write results back: one per
page, the shared chrome (`site.js`), the shared plot area and Python panel
(`figure-plot.js`, `python-panel.js`), and the MD workflow generator's tabs
(`script-generator-*.js`). Page logic worth testing goes in a DOM-free file
beside its script, such as `script-generator-lammps-model.js`, so the tests can
run it in Node.

A change to how something is *calculated* belongs in `src/core/` with a test. A
change to how something is *shown* belongs in `js/`. If a pull request puts a
formula inside a click handler, it will be asked to move.

## Tests

    npm test                       run everything
    npm run test:coverage          with a coverage report
    node tests/smoke.mjs           the package, imported by name
    npm run check:chrome           header, catalogue and footer agree
    npm run check:links:internal   no broken links between pages
    npm run check:sitemap          every page is in sitemap.xml

CI runs all but the coverage report on every pull request, with the tests on
Node 18, 22 and 24. Some tests run the real programs (Python, PLUMED, LAMMPS
through `LMP_BIN`, GROMACS through `GMX_BIN`) and are skipped where those are
not installed.

New behaviour in the core needs a test. Fixing a bug means adding the test that
would have caught it, which is more useful than testing the fix.

Please do not weaken an assertion to make a change pass. If a test is wrong,
say so in the pull request and change it deliberately.

## Scientific correctness

This is a tool people take numbers out of, so a few things are treated
strictly:

- **State the convention.** Where more than one definition exists, say which is
  used and why. Quartiles, R-squared, sample against population standard
  deviation, and standard atomic weights are all places where reasonable
  choices differ.
- **Cite the source** for constants and published values, in the code, not only
  in the documentation.
- **Never substitute a plausible value for a missing one.** An unidentifiable
  atom contributes no mass and is reported; it does not quietly borrow carbon's.
- **Show the working** where a result is not self-evidently checkable.

## Style

Match the surrounding code. It is plain JavaScript with no transpiler: ES
modules in the core and most page scripts, classic scripts in `site.js` and a
few older pages. Four spaces in the older page scripts, two in the core and the
newer ones.

Comments should explain why something is the way it is, particularly where the
obvious approach was wrong. Comments restating what the next line does are
noise.

Styles follow `docs/CSS.md`: colours and sizes come from the tokens in
`src/tailwind/input.css`, shared components are preferred over new per-tool
classes, and no page loads a stylesheet, font or script from another host, so
every tool keeps working offline. Check a change at 375, 768, 1280 and
1920 px in both themes before opening a pull request.

The header, the theme script and the tool names are shared by every page but
copied into each one, since the pages have no build step. `js/site.js` holds
the one catalogue of tools, with each tool's name, description, search terms
and next steps. A new tool needs an entry there, a card on the home page and a
link in the footer of every page; `npm run check:chrome` fails until the three
agree and the header matches the other pages. Then run `npm run build:sitemap`;
CI's `check:sitemap` fails while a page is missing from `sitemap.xml`.

## Pull requests

Keep them focused; a reviewer can assess one change well and five changes
badly. Say what the change does and how you checked it. If it alters a number
any existing user might be relying on, say so plainly in the description.

## Conduct

By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).
