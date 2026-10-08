/**
 * @module stemkit-core
 *
 * Public entry point for the STEMKit computational core: the parsers,
 * numerical routines, and generators that underpin the browser tools, with no
 * DOM or UI dependency.
 *
 * Two usage patterns are supported.
 *
 * **Node.js**, `stemkit-core` resolves to `node.js`, which registers the
 * vendored UMD libraries and re-exports this module:
 *
 * ```js
 * import { independentTTest } from 'stemkit-core';
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
 * Only `statistics`, `outliers`, `error-bars` (and `error-bars-figure`, which
 * uses it), `curve-fitting`, `data-cleaning` and `bibtex` need the vendored
 * libraries; every other module works without any registration at all.
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
export * as Scheduler from './scheduler.js';
export * as Units from './units.js';
export * as DataCleaning from './data-cleaning.js';
export * as Latex from './latex.js';
export * as Bibtex from './bibtex.js';
export * as Digitizer from './digitizer.js';
export * as ErrorBars from './error-bars.js';
export * as Journals from './journals.js';
export * as Iso4 from './iso4.js';
export * as Plumed from './plumed.js';
export * as PlumedSyntax from './plumed-syntax.js';
export * as PlumedParse from './plumed-parse.js';
export * as PlumedAtoms from './plumed-atoms.js';
export * as PlumedAnalysis from './plumed-analysis.js';
export * as PlumedRun from './plumed-run.js';
export * as Selection from './selection.js';
export * as Expression from './expression.js';
export * as NonlinearFit from './nonlinear-fit.js';
export * as FitPython from './fit-python.js';
export * as PlotStyle from './plot-style.js';
export * as Pdf from './pdf.js';
export * as Zip from './zip.js';
export * as GromacsMdp from './gromacs-mdp.js';
export * as GromacsNdx from './gromacs-ndx.js';
export * as DataCleaningPython from './data-cleaning-python.js';
export * as Figure from './figure.js';
export * as FigurePython from './figure-python.js';
export * as ErrorBarsFigure from './error-bars-figure.js';
export * as StatisticsFigure from './statistics-figure.js';
export * as OutliersFigure from './outliers-figure.js';
export * as PlumedAnalysisFigures from './plumed-analysis-figures.js';
export * as PlotBuilder from './plot-builder.js';
export * as LammpsReference from './lammps-reference.js';
export * as LammpsInput from './lammps-input.js';
export * as LammpsData from './lammps-data.js';
export * as LammpsWorkflow from './lammps-workflow.js';
export * as Version from './version.js';

/* ------------------------------------------------------------------ *
 * Flat exports | collision-free modules
 * ------------------------------------------------------------------ */

export * from './version.js';
export * from './vendor.js';
export * from './structure.js';
export * from './slurm.js';
export * from './scheduler.js';
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

// The equation fitter's entry points. The rest of `expression` (compile,
// differentiate, FUNCTIONS, special, ...) has names too general to claim
// flat; reach it as `Expression.compile` and so on.
export { parseEquation, parseExpression, classify, toLatex } from './expression.js';
export { fitModel, studentTQuantile } from './nonlinear-fit.js';
export { generateFitScript } from './fit-python.js';
export { bandVisibility, defaultPlotStyle, normalisePlotStyle } from './plot-style.js';
export { pdfFromSvg, pdfFromJpeg } from './pdf.js';
export { buildZip } from './zip.js';
export { generateCleaningScript } from './data-cleaning-python.js';
export { normaliseFigure } from './figure.js';
export { figureScript } from './figure-python.js';
// Each plotting tool's figure and the script that repeats its numbers.
export { errorBarFigure, errorBarScript } from './error-bars-figure.js';
export { statisticsFigure, statisticsScript } from './statistics-figure.js';
export { outlierFigure, outlierScript } from './outliers-figure.js';

// GROMACS .mdp files. STAGES, FORCE_FIELDS, formatDuration and the like stay
// under GromacsMdp: their names are too general to claim flat.
export {
  parseMdp, checkMdp, explainMdp, generateMdp, generateWorkflow, mdpDocUrl, optionInfo, loadMdpDocs
} from './gromacs-mdp.js';

// LAMMPS: the workflow builder flat; reading, checking and explaining inputs
// (parseInput, checkInput, checkChain, explainInput...) and data files
// (parseDataFile, summariseData...) stay under LammpsInput and LammpsData,
// whose names are too general to claim flat.
export {
  defaultLammpsState, buildLammpsWorkflow, lammpsRunBlock, lammpsReadme
} from './lammps-workflow.js';
export { lammpsDocUrl } from './lammps-reference.js';

// GROMACS index groups. Curated, since names such as parseNdx are specific
// but orGroups or customGroup would read ambiguously beside other modules.
export {
  readGromacsStructure, toGromacsStructure, defaultGroups, makeNdx, writeNdx, parseNdx,
  customGroup, suggestGroups, recommendTcGrps, describeGroups, checkGroupCoverage,
  checkMdpGroups, mergeIndexGroups, renameIndexGroup, findIndexGroup
} from './gromacs-ndx.js';

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
  descriptives,
  boxPlotStats,
  tTwoSided,
  tCritical,
  fUpperTail,
  zTwoSided,
  chiSquaredUpperTail,
  dagostinoNormality,
  leveneTest,
  independentTTest,
  pairedTTest,
  oneSampleTTest,
  oneWayAnova,
  welchAnova,
  pearsonCorrelation,
  leastSquaresLine,
  mannWhitneyU,
  wilcoxonSignedRank,
  oneSampleWilcoxon,
  spearmanCorrelation,
  kruskalWallis,
  qUpperTail,
  adjustPValues,
  tukeyHSD,
  gamesHowell,
  dunnTest,
  recommendTest,
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
