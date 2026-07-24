import { describe, test, expect } from '@jest/globals';
import '../tests/setup.js';
import {
  normaliseDoi, normaliseTitle, parseBibtex, getField,
  findDuplicates, completenessScore, chooseBest, deduplicateAuto,
  serialiseEntry, serialiseLibrary,
  fixPageRange, stripOuterBraces, protectCapitals,
  removeFields, sanitiseLibrary, missingFields,
  readFieldsPreservingBraces, sanitiseText,
  parseDoiList, filterBibtexFields
} from '../src/core/bibtex.js';

const LIBRARY = `
@article{smith2020,
  author = {Smith, J.},
  title = {The Structure of DNA},
  doi = {10.1000/xyz},
  journal = {Nature},
  year = {2020},
  pages = {100-110}
}
@article{smith2020b,
  author = {Smith, John},
  title = {{The} structure of DNA.},
  year = {2020}
}
@article{unique2021,
  author = {Jones, A.},
  title = {A Different Study},
  doi = {10.1000/abc},
  journal = {Science},
  year = {2021}
}
`;

describe('normaliseDoi', () => {
  test('strips a resolver prefix', () => {
    expect(normaliseDoi('https://doi.org/10.1000/xyz')).toBe('10.1000/xyz');
    expect(normaliseDoi('http://dx.doi.org/10.1000/xyz')).toBe('10.1000/xyz');
  });

  test('lowercases, since DOIs are case-insensitive', () => {
    expect(normaliseDoi('10.1000/ABC')).toBe('10.1000/abc');
  });

  test('removes whitespace', () => {
    expect(normaliseDoi('  10.1000/x yz ')).toBe('10.1000/xyz');
  });

  test('handles empty input', () => {
    expect(normaliseDoi('')).toBe('');
    expect(normaliseDoi(null)).toBe('');
  });
});

describe('normaliseTitle', () => {
  test('removes LaTeX grouping braces', () => {
    expect(normaliseTitle('{The} Structure')).toBe('the structure');
  });

  test('removes punctuation and collapses whitespace', () => {
    expect(normaliseTitle('The  structure of DNA.')).toBe('the structure of dna');
  });

  test('removes inline maths', () => {
    expect(normaliseTitle('Energy $E=mc^2$ study')).toBe('energy study');
  });

  test('removes a LaTeX command but keeps its braced argument', () => {
    // Consuming the brace group would delete the title text it wraps.
    expect(normaliseTitle('\\emph{Important} work')).toBe('important work');
    expect(normaliseTitle('\\textbf{Protein} folding')).toBe('protein folding');
  });

  test('makes differently formatted titles compare equal', () => {
    expect(normaliseTitle('{The} structure of DNA.'))
      .toBe(normaliseTitle('The Structure of DNA'));
  });
});

describe('parseBibtex', () => {
  test('parses entries with their keys and tags', () => {
    const r = parseBibtex(LIBRARY);
    expect(r.entries).toHaveLength(3);
    expect(r.entries[0].citationKey).toBe('smith2020');
    expect(r.error).toBeNull();
  });

  test('survives a @string definition instead of losing the library', () => {
    // bibtex-parse-js aborts the whole document on @string, so these blocks
    // are stripped first; a Zotero export would otherwise parse to nothing.
    const r = parseBibtex('@string{nat = "Nature"}\n@article{a, title={T}, year={2020}}');
    expect(r.entries).toHaveLength(1);
    expect(r.error).toBeNull();
    expect(r.strippedBlocks).toBe(1);
  });

  test('survives @comment and @preamble blocks', () => {
    expect(parseBibtex('@comment{jabref-meta: x;}\n@article{a, title={T}, year={2020}}')
      .entries).toHaveLength(1);
    expect(parseBibtex('@preamble{"x"}\n@article{a, title={T}, year={2020}}')
      .entries).toHaveLength(1);
  });

  test('strips several non-entry blocks at once', () => {
    const src = '@string{n="N"}\n@comment{c}\n@preamble{"p"}\n' +
                '@article{a, title={T}, year={2020}}\n@article{b, title={U}, year={2021}}';
    const r = parseBibtex(src);
    expect(r.entries).toHaveLength(2);
    expect(r.strippedBlocks).toBe(3);
  });

  test('reports a genuine syntax error without throwing', () => {
    // The parser throws a bare string rather than an Error object.
    const r = parseBibtex('@article{a, title={T');
    expect(r.entries).toEqual([]);
    expect(r.error).toContain('Syntax error');
  });

  test('returns an empty result for blank input', () => {
    expect(parseBibtex('').entries).toEqual([]);
    expect(parseBibtex(null).entries).toEqual([]);
  });
});

