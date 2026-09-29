/**
 * @module core/plumed-syntax
 *
 * Read access to the PLUMED keyword tables under `plumed-syntax/`.
 *
 * Each table is generated from the `syntax.json` that PLUMED itself writes
 * for a release (see tools/build-plumed-syntax.mjs), so it lists exactly the
 * actions and keywords that release's parser accepts, the module each action
 * is compiled in, and whether that module is part of a default build.
 *
 * A table is about 60 kB compressed, so it is loaded on request:
 *
 * ```js
 * const syntax = await loadSyntax('2.10');
 * syntax.keyword('COORDINATIONNUMBER', 'MORE_THAN2');   // numbered keyword
 * syntax.moduleOf('Q6');                                 // { name: 'symfunc', defaultOn: false }
 * ```
 */

/** Releases a table exists for, oldest first. */
export const SYNTAX_VERSIONS = Object.freeze(['2.9', '2.10', '2.11']);

const STYLE_NAMES = Object.freeze({
  a: 'atoms', c: 'compulsory', o: 'optional', f: 'flag', h: 'hidden', v: 'reduction'
});

const cache = new Map();

/**
 * Load the table for a release.
 *
 * @param {string} version - One of {@link SYNTAX_VERSIONS}.
 * @returns {Promise<ReturnType<typeof createSyntax>>}
 */
export async function loadSyntax(version) {
  const v = String(version);
  if (!SYNTAX_VERSIONS.includes(v)) {
    throw new Error(`No PLUMED syntax table for version "${v}".`);
  }
  if (!cache.has(v)) {
    cache.set(v, import(`./plumed-syntax/v${v}.js`).then(m => createSyntax(m.default)));
  }
  return cache.get(v);
}

/**
 * Split a keyword as written into its registered name and number.
 *
 * `ATOMS12` is the twelfth instance of the numbered keyword `ATOMS`. Several
 * registered names end in a digit themselves (`KAPPA0`, `R_0`, `AT1`), so the
 * split is only taken when the full word is not registered.
 *
 * @param {string} word
 * @param {(name:string)=>boolean} isRegistered
 * @returns {{name:string, index:number|null}}
 */
export function splitNumbered(word, isRegistered) {
  if (isRegistered(word)) return { name: word, index: null };
  const m = /^(.*?)(\d+)$/.exec(word);
  if (m && m[1] && isRegistered(m[1])) return { name: m[1], index: Number(m[2]) };
  return { name: word, index: null };
}

/**
 * Wrap a raw table in lookup functions.
 *
 * @param {object} table - A default export from `plumed-syntax/v*.js`.
 */
