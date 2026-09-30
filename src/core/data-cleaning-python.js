/**
 * @module core/data-cleaning-python
 *
 * The Data Cleaner's recipe as a pandas script.
 *
 * `generateCleaningScript` writes a Python file that reads the same data,
 * applies the same steps in the same order and writes the same CSV the page
 * downloads, cell for cell. Each step is a short, commented block; the few
 * helpers it needs are defined once, and only the ones the recipe uses are
 * included. The rules each helper follows are the ones core/data-cleaning.js
 * documents under "Recipes", and tests/data-cleaning-python.test.js runs the
 * scripts with pandas to check them.
 *
 * Two forms: a plain script that runs top to bottom, and a module with a
 * reusable `clean(df)` function and a `__main__` block. The data are read
 * from the file by name, or embedded in the script.
 */

import {
  SPACE_CHARACTERS, describeStep, checkRecipe, normaliseStep, stripSpaces
} from './data-cleaning.js';

/* ------------------------------------------------------------------ *
 * Python literals
 * ------------------------------------------------------------------ */

const hex = (c, width) => c.toString(16).padStart(width, '0');

function escapeChar(ch) {
  const c = ch.codePointAt(0);
  if (c <= 0xff) return `\\x${hex(c, 2)}`;
  if (c <= 0xffff) return `\\u${hex(c, 4)}`;
  return `\\U${hex(c, 8)}`;
}

// Characters kept out of the source as they are: controls, format
// characters, line and paragraph separators, and spaces other than ' '.
const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Zs}\p{Cs}]/u;

/**
 * A Python string literal in double quotes.
 *
 * @param {string} s
 * @returns {string}
 */
export function pyString(s) {
  let out = '"';
  for (const ch of String(s)) {
    if (ch === '\\') out += '\\\\';
    else if (ch === '"') out += '\\"';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (ch !== ' ' && HIDDEN.test(ch)) out += escapeChar(ch);
    else out += ch;
  }
  return out + '"';
}

/**
 * A Python float literal that reads back as the same double.
 *
 * @param {number} x
 * @returns {string}
 */
export function pyFloat(x) {
  if (Number.isNaN(x)) return 'np.nan';
  if (x === Infinity) return 'math.inf';
  if (x === -Infinity) return '-math.inf';
  const s = String(x);
  return /^-?\d+$/.test(s) ? `${s}.0` : s;
}

/** A cell value as Python: a float, a str, or np.nan for a missing value. */
function pyValue(v) {
  if (v === null || v === undefined) return 'np.nan';
  return typeof v === 'number' ? pyFloat(v) : pyString(v);
}

const pyList = (names) => `[${names.map(pyString).join(', ')}]`;

/**
 * Text as the body of a triple-quoted Python string, starting with a line
 * continuation so the string begins on the next line.
 *
 * @param {string} text  with \n line ends
 * @returns {string}
 */
export function pyTripleQuoted(text) {
  let out = '"""\\\n';
  let quotes = 0;
  for (const ch of String(text)) {
    if (ch === '"') {
      if (quotes === 2) { out += '\\"'; quotes = 0; } else { out += ch; quotes++; }
      continue;
    }
    quotes = 0;
    if (ch === '\\') out += '\\\\';
    else if (ch === '\n' || ch === '\t') out += ch;
    else if (HIDDEN.test(ch) && ch !== ' ') out += escapeChar(ch);
    else out += ch;
  }
  if (out.endsWith('"') && !out.endsWith('\\"')) out = `${out.slice(0, -1)}\\"`;
  return `${out}"""`;
}

/** Text safe for a comment or docstring line: no line breaks, no hidden characters. */
function plain(s) {
  let out = '';
  for (const ch of String(s)) {
    if (ch === '\n') out += '\\n';
    else if (ch === '\t') out += '\\t';
    else if (ch !== ' ' && HIDDEN.test(ch)) out += escapeChar(ch);
    else out += ch;
  }
  return out;
}

