# PLUMED reference files

Written by PLUMED 2.9.3, not by STEMKit, so that the analysis code is tested
against PLUMED's own numbers.

- `HILLS_d`, `HILLS_t`, `HILLS_dt`: hills deposited by `plumed driver` on a
  four-atom random walk, biasing a distance (well-tempered, bias factor 8), a
  torsion (not tempered, periodic) and both at once.
- `COLVAR`: the distance, the torsion and the bias of the two-variable run.
- `fes_d.dat`, `fes_t.dat`, `fes_dt.dat`: `plumed sum_hills` on those hills,
  with `--min 0 --max 1.5 --bin 99`, `--bin 60` and
  `--min 0,-pi --max 1.5,pi --bin 29,20`.
