/**
 * @module stemkit-core/node
 *
 * Node.js entry point: the whole core, with the vendored libraries already
 * registered. `import ... from 'stemkit-core'` resolves here under Node (see
 * the "node" condition in package.json), so a script needs no
 * `registerVendor` call. Browsers and bundlers get `index.js` instead.
 *
 * The bundles are the files in `js/dependencies/` that the browser tools load
 * and the test suite checks, so a script computes with the same code as the
 * site. Calling `registerVendor` afterwards replaces any of them.
 */

import { createRequire } from 'node:module';
import { registerVendor } from './vendor.js';

const require = createRequire(import.meta.url);
const dep = (f) => require('../../js/dependencies/' + f);

registerVendor({
  jStat: dep('jstat.min.js'),
  Papa: dep('papaparse.min.js'),
  regression: dep('regression.min.js'),
  bibtexParse: dep('bibtexParse.min.js')
});

export * from './index.js';
