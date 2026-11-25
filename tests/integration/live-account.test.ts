import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import {
  GameStatusOutputSchema,
  GetGamesStatusOutputSchema,
  ResolveGameOutputSchema,
} from '../../src/schemas.js';
import { createSteamCollectionServer } from '../../src/server.js';
import {
  createReadOnlyFetchObserver,
  parseLiveMutationConfig,
  parseStructuredToolResult,
  verifyLargeOwnedLibrary,
  verifyLiveWishlistFreshness,
  verifyPublicWishlistAgainstUpstream,
} from './live-acceptance-checks.js';

/**
 * Strictly read-only live Steam account acceptance suite (Spec Section 10).
 *
 * Run via:
 *   npm run test:live
 *
 * Required environment variables for account gates (never logged):
 *   STEAM_API_KEY               Steam Web API Key (sent only to GetOwnedGames)
 *   STEAM_ID                    17-digit SteamID64 string
 *
 * Optional operator inputs for the manual real-time wishlist freshness gate:
 *   STEAM_LIVE_MUTATION_APPID   Positive uint32 AppID you will manually add/remove on Steam
 *   STEAM_LIVE_MUTATION_EXPECT  "add" (false -> true) or "remove" (true -> false)
 *   STEAM_LIVE_MUTATION_WAIT_MS Wait window in ms between Read 1 and Read 2 (default 30000)
 *
 * Neither the MCP server nor this test suite ever writes to Steam.
 * When credentials or mutation inputs are absent, the corresponding gates are explicitly
 * skipped and reported on stderr as NOT PASSED.
 */

const hasCredentials =
  Boolean(process.env['STEAM_API_KEY']?.trim()) && Boolean(process.env['STEAM_ID']?.trim());

// Always validate any provided STEAM_LIVE_MUTATION_* inputs before credential skip checks
// so malformed operator parameters fail fast with sanitized diagnostics and zero fetches.
const mutationConfig = parseLiveMutationConfig(process.env);

if (!hasCredentials) {
  process.stderr.write(
    '[live-acceptance] SKIPPED (gate NOT PASSED): missing STEAM_API_KEY and/or STEAM_ID — real large-library (>=2000), independent public wishlist, multilingual live probes, and real-time freshness gates were NOT verified.\n',
  );
} else if (!mutationConfig.configured) {
  process.stderr.write(
    `[live-acceptance] SKIPPED (gate NOT PASSED): ${mutationConfig.reason} — real-time manual wishlist freshness gate will NOT be verified.\n`,
  );
}

