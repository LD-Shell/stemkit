#!/usr/bin/env bash
#
# run-tests.sh: run the STEMKit test suite and report the numbers cited in the
# paper (total tests, the count of each row of Table 1, the domain modules,
# the smoke test) and whether the documentation cites the same total.
#
# Usage, from the repository root:
#     chmod +x run-tests.sh
#     ./run-tests.sh
#
# Writes a copy of the report to test-report.txt.
# Exit status: 0 if the suite and smoke test both pass, 1 otherwise. A count
# that differs from the paper or from a document is reported, not failed:
# correct whichever is wrong before citing either.

set -uo pipefail   # deliberately not -e: a failing suite must still be reported

REPORT="test-report.txt"
JEST_JSON="$(mktemp -t stemkit-jest-XXXXXX.json)"
PARSER="$(mktemp -t stemkit-parse-XXXXXX.cjs)"
trap 'rm -f "$JEST_JSON" "$PARSER"' EXIT

# Everything printed goes to the terminal and into the report file.
exec > >(tee "$REPORT") 2>&1

hr() { printf '%s\n' "------------------------------------------------------------"; }

# --- 1. sanity: are we in the right directory? -----------------------------
if [ ! -f package.json ] || ! grep -q '"stemkit-core"' package.json; then
  echo "ERROR: run this from the repository root (no stemkit-core package.json here)."
  exit 1
fi

echo "STEMKit test run: $(date -u '+%Y-%m-%d %H:%M UTC')"
hr

# --- 2. toolchain ----------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node is not installed. Node.js >= 22 is required."
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
echo "node $(node --version)   npm $(npm --version 2>/dev/null || echo '?')"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "ERROR: Node.js >= 22 is required (package.json engines field)."
  exit 1
fi

# --- 3. dependencies ------------------------------------------------------
if [ ! -x node_modules/jest/bin/jest.js ] && [ ! -f node_modules/jest/bin/jest.js ]; then
  echo "jest not found in node_modules; running npm install..."
  npm install --no-audit --no-fund || { echo "ERROR: npm install failed."; exit 1; }
fi
hr

# --- 4. the suite ---------------------------------------------------------
# --experimental-vm-modules is required because the core is native ESM and
# jest's ESM support is still behind that flag; this mirrors `npm test`.
echo "Running Jest..."
node --experimental-vm-modules node_modules/jest/bin/jest.js \
     --json --outputFile="$JEST_JSON" >/dev/null 2>/tmp/stemkit-jest-stderr.txt
JEST_STATUS=$?
tail -6 /tmp/stemkit-jest-stderr.txt
hr

if [ ! -s "$JEST_JSON" ]; then
  echo "ERROR: jest produced no JSON output. Full log:"
  cat /tmp/stemkit-jest-stderr.txt
  exit 1
fi

# --- 5. the counts, compared with the paper and the documents -------------
# The expected numbers are read from the paper (Table 1 of paper/preprint.md
# and the two counts in its text) and from src/core/index.js, so nothing here
# goes stale when a test or a module is added: the paper is the thing to fix.
cat > "$PARSER" <<'PARSER_EOF'
const fs = require('fs');

const [, , jestJson, paperMd, indexJs, coreDir, ...docs] = process.argv;
const r = require(jestJson);
const paper = fs.readFileSync(paperMd, 'utf8');