describe('getField', () => {
  const tags = { DOI: '10.1/x', title: 'T', Year: '2020' };

  test('matches field names case-insensitively', () => {
    expect(getField(tags, 'doi')).toBe('10.1/x');
    expect(getField(tags, 'TITLE')).toBe('T');
    expect(getField(tags, 'year')).toBe('2020');
  });

  test('returns an empty string when absent', () => {
    expect(getField(tags, 'publisher')).toBe('');
    expect(getField(null, 'doi')).toBe('');
  });
});

describe('findDuplicates', () => {
  const entries = parseBibtex(LIBRARY).entries;

  test('groups entries sharing a normalised title', () => {
    const d = findDuplicates(entries);
    expect(d.groups).toHaveLength(1);
    expect(d.groups[0].members).toHaveLength(2);
  });

  test('leaves unrelated entries as singletons', () => {
    expect(findDuplicates(entries).singletons).toHaveLength(1);
  });

  test('counts duplicates as group size minus one', () => {
    expect(findDuplicates(entries).duplicateCount).toBe(1);
  });

  test('matches on DOI across resolver prefix and case', () => {
    const bib = `@article{a, title={One}, doi={10.1/X}, year={2020}}
@article{b, title={Two}, doi={https://doi.org/10.1/x}, year={2020}}`;
    const d = findDuplicates(parseBibtex(bib).entries);
    expect(d.groups).toHaveLength(1);
  });

  test('links transitively through a shared intermediate', () => {
    // A shares a DOI with B; B shares a title with C. All three are one work.
    const bib = `@article{a, title={Alpha}, doi={10.1/z}, year={2020}}
@article{b, title={Beta}, doi={10.1/z}, year={2020}}
@article{c, title={Beta}, year={2020}}`;
    const d = findDuplicates(parseBibtex(bib).entries);
    expect(d.groups).toHaveLength(1);
    expect(d.groups[0].members).toHaveLength(3);
  });

  test('orders groups by first appearance', () => {
    const bib = `@article{a, title={Zed}, year={2020}}
@article{b, title={Alpha}, year={2020}}
@article{c, title={Alpha}, year={2020}}
@article{d, title={Zed}, year={2020}}`;
    const d = findDuplicates(parseBibtex(bib).entries);
    expect(d.groups[0].members[0].data.citationKey).toBe('a');
  });

  test('does not group entries lacking both DOI and title', () => {
    const bib = `@misc{a, year={2020}}\n@misc{b, year={2021}}`;
    expect(findDuplicates(parseBibtex(bib).entries).groups).toHaveLength(0);
  });

  test('handles empty input', () => {
    expect(findDuplicates([]).groups).toEqual([]);
    expect(findDuplicates(null).groups).toEqual([]);
  });
});

