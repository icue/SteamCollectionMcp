import { describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '../../src/config.js';
import {
  parseRetryAfterMs,
  sanitizeSecretText,
  Semaphore,
  SteamClientError,
  SteamHttpClient,
} from '../../src/clients/http.js';
import { mapStoreAppType, SteamApiClient } from '../../src/clients/steam.js';
import {
  GET_ITEMS_BY_LANG,
  OWNED_GAMES_FIXTURES,
  STORE_SEARCH_FIXTURES,
  TEST_STEAM_API_KEY,
  TEST_STEAM_ID,
  WISHLIST_FIXTURES,
} from '../fixtures/steam-responses.js';

function makeTestConfig(): ServerConfig {
  return {
    steamApiKey: TEST_STEAM_API_KEY,
    steamId: TEST_STEAM_ID,
    country: 'US',
    language: 'english',
    httpTimeoutMs: 2_000,
    maxConcurrency: 2,
    metadataBatchSize: 50,
    toolTimeoutMs: 30_000,
  };
}

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('SteamHttpClient security, retries, and concurrency', () => {
  it('enforces endpoint allowlist, forbids API key on anonymous endpoints, sets redirect=manual and no Cookie', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return jsonResponse({ response: { items: [] } });
    });

    const http = new SteamHttpClient({
      httpTimeoutMs: 5_000,
      maxConcurrency: 2,
      secrets: [TEST_STEAM_API_KEY],
      fetchFn,
      sleep: async () => {},
    });

    const ctx = { deadlineMs: Date.now() + 30_000 };

    // Anonymous endpoint refuses API key
    await expect(
      http.getJson('GetWishlist', { steamid: TEST_STEAM_ID, key: TEST_STEAM_API_KEY }, ctx),
    ).rejects.toMatchObject({ errorCode: 'upstream_error' });
    expect(fetchFn).not.toHaveBeenCalled();

    // Valid anonymous call
    await http.getJson('GetWishlist', { steamid: TEST_STEAM_ID }, ctx);
    expect(calls).toHaveLength(1);
    const parsedUrl = new URL(calls[0]!.url);
    expect(parsedUrl.protocol).toBe('https:');
    expect(parsedUrl.hostname).toBe('api.steampowered.com');
    expect(parsedUrl.pathname).toBe('/IWishlistService/GetWishlist/v1/');
    expect(parsedUrl.searchParams.has('key')).toBe(false);
    expect(calls[0]!.init?.redirect).toBe('manual');
    expect(calls[0]!.init?.credentials).toBe('omit');
    const hdrs = calls[0]!.init?.headers as Record<string, string>;
    expect(Object.keys(hdrs).map((k) => k.toLowerCase())).not.toContain('cookie');
  });

  it('blocks 3xx redirects without following or retrying', async () => {
    const fetchFn = vi.fn(async () => {
      return new Response('', {
        status: 302,
        headers: { location: `https://evil.example/?leak=${TEST_STEAM_API_KEY}` },
      });
    });

    const http = new SteamHttpClient({
      httpTimeoutMs: 5_000,
      maxConcurrency: 2,
      secrets: [TEST_STEAM_API_KEY],
      fetchFn,
      sleep: async () => {},
    });

    try {
      await http.getJson(
        'GetOwnedGames',
        { key: TEST_STEAM_API_KEY, steamid: TEST_STEAM_ID },
        { deadlineMs: Date.now() + 30_000 },
      );
      expect.unreachable('should reject redirect');
    } catch (err) {
      expect(err).toBeInstanceOf(SteamClientError);
      expect((err as SteamClientError).errorCode).toBe('upstream_error');
      expect((err as Error).message).not.toContain(TEST_STEAM_API_KEY);
      expect((err as Error).message).not.toContain('evil.example');
    }
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('retries 429 and 5xx up to 2 times with Retry-After and backoff/jitter, and respects total deadline', async () => {
    const sleepCalls: number[] = [];
    let attempt = 0;
    const fetchFn = vi.fn(async () => {
      attempt++;
      if (attempt === 1) {
        return new Response('Too Many Requests', { status: 429, headers: { 'retry-after': '1' } });
      }
      if (attempt === 2) {
        return new Response('Service Unavailable', { status: 503 });
      }
      return jsonResponse({ total: 0, items: [] });
    });

    let fakeNow = 1_700_000_000_000;
    const http = new SteamHttpClient({
      httpTimeoutMs: 5_000,
      maxConcurrency: 2,
      baseRetryDelayMs: 200,
      fetchFn,
      now: () => fakeNow,
      random: () => 0.5,
      sleep: async (ms) => {
        sleepCalls.push(ms);
        fakeNow += ms;
      },
    });

    const res = await http.getJson(
      'StoreSearch',
      { term: 'Hades', l: 'english', cc: 'US' },
      { deadlineMs: fakeNow + 30_000 },
    );
    expect(res.data).toEqual({ total: 0, items: [] });
    expect(fetchFn).toHaveBeenCalledTimes(3);
    // Attempt 0 got Retry-After: 1 (1000ms) > backoff (200 + 100 = 300ms) -> 1000ms
    // Attempt 1 got 503 -> backoff (400 + 100 = 500ms)
    expect(sleepCalls).toEqual([1000, 500]);

    // Exhausted 429 retries (1 initial + 2 retries = 3 attempts max)
    const always429 = vi.fn(async () => new Response('', { status: 429 }));
    const http2 = new SteamHttpClient({
      httpTimeoutMs: 5_000,
      maxConcurrency: 2,
      baseRetryDelayMs: 100,
      fetchFn: always429,
      now: () => fakeNow,
      random: () => 0,
      sleep: async () => {},
    });
    await expect(
      http2.getJson('StoreSearch', { term: 'X', l: 'english', cc: 'US' }, { deadlineMs: fakeNow + 30_000 }),
    ).rejects.toMatchObject({ dataStatus: 'rate_limited', errorCode: 'rate_limited' });
    expect(always429).toHaveBeenCalledTimes(3);

    // Retry-After exceeding remaining tool deadline aborts immediately instead of sleeping past deadline
    const longRetryAfter = vi.fn(
      async () => new Response('', { status: 429, headers: { 'retry-after': '120' } }),
    );
    const sleepShouldNotRun = vi.fn(async () => {});
    const http3 = new SteamHttpClient({
      httpTimeoutMs: 5_000,
      maxConcurrency: 2,
      fetchFn: longRetryAfter,
      now: () => fakeNow,
      sleep: sleepShouldNotRun,
    });
    await expect(
      http3.getJson('StoreSearch', { term: 'X', l: 'english', cc: 'US' }, { deadlineMs: fakeNow + 10_000 }),
    ).rejects.toMatchObject({ dataStatus: 'rate_limited', errorCode: 'rate_limited' });
    expect(longRetryAfter).toHaveBeenCalledTimes(1);
    expect(sleepShouldNotRun).not.toHaveBeenCalled();
  });

  it('does NOT retry 400, 401, 403, 404, or invalid JSON, and sanitizes secrets from network errors', async () => {
    for (const status of [400, 401, 403, 404]) {
      const fetchFn = vi.fn(async () => {
        const body =
          status === 403
            ? 'Access is denied. Retrying will not help. Please verify your <pre>key=</pre> parameter.'
            : 'error';
        return new Response(body, { status });
      });

      const http = new SteamHttpClient({
        httpTimeoutMs: 5_000,
        maxConcurrency: 2,
        secrets: [TEST_STEAM_API_KEY],
        fetchFn,
        sleep: async () => {},
      });

      const expectedCode =
        status === 401 || status === 403 ? 'invalid_api_key' : 'upstream_error';
      await expect(
        http.getJson(
          'GetOwnedGames',
          { key: TEST_STEAM_API_KEY, steamid: TEST_STEAM_ID },
          { deadlineMs: Date.now() + 30_000 },
        ),
      ).rejects.toMatchObject({ errorCode: expectedCode });
      expect(fetchFn).toHaveBeenCalledTimes(1);
    }

    // Invalid JSON is not retried
    const badJsonFetch = vi.fn(async () => new Response('<html>broken</html>', { status: 200 }));
    const httpBadJson = new SteamHttpClient({
      httpTimeoutMs: 5_000,
      maxConcurrency: 2,
      fetchFn: badJsonFetch,
      sleep: async () => {},
    });
    await expect(
      httpBadJson.getJson('GetWishlist', { steamid: TEST_STEAM_ID }, { deadlineMs: Date.now() + 30_000 }),
    ).rejects.toMatchObject({ errorCode: 'invalid_response' });
    expect(badJsonFetch).toHaveBeenCalledTimes(1);

    // Network error containing key/URL is sanitized
    const leakyFetch = vi.fn(async () => {
      throw new TypeError(
        `fetch failed for https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=${TEST_STEAM_API_KEY}&steamid=${TEST_STEAM_ID}`,
      );
    });
    const httpLeaky = new SteamHttpClient({
      httpTimeoutMs: 5_000,
      maxConcurrency: 2,
      maxRetries: 0,
      secrets: [TEST_STEAM_API_KEY],
      fetchFn: leakyFetch,
    });
    try {
      await httpLeaky.getJson(
        'GetOwnedGames',
        { key: TEST_STEAM_API_KEY, steamid: TEST_STEAM_ID },
        { deadlineMs: Date.now() + 30_000 },
      );
      expect.unreachable('should throw');
    } catch (err) {
      expect((err as Error).message).not.toContain(TEST_STEAM_API_KEY);
      expect((err as Error).message).not.toContain(TEST_STEAM_ID);
    }

    expect(
      sanitizeSecretText(
        `url=https://api.steampowered.com/x?key=${TEST_STEAM_API_KEY}&foo=1`,
        [TEST_STEAM_API_KEY],
      ),
    ).not.toContain(TEST_STEAM_API_KEY);

    expect(parseRetryAfterMs('5', 1_000_000)).toBe(5_000);
    expect(parseRetryAfterMs(new Date(1_005_000).toUTCString(), 1_000_000)).toBe(5_000);
  });

  it('bounds concurrent in-flight HTTP requests to maxConcurrency', async () => {
    let active = 0;
    let peak = 0;
    const fetchFn = vi.fn(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 20));
      active--;
      return jsonResponse({ total: 0, items: [] });
    });

    const http = new SteamHttpClient({
      httpTimeoutMs: 5_000,
      maxConcurrency: 2,
      fetchFn,
    });
    const ctx = { deadlineMs: Date.now() + 30_000 };
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        http.getJson('StoreSearch', { term: `game${i}`, l: 'english', cc: 'US' }, ctx),
      ),
    );
    expect(peak).toBeLessThanOrEqual(2);
    expect(fetchFn).toHaveBeenCalledTimes(6);
  });

  it('retries transient per-attempt timeouts up to 2 times and aborts cleanly at tool deadline', async () => {
    let calls = 0;
    const fetchFn = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      calls++;
      if (calls <= 2) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        });
      }
      return Promise.resolve(jsonResponse({ total: 0, items: [] }));
    });

    const http = new SteamHttpClient({
      httpTimeoutMs: 30,
      maxConcurrency: 2,
      baseRetryDelayMs: 5,
      fetchFn,
    });

    const res = await http.getJson(
      'StoreSearch',
      { term: 'TimeoutRecovery', l: 'english', cc: 'US' },
      { deadlineMs: Date.now() + 5_000 },
    );
    expect(res.data).toEqual({ total: 0, items: [] });
    expect(calls).toBe(3);
  });

  it('does NOT retry permanent TLS/certificate errors, retries transient network errors, and keeps upstream error details sanitized', async () => {
    const permanentCertCodes = [
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      'SELF_SIGNED_CERT_IN_CHAIN',
      'DEPTH_ZERO_SELF_SIGNED_CERT',
      'CERT_HAS_EXPIRED',
      'ERR_TLS_CERT_ALTNAME_INVALID',
    ];

    for (const code of permanentCertCodes) {
      const fetchFn = vi.fn(async () => {
        const inner = Object.assign(
          new Error(`internal proxy cert CN=corp.internal key=${TEST_STEAM_API_KEY}`),
          { code },
        );
        throw new TypeError('fetch failed', { cause: inner });
      });

      const http = new SteamHttpClient({
        httpTimeoutMs: 2_000,
        maxConcurrency: 1,
        baseRetryDelayMs: 1,
        secrets: [TEST_STEAM_API_KEY],
        fetchFn,
        sleep: async () => {},
      });

      try {
        await http.getJson(
          'GetOwnedGames',
          { key: TEST_STEAM_API_KEY, steamid: TEST_STEAM_ID },
          { deadlineMs: Date.now() + 10_000 },
        );
        expect.unreachable(`expected permanent TLS failure for ${code}`);
      } catch (err) {
        expect(err).toBeInstanceOf(SteamClientError);
        expect((err as SteamClientError).errorCode).toBe('upstream_error');
        expect((err as SteamClientError).dataStatus).toBe('error');
        expect((err as Error).message).toContain('TLS certificate verification failed');
        expect((err as Error).message).not.toContain('corp.internal');
        expect((err as Error).message).not.toContain(TEST_STEAM_API_KEY);
      }
      expect(fetchFn, `permanent TLS code ${code} must be attempted at most once`).toHaveBeenCalledTimes(1);
    }

    // Nested AggregateError containing a permanent TLS error also fails without retrying
    const aggFetch = vi.fn(async () => {
      const innerTls = Object.assign(new Error('unable to verify leaf signature'), {
        code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      });
      const agg = new AggregateError([Object.assign(new Error('net'), { code: 'ENETUNREACH' }), innerTls]);
      throw new TypeError('fetch failed', { cause: agg });
    });
    const httpAgg = new SteamHttpClient({
      httpTimeoutMs: 2_000,
      maxConcurrency: 1,
      baseRetryDelayMs: 1,
      fetchFn: aggFetch,
      sleep: async () => {},
    });
    await expect(
      httpAgg.getJson('StoreSearch', { term: 'Hades', l: 'english', cc: 'US' }, { deadlineMs: Date.now() + 10_000 }),
    ).rejects.toMatchObject({ errorCode: 'upstream_error' });
    expect(aggFetch).toHaveBeenCalledTimes(1);

    // Permanent non-TLS permission / address / protocol / config errors fail on first attempt without retrying
    const permanentNonTlsCodes = [
      'EACCES',
      'EPERM',
      'EAFNOSUPPORT',
      'EPROTONOSUPPORT',
      'EADDRNOTAVAIL',
      'UND_ERR_INVALID_ARG',
      'ERR_INVALID_URL',
    ];
    for (const code of permanentNonTlsCodes) {
      const permFetch = vi.fn(async () => {
        throw new TypeError(`fetch failed ${TEST_STEAM_API_KEY}`, {
          cause: Object.assign(new Error(`local failure ${TEST_STEAM_API_KEY}`), { code }),
        });
      });
      const httpPerm = new SteamHttpClient({
        httpTimeoutMs: 2_000,
        maxConcurrency: 1,
        baseRetryDelayMs: 1,
        secrets: [TEST_STEAM_API_KEY],
        fetchFn: permFetch,
        sleep: async () => {},
      });
      try {
        await httpPerm.getJson(
          'StoreSearch',
          { term: 'Hades', l: 'english', cc: 'US' },
          { deadlineMs: Date.now() + 10_000 },
        );
        expect.unreachable(`expected permanent error for ${code}`);
      } catch (err) {
        expect(err).toBeInstanceOf(SteamClientError);
        expect((err as SteamClientError).errorCode).toBe('upstream_error');
        expect((err as SteamClientError).dataStatus).toBe('error');
        expect((err as Error).message).not.toContain(TEST_STEAM_API_KEY);
      }
      expect(permFetch, `permanent non-TLS code ${code} must be attempted once`).toHaveBeenCalledTimes(1);
    }

    // AggregateError with all-permanent causes fails once; mixed IPv6 EAFNOSUPPORT + IPv4 transient ECONNRESET still retries
    const allPermAggFetch = vi.fn(async () => {
      const agg = new AggregateError([
        Object.assign(new Error('denied v6'), { code: 'EACCES' }),
        Object.assign(new Error('denied v4'), { code: 'EACCES' }),
      ]);
      throw new TypeError('fetch failed', { cause: agg });
    });
    const httpAllPermAgg = new SteamHttpClient({
      httpTimeoutMs: 2_000,
      maxConcurrency: 1,
      baseRetryDelayMs: 1,
      fetchFn: allPermAggFetch,
      sleep: async () => {},
    });
    await expect(
      httpAllPermAgg.getJson('StoreSearch', { term: 'Hades', l: 'english', cc: 'US' }, { deadlineMs: Date.now() + 10_000 }),
    ).rejects.toMatchObject({ errorCode: 'upstream_error' });
    expect(allPermAggFetch).toHaveBeenCalledTimes(1);

    let mixedAggAttempt = 0;
    const mixedAggFetch = vi.fn(async () => {
      mixedAggAttempt++;
      if (mixedAggAttempt <= 2) {
        const agg = new AggregateError([
          Object.assign(new Error('no ipv6'), { code: 'EAFNOSUPPORT' }),
          Object.assign(new Error('reset ipv4'), { code: 'ECONNRESET' }),
        ]);
        throw new TypeError('fetch failed', { cause: agg });
      }
      return jsonResponse({ total: 0, items: [] });
    });
    const httpMixedAgg = new SteamHttpClient({
      httpTimeoutMs: 2_000,
      maxConcurrency: 1,
      baseRetryDelayMs: 1,
      fetchFn: mixedAggFetch,
      sleep: async () => {},
    });
    const mixedRes = await httpMixedAgg.getJson(
      'StoreSearch',
      { term: 'MixedAgg', l: 'english', cc: 'US' },
      { deadlineMs: Date.now() + 10_000 },
    );
    expect(mixedRes.data).toEqual({ total: 0, items: [] });
    expect(mixedAggFetch).toHaveBeenCalledTimes(3);

    // Transient network errors (ECONNRESET, ETIMEDOUT, EPIPE, UND_ERR_CONNECT_TIMEOUT, ERR_TLS_HANDSHAKE_TIMEOUT) DO retry up to 2 times
    for (const transientCode of [
      'ECONNRESET',
      'ETIMEDOUT',
      'EPIPE',
      'UND_ERR_CONNECT_TIMEOUT',
      'ERR_TLS_HANDSHAKE_TIMEOUT',
    ]) {
      let attempt = 0;
      const transientFetch = vi.fn(async () => {
        attempt++;
        if (attempt <= 2) {
          throw new TypeError('fetch failed', {
            cause: Object.assign(new Error('socket dropped'), { code: transientCode }),
          });
        }
        return jsonResponse({ total: 0, items: [] });
      });

      const httpTransient = new SteamHttpClient({
        httpTimeoutMs: 2_000,
        maxConcurrency: 1,
        baseRetryDelayMs: 1,
        fetchFn: transientFetch,
        sleep: async () => {},
      });
      const res = await httpTransient.getJson(
        'StoreSearch',
        { term: 'Recovery', l: 'english', cc: 'US' },
        { deadlineMs: Date.now() + 10_000 },
      );
      expect(res.data).toEqual({ total: 0, items: [] });
      expect(transientFetch, `transient code ${transientCode} should retry`).toHaveBeenCalledTimes(3);
    }
  });

  it('orders Semaphore priorities (high > normal > low) and cleans up cancelled/timed-out waiters', async () => {
    const sem = new Semaphore(1);
    const now = () => Date.now();
    const deadline = now() + 5_000;

    await sem.acquire(deadline, now, undefined, 'normal');

    const order: string[] = [];
    const lowP = sem.acquire(deadline, now, undefined, 'low').then(() => {
      order.push('low');
      sem.release();
    });
    const controller = new AbortController();
    const cancelledP = sem.acquire(deadline, now, controller.signal, 'normal');
    const normalP = sem.acquire(deadline, now, undefined, 'normal').then(() => {
      order.push('normal');
      sem.release();
    });
    const highP = sem.acquire(deadline, now, undefined, 'high').then(() => {
      order.push('high');
      sem.release();
    });

    controller.abort();
    await expect(cancelledP).rejects.toThrow('aborted');

    sem.release();
    await Promise.all([lowP, normalP, highP]);
    expect(order).toEqual(['high', 'normal', 'low']);
  });

  it('never invokes fetch when AbortSignal aborts before slot acquisition, immediately during uncontended acquire, while queued, or in the handoff window, and releases slots cleanly', async () => {
    const ctxBase = () => Date.now() + 10_000;

    // 1. Pre-aborted signal -> 0 fetches, structured cancellation error
    {
      const fetchFn = vi.fn(async () => jsonResponse({ total: 0, items: [] }));
      const http = new SteamHttpClient({ httpTimeoutMs: 5_000, maxConcurrency: 1, fetchFn });
      const ac = new AbortController();
      ac.abort();
      await expect(
        http.getJson('StoreSearch', { term: 'PreAborted', l: 'english', cc: 'US' }, {
          deadlineMs: ctxBase(),
          signal: ac.signal,
        }),
      ).rejects.toMatchObject({
        dataStatus: 'unavailable',
        errorCode: 'timeout',
        endpoint: 'StoreSearch',
        message: expect.stringMatching(/cancelled/i),
      });
      expect(fetchFn).toHaveBeenCalledTimes(0);
    }

    // 2. Immediate abort right after calling getJson (while awaiting uncontended semaphore.acquire) -> 0 fetches, slot released
    {
      const fetchFn = vi.fn(async () => jsonResponse({ total: 0, items: [] }));
      const http = new SteamHttpClient({ httpTimeoutMs: 5_000, maxConcurrency: 1, fetchFn });
      const ac = new AbortController();
      const pending = http.getJson('StoreSearch', { term: 'RaceAcquire', l: 'english', cc: 'US' }, {
        deadlineMs: ctxBase(),
        signal: ac.signal,
      });
      ac.abort();
      await expect(pending).rejects.toMatchObject({
        dataStatus: 'unavailable',
        errorCode: 'timeout',
        endpoint: 'StoreSearch',
        message: expect.stringMatching(/cancelled/i),
      });
      expect(fetchFn).toHaveBeenCalledTimes(0);

      // Slot MUST be released so subsequent normal request succeeds immediately
      const ok = await http.getJson('StoreSearch', { term: 'Healthy', l: 'english', cc: 'US' }, {
        deadlineMs: ctxBase(),
      });
      expect(ok.data).toEqual({ total: 0, items: [] });
      expect(fetchFn).toHaveBeenCalledTimes(1);
    }

    // 3. Abort while queued behind an active request AND abort in the handoff window -> 0 fetches for aborted callers, next request runs
    {
      let releaseFirst!: () => void;
      const firstEntered = new Promise<void>((resolve) => {
        // resolved inside fetchFn on call 1
        releaseFirst = resolve;
      });
      let finishFirst!: (resp: Response) => void;
      const firstResponsePromise = new Promise<Response>((resolve) => {
        finishFirst = resolve;
      });

      const fetchedTerms: string[] = [];
      const fetchFn = vi.fn(async (input: string | URL | Request) => {
        const term = new URL(String(input)).searchParams.get('term') ?? '';
        fetchedTerms.push(term);
        if (term === 'First') {
          releaseFirst();
          return await firstResponsePromise;
        }
        return jsonResponse({ total: 0, items: [] });
      });

      const http = new SteamHttpClient({ httpTimeoutMs: 5_000, maxConcurrency: 1, fetchFn });
      const p1 = http.getJson('StoreSearch', { term: 'First', l: 'english', cc: 'US' }, { deadlineMs: ctxBase() });
      await firstEntered;

      const acQueued = new AbortController();
      const pQueued = http.getJson('StoreSearch', { term: 'QueuedAborted', l: 'english', cc: 'US' }, {
        deadlineMs: ctxBase(),
        signal: acQueued.signal,
      });

      const acHandoff = new AbortController();
      const pHandoff = http.getJson('StoreSearch', { term: 'HandoffAborted', l: 'english', cc: 'US' }, {
        deadlineMs: ctxBase(),
        signal: acHandoff.signal,
      });

      const pFinal = http.getJson('StoreSearch', { term: 'FinalHealthy', l: 'english', cc: 'US' }, {
        deadlineMs: ctxBase(),
      });

      // Abort queued waiter BEFORE handoff
      acQueued.abort();
      await expect(pQueued).rejects.toMatchObject({
        dataStatus: 'unavailable',
        errorCode: 'timeout',
        message: expect.stringMatching(/cancelled/i),
      });

      // Finish first request (hands off slot to pHandoff), then abort pHandoff in the same turn before its continuation starts fetch
      finishFirst(jsonResponse({ total: 0, items: [] }));
      acHandoff.abort();

      await expect(p1).resolves.toMatchObject({ data: { total: 0, items: [] } });
      await expect(pHandoff).rejects.toMatchObject({
        dataStatus: 'unavailable',
        errorCode: 'timeout',
        message: expect.stringMatching(/cancelled/i),
      });
      await expect(pFinal).resolves.toMatchObject({ data: { total: 0, items: [] } });
      expect(fetchedTerms).toEqual(['First', 'FinalHealthy']);
    }

    // 4. Abort during in-flight fetch does NOT retry and releases slot for subsequent requests
    {
      let calls = 0;
      const ac = new AbortController();
      const fetchFn = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
        calls++;
        if (calls === 1) {
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
              once: true,
            });
            queueMicrotask(() => ac.abort());
          });
        }
        return Promise.resolve(jsonResponse({ total: 0, items: [] }));
      });
      const http = new SteamHttpClient({
        httpTimeoutMs: 5_000,
        maxConcurrency: 1,
        maxRetries: 2,
        baseRetryDelayMs: 1,
        fetchFn,
      });
      await expect(
        http.getJson('StoreSearch', { term: 'InFlightAbort', l: 'english', cc: 'US' }, {
          deadlineMs: ctxBase(),
          signal: ac.signal,
        }),
      ).rejects.toMatchObject({
        dataStatus: 'unavailable',
        errorCode: 'timeout',
        message: expect.stringMatching(/cancelled/i),
      });
      expect(calls).toBe(1);

      const next = await http.getJson('StoreSearch', { term: 'AfterInFlightAbort', l: 'english', cc: 'US' }, {
        deadlineMs: ctxBase(),
      });
      expect(next.data).toEqual({ total: 0, items: [] });
      expect(calls).toBe(2);
    }
  });
});

