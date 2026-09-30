/**
 * @module core/plumed-atoms
 *
 * From a structure file to the atom lists a PLUMED input needs.
 *
 * Every list here numbers atoms by their position in the structure file,
 * counting from 1, not by the serial number written in it: a `.gro` or PDB
 * serial wraps round after 99 999 and may have gaps. That is how GROMACS
 * passes atoms to PLUMED. Under LAMMPS, fix plumed passes `atom->tag - 1`
 * (fix_plumed.cpp:350), so PLUMED counts by atom ID, and these lists hold
 * only when the file lists the atoms in order of ID, from 1 (fix plumed
 * already refuses IDs with gaps).
 *
 * Systems for nucleation or solvation studies hold hundreds of copies of one
 * molecule, and the input needs the same atom of every copy (`1-2400:8`), a
 * centre per copy, or a direction per copy. Writing those by hand is where
 * off-by-one errors come from; here they follow from the structure.
 */

import { selectAtoms } from './selection.js';
import { elementSymbol } from './structure.js';
import { versionAtLeast } from './plumed.js';

const LABEL_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Write atom numbers the shortest way PLUMED reads them: single numbers,
 * ranges and ranges with a stride.
 *
 * The order is kept, since PLUMED pairs atoms by position (`ATOMS=5,1` is not
 * `ATOMS=1,5`). Only runs that climb by a constant step are folded.
 *
 * @param {number[]} indices - Atom numbers, counted from 1.
 * @param {{minRun?:number}} [options] - Shortest run written as a range.
 * @returns {string}
 */
export function compressAtomList(indices, options = {}) {
  const { minRun = 3 } = options;
  const list = (Array.isArray(indices) ? indices : [])
    .map(Number).filter(n => Number.isInteger(n) && n > 0);
  const out = [];
  let i = 0;
  while (i < list.length) {
    let j = i + 1;
    if (j < list.length) {
      const step = list[j] - list[i];
      if (step > 0) {
        while (j + 1 < list.length && list[j + 1] - list[j] === step) j += 1;
        const count = j - i + 1;
        if (count >= minRun || (count === 2 && step === 1 && minRun <= 2)) {
          out.push(step === 1 ? `${list[i]}-${list[j]}` : `${list[i]}-${list[j]}:${step}`);
          i = j + 1;
          continue;
        }
      }
    }
    out.push(String(list[i]));
    i += 1;
  }
  return out.join(',');
}

/**
 * Give every atom its PLUMED number: its position in the file, from 1.
 *
 * @param {object[]} atoms - Records from `core/structure.js`.
 * @returns {object[]} New records with `index` set.
 */
export function numberAtoms(atoms) {
  return (Array.isArray(atoms) ? atoms : []).map((a, i) => ({ ...a, index: i + 1 }));
}

/**
 * Split a structure into molecules: runs of atoms that share a residue name,
 * number and chain. The residue number alone is not enough, since it wraps
 * round in a large `.gro` file and restarts in each chain.
 *
 * @param {object[]} atoms
 * @returns {Array<{name:string, resSeq:number, chain:string, first:number,
 *   atoms:Array<{index:number, name:string}>}>}
 */
export function moleculesOf(atoms) {
  const out = [];
  let cur = null;
  (Array.isArray(atoms) ? atoms : []).forEach((a, i) => {
    const name = String(a.resName || a.resn || '').trim();
    const resSeq = Number(a.resSeq !== undefined ? a.resSeq : a.resi);
    const chain = String(a.chain || '').trim();
    if (!cur || cur.name !== name || cur.resSeq !== resSeq || cur.chain !== chain) {
      cur = { name, resSeq, chain, first: i + 1, atoms: [] };
      out.push(cur);
    }
    cur.atoms.push({ index: i + 1, name: String(a.atomName || a.atom || '').trim() });
  });
  return out;
}

/**
 * What a system is made of: one entry per residue name.
 *
 * `uniform` says every copy has the same atoms in the same order, which is
 * what lets a per-molecule list be written as a stride.
 *
 * @param {object[]} atoms
 * @returns {Array<{name:string, molecules:number, atomsPerMolecule:number,
 *   atomNames:string[], firstAtom:number, lastAtom:number, uniform:boolean,
 *   contiguous:boolean}>}
 */
