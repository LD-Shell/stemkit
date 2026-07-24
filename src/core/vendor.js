/**
 * @module core/vendor
 *
 * Dependency-injection layer for STEMKit's vendored third-party libraries
 * (jStat, Papa Parse, regression.js, bibtex-parse-js).
 *
 * Why this exists
 * ---------------
 * The vendored files in `js/dependencies/` are UMD bundles. UMD detects its
 * host at run time and either assigns `module.exports` (CommonJS) or attaches
 * a global to `window` (browser). Neither path is reachable by a plain ES
 * module import:
 *
 *   - `import jStat from '../../js/dependencies/jstat.min.js'` yields no
 *     bindings, because the file has no `export` statements.
 *   - `import { createRequire } from 'module'` resolves under Node but is a
 *     hard *resolution* failure in a browser ("Failed to resolve module
 *     specifier 'module'"). Resolution happens before execution, so it cannot
 *     be guarded with try/catch.
 *
 * Rather than branch on the environment inside every core module, which would
 * make the core untestable in one of the two targets, the core declares the
 * libraries it needs and each host registers them at start-up:
 *
 *   Browser:  the UMD `<script>` tags already set window.jStat, window.Papa,
 *             etc.; `registerFromGlobals()` picks them up.
 *   Node:     `registerVendor({ jStat: require('...') })` from the test setup.
 *
 * The core therefore stays environment-neutral, and the vendored libraries
 * remain the single source of truth for the numerics in both targets.
 */

/** @type {{jStat: any, Papa: any, regression: any, bibtexParse: any}} */
const registry = {
  jStat: null,
  Papa: null,
  regression: null,
  bibtexParse: null
};

/** Human-readable guidance emitted when a library is requested but absent. */
const HINTS = {
  jStat: 'jstat.min.js | statistical distributions',
  Papa: 'papaparse.min.js | CSV/TSV parsing',
  regression: 'regression.min.js | least-squares curve fitting',
  bibtexParse: 'bibtexParse.min.js | BibTeX tokenising'
};

/**
 * Register one or more vendored libraries.
 *
 * @param {Partial<typeof registry>} libs - Map of library name to module object.
 * @returns {void}
 */
export function registerVendor(libs = {}) {
  for (const key of Object.keys(libs)) {
    if (!(key in registry)) {
      throw new Error(`registerVendor: unknown library "${key}"`);
    }
    if (libs[key] != null) registry[key] = libs[key];
  }
}

/**
 * Populate the registry from browser globals installed by UMD `<script>` tags.
 *
 * Safe to call in any environment; missing globals are simply skipped, so a
 * page that loads only Plotly and Papa will register only Papa.
 *
 * @param {object} [scope] - Global object to inspect; defaults to
 *        `globalThis`. Injectable for testing.
 * @returns {string[]} Names of the libraries that were found and registered.
 */
export function registerFromGlobals(scope) {
  const g = scope || (typeof globalThis !== 'undefined' ? globalThis : {});
  const found = [];
  for (const key of Object.keys(registry)) {
    if (g[key] != null) {
      registry[key] = g[key];
      found.push(key);
    }
  }
  return found;
}

/**
 * Retrieve a registered library, throwing a diagnostic error if it is absent.
 *
 * Core modules call this lazily, at the point of use rather than at import
 * time, so that importing a module never fails merely because an unrelated
 * library has not been registered yet.
 *
 * @param {keyof typeof registry} name
 * @returns {any} The registered library.
 * @throws {Error} When the library has not been registered.
 */
export function requireVendor(name) {
  if (!(name in registry)) {
    throw new Error(`requireVendor: unknown library "${name}"`);
  }
  if (registry[name] == null) {
    throw new Error(
      `STEMKit core: "${name}" is not registered (${HINTS[name]}). ` +
      `In the browser, load the UMD script before your module and call ` +
      `registerFromGlobals(). In Node, call registerVendor({ ${name}: ... }) ` +
      `using createRequire on js/dependencies/.`
    );
  }
  return registry[name];
}

/**
 * Report whether a library is currently available.
 *
 * Lets callers degrade gracefully, for example, offering an exact test when
 * jStat is present and a normal approximation when it is not.
 *
 * @param {keyof typeof registry} name
 * @returns {boolean}
 */
export function hasVendor(name) {
  return name in registry && registry[name] != null;
}

/**
 * Clear the registry. Intended for test isolation.
 *
 * @returns {void}
 */
export function resetVendor() {
  for (const key of Object.keys(registry)) registry[key] = null;
}