describe('completenessScore and chooseBest', () => {
  const entries = parseBibtex(LIBRARY).entries;

  test('weights a DOI most heavily', () => {
    const withDoi = { entryTags: { doi: '10.1/x' } };
    const withoutDoi = { entryTags: { author: 'A', title: 'T', year: '2020' } };
    expect(completenessScore(withDoi)).toBeGreaterThan(completenessScore(withoutDoi));
  });

  test('scores more fields higher', () => {
    const rich = { entryTags: { author: 'A', title: 'T', year: '2020', journal: 'J' } };
    const sparse = { entryTags: { title: 'T' } };
    expect(completenessScore(rich)).toBeGreaterThan(completenessScore(sparse));
  });

  test('selects the most complete member of a group', () => {
    const d = findDuplicates(entries);
    const best = chooseBest(d.groups[0].members);
    expect(best.citationKey).toBe('smith2020');
  });

  test('handles degenerate input', () => {
    expect(completenessScore(null)).toBe(0);
    expect(chooseBest([])).toBeNull();
  });
});

describe('deduplicateAuto', () => {
  test('keeps one entry per duplicate group', () => {
    const entries = parseBibtex(LIBRARY).entries;
    const r = deduplicateAuto(entries);
    expect(r.entries).toHaveLength(2);
    expect(r.removed).toBe(1);
    expect(r.groups).toBe(1);
  });

  test('keeps the more complete duplicate', () => {
    const r = deduplicateAuto(parseBibtex(LIBRARY).entries);
    expect(r.entries.map(e => e.citationKey)).toContain('smith2020');
    expect(r.entries.map(e => e.citationKey)).not.toContain('smith2020b');
  });

  test('preserves source order', () => {
    const r = deduplicateAuto(parseBibtex(LIBRARY).entries);
    expect(r.entries[0].citationKey).toBe('smith2020');
    expect(r.entries[1].citationKey).toBe('unique2021');
  });

  test('leaves a clean library untouched', () => {
    const bib = `@article{a, title={One}, year={2020}}\n@article{b, title={Two}, year={2021}}`;
    const r = deduplicateAuto(parseBibtex(bib).entries);
    expect(r.removed).toBe(0);
    expect(r.entries).toHaveLength(2);
  });
});

describe('serialisation', () => {
  test('round-trips an entry through the parser', () => {
    const entries = parseBibtex(LIBRARY).entries;
    const back = parseBibtex(serialiseEntry(entries[0]));
    expect(back.entries[0].citationKey).toBe('smith2020');
    expect(getField(back.entries[0].entryTags, 'doi')).toBe('10.1000/xyz');
  });

  test('emits the entry type and key', () => {
    const s = serialiseEntry(parseBibtex(LIBRARY).entries[0]);
    expect(s).toContain('@article{smith2020,');
  });

  test('omits the trailing comma on the final field', () => {
    const s = serialiseEntry({ entryType: 'misc', citationKey: 'k', entryTags: { a: '1', b: '2' } });
    expect(s).toContain('b = {2}\n');
    expect(s).not.toContain('b = {2},');
  });

  test('serialises a whole library', () => {
    const entries = parseBibtex(LIBRARY).entries;
    expect(parseBibtex(serialiseLibrary(entries)).entries).toHaveLength(3);
  });

  test('handles null input', () => {
    expect(serialiseEntry(null)).toBe('');
    expect(serialiseLibrary(null)).toBe('');
  });
});

