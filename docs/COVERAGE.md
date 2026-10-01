# Coverage

```bash
npm run test:coverage
```

Roughly 88% of statements and 93% of lines across `src/core/`. Some suites run
only when Python, PLUMED, LAMMPS or GROMACS is installed, so the figure moves a
little between machines.

Two files report far below that without being untested gaps. (`lammps-input.js`
also reports far below it, and that one is a gap; see below.)

## `index.js` reports 0%

A re-export barrel: no logic, only `export { ... } from './x.js'`. Jest
instruments it, but nothing in it executes as a *statement*, so the counter stays
at zero no matter how heavily the exports are used.

The barrel is still checked, by `tests/smoke.mjs`, which imports the package by
name, as a user's script does, and calls into 28 of the 43 modules through it; a
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
`units.js`, `curve-fitting.js`, `nonlinear-fit.js`, `outliers.js`. A regression
in any of those changes a published number.

Real gaps, unlike the two files above, are genuinely untested code:

- `lammps-input.js`, the LAMMPS input checker: about 63% of statements, 56% of
  branches, 80% of functions. Its agreement with LAMMPS is tested separately,
  by `npm run check:lammps` against an installed LAMMPS.
- `lammps-data.js`: about 83% of statements, 76% of branches.
- `gromacs-mdp.js`: about 84% of statements, 76% of branches.
- `iso4.js`: about 88% of statements, 80% of branches, 90% of functions.

`iso4.js` is also one of the 15 modules `smoke.mjs` does not call into;
`docs/SETUP.md` lists them.