export function speciesOf(atoms) {
  const by = new Map();
  for (const m of moleculesOf(atoms)) {
    if (!by.has(m.name)) by.set(m.name, []);
    by.get(m.name).push(m);
  }
  const out = [];
  for (const [name, mols] of by) {
    const names = mols[0].atoms.map(a => a.name);
    const uniform = mols.every(m => m.atoms.length === names.length &&
      m.atoms.every((a, i) => a.name === names[i]));
    const firstAtom = mols[0].atoms[0].index;
    const last = mols[mols.length - 1];
    const lastAtom = last.atoms[last.atoms.length - 1].index;
    const total = mols.reduce((n, m) => n + m.atoms.length, 0);
    out.push({
      name,
      molecules: mols.length,
      atomsPerMolecule: names.length,
      atomNames: names,
      firstAtom,
      lastAtom,
      uniform,
      contiguous: lastAtom - firstAtom + 1 === total
    });
  }
  return out;
}

function moleculesNamed(atoms, species) {
  return moleculesOf(atoms).filter(m => m.name === species);
}

function pick(molecule, atomName, nth = 0) {
  const hits = molecule.atoms.filter(a => a.name === atomName);
  return hits[nth] ? hits[nth].index : null;
}

/**
 * Make a word a valid PLUMED label.
 *
 * @param {string} text
 * @param {string} [fallback]
 * @returns {string}
 */
export function safeLabel(text, fallback = 'g') {
  let s = String(text == null ? '' : text).trim().replace(/[^A-Za-z0-9_]/g, '_');
  if (!s) s = fallback;
  if (!/^[A-Za-z_]/.test(s)) s = `${fallback}${s}`;
  return s;
}

/**
 * One GROUP per atom name: that atom of every copy of a molecule.
 *
 * @param {object[]} atoms
 * @param {string} species - Residue name.
 * @param {string[]} atomNames - The atoms wanted; a name occurring twice in
 *        the molecule is taken the first time.
 * @param {{labels?:Object<string,string>}} [options]
 * @returns {{lines:string[], groups:Array<{label:string, atoms:string,
 *   count:number}>, warnings:string[]}}
 */
export function perMoleculeGroups(atoms, species, atomNames, options = {}) {
  const mols = moleculesNamed(atoms, species);
  const warnings = [];
  const groups = [];
  if (!mols.length) {
    return { lines: [], groups, warnings: [`The structure has no residue named "${species}".`] };
  }
  for (const name of atomNames || []) {
    const indices = [];
    let missing = 0;
    for (const m of mols) {
      const i = pick(m, name);
      if (i === null) missing += 1;
      else indices.push(i);
    }
    if (!indices.length) {
      warnings.push(`No ${species} residue has an atom named "${name}".`);
      continue;
    }
    if (missing) {
      warnings.push(`${missing} of ${mols.length} ${species} residues have no atom named "${name}".`);
    }
    const label = safeLabel((options.labels && options.labels[name]) || name, 'g');
    groups.push({ label, atoms: compressAtomList(indices), count: indices.length });
  }
  return {
    lines: groups.map(g => `${g.label}: GROUP ATOMS=${g.atoms}`),
    groups,
    warnings
  };
}

/**
 * A virtual atom per molecule, and a group that gathers them.
 *
 * @param {object[]} atoms
 * @param {string} species
 * @param {{atomNames?:string[], prefix?:string, group?:string,
 *   action?:'CENTER'|'COM', mass?:boolean}} [options] - `atomNames` limits the
 *        centre to some atoms of the molecule; without it every atom counts.
 * @returns {{lines:string[], labels:string[], groupLine:string, group:string,
 *   warnings:string[]}}
 */