describe('sanitising helpers', () => {
  test('fixPageRange converts hyphens to LaTeX en dashes', () => {
    expect(fixPageRange('100-110')).toBe('100--110');
    expect(fixPageRange('100 \u2013 110')).toBe('100--110');
    expect(fixPageRange('100 \u2014 110')).toBe('100--110');
  });

  test('fixPageRange leaves non-numeric hyphens alone', () => {
    expect(fixPageRange('Smith-Jones')).toBe('Smith-Jones');
  });

  test('stripOuterBraces removes redundant wrapping', () => {
    expect(stripOuterBraces('{{Title}}')).toBe('Title');
    expect(stripOuterBraces('  {Title}  ')).toBe('Title');
  });

  test('protectCapitals braces all-caps acronyms', () => {
    expect(protectCapitals('The Structure of DNA')).toBe('The Structure of {DNA}');
    expect(protectCapitals('NMR spectroscopy')).toBe('{NMR} spectroscopy');
  });

  test('protectCapitals braces lowercase-initial scientific terms', () => {
    // pH, mRNA and pKa are missed by any rule requiring an initial capital.
    expect(protectCapitals('Study of pH levels')).toBe('Study of {pH} levels');
    expect(protectCapitals('mRNA and pKa values')).toBe('{mRNA} and {pKa} values');
  });

  test('protectCapitals braces internal capitals', () => {
    expect(protectCapitals('NaCl crystal')).toBe('{NaCl} crystal');
  });

  test('protectCapitals is idempotent', () => {
    const once = protectCapitals('Study of pH and DNA');
    expect(protectCapitals(once)).toBe(once);
  });

  test('protectCapitals leaves ordinary title case alone', () => {
    expect(protectCapitals('The Structure of Water')).toBe('The Structure of Water');
  });

  test('protectCapitals does not double-protect existing braces', () => {
    expect(protectCapitals('The {DNA} helix')).toBe('The {DNA} helix');
  });

  test('removeFields drops named fields case-insensitively', () => {
    const e = { entryTags: { title: 'T', abstract: 'long', FILE: 'x.pdf' } };
    const r = removeFields(e, ['abstract', 'file']);
    expect(r.entryTags.title).toBe('T');
    expect(r.entryTags.abstract).toBeUndefined();
    expect(r.entryTags.FILE).toBeUndefined();
  });
});

describe('sanitiseLibrary', () => {
  const entries = parseBibtex(LIBRARY).entries;

  test('fixes page ranges when asked', () => {
    const r = sanitiseLibrary(entries, { fixPages: true });
    expect(getField(r.entries[0].entryTags, 'pages')).toBe('100--110');
  });

  test('protects capitals in titles when asked', () => {
    const r = sanitiseLibrary(entries, { protectCaps: true });
    expect(getField(r.entries[0].entryTags, 'title')).toContain('{DNA}');
  });

  test('removes named fields', () => {
    const r = sanitiseLibrary(entries, { removeFields: ['doi'] });
    expect(getField(r.entries[0].entryTags, 'doi')).toBe('');
  });

  test('lowercases field keys when asked', () => {
    const bib = '@article{a, TITLE={T}, YEAR={2020}}';
    const r = sanitiseLibrary(parseBibtex(bib).entries, { lowercaseKeys: true });
    expect(Object.keys(r.entries[0].entryTags)).toContain('title');
  });

  test('counts how many entries changed', () => {
    expect(sanitiseLibrary(entries, { fixPages: true }).changes).toBeGreaterThan(0);
  });

  test('makes no change when no options are set', () => {
    expect(sanitiseLibrary(entries, {}).changes).toBe(0);
  });

  test('does not mutate the input', () => {
    sanitiseLibrary(entries, { fixPages: true, protectCaps: true });
    expect(getField(entries[0].entryTags, 'pages')).toBe('100-110');
  });
});

describe('missingFields', () => {
  test('reports the fields an article lacks', () => {
    const e = { entryType: 'article', entryTags: { author: 'A', title: 'T' } };
    expect(missingFields(e)).toContain('journal');
    expect(missingFields(e)).toContain('year');
  });

  test('applies type-specific requirements', () => {
    const book = { entryType: 'book', entryTags: { author: 'A', title: 'T', year: '2020' } };
    expect(missingFields(book)).toEqual(['publisher']);
  });

  test('returns an empty array for a complete entry', () => {
    const e = {
      entryType: 'article',
      entryTags: { author: 'A', title: 'T', journal: 'J', year: '2020' }
    };
    expect(missingFields(e)).toEqual([]);
  });

  test('falls back to generic requirements for an unknown type', () => {
    const e = { entryType: 'weirdtype', entryTags: {} };
    expect(missingFields(e)).toEqual(['author', 'title', 'year']);
  });
});

