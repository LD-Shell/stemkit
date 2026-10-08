/*
 * Tutorial video cards. A page opts in with <section data-tutorial="slug"></section>.
 * The card shows the video's thumbnail, served from the site
 * (assets/tutorials/<slug>.webp, a copy of the YouTube one at 640 x 360). The
 * player (youtube-nocookie) is created on click, so the page contacts YouTube
 * only when the visitor presses play. tools/build-csp.mjs allows the player
 * frame on any page carrying data-tutorial.
 *
 * A new video: add it here, add its thumbnail to assets/tutorials/, and put the
 * mount on the tool's page, inside its "How to use" section.
 */
(function () {
    'use strict';

    var VIDEOS = {
        'trailer':              { id: 'b8-Njiae9tQ', title: 'STEMKit Tools' },
        'plot-digitizer':       { id: 'BTx_5dfdDRc', title: 'Plot Digitizer: turn a graph image into numbers' },
        'curve-fitter':         { id: 'yQQcxk8NcqM', title: 'Curve Fitter: fit an equation you type to your data' },
        'plot-builder':         { id: '18X3mi_31bw', title: 'Plot Builder: CSV to a publication figure and the Python that draws it' },
        'latex-formatter':      { id: '1LKQKjukP-4', title: 'Equation Formatter: write, check and copy LaTeX equations' },
        'stats-calculator':     { id: 'C4d3TF0i8Aw', title: 'Statistics Calculator: t-tests, ANOVA and post-hoc tests' },
        'error-bar-generator':  { id: 'jDro2zCEqHs', title: 'Error Bar Generator: SD, SEM or confidence interval, with brackets' },
        'scientific-converter': { id: 'Bzk6f46ePNw', title: 'Scientific Converter: one value in every unit of its quantity' },
        'doi-fetcher':          { id: '29JvEmZ-KFY', title: 'DOI to BibTeX: turn a list of DOIs into a .bib file' },
        'bibtex-deduplicator':  { id: '78_d0617q6A', title: 'BibTeX Deduplicator: remove duplicate references from a .bib file' },
        'bibtex-sanitizer':     { id: 'NkJ6df-sKko', title: 'BibTeX Sanitizer: clean a messy .bib file' },
        'latex-tables':         { id: 'lbvZNv5k-Ak', title: 'Visual LaTeX Tables: turn a spreadsheet table into LaTeX' },
        'journal-abbreviator':  { id: 'bL4YU7Hfp10', title: 'Journal Abbreviator: abbreviate journal names in a reference list or .bib' },
        'xvg-visualizer':       { id: 'Jhy6LdatiDc', title: 'XVG Visualizer: plot GROMACS .xvg and CSV files' },
        'outlier-detector':     { id: 't1pzzCoXxFM', title: 'Outlier Detector: flag unusual values in a column' },
        'data-cleaner':         { id: 'wIOWS0ST7rU', title: 'Data Cleaner: clean a CSV with a recipe you can reuse' }
    };

    function el(tag, cls, text) {
        var n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text) n.textContent = text;
        return n;
    }

    function captionsOff(ifr) {
        var send = function (msg) {
            if (ifr.contentWindow) ifr.contentWindow.postMessage(JSON.stringify(msg), 'https://www.youtube-nocookie.com');
        };
        [0, 400, 1200, 2500].forEach(function (ms) {
            setTimeout(function () {
                send({ event: 'listening', id: 1, channel: 'widget' });
                send({ event: 'command', func: 'unloadModule', args: ['captions'], id: 1, channel: 'widget' });
                send({ event: 'command', func: 'unloadModule', args: ['cc'], id: 1, channel: 'widget' });
            }, ms);
        });
    }

    function build(host) {
        var v = VIDEOS[host.getAttribute('data-tutorial')];
        if (!v) return;
        var watchUrl = 'https://www.youtube.com/watch?v=' + v.id;
        var isTrailer = host.getAttribute('data-tutorial') === 'trailer';

        host.classList.add('stk-tut');
        host.setAttribute('aria-label', isTrailer ? 'Video tour' : 'Video tutorial');

        var play = el('button', 'stk-tut-thumb');
        play.type = 'button';
        play.setAttribute('aria-label', 'Play video: ' + v.title);
        var img = el('img');
        img.src = 'assets/tutorials/' + host.getAttribute('data-tutorial') + '.webp';
        img.alt = '';
        img.width = 640;
        img.height = 360;
        img.loading = 'lazy';
        img.decoding = 'async';
        var icon = el('span', 'stk-tut-play');
        icon.setAttribute('aria-hidden', 'true');
        icon.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20"><path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg>';
        play.appendChild(img);
        play.appendChild(icon);

        var text = el('div', 'stk-tut-text');
        text.appendChild(el('span', 'stk-tut-kicker', isTrailer ? 'Video tour' : 'Video tutorial'));
        text.appendChild(el('h2', 'stk-tut-title', v.title));
        text.appendChild(el('p', 'stk-tut-desc', isTrailer
            ? 'A short tour of what STEMKit does and how the tools fit together.'
            : 'A narrated screen recording with captions, start to finish.'));

        var link = el('a', 'stk-tut-link');
        link.href = watchUrl;
        link.target = '_blank';
        link.rel = 'noopener';
        link.innerHTML = '<span>Watch on YouTube</span><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false"><path d="M6 3h7v7M13 3 5.5 10.5M11 9.5V13H3V5h3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

        host.appendChild(play);
        host.appendChild(text);
        host.appendChild(link);

        play.addEventListener('click', function () {
            var frame = el('div', 'stk-tut-frame');
            var ifr = el('iframe');
            ifr.src = 'https://www.youtube-nocookie.com/embed/' + v.id + '?autoplay=1&rel=0&cc_load_policy=0&enablejsapi=1&origin=' + encodeURIComponent(location.origin);
            ifr.title = v.title;
            ifr.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
            ifr.allowFullscreen = true;
            ifr.referrerPolicy = 'strict-origin-when-cross-origin';
            // cc_load_policy=0 only defers to the viewer's YouTube setting, so also ask
            // the player to drop its captions module once it is up. Captions stay
            // available from the CC button.
            ifr.addEventListener('load', function () { captionsOff(ifr); });
            frame.appendChild(ifr);
            host.classList.add('is-playing');
            host.replaceChild(frame, play);
            ifr.focus();
        });
    }

    function init() {
        var hosts = document.querySelectorAll('[data-tutorial]');
        for (var i = 0; i < hosts.length; i++) build(hosts[i]);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
