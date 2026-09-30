/**
 * The Python script panel, shared by the tools that write a script.
 *
 * It looks and works like the Curve Fitter's Python section: a header with
 * the file name and Copy and Download buttons, a segmented choice of where
 * the data come from, the code on a dark pane that stays dark in both themes,
 * and a note underneath. Styles: src/tools/python-panel.css.
 *
 *   const panel = createPythonPanel(host, {
 *     title: 'Python script',            // the heading
 *     filename: 'clean_data.py',         // shown in the badge, used by Download
 *     sources: [{ id: 'file', label: 'Read the file' }, { id: 'embed', label: 'Data in the script' }],
 *     onSourceChange: (id) => { ... },   // after the reader picks a source
 *     note: 'Runs with Python 3 and pandas.'   // HTML under the code
 *   });
 *   panel.setCode(text);  panel.setFilename(name);  panel.setNote(html);
 *   panel.setSource(id);  panel.destroy();
 *
 * A script of more than a megabyte (a large data set written into it) is
 * shown in part: its first 200 000 characters, highlighted, then a line
 * saying how much is not shown; Copy and Download give the whole script.
 * Megabytes are never put into the page as HTML.
 *
 * Optional extras, all additive: `variants` / `onVariantChange` /
 * `setVariant(id)` for a second segmented choice (the form of the code, say);
 * `setCode(text, { reveal: { start, end } })` to mark and scroll to a range
 * of 1-based lines; `empty` for the placeholder shown with no code;
 * `headingLevel` (2 by default); `onCopy` / `onDownload` callbacks; and
 * `element`, the panel's root.
 */

const PY_KEYWORDS = new Set(('False None True and as assert break class continue def del elif else except ' +
  'finally for from global if import in is lambda nonlocal not or pass raise return try while with yield').split(' '));

const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * The script as HTML with comments, strings, keywords and numbers wrapped in
 * spans. Every character is kept, so the element's textContent is the script.
 *
 * @param {string} code
 * @returns {string}
 */