/** Text for a docstring: plain, with backslashes and runs of quotes defused. */
function docText(s) {
  return plain(s).replace(/\\/g, '\\\\').replace(/"""/g, '""\\"');
}

/* ------------------------------------------------------------------ *
 * Helpers the script may need
 * ------------------------------------------------------------------ */

const SPACES_LITERAL = pyString(SPACE_CHARACTERS);

// Each helper: the imports it needs, the helpers it calls, and its code.
const HELPERS = {
  SPACES: {
    code: [
      '# The characters JavaScript\'s trim() removes, which the page counts as spaces',
      '# (Python\'s own strip() uses a slightly different set).',
      `SPACES = ${SPACES_LITERAL}`
    ]
  },
  cell: {
    imports: ['math', 're', 'numpy'],
    code: [
      '# A number is ASCII digits with an optional sign, one decimal separator and an',
      '# exponent, with spaces or tabs around it.',
      'NUMBER = {',
      '    ".": re.compile(r"[ \\t]*[-+]?([0-9]+\\.?[0-9]*|\\.[0-9]+)([eE][-+]?[0-9]+)?[ \\t]*"),',
      '    ",": re.compile(r"[ \\t]*[-+]?([0-9]+,?[0-9]*|,[0-9]+)([eE][-+]?[0-9]+)?[ \\t]*"),',
      '}',
      'WHOLE_NUMBER = re.compile(r"[ \\t]*[-+]?[0-9]+[ \\t]*")',
      '',
      '',
      'def cell(text, decimal="."):',
      '    """A cell as the page reads it: a number, NaN when empty, or the text unchanged."""',
      '    if text == "":',
      '        return np.nan',
      '    if NUMBER[decimal].fullmatch(text):',
      '        value = float(text.replace(decimal, "."))',
      '        # Whole numbers from 2**53 up would lose digits as floats, so they stay text.',
      '        if math.isfinite(value) and not (WHOLE_NUMBER.fullmatch(text) and abs(value) >= 2 ** 53):',
      '            return value',
      '    return text'
    ]
  },
  column_names: {
    needs: ['SPACES'],
    code: [
      'def column_names(cells, width):',
      '    """Header names trimmed; an empty one becomes column_<n> and a repeat gets _2, _3."""',
      '    names = []',
      '    for i in range(width):',
      '        base = (cells[i] if i < len(cells) else "").strip(SPACES) or f"column_{i + 1}"',
      '        name, k = base, 2',
      '        while name in names:',
      '            name, k = f"{base}_{k}", k + 1',
      '        names.append(name)',
      '    return names'
    ]
  },
  read_table: {
    imports: ['csv', 'pandas'],
    needs: ['cell', 'column_names'],
    code: [
      'def read_table(lines, sep=",", decimal=".", header=True):',
      '    """Read delimited text as the Data Cleaner does.',
      '',
      '    Each cell becomes a number, NaN when it is empty, or stays text, so a column',
      '    can hold both. Blank lines are skipped and short rows padded with NaN.',
      '    """',
      '    rows = [row for row in csv.reader(lines, delimiter=sep) if row]',
      '    width = max((len(row) for row in rows), default=0)',
      '    names = column_names(rows[0] if header and rows else [], width)',
      '    body = rows[1:] if header else rows',
      '    data = [[cell(row[i] if i < len(row) else "", decimal) for i in range(width)] for row in body]',
      '    return pd.DataFrame(data, columns=names)'
    ]
  },
  number_text: {
    imports: ['decimal'],
    code: [
      'def number_text(x):',
      '    """A number as the page writes it (JavaScript\'s rules): 298, 0.12, 1e-7, 1e+21."""',
      '    if x == 0:',
      '        return "0"',
      '    sign, digits, exponent = Decimal(repr(float(x))).normalize().as_tuple()',
      '    digits = "".join(map(str, digits))',
      '    point = len(digits) + exponent',
      '    if len(digits) <= point <= 21:',
      '        text = digits + "0" * (point - len(digits))',
      '    elif 0 < point <= 21:',
      '        text = digits[:point] + "." + digits[point:]',
      '    elif -6 < point <= 0:',
      '        text = "0." + "0" * -point + digits',
      '    else:',
      '        text = digits[0] + ("." + digits[1:] if len(digits) > 1 else "") + f"e{point - 1:+d}"',
      '    return "-" + text if sign else text'
    ]
  },
  text_of: {
    imports: ['pandas'],
    needs: ['number_text'],
    code: [
      'def text_of(value):',
      '    """A cell as the page shows and writes it: text as it is, numbers by number_text, NaN as ""."""',
      '    if isinstance(value, str):',
      '        return value',
      '    if pd.isna(value):',
      '        return ""',
      '    return number_text(value)'
    ]
  },
  write_table: {
    imports: ['pandas'],
    needs: ['text_of'],
    code: [
      'def write_table(df, path):',
      '    """Write the table as the CSV the page downloads."""',
      '    text = pd.DataFrame({name: df[name].map(text_of) for name in df.columns})',
      '    text.to_csv(path, index=False)'
    ]
  },
  report: {
    code: [
      'def report(label, df):',
      '    print(f"{label}: {len(df)} rows, {len(df.columns)} columns")'
    ]
  },
  is_number: {
    imports: ['math', 'numpy'],
    code: [
      'def is_number(value):',
      '    """True for a finite number; False for text and for NaN, the missing value."""',
      '    return isinstance(value, (int, float, np.number)) and not isinstance(value, bool) and math.isfinite(value)'
    ]
  },
  numeric_values: {
    needs: ['is_number'],
    code: [
      'def numeric_values(series):',
      '    """The numbers in a column, leaving out text and missing values."""',
      '    return [float(v) for v in series if is_number(v)]'
    ]
  },
  on_text: {
    imports: ['numpy'],
    code: [
      'def on_text(series, change):',
      '    """Apply `change` to each text cell; numbers and gaps are left alone, empty text becomes NaN."""',
      '    def one(value):',
      '        if isinstance(value, str):',
      '            value = change(value)',
      '            return np.nan if value == "" else value',
      '        return value',
      '    return series.map(one)'
    ]
  },
  on_numbers: {
    imports: ['numpy'],
    needs: ['is_number'],
    code: [
      'def on_numbers(series, change):',
      '    """Apply `change` to each number; text and gaps are left alone, a non-finite result becomes NaN."""',
      '    def one(value):',
      '        if is_number(value):',
      '            value = change(value)',
      '            return value if is_number(value) else np.nan',
      '        return value',
      '    return series.map(one)'
    ]
  },
  mean: {
    imports: ['math'],
    code: [
      'def mean(values):',
      '    """The mean with an exact sum (math.fsum), as the page computes it; None for no values."""',
      '    return math.fsum(values) / len(values) if values else None'
    ]
  },
  median: {
    imports: ['statistics'],
    code: [
      'def median(values):',
      '    return statistics.median(values) if values else None'
    ]
  },
  fill_gaps: {
    imports: ['pandas'],
    code: [
      'def fill_gaps(series, value):',
      '    """Put `value` in every gap; None leaves the gaps as they are."""',
      '    if value is None:',
      '        return series',
      '    return series.map(lambda v: value if pd.isna(v) else v)'
    ]
  },
  fill_down: {
    imports: ['numpy', 'pandas'],
    code: [
      'def fill_down(series):',
      '    """Fill each gap with the nearest value above it."""',
      '    out, last = [], np.nan',
      '    for value in series:',
      '        if pd.isna(value):',
      '            out.append(last)',
      '        else:',
      '            out.append(value)',
      '            last = value',
      '    return pd.Series(out, index=series.index)'
    ]
  },
  keep_rows: {
    imports: ['numpy'],
    code: [
      'def keep_rows(df, column, test):',
      '    """The rows whose value in `column` passes `test`."""',
      '    return df.loc[np.array([bool(test(v)) for v in df[column]], dtype=bool)]'
    ]
  },
  sort_rows: {
    imports: ['pandas'],
    needs: ['is_number'],
    code: [
      'def sort_rows(df, column, descending=False):',
      '    """A stable sort: numbers by value, then text ignoring case; gaps stay last."""',
      '    values = list(df[column])',
      '',
      '    def key(i):',
      '        value = values[i]',
      '        return (0, value, "") if is_number(value) else (1, 0, str(value).lower())',
      '',
      '    present = [i for i, v in enumerate(values) if not pd.isna(v)]',
      '    gaps = [i for i, v in enumerate(values) if pd.isna(v)]',
      '    return df.iloc[sorted(present, key=key, reverse=descending) + gaps]'
    ]
  },
  trim: {
    needs: ['SPACES'],
    code: [
      'def trim(text):',
      '    return text.strip(SPACES)'
    ]
  },
  tidy_spaces: {
    imports: ['re'],
    needs: ['SPACES'],
    code: [
      'SPACE_RUN = re.compile("[" + SPACES + "]+")',
      '',
      '',
      'def tidy_spaces(text):',
      '    """Trim the ends and turn each run of spaces, tabs or line breaks into one space."""',
      '    return SPACE_RUN.sub(" ", text).strip(SPACES)'
    ]
  },
  title_case: {
    imports: ['re'],
    needs: ['SPACES'],
    code: [
      'WORD = re.compile(r"\\w[^" + SPACES + "]*")',
      '',
      '',
      'def title_case(text):',
      '    """Upper-case the first letter or digit of each word and lower-case the rest."""',
      '    return WORD.sub(lambda m: m[0][0].upper() + m[0][1:].lower(), text)'
    ]
  },
  to_number: {
    imports: ['numpy'],
    needs: ['cell', 'SPACES'],
    code: [
      'def to_number(text, decimal=".", keep_text=False):',
      '    """The number written in `text` (spaces around it ignored); other text becomes NaN."""',
      '    value = cell(text.strip(SPACES), decimal)',
      '    if isinstance(value, str):',
      '        return text if keep_text else np.nan',
      '    return value'
    ]
  },
  round_to: {
    imports: ['decimal'],
    code: [
      'def round_to(x, digits, significant=False, ties=ROUND_HALF_UP):',
      '    """Round x as it is written, so 2.675 becomes 2.68 (float round() gives 2.67).',
      '',
      '    To `digits` decimal places, or significant figures; ties go away from zero',
      '    (ROUND_HALF_UP) or to the even digit (ROUND_HALF_EVEN).',
      '    """',
      '    d = Decimal(repr(float(x)))',
      '    if d == 0:',
      '        return x',
      '    exponent = d.adjusted() - digits + 1 if significant else -digits',
      '    if exponent <= d.as_tuple().exponent:',
      '        return x',
      '    return float(d.quantize(Decimal(1).scaleb(exponent), rounding=ties))'
    ]
  },
  PRECISE: {
    imports: ['decimal'],
    code: [
      '# Logarithms are worked out to 50 digits and then rounded once, so they come out',
      '# correctly rounded, the same on every machine and the same as on the page',
      '# (math.log can differ in the last digit from one C library to another).',
      'PRECISE = Context(prec=50)'
    ]
  },
  log10: {
    imports: ['decimal'],
    needs: ['PRECISE'],
    code: [
      'def log10(x):',
      '    return float(Decimal(x).log10(PRECISE))'
    ]
  },
  ln: {
    imports: ['decimal'],
    needs: ['PRECISE'],
    code: [
      'def ln(x):',
      '    return float(Decimal(x).ln(PRECISE))'
    ]
  },
  min_max: {
    needs: ['numeric_values', 'on_numbers'],
    code: [
      'def min_max(series):',
      '    """(x - min) / (max - min) for each number; a column with one value becomes 0."""',
      '    values = numeric_values(series)',
      '    if not values:',
      '        return series',
      '    low, high = min(values), max(values)',
      '    return on_numbers(series, lambda x: (x - low) / (high - low) if high != low else 0.0)'
    ]
  },
  z_score: {
    imports: ['math'],
    needs: ['numeric_values', 'on_numbers', 'mean'],
    code: [
      'def z_score(series):',
      '    """(x - mean) / SD, with the population SD (divide by n), as scikit-learn\'s StandardScaler."""',
      '    values = numeric_values(series)',
      '    if not values:',
      '        return series',
      '    m = mean(values)',
      '    sd = math.sqrt(math.fsum((x - m) * (x - m) for x in values) / len(values))',
      '    return on_numbers(series, lambda x: (x - m) / sd if sd != 0 else 0.0)'
    ]
  }
};

