import { describe, test, expect } from '@jest/globals';
import {
  CV_DEFS, CV_CATEGORIES, CV_EXAMPLES, BIAS_DEFS, BIAS_CATEGORIES, FUNCTION_DEFS,
  FUNCTION_EXAMPLES, REDUCTIONS, PREREQS, KEY_HELP,
  PLUMED_VERSIONS, cvAvailable, fieldsFor, createCV, buildCVLine
} from '../src/core/plumed.js';
import { loadSyntax, SYNTAX_VERSIONS } from '../src/core/plumed-syntax.js';

const SWITCH_KEYS = ['R_0', 'D_0', 'D_MAX', 'NN', 'MM'];

function actionsOf(type, def) {
  const variant = (def.fields || []).find(f => f.variant);
  return variant ? variant.options : [def.act || type];
}

describe('the catalogue is well formed', () => {
  test('there is a keyword table for every target release', () => {
    expect([...SYNTAX_VERSIONS]).toEqual([...PLUMED_VERSIONS]);
  });

  test.each(Object.keys(CV_DEFS))('%s', (type) => {
    const def = CV_DEFS[type];
    expect(Object.keys(CV_CATEGORIES)).toContain(def.cat);
    expect(typeof def.desc).toBe('string');
    expect(def.desc.length).toBeGreaterThan(10);
    expect(CV_EXAMPLES[type]).toBeTruthy();
    expect(def.__key).toBe(type);
    const keys = (def.fields || []).map(f => f.k);
    expect(new Set(keys).size).toBe(keys.length);
    for (const f of def.fields || []) {
      expect(['atoms', 'text', 'num', 'select', 'flag']).toContain(f.type);
      expect(typeof f.label).toBe('string');
      if (f.type === 'select') expect(f.options).toContain(f.def);
      if (f.type === 'flag') expect(typeof f.def).toBe('boolean');
      // Every field can be explained, by its own note or the shared one.
      if (!f.variant) expect(f.help || KEY_HELP[f.k]).toBeTruthy();
    }
    if (def.prereq) expect(PREREQS[def.prereq]).toBeTruthy();
    // A field that another replaces, or needs, names one the entry has.
    for (const f of def.fields || []) {
      for (const k of [...(f.excludedBy || []), ...(f.pairedWith ? [f.pairedWith] : [])]) {
        expect([type, f.k, keys.includes(k)]).toEqual([type, f.k, true]);
      }
    }
    // A fallback is an action name; advice about older releases is olderHint.
    if (def.fallback) expect(def.fallback).toMatch(/^[A-Z][A-Z0-9_]*$/);
    if (def.reductions) {
      for (const r of def.reductions) expect(REDUCTIONS.map(x => x.k)).toContain(r);
    }
  });

  test('bias methods and functions', () => {
    for (const def of Object.values(BIAS_DEFS)) {
      expect(Object.keys(BIAS_CATEGORIES)).toContain(def.cat);
      for (const p of def.params) expect(p.help).toBeTruthy();
    }
    for (const [k, def] of Object.entries(FUNCTION_DEFS)) {
      expect(FUNCTION_EXAMPLES[k]).toBeTruthy();
      expect(def.fields.some(f => f.k === 'PERIODIC')).toBe(true);
    }
  });
});