describe('readFieldsPreservingBraces', () => {
  test('preserves nested braces that the parser would strip', () => {
    // The vendored parser turns {NaCl} into NaCl, destroying the capitalisation
    // protection. A sanitiser must not do that.
    const f = readFieldsPreservingBraces('title={A study of {NaCl} crystals}');
    expect(f[0].value).toBe('A study of {NaCl} crystals');
  });

  test('handles several nested groups in one value', () => {
    const f = readFieldsPreservingBraces('title={{NaCl} and {H2O}}');
    expect(f[0].value).toBe('{NaCl} and {H2O}');
  });

  test('reads quoted values', () => {
    const f = readFieldsPreservingBraces('title="A quoted title", year={2024}');
    expect(f[0].value).toBe('A quoted title');
    expect(f[1].value).toBe('2024');
  });

  test('does not end a quoted value at a brace-enclosed quote', () => {
    const f = readFieldsPreservingBraces('title="Outer {inner} text"');
    expect(f[0].value).toBe('Outer {inner} text');
  });

  test('reads a bare value such as a number or macro', () => {
    const f = readFieldsPreservingBraces('year=2024, journal=jp');
    expect(f[0].value).toBe('2024');
    expect(f[1].value).toBe('jp');
  });

  test('lowercases keys but leaves values untouched', () => {
    const f = readFieldsPreservingBraces('TITLE={MiXeD CaSe}');
    expect(f[0].key).toBe('title');
    expect(f[0].value).toBe('MiXeD CaSe');
  });

  test('skips a malformed field without derailing the rest', () => {
    const f = readFieldsPreservingBraces('broken, year={2024}');
    expect(f.some(x => x.key === 'year')).toBe(true);
  });

  test('handles empty input', () => {
    expect(readFieldsPreservingBraces('')).toEqual([]);
    expect(readFieldsPreservingBraces(null)).toEqual([]);
  });
});

describe('sanitiseText', () => {
  const SRC = `@string{jp = "Journal of Physics"}

@article{smith2024,
  title={An analysis of {NaCl} dynamics},
  author={Smith, John},
  pages={100-110},
  year={2024},
  url={https://tracking.example.com/abc}
}

@comment{jabref-meta: databaseType:bibtex;}`;

  test('strips the named fields', () => {
    const r = sanitiseText(SRC, { stripFields: ['url'] });
    expect(r.text).not.toContain('tracking.example');
    expect(r.fieldsRemoved).toBe(1);
  });

  test('preserves nested braces through the whole pipeline', () => {
    const r = sanitiseText(SRC, { stripFields: ['url'], protectTitle: true });
    expect(r.text).toContain('{NaCl}');
  });

  test('passes @string and @comment blocks through untouched', () => {
    const r = sanitiseText(SRC, { stripFields: ['url'] });
    expect(r.text).toContain('@string{jp = "Journal of Physics"}');
    expect(r.text).toContain('@comment{jabref-meta');
  });

  test('normalises page ranges', () => {
    expect(sanitiseText(SRC, { fixPages: true }).text).toContain('100--110');
  });

  test('aligns the equals signs when asked', () => {
    const r = sanitiseText(SRC, { alignEquals: true });
    expect(r.text).toContain('title  = {');
    expect(r.text).toContain('author = {');
  });

  test('counts the entries it processed', () => {
    expect(sanitiseText(SRC, {}).entriesProcessed).toBe(1);
  });

  test('is idempotent, a second pass changes nothing', () => {
    const opts = { stripFields: ['url'], fixPages: true, protectTitle: true, alignEquals: true };
    const once = sanitiseText(SRC, opts).text;
    expect(sanitiseText(once, opts).text).toBe(once);
  });

  test('handles empty input', () => {
    expect(sanitiseText('', {}).text).toBe('');
    expect(sanitiseText(null, {}).entriesProcessed).toBe(0);
  });
});

