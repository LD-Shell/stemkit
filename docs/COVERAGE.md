# Reading the coverage report

`npm run test:coverage` reports about 94% of statements and 98% of lines across
`src/core/`. Two files sit below that and neither is an untested gap, so they
are explained here rather than left to look like one.

## `src/core/index.js` reports 0%

It is a re-export barrel: no logic, only `export { ... } from './x.js'`
statements. Jest instruments the file but nothing in it executes as a
*statement*, so the counter stays at zero however thoroughly the exports are
used.

The aggregate surface is still checked. `tests/smoke.mjs` imports the barrel and
asserts every expected export is present and of the right type, which is what
catches a missing or misspelled re-export. Run it with:

    node tests/smoke.mjs

That check matters more than the number: a broken barrel fails every consumer
while every unit test continues to pass, because the tests import the modules
directly.

## `src/core/vendor.js` reports about 41%

This is the dependency-injection boundary for the vendored browser libraries.
Most of its uncovered lines are the failure paths that raise when a library has
not been registered, and those messages are deliberately long and specific
because they are what a developer sees when a page loads a bundle in the wrong
order.

The registration path is covered. The failure paths are exercised where a test
needs them, and the rest exist to produce a good error rather than to be
measured.

## What is worth watching

Coverage on the numerical modules, not the total. `statistics.js`,
`structure.js`, `units.js`, `curve-fitting.js` and `outliers.js` are where a
regression would change a published number, and those are the figures to check
if the total moves.