export function perMoleculeCenters(atoms, species, options = {}) {
  const { atomNames = null, action = 'CENTER', mass = false } = options;
  const prefix = safeLabel(options.prefix || 'c', 'c');
  const group = safeLabel(options.group || `${prefix}all`, 'g');
  const mols = moleculesNamed(atoms, species);
  const warnings = [];
  const lines = [];
  const labels = [];
  if (!mols.length) {
    return {
      lines, labels, groupLine: '', group,
      warnings: [`The structure has no residue named "${species}".`]
    };
  }
  let skipped = 0;
  mols.forEach((m, k) => {
    const wanted = atomNames && atomNames.length
      ? m.atoms.filter(a => atomNames.includes(a.name))
      : m.atoms;
    if (!wanted.length) { skipped += 1; return; }
    const label = `${prefix}${k + 1}`;
    labels.push(label);
    const flag = action === 'CENTER' && mass ? ' MASS' : '';
    lines.push(`${label}: ${action === 'COM' ? 'COM' : 'CENTER'} ATOMS=${compressAtomList(wanted.map(a => a.index), { minRun: 3 })}${flag}`);
  });
  if (skipped) {
    warnings.push(`${skipped} of ${mols.length} ${species} residues have none of the atoms named.`);
  }
  if (labels.includes(group)) {
    warnings.push(`The group label "${group}" is also the label of a centre. Choose another.`);
  }
  const groupLine = labels.length ? `${group}: GROUP ATOMS=${labels.join(',')}` : '';
  return { lines, labels, groupLine, group, warnings };
}

/**
 * A position and a direction per molecule, the input SMAC needs.
 *
 * PLUMED 2.9 takes `MOLECULES MOL1=start,end,centre`; from 2.10 the same is
 * written `DISTANCES ATOMS1=start,end LOCATION1=centre ... COMPONENTS`.
 *
 * @param {object[]} atoms
 * @param {string} species
 * @param {{start:string, end:string, centre?:string, label?:string,
 *   version?:string}} options - Atom names within the molecule; the centre
 *        defaults to the start atom.
 * @returns {{lines:string[], label:string, count:number, warnings:string[]}}
 */
export function moleculeOrientations(atoms, species, options = {}) {
  const { start, end, version = '2.9' } = options;
  const centre = options.centre || start;
  const label = safeLabel(options.label || 'm1', 'm');
  const mols = moleculesNamed(atoms, species);
  const warnings = [];
  const rows = [];
  if (!mols.length) {
    return { lines: [], label, count: 0, warnings: [`The structure has no residue named "${species}".`] };
  }
  if (!start || !end) {
    return { lines: [], label, count: 0, warnings: ['Name the two atoms that give the direction.'] };
  }
  if (start === end) warnings.push('The direction runs from an atom to itself. Name two different atoms.');
  let missing = 0;
  for (const m of mols) {
    const a = pick(m, start);
    const b = pick(m, end);
    const c = pick(m, centre);
    if (a === null || b === null || c === null) { missing += 1; continue; }
    rows.push([a, b, c]);
  }
  if (missing) {
    warnings.push(`${missing} of ${mols.length} ${species} residues lack one of the atoms named.`);
  }
  if (!rows.length) return { lines: [], label, count: 0, warnings };

  const lines = [];
  if (versionAtLeast(version, '2.10')) {
    lines.push('DISTANCES ...');
    rows.forEach((r, i) => lines.push(`  ATOMS${i + 1}=${r[0]},${r[1]} LOCATION${i + 1}=${r[2]}`));
    lines.push(`  COMPONENTS LABEL=${label}`, '...');
  } else {
    lines.push('MOLECULES ...');
    rows.forEach((r, i) => lines.push(`  MOL${i + 1}=${r[0]},${r[1]},${r[2]}`));
    lines.push(`  LABEL=${label}`, '...');
  }
  return { lines, label, count: rows.length, warnings };
}

/**
 * Whole molecules as `WHOLEMOLECULES` entities, one per molecule, or as one
 * entity per chain when the residues of a chain are bonded.
 *
 * @param {object[]} atoms
 * @param {string[]} species - Residue names to rebuild.
 * @param {{joinChains?:boolean, limit?:number}} [options]
 * @returns {{entities:string[], warnings:string[]}}
 */