describe('parseDoiList', () => {
  test('splits on newlines by default', () => {
    expect(parseDoiList('10.1/a\n10.1/b').dois).toEqual(['10.1/a', '10.1/b']);
  });

  test('detects semicolon and comma separators', () => {
    expect(parseDoiList('10.1/a; 10.1/b').dois).toHaveLength(2);
    expect(parseDoiList('10.1/a, 10.1/b').dois).toHaveLength(2);
  });

  test('honours an explicit delimiter', () => {
    expect(parseDoiList('10.1/a 10.1/b', 'space').dois).toHaveLength(2);
  });

  test('strips resolver prefixes', () => {
    const r = parseDoiList('https://doi.org/10.1/a\nhttp://dx.doi.org/10.1/b');
    expect(r.dois).toEqual(['10.1/a', '10.1/b']);
  });

  test('removes duplicates case-insensitively', () => {
    // A DOI is case-insensitive by specification, so these are one record.
    const r = parseDoiList('10.1/ABC\n10.1/abc');
    expect(r.dois).toHaveLength(1);
    expect(r.duplicates).toBe(1);
  });

  test('ignores blank entries', () => {
    expect(parseDoiList('10.1/a\n\n\n10.1/b').dois).toHaveLength(2);
  });

  test('handles empty input', () => {
    expect(parseDoiList('').dois).toEqual([]);
    expect(parseDoiList(null).dois).toEqual([]);
  });
});

describe('filterBibtexFields', () => {
  const ENTRY = `@article{key,
  title = {A title},
  author = {Smith, J.},
  abstract = {A long abstract
  that runs across lines.},
  year = {2024}
}`;

  test('keeps only the named fields', () => {
    const r = filterBibtexFields(ENTRY, ['title', 'year']);
    expect(r).toContain('title');
    expect(r).toContain('year');
    expect(r).not.toContain('author');
  });

  test('drops a multi-line value in full', () => {
    // The continuation line must go too, or a fragment survives on its own.
    const r = filterBibtexFields(ENTRY, ['title']);
    expect(r).not.toContain('abstract');
    expect(r).not.toContain('that runs across lines');
  });

  test('preserves the entry header and closing brace', () => {
    const r = filterBibtexFields(ENTRY, ['title']);
    expect(r).toContain('@article{key,');
    expect(r.trimEnd().endsWith('}')).toBe(true);
  });

  test('matches field names case-insensitively', () => {
    expect(filterBibtexFields('@a{k,\n  TITLE = {T}\n}', ['title']))
      .toContain('TITLE');
  });

  test('accepts a Set as well as an array', () => {
    expect(filterBibtexFields(ENTRY, new Set(['title']))).toContain('title');
  });

  test('collapses runs of blank lines', () => {
    expect(filterBibtexFields(ENTRY, ['title'])).not.toMatch(/\n{3,}/);
  });

  test('handles empty input', () => {
    expect(filterBibtexFields('', ['title'])).toBe('');
    expect(filterBibtexFields(null, ['title'])).toBe('');
  });
});

/*
 * Regression cover for field filtering across the layouts providers actually
 * return. The previous implementation scanned line by line, so any entry that
 * put more than one field on a line, which the DOI content-negotiation
 * service commonly does, came back unfiltered, and the feature looked broken.
 */
