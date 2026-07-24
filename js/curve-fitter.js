/**
 * Curve Fitter | UI layer.
 *
 * Parsing, fitting, goodness-of-fit statistics, and Python export live in
 * @stemkit/core; this file handles DOM wiring and Plotly rendering only.
 *
 * Note on the models: exponential, power, and logarithmic fits are performed
 * by linearisation (least squares in log space, y-weighted), which is
 * regression.js behaviour. R-squared is recomputed on the original data so
 * that values are comparable across model families. The core exposes a
 * `linearised` flag, surfaced in the fit metadata below.
 */
import { registerFromGlobals } from '../src/core/vendor.js';
import {
  parseXYData,
  fitCurve,
  formatEquation,
  sampleCurve,
  assessFitAdequacy,
  generateMatplotlibCode
} from '../src/core/curve-fitting.js';

// regression.js is loaded as a UMD global by the page's <script> tags.
registerFromGlobals();

document.addEventListener('DOMContentLoaded', () => {

  // --- 1. Interface bindings ---
  const dataInput = document.getElementById('dataInput');
  const modelSelect = document.getElementById('modelSelect');
  const btnFit = document.getElementById('btnFit');
  const btnUpload = document.getElementById('btnUpload');
  const fileInput = document.getElementById('fileInput');
  const plotContainer = document.getElementById('plotContainer');
  const equationOutput = document.getElementById('equationOutput');
  const r2Value = document.getElementById('r2Value');
  const fitMeta = document.getElementById('fitMeta');
  const btnCopyEquation = document.getElementById('btnCopyEquation');
  const toastContainer = document.getElementById('toastContainer');

  const colXInput = document.getElementById('colX');
  const colYInput = document.getElementById('colY');
  const parseWarnings = document.getElementById('parseWarnings');

  let currentEquationString = '';
  let currentSummary = '';
  let lastFit = null;

  // --- 2. Event listeners ---
  btnFit.addEventListener('click', processRegression);
  colXInput.addEventListener('change', processRegression);
  colYInput.addEventListener('change', processRegression);
  modelSelect.addEventListener('change', processRegression);

  const SAMPLES = {
    linear: { model: 'linear', data: '1\t2.1\n2\t4.3\n3\t5.9\n4\t8.2\n5\t9.8\n6\t12.1\n7\t14.0\n8\t15.9' },
    exponential: { model: 'exponential', data: '0.5\t1.6\n1.0\t2.9\n1.5\t4.4\n2.0\t7.0\n2.5\t10.1\n3.0\t14.8\n3.5\t20.9\n4.0\t29.0' },
    power: { model: 'power', data: '1\t2.0\n2\t5.7\n3\t10.4\n4\t16.0\n5\t22.4\n6\t29.4\n7\t37.0\n8\t45.3' },
    logarithmic: { model: 'logarithmic', data: '1\t0.2\n2\t2.1\n3\t3.3\n4\t4.1\n5\t4.8\n6\t5.3\n7\t5.8\n8\t6.2' },
    polynomial2: { model: 'polynomial2', data: '-4\t18.1\n-3\t9.8\n-2\t4.2\n-1\t1.1\n0\t0.2\n1\t1.0\n2\t4.1\n3\t9.2\n4\t16.3' }
  };

  document.querySelectorAll('.cf-chip').forEach(chip => chip.addEventListener('click', () => {
    const s = SAMPLES[chip.getAttribute('data-sample')];
    if (!s) return;
    colXInput.value = 1;
    colYInput.value = 2;
    dataInput.value = s.data;
    modelSelect.value = s.model;
    const wrap = document.querySelector('.cf-samples');
    if (wrap) wrap.classList.remove('hint');
    processRegression();
  }));

  // When the tool opens with an empty input, pulse the sample chips once to
  // point the user at them; stop as soon as they start typing their own data.
  const cfSamplesWrap = document.querySelector('.cf-samples');
  if (cfSamplesWrap && dataInput && !dataInput.value.trim()) {
    cfSamplesWrap.classList.add('hint');
    dataInput.addEventListener('input',
      () => cfSamplesWrap.classList.remove('hint'), { once: true });
  }

  // Re-render on theme change so the plot colours track it.
  const themeObserver = new MutationObserver(() => {
    if (dataInput.value.trim() !== '') processRegression();
  });
  themeObserver.observe(document.documentElement, {
    attributes: true, attributeFilter: ['class']
  });

  // --- 3. Fitting (delegated to the core) ---
  function processRegression() {
    const xIdx = parseInt(colXInput.value, 10) - 1;
    const yIdx = parseInt(colYInput.value, 10) - 1;

    if (!Number.isInteger(xIdx) || !Number.isInteger(yIdx) || xIdx < 0 || yIdx < 0) {
      showToast('Column numbers must be 1 or higher.');
      return;
    }

    const parsed = parseXYData(dataInput.value, xIdx, yIdx);

    if (parsed.warnings.length > 0 && dataInput.value.trim() !== '') {
      parseWarnings.innerHTML =
        `<i class="fa-solid fa-triangle-exclamation mr-1"></i> ${parsed.warnings.join(' ')}`;
      parseWarnings.classList.remove('hidden');
    } else {
      parseWarnings.classList.add('hidden');
    }

    if (parsed.data.length < 2) {
      if (dataInput.value.trim() === '') return;
      showToast(
        `Found only ${parsed.data.length} valid point(s) in columns ` +
        `${xIdx + 1} and ${yIdx + 1}. At least 2 are needed.`
      );
      resetOutputs();
      return;
    }

    const model = modelSelect.value;
    const fit = fitCurve(parsed.data, model);

    if (fit.error) {
      showToast(fit.error);
      resetOutputs();
      return;
    }

    lastFit = fit;
    currentEquationString = formatEquation(fit.equation, model);
    equationOutput.innerHTML = renderEquationHTML(fit.equation, model);
    r2Value.textContent = Number.isFinite(fit.r2) ? fit.r2.toFixed(4) : ', ';

    currentSummary =
      `R2 = ${Number.isFinite(fit.r2) ? fit.r2.toFixed(4) : 'n/a'}, ` +
      `RMSE = ${Number.isFinite(fit.rmse) ? fit.rmse.toPrecision(4) : 'n/a'}, ` +
      `n = ${fit.n}`;

    renderFitMeta(fit);
    renderPlot(parsed.data, fit);
  }

  function resetOutputs() {
    equationOutput.innerHTML = 'Invalid data selection';
    if (fitMeta) fitMeta.innerHTML = '';
    r2Value.textContent = ', ';
    lastFit = null;
    Plotly.purge(plotContainer);
  }

  // --- 4. Fit metadata and adequacy warnings ---
  function renderFitMeta(fit) {
    if (!fitMeta) return;

    const adequacy = fit.adequacy || assessFitAdequacy(fit.n, fit.model);
    const rmseTxt = Number.isFinite(fit.rmse) ? fit.rmse.toPrecision(4) : 'n/a';
    const linNote = fit.linearised
      ? ' &middot; fitted via linearization (log-space least squares)'
      : '';

    let html = `<span class="font-mono">n = ${fit.n} points &middot; ` +
               `RMSE = ${rmseTxt}${linNote}</span>`;

    if (adequacy.message) {
      const colour = adequacy.level === 'error'
        ? 'text-red-500 dark:text-red-400'
        : 'text-amber-500 dark:text-amber-400';
      html += `<span class="block mt-1 ${colour}">` +
              `<i class="fa-solid fa-triangle-exclamation mr-1"></i>` +
              `${adequacy.message}</span>`;
    }
    fitMeta.innerHTML = html;
  }

  /** Render an equation with HTML superscripts for display. */
  function renderEquationHTML(eq, model) {
    const sign = (v) => (v >= 0 ? '+' : '-');
    const abs = (v) => Math.abs(v);

    switch (model) {
      case 'linear':
        return `y = ${eq[0]}x ${sign(eq[1])} ${abs(eq[1])}`;
      case 'exponential':
        return `y = ${eq[0]} &middot; e<sup>${eq[1]}x</sup>`;
      case 'power':
        return `y = ${eq[0]} &middot; x<sup>${eq[1]}</sup>`;
      case 'logarithmic':
        return `y = ${eq[0]} ${sign(eq[1])} ${abs(eq[1])} &middot; ln(x)`;
      case 'polynomial2':
        return `y = ${eq[0]}x<sup>2</sup> ${sign(eq[1])} ${abs(eq[1])}x ` +
               `${sign(eq[2])} ${abs(eq[2])}`;
      case 'polynomial3':
        return `y = ${eq[0]}x<sup>3</sup> ${sign(eq[1])} ${abs(eq[1])}x<sup>2</sup> ` +
               `${sign(eq[2])} ${abs(eq[2])}x ${sign(eq[3])} ${abs(eq[3])}`;
      default:
        return '';
    }
  }

  // --- 5. Plotting ---
  function renderPlot(data, fit) {
    const isDark = document.documentElement.classList.contains('dark');
    const fontColor = isDark ? '#cbd5e1' : '#334155';
    const gridColor = isDark ? '#334155' : '#e2e8f0';

    const rawX = data.map(p => p[0]);
    const rawY = data.map(p => p[1]);
    const curve = sampleCurve(fit.predict, Math.min(...rawX), Math.max(...rawX), 101);

    const traces = [
      {
        x: rawX, y: rawY, mode: 'markers', type: 'scatter', name: 'Raw Data',
        marker: { size: 8, color: '#94a3b8' }
      },
      {
        x: curve.x, y: curve.y, mode: 'lines', type: 'scatter', name: 'Fitted Model',
        line: { color: '#10b981', width: 3 }
      }
    ];

    const layout = {
      plot_bgcolor: 'transparent',
      paper_bgcolor: 'transparent',
      font: { family: 'Inter, system-ui, sans-serif', color: fontColor },
      xaxis: { gridcolor: gridColor, zerolinecolor: gridColor },
      yaxis: { gridcolor: gridColor, zerolinecolor: gridColor },
      margin: { t: 40, r: 40, b: 40, l: 60 },
      showlegend: true,
      legend: { orientation: 'h', yanchor: 'bottom', y: 1.02, xanchor: 'right', x: 1 }
    };

    Plotly.react(plotContainer, traces, layout, { responsive: true, displaylogo: false });
  }

  // --- 6. Copy and export ---
  btnCopyEquation.addEventListener('click', () => {
    if (!currentEquationString) return;
    const payload = currentSummary
      ? `${currentEquationString}\n${currentSummary}`
      : currentEquationString;
    navigator.clipboard.writeText(payload).then(() => {
      showToast('Equation and fit statistics copied to clipboard!');
      const original = btnCopyEquation.innerHTML;
      btnCopyEquation.innerHTML = 'Copied!';
      setTimeout(() => { btnCopyEquation.innerHTML = original; }, 2000);
    });
  });

  const cfCodeModal = document.getElementById('cfCodeModal');
  const cfCodeBlock = document.getElementById('cfCodeBlock');
  const btnPy = document.getElementById('btnPython');

  if (btnPy) btnPy.addEventListener('click', () => {
    cfCodeBlock.textContent = generateMatplotlibCode(lastFit);
    cfCodeModal.classList.add('open');
  });

  const cfClose = document.getElementById('cfCloseCode');
  if (cfClose) cfClose.addEventListener('click', () => cfCodeModal.classList.remove('open'));
  if (cfCodeModal) cfCodeModal.addEventListener('click', e => {
    if (e.target === cfCodeModal) cfCodeModal.classList.remove('open');
  });

  const cfCopy = document.getElementById('cfCopyCode');
  if (cfCopy) cfCopy.addEventListener('click', () => {
    navigator.clipboard.writeText(cfCodeBlock.textContent)
      .then(() => showToast('matplotlib code copied!'));
  });

  // --- 7. Toasts ---
  function showToast(message) {
    const toast = document.createElement('div');
    toast.className =
      'bg-slate-800 text-white text-xs font-bold px-4 py-2 rounded-lg shadow-xl ' +
      'transform transition-all duration-300 translate-y-[-20px] opacity-0';
    toast.innerText = message;
    toastContainer.appendChild(toast);
    requestAnimationFrame(() => {
      toast.classList.remove('translate-y-[-20px]', 'opacity-0');
      toast.classList.add('translate-y-0', 'opacity-100');
    });
    setTimeout(() => {
      toast.classList.remove('translate-y-0', 'opacity-100');
      toast.classList.add('translate-y-[-20px]', 'opacity-0');
      setTimeout(() => toast.remove(), 300);
    }, 2000);
  }

  // Render an empty plot so the panel does not look broken on load.
  Plotly.react(plotContainer, [], {
    plot_bgcolor: 'transparent',
    paper_bgcolor: 'transparent',
    margin: { t: 40, r: 40, b: 40, l: 60 },
    xaxis: { visible: false },
    yaxis: { visible: false }
  }, { responsive: true, displaylogo: false });

  // The visible button proxies for the hidden native file input.
  if (btnUpload && fileInput) {
    btnUpload.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        dataInput.value = ev.target.result;
        showToast(`Loaded ${file.name}, press Compute Fit.`);
      };
      reader.onerror = () => showToast('Could not read that file.', 'error');
      reader.readAsText(file);
      fileInput.value = '';
    });
  }


  /* --- How the model is fitted and scored -----------------------------------
   * Two things are easy to assume wrongly here. Three of the models are not
   * fitted by least squares on the data as given: they are linearised in log
   * space first, which is fast and closed-form but minimises a different
   * quantity. And R-squared has more than one definition in circulation. Both
   * are stated rather than left to be discovered from a surprising number.
   */
  const MODEL_TEX = {
    linear: String.raw`y = mx + c`,
    exponential: String.raw`y = a\,e^{bx} \;\longrightarrow\; \ln y = \ln a + bx`,
    power: String.raw`y = a\,x^{b} \;\longrightarrow\; \ln y = \ln a + b\ln x`,
    logarithmic: String.raw`y = a\ln x + b`,
    polynomial2: String.raw`y = a_2x^2 + a_1x + a_0`,
    polynomial3: String.raw`y = a_3x^3 + a_2x^2 + a_1x + a_0`
  };

  const SCORE_TEX = String.raw`R^2 = 1 - \frac{\sum_i (y_i - \hat{y}_i)^2}{\sum_i (y_i - \bar{y})^2},
        \qquad \mathrm{RMSE} = \sqrt{\frac{1}{n}\sum_i (y_i - \hat{y}_i)^2}`;

  // Matches LINEARISED_MODELS in the core: logarithmic is not one of them.
  const LINEARISED = new Set(['exponential', 'power']);

  const COMMON_DEFS = [
    [String.raw`y_i`, 'the observed value at point i'],
    [String.raw`\hat{y}_i`, 'the value the fitted curve predicts there'],
    [String.raw`\bar{y}`, 'mean of the observed values'],
    [String.raw`n`, 'number of points used in the fit'],
    [String.raw`R^2`, 'fraction of the variance in y that the model accounts for, computed on the original scale of the data, not on the transformed one'],
    [String.raw`\mathrm{RMSE}`, 'root mean squared residual, in the units of y; divided by n rather than by the residual degrees of freedom, so it is not an unbiased estimate of the error variance']
  ];

  function renderTheory(model) {
    const host = document.getElementById('theoryContainer');
    if (!host) return;
    const tex = MODEL_TEX[model];
    if (!tex) { host.innerHTML = ''; return; }

    if (!window.katex) {
      host.innerHTML = '<span class="text-xs text-slate-400">Formula renderer unavailable.</span>';
      return;
    }
    const kx = (t, d) => {
      try { return katex.renderToString(t, { displayMode: !!d, throwOnError: false, output: 'html' }); }
      catch { return t; }
    };

    const REQUIRES = {
      exponential: 'every y > 0',
      power: 'every x > 0 and every y > 0',
      logarithmic: 'every x > 0'
    };

    const notes = [];
    if (model === 'power') {
      notes.push('Solved as an unweighted least-squares fit of ln y on ln x, so ' +
                 'what is minimised is a residual in log space rather than in the ' +
                 'units of y. That gives small y values more influence than a ' +
                 'direct fit would. Treat it as a fast estimate; for a ' +
                 'maximum-likelihood fit under additive Gaussian noise, use ' +
                 'non-linear least squares on the untransformed data.');
    } else if (model === 'exponential') {
      // regression.js solves this with each point weighted by y, which is the
      // standard correction for log-transform bias; it is not the same as the
      // unweighted log-log fit used for the power model.
      notes.push('Solved in log space, but with each point weighted by y. That ' +
                 'weighting is the standard correction for the bias plain ' +
                 'log-fitting has toward small values, so the result stays close ' +
                 'to a direct non-linear fit without being identical to it.');
    } else if (model === 'logarithmic') {
      notes.push('Ordinary least squares on the data as given. The model is linear ' +
                 'in its parameters, so regressing y on ln x introduces no bias; ' +
                 'only x is transformed, never y.');
    } else {
      notes.push('Ordinary least squares on the data as given.');
    }
    if (REQUIRES[model]) {
      notes.push(`Requires ${REQUIRES[model]}. A dataset containing a point that ` +
                 'cannot be transformed is rejected with a message rather than ' +
                 'having the point quietly dropped.');
    }

    const defs = COMMON_DEFS.map(([s, meaning]) =>
      `<div class="mf-def"><dt>${kx(s)}</dt><dd>${meaning}</dd></div>`).join('');

    // The LaTeX source is kept on the element so the formula can be copied for
    // a methods section; rendered output cannot be copied back out as LaTeX.
    host.innerHTML =
      `<div data-tex="${tex.replace(/"/g, '&quot;')}" title="LaTeX source in the data-tex attribute">${kx(tex, true)}</div>` +
      notes.map(n => `<p class="text-[11px] leading-relaxed text-amber-700 dark:text-amber-400 mb-2">${n}</p>`).join('') +
      `<div data-tex="${SCORE_TEX.replace(/"/g, '&quot;')}">${kx(SCORE_TEX, true)}</div>` +
      `<div class="mf-defs"><div class="mf-defs-title">Where:</div><dl>${defs}</dl></div>`;
  }

  if (modelSelect) modelSelect.addEventListener('change', () => renderTheory(modelSelect.value));
  const theoryHost = document.getElementById('modelTheory');
  if (theoryHost) theoryHost.addEventListener('toggle', () => {
    if (theoryHost.open && modelSelect) renderTheory(modelSelect.value);
  });

});
