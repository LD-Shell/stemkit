/**
 * Selection adapter for the Structure Inspector.
 *
 * `structure-inspector.js` is 2,484 lines built around a 3Dmol.js viewer, with
 * the selection parser threaded through a class that also owns rendering,
 * measurement, trajectory playback, and labelling. Rewriting the whole file in
 * one step would be a large change with a high chance of a subtle rendering
 * regression, and little benefit: the rendering is not the part that needed
 * testing.
 *
 * This module converts the part that did, the selection query language and the
 * spatial neighbour search, and exposes it in the shape the existing class
 * expects, so the rest of the file is untouched.
 *
 * ## Why this is worth doing
 *
 * The original parser resolved sub-selections by calling back into the viewer
 * (`model.selectedAtoms(...)`), which made the query language impossible to
 * test without a browser and a WebGL context. The core version operates on
 * plain atom records, so `within:5,chain:A` is now covered by 67 tests
 * including a brute-force cross-check of the spatial grid across 25
 * radius x cell-size combinations.
 *
 * It also fixes a unit hazard. A `within:` radius is interpreted in the unit
 * the user selected and converted to the coordinate unit of the structure. A
 * `.gro` file is in nanometre and its PDB counterpart in angstrom, so the same
 * query against the same molecule differed by a factor of ten depending on
 * which file was loaded.
 *
 * ## Applying this
 *
 * In `js/structure-inspector.js`:
 *
 *   1. Add at the top of the file:
 *
 *        import { makeSelectionAdapter } from './structure-inspector-selection.js';
 *
 *   2. Replace the body of `parseSelString(str, opts)` with:
 *
 *        return this._selection.parse(str, opts);
 *
 *   3. In the class constructor, after `this.viewer` is assigned:
 *
 *        this._selection = makeSelectionAdapter(() => this.viewer);
 *
 *   4. Add `type="module"` to the script tag in `structure-inspector.html`.
 *
 * The `SpatialGrid` and `dist2` definitions near the top of the file can then
 * be deleted; this module re-exports the tested versions.
 *
 * ## Why it is not applied yet
 *
 * A side-by-side reading of the two parsers found five places where the core
 * would answer a query differently from the page, so switching would change
 * what a selection returns. Each needs settling in `core/selection` first:
 *
 *   - `byres:1` and `expand:N` are page tokens (the syntax table gives
 *     `within:5,resn:HEM byres:1` as a worked example); `compileSelection`
 *     has no such keys and treats them as attribute matches on a field that
 *     does not exist, so the query selects nothing.
 *   - `hetero:1` is the HETATM flag on the page; the core defines it by
 *     residue name and excludes water.
 *   - The named sets differ both ways: the page's protein set includes SEC
 *     and PYL, the core's does not; the page's ion set includes ION.
 *   - The page reads the unit from the `#queryUnit` control; this adapter
 *     reads only `opts.unit`, so a nanometre query would silently become
 *     angstrom.
 *   - Core attribute matching is case-insensitive, while the syntax table
 *     states that `elem` is case-sensitive, and chain identifiers can be
 *     case-distinct in assemblies.
 *
 * Note also that 3Dmol's GRO parser scales to angstrom on load, so the
 * `within:` unit hazard described above does not arise in the viewer itself.
 */

import {
  compileSelection,
  selectAtoms,
  expandToResidues,
  SpatialGrid,
  distance,
  distanceSquared,
  findContacts,
  selectionSummary
} from '../src/core/selection.js';

export { SpatialGrid, distance, distanceSquared, findContacts, selectionSummary };

/**
 * Build a selection adapter bound to a viewer accessor.
 *
 * The viewer is fetched lazily through a callback rather than captured, so the
 * adapter survives a model being reloaded.
 *
 * @param {() => object} getViewer - Returns the live 3Dmol viewer, or null.
 * @returns {{parse:Function, select:Function, atoms:Function}}
 */
export function makeSelectionAdapter(getViewer) {

  /** Every atom in the current model, or an empty array when none is loaded. */
  function allAtoms() {
    const viewer = getViewer ? getViewer() : null;
    const model = viewer && viewer.getModel ? viewer.getModel() : null;
    if (!model) return [];
    try {
      return model.selectedAtoms({}) || [];
    } catch {
      return [];
    }
  }

  /**
   * Parse a selection string into a 3Dmol-compatible selection object.
   *
   * 3Dmol accepts a `predicate` key, so the whole compiled query is handed over
   * as one function rather than being decomposed into the subset of attribute
   * filters 3Dmol understands natively. That keeps the semantics identical to
   * the tested core (including negation, unions, and `within:`) instead of
   * two parsers having to agree.
   *
   * @param {string} str
   * @param {{unit?:string, coordinateUnit?:string, byres?:boolean}} [opts]
   * @returns {object} A 3Dmol selection.
   */
  function parse(str, opts = {}) {
    const pool = allAtoms();
    const { predicate, errors } = compileSelection(str, pool, {
      unit: opts.unit || 'A',
      coordinateUnit: opts.coordinateUnit || 'A'
    });

    if (errors.length && typeof console !== 'undefined') {
      // Surfaced rather than swallowed: a mistyped term that silently selects
      // everything is worse than one that says so.
      console.warn('Selection warnings:', errors);
    }

    const sel = { predicate };
    if (opts.byres) sel.byres = true;
    return sel;
  }

  /**
   * Evaluate a query against the current model without going through 3Dmol.
   *
   * @param {string} str
   * @param {object} [opts]
   * @returns {{atoms:Array<object>, errors:string[], count:number}}
   */
  function select(str, opts = {}) {
    return selectAtoms(allAtoms(), str, opts);
  }

  return {
    parse,
    select,
    atoms: allAtoms,
    expandToResidues: (selected) => expandToResidues(allAtoms(), selected)
  };
}
