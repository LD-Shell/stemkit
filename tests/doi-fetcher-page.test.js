/**
 * The request behind the DOI to BibTeX page (js/doi-fetcher.js): the time
 * limit, what happens when a server limits requests, and the check that a
 * reply is BibTeX. `fetch` and the waits are stood in for, so nothing here
 * goes to the network or takes real time. The page itself is checked in a
 * browser.
 */

import { describe, test, expect } from '@jest/globals';
import '../tests/setup.js';
import {
  fetchBibtex, retryAfterSeconds, spellSeconds, DoiError,
  REQUEST_TIMEOUT_MS, RATE_LIMIT_RETRIES, RATE_LIMIT_WAIT_S, RATE_LIMIT_MAX_WAIT_S
} from '../js/doi-fetcher.js';

const DOI = '10.1038/s41586-020-2649-2';
const CROSSREF = 'https://api.crossref.org/v1/works/10.1038%2Fs41586-020-2649-2/transform';
// What doi.org sends for this DOI, shortened: one line, a space in front.
const ENTRY = ' @article{Harris_2020, title={Array programming with NumPy}, volume={585}, ' +
  'DOI={10.1038/s41586-020-2649-2}, journal={Nature}, year={2020}, month=sep, pages={357–362} }\n';

/** A reply as `fetch` gives it, after any redirect: `url` is who answered. */
const reply = (status, body = '', { url = CROSSREF, headers = {}, statusText = '' } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText,
  url,
  headers: new Headers(headers),
  text: async () => body
});

/** A `fetch` that gives the replies in turn, and records what was asked. */
function fakeFetch(...replies) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    const next = replies[Math.min(calls.length - 1, replies.length - 1)];
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetch, calls };
}

/** A `sleep` that returns at once and records how long it was asked for. */
function fakeSleep() {
  const waits = [];
  return { sleep: async (ms) => { waits.push(ms); }, waits };
}

const failure = async (promise) => {
  try { await promise; } catch (err) { return err; }
  throw new Error('expected the request to fail');
};

describe('retryAfterSeconds', () => {
  test('reads a number of seconds', () => {
    expect(retryAfterSeconds('120')).toBe(120);
    expect(retryAfterSeconds(' 5 ')).toBe(5);
    expect(retryAfterSeconds('0')).toBe(0);
  });

  test('reads an HTTP date as the seconds until it, never less than none', () => {
    // The example dates of RFC 9110, section 5.6.7: the form servers send,
    // and the older one with the day's name in full.
    const now = Date.UTC(1994, 10, 6, 8, 49, 0);
    expect(retryAfterSeconds('Sun, 06 Nov 1994 08:49:37 GMT', now)).toBe(37);
    expect(retryAfterSeconds('Sunday, 06-Nov-94 08:49:37 GMT', now)).toBe(37);
    expect(retryAfterSeconds('Sun, 06 Nov 1994 08:48:00 GMT', now)).toBe(0);
  });

  test('gives null when there is no header or it is neither', () => {
    for (const value of [null, undefined, '', '  ', 'soon', '1.5', '-5', '12 seconds']) {
      expect(retryAfterSeconds(value)).toBeNull();
    }
  });
});

describe('spellSeconds', () => {
  test('seconds, then minutes', () => {
    expect(spellSeconds(10)).toBe('10 s');
    expect(spellSeconds(60)).toBe('60 s');
    expect(spellSeconds(120)).toBe('2 minutes');
    expect(spellSeconds(3600)).toBe('60 minutes');
  });
});

describe('fetchBibtex: a reply that is an entry', () => {
  test('returns the entry, trimmed', async () => {
    const { fetch } = fakeFetch(reply(200, ENTRY));
    expect(await fetchBibtex(DOI, { fetch })).toBe(ENTRY.trim());
  });

  test('asks doi.org for BibTeX, with a signal that can stop the request', async () => {
    const { fetch, calls } = fakeFetch(reply(200, ENTRY));
    await fetchBibtex(DOI, { fetch });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://doi.org/10.1038/s41586-020-2649-2');
    expect(calls[0].init.headers.Accept).toBe('application/x-bibtex; charset=utf-8');
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
    expect(calls[0].init.signal.aborted).toBe(false);
  });

  test('escapes a DOI whose characters would cut the address short', async () => {
    const { fetch, calls } = fakeFetch(reply(200, ENTRY));
    await fetchBibtex('10.1000/456#789', { fetch });
    expect(calls[0].url).toBe('https://doi.org/10.1000/456%23789');
  });
});

