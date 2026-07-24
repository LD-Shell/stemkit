/**
 * @module @stemkit/core
 *
 * Public entry point for the STEMKit computational core: the parsers,
 * numerical routines, and generators that underpin the browser tools, with no
 * DOM or UI dependency.
 *
 * Two usage patterns are supported.
 *
 * **Node.js**, register the vendored UMD libraries once at start-up, then
 * import whatever you need:
 *
 * ```js
 * import { createRequire } from 'module';
 * import { registerVendor, independentTTest } from '@stemkit/core';
 *
 * const require = createRequire(import.meta.url);
 * registerVendor({ jStat: require('./js/dependencies/jstat.min.js') });
 *
 * const result = independentTTest(control, treated);
 * ```
 *
 * **Browser**, the UMD `<script>` tags already install their globals, so a
 * single call picks them up:
 *
 * ```js
 * import { registerFromGlobals, parseXvg } from './src/core/index.js';
 * registerFromGlobals();
 * ```
 *
 * Modules that need no third-party code, `xvg-parser`, `structure`, `slurm`,
 * `digitizer`, `latex`, `units`, work without any registration at all.
 *
 * ## Name collisions
 *
 * A few names occur in more than one module, because the same statistic means
 * slightly different things in different contexts. Re-exporting them all with
 * `export *` would make them silently unimportable | Node raises "conflicting
 * star exports" only at the point of named import, so the barrel takes a
 * deliberate position:
 *
 *   - `mean`, `median`, `sd`, `columnStats`, and `formatValue` resolve to the
 *     implementations most callers want;
 *   - every module is *also* exposed as a namespace (`Stats`, `ErrorBars`,
 *     `DataCleaning`, `Digitizer`, `Units`, ...) so the alternatives remain
 *     reachable and unambiguous.
 *
 * The distinction is not cosmetic. `DataCleaning.columnStats` reports a
 * *population* standard deviation (a description of the rows in hand) while
 * `columnStats` from `xvg-parser` reports the *sample* value, an estimate of a
 * wider population. Silently importing the wrong one changes a reported
 * uncertainty.
 */

/* ------------------------------------------------------------------ *
 * Namespaces, every module, unambiguously
 * ------------------------------------------------------------------ */

export * as Vendor from './vendor.js';
export * as XvgParser from './xvg-parser.js';
export * as Stats from './statistics.js';
export * as Outliers from './outliers.js';
export * as CurveFitting from './curve-fitting.js';
export * as Structure from './structure.js';
export * as Slurm from './slurm.js';
export * as Units from './units.js';
export * as DataCleaning from './data-cleaning.js';
export * as Latex from './latex.js';
export * as Bibtex from './bibtex.js';
export * as Digitizer from './digitizer.js';
export * as ErrorBars from './error-bars.js';
export * as Journals from './journals.js';
export * as Iso4 from './iso4.js';
export * as Plumed from './plumed.js';
export * as Selection from './selection.js';

/* ------------------------------------------------------------------ *
 * Flat exports | collision-free modules
 * ------------------------------------------------------------------ */

export * from './vendor.js';
export * from './structure.js';
export * from './slurm.js';
export * from './latex.js';
export * from './bibtex.js';
export * from './journals.js';
export {
  parseLTWA,
  buildIso4Engine,
  abbreviateWord,
  abbreviateTitle,
  deriveRulesForUnknowns,
  loadIso4
} from './iso4.js';
export * from './plumed.js';
export * from './selection.js';

/* ------------------------------------------------------------------ *
 * Flat exports, modules with collisions, resolved explicitly
 * ------------------------------------------------------------------ */

// curve-fitting: `generateMatplotlibCode` omitted, since `xvg-parser` owns the
// flat name. The two emit different scripts -- one replots a trajectory, the
// other reproduces a fit -- so reach the fitting variant as
// `CurveFitting.generateMatplotlibCode`.
export {
  PARAM_COUNT,
  LINEARISED_MODELS,
  parseXYData,
  validateForModel,
  rSquared,
  rmse,
  adjustedRSquared,
  assessFitAdequacy,
  fitCurve,
  formatEquation,
  sampleCurve,
  residuals,
  pythonModelExpression
} from './curve-fitting.js';

// xvg-parser owns the flat `columnStats` (sample SD, for trajectory columns)
// and `generateMatplotlibCode`.
export {
  COLOR_PALETTE,
  extractQuoted,
  parseMetadataLine,
  parseDataLine,
  resolveHeaders,
  parseXvg,
  extractColumn,
  extractSeries,
  defaultActiveColumns,
  columnStats,
  generateSampleXvg,
  pythonLiteral,
  generateMatplotlibCode
} from './xvg-parser.js';

// statistics owns the flat `mean`, `median`, and `sd`.
export {
  mean,
  variance,
  sd,
  median,
  skewness,
  kurtosis,
  ranks,
  describe,
  tTwoSided,
  tCritical,
  fUpperTail,
  zTwoSided,
  chiSquaredUpperTail,
  dagostinoNormality,
  leveneTest,
  independentTTest,
  pairedTTest,
  oneWayAnova,
  pearsonCorrelation,
  mannWhitneyU,
  wilcoxonSignedRank,
  alignPairs,
  formatP,
  interpretD,
  interpretEta,
  interpretR,
  classifyFields,
  pivotLongToGroups
} from './statistics.js';

// outliers: `median` omitted, being identical to the statistics one.
export {
  MAD_TO_SIGMA,
  MEANAD_TO_SIGMA,
  medianAbsoluteDeviation,
  quartiles,
  zScores,
  modifiedZScores,
  detectZScore,
  detectModifiedZScore,
  detectIQR,
  grubbsTest,
  detectOutliers,
  extractNumericColumn,
  mapToRowIndices,
  partitionRows
} from './outliers.js';

// units: `formatValue` omitted; reach it as `Units.formatValue`.
export {
  UNIT_DB,
  convert,
  convertTemperature,
  listCategories,
  listAllCategories,
  isAffine,
  listUnits,
  getUnit,
  baseUnit,
  findCategory,
  convertKT
} from './units.js';

// data-cleaning: `columnStats` omitted (population SD); use
// `DataCleaning.columnStats` when that is the intended definition.
export {
  parseDelimited,
  toCSV,
  numericColumn,
  isMissing,
  dropMissing,
  deduplicate,
  fillMissing,
  fillWithStatistic,
  trimWhitespace,
  changeCase,
  sortByColumn,
  filterRows,
  roundColumn,
  renameColumn,
  dropColumns,
  transformColumn,
  profileData
} from './data-cleaning.js';

// digitizer owns the flat `formatValue`.
export {
  mapScale,
  toDataCoordinates,
  validateCalibration,
  pixelResolution,
  erasePoints,
  sortPoints,
  formatValue,
  generateCSV,
  digitisePoints
} from './digitizer.js';

// error-bars: `mean`, `sd`, and `median` omitted, being identical to
// the statistics implementations.
export {
  quantile,
  summariseGroup,
  detectHeaderRow,
  groupRows,
  computeGroups,
  currentError,
  errorLabel,
  niceTicks,
  axisRange,
  resultsToCSV,
  pairwiseComparisons
} from './error-bars.js';
