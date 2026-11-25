import assert from 'node:assert/strict';
import type { Client } from '@modelcontextprotocol/client';
import type { FetchFn } from '../../src/clients/http.js';
import {
  GameStatusOutputSchema,
  ListOwnedGamesOutputSchema,
  ListWishlistGamesOutputSchema,
  type GameStatusOutput,
  type ListOwnedGamesOutput,
  type ListWishlistGamesOutput,
} from '../../src/schemas.js';
import { isValidAppId, parseDirectIdentifier } from '../../src/utils/identity.js';

export interface EndpointCallCounts {
  owned: number;
  wishlist: number;
  search: number;
  items: number;
}

export interface ReadOnlyFetchObserver {
  readonly fetchFn: FetchFn;
  readonly counts: EndpointCallCounts;
  getLastRawOwnedPayload(): unknown;
  getLastRawWishlistPayload(): unknown;
}

/**
 * Wraps a fetch implementation purely to observe endpoint call counts and clone
 * HTTP 200 JSON payloads for independent cross-checking. Never modifies requests
 * or responses, never performs write methods, and never records secrets/keys.
 */
export function createReadOnlyFetchObserver(
  baseFetch: FetchFn = globalThis.fetch.bind(globalThis),
): ReadOnlyFetchObserver {
  const counts: EndpointCallCounts = { owned: 0, wishlist: 0, search: 0, items: 0 };
  let lastRawOwnedPayload: unknown = null;
  let lastRawWishlistPayload: unknown = null;

  const fetchFn: FetchFn = async (input, init) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    assert.equal(method, 'GET', `Read-only invariant violated: unexpected HTTP method ${method}`);

    const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(rawUrl);

    if (url.pathname === '/IPlayerService/GetOwnedGames/v1/') {
      counts.owned++;
    } else if (url.pathname === '/IWishlistService/GetWishlist/v1/') {
      counts.wishlist++;
    } else if (url.pathname === '/api/storesearch/') {
      counts.search++;
    } else if (url.pathname === '/IStoreBrowseService/GetItems/v1/') {
      counts.items++;
    }

    const response = await baseFetch(input, init);

    if (response.status >= 200 && response.status < 300) {
      if (url.pathname === '/IPlayerService/GetOwnedGames/v1/') {
        try {
          lastRawOwnedPayload = await response.clone().json();
        } catch {
          lastRawOwnedPayload = null;
        }
      } else if (url.pathname === '/IWishlistService/GetWishlist/v1/') {
        try {
          lastRawWishlistPayload = await response.clone().json();
        } catch {
          lastRawWishlistPayload = null;
        }
      }
    }

    return response;
  };

  return {
    fetchFn,
    counts,
    getLastRawOwnedPayload: () => lastRawOwnedPayload,
    getLastRawWishlistPayload: () => lastRawWishlistPayload,
  };
}

export function parseStructuredToolResult<T>(
  raw: {
    isError?: boolean;
    content: Array<{ type: string; text?: string }>;
    structuredContent?: unknown;
  },
  schema: { parse: (val: unknown) => T },
): T {
  assert.notEqual(raw.isError, true, 'Expected MCP tool call to succeed (isError !== true).');
  assert.equal(raw.content.length, 1, 'Expected exactly 1 content block.');
  const text = raw.content[0]?.text;
  assert.equal(typeof text, 'string', 'Expected JSON text content.');
  const parsedText: unknown = JSON.parse(text!);
  assert.deepEqual(
    raw.structuredContent,
    parsedText,
    'Expected structuredContent to match content[0].text JSON.',
  );
  return schema.parse(raw.structuredContent);
}

export interface LargeLibraryVerificationSummary {
  readonly gameCount: number;
  readonly rawRecordCount: number;
  readonly uniqueAppIdCount: number;
  readonly toolTotal: number;
  readonly pageReturned: number;
  readonly ownedFetchCount: number;
  readonly fetchedAt: string;
}

/**
 * Strictly verifies a real large owned library (>= minGames, default 2000):
 * - Invokes list_owned_games once (include_metadata=false)
 * - Asserts GetOwnedGames was called exactly ONCE
 * - Cross-checks game_count, raw games.length, full deduplicated unique AppIDs,
 *   tool total, and exact ascending AppID page contents against that same raw upstream response.
 */