describe('SteamApiClient strict response validation', () => {
  it('validates GetOwnedGames empty vs missing game_count vs count contradiction', async () => {
    const cfg = makeTestConfig();
    const ctx = { deadlineMs: Date.now() + 30_000 };

    const makeClient = (payload: unknown) => {
      const http = new SteamHttpClient({
        httpTimeoutMs: 5_000,
        maxConcurrency: 2,
        secrets: [cfg.steamApiKey],
        fetchFn: async () => jsonResponse(payload),
      });
      return new SteamApiClient(http, cfg);
    };

    // Valid populated
    const populated = await makeClient(OWNED_GAMES_FIXTURES.sample).getOwnedGames(ctx, {
      includeAppInfo: true,
    });
    expect(populated.gameCount).toBe(5);
    expect(populated.games).toHaveLength(5);

    // Valid explicit empty (array or omitted games with game_count=0)
    const emptyArr = await makeClient(OWNED_GAMES_FIXTURES.explicit_empty_with_array).getOwnedGames(
      ctx,
      { includeAppInfo: false },
    );
    expect(emptyArr.games).toEqual([]);
    const emptyOmitted = await makeClient(
      OWNED_GAMES_FIXTURES.explicit_empty_omitted_games,
    ).getOwnedGames(ctx, { includeAppInfo: false });
    expect(emptyOmitted.games).toEqual([]);

    // Missing game_count (e.g. { response: {} }) MUST fail, never return empty
    await expect(
      makeClient(OWNED_GAMES_FIXTURES.unconfirmable_empty_object).getOwnedGames(ctx, {
        includeAppInfo: false,
      }),
    ).rejects.toMatchObject({ dataStatus: 'unavailable', errorCode: 'invalid_response' });

    // Contradictory game_count=0 with games
    await expect(
      makeClient(OWNED_GAMES_FIXTURES.contradictory_zero_count_with_games).getOwnedGames(ctx, {
        includeAppInfo: false,
      }),
    ).rejects.toMatchObject({ errorCode: 'invalid_response' });

    // Contradictory game_count mismatch
    await expect(
      makeClient(OWNED_GAMES_FIXTURES.contradictory_count_mismatch).getOwnedGames(ctx, {
        includeAppInfo: false,
      }),
    ).rejects.toMatchObject({ errorCode: 'invalid_response' });
  });

  it('parses valid uint32 rtime_last_played and tolerates missing, zero, or malformed values without failing or dropping games', async () => {
    const cfg = makeTestConfig();
    const ctx = { deadlineMs: Date.now() + 30_000 };

    const makeClient = (payload: unknown) => {
      const http = new SteamHttpClient({
        httpTimeoutMs: 5_000,
        maxConcurrency: 2,
        secrets: [cfg.steamApiKey],
        fetchFn: async () => jsonResponse(payload),
      });
      return new SteamApiClient(http, cfg);
    };

    const res = await makeClient({
      response: {
        game_count: 11,
        games: [
          { appid: 1, name: 'Min Valid', playtime_forever: 10, rtime_last_played: 1 },
          { appid: 2, name: 'Max Uint32', playtime_forever: 20, rtime_last_played: 4_294_967_295 },
          { appid: 3, name: 'Missing', playtime_forever: 500 },
          { appid: 4, name: 'Zero', playtime_forever: 600, rtime_last_played: 0 },
          { appid: 5, name: 'Negative', playtime_forever: 700, rtime_last_played: -1 },
          { appid: 6, name: 'Float', playtime_forever: 800, rtime_last_played: 1_700_000_000.5 },
          { appid: 7, name: 'Overflow', playtime_forever: 900, rtime_last_played: 4_294_967_296 },
          { appid: 8, name: 'String', playtime_forever: 1000, rtime_last_played: '1700000000' },
          { appid: 9, name: 'Null', playtime_forever: 1100, rtime_last_played: null },
          { appid: 10, name: 'Boolean', playtime_forever: 1200, rtime_last_played: true },
          { appid: 11, name: 'Object', playtime_forever: 1300, rtime_last_played: { ts: 1700000000 } },
        ],
      },
    }).getOwnedGames(ctx, { includeAppInfo: true });

    expect(res.games).toHaveLength(11);
    expect(res.games.map((g) => [g.appid, g.lastPlayedAt])).toEqual([
      [1, 1],
      [2, 4_294_967_295],
      [3, null],
      [4, null],
      [5, null],
      [6, null],
      [7, null],
      [8, null],
      [9, null],
      [10, null],
      [11, null],
    ]);

    // Strict validation on core fields still rejects malformed appid or negative playtime_forever
    await expect(
      makeClient({
        response: {
          game_count: 1,
          games: [{ appid: 1, playtime_forever: -5, rtime_last_played: 1_700_000_000 }],
        },
      }).getOwnedGames(ctx, { includeAppInfo: false }),
    ).rejects.toMatchObject({ errorCode: 'invalid_response' });
  });

  it('validates GetWishlist explicit empty array vs unconfirmable missing items', async () => {
    const cfg = makeTestConfig();
    const ctx = { deadlineMs: Date.now() + 30_000 };

    const makeClient = (payload: unknown) => {
      const http = new SteamHttpClient({
        httpTimeoutMs: 5_000,
        maxConcurrency: 2,
        fetchFn: async () => jsonResponse(payload),
      });
      return new SteamApiClient(http, cfg);
    };

    const empty = await makeClient(WISHLIST_FIXTURES.explicit_empty).getWishlist(ctx);
    expect(empty.items).toEqual([]);

    await expect(
      makeClient(WISHLIST_FIXTURES.observed_unconfirmable_empty_object).getWishlist(ctx),
    ).rejects.toMatchObject({ dataStatus: 'unavailable', errorCode: 'invalid_response' });
  });

  it('filters StoreSearch strictly to type=app with valid uint32 IDs', async () => {
    const cfg = makeTestConfig();
    const http = new SteamHttpClient({
      httpTimeoutMs: 5_000,
      maxConcurrency: 2,
      fetchFn: async () => jsonResponse(STORE_SEARCH_FIXTURES.mixed_non_app_types),
    });
    const client = new SteamApiClient(http, cfg);
    const res = await client.storeSearch(
      { deadlineMs: Date.now() + 30_000 },
      { term: 'Cyberpunk 2077', language: 'english' },
    );
    expect(res.items).toEqual([{ appid: 1091500, name: 'Cyberpunk 2077' }]);
  });

  it('correlates GetItems strictly by AppID regardless of array order and preserves unknown types', async () => {
    const cfg = makeTestConfig();
    // Return items in reversed order + include invalid appid (success=15, appid=0) + unknown type 99
    const responsePayload = {
      response: {
        store_items: [
          GET_ITEMS_BY_LANG['english']![999999999],
          GET_ITEMS_BY_LANG['english']![500099],
          GET_ITEMS_BY_LANG['english']![2138330],
          GET_ITEMS_BY_LANG['english']![1091500],
        ],
      },
    };
    const http = new SteamHttpClient({
      httpTimeoutMs: 5_000,
      maxConcurrency: 2,
      fetchFn: async () => jsonResponse(responsePayload),
    });
    const client = new SteamApiClient(http, cfg);
    const res = await client.getItems(
      { deadlineMs: Date.now() + 30_000 },
      { appids: [1091500, 2138330, 500099, 999999999, 777777777], language: 'english' },
    );

    expect(res.itemsByAppId.get(1091500)).toMatchObject({
      appid: 1091500,
      found: true,
      name: 'Cyberpunk 2077',
      appType: 'game',
    });
    expect(res.itemsByAppId.get(2138330)).toMatchObject({
      appid: 2138330,
      found: true,
      appType: 'dlc',
    });
    expect(res.itemsByAppId.get(500099)).toMatchObject({
      appid: 500099,
      found: true,
      appType: 'unknown',
    });
    expect(res.itemsByAppId.get(999999999)).toMatchObject({
      appid: 999999999,
      found: false,
      name: null,
      appType: 'unknown',
    });
    // Completely omitted AppID still gets explicit not-found entry
    expect(res.itemsByAppId.get(777777777)).toMatchObject({
      appid: 777777777,
      found: false,
      name: null,
      appType: 'unknown',
    });

    expect(mapStoreAppType(0)).toBe('game');
    expect(mapStoreAppType(1)).toBe('demo');
    expect(mapStoreAppType(4)).toBe('dlc');
    expect(mapStoreAppType(6)).toBe('software');
    expect(mapStoreAppType(11)).toBe('music');
    expect(mapStoreAppType(14)).toBe('advertising');
    expect(mapStoreAppType(999)).toBe('unknown');
    expect(mapStoreAppType(undefined)).toBe('unknown');
  });
});