describe.each([...PLUMED_VERSIONS])('the catalogue against PLUMED %s', (version) => {
  let syntax;
  const load = async () => { syntax = syntax || await loadSyntax(version); return syntax; };

  test('every entry offered for the release is an action of it', async () => {
    const s = await load();
    const missing = [];
    for (const [type, def] of Object.entries(CV_DEFS)) {
      if (def.isCustom || !cvAvailable(def, version)) continue;
      for (const a of actionsOf(type, def)) if (!s.has(a)) missing.push(a);
    }
    expect(missing).toEqual([]);
  });

  test('every field is a keyword the action registers', async () => {
    const s = await load();
    const unknown = [];
    for (const [type, def] of Object.entries(CV_DEFS)) {
      if (def.isCustom || !cvAvailable(def, version)) continue;
      for (const action of actionsOf(type, def)) {
        // Without a table, only the catalogue's own bounds decide.
        for (const f of fieldsFor(def, { version, action })) {
          if (f.variant || f.k.startsWith('__') || s.keyword(action, f.k)) continue;
          const folded = (def.switchSpeed || def.coordSwitch) && SWITCH_KEYS.includes(f.k) &&
            s.keyword(action, 'SWITCH');
          const shared = REDUCTIONS.some(r => r.k === f.k) && !(def.fields || []).some(x => x.k === f.k);
          if (!folded && !shared) unknown.push(`${action} ${f.k}`);
        }
      }
    }
    expect(unknown).toEqual([]);
  });

  test('a field written under another keyword is written under a registered one', async () => {
    const s = await load();
    for (const [type, def] of Object.entries(CV_DEFS)) {
      if (!cvAvailable(def, version)) continue;
      for (const f of (def.fields || []).filter(x => x.writeAs)) {
        expect([type, f.writeAs, !!s.keyword(def.act || type, f.writeAs)]).toEqual([type, f.writeAs, true]);
      }
    }
  });

  test('every bias parameter is a keyword of its action', async () => {
    const s = await load();
    const unknown = [];
    for (const def of Object.values(BIAS_DEFS)) {
      if (!def.action) continue;
      expect(s.has(def.action)).toBe(true);
      for (const p of def.params) {
        if (!s.keyword(def.action, p.k)) unknown.push(`${def.action} ${p.k}`);
      }
    }
    expect(unknown).toEqual([]);
  });

  test('functions and the actions the generator writes itself', async () => {
    const s = await load();
    for (const [name, def] of Object.entries(FUNCTION_DEFS)) {
      expect(s.has(name)).toBe(true);
      for (const f of def.fields) expect([name, f.k, !!s.keyword(name, f.k)]).toEqual([name, f.k, true]);
    }
    for (const [action, keys] of Object.entries({
      PRINT: ['ARG', 'FILE', 'STRIDE'], UNITS: ['LENGTH', 'ENERGY', 'TIME'], LOAD: ['FILE'],
      INCLUDE: ['FILE'], FLUSH: ['STRIDE'], MOLINFO: ['STRUCTURE', 'MOLTYPE'],
      WHOLEMOLECULES: ['ENTITY0', 'RESIDUES', 'MOLTYPE'], RESTART: [],
      METAD: ['GRID_MIN', 'GRID_MAX', 'GRID_BIN', 'CALC_RCT', 'RCT_USTRIDE', 'WALKERS_MPI',
        'WALKERS_N', 'WALKERS_ID', 'WALKERS_DIR', 'WALKERS_RSTRIDE', 'FILE', 'SIGMA'],
      PBMETAD: ['GRID_MIN', 'FILE', 'WALKERS_MPI', 'WALKERS_DIR'],
      OPES_METAD: ['FILE', 'STATE_WFILE', 'STATE_WSTRIDE', 'NLIST', 'WALKERS_MPI', 'SIGMA']
    })) {
      expect(s.has(action)).toBe(true);
      for (const k of keys) expect([action, k, !!s.keyword(action, k)]).toEqual([action, k, true]);
    }
  });

  test('with the table loaded, every line is made of registered keywords', async () => {
    const s = await load();
    const unknown = [];
    let seq = 0;
    for (const [type, def] of Object.entries(CV_DEFS)) {
      if (def.isCustom || !cvAvailable(def, version)) continue;
      const cv = createCV(type, ++seq, { version, syntax: s });
      const { line, action } = buildCVLine(cv, CV_DEFS, { version, syntax: s });
      const words = line.replace(/\{[^}]*\}/g, '{}').split(/\s+/).slice(2);
      for (const w of words) {
        const key = w.split('=')[0];
        if (!s.keyword(action, key)) unknown.push(`${action} ${key}`);
      }
    }
    expect(unknown).toEqual([]);
  });
});

describe('what the help says a parameter does', () => {
  // UWalls.cpp: acts where (x - AT + OFFSET)/EPS > 0; LWalls.cpp: where (x - AT - OFFSET)/EPS < 0.
  const help = (method, k) => BIAS_DEFS[method].params.find(p => p.k === k).help;

  test('a wall OFFSET moves where the wall starts, not AT', () => {
    expect(help('upper', 'OFFSET')).toContain('Moves the start of the wall down to AT − OFFSET, without moving AT');
    expect(help('lower', 'OFFSET')).toContain('Moves the start of the wall up to AT + OFFSET, without moving AT');
    expect(help('upper', 'AT')).toContain('above AT − OFFSET when OFFSET is set');
    expect(help('lower', 'AT')).toContain('below AT + OFFSET when OFFSET is set');
  });

  test('D_MAX of COORDINATION is not said to bring linked cells', () => {
    const dmax = CV_DEFS.COORDINATION.fields.find(f => f.k === 'D_MAX').help;
    expect(dmax).toContain('does not make it faster');
    expect(dmax).not.toMatch(/enables linked/);
  });
});