export async function verifyLargeOwnedLibrary(params: {
  client: Client;
  observer: ReadOnlyFetchObserver;
  minGames?: number;
  pageLimit?: number;
}): Promise<LargeLibraryVerificationSummary> {
  const minGames = params.minGames ?? 2_000;
  const pageLimit = params.pageLimit ?? 50;
  const beforeOwnedCalls = params.observer.counts.owned;

  const rawResult = await params.client.callTool({
    name: 'list_owned_games',
    arguments: { offset: 0, limit: pageLimit, include_metadata: false },
  });
  const out: ListOwnedGamesOutput = parseStructuredToolResult(
    rawResult as never,
    ListOwnedGamesOutputSchema,
  );

  const ownedCallsDelta = params.observer.counts.owned - beforeOwnedCalls;
  assert.equal(
    ownedCallsDelta,
    1,
    `Expected exactly 1 upstream GetOwnedGames call, observed ${ownedCallsDelta}.`,
  );

  const rawPayload = params.observer.getLastRawOwnedPayload() as {
    response?: { game_count?: unknown; games?: unknown };
  } | null;
  assert(
    rawPayload !== null && typeof rawPayload === 'object' && rawPayload.response !== undefined,
    'Missing raw upstream GetOwnedGames payload for independent verification.',
  );

  const rawGameCount = rawPayload.response.game_count;
  const rawGames = rawPayload.response.games;
  assert(
    typeof rawGameCount === 'number' && Number.isInteger(rawGameCount),
    'Raw upstream GetOwnedGames response missing integer game_count.',
  );
  assert(
    Array.isArray(rawGames),
    'Raw upstream GetOwnedGames response missing games array.',
  );

  assert(
    rawGameCount >= minGames,
    `Large library gate failed: upstream game_count (${rawGameCount}) is below required threshold (${minGames}).`,
  );
  assert.equal(
    rawGames.length,
    rawGameCount,
    `Raw GetOwnedGames record count (${rawGames.length}) does not match game_count (${rawGameCount}).`,
  );

  const uniqueSet = new Set<number>();
  for (const entry of rawGames as Array<{ appid?: unknown }>) {
    assert(
      typeof entry?.appid === 'number' && isValidAppId(entry.appid),
      'Raw GetOwnedGames entry contains invalid appid.',
    );
    uniqueSet.add(entry.appid);
  }
  const uniqueSortedAppIds = [...uniqueSet].sort((a, b) => a - b);

  assert(
    uniqueSortedAppIds.length >= minGames,
    `Large library gate failed: unique AppID count (${uniqueSortedAppIds.length}) is below required threshold (${minGames}).`,
  );
  assert.equal(
    uniqueSortedAppIds.length,
    rawGameCount,
    `Large library gate failed: unique AppID count (${uniqueSortedAppIds.length}) does not equal raw game_count (${rawGameCount}) and raw record count (${rawGames.length}).`,
  );

  assert.equal(out.data_status, 'ok');
  assert.equal(out.metadata_status, 'skipped');
  assert.equal(
    out.total,
    uniqueSortedAppIds.length,
    `Tool total (${out.total}) does not match raw unique AppID count (${uniqueSortedAppIds.length}).`,
  );
  assert.equal(
    out.total,
    rawGameCount,
    `Tool total (${out.total}) does not equal raw game_count (${rawGameCount}).`,
  );
  const expectedReturned = Math.min(pageLimit, uniqueSortedAppIds.length);
  assert.equal(out.returned, expectedReturned);
  assert.equal(out.has_more, expectedReturned < out.total);
  assert.deepEqual(
    out.games.map((g) => g.appid),
    uniqueSortedAppIds.slice(0, expectedReturned),
    'Tool first page AppIDs do not match ascending sorted unique AppIDs from raw GetOwnedGames.',
  );

  return {
    gameCount: rawGameCount,
    rawRecordCount: rawGames.length,
    uniqueAppIdCount: uniqueSortedAppIds.length,
    toolTotal: out.total,
    pageReturned: out.returned,
    ownedFetchCount: ownedCallsDelta,
    fetchedAt: out.fetched_at,
  };
}

export interface IndependentWishlistEntry {
  readonly appid: number;
  readonly priority: number | null;
  readonly date_added: number | null;
}

/**
 * Independently fetches and normalizes the public wishlist directly from Steam's
 * anonymous IWishlistService/GetWishlist/v1/ endpoint (read-only, no API key).
 */
