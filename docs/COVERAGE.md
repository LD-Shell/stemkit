# Coverage

```bash
npm run test:coverage
```

Roughly 94% of statements and 98% of lines across `src/core/`.

Two files report far below that. Neither is an untested gap.

## `index.js` reports 0%

A re-export barrel: no logic, only `export { ... } from './x.js'`. Jest
instruments it, but nothing in it executes as a *statement*, so the counter stays
at zero no matter how heavily the exports are used.

The barrel is still checked, by `tests/smoke.mjs`, which imports the package by
name, as a user's script does, and calls into 15 of the 17 modules through it; a
missing export fails the import itself:

```bash
node tests/smoke.mjs
```

That check matters more than the percentage. A broken barrel fails every
consumer while every unit test passes, because the unit tests import modules
directly.

## `vendor.js` reports about 41%

The dependency-injection boundary for the vendored browser libraries. Most
uncovered lines are the failure paths that throw when a library was never
registered. Their messages are long and specific on purpose: they are what a
developer sees when a page loads bundles in the wrong order.

The registration path is covered. The failure paths are exercised where a test
needs one. The rest exist to produce a good error, not to be measured.

## What to watch

The numerical modules, not the total: `statistics.js`, `structure.js`,
`units.js`, `curve-fitting.js`, `outliers.js`. A regression in any of those
changes a published number.

One real gap: `iso4.js` at about 88% of statements, 80% of branches, 90% of
functions. Unlike the two files above, that is genuinely untested code. It is
also one of the two modules, with `journals.js`, that `smoke.mjs` does not
call into.
