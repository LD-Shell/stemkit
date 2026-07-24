/**
 * @module core/plumed
 *
 * PLUMED input-file generation, extracted from STEMKit's HPC Script Generator.
 *
 * PLUMED [Tribello et al., Comput. Phys. Commun. 185 (2014) 604] drives
 * enhanced sampling by reading a plain-text input that declares collective
 * variables (CVs) and the bias acting on them. The file is easy to write badly:
 * an action renamed between releases, a switching function whose cutoff is
 * below the distance it is meant to switch at, or a grid that does not span the
 * CV all produce a run that starts successfully and yields meaningless free
 * energies.
 *
 * This module handles the parts that are pure text and arithmetic, the action
 * catalogue, version gating, token emission, and validation, leaving the form
 * rendering to the UI layer.
 *
 * Two design points carry over from the original implementation and are worth
 * stating, since both are easy to get wrong:
 *
 *   - **Version gating.** PLUMED renamed several actions at 2.10 (the
 *     multicolvar rewrite). A CV declares `minVersion` and, where one exists, a
 *     `fallback` action name for older releases, so the same catalogue emits
 *     correct input for either target.
 *   - **Bias-dependent redundancy.** Some bias methods internally manage
 *     parameters that would then be redundant or contradictory on the CV.
 *     Which keys to suppress is expressed declaratively rather than buried in
 *     rendering code.
 */

/** PLUMED releases this module can target. */
export const PLUMED_VERSIONS = Object.freeze(['2.9', '2.10']);

/** Default target when none is specified. */
export const DEFAULT_PLUMED_VERSION = '2.9';

/**
 * Compare dotted version strings.
 *
 * @param {string} have
 * @param {string} need
 * @returns {boolean} True when `have` is at least `need`.
 */
export function versionAtLeast(have, need) {
  const a = String(have).split('.').map(Number);
  const b = String(need).split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x !== y) return x > y;
  }
  return true;
}

/**
 * Is a CV definition available under a target version?
 *
 * @param {object} def - Catalogue entry.
 * @param {string} version
 * @returns {boolean}
 */
export function cvAvailable(def, version) {
  if (!def || !def.minVersion) return true;
  return versionAtLeast(version || DEFAULT_PLUMED_VERSION, def.minVersion);
}

/**
 * Resolve the action name to emit for a CV under a target version.
 *
 * When a CV requires a newer PLUMED than the target and declares a fallback,
 * the fallback name is emitted instead. Without a fallback the CV is
 * unavailable and the caller is told so.
 *
 * @param {string} type - Catalogue key.
 * @param {object} def - Catalogue entry.
 * @param {string} version
 * @returns {{action:string|null, usedFallback:boolean, available:boolean}}
 */
export function resolveAction(type, def, version) {
  if (!def) return { action: null, usedFallback: false, available: false };
  const act = def.act || type;

  if (cvAvailable(def, version)) {
    return { action: act, usedFallback: false, available: true };
  }
  if (def.fallback) {
    return { action: def.fallback, usedFallback: true, available: true };
  }
  return { action: null, usedFallback: false, available: false };
}

/**
 * Emit one `KEY=value` token for a field.
 *
 * Three shapes occur in the catalogue and are distinguished here:
 *
 *   - a flag contributes its bare keyword when truthy, and nothing otherwise;
 *   - a brace-delimited block (`SWITCH={RATIONAL R_0=0.3}`) is emitted as
 *     `KEY={...}`;
 *   - free text that already contains `KEY=` pairs is a raw fragment and is
 *     passed through verbatim, so a user can hand-write an option the form does
 *     not expose.
 *
 * @param {string[]} parts - Token accumulator, appended in place.
 * @param {{k:string, type?:string, variant?:boolean}} field
 * @param {*} value
 * @returns {void}
 */
export function pushFieldToken(parts, field, value) {
  if (!field || field.variant) return;

  if (field.type === 'flag') {
    if (value) parts.push(field.k);
    return;
  }
  if (value === undefined || value === null || String(value).trim() === '') return;

  const v = String(value).trim();
  if (field.type === 'text') {
    if (v.startsWith('{')) {
      parts.push(`${field.k}=${v}`);
      return;
    }
    // A raw fragment such as "NN=6 MM=12" is passed through unchanged, but a
    // bare numeric list must not be mistaken for one.
    if (/\w+=/.test(v) && !/^[\d.,\-]+$/.test(v)) {
      parts.push(v);
      return;
    }
  }
  parts.push(`${field.k}=${v}`);
}

/**
 * Bias methods that render some CV parameters redundant.
 *
 * Keyed by bias method, then by action name (or `*` for every CV).
 */
