/**
 * Jest setup for the Node test environment.
 *
 * The vendored libraries in `js/dependencies/` are UMD bundles, which a plain
 * ES `import` cannot bind. Under Node they are loaded with `createRequire` and
 * handed to the core through the injection layer; in the browser the same
 * registry is populated from the globals the UMD `<script>` tags install.
 *
 * Registering here, once, keeps every test file free of loader boilerplate.
 */
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import { registerVendor } from '../src/core/vendor.js';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const dep = (name) => path.join(here, '..', 'js', 'dependencies', name);

registerVendor({
  jStat: require(dep('jstat.min.js')),
  Papa: require(dep('papaparse.min.js')),
  regression: require(dep('regression.min.js')),
  bibtexParse: require(dep('bibtexParse.min.js'))
});