export async function fetchIndependentPublicWishlist(
  steamId: string,
  fetchFn: FetchFn = globalThis.fetch.bind(globalThis),
): Promise<IndependentWishlistEntry[]> {
  const url = new URL('https://api.steampowered.com/IWishlistService/GetWishlist/v1/');
  url.searchParams.set('steamid', steamId);

  const response = await fetchFn(url.toString(), {
    method: 'GET',
    headers: { Accept: 'application/json' },
    redirect: 'manual',
    credentials: 'omit',
  });
  assert.equal(
    response.status,
    200,
    `Independent upstream GetWishlist returned HTTP ${response.status}.`,
  );

  const payload = (await response.json()) as { response?: { items?: unknown } };
  assert(
    payload !== null &&
      typeof payload === 'object' &&
      payload.response !== undefined &&
      Array.isArray(payload.response.items),
    'Independent upstream GetWishlist response is missing explicit response.items array.',
  );

  const byAppId = new Map<number, IndependentWishlistEntry>();
  for (const raw of payload.response.items as Array<{
    appid?: unknown;
    priority?: unknown;
    date_added?: unknown;
  }>) {
    assert(
      typeof raw?.appid === 'number' && isValidAppId(raw.appid),
      'Independent upstream GetWishlist entry contains invalid appid.',
    );
    const priority = typeof raw.priority === 'number' ? raw.priority : null;
    const date_added = typeof raw.date_added === 'number' ? raw.date_added : null;
    const existing = byAppId.get(raw.appid);
    if (!existing) {
      byAppId.set(raw.appid, { appid: raw.appid, priority, date_added });
    } else {
      byAppId.set(raw.appid, {
        appid: existing.appid,
        priority: existing.priority ?? priority,
        date_added: existing.date_added ?? date_added,
      });
    }
  }

  return [...byAppId.values()].sort((a, b) => {
    if (a.priority === null && b.priority !== null) return 1;
    if (a.priority !== null && b.priority === null) return -1;
    if (a.priority !== null && b.priority !== null && a.priority !== b.priority) {
      return a.priority - b.priority;
    }
    return a.appid - b.appid;
  });
}

export interface WishlistVerificationSummary {
  readonly upstreamTotal: number;
  readonly toolTotal: number;
  readonly headSampleChecked: number;
  readonly tailSampleChecked: number;
  readonly metadataPageStatus: string;
  readonly fetchedAt: string;
}

/**
 * Compares MCP list_wishlist_games (head sample, optional tail sample, and metadata-enriched page)
 * against an independent read-only upstream GetWishlist fetch.
 */
export async function verifyPublicWishlistAgainstUpstream(params: {
  client: Client;
  steamId: string;
  upstreamFetchFn?: FetchFn;
  sampleSize?: number;
  checkMetadataPage?: boolean;
}): Promise<WishlistVerificationSummary> {
  const sampleSize = params.sampleSize ?? 25;
  const checkMetadataPage = params.checkMetadataPage ?? true;

  const expectedItems = await fetchIndependentPublicWishlist(
    params.steamId,
    params.upstreamFetchFn,
  );

  const rawHead = await params.client.callTool({
    name: 'list_wishlist_games',
    arguments: { offset: 0, limit: sampleSize, include_metadata: false },
  });
  const headOut: ListWishlistGamesOutput = parseStructuredToolResult(
    rawHead as never,
    ListWishlistGamesOutputSchema,
  );

  assert.equal(headOut.data_status, 'ok');
  assert.equal(headOut.metadata_status, 'skipped');
  assert.equal(
    headOut.total,
    expectedItems.length,
    `Wishlist tool total (${headOut.total}) disagrees with independent upstream total (${expectedItems.length}).`,
  );

  const expectedHead = expectedItems.slice(0, sampleSize);
  assert.equal(headOut.returned, expectedHead.length);
  assert.deepEqual(
    headOut.games.map((g) => ({
      appid: g.appid,
      priority: g.priority,
      date_added: g.date_added,
    })),
    expectedHead,
    'Wishlist head sample (appid, priority, date_added) disagrees with independent upstream GetWishlist.',
  );

  // Also verify a non-zero offset tail sample when the wishlist exceeds sampleSize
  let tailSampleChecked = 0;
  if (expectedItems.length > sampleSize) {
    const tailLimit = Math.min(10, expectedItems.length - sampleSize);
    const tailOffset = expectedItems.length - tailLimit;
    const rawTail = await params.client.callTool({
      name: 'list_wishlist_games',
      arguments: { offset: tailOffset, limit: tailLimit, include_metadata: false },
    });
    const tailOut = parseStructuredToolResult(rawTail as never, ListWishlistGamesOutputSchema);
    assert.equal(tailOut.total, expectedItems.length);
    const expectedTail = expectedItems.slice(tailOffset, tailOffset + tailLimit);
    assert.deepEqual(
      tailOut.games.map((g) => ({
        appid: g.appid,
        priority: g.priority,
        date_added: g.date_added,
      })),
      expectedTail,
      'Wishlist tail sample (appid, priority, date_added) disagrees with independent upstream GetWishlist.',
    );
    tailSampleChecked = expectedTail.length;
  }

  let metadataPageStatus = 'skipped';
  if (checkMetadataPage && expectedItems.length > 0) {
    const metaLimit = Math.min(15, expectedItems.length);
    const rawMeta = await params.client.callTool({
      name: 'list_wishlist_games',
      arguments: { offset: 0, limit: metaLimit, language: 'english', include_metadata: true },
    });
    const metaOut = parseStructuredToolResult(rawMeta as never, ListWishlistGamesOutputSchema);
    assert.equal(metaOut.data_status, 'ok');
    assert.equal(metaOut.total, expectedItems.length);
    assert.deepEqual(
      metaOut.games.map((g) => ({
        appid: g.appid,
        priority: g.priority,
        date_added: g.date_added,
      })),
      expectedItems.slice(0, metaLimit),
      'Metadata-enriched wishlist page dropped or altered member order/fields compared to upstream.',
    );
    metadataPageStatus = metaOut.metadata_status;
  }

  return {
    upstreamTotal: expectedItems.length,
    toolTotal: headOut.total,
    headSampleChecked: expectedHead.length,
    tailSampleChecked,
    metadataPageStatus,
    fetchedAt: headOut.fetched_at,
  };
}