export const BIAS_REDUNDANCY = Object.freeze({
  // Metadynamics lays hills on a grid this tool defines, so a per-CV neighbour
  // list does not control the cost of the bias; hiding the knobs avoids
  // implying that it does.
  wt_metad: { '*': ['NL_CUTOFF', 'NL_STRIDE'] },
  metad: { '*': ['NL_CUTOFF', 'NL_STRIDE'] },
  // OPES adapts its own kernel bandwidth, so a per-CV reduction is not a
  // meaningful biased quantity.
  opes: { '*': ['MORE_THAN', 'LESS_THAN'] }
});

/**
 * Field keys to suppress for a CV under the active bias.
 *
 * Only biased CVs are affected; an unbiased CV keeps every parameter.
 *
 * @param {{type:string, bias?:boolean}} instance
 * @param {string} biasMethod
 * @param {Object<string, object>} catalogue
 * @returns {Set<string>}
 */
export function hiddenFieldsForBias(instance, biasMethod, catalogue = {}) {
  const keys = new Set();
  if (!instance || !instance.bias) return keys;

  const map = BIAS_REDUNDANCY[biasMethod];
  if (!map) return keys;

  const def = catalogue[instance.type] || {};
  const act = def.act || instance.type;

  for (const k of map['*'] || []) keys.add(k);
  for (const k of map[act] || []) keys.add(k);
  for (const k of map[instance.type] || []) keys.add(k);
  return keys;
}

/**
 * Build the PLUMED line for one CV instance.
 *
 * @param {{type:string, label:string, values?:object, bias?:boolean}} instance
 * @param {Object<string, object>} catalogue
 * @param {{version?:string, biasMethod?:string}} [options]
 * @returns {{line:string|null, warnings:string[], usedFallback:boolean}}
 */
export function buildCVLine(instance, catalogue, options = {}) {
  const { version = DEFAULT_PLUMED_VERSION, biasMethod = 'none' } = options;
  const warnings = [];

  if (!instance || !instance.type) {
    return { line: null, warnings: ['CV instance has no type.'], usedFallback: false };
  }

  const def = catalogue[instance.type];
  if (!def) {
    return {
      line: null,
      warnings: [`Unknown CV type "${instance.type}".`],
      usedFallback: false
    };
  }

  const { action, usedFallback, available } = resolveAction(instance.type, def, version);
  if (!available) {
    return {
      line: null,
      warnings: [
        `${instance.type} requires PLUMED ${def.minVersion} or newer; ` +
        `target is ${version} and no fallback action exists.`
      ],
      usedFallback: false
    };
  }
  if (usedFallback) {
    warnings.push(
      `${instance.type} is named ${def.fallback} in PLUMED ${version}; ` +
      `emitted the older action name.`
    );
  }

  const hidden = hiddenFieldsForBias(instance, biasMethod, catalogue);
  const values = instance.values || {};
  const parts = [];

  for (const f of def.fields || []) {
    if (hidden.has(f.k)) continue;
    const v = Object.prototype.hasOwnProperty.call(values, f.k) ? values[f.k] : f.def;
    if (f.required && (v === undefined || String(v).trim() === '')) {
      warnings.push(`${instance.type}: required field ${f.k} is empty.`);
    }
    pushFieldToken(parts, f, v);
  }

  const label = instance.label || instance.type.toLowerCase();
  const line = parts.length
    ? `${label}: ${action} ${parts.join(' ')}`
    : `${label}: ${action}`;

  return { line, warnings, usedFallback };
}

/**
 * Build a rational switching-function block.
 *
 * PLUMED's rational switch is
 *
 *   s(r) = [1 - ((r - d0)/r0)^n] / [1 - ((r - d0)/r0)^m],   m = 2n when m = 0.
 *
 * `D_MAX` is worth setting: beyond it the function is exactly zero, which lets
 * PLUMED use linked cells for neighbour search and is often a large speedup.
 * It must sit comfortably above r0, or contacts are truncated while the switch
 * is still appreciable.
 *
 * @param {{r0:number, d0?:number, nn?:number, mm?:number, dmax?:number}} params
 * @returns {{block:string, warnings:string[]}}
 */
