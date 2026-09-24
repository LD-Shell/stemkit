/**
 * LaTeX Formatter | UI layer.
 *
 * Matrix generation and zero-width stripping live in @stemkit/core; this file
 * handles the MathLive/KaTeX binding.
 *
 * Note: the previous version of this file contained a syntax error, an
 * unclosed `forEach` callback in the theme-toggle handler, which meant the
 * script failed to parse and the tool did not run at all. That is fixed here,
 * and the toggle is removed entirely because the shared inline script in the
 * page already handles theming; the duplicate handler double-bound the button
 * and cancelled itself out.
 */
import { generateMatrix, stripZeroWidth } from '../src/core/latex.js';

document.addEventListener('DOMContentLoaded', () => {

  // --- 1. Bindings ---
  const mathField = document.getElementById('mathField');
  const latexInput = document.getElementById('latexInput');
  const katexPreview = document.getElementById('katexPreview');
  const syntaxStatus = document.getElementById('syntaxStatus');

  const matrixRows = document.getElementById('matrixRows');
  const matrixCols = document.getElementById('matrixCols');
  const matrixStyle = document.getElementById('matrixStyle');
  const generateMatrixBtn = document.getElementById('generateMatrixBtn');
  const copyLatexBtn = document.getElementById('copyLatexBtn');
  const clearBtn = document.getElementById('clearBtn');
  const previewEmpty = document.getElementById('previewEmpty');

  const EXAMPLE = 'H = \\sum_{i=1}^{N} \\frac{p_i^2}{2m} + V(q_1, \\ldots, q_N)';

  // --- Keypress sounds ---
  // MathLive ships its own keypress sounds and looks them up by filename under
  // `soundsDirectory`. Overriding the map here rather than editing the vendored
  // bundle keeps js/dependencies/mathlive.min.js untouched and upgradeable.
  //
  // Only Backspace and Delete make a sound. The standard keypress used to
  // name sound/hee-hee.mp3, which was never committed, so every keystroke
  // requested a missing file; `default`, `return` and `spacebar` are now
  // silent rather than pointed at MathLive's own files, which are not in
  // sound/ either. Add a file and name it here to give typing a sound.
  const KEY_SOUNDS = { delete: 'fahhh.mp3' };

  if (window.MathfieldElement) {
    try {
      window.MathfieldElement.soundsDirectory = 'sound';
      window.MathfieldElement.keypressSound = {
        default: KEY_SOUNDS.standard || null,
        delete: KEY_SOUNDS.delete || null,
        return: KEY_SOUNDS.standard || null,
        spacebar: KEY_SOUNDS.standard || null
      };
    } catch (e) {
      // A sound that will not load should never stop the editor working.
      console.warn('Could not configure MathLive keypress sounds:', e);
    }
  }

  /*
   * Typing on a physical keyboard is silent with the configuration above
   * alone. Inside MathLive the keypress sound is played only when a command
   * carries a `feedback` flag, and that flag is set by the on-screen maths
   * keyboard, the same branch that triggers haptic vibration. Ordinary
   * keystrokes take a different path, so on a desktop the sound never fires
   * no matter which files are configured.
   *
   * Playing it here restores the behaviour people expect from typing.
   */
  const soundCache = {};

  function keySound(kind) {
    if (soundCache[kind] !== undefined) return soundCache[kind];
    if (!KEY_SOUNDS[kind]) return (soundCache[kind] = null);
    try {
      const el = new Audio(`sound/${KEY_SOUNDS[kind]}`);
      el.preload = 'auto';
      soundCache[kind] = el;
    } catch {
      soundCache[kind] = null;
    }
    return soundCache[kind];
  }

  function playKeySound(kind) {
    const base = keySound(kind);
    if (!base) return;
    // A fresh node per keystroke, so held or fast typing overlaps rather than
    // cutting the previous sound short.
    const note = base.cloneNode();
    note.volume = 0.5;
    // Autoplay rules and a missing file both surface as a rejected promise;
    // neither should reach the console on every keystroke.
    const played = note.play();
    if (played && typeof played.catch === 'function') played.catch(() => {});
  }

  if (mathField) {
    mathField.addEventListener('keydown', (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;   // shortcuts stay silent
      const isDelete = e.key === 'Backspace' || e.key === 'Delete';
      playKeySound(isDelete ? 'delete' : 'standard');
    });
  }

  // Theming is handled by the shared inline script in the page.

  // --- 2. Bidirectional binding ---
  if (mathField) mathField.addEventListener('input', () => {
    const raw = mathField.getValue('latex');
    if (latexInput.value !== raw) {
      latexInput.value = raw;
      compileKaTeX(raw);
    }
  });

  if (latexInput) latexInput.addEventListener('input', (e) => {
    const raw = e.target.value;
    if (mathField) mathField.setValue(raw, { suppressChangeNotifications: true });
    compileKaTeX(raw);
  });

  // --- 3. Compilation ---
  function compileKaTeX(latexString) {
    if (!katexPreview) return;
    const has = latexString.trim() !== '';
    if (previewEmpty) previewEmpty.hidden = has;
    katexPreview.hidden = !has;
    if (copyLatexBtn) copyLatexBtn.disabled = !has;
    if (clearBtn) clearBtn.disabled = !has;

    if (!has) {
      katexPreview.innerHTML = '';
      updateStatus(null);
      return;
    }

    try {
      katex.render(latexString, katexPreview, {
        displayMode: true,
        throwOnError: true,
        strict: false
      });
      updateStatus(true);
    } catch (err) {
      katexPreview.innerHTML =
        `<span class="text-red-700 dark:text-red-400 font-mono text-sm">${escapeHtml(err.message)}</span>`;
      updateStatus(false);
    }
  }

  /** true: typesets; false: an error; null: nothing to check. */
  function updateStatus(isValid) {
    if (!syntaxStatus) return;
    if (isValid === null) {
      syntaxStatus.innerHTML = '';
    } else if (isValid) {
      syntaxStatus.innerHTML = '<i class="fa-solid fa-check mr-1" aria-hidden="true"></i> Typesets';
      syntaxStatus.className = 'text-xs font-semibold text-emerald-700 dark:text-emerald-400';
    } else {
      syntaxStatus.innerHTML =
        '<i class="fa-solid fa-triangle-exclamation mr-1" aria-hidden="true"></i> Does not typeset';
      syntaxStatus.className = 'text-xs font-semibold text-red-700 dark:text-red-400';
    }
  }

  /** Put the same LaTeX in both editors and the preview. */
  function setEquation(latex) {
    latexInput.value = latex;
    if (mathField) mathField.setValue(latex, { suppressChangeNotifications: true });
    compileKaTeX(latex);
  }

  // Offered twice: in the page head and in the empty preview.
  document.querySelectorAll('[data-load-example]').forEach(btn => {
    btn.addEventListener('click', () => {
      setEquation(EXAMPLE);
      showToast('Loaded the example: a Hamiltonian.');
    });
  });

  if (clearBtn) clearBtn.addEventListener('click', () => {
    setEquation('');
    if (mathField) mathField.focus();
  });

  // --- 4. Matrix generator (delegated to the core) ---
  if (generateMatrixBtn) generateMatrixBtn.addEventListener('click', () => {
    const rows = parseInt(matrixRows.value, 10) || 3;
    const cols = parseInt(matrixCols.value, 10) || 3;
    const style = matrixStyle.value || 'pmatrix';

    const matrix = generateMatrix(rows, cols, style);
    const current = latexInput.value.trim();
    setEquation(current ? `${current} = ${matrix}` : matrix);

    showToast(`Added a ${rows} × ${cols} ${style} to the equation.`);
  });

  // --- 5. Export ---
  if (copyLatexBtn) copyLatexBtn.addEventListener('click', () => {
    const content = latexInput.value;
    if (!content.trim()) return;
    // MathLive leaves zero-width anchors in the value; they are invisible but
    // break a .tex file if pasted.
    navigator.clipboard.writeText(stripZeroWidth(content))
      .then(() => showToast('Copied the LaTeX.', 'success'))
      .catch(() => showToast('The browser blocked the clipboard. Select the source and copy it instead.', 'error'));
  });

  // --- 6. Utilities ---
  function escapeHtml(text) {
    return String(text ?? '').replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
  }

  // Toasts use the shared .stk-toast component.
  function showToast(msg, type = 'info') {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = 'stk-toast' +
      (type === 'success' ? ' stk-toast-ok' : type === 'error' ? ' stk-toast-danger' : '');
    toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
    const icon = document.createElement('i');
    icon.className = 'fa-solid ' + (type === 'success' ? 'fa-circle-check'
      : type === 'error' ? 'fa-triangle-exclamation' : 'fa-circle-info');
    icon.setAttribute('aria-hidden', 'true');
    const body = document.createElement('span');
    body.textContent = msg;
    toast.append(icon, body);
    container.appendChild(toast);
    setTimeout(() => toast.remove(), type === 'error' ? 5000 : 3000);
  }

  // --- 7. Initial state ---
  if (latexInput && mathField) {
    latexInput.value = mathField.getValue('latex');
    compileKaTeX(latexInput.value);
  }
});
