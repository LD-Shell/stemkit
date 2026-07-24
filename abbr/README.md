# ISO 4 word list (LTWA)

`abbreviation.csv` in this folder is the ISSN **List of Title Word
Abbreviations**, the data behind ISO 4. The Journal Abbreviator loads it at
runtime to abbreviate titles the built-in dictionary does not know.

Source: <https://portal.issn.org/ltwa>. The ISSN International Centre publishes
it under its own terms, so check those before redistributing this repository,
and re-download periodically — the list is revised roughly annually.

## How the two tiers fit together

1. **Dictionary** — `js/journal-data.js` maps ~200 whole journal titles to
   whole abbreviations. Exact and authoritative, but only covers titles someone
   has entered.
2. **ISO 4** — this file maps individual title *words* (mostly stems) to
   abbreviations, so any title can be abbreviated by rule.

Tier 1 runs first; whatever it does not recognise goes to tier 2. Delete this
file and the tool still works, simply reporting those titles as unknown. The
load is asynchronous, so it never blocks first paint.

## Format as actually published

The download differs from the prose documentation in several ways, all of which
the loader handles:

    WORD,ABBREVIATION,LANGUAGES
    Aabenraa,,Danish
    Aachener,Aachen.,German
    abdominal,abdom.,"English, French"
    biolog-,biol.,Multiple languages

- It is **comma**-separated despite ISO 4 write-ups describing tabs.
- "Not abbreviated" is an **empty abbreviation column**, not the literal
  `n.a.` that some documentation mentions. About a third of the 56,519 rows are
  of this kind — mostly proper nouns and place names.
- Languages are **spelled out in English** ("German", "French"), not ISO 639
  codes, and multilingual rules say **"Multiple languages"**, not `mul`.
- Cells listing several languages are quoted, because they contain commas.
  Some carry a qualifier, e.g. `"Greek, Modern (1453- )"`.

The loader sniffs the delimiter, handles quoting and a byte-order mark, skips
the header, normalises language tags (so `eng`, `en` and `English` all work),
and counts malformed rows instead of throwing.

Word patterns use hyphens to mark where a rule may extend:

| Pattern    | Meaning | Matches |
|------------|---------|---------|
| `journal`  | exact   | *journal* only, not *journalism* |
| `chemi-`   | stem    | *chemical*, *chemistry* |
| `-ologie`  | ending  | *radiologie* |
| `-graph-`  | inside  | *bibliographical* |

## Do not filter by language

`buildIso4Engine` accepts a `languages` option, but leaving it unset — which is
the default — gives better results, and the reason is worth knowing.

LTWA tags a word with the languages in which that spelling occurs, and the
tagging is uneven. Restricting to English drops rules that English titles
genuinely need, and it breaks any title that is not English. Measured against
the real list:

- *Journal of Molecular Biology* → `J. Mol. Biol.` unfiltered, but
  `J. Mol. Biology` when restricted to English.
- *Angewandte Chemie International Edition* → `Angew. Chem. Int. Ed.`
  unfiltered, but largely unabbreviated when restricted to English.

The option exists for callers who know they want it. The tool does not use it.

## Known limit

ISO 4 expects a cataloguer not to abbreviate personal or place names, and
nothing in the data marks which entries are names. The list mitigates this by
leaving most proper nouns unabbreviated, but a surname that coincides with an
ordinary stem will still be abbreviated. Treat tier-2 output as a good draft
rather than a citation-ready answer — every substitution is reported so the
result can be checked.
