# PLUMED reference files

Written by PLUMED, not by STEMKit, so that the analysis code is tested
against PLUMED's own numbers.

Written by PLUMED 2.9.3:

- `HILLS_d`, `HILLS_t`, `HILLS_dt`: hills deposited by `plumed driver` on a
  four-atom random walk, biasing a distance (well-tempered, bias factor 8), a
  torsion (not tempered, periodic) and both at once.
- `COLVAR`: the distance, the torsion, and the bias and its reweighting bias
  (`m3.bias`, `m3.rbias`) of the two-variable run.
- `fes_d.dat`, `fes_t.dat`, `fes_dt.dat`: `plumed sum_hills` on those hills,
  with `--min 0 --max 1.5 --bin 99`, `--bin 60` and
  `--min 0,-pi --max 1.5,pi --bin 29,20`.

Written by PLUMED 2.11:

- `fes_dt_d.dat`, `fes_dt_t.dat`: `HILLS_dt` along one variable with the other
  integrated out, `plumed sum_hills --idw d --kt 2.494339` (and `--idw t`),
  `--min 0,-pi --max 1.5,pi` and `--bin 99,40` (and `--bin 99,60`).
- `HILLS_adaptive`: METAD with `ADAPTIVE=DIFF` on a distance and a torsion
  (multivariate hills, `sigma_d_d sigma_t_t sigma_t_d`); `fes_adaptive.dat` is
  `sum_hills` with `--min 0,-pi --max 1.5,pi --bin 29,20`, and
  `fes_adaptive_d.dat` the same with `--bin 99,40 --idw d --kt 2.494339`.
- `HILLS_wide`: fifty hills 1.5 rad wide on a periodic torsion, wider than
  half the period; `fes_wide.dat` is `sum_hills --min -pi --max pi --bin 100`.
- `fes_d_nokernel.dat`, `fes_d_gaussian.dat`: `sum_hills --min 0 --max 1.5
  --bin 99` on `HILLS_d` with its `kerneltype` line left out (as PLUMED 2.7
  and older wrote it), and with it set to `gaussian`.
- `HILLS_restart`, `COLVAR_restart`: a well-tempered METAD (PACE=25) killed at
  step 1499 and continued with `--restart --initial-step 1000` from the
  checkpoint at step 1000. The file keeps the 19 hills the first part laid
  after the checkpoint; the restarted METAD read all 59 back (the COLVAR's
  `m.bias` at t = 2.0 includes them). `fes_restart.dat` is `sum_hills --min
  0.3 --max 0.7 --bin 99` on all of them.
- `COLVAR_wall`: METAD with `CALC_RCT` beside `UPPER_WALLS AT=1.0`, printing
  `d metad.bias metad.rbias uw.bias`; the wall pushes about half the frames.