// The order helpers appear in the script: reading and writing first.
const HELPER_ORDER = ['SPACES', 'cell', 'column_names', 'read_table', 'number_text', 'text_of', 'write_table', 'report',
  'is_number', 'numeric_values', 'on_text', 'on_numbers', 'mean', 'median', 'fill_gaps', 'fill_down', 'keep_rows',
  'sort_rows', 'trim', 'tidy_spaces', 'title_case', 'to_number', 'round_to', 'PRECISE', 'log10', 'ln', 'min_max', 'z_score'];

/* ------------------------------------------------------------------ *
 * Steps as pandas
 * ------------------------------------------------------------------ */

/** Code that sets each target column to `rhs(columnExpression)`. */
function perColumn(columns, rhs) {
  if (!columns.length) return ['for column in df.columns:', `    df[column] = ${rhs('df[column]')}`];
  if (columns.length === 1) {
    const c = `df[${pyString(columns[0])}]`;
    return [`${c} = ${rhs(c)}`];
  }
  return [`for column in ${pyList(columns)}:`, `    df[column] = ${rhs('df[column]')}`];
}

const FILTER_PY = {
  gt: '>', gte: '>=', lt: '<', lte: '<='
};

/**
 * One step as Python: an explanatory note (or null), the code lines and the
 * helpers they call.
 *
 * @param {object} step  a normalised step
 * @returns {{note:string|null, code:string[], helpers:string[]}}
 */