export function highlightPython(code) {
  const n = code.length;
  const span = (cls, text) => `<span class="tok-${cls}">${escapeHtml(text)}</span>`;
  const isId = ch => ch !== undefined && /[\p{L}\p{N}_]/u.test(ch);
  let out = '';
  let plain = '';
  const flush = () => { if (plain) { out += escapeHtml(plain); plain = ''; } };
  let i = 0;
  while (i < n) {
    const ch = code[i];
    if (ch === '#') {
      let j = code.indexOf('\n', i);
      if (j < 0) j = n;
      flush();
      out += span('c', code.slice(i, j));
      i = j;
      continue;
    }
    const prev = code[i - 1];
    if (!isId(prev)) {
      const m = /^(?:[rRbBuUfF]{1,2})?("""|'''|"|')/.exec(code.slice(i, i + 5));
      if (m) {
        const quote = m[1];
        const raw = /[rR]/.test(m[0].slice(0, -quote.length));
        let j = i + m[0].length;
        if (quote.length === 3) {
          // A backslash escapes the next character, so \" does not end the string.
          while (j < n && code.slice(j, j + 3) !== quote) j += code[j] === '\\' && !raw ? 2 : 1;
          j = j < n ? j + 3 : n;
        } else {
          while (j < n && code[j] !== quote && code[j] !== '\n') j += code[j] === '\\' && !raw ? 2 : 1;
          if (code[j] === quote) j++;
        }
        flush();
        out += span('s', code.slice(i, j));
        i = j;
        continue;
      }
      if (/\d/.test(ch) || (ch === '.' && /\d/.test(code[i + 1] || ''))) {
        const m2 = /^(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d+)?j?/.exec(code.slice(i, i + 40));
        flush();
        out += span('n', m2[0]);
        i += m2[0].length;
        continue;
      }
      if (isId(ch)) {
        let j = i;
        while (j < n && isId(code[j])) j++;
        const word = code.slice(i, j);
        if (PY_KEYWORDS.has(word)) { flush(); out += span('k', word); }
        else plain += word;
        i = j;
        continue;
      }
    }
    plain += ch;
    i++;
  }
  flush();
  return out;
}

let panelCount = 0;

/* Past SHOW_ALL characters only the first SHOW_PART are shown (cut at a line
   end); the whole script stays in memory for Copy and Download. */
const SHOW_ALL = 1000000;
const SHOW_PART = 200000;
const HIGHLIGHT_ALL = 400000;

/* Size in words: 16.2 MB, 340 kB. */
function sizeText(chars) {
  return chars >= 1e6 ? `${(chars / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(chars / 1e3))} kB`;
}

/* How many lines there are in text[from:], counted without splitting it. */
function linesFrom(text, from) {
  let n = 0;
  for (let i = text.indexOf('\n', from); i >= 0; i = text.indexOf('\n', i + 1)) n++;
  return text.endsWith('\n') ? n : n + 1;
}

function copyToClipboard(text) {
  const fallback = () => new Promise((resolve, reject) => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      if (document.execCommand('copy')) resolve(); else reject(new Error('copy'));
    } catch (e) {
      reject(e);
    }
    ta.remove();
  });
  if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text).catch(fallback);
  return fallback();
}

function segmented(items, label, current) {
  const seg = document.createElement('div');
  seg.className = 'stk-seg';
  seg.setAttribute('role', 'group');
  seg.setAttribute('aria-label', label);
  for (const item of items) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.id = item.id;
    b.textContent = item.label;
    const on = item.id === current;
    b.setAttribute('aria-pressed', String(on));
    b.classList.toggle('is-active', on);
    seg.appendChild(b);
  }
  return seg;
}

function pressSegment(seg, id) {
  if (!seg) return;
  for (const b of seg.querySelectorAll('button')) {
    const on = b.dataset.id === id;
    b.setAttribute('aria-pressed', String(on));
    b.classList.toggle('is-active', on);
  }
}

/**
 * Build a Python script panel inside `host`.
 *
 * @param {HTMLElement} host
 * @param {object} options
 * @param {string} [options.title='Python script']
 * @param {string} [options.filename='script.py']
 * @param {{id:string, label:string}[]} [options.sources]
 * @param {(id:string) => void} [options.onSourceChange]
 * @param {string} [options.note]  HTML
 * @param {{id:string, label:string}[]} [options.variants]
 * @param {(id:string) => void} [options.onVariantChange]
 * @param {string} [options.empty]
 * @param {number} [options.headingLevel=2]
 * @param {(text:string) => void} [options.onCopy]
 * @param {(text:string, filename:string) => void} [options.onDownload]
 * @returns {{setCode:Function, setFilename:Function, setNote:Function, setSource:Function,
 *            setVariant:Function, destroy:Function, element:HTMLElement}}
 */
export function createPythonPanel(host, options = {}) {
  const {
    title = 'Python script',
    sources = [],
    variants = [],
    onSourceChange,
    onVariantChange,
    onCopy,
    onDownload,
    headingLevel = 2
  } = options;
  const empty = options.empty || '# The script appears here.';
  const id = `pyp${++panelCount}`;
  let filename = options.filename || 'script.py';
  let code = '';
  let source = sources.length ? sources[0].id : null;
  let variant = variants.length ? variants[0].id : null;
  let copyTimer = null;

  const root = document.createElement('section');
  root.className = 'pyp';
  root.setAttribute('aria-labelledby', `${id}-t`);
  const level = Math.min(6, Math.max(2, headingLevel | 0 || 2));
  root.innerHTML = `
    <div class="pyp-h">
      <h${level} id="${id}-t" class="pyp-t"><span class="pyp-title"></span> <span class="stk-badge stk-mono pyp-name"></span></h${level}>
      <div class="pyp-actions">
        <button type="button" class="stk-btn stk-btn-sm stk-btn-primary" data-pyp="copy" disabled><i class="fa-regular fa-copy" aria-hidden="true"></i> Copy</button>
        <button type="button" class="stk-btn stk-btn-sm" data-pyp="download" disabled><i class="fa-solid fa-download" aria-hidden="true"></i> Download .py</button>
      </div>
    </div>
    <div class="pyp-opts" hidden></div>
    <div class="pyp-body stk-scroll" tabindex="0" role="region" aria-label="">
      <div class="pyp-inner">
        <div class="pyp-mark" hidden></div>
        <pre class="pyp-code"><code></code></pre>
      </div>
    </div>
    <p class="pyp-f"></p>
    <span class="sr-only" role="status" aria-live="polite"></span>`;

  const $ = sel => root.querySelector(sel);
  const nameEl = $('.pyp-name');
  const copyBtn = $('[data-pyp="copy"]');
  const downloadBtn = $('[data-pyp="download"]');
  const opts = $('.pyp-opts');
  const body = $('.pyp-body');
  const mark = $('.pyp-mark');
  const pre = $('.pyp-code');
  const codeEl = $('code');
  const foot = $('.pyp-f');
  const live = $('[role="status"]');
  $('.pyp-title').textContent = title;
  body.setAttribute('aria-label', title);

  let sourceSeg = null;
  let variantSeg = null;
  if (sources.length) {
    sourceSeg = segmented(sources, 'Where the script reads the data', source);
    opts.appendChild(sourceSeg);
  }
  if (variants.length) {
    variantSeg = segmented(variants, 'Form of the script', variant);
    opts.appendChild(variantSeg);
  }
  opts.hidden = !sources.length && !variants.length;

  const onSegment = (e) => {
    const b = e.target.closest('button[data-id]');
    if (!b) return;
    if (sourceSeg && sourceSeg.contains(b)) {
      if (b.dataset.id === source) return;
      source = b.dataset.id;
      pressSegment(sourceSeg, source);
      if (onSourceChange) onSourceChange(source);
    } else if (variantSeg && variantSeg.contains(b)) {
      if (b.dataset.id === variant) return;
      variant = b.dataset.id;
      pressSegment(variantSeg, variant);
      if (onVariantChange) onVariantChange(variant);
    }
  };
  opts.addEventListener('click', onSegment);

  const announce = (text) => {
    live.textContent = '';
    setTimeout(() => { live.textContent = text; }, 50);
  };

  const onCopyClick = () => {
    if (!code) return;
    copyToClipboard(code).then(() => {
      clearTimeout(copyTimer);
      copyBtn.innerHTML = '<i class="fa-solid fa-check" aria-hidden="true"></i> Copied';
      copyBtn.setAttribute('aria-pressed', 'true');
      copyTimer = setTimeout(() => {
        copyBtn.innerHTML = '<i class="fa-regular fa-copy" aria-hidden="true"></i> Copy';
        copyBtn.removeAttribute('aria-pressed');
      }, 1600);
      announce('Copied the Python script.');
      if (onCopy) onCopy(code);
    }).catch(() => announce('Copying failed. Select the code and copy it by hand.'));
  };
  const onDownloadClick = () => {
    if (!code) return;
    const url = URL.createObjectURL(new Blob([code], { type: 'text/x-python' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    announce(`Saved ${filename}.`);
    if (onDownload) onDownload(code, filename);
  };
  copyBtn.addEventListener('click', onCopyClick);
  downloadBtn.addEventListener('click', onDownloadClick);

  function setFilename(name) {
    filename = String(name || 'script.py');
    nameEl.textContent = filename;
  }

  function setNote(html) {
    foot.innerHTML = html || '';
    foot.hidden = !html;
  }

  function reveal(range) {
    const lineHeight = parseFloat(getComputedStyle(pre).lineHeight) || 18;
    const top = parseFloat(getComputedStyle(pre).paddingTop) || 0;
    const start = Math.max(1, range.start | 0);
    const end = Math.max(start, range.end | 0);
    mark.style.top = `${top + (start - 1) * lineHeight}px`;
    mark.style.height = `${(end - start + 1) * lineHeight}px`;
    mark.hidden = false;
    mark.classList.remove('is-new');
    void mark.offsetWidth;
    mark.classList.add('is-new');
    // Scroll the pane, not the page, to bring the lines into view.
    const want = top + (start - 1) * lineHeight - lineHeight * 2;
    const bottom = top + end * lineHeight;
    if (body.scrollHeight > body.clientHeight && (want < body.scrollTop || bottom > body.scrollTop + body.clientHeight)) {
      const smooth = !window.matchMedia || !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      body.scrollTo({ top: Math.max(0, want), behavior: smooth ? 'smooth' : 'auto' });
    }
  }

  let shownLines = Infinity;
  function setCode(text, extra = {}) {
    code = String(text || '');
    if (!code) {
      codeEl.innerHTML = `<span class="pyp-empty">${escapeHtml(empty)}</span>`;
      mark.hidden = true;
      shownLines = Infinity;
    } else if (code.length > SHOW_ALL) {
      // The first part, cut at a line end, and a line saying what is left out.
      let cut = code.lastIndexOf('\n', SHOW_PART);
      if (cut <= 0) cut = SHOW_PART;
      const shown = code.slice(0, cut + 1);
      const rest = linesFrom(code, cut + 1);
      codeEl.innerHTML = highlightPython(shown);
      const note = document.createElement('span');
      note.className = 'pyp-cut';
      note.textContent = `# … ${rest.toLocaleString('en-GB')} more line${rest === 1 ? '' : 's'} (${sizeText(code.length - shown.length)} of ${sizeText(code.length)}) are not shown here. Copy and Download give the whole script.`;
      codeEl.appendChild(note);
      shownLines = linesFrom(shown, 0);
      if (extra.reveal && (extra.reveal.end | 0) <= shownLines) reveal(extra.reveal);
      else mark.hidden = true;
    } else {
      codeEl.innerHTML = code.length < HIGHLIGHT_ALL ? highlightPython(code) : escapeHtml(code);
      shownLines = Infinity;
      if (extra.reveal) reveal(extra.reveal);
      else if (extra.mark === false || extra.reveal === null) mark.hidden = true;
    }
    copyBtn.disabled = !code;
    downloadBtn.disabled = !code;
  }

  function setSource(next) {
    if (!sources.some(s => s.id === next)) return;
    source = next;
    pressSegment(sourceSeg, source);
  }

  function setVariant(next) {
    if (!variants.some(v => v.id === next)) return;
    variant = next;
    pressSegment(variantSeg, variant);
  }

  function destroy() {
    clearTimeout(copyTimer);
    opts.removeEventListener('click', onSegment);
    copyBtn.removeEventListener('click', onCopyClick);
    downloadBtn.removeEventListener('click', onDownloadClick);
    root.remove();
  }

  setFilename(filename);
  setNote(options.note || '');
  setCode('');
  host.appendChild(root);

  return { setCode, setFilename, setNote, setSource, setVariant, destroy, element: root };
}