export function createSyntax(table) {
  if (!table || typeof table !== 'object' || !table.actions) {
    throw new Error('Not a PLUMED syntax table.');
  }
  const { actions, strings = [], modules = {} } = table;
  const text = (i) => (i >= 0 && i < strings.length ? strings[i] : '');

  function expandKeyword(name, row) {
    const style = STYLE_NAMES[row[0]] || 'optional';
    const out = {
      name,
      style,
      description: text(row[1]),
      numbered: row[2] === 1,
      required: style === 'compulsory' && row[3] === undefined
    };
    if (row[3] !== undefined) out.default = row[3];
    return out;
  }

  const api = {
    /** Release the table describes, e.g. `2.10`. */
    version: table.version,
    /** Full version string of the tree the table was generated from. */
    release: table.release,

    /** @returns {string[]} Every action name, sorted. */
    actionNames() {
      return Object.keys(actions);
    },

    /** @param {string} name @returns {boolean} */
    has(name) {
      return Object.prototype.hasOwnProperty.call(actions, String(name));
    },

    /**
     * Everything known about one action.
     *
     * @param {string} name
     * @returns {{name:string, module:string, description:string, dois:string[],
     *   keywords:object[], outputs:object[]}|null}
     */
    action(name) {
      if (!api.has(name)) return null;
      const a = actions[name];
      return {
        name,
        module: a.m,
        description: text(a.d),
        dois: Array.isArray(a.doi) ? a.doi.slice() : [],
        keywords: Object.keys(a.k).map(k => expandKeyword(k, a.k[k])),
        outputs: Object.keys(a.o || {}).map(c => ({
          name: c,
          keyword: a.o[c][0] === 'default' ? null : a.o[c][0],
          description: text(a.o[c][1])
        }))
      };
    },

    /**
     * Look up a keyword as it would be written, numbered instances included.
     *
     * @param {string} action
     * @param {string} word - e.g. `ATOMS`, `ATOMS3`, `KAPPA1`.
     * @returns {(object & {index:number|null})|null}
     */
    keyword(action, word) {
      if (!api.has(action)) return null;
      const k = actions[action].k;
      const has = (n) => Object.prototype.hasOwnProperty.call(k, n);
      const { name, index } = splitNumbered(String(word), has);
      if (!has(name)) return null;
      const spec = expandKeyword(name, k[name]);
      if (index !== null && !spec.numbered) return null;
      return { ...spec, index };
    },

    /**
     * Compulsory keywords with no default: the ones an input must give.
     *
     * @param {string} action
     * @returns {string[]}
     */
    requiredKeywords(action) {
      if (!api.has(action)) return [];
      const k = actions[action].k;
      return Object.keys(k).filter(n => k[n][0] === 'c' && k[n][3] === undefined);
    },

    /**
     * The module an action is compiled in and whether a default build has it.
     *
     * @param {string} action
     * @returns {{name:string, defaultOn:boolean}|null}
     */
    moduleOf(action) {
      if (!api.has(action)) return null;
      const name = actions[action].m;
      return { name, defaultOn: api.moduleDefaultOn(name) };
    },

    /**
     * Is a module part of a default `./configure` build? Unknown modules are
     * reported as on, so a gap in the table never raises a false alarm.
     *
     * @param {string} name
     * @returns {boolean}
     */
    moduleDefaultOn(name) {
      if (!Object.prototype.hasOwnProperty.call(modules, name)) return true;
      return modules[name] === 1;
    },

    /**
     * Actions whose name or description matches every word of a query, best
     * first: exact name, name prefix, name substring, then description.
     *
     * @param {string} query
     * @param {{limit?:number, modules?:string[]}} [options]
     * @returns {Array<{name:string, module:string, description:string}>}
     */
    search(query, options = {}) {
      const { limit = 50, modules: only = null } = options;
      const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
      const scored = [];
      for (const name of Object.keys(actions)) {
        const a = actions[name];
        if (only && !only.includes(a.m)) continue;
        const lname = name.toLowerCase();
        const ldesc = text(a.d).toLowerCase();
        let score = 0;
        let ok = true;
        for (const w of words) {
          if (lname === w) score += 100;
          else if (lname.startsWith(w)) score += 40;
          else if (lname.includes(w)) score += 20;
          else if (a.m.toLowerCase() === w) score += 8;
          else if (ldesc.includes(w)) score += 5;
          else { ok = false; break; }
        }
        if (ok) scored.push({ name, module: a.m, description: text(a.d), score });
      }
      scored.sort((x, y) => y.score - x.score || x.name.localeCompare(y.name));
      return scored.slice(0, limit).map(({ score, ...rest }) => rest);
    },

    /**
     * Documentation page for an action in this release's manual.
     *
     * @param {string} action
     * @returns {string}
     */
    docUrl(action) {
      const name = String(action || '');
      if (!/^[A-Z][A-Z0-9_]*$/.test(name)) return '';
      const doc = table.doc || {};
      if (!doc.base) return plumedDocUrl(name, table.version);
      return doc.mangled ? `${doc.base}${manglePage(name)}.html` : `${doc.base}${name}`;
    }
  };

  return Object.freeze(api);
}

/**
 * Manual page for an action.
 *
 * The 2.x doxygen manual names each page after the action with every capital
 * written as `_` plus the lower-case letter, and a literal underscore doubled:
 * `PROJECTION_ON_AXIS` becomes `_p_r_o_j_e_c_t_i_o_n__o_n__a_x_i_s.html`.
 *
 * @param {string} action
 * @param {string} version
 * @returns {string}
 */
export function plumedDocUrl(action, version) {
  const name = String(action || '');
  if (!/^[A-Z][A-Z0-9_]*$/.test(name)) return '';
  return `https://www.plumed.org/doc-v${version}/user-doc/html/${manglePage(name)}.html`;
}

function manglePage(name) {
  let page = '';
  for (const ch of name) {
    if (ch >= 'A' && ch <= 'Z') page += `_${ch.toLowerCase()}`;
    else if (ch === '_') page += '_';
    else page += ch;
  }
  return page;
}