// Table 1: one row per module or group of modules, with the tests of the
// page scripts built on them. "| `a`, `b` | what it does | 123 | needs |".
const rows = [];
let paperTotal = null;
{
  let seen = false, inTable = false;
  for (const line of paper.split('\n')) {
    if (!seen) { seen = /^\*\*Table 1\.\*\*/.test(line); continue; }
    if (!inTable) { inTable = /^\| Module \|/.test(line); continue; }
    if (!line.startsWith('|')) break;
    const cells = line.split('|').slice(1, -1).map(c => c.trim());
    if (/^:?-+:?$/.test(cells[0])) continue;               // the alignment row
    const n = parseInt(cells[2].replace(/\*/g, ''), 10);
    if (/^\*\*Total\*\*$/.test(cells[0])) { paperTotal = n; continue; }
    const modules = [...cells[0].matchAll(/`([^`]+)`/g)].map(m => m[1]);
    rows.push({ key: modules[0] || '(no module)', modules, paper: n, actual: 0 });
  }
}
if (!rows.length || paperTotal === null) {
  console.log('ERROR: could not read Table 1 from ' + paperMd);
  process.exit(1);
}

// A test file belongs to the row that lists the module of its name. Files
// named after something else (a page script, a program the module is
// checked against) say which row they count with.
const WITH = {
  'bibtex-commands': 'bibtex', 'doi-fetcher-page': 'bibtex',
  'curve-fitter-page': 'expression', 'fit-plot': 'expression',
  'decision': '(no module)', 'doc-tabs': '(no module)', 'how-tabs': '(no module)', 'site-tools': '(no module)',
  'file-check': '(no module)',
  'digitizer-figure': 'digitizer',
  'figure-plot': 'figure', 'number-fields': 'figure',
  'gromacs-ui': 'gromacs-mdp',
  'lammps-ui': 'lammps-reference',
  'plumed-catalogue': 'plumed', 'plumed-crosscheck': 'plumed', 'plumed-page': 'plumed',
  'plumed-program': 'plumed', 'plumed-units': 'plumed', 'script-generator-notes': 'plumed',
  'plumed-analysis-python': 'plumed-analysis',
  'scientific-converter-page': 'units',
  'slurm-form': 'slurm',
  'structure-gromacs': 'structure',
  'xvg-figure': 'xvg-parser'
};
const rowOf = stem =>
  rows.find(row => row.modules.includes(stem)) || rows.find(row => row.key === WITH[stem]);

let actualTotal = 0;
const unplaced = [], failing = [];
for (const t of r.testResults) {
  const stem = t.name.split(/[\\/]/).pop().replace(/\.test\.[cm]?js$/, '');
  const n = t.assertionResults.length;
  const failed = t.assertionResults.filter(a => a.status === 'failed').length;
  actualTotal += n;
  if (failed) failing.push(`${stem} (${failed})`);
  const row = rowOf(stem);
  if (row) row.actual += n; else unplaced.push(`${stem} (${n})`);
}

const pad = (s, w) => String(s).padEnd(w);
const lpad = (s, w) => String(s).padStart(w);
const delta = (a, b) => (a === b ? 'ok' : (a - b > 0 ? '+' : '') + (a - b));

console.log('Test counts by row of Table 1 of the paper');
console.log('(a row counts the page scripts built on its modules)');
console.log('');
console.log(pad('row', 34) + lpad('actual', 7) + lpad('paper', 7) + '   delta');
console.log('-'.repeat(56));
const drift = [];
for (const row of [...rows].sort((a, b) => b.paper - a.paper)) {
  const label = row.key + (row.modules.length > 1 ? ` (+${row.modules.length - 1})` : '');
  if (row.actual !== row.paper) drift.push(row.key);
  console.log(pad(label, 34) + lpad(row.actual, 7) + lpad(row.paper, 7) + '   ' + delta(row.actual, row.paper));
}
console.log('-'.repeat(56));
console.log(pad('TOTAL', 34) + lpad(actualTotal, 7) + lpad(paperTotal, 7) + '   ' + delta(actualTotal, paperTotal));
console.log('');
console.log(`suites: ${r.numTotalTestSuites}   tests: ${r.numTotalTests}   ` +
            `passed: ${r.numPassedTests}   failed: ${r.numFailedTests}   ` +
            `skipped: ${r.numPendingTests + r.numTodoTests}`);
if (failing.length) console.log(`FAILING: ${failing.join(', ')}`);
if (unplaced.length) console.log(`NOTE: in no row of Table 1 (add the module to the table, or the file to WITH in run-tests.sh): ${unplaced.join(', ')}`);
if (drift.length) console.log(`NOTE: count differs from Table 1: ${drift.join(', ')}`);

// The domain modules are the namespaces index.js exports, less the
// dependency-injection layer and the release version, which carry no domain
// logic; the rest of src/core is the barrel, the Node entry and the files that
// belong to one module each (generated tables, parts of the longest modules).
console.log('');
const index = fs.readFileSync(indexJs, 'utf8');
const namespaces = [...index.matchAll(/^export \* as \w+ from '\.\/([\w-]+)\.js';/gm)].map(m => m[1]);
const domain = namespaces.filter(n => n !== 'vendor' && n !== 'version').sort();
const files = fs.readdirSync(coreDir).filter(f => f.endsWith('.js'));
const claim = re => { const m = paper.match(re); return m ? Number(m[1]) : null; };
const paperDomain = claim(/(\d+) domain modules \(Table 1\)/);
const paperNamespaces = claim(/exports (\d+) namespaces/);
const inTable = new Set(rows.flatMap(row => row.modules).filter(m => m !== 'version'));
const notInTable = domain.filter(m => !inTable.has(m));
const notInIndex = [...inTable].filter(m => !domain.includes(m));
console.log(`src/core: ${files.length} files = ${namespaces.length} namespaces of index.js + index.js, node.js` +
            ` + ${files.length - namespaces.length - 2} generated or internal files`);
console.log(`domain modules (namespaces less vendor, version): ${domain.length}   paper: ${paperDomain}   ${delta(domain.length, paperDomain)}`);
console.log(`namespaces exported by index.js: ${namespaces.length}   paper: ${paperNamespaces}   ${delta(namespaces.length, paperNamespaces)}`);
if (notInTable.length) console.log(`NOTE: exported by index.js, absent from Table 1: ${notInTable.join(', ')}`);
if (notInIndex.length) console.log(`NOTE: in Table 1, not exported by index.js: ${notInIndex.join(', ')}`);
console.log('Domain modules: ' + domain.join(' '));

// Documents that quote the total. A number of four digits before "tests" or
// "-test" is a total (a row of Table 1 is never that large); history in
// CHANGELOG.md is left alone. architecture.png in paper/figures is drawn from
// the figure in preprint.tex and carries the total too: redraw it when it moves.
console.log('');
console.log(`Documents that quote the total (the suite has ${actualTotal}):`);
let stale = 0;
for (const f of docs) {
  if (!fs.existsSync(f)) continue;
  const cited = [...fs.readFileSync(f, 'utf8').matchAll(/\b(\d{4})(?:-test\b| (?:Jest )?tests\b)/g)].map(m => Number(m[1]));
  const wrong = [...new Set(cited.filter(n => n >= 4000 && n !== actualTotal))];
  if (wrong.length) stale++;
  console.log(`  ${pad(f, 24)} ${cited.length ? (wrong.length ? 'STALE, cites ' + wrong.join(', ') : 'ok') : 'does not quote it'}`);
}
if (stale) console.log('NOTE: update the documents marked STALE.');

process.exit(r.numFailedTests > 0 ? 1 : 0);
PARSER_EOF

node "$PARSER" "$JEST_JSON" paper/preprint.md src/core/index.js src/core \
     README.md docs/SETUP.md src/core/README.md ARCHITECTURE.md \
     paper/paper.md paper/preprint.md paper/preprint.tex
PARSE_STATUS=$?
hr

# --- 6. end-to-end smoke test -------------------------------------------
echo "Running smoke test (node tests/smoke.mjs)..."
node tests/smoke.mjs 2>&1 | tail -4
SMOKE_STATUS=${PIPESTATUS[0]}
hr

# --- 7. summary ----------------------------------------------------------
echo "jest exit=$JEST_STATUS   parse exit=$PARSE_STATUS   smoke exit=$SMOKE_STATUS"
if [ "$JEST_STATUS" -eq 0 ] && [ "$SMOKE_STATUS" -eq 0 ]; then
  echo "RESULT: all green. Report saved to $REPORT"
  exit 0
else
  echo "RESULT: something failed above. Report saved to $REPORT"
  exit 1
fi
