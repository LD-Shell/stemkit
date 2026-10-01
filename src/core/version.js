/**
 * @module core/version
 *
 * The release this copy of STEMKit belongs to. The footer of every page shows
 * the same version and date, and `npm run check:chrome` fails when they part
 * from `package.json`; `tests/version.test.js` holds these constants to
 * `package.json`, `CITATION.cff` and `CHANGELOG.md`. Bump all of them
 * together at a release.
 */

/** The release, as in `package.json` (without the leading "v"). */
export const STEMKIT_VERSION = '0.3.0';

/** The day the release was published, ISO 8601 (YYYY-MM-DD). */
export const RELEASE_DATE = '2026-10-01';