export function buildSwitchBlock(params = {}) {
  const { r0, d0 = 0, nn = 6, mm = 0, dmax } = params;
  const warnings = [];

  if (!Number.isFinite(r0) || r0 <= 0) {
    return { block: '', warnings: ['Switching function requires a positive R_0.'] };
  }

  const parts = [`RATIONAL R_0=${r0}`];
  if (d0) parts.push(`D_0=${d0}`);
  if (nn !== 6) parts.push(`NN=${nn}`);
  if (mm) parts.push(`MM=${mm}`);

  if (Number.isFinite(dmax)) {
    parts.push(`D_MAX=${dmax}`);
    // At r = d0 + 2*r0 the rational switch has decayed to roughly 1-2%.
    if (dmax < d0 + 2 * r0) {
      warnings.push(
        `D_MAX=${dmax} is close to R_0=${r0}; the switching function is still ` +
        `appreciable there, so contacts will be truncated abruptly. ` +
        `Consider D_MAX >= ${(d0 + 2 * r0).toFixed(3)}.`
      );
    }
  } else {
    warnings.push(
      'No D_MAX set. Setting it lets PLUMED use linked cells for neighbour ' +
      'search, which is often a substantial speedup for large groups.'
    );
  }

  return { block: `{${parts.join(' ')}}`, warnings };
}

/**
 * Build the bias line.
 *
 * @param {string} method - 'wt_metad' | 'metad' | 'opes' | 'restraint' |
 *        'moving' | 'upper' | 'lower' | 'none'
 * @param {Array<{label:string}>} biasedCVs
 * @param {object} params - Method-specific parameters.
 * @returns {{lines:string[], warnings:string[]}}
 */
export function buildBiasLine(method, biasedCVs, params = {}) {
  const warnings = [];
  const lines = [];

  if (!method || method === 'none') return { lines, warnings };
  if (!Array.isArray(biasedCVs) || biasedCVs.length === 0) {
    return {
      lines,
      warnings: [`Bias method "${method}" selected but no CV is marked for biasing.`]
    };
  }

  const arg = biasedCVs.map(c => c.label).join(',');

  switch (method) {
    case 'wt_metad':
    case 'metad': {
      const {
        pace = 500, height = 1.2, sigma = '', biasfactor = 10,
        temp = 300, gridMin = '', gridMax = '', gridBin = '',
        file = 'HILLS'
      } = params;

      const parts = [`ARG=${arg}`, `PACE=${pace}`, `HEIGHT=${height}`];
      if (sigma) parts.push(`SIGMA=${sigma}`);
      else warnings.push('SIGMA is unset; metadynamics requires one width per biased CV.');

      if (method === 'wt_metad') {
        parts.push(`BIASFACTOR=${biasfactor}`, `TEMP=${temp}`);
      }
      if (gridMin && gridMax) {
        parts.push(`GRID_MIN=${gridMin}`, `GRID_MAX=${gridMax}`);
        if (gridBin) parts.push(`GRID_BIN=${gridBin}`);
      } else {
        warnings.push(
          'No grid bounds set. Without GRID_MIN/GRID_MAX the hill sum is ' +
          'evaluated over every deposited hill, which slows steadily as the run ' +
          'proceeds.'
        );
      }
      parts.push(`FILE=${file}`);
      lines.push(`metad: METAD ${parts.join(' ')}`);
      break;
    }

    case 'opes': {
      const { pace = 500, barrier = 30, sigma = 'ADAPTIVE', temp = 300 } = params;
      lines.push(
        `opes: OPES_METAD ARG=${arg} PACE=${pace} BARRIER=${barrier} ` +
        `SIGMA=${sigma} TEMP=${temp}`
      );
      if (!Number.isFinite(Number(barrier)) || Number(barrier) <= 0) {
        warnings.push('BARRIER must be a positive energy; it is the single most ' +
                      'important OPES setting.');
      }
      break;
    }

    case 'restraint': {
      const { at = '', kappa = 100 } = params;
      if (!at) warnings.push('RESTRAINT requires an AT value per biased CV.');
      lines.push(`restraint: RESTRAINT ARG=${arg} AT=${at} KAPPA=${kappa}`);
      break;
    }

    case 'moving': {
      const { at0 = '', at1 = '', step0 = 0, step1 = 100000, kappa = 100 } = params;
      lines.push(
        `steer: MOVINGRESTRAINT ARG=${arg} ` +
        `STEP0=${step0} AT0=${at0} KAPPA0=${kappa} ` +
        `STEP1=${step1} AT1=${at1} KAPPA1=${kappa}`
      );
      if (!at0 || !at1) warnings.push('MOVINGRESTRAINT requires both AT0 and AT1.');
      break;
    }

    case 'upper': {
      const { at = '', kappa = 150 } = params;
      lines.push(`uwall: UPPER_WALLS ARG=${arg} AT=${at} KAPPA=${kappa}`);
      break;
    }

    case 'lower': {
      const { at = '', kappa = 150 } = params;
      lines.push(`lwall: LOWER_WALLS ARG=${arg} AT=${at} KAPPA=${kappa}`);
      break;
    }

    default:
      warnings.push(`Unknown bias method "${method}".`);
  }

  return { lines, warnings };
}

