# ISO 4 word list (LTWA)

`abbreviation.csv` in this folder is the ISSN **List of Title Word
Abbreviations**, the data behind ISO 4. The Journal Abbreviator loads it at
runtime to abbreviate titles the built-in dictionary does not know.

Source: <https://portal.issn.org/ltwa>. The rules that use it are those of
ISO 4:1997, *Rules for the abbreviation of title words and titles of
publications*; clause numbers below refer to it.

## How the two tiers fit together

1. **Dictionary** — `js/journal-data.js` maps ~200 whole journal titles to
   whole abbreviations. Exact and authoritative, but only covers titles entered.
2. **ISO 4** — this file maps individual title *words* (mostly stems) to
   abbreviations, so any title can be abbreviated by rule.

Tier 1 runs first; whatever it does not recognise goes to tier 2. Delete this
file and the tool still works, simply reporting those titles as unknown. The
load is asynchronous, so it never blocks first paint.

The page marks the two apart. A dictionary result is filled in blue; a
rule-based one has a dashed underline and an **ISO 4** tag, because it is the
standard's answer rather than the journal's registered abbreviation, and the
two can differ (see *Agreement with the dictionary* below).

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

## Reading a row

Word patterns use hyphens to mark where a rule may extend:

| Pattern       | Meaning | Example |
|---------------|---------|---------|
| `journal`     | word    | *journal*, and its plural *journals*, not *journalism* |
| `chemi-`      | stem    | *chemical*, *chemistry* |
| `-forschung`  | final component of a compound | *Naturforschung* → *Natur* + *forsch.* |
| `-graph-`     | inner component | *Bibliographical* → *Biblio* + *gr.* |

The hyphen in front of a component's abbreviation (`-forschung` → `-forsch.`)
stands for the part of the word before the component, which is kept. It is
never printed: that is what used to turn *Zeitschrift für Naturforschung* into
`Z. -forsch.` and *Phase Transitions* into `-ph. Transitions`. A component row
only applies inside a compound, so it never matches the bare component
(*Phase* is not `-phas-`), and the head must be at least four letters
(*Southampton* → *Southampt.*, the 3.10 example, but *Dalton* is a name, not
*Dal* + `-ton`).

Other shapes in the real file, all handled:

- **Phrases**: `United States of America` → `U. S. A.`, `Los alamos` (kept in
  full, so its article is not dropped).
- **Sense notes**: `Band (book)`, `real (royal)` / `real (actual)`. The note is
  not part of the word; when two senses disagree, the word is left in full.
- **Optional letters**: `Wachst(h)um` is both *Wachstum* and *Wachsthum*.
- **Ligatures**: `œcolog-` also matches *Oecologica*.
- **Typos in the abbreviation column**, such as `tom. .`, `confinam-` or a
  missing full stop, are repaired; an "abbreviation" equal to the word means
  not abbreviated.

## Rules applied

Word rules:

- At least two letters must be dropped, or the word stays in full (3.1):
  *Alloys* is not *Alloy.*
- Diacritics are kept as the title writes them, and a title written without
  them still matches (3.2): *Electronic* matches `electróni-` → *Electron.*
  A row spelled exactly like the word wins over one that matches only once
  accents are ignored (*Botanica* is `botan-`, not Spanish `botánica`).
- Plurals and other inflected forms take the singular's abbreviation when its
  letters are all in the inflected word (3.4): *Reports* → *Rep.*,
  *Equilibria* → *Equilib.*
- Compounds (3.7): hyphenated ones are abbreviated part by part and keep their
  hyphens; a closed compound with no row of its own is read as a combining form
  kept in full plus a word the list knows (*Electrochimica* → *Electrochim.*,
  *Bioorganic* → *Bioorg.*).
- Artificial words keep their form (3.3): *CrystEngComm*, *eLife*.
- Every output letter is copied from the title (3.12), so the title's
  capitalisation is kept (4.5).

