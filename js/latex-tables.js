/**
 * LaTeX Table Generator | UI layer.
 *
 * Parsing, escaping, and LaTeX/Markdown generation live in @stemkit/core;
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
  const latexOutput = document.getElementById('latexOutput');
  const btnCopyCode = document.getElementById('btnCopyCode');
  const btnDownload = document.getElementById('btnDownload');
  const btnExample = document.getElementById('btnExample');
  const btnMarkdown = document.getElementById('btnMarkdown');
  const toastContainer = document.getElementById('toastContainer');

  const PLACEHOLDER = 'Waiting for input matrix...';
  const EXAMPLE =
    'Material\tBand gap (eV)\tRole\n' +
    'Silicon\t1.12\tSemiconductor\n' +
    'GaAs\t1.42\tSemiconductor\n' +
    'Diamond\t5.47\tInsulator';

  // # --- 2. Event listeners ---
  [dataInput, envSelect, styleSelect, captionInput, labelInput]
    .filter(Boolean)
    .forEach(el => el.addEventListener('input', processPipeline));

  Array.from(alignRadios).forEach(radio =>
    radio.addEventListener('change', processPipeline));

  document.querySelectorAll('.accordion-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const expanded = btn.getAttribute('aria-expanded') === 'true';
      btn.setAttribute('aria-expanded', !expanded);
      const target = document.getElementById(btn.getAttribute('data-target'));
      if (target) target.classList.toggle('expanded');
    });
  });

  if (btnExample) btnExample.addEventListener('click', () => {
    dataInput.value = EXAMPLE;
    processPipeline();
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

    renderPreview(matrix);

    if (matrix.length === 0) {
      latexOutput.textContent = PLACEHOLDER;
      return;
    }

    latexOutput.textContent = generateLatexTable(matrix, {
      environment: envSelect.value,
      style: styleSelect.value,
      align: currentAlign(),
      caption: captionInput.value.trim(),
      label: labelInput.value.trim()
    });
  }

  // # --- 4. Preview ---
  function renderPreview(matrix) {
    if (matrix.length === 0) {
      tablePreview.innerHTML =
        '<span class="text-slate-400">Paste data to render preview.</span>';
      return;
    }

    const style = styleSelect.value;
    const alignClass =
      { l: 'text-left', c: 'text-center', r: 'text-right' }[currentAlign()];

    const parts = [
      `<table class="preview-table ${style === 'booktabs' ? 'booktabs' : ''}">`,
      '<thead><tr>'
    ];
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
  if (btnCopyCode) btnCopyCode.addEventListener('click', () => {
    const text = latexOutput.textContent;
    if (!text || text === PLACEHOLDER) return;
    navigator.clipboard.writeText(text).then(() => showToast('LaTeX copied.'));
  });

  if (btnMarkdown) btnMarkdown.addEventListener('click', () => {
    const matrix = padMatrix(parseTableData(dataInput.value));
    if (matrix.length === 0) return showToast('Nothing to convert yet.');
    const md = generateMarkdownTable(matrix, { align: currentAlign() });
    navigator.clipboard.writeText(md).then(() => showToast('Markdown copied.'));
  });

  if (btnDownload) btnDownload.addEventListener('click', () => {
    const text = latexOutput.textContent;
    if (!text || text === PLACEHOLDER) return;
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'table.tex';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    showToast('Downloaded table.tex');
  });

  // # --- 6. Utilities ---
  function escapeHtml(text) {
    return String(text ?? '').replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
  }

  function showToast(message) {
    if (!toastContainer) return;
    const toast = document.createElement('div');
    toast.className =
      'bg-slate-800 text-white text-xs font-bold px-4 py-2 rounded-lg shadow-xl ' +
      'transition-opacity duration-300';
    toast.innerText = message;
    toastContainer.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 300);
    }, 2000);
  }

  processPipeline();
});
