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

  // --- Keypress sounds ---
  // MathLive ships its own keypress sounds and looks them up by filename under
  // `soundsDirectory`. Overriding the map here rather than editing the vendored
  // bundle keeps js/dependencies/mathlive.min.js untouched and upgradeable.
  //
  // `default` is what MathLive calls the standard keypress. `return` and
  // `spacebar` are pointed at the same file: they have their own defaults that
  // are not present in sound/, so leaving them alone would just request a
  // missing file on every press.
  const KEY_SOUNDS = { standard: 'hee-hee.mp3', delete: 'fahhh.mp3' };

  if (window.MathfieldElement) {
    try {
      window.MathfieldElement.soundsDirectory = 'sound';
      window.MathfieldElement.keypressSound = {
        default: KEY_SOUNDS.standard,
        delete: KEY_SOUNDS.delete,
        return: KEY_SOUNDS.standard,
        spacebar: KEY_SOUNDS.standard
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

    if (!latexString.trim()) {
      katexPreview.innerHTML = '';
      updateStatus(true);
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
        `<span class="text-red-500 font-mono text-sm">${escapeHtml(err.message)}</span>`;
      updateStatus(false);
    }
  }

  function updateStatus(isValid) {
    if (!syntaxStatus) return;
    if (isValid) {
      syntaxStatus.innerHTML = '<i class="fa-solid fa-check mr-1"></i> Valid Syntax';
      syntaxStatus.className = 'text-xs font-bold text-emerald-500';
    } else {
      syntaxStatus.innerHTML =
        '<i class="fa-solid fa-triangle-exclamation mr-1"></i> Compilation Error';
      syntaxStatus.className = 'text-xs font-bold text-red-500';
    }
  }

  // --- 4. Matrix generator (delegated to the core) ---
  if (generateMatrixBtn) generateMatrixBtn.addEventListener('click', () => {
    const rows = parseInt(matrixRows.value, 10) || 3;
    const cols = parseInt(matrixCols.value, 10) || 3;
    const style = matrixStyle.value || 'pmatrix';

    const matrix = generateMatrix(rows, cols, style);
    const current = latexInput.value.trim();
    const next = current ? `${current} = ${matrix}` : matrix;

    latexInput.value = next;
    if (mathField) mathField.setValue(next, { suppressChangeNotifications: true });
    compileKaTeX(next);

    showToast(`Generated ${rows}x${cols} ${style}.`, 'info');
  });

  // --- 5. Export ---
  if (copyLatexBtn) copyLatexBtn.addEventListener('click', () => {
    const content = latexInput.value;
    if (!content) {
      showToast('Workspace is empty.', 'error');
      return;
    }
    // MathLive leaves zero-width anchors in the value; they are invisible but
    // break a .tex file if pasted.
    navigator.clipboard.writeText(stripZeroWidth(content))
      .then(() => showToast('LaTeX string copied to clipboard.', 'success'))
      .catch(() => showToast('Clipboard access denied.', 'error'));
  });

  // --- 6. Utilities ---
  function escapeHtml(text) {
    return String(text ?? '').replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
  }

  function showToast(msg, type) {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    const colors = type === 'success'
      ? 'bg-emerald-50 text-emerald-800 border-emerald-200 dark:bg-emerald-900/30'
      : type === 'error'
        ? 'bg-red-50 text-red-800 border-red-200 dark:bg-red-900/30'
        : 'bg-indigo-50 text-indigo-800 border-indigo-200 dark:bg-indigo-900/30';
    toast.className =
      `px-4 py-3 rounded-xl border shadow-lg toast-enter text-sm font-medium transition-all ${colors}`;
    toast.innerHTML =
      `<i class="fa-solid ${type === 'success' ? 'fa-check-circle' : type === 'error' ? 'fa-triangle-exclamation' : 'fa-info-circle'} mr-2"></i> ${escapeHtml(msg)}`;
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  // --- 7. Initial state ---
  if (latexInput && mathField) {
    latexInput.value = mathField.getValue('latex');
    compileKaTeX(latexInput.value);
  }
});