export function stepToPython(step) {
  const cols = step.columns || [];
  const col = step.column !== undefined ? pyString(step.column) : '';
  switch (step.type) {
    case 'dropMissing':
      return {
        note: null,
        code: [cols.length ? `df = df.dropna(subset=${pyList(cols)})` : 'df = df.dropna()'],
        helpers: []
      };
    case 'dedupe':
      return {
        note: 'The first of each set of repeated rows stays.',
        code: [cols.length ? `df = df.drop_duplicates(subset=${pyList(cols)})` : 'df = df.drop_duplicates()'],
        helpers: []
      };
    case 'filter': {
      const v = step.value;
      switch (step.op) {
        case 'eq':
        case 'ne':
          return {
            note: typeof v === 'number' ? 'Numbers compare by value; text never equals a number.' : 'Text compares exactly, including case.',
            code: [`df = keep_rows(df, ${col}, lambda v: v ${step.op === 'eq' ? '==' : '!='} ${pyValue(v)})`],
            helpers: ['keep_rows']
          };
        case 'gt':
        case 'gte':
        case 'lt':
        case 'lte':
          return {
            note: 'Only numbers can pass; text and missing values are dropped.',
            code: [`df = keep_rows(df, ${col}, lambda v: is_number(v) and v ${FILTER_PY[step.op]} ${pyFloat(v)})`],
            helpers: ['keep_rows', 'is_number']
          };
        case 'contains':
        case 'notContains':
          return {
            note: 'Ignoring case; numbers are matched as the page writes them.',
            code: [`df = keep_rows(df, ${col}, lambda v: ${pyString(String(v).toLowerCase())} ${step.op === 'contains' ? 'in' : 'not in'} text_of(v).lower())`],
            helpers: ['keep_rows', 'text_of']
          };
        case 'missing':
          return { note: null, code: [`df = keep_rows(df, ${col}, pd.isna)`], helpers: ['keep_rows'] };
        default:
          return { note: null, code: [`df = keep_rows(df, ${col}, pd.notna)`], helpers: ['keep_rows'] };
      }
    }
    case 'sort':
      return {
        note: 'Numbers come before text, text ignores case, missing values go last and ties keep their order.',
        code: [`df = sort_rows(df, ${col}${step.descending ? ', descending=True' : ''})`],
        helpers: ['sort_rows']
      };
    case 'fill':
      switch (step.method) {
        case 'mean':
          return {
            note: 'The mean of the numbers in each column; a column with no numbers is left as it is.',
            code: perColumn(cols, c => `fill_gaps(${c}, mean(numeric_values(${c})))`),
            helpers: ['fill_gaps', 'mean', 'numeric_values']
          };
        case 'median':
          return {
            note: 'The median of the numbers in each column; a column with no numbers is left as it is.',
            code: perColumn(cols, c => `fill_gaps(${c}, median(numeric_values(${c})))`),
            helpers: ['fill_gaps', 'median', 'numeric_values']
          };
        case 'previous':
          return {
            note: 'Gaps at the top of a column stay empty.',
            code: perColumn(cols, c => `fill_down(${c})`),
            helpers: ['fill_down']
          };
        default:
          return { note: null, code: perColumn(cols, c => `fill_gaps(${c}, ${pyValue(step.value)})`), helpers: ['fill_gaps'] };
      }
    case 'replace':
      if (step.whole) {
        return {
          note: 'Whole cells only.',
          code: perColumn(cols, c => `${c}.map(lambda v: ${pyValue(step.with)} if v == ${pyValue(step.find)} else v)`),
          helpers: []
        };
      }
      return {
        note: 'Inside text cells, every occurrence, matching case; text left empty becomes missing.',
        code: perColumn(cols, c => `on_text(${c}, lambda s: s.replace(${pyString(step.find)}, ${pyString(step.with)}))`),
        helpers: ['on_text']
      };
    case 'trim':
      return {
        note: step.collapse ? null : 'Text left empty becomes missing.',
        code: perColumn(cols, c => `on_text(${c}, ${step.collapse ? 'tidy_spaces' : 'trim'})`),
        helpers: ['on_text', step.collapse ? 'tidy_spaces' : 'trim']
      };
    case 'case': {
      const fn = step.mode === 'upper' ? 'str.upper' : step.mode === 'lower' ? 'str.lower' : 'title_case';
      return {
        note: null,
        code: perColumn(cols, c => `on_text(${c}, ${fn})`),
        helpers: ['on_text', ...(step.mode === 'title' ? ['title_case'] : [])]
      };
    }
    case 'toNumber': {
      const args = [];
      if (step.decimal === ',') args.push('decimal=","');
      if (step.invalid === 'keep') args.push('keep_text=True');
      const fn = args.length ? `lambda s: to_number(s, ${args.join(', ')})` : 'to_number';
      return {
        note: step.invalid === 'keep' ? 'Text that is not a number stays as it is.' : 'Text that is not a number becomes missing.',
        code: perColumn(cols, c => `on_text(${c}, ${fn})`),
        helpers: ['on_text', 'to_number']
      };
    }
    case 'round': {
      const args = [String(step.digits)];
      if (step.significant) args.push('significant=True');
      if (step.ties === 'even') args.push('ties=ROUND_HALF_EVEN');
      return {
        note: step.ties === 'even' ? 'Ties go to the even digit.' : 'Ties go away from zero.',
        code: perColumn(cols, c => `on_numbers(${c}, lambda x: round_to(x, ${args.join(', ')}))`),
        helpers: ['on_numbers', 'round_to']
      };
    }
    case 'transform':
      switch (step.operation) {
        case 'log10':
        case 'ln':
          return {
            note: 'Zero and negative values have no logarithm and become missing.',
            code: perColumn(cols, c => `on_numbers(${c}, lambda x: ${step.operation}(x) if x > 0 else np.nan)`),
            helpers: ['on_numbers', step.operation]
          };
        case 'abs':
          return { note: null, code: perColumn(cols, c => `on_numbers(${c}, abs)`), helpers: ['on_numbers'] };
        case 'minmax':
          return { note: '(x - min) / (max - min), over the numbers in each column.', code: perColumn(cols, c => `min_max(${c})`), helpers: ['min_max'] };
        case 'zscore':
          return { note: '(x - mean) / SD, with the population SD (divide by n).', code: perColumn(cols, c => `z_score(${c})`), helpers: ['z_score'] };
        case 'multiply':
          return { note: null, code: perColumn(cols, c => `on_numbers(${c}, lambda x: x * ${pyFloat(step.value)})`), helpers: ['on_numbers'] };
        default: {
          const v = step.value;
          const expr = v < 0 ? `x - ${pyFloat(-v)}` : `x + ${pyFloat(v)}`;
          return { note: null, code: perColumn(cols, c => `on_numbers(${c}, lambda x: ${expr})`), helpers: ['on_numbers'] };
        }
      }
    case 'rename':
      return {
        note: null,
        code: [`df = df.rename(columns={${col}: ${pyString(stripSpaces(step.to))}})`],
        helpers: []
      };
    case 'dropColumns':
      return { note: null, code: [`df = df.drop(columns=${pyList(cols)})`], helpers: [] };
    default:
      return { note: null, code: [], helpers: [] };
  }
}

