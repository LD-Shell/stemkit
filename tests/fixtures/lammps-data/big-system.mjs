/*
 * A large LAMMPS data file made on the fly: TIP3P water on a cubic lattice
 * with a few Na+ and Cl- ions, atom_style full, with bonds and angles.
 * bigWaterSystem(333334) gives 1 000 134 atoms: 333 334 waters and 66 ions
 * of each kind (about 72 MB of text).
 */

export function bigWaterSystem(nWater, { ions = 0 } = {}) {
  const nIon = ions || 2 * Math.floor(nWater / 5000);
  const sites = nWater + nIon;
  const side = Math.ceil(Math.cbrt(sites));
  const a = 3.1;
  const L = side * a;
  const natoms = 3 * nWater + nIon;
  const parts = [];
  parts.push('Generated water box for STEMKit tests, units = real\n\n');
  parts.push(`${natoms} atoms\n4 atom types\n${2 * nWater} bonds\n1 bond types\n${nWater} angles\n1 angle types\n\n`);
  parts.push(`0 ${L.toFixed(4)} xlo xhi\n0 ${L.toFixed(4)} ylo yhi\n0 ${L.toFixed(4)} zlo zhi\n\n`);
  parts.push('Masses\n\n1 15.9994 # OW\n2 1.008 # HW\n3 22.99 # Na\n4 35.45 # Cl\n\n');
  parts.push('Atoms # full\n\n');
  const f = (v) => v.toFixed(4);
  let id = 0;
  let mol = 0;
  let chunk = [];
  const flush = () => { parts.push(chunk.join('')); chunk = []; };
  // Ions sit on every (sites / nIon)-th lattice point, waters on the rest.
  const every = nIon ? Math.floor(sites / nIon) : Infinity;
  let placedIons = 0;
  let placedWater = 0;
  for (let k = 0; k < sites; k++) {
    const ix = k % side;
    const iy = Math.floor(k / side) % side;
    const iz = Math.floor(k / (side * side));
    const x = (ix + 0.5) * a;
    const y = (iy + 0.5) * a;
    const z = (iz + 0.5) * a;
    mol++;
    if (placedIons < nIon && k % every === every - 1) {
      const na = placedIons % 2 === 0;
      chunk.push(`${++id} ${mol} ${na ? 3 : 4} ${na ? '1.0' : '-1.0'} ${f(x)} ${f(y)} ${f(z)}\n`);
      placedIons++;
    } else if (placedWater < nWater) {
      chunk.push(`${++id} ${mol} 1 -0.834 ${f(x)} ${f(y)} ${f(z)}\n`);
      chunk.push(`${++id} ${mol} 2 0.417 ${f(x + 0.9572)} ${f(y)} ${f(z)}\n`);
      chunk.push(`${++id} ${mol} 2 0.417 ${f(x - 0.2400)} ${f(y + 0.9266)} ${f(z)}\n`);
      placedWater++;
    } else {
      mol--;
    }
    if (chunk.length > 30000) flush();
  }
  flush();
  // Bonds and angles: the oxygen of each water is followed by its two H.
  const bonds = [];
  const angles = [];
  let nb = 0;
  let na = 0;
  const atomsText = parts.slice(5).join('');
  const re = /^(\d+) \d+ 1 /gm;
  let m;
  while ((m = re.exec(atomsText))) {
    const o = +m[1];
    bonds.push(`${++nb} 1 ${o} ${o + 1}\n${++nb} 1 ${o} ${o + 2}\n`);
    angles.push(`${++na} 1 ${o + 1} ${o} ${o + 2}\n`);
  }
  parts.push('\nBonds\n\n', bonds.join(''), '\nAngles\n\n', angles.join(''));
  return parts.join('');
}