describe('filterBibtexFields across real-world layouts', () => {
  const keep = ['author', 'title', 'journal', 'year', 'doi'];
  const has = (out, field) => new RegExp(`\\b${field}\\s*=`, 'i').test(out);

  test('filters a conventional multi-line entry', () => {
    const bib = '@article{Ito_2020,\n\tdoi = {10.1107/x},\n\turl = {https://doi.org/x},\n' +
                '\tyear = 2020,\n\tauthor = {Hiroshi Ito},\n\ttitle = {A study}\n}';
    const out = filterBibtexFields(bib, keep);
    expect(has(out, 'url')).toBe(false);
    expect(has(out, 'title')).toBe(true);
    expect(has(out, 'doi')).toBe(true);
  });

  test('filters an entry returned entirely on one line', () => {
    const bib = '@article{Ito_2020, title={A study}, volume={27}, ISSN={1600-5775}, ' +
                'url={http://dx.doi.org/x}, DOI={10.1107/x}, author={Ito, Hiroshi}, year={2020} }';
    const out = filterBibtexFields(bib, keep);
    expect(has(out, 'url')).toBe(false);
    expect(has(out, 'issn')).toBe(false);
    expect(has(out, 'volume')).toBe(false);
    expect(has(out, 'title')).toBe(true);
    expect(has(out, 'author')).toBe(true);
  });

  test('filters when several fields share a line', () => {
    const bib = '@article{X,\n\tauthor = {A}, title = {T}, url = {http://x}\n}';
    const out = filterBibtexFields(bib, keep);
    expect(has(out, 'url')).toBe(false);
    expect(has(out, 'author')).toBe(true);
  });

  test('field names are matched case-insensitively', () => {
    const out = filterBibtexFields('@article{X, DOI={10.1/x}, URL={http://x}}', keep);
    expect(has(out, 'doi')).toBe(true);
    expect(has(out, 'url')).toBe(false);
  });

  test('nested braces in a kept value survive intact', () => {
    const out = filterBibtexFields('@article{X, title={A study of {NaCl} phases}, url={u}}', keep);
    expect(out).toContain('{NaCl}');
    expect(has(out, 'url')).toBe(false);
  });

  test('quoted values are handled like braced ones', () => {
    const out = filterBibtexFields('@article{X, title="A study", url="http://x", author="B"}', keep);
    expect(has(out, 'title')).toBe(true);
    expect(has(out, 'url')).toBe(false);
  });

  test('bare values such as year and month are handled', () => {
    const out = filterBibtexFields('@article{X,\n year = 2020,\n month = jul,\n title = {T}\n}',
      ['year', 'title']);
    expect(out).toMatch(/year\s*=\s*2020/);
    expect(has(out, 'month')).toBe(false);
  });

  test('a multi-line value is dropped in full, not partially', () => {
    const bib = '@article{X,\n\tauthor = {A},\n\tabstract = {Line one\n\tline two},\n\ttitle = {T}\n}';
    const out = filterBibtexFields(bib, keep);
    expect(out).not.toMatch(/line two/i);
    expect(has(out, 'abstract')).toBe(false);
  });

  test('every entry in a multi-entry document is filtered', () => {
    const out = filterBibtexFields('@article{A, title={T1}, url={u}}\n\n@book{B, title={T2}, isbn={9}}', keep);
    expect(has(out, 'url')).toBe(false);
    expect(has(out, 'isbn')).toBe(false);
    expect(out).toContain('T1');
    expect(out).toContain('T2');
    expect(out).toContain('@book{B');
  });

  test('the entry type and citation key are preserved', () => {
    const out = filterBibtexFields('@inproceedings{Smith_2024, title={T}, url={u}}', keep);
    expect(out).toContain('@inproceedings{Smith_2024');
  });

  test('keeping nothing still yields a well-formed entry', () => {
    const out = filterBibtexFields('@article{X, title={T}, url={u}}', []);
    expect(out).toBe('@article{X\n}');
  });

  test('accepts a Set as well as an array', () => {
    const out = filterBibtexFields('@article{X, title={T}, url={u}}', new Set(['title']));
    expect(has(out, 'title')).toBe(true);
    expect(has(out, 'url')).toBe(false);
  });

  test('handles empty and malformed input without throwing', () => {
    expect(filterBibtexFields('', keep)).toBe('');
    expect(filterBibtexFields(null, keep)).toBe('');
    expect(() => filterBibtexFields('@article{X, title={unclosed', keep)).not.toThrow();
  });
});