export type LiveMutationExpectation = 'add' | 'remove';

export type ParsedLiveMutationConfig =
  | {
      readonly configured: false;
      readonly reason: string;
    }
  | {
      readonly configured: true;
      readonly appid: number;
      readonly expect: LiveMutationExpectation;
      readonly waitMs: number;
    };

/**
 * Parses operator-supplied read-only freshness gate parameters.
 * - Validates every provided field individually, even if other parameters are absent,
 *   so malformed values never silently skip and raw values are never echoed in errors.
 * - Returns configured=false when neither APPID nor EXPECT is set and any provided
 *   optional WAIT_MS is valid.
 */
export function parseLiveMutationConfig(
  env: Readonly<Record<string, string | undefined>>,
): ParsedLiveMutationConfig {
  const rawAppId = env['STEAM_LIVE_MUTATION_APPID']?.trim() ?? '';
  const rawExpect = env['STEAM_LIVE_MUTATION_EXPECT']?.trim().toLowerCase() ?? '';
  const rawWait = env['STEAM_LIVE_MUTATION_WAIT_MS']?.trim() ?? '';

  const errors: string[] = [];

  let parsedAppId: number | null = null;
  if (rawAppId.length > 0) {
    const parsedId = parseDirectIdentifier(rawAppId);
    if (parsedId.kind !== 'appid' || parsedId.source !== 'decimal_appid') {
      errors.push(
        'STEAM_LIVE_MUTATION_APPID must be a valid positive decimal uint32 Steam AppID (1..4294967295).',
      );
    } else {
      parsedAppId = parsedId.appid;
    }
  }

  let parsedExpect: LiveMutationExpectation | null = null;
  if (rawExpect.length > 0) {
    if (rawExpect !== 'add' && rawExpect !== 'remove') {
      errors.push('STEAM_LIVE_MUTATION_EXPECT must be "add" or "remove".');
    } else {
      parsedExpect = rawExpect;
    }
  }

  let waitMs = 30_000;
  if (rawWait.length > 0) {
    if (!/^[0-9]+$/.test(rawWait)) {
      errors.push(
        'STEAM_LIVE_MUTATION_WAIT_MS must be a non-negative integer in ms (0..300000).',
      );
    } else {
      const parsedWait = Number.parseInt(rawWait, 10);
      if (!Number.isSafeInteger(parsedWait) || parsedWait < 0 || parsedWait > 300_000) {
        errors.push(
          'STEAM_LIVE_MUTATION_WAIT_MS must be an integer between 0 and 300000.',
        );
      } else {
        waitMs = parsedWait;
      }
    }
  }

  if ((rawAppId.length > 0) !== (rawExpect.length > 0)) {
    errors.push(
      'Both STEAM_LIVE_MUTATION_APPID and STEAM_LIVE_MUTATION_EXPECT ("add" or "remove") must be provided together.',
    );
  }

  if (errors.length > 0) {
    throw new Error(errors.join(' '));
  }

  if (parsedAppId === null || parsedExpect === null) {
    return {
      configured: false,
      reason:
        'STEAM_LIVE_MUTATION_APPID and STEAM_LIVE_MUTATION_EXPECT (add|remove) are not set',
    };
  }

  return {
    configured: true,
    appid: parsedAppId,
    expect: parsedExpect,
    waitMs,
  };
}