/* ------------------------------------------------------------------ *
 * The script
 * ------------------------------------------------------------------ */

const ENCODINGS = {
  'utf-8': 'utf-8-sig',
  'windows-1252': 'cp1252',
  'utf-16le': 'utf-16',
  'utf-16be': 'utf-16'
};

/**
 * The file name the Data Cleaner suggests for the script and the output.
 *
 * @param {string} fileName  the data file's name
 * @returns {{script:string, output:string, stem:string}}
 */
export function cleaningFileNames(fileName) {
  const base = String(fileName || 'data.csv').split(/[\\/]/).pop();
  const stem = base.replace(/\.[^.]+$/, '') || 'data';
  const safe = stem.replace(/[^\p{L}\p{N}_]+/gu, '_').replace(/^_+|_+$/g, '') || 'data';
  const module = /^\p{N}/u.test(safe) ? `data_${safe}` : safe;
  return { stem, script: `clean_${module}.py`, output: `${stem}_cleaned.csv` };
}

/**
 * Write the recipe as a pandas script.
 *
 * @param {object} spec
 * @param {object[]} spec.steps          the recipe
 * @param {string[]} spec.columns        the columns of the table as read
 * @param {object}   spec.source         {fileName, delimiter, decimal, header, encoding}
 * @param {'script'|'function'} [spec.form='script']
 * @param {'file'|'embed'} [spec.data='file']
 * @param {string}   [spec.text]         the file's text, for data: 'embed'
 * @param {string}   [spec.output]       the file the script writes
 * @returns {{code:string, steps:{start:number, end:number}[]}}  steps: 1-based
 *          line ranges of each step's block, in recipe order
 */
