#!/usr/bin/env bash
#
# run-tests.sh: run the STEMKit test suite and report the numbers cited in the
# paper (total tests, per-module counts, domain-module count, smoke test).
#
# Usage, from the repository root:
#     chmod +x run-tests.sh
#     ./run-tests.sh
#
# Writes a copy of the report to test-report.txt.
# Exit status: 0 if the suite and smoke test both pass, 1 otherwise.

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
  echo "ERROR: node is not installed. Node.js >= 18 is required."
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
echo "node $(node --version)   npm $(npm --version 2>/dev/null || echo '?')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "ERROR: Node.js >= 18 is required (package.json engines field)."
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

# --- 5. per-module breakdown, compared with the paper's Table 1 -----------
cat > "$PARSER" <<'PARSER_EOF'
const r = require(process.argv[2]);

// Per-module test counts as printed in Table 1 of paper/preprint.tex.
// A delta here means the suite and the manuscript have diverged: correct
// whichever is wrong before citing either.
const paper = {
  bibtex: 102, structure: 100, statistics: 84, 'curve-fitting': 77,
  'xvg-parser': 77, units: 73, plumed: 72, selection: 67, slurm: 61,
  latex: 59, 'error-bars': 57, journals: 53, 'data-cleaning': 51,
  outliers: 51, scheduler: 51, digitizer: 49, iso4: 44
};

const rows = r.testResults
  .map(t => ({
    module: t.name.split(/[\\/]/).pop().replace(/\.test\.[cm]?js$/, ''),
    n: t.assertionResults.length,
    failed: t.assertionResults.filter(a => a.status === 'failed').length
  }))
  .sort((a, b) => b.n - a.n || a.module.localeCompare(b.module));

const pad = (s, w) => String(s).padEnd(w);
const lpad = (s, w) => String(s).padStart(w);

console.log('Per-module test counts vs. Table 1 of the paper');
console.log('');
console.log(pad('module', 16) + lpad('actual', 7) + lpad('paper', 7) + '   delta');
console.log('-'.repeat(48));

let actualTotal = 0, missing = [], drift = [];
for (const { module, n, failed } of rows) {
  actualTotal += n;
  const p = paper[module];
  let delta;
  if (p === undefined) { delta = 'not in Table 1'; missing.push(module); }
  else if (n === p)    { delta = 'ok'; }
  else                 { delta = (n - p > 0 ? '+' : '') + (n - p); drift.push(module); }
  console.log(
    pad(module, 16) + lpad(n, 7) + lpad(p === undefined ? '-' : p, 7) +
    '   ' + delta + (failed ? `  (${failed} FAILING)` : '')
  );
}

const paperTotal = Object.values(paper).reduce((a, b) => a + b, 0);
console.log('-'.repeat(48));
console.log(pad('TOTAL', 16) + lpad(actualTotal, 7) + lpad(paperTotal, 7) +
            '   ' + (actualTotal === paperTotal ? 'ok' : (actualTotal - paperTotal > 0 ? '+' : '') + (actualTotal - paperTotal)));
console.log('');
console.log(`suites: ${r.numTotalTestSuites}   tests: ${r.numTotalTests}   ` +
            `passed: ${r.numPassedTests}   failed: ${r.numFailedTests}   ` +
            `skipped: ${r.numPendingTests + r.numTodoTests}`);

if (missing.length) console.log(`\nNOTE: tested but absent from Table 1: ${missing.join(', ')}`);
if (drift.length)   console.log(`NOTE: count changed since Table 1 was written: ${drift.join(', ')}`);

process.exit(r.numFailedTests > 0 ? 1 : 0);
PARSER_EOF

node "$PARSER" "$JEST_JSON"
PARSE_STATUS=$?
hr

# --- 6. domain-module count (the paper's "N domain modules") -------------
# index.js is a re-export barrel and vendor.js is the DI boundary; neither is
# a domain module, so both are excluded from the count the paper quotes.
DOMAIN_COUNT="$(find src/core -maxdepth 1 -name '*.js' \
                ! -name 'index.js' ! -name 'vendor.js' | wc -l | tr -d ' ')"
echo "Domain modules under src/core/ (excluding index.js, vendor.js): $DOMAIN_COUNT"
echo "Modules:"
find src/core -maxdepth 1 -name '*.js' ! -name 'index.js' ! -name 'vendor.js' \
  -exec basename {} .js \; | sort | tr '\n' ' '
echo
hr

# --- 7. end-to-end smoke test -------------------------------------------
echo "Running smoke test (node tests/smoke.mjs)..."
node tests/smoke.mjs 2>&1 | tail -4
SMOKE_STATUS=${PIPESTATUS[0]}
hr

# --- 8. summary ----------------------------------------------------------
echo "jest exit=$JEST_STATUS   parse exit=$PARSE_STATUS   smoke exit=$SMOKE_STATUS"
if [ "$JEST_STATUS" -eq 0 ] && [ "$SMOKE_STATUS" -eq 0 ]; then
  echo "RESULT: all green. Report saved to $REPORT"
  exit 0
else
  echo "RESULT: something failed above. Report saved to $REPORT"
  exit 1
fi
