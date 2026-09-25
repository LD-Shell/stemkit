/**
 * Jest setup for the Node test environment.
 *
 * The vendored libraries in `js/dependencies/` are UMD bundles, which a plain
 * ES `import` cannot bind. Under Node, `src/core/node.js` (the package entry a
 * user's script resolves to) loads them with `createRequire` and hands them to
 * the core through the injection layer; in the browser the same registry is
 * populated from the globals the UMD `<script>` tags install.
 *
 * Importing it here, once, keeps every test file free of loader boilerplate
 * and tests the bundles through the path users take.
 */
import '../src/core/node.js';
