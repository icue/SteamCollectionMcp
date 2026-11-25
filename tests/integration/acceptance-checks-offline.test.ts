import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import type { ServerConfig } from '../../src/config.js';
import type { FetchFn } from '../../src/clients/http.js';
import { createSteamCollectionServer } from '../../src/server.js';
import {
  makeLargeOwnedGamesFixture,
  TEST_STEAM_API_KEY,
  TEST_STEAM_ID,
} from '../fixtures/steam-responses.js';
import {
  createReadOnlyFetchObserver,
  parseLiveMutationConfig,
  verifyLargeOwnedLibrary,
  verifyLiveWishlistFreshness,
  verifyPublicWishlistAgainstUpstream,
} from './live-acceptance-checks.js';

function makeConfig(): ServerConfig {
  return {
    steamApiKey: TEST_STEAM_API_KEY,
    steamId: TEST_STEAM_ID,
    country: 'US',
    language: 'english',
    httpTimeoutMs: 5_000,
    maxConcurrency: 2,
    metadataBatchSize: 50,
    toolTimeoutMs: 30_000,
  };
}

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function withMockedObservedClient<T>(
  rawFetchFn: FetchFn,
  fn: (ctx: {
    client: Client;
    observer: ReturnType<typeof createReadOnlyFetchObserver>;
  }) => Promise<T>,
): Promise<T> {
  const observer = createReadOnlyFetchObserver(rawFetchFn);
  const server = createSteamCollectionServer(makeConfig(), {
    fetchFn: observer.fetchFn,
    sleep: async () => {},
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'live-check-regression', version: '0.1.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return await fn({ client, observer });
  } finally {
    await client.close();
    await server.close();
  }
}

describe('Strict live acceptance check assertions (synthetic offline regressions)', () => {
  it('accepts a consistent >= 2,000 owned library with 1x GetOwnedGames and rejects small libraries (< 2,000)', async () => {
    const largeOwned = makeLargeOwnedGamesFixture(2_050);
    await withMockedObservedClient(
      async (input) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith('/GetOwnedGames/v1/')) {
          return jsonResp(largeOwned);
        }
        return jsonResp({}, 404);
      },
      async ({ client, observer }) => {
        const summary = await verifyLargeOwnedLibrary({ client, observer, minGames: 2_000 });
        expect(summary.gameCount).toBe(2_050);
        expect(summary.uniqueAppIdCount).toBe(2_050);
        expect(summary.toolTotal).toBe(2_050);
        expect(summary.ownedFetchCount).toBe(1);
      },
    );

    // Small library (< 2,000) MUST fail the strict assertion
    const smallOwned = makeLargeOwnedGamesFixture(500);
    await withMockedObservedClient(
      async (input) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith('/GetOwnedGames/v1/')) {
          return jsonResp(smallOwned);
        }
        return jsonResp({}, 404);
      },
      async ({ client, observer }) => {
        await expect(
          verifyLargeOwnedLibrary({ client, observer, minGames: 2_000 }),
        ).rejects.toThrow(/below required threshold \(2000\)/);
      },
    );

    // Duplicate AppID mismatch (2001/2001/2000/2000) MUST be rejected by strict 4-way equality gate
    const dupGames = Array.from({ length: 2_000 }, (_, i) => ({
      appid: 10_000 + i,
      name: `Game ${i}`,
      playtime_forever: 0,
    }));
    const dupPayload = {
      response: {
        game_count: 2_001,
        games: [...dupGames, dupGames[0]!],
      },
    };
    await withMockedObservedClient(
      async (input) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith('/GetOwnedGames/v1/')) {
          return jsonResp(dupPayload);
        }
        return jsonResp({}, 404);
      },
      async ({ client, observer }) => {
        await expect(
          verifyLargeOwnedLibrary({ client, observer, minGames: 2_000 }),
        ).rejects.toThrow(/unique AppID count \(2000\) does not equal raw game_count \(2001\)/);
      },
    );
  });

  it('verifies public wishlist against independent upstream GetWishlist and rejects sample/priority/date mismatches', async () => {
    const sharedWishlist = {
      response: {
        items: Array.from({ length: 40 }, (_, i) => ({
          appid: 50_000 + i,
          priority: i === 39 ? undefined : 40 - i,
          date_added: 1_700_000_000 + i * 100,
        })),
      },
    };

    const makeFetch = (wishlistPayload: unknown): FetchFn => async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/GetWishlist/v1/')) {
        return jsonResp(wishlistPayload);
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
              name: `Game ${appid}`,
            })),
          },
        });
      }
      return jsonResp({}, 404);
    };

    // Matching upstream & MCP tool passes
    await withMockedObservedClient(makeFetch(sharedWishlist), async ({ client }) => {
      const summary = await verifyPublicWishlistAgainstUpstream({
        client,
        steamId: TEST_STEAM_ID,
        upstreamFetchFn: makeFetch(sharedWishlist),
        sampleSize: 25,
        checkMetadataPage: true,
      });
      expect(summary.upstreamTotal).toBe(40);
      expect(summary.toolTotal).toBe(40);
      expect(summary.headSampleChecked).toBe(25);
      expect(summary.tailSampleChecked).toBe(10);
      expect(summary.metadataPageStatus).toBe('complete');
    });

    // Sample mismatch (different priority / date_added between independent upstream and MCP tool) MUST fail
    const tamperedUpstream = {
      response: {
        items: sharedWishlist.response.items.map((item, idx) =>
          idx === 38 ? { ...item, date_added: item.date_added + 999 } : item,
        ),
      },
    };
    await withMockedObservedClient(makeFetch(sharedWishlist), async ({ client }) => {
      await expect(
        verifyPublicWishlistAgainstUpstream({
          client,
          steamId: TEST_STEAM_ID,
          upstreamFetchFn: makeFetch(tamperedUpstream),
          sampleSize: 25,
        }),
      ).rejects.toThrow(/disagrees with independent upstream GetWishlist/);
    });
  });

  it('requires real observed change on live freshness check and rejects unchanged state or bad preconditions', async () => {
    let wishlisted = false;
    const makeStatefulFetch = (): FetchFn => async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/GetOwnedGames/v1/')) {
        return jsonResp({ response: { game_count: 0, games: [] } });
      }
      if (url.pathname.endsWith('/GetWishlist/v1/')) {
        return jsonResp({
          response: {
            items: wishlisted ? [{ appid: 400, priority: 1, date_added: 1_700_000_000 }] : [],
          },
        });
      }
      if (url.pathname.endsWith('/GetItems/v1/')) {
        return jsonResp({
          response: {
            store_items: [
              { item_type: 0, id: 400, appid: 400, success: 1, visible: true, type: 0, name: 'Portal' },
            ],
          },
        });
      }
      return jsonResp({}, 404);
    };

    // 1. Expected add transition (false -> true) succeeds and asserts 2 live GetWishlist fetches
    wishlisted = false;
    await withMockedObservedClient(makeStatefulFetch(), async ({ client, observer }) => {
      const res = await verifyLiveWishlistFreshness({
        client,
        observer,
        appid: 400,
        expect: 'add',
        waitMs: 0,
        onBeforeWait: () => {
          wishlisted = true;
        },
      });
      expect(res.beforeWishlisted).toBe(false);
      expect(res.afterWishlisted).toBe(true);
      expect(res.wishlistFetchDelta).toBe(2);
    });

    // 2. Expected remove transition (true -> false) succeeds
    wishlisted = true;
    await withMockedObservedClient(makeStatefulFetch(), async ({ client, observer }) => {
      const res = await verifyLiveWishlistFreshness({
        client,
        observer,
        appid: 400,
        expect: 'remove',
        waitMs: 0,
        onBeforeWait: () => {
          wishlisted = false;
        },
      });
      expect(res.beforeWishlisted).toBe(true);
      expect(res.afterWishlisted).toBe(false);
      expect(res.wishlistFetchDelta).toBe(2);
    });

    // 3. No change observed (false -> false) MUST fail!
    wishlisted = false;
    await withMockedObservedClient(makeStatefulFetch(), async ({ client, observer }) => {
      await expect(
        verifyLiveWishlistFreshness({
          client,
          observer,
          appid: 400,
          expect: 'add',
          waitMs: 0,
        }),
      ).rejects.toThrow(/did not change between Read 1 and Read 2/);
    });

    // 4. Wrong precondition (expect='add' when already wishlisted=true) MUST fail!
    wishlisted = true;
    await withMockedObservedClient(makeStatefulFetch(), async ({ client, observer }) => {
      await expect(
        verifyLiveWishlistFreshness({
          client,
          observer,
          appid: 400,
          expect: 'add',
          waitMs: 0,
        }),
      ).rejects.toThrow(/precondition failed/);
    });
  });

  it('validates live mutation parameter parsing and missing-input skip behavior', () => {
    expect(parseLiveMutationConfig({})).toMatchObject({ configured: false });
    expect(
      parseLiveMutationConfig({
        STEAM_LIVE_MUTATION_APPID: '400',
        STEAM_LIVE_MUTATION_EXPECT: 'ADD',
        STEAM_LIVE_MUTATION_WAIT_MS: '15000',
      }),
    ).toEqual({
      configured: true,
      appid: 400,
      expect: 'add',
      waitMs: 15_000,
    });

    expect(() =>
      parseLiveMutationConfig({ STEAM_LIVE_MUTATION_APPID: '400' }),
    ).toThrow(/must be provided together/);

    // Error messages for operator parameters MUST NEVER echo raw values (which may accidentally be an API key)
    const simulatedSecret = 'SYNTHETIC_SECRET_KEY_NEVER_ECHO_999';
    try {
      parseLiveMutationConfig({
        STEAM_LIVE_MUTATION_APPID: simulatedSecret,
        STEAM_LIVE_MUTATION_EXPECT: 'add',
      });
      expect.unreachable('should have thrown for invalid STEAM_LIVE_MUTATION_APPID');
    } catch (err) {
      expect((err as Error).message).toContain('STEAM_LIVE_MUTATION_APPID');
      expect((err as Error).message).toContain('positive decimal uint32');
      expect((err as Error).message).not.toContain(simulatedSecret);
    }

    try {
      parseLiveMutationConfig({
        STEAM_LIVE_MUTATION_APPID: '400',
        STEAM_LIVE_MUTATION_EXPECT: simulatedSecret,
      });
      expect.unreachable('should have thrown for invalid STEAM_LIVE_MUTATION_EXPECT');
    } catch (err) {
      expect((err as Error).message).toContain('STEAM_LIVE_MUTATION_EXPECT');
      expect((err as Error).message).toContain('"add" or "remove"');
      expect((err as Error).message).not.toContain(simulatedSecret);
    }

    try {
      parseLiveMutationConfig({
        STEAM_LIVE_MUTATION_APPID: '400',
        STEAM_LIVE_MUTATION_EXPECT: 'add',
        STEAM_LIVE_MUTATION_WAIT_MS: simulatedSecret,
      });
      expect.unreachable('should have thrown for invalid STEAM_LIVE_MUTATION_WAIT_MS');
    } catch (err) {
      expect((err as Error).message).toContain('STEAM_LIVE_MUTATION_WAIT_MS');
      expect((err as Error).message).not.toContain(simulatedSecret);
    }

    try {
      parseLiveMutationConfig({
        STEAM_LIVE_MUTATION_APPID: '400',
        STEAM_LIVE_MUTATION_EXPECT: 'add',
        STEAM_LIVE_MUTATION_WAIT_MS: '999999999',
      });
      expect.unreachable('should have thrown for out-of-range STEAM_LIVE_MUTATION_WAIT_MS');
    } catch (err) {
      expect((err as Error).message).toContain('STEAM_LIVE_MUTATION_WAIT_MS');
      expect((err as Error).message).not.toContain('999999999');
    }

    // Valid optional WAIT_MS alone (without APPID/EXPECT) preserves waiting-for-operator-input skip semantic
    expect(
      parseLiveMutationConfig({
        STEAM_LIVE_MUTATION_WAIT_MS: '15000',
      }),
    ).toMatchObject({ configured: false });
    expect(
      parseLiveMutationConfig({
        STEAM_LIVE_MUTATION_WAIT_MS: '0',
      }),
    ).toMatchObject({ configured: false });

    // Invalid WAIT_MS alone (even with APPID and EXPECT absent) MUST fail with sanitized message
    try {
      parseLiveMutationConfig({
        STEAM_LIVE_MUTATION_WAIT_MS: simulatedSecret,
      });
      expect.unreachable('should have thrown for invalid standalone STEAM_LIVE_MUTATION_WAIT_MS');
    } catch (err) {
      expect((err as Error).message).toContain('STEAM_LIVE_MUTATION_WAIT_MS');
      expect((err as Error).message).not.toContain(simulatedSecret);
    }

    // Invalid APPID alone (without EXPECT) validates APPID itself and reports sanitized error
    try {
      parseLiveMutationConfig({
        STEAM_LIVE_MUTATION_APPID: simulatedSecret,
      });
      expect.unreachable('should have thrown for invalid standalone STEAM_LIVE_MUTATION_APPID');
    } catch (err) {
      expect((err as Error).message).toContain('STEAM_LIVE_MUTATION_APPID');
      expect((err as Error).message).toContain('positive decimal uint32');
      expect((err as Error).message).not.toContain(simulatedSecret);
    }

    // Invalid EXPECT alone (without APPID) validates EXPECT itself and reports sanitized error
    try {
      parseLiveMutationConfig({
        STEAM_LIVE_MUTATION_EXPECT: simulatedSecret,
      });
      expect.unreachable('should have thrown for invalid standalone STEAM_LIVE_MUTATION_EXPECT');
    } catch (err) {
      expect((err as Error).message).toContain('STEAM_LIVE_MUTATION_EXPECT');
      expect((err as Error).message).toContain('"add" or "remove"');
      expect((err as Error).message).not.toContain(simulatedSecret);
    }
  });
});