export function generateCleaningScript(spec) {
  const steps = (spec.steps || []).map(normaliseStep);
  const columns = spec.columns || [];
  const source = spec.source || {};
  const form = spec.form === 'function' ? 'function' : 'script';
  const embed = spec.data === 'embed';
  const fileName = source.fileName || 'data.csv';
  const names = cleaningFileNames(fileName);
  const output = spec.output || names.output;
  const problems = checkRecipe(columns, steps);

  const helpers = new Set(['read_table', 'write_table', 'report']);
  const imports = new Set();
  const blocks = steps.map((step, i) => {
    const n = i + 1;
    const words = plain(describeStep(step));
    if (problems[i]) {
      return { lines: [`# ${n}. ${words}`, `#    Skipped, as on the page: ${plain(problems[i])}`] };
    }
    const py = stepToPython(step);
    py.helpers.forEach(h => helpers.add(h));
    if (py.code.some(line => /\bnp\./.test(line))) imports.add('numpy');
    if (py.code.some(line => /\bpd\./.test(line))) imports.add('pandas');
    if (step.enabled === false) {
      return {
        lines: [`# ${n}. ${words}`, '#    Switched off on the page; remove the # signs to use it.',
          ...py.code.map(line => `# ${line}`), `# report(${pyString(`${n}. ${describeStep(step)}`)}, df)`]
      };
    }
    return {
      lines: [`# ${n}. ${words}`, ...(py.note ? [`#    ${py.note}`] : []), ...py.code,
        `report(${pyString(`${n}. ${describeStep(step)}`)}, df)`]
    };
  });

  // Close the helper set over its dependencies.
  let grew = true;
  while (grew) {
    grew = false;
    for (const h of [...helpers]) {
      for (const d of HELPERS[h].needs || []) {
        if (!helpers.has(d)) { helpers.add(d); grew = true; }
      }
    }
  }
  for (const h of helpers) for (const m of HELPERS[h].imports || []) imports.add(m);
  imports.add('pandas');
  imports.add(embed ? 'io' : 'csv');
  imports.add('csv');

  const readArgs = [];
  if (source.delimiter && source.delimiter !== ',') readArgs.push(`sep=${pyString(source.delimiter)}`);
  if (source.decimal === ',') readArgs.push('decimal=","');
  if (source.header === false) readArgs.push('header=False');
  const readTail = readArgs.length ? `, ${readArgs.join(', ')}` : '';
  const encoding = ENCODINGS[source.encoding] || 'utf-8-sig';

  const out = [];
  const push = (...lines) => { for (const l of lines) out.push(l); };

  // The docstring: what the script does and the recipe in words.
  const recipe = steps.length
    ? steps.map((s, i) => `    ${i + 1}. ${docText(describeStep(s))}${s.enabled === false ? ' (switched off)' : problems[i] ? ' (skipped)' : ''}`)
    : ['    (no steps yet: the table is read and written as it is)'];
  push(`"""Clean ${docText(fileName)} with the recipe made in STEMKit's Data Cleaner.`, '',
    'Made at https://stemkit.net/data-cleaner.html. The steps, in order:', '', ...recipe, '',
    'Run it with Python 3.8 or later and pandas:', '', `    python ${docText(names.script)}`, '');
  if (embed) {
    push(`The data are in the script (DATA, below). It prints the size of the table`,
      `after each step and writes ${docText(output)}, the same table the page shows.`);
  } else {
    push(`It reads ${docText(fileName)} from the folder you run it in, prints the size of`,
      `the table after each step and writes ${docText(output)}, the same table the page`,
      'shows, cell for cell. To clean another file the same way, change INPUT.');
  }
  if (form === 'function') {
    push('', 'Or import it and call clean() on a table from read_table():', '',
      `    from ${docText(names.script.replace(/\.py$/, ''))} import read_table, clean`);
  }
  push('"""', '');

  // Imports.
  const std = ['csv', 'io', 'math', 're', 'statistics'].filter(m => imports.has(m));
  for (const m of std) push(`import ${m}`);
  if (imports.has('decimal')) {
    const names2 = ['Context', 'Decimal', 'ROUND_HALF_UP'];
    if (steps.some(s => s.type === 'round' && s.ties === 'even')) names2.push('ROUND_HALF_EVEN');
    push(`from decimal import ${names2.join(', ')}`);
  }
  push('', 'import numpy as np', 'import pandas as pd', '');
  if (embed) {
    push('# The data, as read from ' + plain(fileName) + '.', `DATA = ${pyTripleQuoted(spec.text || '')}`);
  } else {
    push(`INPUT = ${pyString(fileName)}`);
  }
  push(`OUTPUT = ${pyString(output)}`, '');

  const readLines = (target) => (embed
    ? [`${target} = read_table(io.StringIO(DATA)${readTail})`]
    : [`with open(INPUT, encoding=${pyString(encoding)}) as file:`, `    ${target} = read_table(file${readTail})`]);
  const readLabel = embed ? '"Read the data"' : '"Read " + INPUT';

  const helperLines = [];
  for (const h of HELPER_ORDER) {
    if (!helpers.has(h)) continue;
    helperLines.push('', '', ...HELPERS[h].code);
  }

  const ranges = [];
  const emitSteps = (indent) => {
    blocks.forEach((b, i) => {
      push('');
      const start = out.length + 1;
      for (const l of b.lines) push(l ? indent + l : l);
      ranges[i] = { start, end: out.length };
    });
  };

  if (form === 'script') {
    push('', '# Reading and writing, and the helpers the steps use ' + '-'.repeat(26));
    push(...helperLines.slice(1));
    push('', '', '# The recipe ' + '-'.repeat(66), '');
    push(...readLines('df'), `report(${readLabel}, df)`);
    if (!blocks.length) push('', '# No steps yet: add them on the page and this script follows.');
    emitSteps('');
    push('', 'write_table(df, OUTPUT)', 'print("Wrote " + OUTPUT)');
  } else {
    push('', 'def clean(df):', '    """Apply the recipe to a table from read_table() and return the cleaned copy."""',
      '    df = df.copy()');
    if (!blocks.length) push('', '    # No steps yet: add them on the page and this function follows.');
    emitSteps('    ');
    push('', '    return df', '', '', '# Reading and writing, and the helpers the steps use ' + '-'.repeat(26));
    push(...helperLines.slice(1));
    push('', '', 'if __name__ == "__main__":');
    push(...readLines('table').map(l => `    ${l}`), `    report(${readLabel}, table)`,
      '    table = clean(table)', '    write_table(table, OUTPUT)', '    print("Wrote " + OUTPUT)');
  }
  return { code: out.join('\n') + '\n', steps: ranges };
}