describe('fetchBibtex: a reply that is not an entry', () => {
  test('a web page with status 200 is a failure', async () => {
    const page = '<!DOCTYPE html>\n<html><head><title>Error: DOI Not Found</title></head><body></body></html>';
    const err = await failure(fetchBibtex(DOI, fakeFetch(reply(200, page, { url: 'https://data.crosscite.org/x' }))));
    expect(err).toBeInstanceOf(DoiError);
    expect(err.message).toBe('data.crosscite.org sent a web page, not BibTeX.');
    expect(err.rateLimited).toBe(false);
  });

  test('an empty reply is a failure', async () => {
    for (const body of ['', '  \n']) {
      const err = await failure(fetchBibtex(DOI, fakeFetch(reply(200, body))));
      expect(err.message).toBe('api.crossref.org sent an empty reply.');
    }
  });

  test('text or JSON that is not an entry is a failure', async () => {
    for (const body of ['Resource not found.', '{"status":"error"}', '@article{Harris_2020, title={Cut off']) {
      const err = await failure(fetchBibtex(DOI, fakeFetch(reply(200, body))));
      expect(err.message).toBe('api.crossref.org sent a reply that is not a BibTeX entry.');
    }
  });
});

describe('fetchBibtex: statuses, named after the server that answered', () => {
  test('404 from doi.org: the DOI is not known', async () => {
    const err = await failure(fetchBibtex(DOI, fakeFetch(reply(404, '<html>', { url: `https://doi.org/${DOI}` }))));
    expect(err.message).toBe('doi.org does not know this DOI (404). Check it for a typing mistake.');
  });

  test('404 from the agency doi.org passed the lookup to', async () => {
    const err = await failure(fetchBibtex(DOI, fakeFetch(reply(404))));
    expect(err.message).toBe('api.crossref.org has no record of this DOI (404).');
  });

  test('406: the agency has no BibTeX for it', async () => {
    const err = await failure(fetchBibtex(DOI, fakeFetch(reply(406, '', { url: 'https://data.medra.org/x' }))));
    expect(err.message).toBe('data.medra.org cannot give this DOI as BibTeX (406).');
  });

  test('any other status is given with its text', async () => {
    const err = await failure(fetchBibtex(DOI, fakeFetch(reply(503, '', { statusText: 'Service Unavailable' }))));
    expect(err.message).toBe('api.crossref.org answered 503 Service Unavailable.');
    const bare = await failure(fetchBibtex(DOI, fakeFetch(reply(500))));
    expect(bare.message).toBe('api.crossref.org answered 500.');
  });

  test('a reply that does not say where it came from is "The server"', async () => {
    const err = await failure(fetchBibtex(DOI, fakeFetch(reply(500, '', { url: '' }))));
    expect(err.message).toBe('The server answered 500.');
  });

  test('a status that is not 200 is not asked for again', async () => {
    const { fetch, calls } = fakeFetch(reply(503));
    await failure(fetchBibtex(DOI, { fetch }));
    expect(calls).toHaveLength(1);
  });
});

describe('fetchBibtex: no reply', () => {
  /** A `fetch` that never answers, and fails as the browser's does when stopped. */
  const silent = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
  });

  test('a request with no reply in time is stopped and reported', async () => {
    const started = Date.now();
    const err = await failure(fetchBibtex(DOI, { fetch: silent, timeoutMs: 30 }));
    expect(err).toBeInstanceOf(DoiError);
    expect(err.message).toBe('No reply within 0 s.');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test('the message gives the limit the page uses', async () => {
    // The limit itself is not waited for: the timer is made to fire at once.
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn) => realSetTimeout(fn, 0);
    try {
      const err = await failure(fetchBibtex(DOI, { fetch: silent }));
      expect(err.message).toBe(`No reply within ${REQUEST_TIMEOUT_MS / 1000} s.`);
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });

  test('a reply that stalls after its headers is stopped too', async () => {
    let signal;
    const fetch = async (url, init) => {
      signal = init.signal;
      return {
        ...reply(200),
        text: () => new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
        })
      };
    };
    const err = await failure(fetchBibtex(DOI, { fetch, timeoutMs: 30 }));
    expect(err.message).toBe('No reply within 0 s.');
    expect(signal.aborted).toBe(true);
  });

  test('a request the browser could not complete says what that can mean', async () => {
    const err = await failure(fetchBibtex(DOI, fakeFetch(new TypeError('Failed to fetch'))));
    expect(err).toBeInstanceOf(DoiError);
    expect(err.message).toBe('No reply the browser could read. The connection failed, or the agency ' +
      'that registered this DOI does not answer lookups from a web page.');
    expect(err.rateLimited).toBe(false);
  });

  test('the timer is stopped once a reply is in', async () => {
    const realClear = globalThis.clearTimeout;
    let cleared = 0;
    globalThis.clearTimeout = (id) => { cleared++; realClear(id); };
    try {
      await fetchBibtex(DOI, fakeFetch(reply(200, ENTRY)));
    } finally {
      globalThis.clearTimeout = realClear;
    }
    expect(cleared).toBe(1);
  });
});