Title rules:

- A one-word title is not abbreviated (4.2), counting neither articles nor
  designators: *The Magistrate* → *Magistrate*, *Physica A* stays.
- Articles, conjunctions and prepositions are dropped, except a preposition
  that opens the title, a locution such as *in vivo*, and words inside a phrase
  the list knows (4.3).
- Acronyms, section letters, numbers and roman numerals are kept (4.4, 4.8):
  *Journal of Physics A* → *J. Phys. A*, *Section B* → *Sect. B*. A word
  spelled like a function word is kept when it closes the title or a section,
  since an article or preposition cannot (*JACS Au*, *Physical Review E*).
- Commas are dropped, a full stop between title parts becomes a comma, and
  "&" or "+" for "and" goes (4.6, 4.7): *Journal of botany. Section A* →
  *J. bot., Sect. A*.

The engine's header comment in `src/core/iso4.js` has the details, and
`tests/iso4.test.js` checks the examples printed in the standard.

## Agreement with the dictionary

The dictionary holds official abbreviations, so it is the yardstick. Of its
184 titles that are actually abbreviated, the rules alone reproduced 150 before
the October 2026 fixes and reproduce **169** now; `tests/iso4.test.js` fails if
that number drops. The other 15 are places where the registered abbreviation
departs from ISO 4 on purpose, and they are listed in the test rather than
special-cased:

- CASSI keeps a word the LTWA abbreviates: *ACS Sustainable Chem. Eng.*
  (ISO 4: *Sustain.*), *Int. J. Hydrogen Energy* (*Hydrog.*),
  *Int. J. Heat Mass Transfer* (*Transf.*), *Bioconjugate Chem.*
  (*Bioconjug.*, as NLM has it).
- The LTWA lists *Cheminformatics* as not abbreviated; CASSI writes
  *J. Cheminf.*
- CASSI adds a comma before a section letter or edition statement where the
  title has no full stop to turn into one: *J. Vac. Sci. Technol., A*,
  *Angew. Chem., Int. Ed.*, *Nucl. Instrum. Methods Phys. Res., Sect. A*.
- CASSI also drops the section title, which ISO 4 keeps:
  *Appl. Catal., A* and *B*, *Colloids Surf., A*, *Spectrochim. Acta, Part A*,
  *Sens. Actuators, B* (ISO 4: *Appl. Catal. A: Gen.* and so on).
- The LTWA spaces initials (*U. S. A.*) where PNAS writes *U.S.A.*, and the
  dictionary maps the short name *Proceedings of the National Academy of
  Sciences* to the full title's abbreviation, whose *U.S.A.* is not in it.

## Do not filter by language

`buildIso4Engine` accepts a `languages` option, but leaving it unset — which is
the default — gives better results, and the reason is worth knowing.

LTWA tags a word with the languages in which that spelling occurs, and the
tagging is uneven. Rules tagged "Multiple languages" apply under any filter, so
English titles mostly come out the same, but any title that is not English
breaks. Measured against the real list:

- *Angewandte Chemie International Edition* → `Angew. Chem. Int. Ed.`
  unfiltered, but `Angewandte Chemie Int. Ed.` when restricted to English.
- *Annalen der Physik* → `Ann. Phys.` unfiltered, but `Ann. Physik` when
  restricted to English.

The option exists for callers who know they want it. The tool does not use it.

## Known limits

ISO 4 expects a cataloguer not to abbreviate personal or place names (3.8),
and nothing in the data marks which entries are names. The list mitigates this
by leaving most proper nouns unabbreviated, and component rows need a real
head, but a surname that coincides with an ordinary stem will still be
abbreviated. A few common words are missing from the list altogether
(*Zhurnal*, *Comptes Rendus*), so they stay in full. Treat tier-2 output as a
good draft rather than a citation-ready answer: every substitution is reported
and tagged so the result can be checked.
