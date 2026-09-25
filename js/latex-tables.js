/**
 * LaTeX Table Generator | UI layer.
 *
 * Parsing, escaping, and LaTeX/Markdown generation live in stemkit-core;
 * this file handles DOM wiring and the HTML preview.
 */
import {
  parseTableData,
  generateLatexTable,
  generateMarkdownTable,
  padMatrix
} from '../src/core/latex.js';

document.addEventListener('DOMContentLoaded', () => {

  // # --- 1. Interface bindings ---
  const dataInput = document.getElementById('dataInput');
  const envSelect = document.getElementById('envSelect');
  const styleSelect = document.getElementById('styleSelect');
  const captionInput = document.getElementById('captionInput');
  const labelInput = document.getElementById('labelInput');
  const alignRadios = document.getElementsByName('align');

  const tablePreview = document.getElementById('tablePreview');
  const previewEmpty = document.getElementById('previewEmpty');
  const latexOutput = document.getElementById('latexOutput');
  const latexResult = document.getElementById('latexResult');
  const latexEmpty = document.getElementById('latexEmpty');
  const btnCopyCode = document.getElementById('btnCopyCode');
  const btnDownload = document.getElementById('btnDownload');
  const btnMarkdown = document.getElementById('btnMarkdown');
  const btnClear = document.getElementById('btnClear');
  const toastContainer = document.getElementById('toastContainer');

  const EXAMPLE =
    'Material\tBand gap (eV)\tRole\n' +
    'Silicon\t1.12\tSemiconductor\n' +
    'GaAs\t1.42\tSemiconductor\n' +
    'Diamond\t5.47\tInsulator';
  const EX_CAPTION = 'Band gaps of three semiconductors and an insulator';
  const EX_LABEL = 'tab:gaps';

  // # --- 2. Event listeners ---
  [dataInput, envSelect, styleSelect, captionInput, labelInput]
    .filter(Boolean)
    .forEach(el => el.addEventListener('input', processPipeline));

  Array.from(alignRadios).forEach(radio =>
    radio.addEventListener('change', processPipeline));

  // Offered twice: in the page head and in the empty preview.
  document.querySelectorAll('[data-load-example]').forEach(btn => {
    btn.addEventListener('click', () => {
      dataInput.value = EXAMPLE;
      if (!captionInput.value) captionInput.value = EX_CAPTION;
      if (!labelInput.value) labelInput.value = EX_LABEL;
      processPipeline();
      showToast('Loaded an example table.');
    });
  });

  if (btnClear) btnClear.addEventListener('click', () => {
    dataInput.value = '';
    // The example's caption and label go with it; the user's own stay.
    if (captionInput.value === EX_CAPTION) captionInput.value = '';
    if (labelInput.value === EX_LABEL) labelInput.value = '';
    processPipeline();
    dataInput.focus();
  });

  // # --- 3. Pipeline ---
  const currentAlign = () => {
    const checked = Array.from(alignRadios).find(r => r.checked);
    return checked ? checked.value : 'l';
  };

  function processPipeline() {
    // Ragged input is squared off once, so the preview and the LaTeX output
    // always show the same shape rather than disagreeing about column count.
    const matrix = padMatrix(parseTableData(dataInput.value));
    const has = matrix.length > 0;

    btnClear.disabled = dataInput.value === '';
    btnCopyCode.disabled = !has;
    btnDownload.disabled = !has;
    btnMarkdown.disabled = !has;
    previewEmpty.hidden = has;
    tablePreview.hidden = !has;
    latexEmpty.hidden = has;
    latexResult.hidden = !has;

    renderPreview(matrix);
    latexOutput.textContent = has
      ? generateLatexTable(matrix, {
          environment: envSelect.value,
          style: styleSelect.value,
          align: currentAlign(),
          caption: captionInput.value.trim(),
          label: labelInput.value.trim()
        })
      : '';
  }

  // # --- 4. Preview ---
  function renderPreview(matrix) {
    if (matrix.length === 0) {
      tablePreview.innerHTML = '';
      return;
    }

    // The class names the line style, so the preview draws the same rules
    // the LaTeX does: booktabs, rules only, or a full grid.
    const style = styleSelect.value;
    const alignClass =
      { l: 'text-left', c: 'text-center', r: 'text-right' }[currentAlign()];
    const caption = captionInput.value.trim();

    const parts = [`<table class="preview-table lt-${escapeHtml(style)}">`];
    if (caption) parts.push(`<caption>${escapeHtml(caption)}</caption>`);
    parts.push('<thead><tr>');
    for (const h of matrix[0]) {
      parts.push(`<th class="${alignClass}">${escapeHtml(h)}</th>`);
    }
    parts.push('</tr></thead><tbody>');

    for (let i = 1; i < matrix.length; i++) {
      parts.push('<tr>');
      for (const cell of matrix[i]) {
        parts.push(`<td class="${alignClass}">${escapeHtml(cell)}</td>`);
      }
      parts.push('</tr>');
    }
    parts.push('</tbody></table>');
    tablePreview.innerHTML = parts.join('');
  }

  // # --- 5. Export ---
  function copy(text, what) {
    navigator.clipboard.writeText(text).then(
      () => showToast(`Copied the ${what}.`, 'success'),
      () => showToast('The browser blocked the clipboard. Select the text and copy it instead.', 'error')
    );
  }

  if (btnCopyCode) btnCopyCode.addEventListener('click', () => {
    const text = latexOutput.textContent;
    if (text) copy(text, 'LaTeX');
  });

  if (btnMarkdown) btnMarkdown.addEventListener('click', () => {
    const matrix = padMatrix(parseTableData(dataInput.value));
    if (matrix.length === 0) return;
    copy(generateMarkdownTable(matrix, { align: currentAlign() }), 'table as Markdown');
  });

  if (btnDownload) btnDownload.addEventListener('click', () => {
    const text = latexOutput.textContent;
    if (!text) return;
    const blob = new Blob([text.trimEnd() + '\n'], { type: 'text/plain;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'table.tex';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    showToast('Saved table.tex.', 'success');
  });

  // # --- 6. Utilities ---
  function escapeHtml(text) {
    return String(text ?? '').replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
  }

  // Toasts use the shared .stk-toast component.
  function showToast(message, type = 'info') {
    if (!toastContainer) return;
    const toast = document.createElement('div');
    toast.className = 'stk-toast' +
      (type === 'success' ? ' stk-toast-ok' : type === 'error' ? ' stk-toast-danger' : '');
    toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
    const icon = document.createElement('i');
    icon.className = 'fa-solid ' + (type === 'success' ? 'fa-circle-check'
      : type === 'error' ? 'fa-triangle-exclamation' : 'fa-circle-info');
    icon.setAttribute('aria-hidden', 'true');
    const body = document.createElement('span');
    body.textContent = message;
    toast.append(icon, body);
    toastContainer.appendChild(toast);
    setTimeout(() => toast.remove(), type === 'error' ? 5000 : 2500);
  }

  processPipeline();
});