describe('fetchBibtex: 429 Too Many Requests', () => {
  const limited = (headers = {}) => reply(429, '', { headers, statusText: 'Too Many Requests' });

  test('waits as long as Retry-After asks, then asks again', async () => {
    const { fetch, calls } = fakeFetch(limited({ 'Retry-After': '7' }), reply(200, ENTRY));
    const { sleep, waits } = fakeSleep();
    const told = [];
    const bib = await fetchBibtex(DOI, { fetch, sleep, onWait: w => told.push(['wait', w]), onRetry: w => told.push(['retry', w]) });
    expect(bib).toBe(ENTRY.trim());
    expect(calls).toHaveLength(2);
    expect(waits).toEqual([7000]);
    const wait = { who: 'api.crossref.org', seconds: 7, asked: true, attempt: 1, retries: RATE_LIMIT_RETRIES };
    expect(told).toEqual([['wait', wait], ['retry', wait]]);
  });

  test('reads Retry-After given as a date', async () => {
    const at = new Date(Date.now() + 30000).toUTCString();
    const { fetch } = fakeFetch(limited({ 'Retry-After': at }), reply(200, ENTRY));
    const { sleep, waits } = fakeSleep();
    await fetchBibtex(DOI, { fetch, sleep });
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThanOrEqual(29000);
    expect(waits[0]).toBeLessThanOrEqual(31000);
  });

  test('with no Retry-After it waits 10 s, then twice that', async () => {
    const { fetch, calls } = fakeFetch(limited(), limited(), reply(200, ENTRY));
    const { sleep, waits } = fakeSleep();
    const told = [];
    await fetchBibtex(DOI, { fetch, sleep, onWait: w => told.push(w) });
    expect(calls).toHaveLength(3);
    expect(waits).toEqual([RATE_LIMIT_WAIT_S * 1000, RATE_LIMIT_WAIT_S * 2000]);
    expect(told.map(w => [w.seconds, w.asked, w.attempt])).toEqual([[10, false, 1], [20, false, 2]]);
  });

  test('gives up after the tries allowed, and says so', async () => {
    const { fetch, calls } = fakeFetch(limited());
    const { sleep, waits } = fakeSleep();
    const err = await failure(fetchBibtex(DOI, { fetch, sleep }));
    expect(calls).toHaveLength(1 + RATE_LIMIT_RETRIES);
    expect(waits).toHaveLength(RATE_LIMIT_RETRIES);
    expect(err).toBeInstanceOf(DoiError);
    expect(err.rateLimited).toBe(true);
    expect(err.message).toBe('api.crossref.org is limiting requests (429), and still was after 2 more tries. ' +
      'Try again in a few minutes.');
  });

  test('the number of tries can be set', async () => {
    const { fetch, calls } = fakeFetch(limited());
    const { sleep } = fakeSleep();
    const err = await failure(fetchBibtex(DOI, { fetch, sleep, retries: 1 }));
    expect(calls).toHaveLength(2);
    expect(err.message).toContain('still was after 1 more try.');
    const none = fakeFetch(limited());
    await failure(fetchBibtex(DOI, { fetch: none.fetch, sleep, retries: 0 }));
    expect(none.calls).toHaveLength(1);
  });

  test('a wait longer than a minute is not sat out', async () => {
    const { fetch, calls } = fakeFetch(limited({ 'Retry-After': '3600' }));
    const { sleep, waits } = fakeSleep();
    const err = await failure(fetchBibtex(DOI, { fetch, sleep }));
    expect(calls).toHaveLength(1);
    expect(waits).toEqual([]);
    expect(err.rateLimited).toBe(true);
    expect(err.message).toBe('api.crossref.org is limiting requests (429) and asked for a wait of 60 minutes. ' +
      'Try again after that.');
  });

  test('the longest wait that is sat out is the limit itself', async () => {
    const { fetch } = fakeFetch(limited({ 'Retry-After': String(RATE_LIMIT_MAX_WAIT_S) }), reply(200, ENTRY));
    const { sleep, waits } = fakeSleep();
    await fetchBibtex(DOI, { fetch, sleep });
    expect(waits).toEqual([RATE_LIMIT_MAX_WAIT_S * 1000]);
  });

  test('each try has its own time limit', async () => {
    const signals = [];
    const { fetch } = fakeFetch(limited({ 'Retry-After': '1' }), reply(200, ENTRY));
    const { sleep } = fakeSleep();
    await fetchBibtex(DOI, { fetch: (url, init) => { signals.push(init.signal); return fetch(url, init); }, sleep });
    expect(signals).toHaveLength(2);
    expect(signals[0]).not.toBe(signals[1]);
    expect(signals.every(s => !s.aborted)).toBe(true);
  });
});