export interface LiveFreshnessSummary {
  readonly appid: number;
  readonly expect: LiveMutationExpectation;
  readonly beforeWishlisted: boolean;
  readonly afterWishlisted: boolean;
  readonly wishlistFetchDelta: number;
  readonly beforeFetchedAt: string;
  readonly afterFetchedAt: string;
}

/**
 * Strictly verifies live freshness between two consecutive MCP get_game_status calls
 * on the SAME server instance:
 * - Asserts before-state matches the expected precondition (false for "add", true for "remove")
 * - Waits for the manual operator Steam wishlist edit (or synthetic hook)
 * - Asserts each MCP call sent a real upstream GetWishlist request (no cross-call caching)
 * - Asserts after-state changed to the exact expected postcondition (no change = FAIL).
 */
export async function verifyLiveWishlistFreshness(params: {
  client: Client;
  observer: ReadOnlyFetchObserver;
  appid: number;
  expect: LiveMutationExpectation;
  waitMs: number;
  onBeforeWait?: (info: {
    appid: number;
    expect: LiveMutationExpectation;
    beforeWishlisted: boolean;
    waitMs: number;
  }) => Promise<void> | void;
  sleepFn?: (ms: number) => Promise<void>;
}): Promise<LiveFreshnessSummary> {
  const sleep = params.sleepFn ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const expectedBefore = params.expect === 'add' ? false : true;
  const expectedAfter = params.expect === 'add' ? true : false;

  const startWishlistCalls = params.observer.counts.wishlist;

  const rawBefore = await params.client.callTool({
    name: 'get_game_status',
    arguments: { query: String(params.appid) },
  });
  const before: GameStatusOutput = parseStructuredToolResult(
    rawBefore as never,
    GameStatusOutputSchema,
  );

  assert.equal(
    params.observer.counts.wishlist - startWishlistCalls,
    1,
    'Read 1 did not send a fresh upstream GetWishlist request.',
  );
  assert.equal(before.resolution, 'resolved');
  assert.equal(before.appid, params.appid);
  assert.equal(before.wishlist_data_status, 'ok');
  assert.equal(
    before.wishlisted,
    expectedBefore,
    `Freshness precondition failed for appid ${params.appid}: expected wishlisted=${String(expectedBefore)} before manual "${params.expect}", observed ${String(before.wishlisted)}.`,
  );
  assert(before.wishlist_fetched_at !== null, 'Read 1 missing wishlist_fetched_at.');

  await params.onBeforeWait?.({
    appid: params.appid,
    expect: params.expect,
    beforeWishlisted: before.wishlisted,
    waitMs: params.waitMs,
  });

  if (params.waitMs > 0) {
    await sleep(params.waitMs);
  }

  const rawAfter = await params.client.callTool({
    name: 'get_game_status',
    arguments: { query: String(params.appid) },
  });
  const after: GameStatusOutput = parseStructuredToolResult(
    rawAfter as never,
    GameStatusOutputSchema,
  );

  const wishlistFetchDelta = params.observer.counts.wishlist - startWishlistCalls;
  assert.equal(
    wishlistFetchDelta,
    2,
    `Expected 2 live upstream GetWishlist requests across Read 1 and Read 2 (zero cross-call cache), observed ${wishlistFetchDelta}.`,
  );
  assert.equal(after.resolution, 'resolved');
  assert.equal(after.appid, params.appid);
  assert.equal(after.wishlist_data_status, 'ok');
  assert(after.wishlist_fetched_at !== null, 'Read 2 missing wishlist_fetched_at.');
  assert(
    after.wishlist_fetched_at >= before.wishlist_fetched_at,
    'Read 2 wishlist_fetched_at must not precede Read 1.',
  );
  assert.notEqual(
    after.wishlisted,
    before.wishlisted,
    `Freshness gate failed: appid ${params.appid} wishlisted state did not change between Read 1 and Read 2 (remained ${String(after.wishlisted)}).`,
  );
  assert.equal(
    after.wishlisted,
    expectedAfter,
    `Freshness postcondition failed for appid ${params.appid}: expected wishlisted=${String(expectedAfter)} after manual "${params.expect}", observed ${String(after.wishlisted)}.`,
  );

  return {
    appid: params.appid,
    expect: params.expect,
    beforeWishlisted: before.wishlisted,
    afterWishlisted: after.wishlisted,
    wishlistFetchDelta,
    beforeFetchedAt: before.wishlist_fetched_at,
    afterFetchedAt: after.wishlist_fetched_at,
  };
}