describe.skipIf(!hasCredentials)('Live Steam account acceptance (strict, read-only)', () => {
  async function withObservedLiveClient<T>(
    fn: (ctx: {
      client: Client;
      observer: ReturnType<typeof createReadOnlyFetchObserver>;
      steamId: string;
    }) => Promise<T>,
  ): Promise<T> {
    const config = loadConfig(process.env);
    const observer = createReadOnlyFetchObserver();
    const server = createSteamCollectionServer(config, {
      fetchFn: observer.fetchFn,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'live-acceptance-client', version: '0.1.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      return await fn({ client, observer, steamId: config.steamId });
    } finally {
      await client.close();
      await server.close();
    }
  }

  it('verifies large owned library (>= 2,000) against the exact single raw GetOwnedGames response', async () => {
    await withObservedLiveClient(async ({ client, observer }) => {
      const summary = await verifyLargeOwnedLibrary({
        client,
        observer,
        minGames: 2_000,
        pageLimit: 50,
      });

      process.stderr.write(
        `[live-acceptance] large_library=PASS game_count=${summary.gameCount} raw_records=${summary.rawRecordCount} unique_appids=${summary.uniqueAppIdCount} tool_total=${summary.toolTotal} owned_calls=${summary.ownedFetchCount} fetched_at=${summary.fetchedAt}\n`,
      );
    });
  });

  it('verifies public wishlist membership, priority, and date_added against independent upstream GetWishlist', async () => {
    await withObservedLiveClient(async ({ client, steamId }) => {
      const summary = await verifyPublicWishlistAgainstUpstream({
        client,
        steamId,
        sampleSize: 25,
        checkMetadataPage: true,
      });

      process.stderr.write(
        `[live-acceptance] public_wishlist=PASS upstream_total=${summary.upstreamTotal} tool_total=${summary.toolTotal} head_sample=${summary.headSampleChecked} tail_sample=${summary.tailSampleChecked} metadata_status=${summary.metadataPageStatus} fetched_at=${summary.fetchedAt}\n`,
      );
    });
  });

  it('verifies live multilingual resolution, ambiguity handling, and batch status query', async () => {
    await withObservedLiveClient(async ({ client }) => {
      const cpEn = parseStructuredToolResult(
        (await client.callTool({
          name: 'resolve_game',
          arguments: { query: 'Cyberpunk 2077' },
        })) as never,
        ResolveGameOutputSchema,
      );
      const cpZh = parseStructuredToolResult(
        (await client.callTool({
          name: 'resolve_game',
          arguments: { query: '赛博朋克 2077', language: 'zh-CN' },
        })) as never,
        ResolveGameOutputSchema,
      );
      const cpJa = parseStructuredToolResult(
        (await client.callTool({
          name: 'resolve_game',
          arguments: { query: 'サイバーパンク2077', language: 'ja' },
        })) as never,
        ResolveGameOutputSchema,
      );
      expect(cpEn.appid).toBe(1091500);
      expect(cpZh.appid).toBe(1091500);
      expect(cpJa.appid).toBe(1091500);

      const re4 = parseStructuredToolResult(
        (await client.callTool({
          name: 'resolve_game',
          arguments: { query: 'Resident Evil 4' },
        })) as never,
        ResolveGameOutputSchema,
      );
      expect(re4.resolution).toBe('ambiguous');
      expect(re4.appid).toBeNull();

      const single = parseStructuredToolResult(
        (await client.callTool({
          name: 'get_game_status',
          arguments: { query: '1091500' },
        })) as never,
        GameStatusOutputSchema,
      );
      expect(single.owned_data_status).toBe('ok');
      expect(single.wishlist_data_status).toBe('ok');

      const batch = parseStructuredToolResult(
        (await client.callTool({
          name: 'get_games_status',
          arguments: {
            queries: [{ query: '1091500' }, { query: 'Hades' }, { query: 'Resident Evil 4' }],
          },
        })) as never,
        GetGamesStatusOutputSchema,
      );
      expect(batch.total).toBe(3);
      expect(batch.results[2]!.owned).toBeNull();
      expect(batch.results[2]!.wishlisted).toBeNull();
    });
  });

  it.skipIf(!mutationConfig.configured)(
    'verifies live wishlist freshness across two MCP calls after manual Steam mutation',
    async () => {
      if (!mutationConfig.configured) return;

      await withObservedLiveClient(async ({ client, observer }) => {
        const summary = await verifyLiveWishlistFreshness({
          client,
          observer,
          appid: mutationConfig.appid,
          expect: mutationConfig.expect,
          waitMs: mutationConfig.waitMs,
          onBeforeWait: ({ appid, expect: action, beforeWishlisted, waitMs }) => {
            process.stderr.write(
              `[live-acceptance] Read 1 verified: appid=${appid} wishlisted=${String(beforeWishlisted)}. Waiting ${waitMs}ms — manually ${action} appid ${appid} in your Steam wishlist now...\n`,
            );
          },
        });

        process.stderr.write(
          `[live-acceptance] live_freshness=PASS appid=${summary.appid} expect=${summary.expect} before=${String(summary.beforeWishlisted)} after=${String(summary.afterWishlisted)} wishlist_calls=${summary.wishlistFetchDelta}\n`,
        );
      });
    },
    360_000,
  );
});