export function wholeMoleculeEntities(atoms, species, options = {}) {
  const { joinChains = false, limit = 500 } = options;
  const wanted = new Set(species || []);
  const warnings = [];
  const runs = [];
  let cur = null;
  for (const m of moleculesOf(atoms)) {
    if (!wanted.has(m.name)) { cur = null; continue; }
    const indices = m.atoms.map(a => a.index);
    if (joinChains && cur && cur.chain === m.chain) cur.indices.push(...indices);
    else {
      cur = { chain: m.chain, indices };
      runs.push(cur);
    }
  }
  if (runs.length > limit) {
    warnings.push(
      `${runs.length} ${joinChains ? 'chains and residues' : 'residues'} would each be an entity. ` +
      'Rebuilding that many every step is slow; rebuild only those a collective variable spans.');
  }
  return { entities: runs.slice(0, limit).map(r => compressAtomList(r.indices)), warnings };
}

/**
 * Select atoms with the STEMKit query language and write them for PLUMED.
 *
 * A `.gro` file, and a PDB that GROMACS writes from one, leave the element
 * column blank, so `elem:H` would match nothing and `!elem:H` everything. An
 * atom without an element gets the one its name implies (HW1 is H, OW is O),
 * as structure.js reads it elsewhere.
 *
 * @param {object[]} atoms
 * @param {string} query - e.g. `resn:UREA atom:C`, `chain:A resi:1-50 atom:CA`.
 * @param {{unit?:string, coordinateUnit?:string, byres?:boolean,
 *   box?:number[]|null, boxVectors?:number[]|null}} [options] - Passed to
 *   selectAtoms: with the file's `box` (and `boxVectors`), in nm as
 *   core/structure.js keeps them, `within:` measures to the nearest image.
 * @returns {{list:string, count:number, indices:number[], errors:string[]}}
 */
export function selectForPlumed(atoms, query, options = {}) {
  const numbered = numberAtoms(atoms).map((a) => {
    if (String(a.element || a.elem || '').trim()) return a;
    const e = elementSymbol(a);
    return e && e !== 'X' ? { ...a, element: e } : a;
  });
  const r = selectAtoms(numbered, query, options);
  const indices = r.atoms.map(a => a.index);
  return { list: compressAtomList(indices), count: indices.length, indices, errors: r.errors };
}

/**
 * Atoms of a protein backbone torsion, by residue, without MOLINFO.
 *
 * phi is C(i-1) N CA C; psi is N CA C N(i+1).
 *
 * @param {object[]} atoms
 * @param {'phi'|'psi'} which
 * @param {number} resSeq
 * @param {string} [chain]
 * @returns {{list:string, indices:number[], error:string}}
 */
export function backboneTorsion(atoms, which, resSeq, chain = '') {
  const mols = moleculesOf(atoms).filter(m => !chain || m.chain === chain);
  const at = mols.findIndex(m => m.resSeq === Number(resSeq));
  if (at < 0) return { list: '', indices: [], error: `There is no residue ${resSeq}.` };
  const here = mols[at];
  const prev = mols[at - 1];
  const next = mols[at + 1];
  let picks;
  if (which === 'phi') {
    if (!prev) return { list: '', indices: [], error: 'phi needs the residue before this one.' };
    picks = [pick(prev, 'C'), pick(here, 'N'), pick(here, 'CA'), pick(here, 'C')];
  } else if (which === 'psi') {
    if (!next) return { list: '', indices: [], error: 'psi needs the residue after this one.' };
    picks = [pick(here, 'N'), pick(here, 'CA'), pick(here, 'C'), pick(next, 'N')];
  } else {
    return { list: '', indices: [], error: `Unknown torsion "${which}".` };
  }
  if (picks.some(p => p === null)) {
    return { list: '', indices: [], error: `Residue ${resSeq} lacks a backbone atom (N, CA, C).` };
  }
  return { list: picks.join(','), indices: picks, error: '' };
}

/** Is a word usable as a PLUMED label? */
export function isLabel(text) {
  return LABEL_RE.test(String(text == null ? '' : text));
}