/**
 * Build the PRINT line.
 *
 * @param {Array<{label:string}>} cvs
 * @param {{stride?:number, file?:string, extra?:string[]}} [options]
 * @returns {string}
 */
export function buildPrintLine(cvs, options = {}) {
  const { stride = 500, file = 'COLVAR', extra = [] } = options;
  const labels = (Array.isArray(cvs) ? cvs : []).map(c => c.label);
  const args = [...labels, ...extra].filter(Boolean);
  if (args.length === 0) return '';
  return `PRINT ARG=${args.join(',')} STRIDE=${stride} FILE=${file}`;
}

/**
 * Check labels for the problems PLUMED will reject or silently mishandle.
 *
 * @param {Array<{label:string}>} cvs
 * @returns {string[]}
 */
export function validateLabels(cvs) {
  const warnings = [];
  const seen = new Set();
  if (!Array.isArray(cvs)) return warnings;

  for (const cv of cvs) {
    const l = cv && cv.label;
    if (!l) {
      warnings.push('A CV has no label.');
      continue;
    }
    if (seen.has(l)) {
      warnings.push(`Duplicate label "${l}"; PLUMED requires unique labels.`);
    }
    seen.add(l);

    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(l)) {
      warnings.push(
        `Label "${l}" is not a valid PLUMED identifier, use a letter followed ` +
        `by letters, digits, or underscores.`
      );
    }
    // A label containing a dot would be parsed as a component reference.
    if (l.includes('.')) {
      warnings.push(`Label "${l}" contains a dot, which PLUMED reads as a component reference.`);
    }
  }
  return warnings;
}

/**
 * Assemble a complete PLUMED input file.
 *
 * @param {{
 *   cvs?: Array<object>,
 *   biasMethod?: string,
 *   biasParams?: object,
 *   version?: string,
 *   catalogue?: Object<string, object>,
 *   units?: {length?:string, energy?:string, time?:string},
 *   molinfo?: {structure?:string, moltype?:string},
 *   printStride?: number,
 *   printFile?: string
 * }} config
 * @returns {{input:string, warnings:string[], cvLines:string[]}}
 */
export function generatePlumedInput(config = {}) {
  const {
    cvs = [],
    biasMethod = 'none',
    biasParams = {},
    version = DEFAULT_PLUMED_VERSION,
    catalogue = {},
    units = null,
    molinfo = null,
    printStride = 500,
    printFile = 'COLVAR'
  } = config;

  const warnings = [];
  const lines = [];

  lines.push('# PLUMED input generated by STEMKit');
  lines.push(`# Target: PLUMED ${version}`);
  lines.push('');

  if (units) {
    const parts = [];
    if (units.length) parts.push(`LENGTH=${units.length}`);
    if (units.energy) parts.push(`ENERGY=${units.energy}`);
    if (units.time) parts.push(`TIME=${units.time}`);
    if (parts.length) {
      lines.push(`UNITS ${parts.join(' ')}`);
      lines.push('');
    }
  }

  if (molinfo && molinfo.structure) {
    const mt = molinfo.moltype ? ` MOLTYPE=${molinfo.moltype}` : '';
    lines.push(`MOLINFO STRUCTURE=${molinfo.structure}${mt}`);
    lines.push('');
  }

  warnings.push(...validateLabels(cvs));

  const cvLines = [];
  for (const cv of cvs) {
    const r = buildCVLine(cv, catalogue, { version, biasMethod });
    warnings.push(...r.warnings);
    if (r.line) {
      cvLines.push(r.line);
      lines.push(r.line);
    }
  }
  if (cvLines.length) lines.push('');

  const biased = cvs.filter(c => c && c.bias);
  const bias = buildBiasLine(biasMethod, biased, biasParams);
  warnings.push(...bias.warnings);
  if (bias.lines.length) {
    lines.push(...bias.lines);
    lines.push('');
  }

  const printExtra = [];
  if (biasMethod === 'wt_metad' || biasMethod === 'metad') printExtra.push('metad.bias');
  else if (biasMethod === 'opes') printExtra.push('opes.bias');
  else if (biasMethod === 'restraint') printExtra.push('restraint.bias');

  const printLine = buildPrintLine(cvs, {
    stride: printStride, file: printFile, extra: printExtra
  });
  if (printLine) lines.push(printLine);

  return { input: lines.join('\n') + '\n', warnings, cvLines };
}
