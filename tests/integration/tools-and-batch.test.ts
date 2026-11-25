import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '../../src/config.js';
import {
  GameStatusOutputSchema,
  GetGamesStatusOutputSchema,
  ListOwnedGamesOutputSchema,
  ListWishlistGamesOutputSchema,
  ResolveGameOutputSchema,
} from '../../src/schemas.js';
import { createSteamCollectionServer } from '../../src/server.js';
import { computeDeduplicationKey, handleGetGamesStatus } from '../../src/tools/status.js';
import { SteamHttpClient } from '../../src/clients/http.js';
import { SteamApiClient } from '../../src/clients/steam.js';
import { LibraryService } from '../../src/services/library.js';
import { MetadataService } from '../../src/services/metadata.js';
import { GameResolverService } from '../../src/services/resolver.js';
import {
  makeGetItemsResponse,
  OWNED_GAMES_FIXTURES,
  STORE_SEARCH_FIXTURES,
  TEST_STEAM_API_KEY,
  TEST_STEAM_ID,
  WISHLIST_FIXTURES,
} from '../fixtures/steam-responses.js';

function makeConfig(overrides?: Partial<ServerConfig>): ServerConfig {
  return {
    steamApiKey: TEST_STEAM_API_KEY,
    steamId: TEST_STEAM_ID,
    country: 'US',
    language: 'english',
    httpTimeoutMs: 5_000,
    maxConcurrency: 2,
    metadataBatchSize: 50,
    toolTimeoutMs: 90_000,
    ...overrides,
  };
}

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function connectInMemory(
  fetchHandler: (url: URL, init?: RequestInit) => Response | Promise<Response>,
  options?: {
    configOverrides?: Partial<ServerConfig>;
    useRealClock?: boolean;
  },
) {
  const config = makeConfig(options?.configOverrides);
  const counts = { owned: 0, wishlist: 0, search: 0, getItems: 0 };
  const requestOrder: string[] = [];
  const getItemsCalls: Array<{ ids: number[]; language: string }> = [];
  let tick = 1_764_000_000_000;

  const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    tick += 1000;
    if (url.pathname.endsWith('/GetOwnedGames/v1/')) {
      counts.owned++;
      requestOrder.push('owned');
    }
    if (url.pathname.endsWith('/GetWishlist/v1/')) {
      counts.wishlist++;
      requestOrder.push('wishlist');
    }
    if (url.pathname.endsWith('/api/storesearch/')) {
      counts.search++;
      requestOrder.push('search');
    }
    if (url.pathname.endsWith('/GetItems/v1/')) {
      counts.getItems++;
      requestOrder.push('items');
      const payload = JSON.parse(url.searchParams.get('input_json') ?? '{}') as {
        ids?: Array<{ appid: number }>;
        context?: { language?: string };
      };
      getItemsCalls.push({
        ids: (payload.ids ?? []).map((x) => x.appid),
        language: payload.context?.language ?? 'english',
      });
    }
    return await fetchHandler(url, init);
  });

  const server = createSteamCollectionServer(config, {
    fetchFn,
    ...(options?.useRealClock ? {} : { now: () => tick, sleep: async () => {} }),
    baseRetryDelayMs: 1,
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.1.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    counts,
    requestOrder,
    getItemsCalls,
    fetchFn,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

function defaultMockRouter(overrides?: {
  ownedResponse?: () => Response;
  wishlistResponse?: () => Response;
  getItemsResponse?: (appids: number[], lang: string) => Response;
}) {
  return (url: URL): Response => {
    if (url.pathname.endsWith('/GetOwnedGames/v1/')) {
      return overrides?.ownedResponse ? overrides.ownedResponse() : jsonResp(OWNED_GAMES_FIXTURES.sample);
    }
    if (url.pathname.endsWith('/GetWishlist/v1/')) {
      return overrides?.wishlistResponse
        ? overrides.wishlistResponse()
        : jsonResp(WISHLIST_FIXTURES.sample);
    }
    if (url.pathname.endsWith('/api/storesearch/')) {
      const term = url.searchParams.get('term') ?? '';
      if (term === 'Cyberpunk 2077') return jsonResp(STORE_SEARCH_FIXTURES.cyberpunk_en);
      if (term === '赛博朋克2077') return jsonResp(STORE_SEARCH_FIXTURES.cyberpunk_zh_cn);
      if (term === 'Hades') return jsonResp(STORE_SEARCH_FIXTURES.hades_en);
      if (term === 'Portal') return jsonResp(STORE_SEARCH_FIXTURES.portal_en);
      if (term === 'Resident Evil 4') return jsonResp(STORE_SEARCH_FIXTURES.re4_en_remake_conflict);
      if (term === 'ELDEN RING') return jsonResp(STORE_SEARCH_FIXTURES.elden_ring_en);
      if (term === '博德之门3') return jsonResp(STORE_SEARCH_FIXTURES.bg3_zh_cn);
      return jsonResp(STORE_SEARCH_FIXTURES.empty);
    }
    if (url.pathname.endsWith('/GetItems/v1/')) {
      const payload = JSON.parse(url.searchParams.get('input_json') ?? '{}') as {
        ids: Array<{ appid: number }>;
        context: { language: string };
      };
      const ids = payload.ids.map((i) => i.appid);
      return overrides?.getItemsResponse
        ? overrides.getItemsResponse(ids, payload.context.language)
        : jsonResp(makeGetItemsResponse(ids, payload.context.language));
    }
    return jsonResp({}, 404);
  };
}

function assertStructuredMatchesText(result: {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
}) {
  expect(result.isError).not.toBe(true);
  expect(result.content).toHaveLength(1);
  expect(result.content[0]!.type).toBe('text');
  const parsedText = JSON.parse(result.content[0]!.text!);
  expect(result.structuredContent).toEqual(parsedText);
  return parsedText;
}

describe('MCP tools integration, 50-item batching, and failure isolation', () => {
  it('registers ONLY the 5 specified read-only tools', async () => {
    const conn = await connectInMemory(defaultMockRouter());
    try {
      const { tools } = await conn.client.listTools();
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual([
        'get_game_status',
        'get_games_status',
        'list_owned_games',
        'list_wishlist_games',
        'resolve_game',
      ]);
      for (const tool of tools) {
        expect(tool.annotations?.readOnlyHint).toBe(true);
        expect(tool.outputSchema).toBeDefined();
      }
    } finally {
      await conn.close();
    }
  });

  it('handles a 50-item get_games_status batch with duplicates, fallback, ambiguity, and rejected URL using 1x GetOwnedGames and 1x GetWishlist', async () => {
    const conn = await connectInMemory(
      defaultMockRouter({
        wishlistResponse: () => jsonResp(WISHLIST_FIXTURES.verifiable_sample),
      }),
    );
    try {
      const queries = [
        { query: 'Hades' }, // owned
        { query: 'Hades' }, // duplicate name
        { query: '1091500' }, // direct appid owned
        { query: 'https://store.steampowered.com/app/1091500/Cyberpunk_2077/' }, // same appid via URL
        { query: '赛博朋克2077', language: 'zh-CN', alternative_names: ['Cyberpunk 2077'] },
        { query: 'Resident Evil 4' }, // ambiguous remake conflict
        { query: 'DARK SOULS: Prepare To Die Edition' }, // delisted -> triggers personal library fallback!
        { query: 'https://store.steampowered.com/bundle/232/' }, // rejected URL -> error item without masking others
        { query: 'Nonexistent Title XYZ 987654' }, // not_found
        { query: '999999999' }, // direct AppID with missing metadata!
        // Fill remaining 40 items with direct AppIDs (including duplicates and wishlisted items)
        ...Array.from({ length: 40 }, (_, i) => ({
          query: i % 4 === 0 ? '1086940' : i % 4 === 1 ? '413150' : String(200_000 + i),
        })),
      ];
      expect(queries).toHaveLength(50);

      const raw = await conn.client.callTool({
        name: 'get_games_status',
        arguments: { queries },
      });
      const parsed = GetGamesStatusOutputSchema.parse(assertStructuredMatchesText(raw as never));

      // CRITICAL: exactly 1x GetOwnedGames and 1x GetWishlist across the entire 50-item batch (including fallback!)
      expect(conn.counts.owned).toBe(1);
      expect(conn.counts.wishlist).toBe(1);

      expect(parsed.total).toBe(50);
      expect(parsed.results).toHaveLength(50);
      expect(parsed.owned_data_status).toBe('ok');
      expect(parsed.wishlist_data_status).toBe('ok');

      // Preserves exact input order and original query text for duplicates
      expect(parsed.results[0]!.query).toBe('Hades');
      expect(parsed.results[0]!.owned).toBe(true);
      expect(parsed.results[0]!.wishlisted).toBe(false);
      expect(parsed.results[1]!.query).toBe('Hades');
      expect(parsed.results[1]!.appid).toBe(1145360);

      expect(parsed.results[2]!.query).toBe('1091500');
      expect(parsed.results[2]!.owned).toBe(true);
      expect(parsed.results[3]!.query).toBe('https://store.steampowered.com/app/1091500/Cyberpunk_2077/');
      expect(parsed.results[3]!.appid).toBe(1091500);
      expect(parsed.results[3]!.owned).toBe(true);

      expect(parsed.results[4]!.appid).toBe(1091500);
      expect(parsed.results[4]!.name).toBe('赛博朋克 2077');

      // Ambiguous: top-level owned & wishlisted MUST be null
      expect(parsed.results[5]!.resolution).toBe('ambiguous');
      expect(parsed.results[5]!.appid).toBeNull();
      expect(parsed.results[5]!.owned).toBeNull();
      expect(parsed.results[5]!.wishlisted).toBeNull();
      expect(parsed.results[5]!.candidates.length).toBeGreaterThanOrEqual(2);
      expect(parsed.results[5]!.candidates[0]!.owned).toBe(false);

      // Delisted fallback resolved and checked accurately
      expect(parsed.results[6]!.resolution).toBe('resolved');
      expect(parsed.results[6]!.appid).toBe(211420);
      expect(parsed.results[6]!.identity_source).toBe('personal_library_fallback');
      expect(parsed.results[6]!.owned).toBe(true);
      expect(parsed.results[6]!.wishlisted).toBe(false);

      // Rejected URL did NOT break batch; top-level states null
      expect(parsed.results[7]!.resolution).toBe('error');
      expect(parsed.results[7]!.error_code).toBe('invalid_query');
      expect(parsed.results[7]!.owned).toBeNull();
      expect(parsed.results[7]!.wishlisted).toBeNull();

      // Not found: top-level states null (NEVER false!)
      expect(parsed.results[8]!.resolution).toBe('not_found');
      expect(parsed.results[8]!.owned).toBeNull();
      expect(parsed.results[8]!.wishlisted).toBeNull();

      // Missing-metadata direct AppID still accurately reports confirmed booleans!
      expect(parsed.results[9]!.resolution).toBe('resolved');
      expect(parsed.results[9]!.appid).toBe(999999999);
      expect(parsed.results[9]!.identity_source).toBe('provided_appid');
      expect(parsed.results[9]!.metadata_status).toBe('unavailable');
      expect(parsed.results[9]!.owned).toBe(false);
      expect(parsed.results[9]!.wishlisted).toBe(false);

      // Wishlisted item 1086940 at index 10
      expect(parsed.results[10]!.appid).toBe(1086940);
      expect(parsed.results[10]!.owned).toBe(false);
      expect(parsed.results[10]!.wishlisted).toBe(true);
    } finally {
      await conn.close();
    }

    // Also verify missing-metadata wishlisted AppID 999999999:
    // - Direct AppID query still resolves with wishlisted=true & metadata_status='unavailable'
    // - Personal fallback name queries do NOT claim complete uniqueness/not_found when an unverifiable wishlist item exists
    const connUnverifiableWl = await connectInMemory(defaultMockRouter());
    try {
      const raw = await connUnverifiableWl.client.callTool({
        name: 'get_games_status',
        arguments: {
          queries: [
            { query: '999999999' },
            { query: 'DARK SOULS: Prepare To Die Edition' },
            { query: 'Nonexistent Title XYZ 987654' },
          ],
        },
      });
      const parsed = GetGamesStatusOutputSchema.parse(assertStructuredMatchesText(raw as never));
      expect(parsed.results[0]).toMatchObject({
        resolution: 'resolved',
        appid: 999999999,
        identity_source: 'provided_appid',
        metadata_status: 'unavailable',
        owned: false,
        wishlisted: true,
      });
      expect(parsed.results[1]).toMatchObject({
        resolution: 'ambiguous',
        appid: null,
        owned: null,
        wishlisted: null,
        search_complete: false,
      });
      expect(parsed.results[1]!.candidates.some((c) => c.appid === 211420 && c.owned === true)).toBe(true);
      expect(parsed.results[2]).toMatchObject({
        resolution: 'error',
        appid: null,
        owned: null,
        wishlisted: null,
        search_complete: false,
      });
    } finally {
      await connUnverifiableWl.close();
    }
  });

  it('supports partial source failure: one failing account source yields null without masking the other source, never faking false', async () => {
    // Case 1: GetOwnedGames fails with 401 invalid key, GetWishlist succeeds
    const conn1 = await connectInMemory(
      defaultMockRouter({
        ownedResponse: () => new Response('Unauthorized', { status: 401 }),
      }),
    );
    try {
      const statusRaw = await conn1.client.callTool({
        name: 'get_game_status',
        arguments: { query: '1086940' },
      });
      const status = GameStatusOutputSchema.parse(assertStructuredMatchesText(statusRaw as never));
      expect(status.owned).toBeNull();
      expect(status.owned_data_status).toBe('unavailable');
      expect(status.owned_error_code).toBe('invalid_api_key');
      expect(status.wishlisted).toBe(true);
      expect(status.wishlist_data_status).toBe('ok');
      expect(status.wishlist_error_code).toBeNull();

      // list_owned_games MUST return isError=true (never fake empty list!) and leak no key
      const listRaw = await conn1.client.callTool({
        name: 'list_owned_games',
        arguments: {},
      });
      expect(listRaw.isError).toBe(true);
      const errText = (listRaw.content[0] as { text: string }).text;
      expect(errText).not.toContain(TEST_STEAM_API_KEY);
      expect(JSON.parse(errText)).toMatchObject({
        list: 'owned',
        data_status: 'unavailable',
        error_code: 'invalid_api_key',
      });
    } finally {
      await conn1.close();
    }

    // Case 2: GetWishlist returns observed { response: {} } (unconfirmable!), GetOwnedGames succeeds
    const conn2 = await connectInMemory(
      defaultMockRouter({
        wishlistResponse: () => jsonResp(WISHLIST_FIXTURES.observed_unconfirmable_empty_object),
      }),
    );
    try {
      const statusRaw = await conn2.client.callTool({
        name: 'get_game_status',
        arguments: { query: '1091500' },
      });
      const status = GameStatusOutputSchema.parse(assertStructuredMatchesText(statusRaw as never));
      expect(status.owned).toBe(true);
      expect(status.owned_data_status).toBe('ok');
      // NEVER false when wishlist is unconfirmable!
      expect(status.wishlisted).toBeNull();
      expect(status.wishlist_data_status).toBe('unavailable');
      expect(status.wishlist_error_code).toBe('invalid_response');

      // list_wishlist_games MUST return isError=true
      const wlRaw = await conn2.client.callTool({
        name: 'list_wishlist_games',
        arguments: {},
      });
      expect(wlRaw.isError).toBe(true);
      expect(JSON.parse((wlRaw.content[0] as { text: string }).text)).toMatchObject({
        list: 'wishlist',
        data_status: 'unavailable',
        error_code: 'invalid_response',
      });
    } finally {
      await conn2.close();
    }
  });

  it('re-fetches live data across consecutive calls with zero cross-call cache and validates all 5 tool schemas', async () => {
    let wishlisted = false;
    const conn = await connectInMemory(
      defaultMockRouter({
        wishlistResponse: () =>
          jsonResp({
            response: {
              items: wishlisted ? [{ appid: 413150, priority: 1, date_added: 1700000000 }] : [],
            },
          }),
      }),
    );
    try {
      const firstStatus = GameStatusOutputSchema.parse(
        assertStructuredMatchesText(
          (await conn.client.callTool({
            name: 'get_game_status',
            arguments: { query: '413150' },
          })) as never,
        ),
      );
      expect(firstStatus.wishlisted).toBe(false);

      // Mutate upstream wishlist
      wishlisted = true;
      const secondStatus = GameStatusOutputSchema.parse(
        assertStructuredMatchesText(
          (await conn.client.callTool({
            name: 'get_game_status',
            arguments: { query: '413150' },
          })) as never,
        ),
      );
      expect(secondStatus.wishlisted).toBe(true);
      expect(conn.counts.wishlist).toBe(2);
      expect(conn.counts.owned).toBe(2);

      // Validate remaining tool output schemas directly
      const ownedList = ListOwnedGamesOutputSchema.parse(
        assertStructuredMatchesText(
          (await conn.client.callTool({ name: 'list_owned_games', arguments: { limit: 10 } })) as never,
        ),
      );
      expect(ownedList.total).toBe(5);

      const wlList = ListWishlistGamesOutputSchema.parse(
        assertStructuredMatchesText(
          (await conn.client.callTool({ name: 'list_wishlist_games', arguments: { limit: 10 } })) as never,
        ),
      );
      expect(wlList.total).toBe(1);

      const resolved = ResolveGameOutputSchema.parse(
        assertStructuredMatchesText(
          (await conn.client.callTool({
            name: 'resolve_game',
            arguments: { query: '博德之门3', language: 'zh-CN' },
          })) as never,
        ),
      );
      expect(resolved.appid).toBe(1086940);

      // Verify input validation rejects out-of-range limit (> 500) and batch > 50
      const badLimit = await conn.client.callTool({
        name: 'list_owned_games',
        arguments: { limit: 501 },
      });
      expect(badLimit.isError).toBe(true);

      const badBatch = await conn.client.callTool({
        name: 'get_games_status',
        arguments: {
          queries: Array.from({ length: 51 }, (_, i) => ({ query: String(i + 1) })),
        },
      });
      expect(badBatch.isError).toBe(true);
    } finally {
      await conn.close();
    }
  });

  it('schedules collection queries ahead of optional metadata so hanging GetItems never starves owned/wishlist in single or mixed/bounded batches', async () => {
    const hangUntilAbort = (init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true },
        );
      });

    // 1. Single get_game_status({query:'10'}) with httpTimeoutMs === toolTimeoutMs and hanging GetItems
    const connSingle = await connectInMemory(
      (url, init) => {
        if (url.pathname.endsWith('/GetItems/v1/')) return hangUntilAbort(init);
        if (url.pathname.endsWith('/GetOwnedGames/v1/')) {
          return jsonResp({ response: { game_count: 1, games: [{ appid: 10 }] } });
        }
        if (url.pathname.endsWith('/GetWishlist/v1/')) {
          return jsonResp({ response: { items: [{ appid: 10 }] } });
        }
        return jsonResp({}, 404);
      },
      { configOverrides: { httpTimeoutMs: 120, toolTimeoutMs: 120 }, useRealClock: true },
    );
    try {
      const raw = await connSingle.client.callTool({
        name: 'get_game_status',
        arguments: { query: '10' },
      });
      const parsed = GameStatusOutputSchema.parse(assertStructuredMatchesText(raw as never));
      expect(parsed.resolution).toBe('resolved');
      expect(parsed.appid).toBe(10);
      expect(parsed.owned).toBe(true);
      expect(parsed.wishlisted).toBe(true);
      expect(parsed.owned_data_status).toBe('ok');
      expect(parsed.wishlist_data_status).toBe('ok');
      expect(parsed.metadata_status).toBe('unavailable');
      expect(connSingle.requestOrder.slice(0, 2).sort()).toEqual(['owned', 'wishlist']);
    } finally {
      await connSingle.close();
    }

    // 2. Batch get_games_status with direct AppIDs + hanging GetItems
    const connBatch = await connectInMemory(
      (url, init) => {
        if (url.pathname.endsWith('/GetItems/v1/')) return hangUntilAbort(init);
        if (url.pathname.endsWith('/GetOwnedGames/v1/')) {
          return jsonResp({ response: { game_count: 1, games: [{ appid: 10 }] } });
        }
        if (url.pathname.endsWith('/GetWishlist/v1/')) {
          return jsonResp({ response: { items: [{ appid: 10 }, { appid: 11 }] } });
        }
        return jsonResp({}, 404);
      },
      { configOverrides: { httpTimeoutMs: 120, toolTimeoutMs: 120, maxConcurrency: 1 }, useRealClock: true },
    );
    try {
      const raw = await connBatch.client.callTool({
        name: 'get_games_status',
        arguments: { queries: [{ query: '10' }, { query: '11' }] },
      });
      const parsed = GetGamesStatusOutputSchema.parse(assertStructuredMatchesText(raw as never));
      expect(parsed.owned_data_status).toBe('ok');
      expect(parsed.wishlist_data_status).toBe('ok');
      expect(parsed.results[0]).toMatchObject({ appid: 10, owned: true, wishlisted: true, metadata_status: 'unavailable' });
      expect(parsed.results[1]).toMatchObject({ appid: 11, owned: false, wishlisted: true, metadata_status: 'unavailable' });
    } finally {
      await connBatch.close();
    }

    // 3. Mixed fast/slow batch under maxConcurrency=1: hanging name query FIRST, direct AppID SECOND
    const connMixed = await connectInMemory(
      (url, init) => {
        if (url.pathname.endsWith('/api/storesearch/')) return hangUntilAbort(init);
        if (url.pathname.endsWith('/GetOwnedGames/v1/')) {
          return jsonResp({ response: { game_count: 1, games: [{ appid: 10, name: 'Ten' }] } });
        }
        if (url.pathname.endsWith('/GetWishlist/v1/')) {
          return jsonResp({ response: { items: [{ appid: 10 }] } });
        }
        if (url.pathname.endsWith('/GetItems/v1/')) {
          return jsonResp({
            response: {
              store_items: [{ item_type: 0, id: 10, appid: 10, success: 1, visible: true, type: 0, name: 'Ten' }],
            },
          });
        }
        return jsonResp({}, 404);
      },
      { configOverrides: { httpTimeoutMs: 120, toolTimeoutMs: 120, maxConcurrency: 1 }, useRealClock: true },
    );
    try {
      const raw = await connMixed.client.callTool({
        name: 'get_games_status',
        arguments: { queries: [{ query: 'Hanging Title' }, { query: '10' }] },
      });
      const parsed = GetGamesStatusOutputSchema.parse(assertStructuredMatchesText(raw as never));
      expect(parsed.results[0]).toMatchObject({ resolution: 'error', error_code: 'timeout', owned: null, wishlisted: null });
      expect(parsed.results[1]).toMatchObject({ resolution: 'resolved', appid: 10, owned: true, wishlisted: true });
    } finally {
      await connMixed.close();
    }

    // 4. Multi-language direct batch under maxConcurrency=2: hanging english GetItems does not starve fast japanese GetItems
    const connMultiLang = await connectInMemory(
      (url, init) => {
        if (url.pathname.endsWith('/GetOwnedGames/v1/')) {
          return jsonResp({ response: { game_count: 1, games: [{ appid: 10 }] } });
        }
        if (url.pathname.endsWith('/GetWishlist/v1/')) {
          return jsonResp({ response: { items: [{ appid: 11 }] } });
        }
        if (url.pathname.endsWith('/GetItems/v1/')) {
          const req = JSON.parse(url.searchParams.get('input_json') ?? '{}') as { context?: { language?: string } };
          if (req.context?.language === 'english') return hangUntilAbort(init);
          return jsonResp({
            response: {
              store_items: [{ item_type: 0, id: 11, appid: 11, success: 1, visible: true, type: 0, name: '十一' }],
            },
          });
        }
        return jsonResp({}, 404);
      },
      { configOverrides: { httpTimeoutMs: 120, toolTimeoutMs: 120, maxConcurrency: 2 }, useRealClock: true },
    );
    try {
      const raw = await connMultiLang.client.callTool({
        name: 'get_games_status',
        arguments: {
          queries: [
            { query: '10', language: 'english' },
            { query: '11', language: 'ja' },
          ],
        },
      });
      const parsed = GetGamesStatusOutputSchema.parse(assertStructuredMatchesText(raw as never));
      expect(parsed.results[0]).toMatchObject({ appid: 10, owned: true, wishlisted: false, metadata_status: 'unavailable' });
      expect(parsed.results[1]).toMatchObject({ appid: 11, owned: false, wishlisted: true, name: '十一', metadata_status: 'complete' });
    } finally {
      await connMultiLang.close();
    }

    // 5. Mixed fast/slow NAME batch under maxConcurrency=2: slow name query hangs while fast name query succeeds independently
    const connMixedNames = await connectInMemory(
      (url, init) => {
        if (url.pathname.endsWith('/api/storesearch/')) {
          if (url.searchParams.get('term') === 'Hanging Title') return hangUntilAbort(init);
          return jsonResp({ total: 1, items: [{ id: 1145360, type: 'app', name: 'Hades' }] });
        }
        if (url.pathname.endsWith('/GetOwnedGames/v1/')) {
          return jsonResp({ response: { game_count: 1, games: [{ appid: 1145360, name: 'Hades' }] } });
        }
        if (url.pathname.endsWith('/GetWishlist/v1/')) {
          return jsonResp({ response: { items: [] } });
        }
        if (url.pathname.endsWith('/GetItems/v1/')) {
          return jsonResp({
            response: {
              store_items: [
                { item_type: 0, id: 1145360, appid: 1145360, success: 1, visible: true, type: 0, name: 'Hades' },
              ],
            },
          });
        }
        return jsonResp({}, 404);
      },
      { configOverrides: { httpTimeoutMs: 120, toolTimeoutMs: 120, maxConcurrency: 2 }, useRealClock: true },
    );
    try {
      const raw = await connMixedNames.client.callTool({
        name: 'get_games_status',
        arguments: { queries: [{ query: 'Hanging Title' }, { query: 'Hades' }] },
      });
      const parsed = GetGamesStatusOutputSchema.parse(assertStructuredMatchesText(raw as never));
      expect(parsed.results[0]).toMatchObject({ resolution: 'error', error_code: 'timeout', owned: null, wishlisted: null });
      expect(parsed.results[1]).toMatchObject({ resolution: 'resolved', appid: 1145360, owned: true, wishlisted: false });
    } finally {
      await connMixedNames.close();
    }

    // 6. Single get_game_status("Signal") with concurrency=2, owned hangs until timeout, wishlist healthy -> appid=10, owned=null, wishlisted=true, metadata=1
    const connSingleOwnedTimeout = await connectInMemory(
      (url, init) => {
        if (url.pathname.endsWith('/api/storesearch/')) {
          return jsonResp({
            total: 2,
            items: [
              { id: 10, type: 'app', name: 'Signal' },
              { id: 11, type: 'app', name: 'Different Title' },
            ],
          });
        }
        if (url.pathname.endsWith('/GetOwnedGames/v1/')) return hangUntilAbort(init);
        if (url.pathname.endsWith('/GetWishlist/v1/')) {
          return jsonResp({ response: { items: [{ appid: 10 }] } });
        }
        if (url.pathname.endsWith('/GetItems/v1/')) {
          return jsonResp({
            response: {
              store_items: [
                { item_type: 0, id: 10, appid: 10, success: 1, visible: true, type: 0, name: 'Signal' },
                { item_type: 0, id: 11, appid: 11, success: 1, visible: true, type: 0, name: 'Different Title' },
              ],
            },
          });
        }
        return jsonResp({}, 404);
      },
      { configOverrides: { httpTimeoutMs: 150, toolTimeoutMs: 150, maxConcurrency: 2 }, useRealClock: true },
    );
    try {
      const raw = await connSingleOwnedTimeout.client.callTool({
        name: 'get_game_status',
        arguments: { query: 'Signal' },
      });
      const parsed = GameStatusOutputSchema.parse(assertStructuredMatchesText(raw as never));
      expect([parsed.appid, parsed.owned, parsed.wishlisted, connSingleOwnedTimeout.counts.getItems]).toEqual([
        10,
        null,
        true,
        1,
      ]);
      expect(parsed.owned_data_status).toBe('unavailable');
      expect(parsed.wishlist_data_status).toBe('ok');
    } finally {
      await connSingleOwnedTimeout.close();
    }

    // 7. Batch concurrency=2: slow name query does not block unrelated direct AppID Japanese display enrichment
    const connSlowNameAndDirect = await connectInMemory(
      (url, init) => {
        if (url.pathname.endsWith('/api/storesearch/')) {
          const term = url.searchParams.get('term');
          return jsonResp(
            term === 'Slow'
              ? { total: 1, items: [{ id: 12, type: 'app', name: 'Different' }] }
              : { total: 1, items: [{ id: 10, type: 'app', name: 'Fast' }] },
          );
        }
        if (url.pathname.endsWith('/GetItems/v1/')) {
          const req = JSON.parse(url.searchParams.get('input_json') ?? '{}') as { ids: Array<{ appid: number }> };
          const ids = req.ids.map((x) => x.appid);
          if (ids.includes(12)) return hangUntilAbort(init);
          return jsonResp({
            response: {
              store_items: ids.map((id) => ({
                item_type: 0,
                id,
                appid: id,
                success: 1,
                visible: true,
                type: 0,
                name: id === 11 ? 'Eleven' : 'Fast',
              })),
            },
          });
        }
        if (url.pathname.endsWith('/GetOwnedGames/v1/')) {
          return jsonResp({ response: { game_count: 2, games: [{ appid: 10 }, { appid: 11 }] } });
        }
        if (url.pathname.endsWith('/GetWishlist/v1/')) {
          return jsonResp({ response: { items: [{ appid: 10 }, { appid: 11 }] } });
        }
        return jsonResp({}, 404);
      },
      { configOverrides: { httpTimeoutMs: 150, toolTimeoutMs: 150, maxConcurrency: 2 }, useRealClock: true },
    );
    try {
      const raw = await connSlowNameAndDirect.client.callTool({
        name: 'get_games_status',
        arguments: { queries: [{ query: 'Slow' }, { query: 'Fast' }, { query: '11', language: 'ja' }] },
      });
      const parsed = GetGamesStatusOutputSchema.parse(assertStructuredMatchesText(raw as never));
      expect(
        parsed.results.map((x) => [x.appid, x.owned, x.wishlisted, x.metadata_status]),
      ).toEqual([
        [null, null, null, 'unavailable'],
        [10, true, true, 'complete'],
        [11, true, true, 'complete'],
      ]);
    } finally {
      await connSlowNameAndDirect.close();
    }

    // 8. Batch concurrency=2: slow multi-chunk personal fallback GetItems consumes at most 1 slot so fast name verification completes
    const connSlowFallbackVsFast = await connectInMemory(
      async (url, init) => {
        if (url.pathname.endsWith('/api/storesearch/')) {
          if (url.searchParams.get('term') === 'Unlisted') {
            return jsonResp({ total: 0, items: [] });
          }
          await new Promise((r) => setTimeout(r, 40));
          return jsonResp({
            total: 2,
            items: [
              { id: 10, type: 'app', name: 'Fast' },
              { id: 11, type: 'app', name: 'Another' },
            ],
          });
        }
        if (url.pathname.endsWith('/GetOwnedGames/v1/')) {
          return jsonResp({
            response: {
              game_count: 2,
              games: [
                { appid: 1000, name: 'Unlisted' },
                { appid: 10, name: 'Fast' },
              ],
            },
          });
        }
        if (url.pathname.endsWith('/GetWishlist/v1/')) {
          return jsonResp({
            response: {
              items: Array.from({ length: 120 }, (_, i) => ({ appid: 1001 + i })),
            },
          });
        }
        if (url.pathname.endsWith('/GetItems/v1/')) {
          const req = JSON.parse(url.searchParams.get('input_json') ?? '{}') as { ids: Array<{ appid: number }> };
          const ids = req.ids.map((x) => x.appid);
          if (ids.some((x) => x >= 1000)) return hangUntilAbort(init);
          return jsonResp({
            response: {
              store_items: [
                { item_type: 0, id: 10, appid: 10, success: 1, visible: true, type: 0, name: 'Fast' },
                { item_type: 0, id: 11, appid: 11, success: 1, visible: true, type: 0, name: 'Another' },
              ],
            },
          });
        }
        return jsonResp({}, 404);
      },
      { configOverrides: { httpTimeoutMs: 180, toolTimeoutMs: 180, maxConcurrency: 2 }, useRealClock: true },
    );
    try {
      const raw = await connSlowFallbackVsFast.client.callTool({
        name: 'get_games_status',
        arguments: { queries: [{ query: 'Unlisted' }, { query: 'Fast' }] },
      });
      const parsed = GetGamesStatusOutputSchema.parse(assertStructuredMatchesText(raw as never));
      expect(parsed.results[1]).toMatchObject({ resolution: 'resolved', appid: 10, owned: true });
      expect(connSlowFallbackVsFast.counts.owned).toBe(1);
      expect(connSlowFallbackVsFast.counts.wishlist).toBe(1);
    } finally {
      await connSlowFallbackVsFast.close();
    }
  });

  it('returns MCP isError=true with structured diagnostics on whole-tool failures while preserving partial success and normal ambiguity/not_found', async () => {
    // 1. All StoreSearch 403 -> resolve_game, get_game_status, all-failed get_games_status all return isError:true
    const conn403 = await connectInMemory((url) => {
      if (url.pathname.endsWith('/api/storesearch/')) {
        return new Response('Forbidden', { status: 403 });
      }
      throw new Error(`Unexpected request to ${url.pathname}`);
    });
    try {
      const r1 = await conn403.client.callTool({ name: 'resolve_game', arguments: { query: 'Acme Signal' } });
      expect(r1.isError).toBe(true);
      const p1 = ResolveGameOutputSchema.parse(JSON.parse((r1.content[0] as { text: string }).text));
      expect(r1.structuredContent).toEqual(p1);
      expect(p1.resolution).toBe('error');
      expect(p1.error_code).toBe('access_denied');

      const r2 = await conn403.client.callTool({ name: 'get_game_status', arguments: { query: 'Acme Signal' } });
      expect(r2.isError).toBe(true);
      const p2 = GameStatusOutputSchema.parse(JSON.parse((r2.content[0] as { text: string }).text));
      expect(r2.structuredContent).toEqual(p2);
      expect(p2.resolution).toBe('error');
      expect(p2.error_code).toBe('access_denied');

      const r3 = await conn403.client.callTool({
        name: 'get_games_status',
        arguments: { queries: [{ query: 'Acme Signal' }, { query: 'Space Flight' }] },
      });
      expect(r3.isError).toBe(true);
      const p3 = GetGamesStatusOutputSchema.parse(JSON.parse((r3.content[0] as { text: string }).text));
      expect(r3.structuredContent).toEqual(p3);
      expect(p3.results.map((x) => [x.resolution, x.error_code])).toEqual([
        ['error', 'access_denied'],
        ['error', 'access_denied'],
      ]);
    } finally {
      await conn403.close();
    }

    // 2. Total source + metadata failure for resolved direct AppID distinguishes resolution from data failure and never fakes false
    const connAllFail = await connectInMemory((url) => {
      if (url.pathname.endsWith('/api/storesearch/')) return new Response('Forbidden', { status: 403 });
      if (url.pathname.endsWith('/GetOwnedGames/v1/')) return new Response('Unauthorized', { status: 401 });
      if (url.pathname.endsWith('/GetWishlist/v1/')) return jsonResp({ response: {} });
      if (url.pathname.endsWith('/GetItems/v1/')) return jsonResp({ response: { store_items: [] } });
      return jsonResp({}, 404);
    });
    try {
      const single = await connAllFail.client.callTool({ name: 'get_game_status', arguments: { query: '10' } });
      expect(single.isError).toBe(true);
      const ps = GameStatusOutputSchema.parse(JSON.parse((single.content[0] as { text: string }).text));
      expect(single.structuredContent).toEqual(ps);
      expect(ps.resolution).toBe('resolved');
      expect(ps.appid).toBe(10);
      expect(ps.owned).toBeNull();
      expect(ps.wishlisted).toBeNull();
      expect(ps.owned_error_code).toBe('invalid_api_key');
      expect(ps.wishlist_error_code).toBe('invalid_response');
      expect(ps.metadata_status).toBe('unavailable');

      const batch = await connAllFail.client.callTool({
        name: 'get_games_status',
        arguments: { queries: [{ query: '10' }, { query: 'Signal' }] },
      });
      expect(batch.isError).toBe(true);
      const pb = GetGamesStatusOutputSchema.parse(JSON.parse((batch.content[0] as { text: string }).text));
      expect(batch.structuredContent).toEqual(pb);
      expect(pb.results.map((x) => x.resolution)).toEqual(['resolved', 'error']);
    } finally {
      await connAllFail.close();
    }

    // 3. StoreSearch 0 + Owned explicit empty + Wishlist missing items:
    //    - resolve_game & get_game_status on name -> resolution=error, search_complete=false, isError=true
    //    - get_game_status on direct AppID -> partial success (owned=false, wishlisted=null, isError=false)
    const connPartialFallback = await connectInMemory((url) => {
      if (url.pathname.endsWith('/api/storesearch/')) return jsonResp({ total: 0, items: [] });
      if (url.pathname.endsWith('/GetOwnedGames/v1/')) return jsonResp({ response: { game_count: 0, games: [] } });
      if (url.pathname.endsWith('/GetWishlist/v1/')) return jsonResp({ response: {} });
      if (url.pathname.endsWith('/GetItems/v1/')) return jsonResp({ response: { store_items: [] } });
      return jsonResp({}, 404);
    });
    try {
      const direct = await connPartialFallback.client.callTool({ name: 'get_game_status', arguments: { query: '480' } });
      const pd = GameStatusOutputSchema.parse(assertStructuredMatchesText(direct as never));
      expect(pd.owned).toBe(false);
      expect(pd.wishlisted).toBeNull();

      const resName = await connPartialFallback.client.callTool({ name: 'resolve_game', arguments: { query: 'No Match' } });
      expect(resName.isError).toBe(true);
      const pr = ResolveGameOutputSchema.parse(JSON.parse((resName.content[0] as { text: string }).text));
      expect(pr.resolution).toBe('error');
      expect(pr.search_complete).toBe(false);
      expect(pr.error_code).toBe('invalid_response');

      const statusName = await connPartialFallback.client.callTool({ name: 'get_game_status', arguments: { query: 'No Match' } });
      expect(statusName.isError).toBe(true);
      const psn = GameStatusOutputSchema.parse(JSON.parse((statusName.content[0] as { text: string }).text));
      expect(psn.resolution).toBe('error');
      expect(psn.search_complete).toBe(false);
      expect(psn.error_code).toBe('invalid_response');
    } finally {
      await connPartialFallback.close();
    }

    // 4. Two verified homonyms + owned 401 + wishlist 403 -> single & batch return normal ambiguous (isError !== true),
    //    mixed batch with direct AppID + ambiguous also preserves normal answer (isError !== true),
    //    while pure direct AppID with both collection sources failing returns isError === true with resolved appid + diagnostics
    const connAmbigBothFail = await connectInMemory((url) => {
      if (url.pathname.endsWith('/api/storesearch/')) {
        return jsonResp({
          total: 2,
          items: [
            { id: 10, type: 'app', name: 'Signal' },
            { id: 11, type: 'app', name: 'Signal' },
          ],
        });
      }
      if (url.pathname.endsWith('/GetItems/v1/')) {
        return jsonResp({
          response: {
            store_items: [
              { item_type: 0, id: 10, appid: 10, success: 1, visible: true, type: 0, name: 'Signal' },
              { item_type: 0, id: 11, appid: 11, success: 1, visible: true, type: 0, name: 'Signal' },
            ],
          },
        });
      }
      if (url.pathname.endsWith('/GetOwnedGames/v1/')) return new Response('Unauthorized', { status: 401 });
      if (url.pathname.endsWith('/GetWishlist/v1/')) return new Response('Forbidden', { status: 403 });
      return jsonResp({}, 404);
    });
    try {
      const singleAmb = await connAmbigBothFail.client.callTool({
        name: 'get_game_status',
        arguments: { query: 'Signal' },
      });
      const psa = GameStatusOutputSchema.parse(assertStructuredMatchesText(singleAmb as never));
      expect(psa.resolution).toBe('ambiguous');
      expect(psa.appid).toBeNull();
      expect(psa.owned).toBeNull();
      expect(psa.wishlisted).toBeNull();
      expect(psa.owned_error_code).toBe('invalid_api_key');
      expect(psa.wishlist_error_code).toBe('access_denied');
      expect(psa.candidates.map((c) => [c.appid, c.owned, c.wishlisted])).toEqual([
        [10, null, null],
        [11, null, null],
      ]);

      const batchAmb = await connAmbigBothFail.client.callTool({
        name: 'get_games_status',
        arguments: { queries: [{ query: 'Signal' }] },
      });
      const pba = GetGamesStatusOutputSchema.parse(assertStructuredMatchesText(batchAmb as never));
      expect(pba.results[0]?.resolution).toBe('ambiguous');

      const mixedAmbAndDirect = await connAmbigBothFail.client.callTool({
        name: 'get_games_status',
        arguments: { queries: [{ query: '10' }, { query: 'Signal' }] },
      });
      const pmad = GetGamesStatusOutputSchema.parse(assertStructuredMatchesText(mixedAmbAndDirect as never));
      expect(pmad.results.map((x) => x.resolution)).toEqual(['resolved', 'ambiguous']);
      expect(pmad.results[0]).toMatchObject({ appid: 10, owned: null, wishlisted: null });

      const pureDirectFail = await connAmbigBothFail.client.callTool({
        name: 'get_games_status',
        arguments: { queries: [{ query: '10' }] },
      });
      expect(pureDirectFail.isError).toBe(true);
      const ppdf = GetGamesStatusOutputSchema.parse(
        JSON.parse((pureDirectFail.content[0] as { text: string }).text),
      );
      expect(pureDirectFail.structuredContent).toEqual(ppdf);
      expect(ppdf.results[0]).toMatchObject({ resolution: 'resolved', appid: 10, owned: null, wishlisted: null });
    } finally {
      await connAmbigBothFail.close();
    }
  });

  it('shares in-flight GetItems metadata within a call, isolates languages, enforces a single 4-batch call-scoped fallback budget, and handles prototype-named languages', async () => {
    // 1. Concurrent different titles hitting the same candidate AppIDs [10, 11] with 30ms GetItems delay -> 1 GetItems batch
    const connInFlight = await connectInMemory(
      async (url) => {
        if (url.pathname.endsWith('/api/storesearch/')) {
          return jsonResp({
            total: 2,
            items: [
              { id: 10, type: 'app', name: 'First Signal' },
              { id: 11, type: 'app', name: 'Second Signal' },
            ],
          });
        }
        if (url.pathname.endsWith('/GetItems/v1/')) {
          await new Promise((r) => setTimeout(r, 30));
          const req = JSON.parse(url.searchParams.get('input_json') ?? '{}') as {
            ids: Array<{ appid: number }>;
            context: { language: string };
          };
          const prefix = req.context.language === 'japanese' ? 'JP ' : '';
          return jsonResp({
            response: {
              store_items: req.ids.map(({ appid }) => ({
                item_type: 0,
                id: appid,
                appid,
                success: 1,
                visible: true,
                type: 0,
                name: appid === 10 ? `${prefix}First Signal` : `${prefix}Second Signal`,
              })),
            },
          });
        }
        if (url.pathname.endsWith('/GetOwnedGames/v1/')) {
          return jsonResp({ response: { game_count: 1, games: [{ appid: 10 }] } });
        }
        if (url.pathname.endsWith('/GetWishlist/v1/')) {
          return jsonResp({ response: { items: [] } });
        }
        return jsonResp({}, 404);
      },
      { useRealClock: true },
    );
    try {
      const raw = await connInFlight.client.callTool({
        name: 'get_games_status',
        arguments: { queries: [{ query: 'First Signal' }, { query: 'Second Signal' }] },
      });
      const parsed = GetGamesStatusOutputSchema.parse(assertStructuredMatchesText(raw as never));
      expect(parsed.results.map((x) => x.appid)).toEqual([10, 11]);
      expect(connInFlight.counts.getItems).toBe(1);
      expect(connInFlight.counts.owned).toBe(1);
      expect(connInFlight.counts.wishlist).toBe(1);

      // Language isolation + zero cross-call caching: next call re-fetches and keeps english vs japanese distinct
      const raw2 = await connInFlight.client.callTool({
        name: 'get_games_status',
        arguments: {
          queries: [
            { query: '10', language: 'english' },
            { query: '10', language: 'ja' },
          ],
        },
      });
      const parsed2 = GetGamesStatusOutputSchema.parse(assertStructuredMatchesText(raw2 as never));
      expect(parsed2.results[0]?.name).toBe('First Signal');
      expect(parsed2.results[1]?.name).toBe('JP First Signal');
      expect(connInFlight.counts.getItems).toBe(3);
    } finally {
      await connInFlight.close();
    }

    // 2. Call-scoped 4-batch fallback budget across 3 different unmatched titles on a 401-item wishlist
    const connBudget = await connectInMemory((url) => {
      if (url.pathname.endsWith('/GetOwnedGames/v1/')) {
        return jsonResp({ response: { game_count: 0, games: [] } });
      }
      if (url.pathname.endsWith('/GetWishlist/v1/')) {
        return jsonResp({
          response: {
            items: Array.from({ length: 401 }, (_, i) => ({ appid: 1000 + i, priority: i })),
          },
        });
      }
      if (url.pathname.endsWith('/api/storesearch/')) {
        return jsonResp({ total: 0, items: [] });
      }
      if (url.pathname.endsWith('/GetItems/v1/')) {
        const req = JSON.parse(url.searchParams.get('input_json') ?? '{}') as {
          ids: Array<{ appid: number }>;
        };
        return jsonResp({
          response: {
            store_items: req.ids.map(({ appid }) => ({
              item_type: 0,
              id: appid,
              appid,
              success: 1,
              visible: true,
              type: 0,
              name: `Fixture ${appid}`,
            })),
          },
        });
      }
      return jsonResp({}, 404);
    });
    try {
      const raw = await connBudget.client.callTool({
        name: 'get_games_status',
        arguments: {
          queries: [
            { query: 'Unmatched One' },
            { query: 'Unmatched Two' },
            { query: 'Unmatched Three' },
          ],
        },
      });
      const parsed = GetGamesStatusOutputSchema.parse(assertStructuredMatchesText(raw as never));
      expect(connBudget.counts.owned).toBe(1);
      expect(connBudget.counts.wishlist).toBe(1);
      expect(connBudget.counts.getItems).toBe(4);
      const uniqueFetched = new Set(connBudget.getItemsCalls.flatMap((c) => c.ids));
      expect(uniqueFetched.size).toBe(200);
      expect(parsed.results.map((r) => r.search_complete)).toEqual([false, false, false]);
      expect(parsed.results.map((r) => r.error_code)).toEqual([
        'request_budget_exceeded',
        'request_budget_exceeded',
        'request_budget_exceeded',
      ]);
    } finally {
      await connBudget.close();
    }

    // 3. Prototype language name ("constructor") falls back cleanly without breaking batch or bleeding warnings
    const connProtoLang = await connectInMemory((url) => {
      if (url.pathname.endsWith('/GetOwnedGames/v1/')) {
        return jsonResp({ response: { game_count: 1, games: [{ appid: 10 }] } });
      }
      if (url.pathname.endsWith('/GetWishlist/v1/')) {
        return jsonResp({ response: { items: [{ appid: 11 }] } });
      }
      if (url.pathname.endsWith('/GetItems/v1/')) {
        const req = JSON.parse(url.searchParams.get('input_json') ?? '{}') as {
          ids: Array<{ appid: number }>;
        };
        return jsonResp({
          response: {
            store_items: req.ids.map(({ appid }) => ({
              item_type: 0,
              id: appid,
              appid,
              success: 1,
              visible: true,
              type: 0,
              name: appid === 10 ? 'Signal' : 'Other Title',
            })),
          },
        });
      }
      return jsonResp({}, 404);
    });
    try {
      const raw = await connProtoLang.client.callTool({
        name: 'get_games_status',
        arguments: {
          queries: [
            { query: '10', language: 'constructor' },
            { query: '10' },
            { query: '11', language: '__proto__' },
          ],
        },
      });
      const parsed = GetGamesStatusOutputSchema.parse(assertStructuredMatchesText(raw as never));
      expect(parsed.total).toBe(3);
      expect(parsed.results[0]).toMatchObject({ appid: 10, owned: true, requested_language: 'english' });
      expect(parsed.results[0]?.warnings?.some((w) => w.includes('constructor'))).toBe(true);
      // Item 1 (valid default language) MUST NOT inherit Item 0's unsupported-language warning!
      expect(parsed.results[1]).toMatchObject({ appid: 10, owned: true, requested_language: 'english' });
      expect(parsed.results[1]?.warnings).toBeUndefined();
      expect(parsed.results[2]).toMatchObject({ appid: 11, wishlisted: true, requested_language: 'english' });
      expect(parsed.results[2]?.warnings?.some((w) => w.includes('__proto__'))).toBe(true);
    } finally {
      await connProtoLang.close();
    }
  });

  it('prevents two slow shared fallbacks from starving a third fast name query while respecting maxConcurrency and handling queued AbortSignal cleanly', async () => {
    const hangUntilAbort = (init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        if (init?.signal?.aborted) {
          reject(new DOMException('Aborted', 'AbortError'));
          return;
        }
        init?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true },
        );
      });

    // 1. Concurrency=2 and concurrency=1: two slow shared fallbacks MUST NOT block third fast query
    for (const maxConcurrency of [2, 1]) {
      let active = 0;
      let peak = 0;
      const conn = await connectInMemory(
        async (url, init) => {
          active++;
          peak = Math.max(peak, active);
          try {
            if (url.pathname.endsWith('/api/storesearch/')) {
              const term = url.searchParams.get('term');
              return jsonResp(
                term === 'Fast'
                  ? {
                      total: 2,
                      items: [
                        { id: 10, type: 'app', name: 'Fast' },
                        { id: 11, type: 'app', name: 'Unrelated' },
                      ],
                    }
                  : { total: 0, items: [] },
              );
            }
            if (url.pathname.endsWith('/GetOwnedGames/v1/')) {
              return jsonResp({ response: { game_count: 1, games: [{ appid: 10, name: 'Fast' }] } });
            }
            if (url.pathname.endsWith('/GetWishlist/v1/')) {
              return jsonResp({ response: { items: [{ appid: 9000, priority: 1 }] } });
            }
            if (url.pathname.endsWith('/GetItems/v1/')) {
              const req = JSON.parse(url.searchParams.get('input_json') ?? '{}') as {
                ids: Array<{ appid: number }>;
              };
              const ids = req.ids.map((x) => x.appid);
              if (ids.includes(9000)) {
                return await hangUntilAbort(init);
              }
              return jsonResp({
                response: {
                  store_items: [
                    { item_type: 0, id: 10, appid: 10, success: 1, visible: true, type: 0, name: 'Fast' },
                    { item_type: 0, id: 11, appid: 11, success: 1, visible: true, type: 0, name: 'Unrelated' },
                  ],
                },
              });
            }
            return jsonResp({}, 404);
          } finally {
            active--;
          }
        },
        {
          configOverrides: { httpTimeoutMs: 220, toolTimeoutMs: 220, maxConcurrency },
          useRealClock: true,
        },
      );
      try {
        const raw = await conn.client.callTool({
          name: 'get_games_status',
          arguments: {
            queries: [{ query: 'Unlisted A' }, { query: 'Unlisted B' }, { query: 'Fast' }],
          },
        });
        const parsed = GetGamesStatusOutputSchema.parse(assertStructuredMatchesText(raw as never));
        expect(parsed.results[2], `concurrency=${maxConcurrency}`).toMatchObject({
          query: 'Fast',
          resolution: 'resolved',
          appid: 10,
          owned: true,
          wishlisted: false,
          search_complete: true,
        });
        expect(conn.counts.owned, `concurrency=${maxConcurrency}`).toBe(1);
        expect(conn.counts.wishlist, `concurrency=${maxConcurrency}`).toBe(1);
        expect(peak, `concurrency=${maxConcurrency}`).toBeLessThanOrEqual(maxConcurrency);
      } finally {
        await conn.close();
      }
    }

    // 2. Slow-but-successful shared fallback completes all 3 items with 1x owned, 1x wishlist, 1x fallback GetItems, peak <= 2
    let activeSuccess = 0;
    let peakSuccess = 0;
    const connSlowOk = await connectInMemory(
      async (url, init) => {
        activeSuccess++;
        peakSuccess = Math.max(peakSuccess, activeSuccess);
        try {
          if (url.pathname.endsWith('/api/storesearch/')) {
            const term = url.searchParams.get('term');
            return jsonResp(
              term === 'Fast'
                ? { total: 1, items: [{ id: 10, type: 'app', name: 'Fast' }] }
                : { total: 0, items: [] },
            );
          }
          if (url.pathname.endsWith('/GetOwnedGames/v1/')) {
            return jsonResp({ response: { game_count: 1, games: [{ appid: 10, name: 'Fast' }] } });
          }
          if (url.pathname.endsWith('/GetWishlist/v1/')) {
            return jsonResp({ response: { items: [{ appid: 9000, priority: 1 }] } });
          }
          if (url.pathname.endsWith('/GetItems/v1/')) {
            const req = JSON.parse(url.searchParams.get('input_json') ?? '{}') as {
              ids: Array<{ appid: number }>;
            };
            const ids = req.ids.map((x) => x.appid);
            if (ids.includes(9000)) {
              await new Promise<void>((resolve, reject) => {
                if (init?.signal?.aborted) {
                  reject(new DOMException('Aborted', 'AbortError'));
                  return;
                }
                const onAbort = () => {
                  clearTimeout(t);
                  reject(new DOMException('Aborted', 'AbortError'));
                };
                const t = setTimeout(() => {
                  init?.signal?.removeEventListener('abort', onAbort);
                  resolve();
                }, 60);
                init?.signal?.addEventListener('abort', onAbort, { once: true });
              });
              return jsonResp({
                response: {
                  store_items: [
                    { item_type: 0, id: 9000, appid: 9000, success: 1, visible: true, type: 0, name: 'Other' },
                  ],
                },
              });
            }
            return jsonResp({
              response: {
                store_items: [
                  { item_type: 0, id: 10, appid: 10, success: 1, visible: true, type: 0, name: 'Fast' },
                ],
              },
            });
          }
          return jsonResp({}, 404);
        } finally {
          activeSuccess--;
        }
      },
      { configOverrides: { httpTimeoutMs: 2_000, toolTimeoutMs: 2_000, maxConcurrency: 2 }, useRealClock: true },
    );
    try {
      const raw = await connSlowOk.client.callTool({
        name: 'get_games_status',
        arguments: {
          queries: [{ query: 'Unlisted A' }, { query: 'Unlisted B' }, { query: 'Fast' }],
        },
      });
      const parsed = GetGamesStatusOutputSchema.parse(assertStructuredMatchesText(raw as never));
      expect(parsed.results[2]).toMatchObject({
        resolution: 'resolved',
        appid: 10,
        owned: true,
        wishlisted: false,
      });
      expect(parsed.results[0]).toMatchObject({ resolution: 'not_found', search_complete: true });
      expect(parsed.results[1]).toMatchObject({ resolution: 'not_found', search_complete: true });
      expect(connSlowOk.counts.owned).toBe(1);
      expect(connSlowOk.counts.wishlist).toBe(1);
      expect(connSlowOk.getItemsCalls.filter((c) => c.ids.includes(9000))).toHaveLength(1);
      expect(peakSuccess).toBeLessThanOrEqual(2);
    } finally {
      await connSlowOk.close();
    }

    // 3. AbortSignal cancelling queued concurrent batch settles cleanly with zero fetches after abort,
    //    and a subsequent normal batch on the same services succeeds without leaked semaphore slots.
    const cfg = makeConfig({ httpTimeoutMs: 5_000, toolTimeoutMs: 5_000, maxConcurrency: 2 });
    let abortFetchCount = 0;
    let fetchesAfterAbort = 0;
    const ac = new AbortController();
    const abortableFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (ac.signal.aborted) {
        fetchesAfterAbort++;
      }
      abortFetchCount++;
      const url = new URL(String(input));
      if (url.pathname.endsWith('/api/storesearch/')) {
        if (!ac.signal.aborted && abortFetchCount >= 2) {
          queueMicrotask(() => ac.abort());
        }
        return await hangUntilAbort(init);
      }
      return jsonResp({ response: { game_count: 0, games: [], items: [], store_items: [] } });
    });

    const http = new SteamHttpClient({
      httpTimeoutMs: cfg.httpTimeoutMs,
      maxConcurrency: cfg.maxConcurrency,
      maxRetries: 0,
      secrets: [cfg.steamApiKey],
      fetchFn: abortableFetch,
    });
    const steam = new SteamApiClient(http, cfg);
    const library = new LibraryService(steam, cfg);
    const metadata = new MetadataService(steam, cfg);
    const resolver = new GameResolverService(steam, library, metadata, cfg);

    const abortedOut = await handleGetGamesStatus(
      { config: cfg, library, metadata, resolver },
      {
        queries: [
          { query: 'Queued 1' },
          { query: 'Queued 2' },
          { query: 'Queued 3' },
          { query: 'Queued 4' },
        ],
      },
      ac.signal,
    );
    expect(abortedOut.results.every((r) => r.resolution === 'error' && r.error_code === 'timeout')).toBe(
      true,
    );
    expect(fetchesAfterAbort).toBe(0);
    expect(abortFetchCount).toBeLessThanOrEqual(2);

    // Subsequent normal request on the same HTTP client / semaphore completes cleanly
    const okCfg = makeConfig({ httpTimeoutMs: 5_000, toolTimeoutMs: 5_000, maxConcurrency: 2 });
    const normalFetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/api/storesearch/')) {
        return jsonResp({ total: 1, items: [{ id: 10, type: 'app', name: 'After Abort' }] });
      }
      if (url.pathname.endsWith('/GetItems/v1/')) {
        return jsonResp({
          response: {
            store_items: [{ item_type: 0, id: 10, appid: 10, success: 1, visible: true, type: 0, name: 'After Abort' }],
          },
        });
      }
      if (url.pathname.endsWith('/GetOwnedGames/v1/')) {
        return jsonResp({ response: { game_count: 1, games: [{ appid: 10, name: 'After Abort' }] } });
      }
      if (url.pathname.endsWith('/GetWishlist/v1/')) {
        return jsonResp({ response: { items: [] } });
      }
      return jsonResp({}, 404);
    });
    // Swap behavior by verifying the SAME http semaphore is released with a non-aborted call
    abortableFetch.mockImplementation(normalFetch);
    const afterAbort = await handleGetGamesStatus(
      { config: okCfg, library, metadata, resolver },
      { queries: [{ query: 'After Abort' }] },
    );
    expect(afterAbort.results[0]).toMatchObject({ resolution: 'resolved', appid: 10, owned: true });
  });

  it('uses collision-free structured deduplication keys across colons, delimiters, Unicode, optional fields, and non-equivalent normalizations while sharing true duplicates', async () => {
    // Direct key collision regressions
    expect(
      computeDeduplicationKey(
        { query: 'Signal:English:Cut', alternative_names: ['The Movie'] },
        'english',
      ),
    ).not.toBe(
      computeDeduplicationKey(
        { query: 'Signal', alternative_names: ['Cut:English:The Movie'] },
        'english',
      ),
    );
    expect(
      computeDeduplicationKey({ query: 'Signal', alternative_names: ['A\u0000B'] }, 'english'),
    ).not.toBe(
      computeDeduplicationKey({ query: 'Signal', alternative_names: ['A', 'B'] }, 'english'),
    );
    expect(
      computeDeduplicationKey({ query: 'Signal', alternative_names: ['["a","b"]'] }, 'english'),
    ).not.toBe(
      computeDeduplicationKey({ query: 'Signal', alternative_names: ['a', 'b'] }, 'english'),
    );
    expect(computeDeduplicationKey({ query: 'Signal' }, 'english')).not.toBe(
      computeDeduplicationKey({ query: 'Signal', alternative_names: ['Alt'] }, 'english'),
    );
    // Preserve search distinctions that normalizeComparable/normalizeLoose would collapse
    expect(computeDeduplicationKey({ query: 'Signal: Cut' }, 'english')).not.toBe(
      computeDeduplicationKey({ query: 'Signal - Cut' }, 'english'),
    );
    expect(computeDeduplicationKey({ query: 'Signal+' }, 'english')).not.toBe(
      computeDeduplicationKey({ query: 'Signal' }, 'english'),
    );
    expect(computeDeduplicationKey({ query: 'Wiedźmin 3' }, 'polish')).not.toBe(
      computeDeduplicationKey({ query: 'Wiedzmin 3' }, 'polish'),
    );
    expect(computeDeduplicationKey({ query: '赛博朋克 2077' }, 'schinese')).not.toBe(
      computeDeduplicationKey({ query: '赛博朋克2077' }, 'schinese'),
    );
    // True duplicates (case/whitespace/reordered alternative_names/omitted vs empty alt array) DO share keys
    expect(
      computeDeduplicationKey(
        { query: 'Signal:English:Cut', alternative_names: ['B', 'A'] },
        'english',
      ),
    ).toBe(
      computeDeduplicationKey(
        { query: '  signal:english:cut ', alternative_names: ['a', 'B'] },
        'english',
      ),
    );
    expect(computeDeduplicationKey({ query: 'Signal' }, 'english')).toBe(
      computeDeduplicationKey({ query: 'Signal', alternative_names: [] }, 'english'),
    );
    // ASCII/Unicode surrounding whitespace deduplicates consistently for names, AppIDs, URLs, and rejected URLs
    expect(computeDeduplicationKey({ query: '  Hades  ' }, 'english')).toBe(
      computeDeduplicationKey({ query: '\u3000\tHades\u00a0' }, 'english'),
    );
    expect(computeDeduplicationKey({ query: '  Hades  ' }, 'english')).toBe(
      computeDeduplicationKey({ query: 'Hades' }, 'english'),
    );
    expect(computeDeduplicationKey({ query: '  10  ' }, 'english')).toBe(
      computeDeduplicationKey({ query: '\thttps://store.steampowered.com/app/10/Signal/\u3000' }, 'english'),
    );
    expect(computeDeduplicationKey({ query: '  10  ' }, 'english')).toBe(
      computeDeduplicationKey({ query: '10' }, 'english'),
    );
    expect(computeDeduplicationKey({ query: '  10  ', language: 'en' }, 'english')).not.toBe(
      computeDeduplicationKey({ query: '  10  ', language: 'ja' }, 'english'),
    );
    expect(computeDeduplicationKey({ query: '  https://store.steampowered.com/bundle/232/  ' }, 'english')).toBe(
      computeDeduplicationKey({ query: 'https://store.steampowered.com/bundle/232/' }, 'english'),
    );

    // End-to-end batch verification: colon-containing titles resolve independently with separate collection states,
    // while genuine duplicates (including ASCII/Unicode whitespace-padded names/AppIDs/URLs) share work
    // and preserve exact per-index raw input query strings and order
    const searchTerms: string[] = [];
    const conn = await connectInMemory((url) => {
      if (url.pathname.endsWith('/api/storesearch/')) {
        const term = url.searchParams.get('term') ?? '';
        searchTerms.push(term);
        if (term === 'Signal:English:Cut') {
          return jsonResp({ total: 1, items: [{ id: 10, type: 'app', name: 'Signal:English:Cut' }] });
        }
        if (term === 'Signal') {
          return jsonResp({ total: 1, items: [{ id: 11, type: 'app', name: 'Signal' }] });
        }
        if (term === 'シグナル：完全版') {
          return jsonResp({ total: 1, items: [{ id: 12, type: 'app', name: 'シグナル：完全版' }] });
        }
        return jsonResp({ total: 0, items: [] });
      }
      if (url.pathname.endsWith('/GetOwnedGames/v1/')) {
        return jsonResp({ response: { game_count: 1, games: [{ appid: 10 }] } });
      }
      if (url.pathname.endsWith('/GetWishlist/v1/')) {
        return jsonResp({ response: { items: [{ appid: 11 }, { appid: 12 }] } });
      }
      if (url.pathname.endsWith('/GetItems/v1/')) {
        const req = JSON.parse(url.searchParams.get('input_json') ?? '{}') as {
          ids: Array<{ appid: number }>;
          context?: { language?: string };
        };
        const lang = req.context?.language ?? 'english';
        const names: Record<number, string> = {
          10: lang === 'japanese' ? 'シグナル：カット' : 'Signal:English:Cut',
          11: 'Signal',
          12: 'シグナル：完全版',
        };
        return jsonResp({
          response: {
            store_items: req.ids.map(({ appid }) => ({
              item_type: 0,
              id: appid,
              appid,
              success: 1,
              visible: true,
              type: 0,
              name: names[appid] ?? `App ${appid}`,
            })),
          },
        });
      }
      return jsonResp({}, 404);
    });
    try {
      const raw = await conn.client.callTool({
        name: 'get_games_status',
        arguments: {
          queries: [
            { query: '  Signal:English:Cut  ', alternative_names: ['The Movie'] },
            { query: '\u3000\tSignal\u00a0', alternative_names: ['Cut:English:The Movie'] },
            { query: 'signal:english:cut', alternative_names: ['the movie'] },
            { query: 'シグナル：完全版', language: 'ja', alternative_names: ['Alt 1', 'Alt 2'] },
            { query: '  10  ' },
            { query: '\thttps://store.steampowered.com/app/10/Signal/\u3000' },
            { query: '  10  ', language: 'ja' },
          ],
        },
      });
      const parsed = GetGamesStatusOutputSchema.parse(assertStructuredMatchesText(raw as never));
      expect(parsed.results.map((r) => r.query)).toEqual([
        '  Signal:English:Cut  ',
        '\u3000\tSignal\u00a0',
        'signal:english:cut',
        'シグナル：完全版',
        '  10  ',
        '\thttps://store.steampowered.com/app/10/Signal/\u3000',
        '  10  ',
      ]);
      expect(parsed.results.map((r) => [r.appid, r.requested_language, r.name, r.owned, r.wishlisted])).toEqual([
        [10, 'english', 'Signal:English:Cut', true, false],
        [11, 'english', 'Signal', false, true],
        [10, 'english', 'Signal:English:Cut', true, false],
        [12, 'japanese', 'シグナル：完全版', false, true],
        [10, 'english', 'Signal:English:Cut', true, false],
        [10, 'english', 'Signal:English:Cut', true, false],
        [10, 'japanese', 'シグナル：カット', true, false],
      ]);
      // Item 0 and Item 2 shared deduplicated work (trimmed 'Signal:English:Cut' searched only once)
      expect(searchTerms).toContain('Signal:English:Cut');
      expect(searchTerms).toContain('Signal');
      expect(searchTerms.filter((t) => t.toLowerCase() === 'signal:english:cut')).toHaveLength(1);
      expect(searchTerms.every((t) => t === t.trim())).toBe(true);
      // Direct AppID 10 shared one english GetItems call (deduped across AppID & URL) and one japanese GetItems call
      expect(conn.counts.owned).toBe(1);
      expect(conn.counts.wishlist).toBe(1);
      const directJaCalls = conn.getItemsCalls.filter(
        (c) => c.language === 'japanese' && c.ids.includes(10),
      );
      expect(directJaCalls).toHaveLength(1);
      const englishId10Calls = conn.getItemsCalls.filter(
        (c) => c.language === 'english' && c.ids.includes(10),
      );
      expect(englishId10Calls).toHaveLength(1);
    } finally {
      await conn.close();
    }
  });

  it('uses idle HTTP slots cleanly across multi-language fallbacks, queued-vs-in-flight promotion, known-AppID display metadata, and partial collection fallback', async () => {
    const hangUntilAbort = (init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        if (init?.signal?.aborted) {
          reject(new DOMException('Aborted', 'AbortError'));
          return;
        }
        init?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true },
        );
      });

    // 1a. Two fallback languages with one idle slot: hanging English fallback does NOT block Japanese fallback
    //     when no higher-priority work remains; also works when a third slow StoreSearch finishes first.
    for (const includeThirdFast of [false, true]) {
      let active = 0;
      let peak = 0;
      const conn = await connectInMemory(
        async (url, init) => {
          active++;
          peak = Math.max(peak, active);
          try {
            if (url.pathname.endsWith('/api/storesearch/')) {
              const term = url.searchParams.get('term');
              if (term === 'Fast') {
                await new Promise((r) => setTimeout(r, 60));
                return jsonResp({ total: 1, items: [{ id: 12, type: 'app', name: 'Fast' }] });
              }
              return jsonResp({ total: 0, items: [] });
            }
            if (url.pathname.endsWith('/GetOwnedGames/v1/')) {
              return jsonResp({ response: { game_count: 0, games: [] } });
            }
            if (url.pathname.endsWith('/GetWishlist/v1/')) {
              return jsonResp({ response: { items: [{ appid: 10 }] } });
            }
            if (url.pathname.endsWith('/GetItems/v1/')) {
              const req = JSON.parse(url.searchParams.get('input_json') ?? '{}') as {
                ids: Array<{ appid: number }>;
                context: { language: string };
              };
              const ids = req.ids.map((x) => x.appid);
              if (ids.includes(12)) {
                return jsonResp({
                  response: {
                    store_items: [{ item_type: 0, id: 12, appid: 12, success: 1, visible: true, type: 0, name: 'Fast' }],
                  },
                });
              }
              if (req.context.language === 'english') {
                return await hangUntilAbort(init);
              }
              return jsonResp({
                response: {
                  store_items: [{ item_type: 0, id: 10, appid: 10, success: 1, visible: true, type: 0, name: '隠れたゲーム' }],
                },
              });
            }
            return jsonResp({}, 404);
          } finally {
            active--;
          }
        },
        { configOverrides: { httpTimeoutMs: 250, toolTimeoutMs: 250, maxConcurrency: 2 }, useRealClock: true },
      );
      try {
        const queries = includeThirdFast
          ? [{ query: 'Slow personal' }, { query: '隠れたゲーム', language: 'ja' }, { query: 'Fast' }]
          : [{ query: 'Slow personal' }, { query: '隠れたゲーム', language: 'ja' }];
        const raw = await conn.client.callTool({ name: 'get_games_status', arguments: { queries } });
        const parsed = GetGamesStatusOutputSchema.parse(assertStructuredMatchesText(raw as never));
        expect(peak).toBeLessThanOrEqual(2);
        expect(parsed.results[1]).toMatchObject({
          resolution: 'resolved',
          appid: 10,
          wishlisted: true,
          metadata_status: 'complete',
        });
        if (includeThirdFast) {
          expect(parsed.results[2]).toMatchObject({
            resolution: 'resolved',
            appid: 12,
            wishlisted: false,
          });
        }
        expect(conn.getItemsCalls.some((c) => c.language === 'japanese')).toBe(true);
      } finally {
        await conn.close();
      }
    }

    // 1b. Queued low-priority fallback chunk [11] behind hanging [10] (batchSize=1) is claimed immediately
    //     by higher-priority StoreSearch verification for Fast, with exactly 1 GetItems call for 11.
    {
      let active = 0;
      let peak = 0;
      const conn = await connectInMemory(
        async (url, init) => {
          active++;
          peak = Math.max(peak, active);
          try {
            if (url.pathname.endsWith('/api/storesearch/')) {
              const term = url.searchParams.get('term');
              if (term !== 'Fast') return jsonResp({ total: 0, items: [] });
              await new Promise((r) => setTimeout(r, 80));
              return jsonResp({ total: 1, items: [{ id: 11, type: 'app', name: 'Related Candidate' }] });
            }
            if (url.pathname.endsWith('/GetOwnedGames/v1/')) {
              return jsonResp({ response: { game_count: 0, games: [] } });
            }
            if (url.pathname.endsWith('/GetWishlist/v1/')) {
              return jsonResp({ response: { items: [{ appid: 10 }, { appid: 11 }] } });
            }
            if (url.pathname.endsWith('/GetItems/v1/')) {
              const req = JSON.parse(url.searchParams.get('input_json') ?? '{}') as {
                ids: Array<{ appid: number }>;
              };
              const ids = req.ids.map((x) => x.appid);
              if (ids.includes(10)) return await hangUntilAbort(init);
              return jsonResp({
                response: {
                  store_items: [{ item_type: 0, id: 11, appid: 11, success: 1, visible: true, type: 0, name: 'Fast' }],
                },
              });
            }
            return jsonResp({}, 404);
          } finally {
            active--;
          }
        },
        {
          configOverrides: { httpTimeoutMs: 300, toolTimeoutMs: 300, maxConcurrency: 2, metadataBatchSize: 1 },
          useRealClock: true,
        },
      );
      try {
        const raw = await conn.client.callTool({
          name: 'get_games_status',
          arguments: { queries: [{ query: 'Slow personal' }, { query: 'Fast' }] },
        });
        const parsed = GetGamesStatusOutputSchema.parse(assertStructuredMatchesText(raw as never));
        expect(peak).toBeLessThanOrEqual(2);
        expect(parsed.results[1]).toMatchObject({ resolution: 'resolved', appid: 11, wishlisted: true });
        expect(conn.getItemsCalls.filter((c) => c.ids.includes(11))).toHaveLength(1);
      } finally {
        await conn.close();
      }
    }

    // 1c. Known AppID optional display metadata runs on idle slot when either owned or wishlist hangs
    //     (both get_games_status and get_game_status), while still protecting healthy retrying sources.
    for (const slowSource of ['owned', 'wishlist'] as const) {
      for (const toolName of ['get_games_status', 'get_game_status'] as const) {
        let active = 0;
        let peak = 0;
        const conn = await connectInMemory(
          async (url, init) => {
            active++;
            peak = Math.max(peak, active);
            try {
              if (url.pathname.endsWith('/GetOwnedGames/v1/')) {
                if (slowSource === 'owned') return await hangUntilAbort(init);
                return jsonResp({ response: { game_count: 1, games: [{ appid: 10 }] } });
              }
              if (url.pathname.endsWith('/GetWishlist/v1/')) {
                if (slowSource === 'wishlist') return await hangUntilAbort(init);
                return jsonResp({ response: { items: [{ appid: 10 }] } });
              }
              if (url.pathname.endsWith('/GetItems/v1/')) {
                return jsonResp({
                  response: {
                    store_items: [{ item_type: 0, id: 10, appid: 10, success: 1, visible: true, type: 0, name: 'Ten' }],
                  },
                });
              }
              return jsonResp({}, 404);
            } finally {
              active--;
            }
          },
          { configOverrides: { httpTimeoutMs: 200, toolTimeoutMs: 200, maxConcurrency: 2 }, useRealClock: true },
        );
        try {
          const raw = await conn.client.callTool({
            name: toolName,
            arguments: toolName === 'get_games_status' ? { queries: [{ query: '10' }] } : { query: '10' },
          });
          expect(peak).toBeLessThanOrEqual(2);
          expect(conn.counts.getItems).toBe(1);
          const item =
            toolName === 'get_games_status'
              ? GetGamesStatusOutputSchema.parse(assertStructuredMatchesText(raw as never)).results[0]!
              : GameStatusOutputSchema.parse(assertStructuredMatchesText(raw as never));
          expect(item.owned).toBe(slowSource === 'owned' ? null : true);
          expect(item.wishlisted).toBe(slowSource === 'wishlist' ? null : true);
          expect(item.name).toBe('Ten');
          expect(item.metadata_status).toBe('complete');
        } finally {
          await conn.close();
        }
      }
    }

    // 1c safety: healthy owned source retrying after 503 is NOT starved by hanging multi-chunk optional direct metadata
    {
      let ownedAttempts = 0;
      const conn = await connectInMemory(
        async (url, init) => {
          if (url.pathname.endsWith('/GetOwnedGames/v1/')) {
            ownedAttempts++;
            if (ownedAttempts === 1) return new Response('Service Unavailable', { status: 503 });
            return jsonResp({ response: { game_count: 1, games: [{ appid: 10 }] } });
          }
          if (url.pathname.endsWith('/GetWishlist/v1/')) {
            return jsonResp({ response: { items: [{ appid: 10 }] } });
          }
          if (url.pathname.endsWith('/GetItems/v1/')) {
            return await hangUntilAbort(init);
          }
          return jsonResp({}, 404);
        },
        {
          configOverrides: { httpTimeoutMs: 200, toolTimeoutMs: 200, maxConcurrency: 2, metadataBatchSize: 1 },
          useRealClock: true,
        },
      );
      try {
        const raw = await conn.client.callTool({
          name: 'get_games_status',
          arguments: { queries: [{ query: '10' }, { query: '11' }] },
        });
        const parsed = GetGamesStatusOutputSchema.parse(assertStructuredMatchesText(raw as never));
        expect(parsed.owned_data_status).toBe('ok');
        expect(parsed.wishlist_data_status).toBe('ok');
        expect(parsed.results[0]).toMatchObject({ appid: 10, owned: true, wishlisted: true, metadata_status: 'unavailable' });
        expect(ownedAttempts).toBe(2);
      } finally {
        await conn.close();
      }
    }

    // 1d. Partial collection fallback consumes healthy wishlist (or healthy owned) immediately while peer hangs,
    //     preserving candidate evidence and confirmed source membership without fabricating top-level identity.
    for (const slowSource of ['owned', 'wishlist'] as const) {
      let active = 0;
      let peak = 0;
      const conn = await connectInMemory(
        async (url, init) => {
          active++;
          peak = Math.max(peak, active);
          try {
            if (url.pathname.endsWith('/api/storesearch/')) {
              return jsonResp({ total: 0, items: [] });
            }
            if (url.pathname.endsWith('/GetOwnedGames/v1/')) {
              if (slowSource === 'owned') return await hangUntilAbort(init);
              return jsonResp({ response: { game_count: 1, games: [{ appid: 10, name: 'Hidden Game' }] } });
            }
            if (url.pathname.endsWith('/GetWishlist/v1/')) {
              if (slowSource === 'wishlist') return await hangUntilAbort(init);
              return jsonResp({ response: { items: [{ appid: 10 }] } });
            }
            if (url.pathname.endsWith('/GetItems/v1/')) {
              return jsonResp({
                response: {
                  store_items: [{ item_type: 0, id: 10, appid: 10, success: 1, visible: true, type: 0, name: 'Hidden Game' }],
                },
              });
            }
            return jsonResp({}, 404);
          } finally {
            active--;
          }
        },
        { configOverrides: { httpTimeoutMs: 200, toolTimeoutMs: 200, maxConcurrency: 2 }, useRealClock: true },
      );
      try {
        const raw = await conn.client.callTool({
          name: 'get_games_status',
          arguments: { queries: [{ query: 'Hidden Game' }] },
        });
        const parsed = GetGamesStatusOutputSchema.parse(assertStructuredMatchesText(raw as never));
        expect(peak).toBeLessThanOrEqual(2);
        expect(conn.counts.owned).toBe(1);
        expect(conn.counts.wishlist).toBe(1);
        expect(conn.counts.getItems).toBe(1);
        expect(parsed.results[0]).toMatchObject({
          resolution: 'ambiguous',
          appid: null,
          owned: null,
          wishlisted: null,
          search_complete: false,
        });
        expect(parsed.results[0]!.candidates).toEqual([
          expect.objectContaining({
            appid: 10,
            name: 'Hidden Game',
            owned: slowSource === 'owned' ? null : true,
            wishlisted: slowSource === 'wishlist' ? null : true,
          }),
        ]);
      } finally {
        await conn.close();
      }
    }

    // 1d shared AppID across delayed healthy owned & wishlist sources (both arrival orders):
    //    exactly 1x GetOwnedGames, 1x GetWishlist, 1x GetItems, deterministic personal_library_fallback provenance.
    for (const delayedSource of ['owned', 'wishlist'] as const) {
      const conn = await connectInMemory(
        async (url) => {
          if (url.pathname.endsWith('/api/storesearch/')) {
            return jsonResp({ total: 0, items: [] });
          }
          if (url.pathname.endsWith('/GetOwnedGames/v1/')) {
            if (delayedSource === 'owned') await new Promise((r) => setTimeout(r, 40));
            return jsonResp({ response: { game_count: 1, games: [{ appid: 10, name: 'Shared Hidden' }] } });
          }
          if (url.pathname.endsWith('/GetWishlist/v1/')) {
            if (delayedSource === 'wishlist') await new Promise((r) => setTimeout(r, 40));
            return jsonResp({ response: { items: [{ appid: 10 }] } });
          }
          if (url.pathname.endsWith('/GetItems/v1/')) {
            return jsonResp({
              response: {
                store_items: [{ item_type: 0, id: 10, appid: 10, success: 1, visible: true, type: 0, name: 'Shared Hidden' }],
              },
            });
          }
          return jsonResp({}, 404);
        },
        { configOverrides: { httpTimeoutMs: 2_000, toolTimeoutMs: 2_000, maxConcurrency: 2 }, useRealClock: true },
      );
      try {
        const raw = await conn.client.callTool({
          name: 'get_games_status',
          arguments: { queries: [{ query: 'Shared Hidden' }] },
        });
        const parsed = GetGamesStatusOutputSchema.parse(assertStructuredMatchesText(raw as never));
        expect(conn.counts.owned).toBe(1);
        expect(conn.counts.wishlist).toBe(1);
        expect(conn.counts.getItems).toBe(1);
        expect(parsed.results[0]).toMatchObject({
          resolution: 'resolved',
          appid: 10,
          identity_source: 'personal_library_fallback',
          owned: true,
          wishlisted: true,
          search_complete: true,
        });
        expect(parsed.results[0]!.candidates[0]?.match_source).toBe('owned_library_fallback');
      } finally {
        await conn.close();
      }
    }
  });

  it('prevents shared in-flight metadata waiters from starving fast queries/low-priority work and lets same-language independent fallback chunks use idle slots within maxConcurrency', async () => {
    const hangUntilAbort = (init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        if (init?.signal?.aborted) {
          reject(new DOMException('Aborted', 'AbortError'));
          return;
        }
        init?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true },
        );
      });

    // 1. P1: Distinct name queries sharing a hanging GetItems([10]) never starve an unrelated Fast query
    //    (3-item forward/reverse, 50-item forward/reverse, and slow StoreSearch + shared GetItems), with peak <= 2.
    const p1Cases: Array<{ label: string; queries: Array<{ query: string }>; fastIndex: number; slowSearchTerm?: string }> = [
      {
        label: '3-item-forward',
        queries: [{ query: 'Slow A' }, { query: 'Slow B' }, { query: 'Fast' }],
        fastIndex: 2,
      },
      {
        label: '3-item-reverse',
        queries: [{ query: 'Fast' }, { query: 'Slow A' }, { query: 'Slow B' }],
        fastIndex: 0,
      },
      {
        label: '50-item-forward',
        queries: [
          ...Array.from({ length: 49 }, (_, i) => ({ query: `Slow ${i + 1}` })),
          { query: 'Fast' },
        ],
        fastIndex: 49,
      },
      {
        label: '50-item-reverse',
        queries: [
          { query: 'Fast' },
          ...Array.from({ length: 49 }, (_, i) => ({ query: `Slow ${i + 1}` })),
        ],
        fastIndex: 0,
      },
      {
        label: 'slow-storesearch-and-shared-getitems',
        queries: [{ query: 'SlowSearchA' }, { query: 'Slow B' }, { query: 'Fast' }],
        fastIndex: 2,
        slowSearchTerm: 'SlowSearchA',
      },
    ];

    for (const tc of p1Cases) {
      let active = 0;
      let peak = 0;
      const conn = await connectInMemory(
        async (url, init) => {
          active++;
          peak = Math.max(peak, active);
          try {
            if (url.pathname.endsWith('/api/storesearch/')) {
              const term = url.searchParams.get('term');
              if (tc.slowSearchTerm && term === tc.slowSearchTerm) {
                await new Promise((r) => setTimeout(r, 40));
              }
              return jsonResp(
                term === 'Fast'
                  ? { total: 1, items: [{ id: 11, type: 'app', name: 'Fast' }] }
                  : { total: 1, items: [{ id: 10, type: 'app', name: 'Possible related candidate' }] },
              );
            }
            if (url.pathname.endsWith('/GetOwnedGames/v1/')) {
              return jsonResp({ response: { game_count: 0, games: [] } });
            }
            if (url.pathname.endsWith('/GetWishlist/v1/')) {
              return jsonResp({ response: { items: [{ appid: 11 }] } });
            }
            if (url.pathname.endsWith('/GetItems/v1/')) {
              const req = JSON.parse(url.searchParams.get('input_json') ?? '{}') as {
                ids: Array<{ appid: number }>;
              };
              const ids = req.ids.map((x) => x.appid);
              if (ids.includes(10)) return await hangUntilAbort(init);
              return jsonResp({
                response: {
                  store_items: [{ item_type: 0, id: 11, appid: 11, success: 1, visible: true, type: 0, name: 'Fast' }],
                },
              });
            }
            return jsonResp({}, 404);
          } finally {
            active--;
          }
        },
        {
          configOverrides: { httpTimeoutMs: 260, toolTimeoutMs: 260, maxConcurrency: 2, metadataBatchSize: 1 },
          useRealClock: true,
        },
      );
      try {
        const raw = await conn.client.callTool({
          name: 'get_games_status',
          arguments: { queries: tc.queries },
        });
        const parsed = GetGamesStatusOutputSchema.parse(assertStructuredMatchesText(raw as never));
        expect(peak, tc.label).toBeLessThanOrEqual(2);
        expect(conn.counts.owned, tc.label).toBe(1);
        expect(conn.counts.wishlist, tc.label).toBe(1);
        expect(conn.getItemsCalls.filter((c) => c.ids.includes(10)), tc.label).toHaveLength(1);
        expect(parsed.results[tc.fastIndex], tc.label).toMatchObject({
          resolution: 'resolved',
          appid: 11,
          wishlisted: true,
        });
      } finally {
        await conn.close();
      }
    }

    // 1b. Shared in-flight Stage A waiters release low-priority slot reservations so direct-AppID metadata
    //     and independent personal fallback still complete on the idle second slot.
    {
      let active = 0;
      let peak = 0;
      const conn = await connectInMemory(
        async (url, init) => {
          active++;
          peak = Math.max(peak, active);
          try {
            if (url.pathname.endsWith('/api/storesearch/')) {
              const term = url.searchParams.get('term');
              if (term === 'Hidden Wish') return jsonResp({ total: 0, items: [] });
              return jsonResp({ total: 1, items: [{ id: 10, type: 'app', name: 'Related' }] });
            }
            if (url.pathname.endsWith('/GetOwnedGames/v1/')) {
              return jsonResp({ response: { game_count: 1, games: [{ appid: 12 }] } });
            }
            if (url.pathname.endsWith('/GetWishlist/v1/')) {
              return jsonResp({ response: { items: [{ appid: 11 }] } });
            }
            if (url.pathname.endsWith('/GetItems/v1/')) {
              const req = JSON.parse(url.searchParams.get('input_json') ?? '{}') as {
                ids: Array<{ appid: number }>;
              };
              const ids = req.ids.map((x) => x.appid);
              if (ids.includes(10)) return await hangUntilAbort(init);
              return jsonResp({
                response: {
                  store_items: ids.map((id) => ({
                    item_type: 0,
                    id,
                    appid: id,
                    success: 1,
                    visible: true,
                    type: 0,
                    name: id === 11 ? 'Hidden Wish' : 'Direct Twelve',
                  })),
                },
              });
            }
            return jsonResp({}, 404);
          } finally {
            active--;
          }
        },
        {
          configOverrides: { httpTimeoutMs: 240, toolTimeoutMs: 240, maxConcurrency: 2, metadataBatchSize: 1 },
          useRealClock: true,
        },
      );
      try {
        const raw = await conn.client.callTool({
          name: 'get_games_status',
          arguments: {
            queries: [
              { query: 'Slow A' },
              { query: 'Slow B' },
              { query: '12' },
              { query: 'Hidden Wish' },
            ],
          },
        });
        const parsed = GetGamesStatusOutputSchema.parse(assertStructuredMatchesText(raw as never));
        expect(peak).toBeLessThanOrEqual(2);
        expect(conn.counts.owned).toBe(1);
        expect(conn.counts.wishlist).toBe(1);
        expect(conn.getItemsCalls.filter((c) => c.ids.includes(10))).toHaveLength(1);
        expect(parsed.results[2]).toMatchObject({
          resolution: 'resolved',
          appid: 12,
          name: 'Direct Twelve',
          metadata_status: 'complete',
          owned: true,
        });
        expect(parsed.results[3]).toMatchObject({
          resolution: 'resolved',
          appid: 11,
          name: 'Hidden Wish',
          wishlisted: true,
        });
      } finally {
        await conn.close();
      }
    }

    // 2. P2: Same-language independent personal fallback chunks use idle HTTP slots up to maxConcurrency:
    //    wishlist [10, 11], batchSize=1, maxConcurrency=2, GetItems([10]) hangs, [11] returns "Hidden Wish" ->
    //    preserves candidate 11 (wishlisted=true), top-level null, search_complete=false, isError!==true, peak<=2.
    {
      let active = 0;
      let peak = 0;
      const conn = await connectInMemory(
        async (url, init) => {
          active++;
          peak = Math.max(peak, active);
          try {
            if (url.pathname.endsWith('/api/storesearch/')) return jsonResp({ total: 0, items: [] });
            if (url.pathname.endsWith('/GetOwnedGames/v1/')) {
              return jsonResp({ response: { game_count: 0, games: [] } });
            }
            if (url.pathname.endsWith('/GetWishlist/v1/')) {
              return jsonResp({ response: { items: [{ appid: 10 }, { appid: 11 }] } });
            }
            if (url.pathname.endsWith('/GetItems/v1/')) {
              const req = JSON.parse(url.searchParams.get('input_json') ?? '{}') as {
                ids: Array<{ appid: number }>;
              };
              const ids = req.ids.map((x) => x.appid);
              if (ids.includes(10)) return await hangUntilAbort(init);
              return jsonResp({
                response: {
                  store_items: [{ item_type: 0, id: 11, appid: 11, success: 1, visible: true, type: 0, name: 'Hidden Wish' }],
                },
              });
            }
            return jsonResp({}, 404);
          } finally {
            active--;
          }
        },
        {
          configOverrides: { httpTimeoutMs: 220, toolTimeoutMs: 220, maxConcurrency: 2, metadataBatchSize: 1 },
          useRealClock: true,
        },
      );
      try {
        const raw = await conn.client.callTool({
          name: 'get_game_status',
          arguments: { query: 'Hidden Wish' },
        });
        const parsed = GameStatusOutputSchema.parse(assertStructuredMatchesText(raw as never));
        expect(peak).toBeLessThanOrEqual(2);
        expect(conn.counts.owned).toBe(1);
        expect(conn.counts.wishlist).toBe(1);
        expect(conn.getItemsCalls.filter((c) => c.ids.includes(11))).toHaveLength(1);
        expect(parsed).toMatchObject({
          resolution: 'ambiguous',
          appid: null,
          owned: null,
          wishlisted: null,
          search_complete: false,
        });
        expect(parsed.candidates).toEqual([
          expect.objectContaining({ appid: 11, name: 'Hidden Wish', wishlisted: true }),
        ]);
      } finally {
        await conn.close();
      }
    }

    // 2b. Cross-language fairness preserved even when the first fallback language has multiple hanging chunks:
    //     both english chunks [10, 11] hang, yet japanese fallback still gets the idle slot and resolves cleanly.
    {
      let active = 0;
      let peak = 0;
      const conn = await connectInMemory(
        async (url, init) => {
          active++;
          peak = Math.max(peak, active);
          try {
            if (url.pathname.endsWith('/api/storesearch/')) return jsonResp({ total: 0, items: [] });
            if (url.pathname.endsWith('/GetOwnedGames/v1/')) {
              await new Promise((r) => setTimeout(r, 15));
              return jsonResp({ response: { game_count: 0, games: [] } });
            }
            if (url.pathname.endsWith('/GetWishlist/v1/')) {
              await new Promise((r) => setTimeout(r, 15));
              return jsonResp({ response: { items: [{ appid: 10 }, { appid: 11 }] } });
            }
            if (url.pathname.endsWith('/GetItems/v1/')) {
              const req = JSON.parse(url.searchParams.get('input_json') ?? '{}') as {
                ids: Array<{ appid: number }>;
                context: { language: string };
              };
              if (req.context.language === 'english') return await hangUntilAbort(init);
              return jsonResp({
                response: {
                  store_items: req.ids.map(({ appid }) => ({
                    item_type: 0,
                    id: appid,
                    appid,
                    success: 1,
                    visible: true,
                    type: 0,
                    name: appid === 11 ? '隠れたゲーム' : '別のゲーム',
                  })),
                },
              });
            }
            return jsonResp({}, 404);
          } finally {
            active--;
          }
        },
        {
          configOverrides: { httpTimeoutMs: 250, toolTimeoutMs: 250, maxConcurrency: 2, metadataBatchSize: 1 },
          useRealClock: true,
        },
      );
      try {
        const raw = await conn.client.callTool({
          name: 'get_games_status',
          arguments: { queries: [{ query: 'Slow EN' }, { query: '隠れたゲーム', language: 'ja' }] },
        });
        const parsed = GetGamesStatusOutputSchema.parse(assertStructuredMatchesText(raw as never));
        expect(peak).toBeLessThanOrEqual(2);
        expect(conn.counts.owned).toBe(1);
        expect(conn.counts.wishlist).toBe(1);
        expect(parsed.results[1]).toMatchObject({
          resolution: 'resolved',
          appid: 11,
          wishlisted: true,
          search_complete: true,
        });
      } finally {
        await conn.close();
      }
    }
  });

  it('preserves normal-priority continuation lease across required default-language verification without letting queued low-priority metadata steal the slot', async () => {
    const hangUntilAbort = (init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        if (init?.signal?.aborted) {
          reject(new DOMException('Aborted', 'AbortError'));
          return;
        }
        init?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true },
        );
      });

    // 1. P1 regression (forward and reverse input orders):
    //    concurrency=2, batchSize=1, hanging optional direct AppIDs [20, 21] plus a French name query
    //    with alternative_names requiring a follow-up English GetItems([11]) verification.
    //    Completing French GetItems([11]) must NOT drop normal demand to 0 before English GetItems([11])
    //    is scheduled, so hanging [21] cannot steal slot 2 and starve required English verification.
    const nameQuery = {
      query: 'Nom obscur',
      language: 'fr',
      alternative_names: ['Visible alternate title'],
    };
    const hangingDirects = [{ query: '20' }, { query: '21' }];

    for (const reverse of [false, true]) {
      const queries = reverse ? [...hangingDirects, nameQuery] : [nameQuery, ...hangingDirects];
      let active = 0;
      let peak = 0;
      const conn = await connectInMemory(
        async (url, init) => {
          active++;
          peak = Math.max(peak, active);
          try {
            if (url.pathname.endsWith('/GetOwnedGames/v1/')) {
              return jsonResp({ response: { game_count: 0, games: [] } });
            }
            if (url.pathname.endsWith('/GetWishlist/v1/')) {
              return jsonResp({ response: { items: [{ appid: 11 }] } });
            }
            if (url.pathname.endsWith('/api/storesearch/')) {
              const term = url.searchParams.get('term');
              return jsonResp(
                term === 'Visible alternate title'
                  ? { total: 1, items: [{ id: 11, type: 'app', name: 'Related' }] }
                  : { total: 0, items: [] },
              );
            }
            if (url.pathname.endsWith('/GetItems/v1/')) {
              const req = JSON.parse(url.searchParams.get('input_json') ?? '{}') as {
                ids: Array<{ appid: number }>;
                context: { language: string };
              };
              const ids = req.ids.map((x) => x.appid);
              if (!ids.includes(11)) {
                return await hangUntilAbort(init);
              }
              return jsonResp({
                response: {
                  store_items: [
                    {
                      item_type: 0,
                      id: 11,
                      appid: 11,
                      success: 1,
                      visible: true,
                      type: 0,
                      name:
                        req.context.language === 'english'
                          ? 'Visible alternate title'
                          : 'Titre apparenté',
                    },
                  ],
                },
              });
            }
            return jsonResp({}, 404);
          } finally {
            active--;
          }
        },
        {
          configOverrides: {
            httpTimeoutMs: 260,
            toolTimeoutMs: 260,
            maxConcurrency: 2,
            metadataBatchSize: 1,
          },
          useRealClock: true,
        },
      );

      try {
        const raw = await conn.client.callTool({
          name: 'get_games_status',
          arguments: { queries },
        });
        const parsed = GetGamesStatusOutputSchema.parse(assertStructuredMatchesText(raw as never));
        expect(peak, `reverse=${reverse}`).toBeLessThanOrEqual(2);
        expect(conn.counts.owned, `reverse=${reverse}`).toBe(1);
        expect(conn.counts.wishlist, `reverse=${reverse}`).toBe(1);
        expect(
          parsed.results.map((r) => r.query),
          `reverse=${reverse}`,
        ).toEqual(queries.map((q) => q.query));

        const nameRow = parsed.results.find((r) => r.query === nameQuery.query);
        expect(nameRow, `reverse=${reverse}`).toMatchObject({
          resolution: 'resolved',
          appid: 11,
          owned: false,
          wishlisted: true,
          search_complete: true,
        });
        expect(nameRow?.error_code, `reverse=${reverse}`).toBeUndefined();
        expect(
          conn.getItemsCalls.filter((c) => c.ids.includes(11) && c.language === 'english'),
          `reverse=${reverse}`,
        ).toHaveLength(1);
        expect(
          conn.getItemsCalls.filter((c) => c.ids.includes(11) && c.language === 'french'),
          `reverse=${reverse}`,
        ).toHaveLength(1);
      } finally {
        await conn.close();
      }
    }

    // 2. Shared/promoted primary-language metadata + required default-language verification:
    //    even when French AppID 11 is also requested by a direct AppID query (deduplicated/cached),
    //    queued hanging [20, 21] still cannot preempt English GetItems([11]), and French [11] runs once.
    {
      let active = 0;
      let peak = 0;
      const conn = await connectInMemory(
        async (url, init) => {
          active++;
          peak = Math.max(peak, active);
          try {
            if (url.pathname.endsWith('/GetOwnedGames/v1/')) {
              return jsonResp({ response: { game_count: 0, games: [] } });
            }
            if (url.pathname.endsWith('/GetWishlist/v1/')) {
              return jsonResp({ response: { items: [{ appid: 11 }] } });
            }
            if (url.pathname.endsWith('/api/storesearch/')) {
              const term = url.searchParams.get('term');
              return jsonResp(
                term === 'Visible alternate title'
                  ? { total: 1, items: [{ id: 11, type: 'app', name: 'Related' }] }
                  : { total: 0, items: [] },
              );
            }
            if (url.pathname.endsWith('/GetItems/v1/')) {
              const req = JSON.parse(url.searchParams.get('input_json') ?? '{}') as {
                ids: Array<{ appid: number }>;
                context: { language: string };
              };
              const ids = req.ids.map((x) => x.appid);
              if (!ids.includes(11)) {
                return await hangUntilAbort(init);
              }
              return jsonResp({
                response: {
                  store_items: [
                    {
                      item_type: 0,
                      id: 11,
                      appid: 11,
                      success: 1,
                      visible: true,
                      type: 0,
                      name:
                        req.context.language === 'english'
                          ? 'Visible alternate title'
                          : 'Titre apparenté',
                    },
                  ],
                },
              });
            }
            return jsonResp({}, 404);
          } finally {
            active--;
          }
        },
        {
          configOverrides: {
            httpTimeoutMs: 260,
            toolTimeoutMs: 260,
            maxConcurrency: 2,
            metadataBatchSize: 1,
          },
          useRealClock: true,
        },
      );

      try {
        const queries = [
          { query: '20' },
          { query: '21' },
          { query: '11', language: 'fr' },
          nameQuery,
        ];
        const raw = await conn.client.callTool({
          name: 'get_games_status',
          arguments: { queries },
        });
        const parsed = GetGamesStatusOutputSchema.parse(assertStructuredMatchesText(raw as never));
        expect(peak).toBeLessThanOrEqual(2);
        expect(conn.counts.owned).toBe(1);
        expect(conn.counts.wishlist).toBe(1);
        expect(parsed.results[2]).toMatchObject({
          resolution: 'resolved',
          appid: 11,
          name: 'Titre apparenté',
          wishlisted: true,
          metadata_status: 'complete',
        });
        expect(parsed.results[3]).toMatchObject({
          resolution: 'resolved',
          appid: 11,
          wishlisted: true,
          search_complete: true,
        });
        expect(parsed.results[3]?.error_code).toBeUndefined();
        expect(
          conn.getItemsCalls.filter((c) => c.ids.includes(11) && c.language === 'french'),
        ).toHaveLength(1);
        expect(
          conn.getItemsCalls.filter((c) => c.ids.includes(11) && c.language === 'english'),
        ).toHaveLength(1);
      } finally {
        await conn.close();
      }
    }

    // 3. A normal task with alternative_names that is purely waiting on an unsettled shared hanging
    //    entry MUST still drop its normal demand to 0 so an unrelated direct AppID completes on slot 2.
    {
      let active = 0;
      let peak = 0;
      const conn = await connectInMemory(
        async (url, init) => {
          active++;
          peak = Math.max(peak, active);
          try {
            if (url.pathname.endsWith('/GetOwnedGames/v1/')) {
              return jsonResp({ response: { game_count: 1, games: [{ appid: 12 }] } });
            }
            if (url.pathname.endsWith('/GetWishlist/v1/')) {
              return jsonResp({ response: { items: [] } });
            }
            if (url.pathname.endsWith('/api/storesearch/')) {
              return jsonResp({ total: 1, items: [{ id: 10, type: 'app', name: 'Shared Slow' }] });
            }
            if (url.pathname.endsWith('/GetItems/v1/')) {
              const req = JSON.parse(url.searchParams.get('input_json') ?? '{}') as {
                ids: Array<{ appid: number }>;
              };
              const ids = req.ids.map((x) => x.appid);
              if (ids.includes(10)) {
                return await hangUntilAbort(init);
              }
              return jsonResp({
                response: {
                  store_items: [
                    {
                      item_type: 0,
                      id: 12,
                      appid: 12,
                      success: 1,
                      visible: true,
                      type: 0,
                      name: 'Direct Twelve',
                    },
                  ],
                },
              });
            }
            return jsonResp({}, 404);
          } finally {
            active--;
          }
        },
        {
          configOverrides: {
            httpTimeoutMs: 260,
            toolTimeoutMs: 260,
            maxConcurrency: 2,
            metadataBatchSize: 1,
          },
          useRealClock: true,
        },
      );

      try {
        const raw = await conn.client.callTool({
          name: 'get_games_status',
          arguments: {
            queries: [
              { query: 'Slow Owner', language: 'fr' },
              { query: 'Slow Waiter', language: 'fr', alternative_names: ['Alt Waiter'] },
              { query: '12' },
            ],
          },
        });
        const parsed = GetGamesStatusOutputSchema.parse(assertStructuredMatchesText(raw as never));
        expect(peak).toBeLessThanOrEqual(2);
        expect(conn.counts.owned).toBe(1);
        expect(conn.counts.wishlist).toBe(1);
        expect(
          conn.getItemsCalls.filter((c) => c.ids.includes(10) && c.language === 'french'),
        ).toHaveLength(1);
        expect(parsed.results[2]).toMatchObject({
          resolution: 'resolved',
          appid: 12,
          name: 'Direct Twelve',
          owned: true,
          metadata_status: 'complete',
        });
      } finally {
        await conn.close();
      }
    }
  });
});
