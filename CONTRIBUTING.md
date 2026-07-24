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

The site is static, so any local server will serve it:

    python3 -m http.server 8000

There is no build step for the pages themselves. Styles are generated:
`npm run build:css` after editing `src/tailwind/input.css`. Do not edit
`src/output.css` directly, as the next build overwrites it.

## Where code belongs

The split matters more than anything else here.

`src/core/` holds the computation: parsing, statistics, geometry, unit
conversion, fitting. It touches no DOM, has no side effects, and is what the
tests cover. `js/` holds one script per page, which reads the DOM, calls the
core and writes results back.

A change to how something is *calculated* belongs in `src/core/` with a test. A
change to how something is *shown* belongs in `js/`. If a pull request puts a
formula inside a click handler, it will be asked to move.

## Tests

    npm test                 run everything
    npm run test:coverage    with a coverage report

New behaviour in the core needs a test. Fixing a bug means adding the test that
would have caught it, which is more useful than testing the fix. Several of the
existing tests exist because a defect shipped and nothing failed:
`tests/units.test.js` has a case pinning a wavelength conversion that silently
returned a plausible but wrong number for a year.

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

Match the surrounding code. It is plain ES modules with no transpiler, four
spaces in the older page scripts and two in the core.

Comments should explain why something is the way it is, particularly where the
obvious approach was wrong. Comments restating what the next line does are
noise.

## Pull requests

Keep them focused; a reviewer can assess one change well and five changes
badly. Say what the change does and how you checked it. If it alters a number
any existing user might be relying on, say so plainly in the description.

## Conduct

By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).
