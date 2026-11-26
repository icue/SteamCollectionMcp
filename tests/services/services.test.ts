import { describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '../../src/config.js';
import { SteamHttpClient } from '../../src/clients/http.js';
import { SteamApiClient } from '../../src/clients/steam.js';
import {
  deduplicateAndSortOwned,
  LibraryService,
  sortOwnedGamesByLastPlayed,
  sortOwnedGamesByPlaytime,
} from '../../src/services/library.js';
import { MetadataService } from '../../src/services/metadata.js';
import { GameResolverService, type ResolverBudgetOptions } from '../../src/services/resolver.js';
import { handleListOwnedGames, handleListWishlistGames } from '../../src/tools/lists.js';
import { handleResolveGame } from '../../src/tools/resolve.js';
import {
  makeGetItemsResponse,
  makeLargeOwnedGamesFixture,
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

function createHarness(
  fetchHandler: (url: URL) => Promise<Response> | Response,
  configOverrides?: Partial<ServerConfig>,
  budgets?: ResolverBudgetOptions,
) {
  const config = makeConfig(configOverrides);
  const calls: Array<{ pathname: string; url: URL }> = [];
  let tick = 1_764_000_000_000;
  const fetchFn = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push({ pathname: url.pathname, url });
    tick += 1000;
    return await fetchHandler(url);
  });

  const http = new SteamHttpClient({
    httpTimeoutMs: config.httpTimeoutMs,
    maxConcurrency: config.maxConcurrency,
    secrets: [config.steamApiKey],
    fetchFn,
    now: () => tick,
    sleep: async () => {},
  });
  const steam = new SteamApiClient(http, config);
  const library = new LibraryService(steam, config, () => tick);
  const metadata = new MetadataService(steam, config);
  const resolver = new GameResolverService(steam, library, metadata, config, budgets);

  return { config, calls, fetchFn, steam, library, metadata, resolver };
}

describe('LibraryService, MetadataService, and list tools', () => {
  it('handles 2,500+ simulated owned library: sorts by AppID, paginates locally, enriches ONLY current page, and skips GetItems when include_metadata=false', async () => {
    const largeOwned = makeLargeOwnedGamesFixture(2_500);
    const getItemsBatches: number[][] = [];

    const h = createHarness((url) => {
      if (url.pathname.endsWith('/GetOwnedGames/v1/')) {
        return jsonResp(largeOwned);
      }
      if (url.pathname.endsWith('/GetItems/v1/')) {
        const payload = JSON.parse(url.searchParams.get('input_json') ?? '{}') as {
          ids: Array<{ appid: number }>;
        };
        const ids = payload.ids.map((i) => i.appid);
        getItemsBatches.push(ids);
        return jsonResp({
          response: {
            store_items: ids.map((appid) => ({
              item_type: 0,
              id: appid,
              appid,
              success: 1,
              visible: true,
              type: 0,
              name: `Localized ${appid}`,
            })),
          },
        });
      }
      return jsonResp({}, 404);
    });

    // Page with include_metadata=false -> ZERO GetItems calls, include_appinfo=false
    const rawPage = await handleListOwnedGames(
      { config: h.config, library: h.library, metadata: h.metadata },
      { offset: 0, limit: 100, include_metadata: false },
    );
    expect(rawPage.ok).toBe(true);
    if (!rawPage.ok) return;
    expect(rawPage.output.total).toBe(2500);
    expect(rawPage.output.returned).toBe(100);
    expect(rawPage.output.has_more).toBe(true);
    expect(rawPage.output.metadata_status).toBe('skipped');
    expect(rawPage.output.games[0]!.appid).toBe(10_001);
    expect(rawPage.output.games[99]!.appid).toBe(10_100);
    expect(rawPage.output.games[0]!.name).toBeNull();
    expect(getItemsBatches).toHaveLength(0);
    expect(h.calls[0]!.url.searchParams.get('include_appinfo')).toBe('false');

    // Last page with include_metadata=true -> ONLY fetches 50 items (1 batch), NOT all 2,500
    const lastPage = await handleListOwnedGames(
      { config: h.config, library: h.library, metadata: h.metadata },
      { offset: 2450, limit: 100, language: 'ja', include_metadata: true },
    );
    expect(lastPage.ok).toBe(true);
    if (!lastPage.ok) return;
    expect(lastPage.output.total).toBe(2500);
    expect(lastPage.output.returned).toBe(50);
    expect(lastPage.output.has_more).toBe(false);
    expect(lastPage.output.metadata_status).toBe('complete');
    expect(lastPage.output.requested_language).toBe('japanese');
    expect(lastPage.output.games[0]!.appid).toBe(12_451);
    expect(lastPage.output.games[0]!.name).toBe('Localized 12451');
    expect(getItemsBatches).toHaveLength(1);
    expect(getItemsBatches[0]).toHaveLength(50);
  });

  it('sorts wishlist by priority asc (missing last) then AppID, preserves members with missing metadata, and has zero cross-call cache', async () => {
    let wishlistVersion = 1;
    const h = createHarness((url) => {
      if (url.pathname.endsWith('/GetWishlist/v1/')) {
        if (wishlistVersion === 1) {
          return jsonResp(WISHLIST_FIXTURES.sample);
        }
        return jsonResp({
          response: {
            items: [{ appid: 413150, priority: 1, date_added: 1699000000 }],
          },
        });
      }
      if (url.pathname.endsWith('/GetItems/v1/')) {
        const payload = JSON.parse(url.searchParams.get('input_json') ?? '{}') as {
          ids: Array<{ appid: number }>;
          context: { language: string };
        };
        return jsonResp(
          makeGetItemsResponse(
            payload.ids.map((i) => i.appid),
            payload.context.language,
          ),
        );
      }
      return jsonResp({}, 404);
    });

    const first = await handleListWishlistGames(
      { config: h.config, library: h.library, metadata: h.metadata },
      { offset: 0, limit: 100, language: 'zh-CN', include_metadata: true },
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // Order: priority 1 (413150), priority 2 (400 then 1086940), priority 5 (999999999), missing priority (1245620)
    expect(first.output.games.map((g) => g.appid)).toEqual([
      413150, 400, 1086940, 999999999, 1245620,
    ]);
    // Missing metadata item 999999999 MUST be preserved
    const missingItem = first.output.games.find((g) => g.appid === 999999999)!;
    expect(missingItem.name).toBeNull();
    expect(missingItem.app_type).toBe('unknown');
    expect(first.output.metadata_status).toBe('partial');
    expect(first.output.requested_language).toBe('schinese');
    // Localized Chinese title returned for BG3 & Elden Ring
    expect(first.output.games.find((g) => g.appid === 1086940)!.name).toBe('博德之门3');
    expect(first.output.games.find((g) => g.appid === 1245620)!.name).toBe('艾尔登法环');

    // Mutate upstream wishlist -> next tool call MUST re-fetch live with zero cache
    wishlistVersion = 2;
    const second = await handleListWishlistGames(
      { config: h.config, library: h.library, metadata: h.metadata },
      { offset: 0, limit: 100, include_metadata: false },
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.output.total).toBe(1);
    expect(second.output.games.map((g) => g.appid)).toEqual([413150]);
    expect(second.output.fetched_at).not.toBe(first.output.fetched_at);
  });

  it('merges duplicate AppIDs keeping newer valid lastPlayedAt while preserving name/playtime merge and canonical AppID scope order', async () => {
    const deduped = deduplicateAndSortOwned([
      { appid: 300, name: 'Older Entry', playtimeForever: 100, lastPlayedAt: 1_700_000_100 },
      { appid: 300, name: 'Newer Entry', playtimeForever: 250, lastPlayedAt: 1_700_000_900 },
      { appid: 100, name: null, playtimeForever: null, lastPlayedAt: 1_700_000_800 },
      { appid: 100, name: 'Filled Name', playtimeForever: 40, lastPlayedAt: 1_700_000_200 },
      { appid: 200, name: 'Null Then Valid', playtimeForever: 9999, lastPlayedAt: null },
      { appid: 200, name: 'Ignored', playtimeForever: 1, lastPlayedAt: 1_700_000_500 },
      { appid: 400, name: 'Valid Then Null', playtimeForever: 10, lastPlayedAt: 1_700_000_500 },
      { appid: 400, name: 'Ignored 2', playtimeForever: 20, lastPlayedAt: null },
      { appid: 50, name: 'Never Played High Playtime', playtimeForever: 50_000, lastPlayedAt: null },
    ]);

    expect(deduped).toEqual([
      { appid: 50, name: 'Never Played High Playtime', playtimeForever: 50_000, lastPlayedAt: null },
      { appid: 100, name: 'Filled Name', playtimeForever: 40, lastPlayedAt: 1_700_000_800 },
      { appid: 200, name: 'Null Then Valid', playtimeForever: 9999, lastPlayedAt: 1_700_000_500 },
      { appid: 300, name: 'Older Entry', playtimeForever: 100, lastPlayedAt: 1_700_000_900 },
      { appid: 400, name: 'Valid Then Null', playtimeForever: 10, lastPlayedAt: 1_700_000_500 },
    ]);

    const byLastPlayed = sortOwnedGamesByLastPlayed(deduped);
    expect(byLastPlayed.map((g) => g.appid)).toEqual([300, 100, 200, 400, 50]);
    // Must not mutate the canonical AppID-ordered array
    expect(deduped.map((g) => g.appid)).toEqual([50, 100, 200, 300, 400]);

    // Also verify ToolCallScope cached owned list stays in canonical AppID order after sorting
    const h = createHarness((url) => {
      if (url.pathname.endsWith('/GetOwnedGames/v1/')) {
        return jsonResp({
          response: {
            game_count: 3,
            games: [
              { appid: 10, name: 'Oldest', playtime_forever: 900, rtime_last_played: 1_700_000_100 },
              { appid: 30, name: 'Newest', playtime_forever: 10, rtime_last_played: 1_700_000_900 },
              { appid: 20, name: 'Unplayed', playtime_forever: 5000, rtime_last_played: 0 },
            ],
          },
        });
      }
      return jsonResp({}, 404);
    });

    const scope = h.library.createScope();
    const firstRead = await h.library.getOwnedList(scope, { includeAppInfo: false });
    expect(firstRead.ok).toBe(true);
    if (!firstRead.ok) return;
    expect(firstRead.data.games.map((g) => g.appid)).toEqual([10, 20, 30]);
    expect(sortOwnedGamesByLastPlayed(firstRead.data.games).map((g) => g.appid)).toEqual([30, 10, 20]);
    const secondRead = await h.library.getOwnedList(scope, { includeAppInfo: false });
    expect(secondRead.ok).toBe(true);
    if (!secondRead.ok) return;
    expect(secondRead.data.games.map((g) => g.appid)).toEqual([10, 20, 30]);
  });

  it('sorts owned games by playtime asc/desc with 0 valid, missing last, AppID ties, preserved duplicate merge, and immutable canonical scope order', async () => {
    const deduped = deduplicateAndSortOwned([
      { appid: 600, name: 'Zero High', playtimeForever: 0, lastPlayedAt: null },
      { appid: 150, name: 'Zero Low', playtimeForever: 0, lastPlayedAt: 1_700_000_900 },
      { appid: 400, name: 'Dup Zero Kept', playtimeForever: 0, lastPlayedAt: null },
      { appid: 400, name: 'Dup Ignored 999', playtimeForever: 999, lastPlayedAt: null },
      { appid: 300, name: 'Dup Null Filled', playtimeForever: null, lastPlayedAt: null },
      { appid: 300, name: 'Dup Fill 120', playtimeForever: 120, lastPlayedAt: null },
      { appid: 200, name: 'Tie 120 Low', playtimeForever: 120, lastPlayedAt: null },
      { appid: 500, name: 'Tie 120 High', playtimeForever: 120, lastPlayedAt: null },
      { appid: 700, name: 'Missing High', playtimeForever: null, lastPlayedAt: null },
      { appid: 350, name: 'Missing Low', playtimeForever: null, lastPlayedAt: null },
      { appid: 350, name: 'Missing Still Null', playtimeForever: null, lastPlayedAt: null },
      { appid: 900, name: 'Longest', playtimeForever: 5_000, lastPlayedAt: null },
    ]);

    expect(deduped.map((g) => [g.appid, g.playtimeForever])).toEqual([
      [150, 0],
      [200, 120],
      [300, 120],
      [350, null],
      [400, 0],
      [500, 120],
      [600, 0],
      [700, null],
      [900, 5_000],
    ]);

    expect(sortOwnedGamesByPlaytime(deduped, 'asc').map((g) => g.appid)).toEqual([
      150, 400, 600, 200, 300, 500, 900, 350, 700,
    ]);
    expect(sortOwnedGamesByPlaytime(deduped, 'desc').map((g) => g.appid)).toEqual([
      900, 200, 300, 500, 150, 400, 600, 350, 700,
    ]);
    // Must not mutate canonical AppID-ordered array
    expect(deduped.map((g) => g.appid)).toEqual([150, 200, 300, 350, 400, 500, 600, 700, 900]);

    // ToolCallScope cached owned list remains in canonical AppID order after sorting in both directions
    const h = createHarness((url) => {
      if (url.pathname.endsWith('/GetOwnedGames/v1/')) {
        return jsonResp({
          response: {
            game_count: 3,
            games: [
              { appid: 30, name: 'Zero', playtime_forever: 0 },
              { appid: 10, name: 'Missing' },
              { appid: 20, name: 'Played', playtime_forever: 50 },
            ],
          },
        });
      }
      return jsonResp({}, 404);
    });

    const scope = h.library.createScope();
    const firstRead = await h.library.getOwnedList(scope, { includeAppInfo: false });
    expect(firstRead.ok).toBe(true);
    if (!firstRead.ok) return;
    expect(firstRead.data.games.map((g) => g.appid)).toEqual([10, 20, 30]);
    expect(sortOwnedGamesByPlaytime(firstRead.data.games, 'asc').map((g) => g.appid)).toEqual([
      30, 20, 10,
    ]);
    expect(sortOwnedGamesByPlaytime(firstRead.data.games, 'desc').map((g) => g.appid)).toEqual([
      20, 30, 10,
    ]);
    const secondRead = await h.library.getOwnedList(scope, { includeAppInfo: false });
    expect(secondRead.ok).toBe(true);
    if (!secondRead.ok) return;
    expect(secondRead.data.games.map((g) => g.appid)).toEqual([10, 20, 30]);
  });
});

describe('GameResolverService multilingual resolution, ambiguity, and fallback', () => {
  function createResolverHarness(
    extra?: {
      owned?: unknown;
      wishlist?: unknown;
      storeSearchError?: boolean;
      getItemsError?: boolean;
    },
    budgets?: ResolverBudgetOptions,
  ) {
    return createHarness(
      (url) => {
        if (url.pathname.endsWith('/GetOwnedGames/v1/')) {
          return jsonResp(extra?.owned ?? OWNED_GAMES_FIXTURES.sample);
        }
        if (url.pathname.endsWith('/GetWishlist/v1/')) {
          return jsonResp(extra?.wishlist ?? WISHLIST_FIXTURES.verifiable_sample);
        }
        if (url.pathname.endsWith('/api/storesearch/')) {
          if (extra?.storeSearchError) {
            return new Response('Upstream error', { status: 503 });
          }
          const term = url.searchParams.get('term') ?? '';
          const lang = url.searchParams.get('l') ?? 'english';
          if (term === 'Cyberpunk 2077') return jsonResp(STORE_SEARCH_FIXTURES.cyberpunk_en);
          if (term === '赛博朋克2077' || term === '赛博朋克 2077')
            return jsonResp(STORE_SEARCH_FIXTURES.cyberpunk_zh_cn);
          if (term === 'サイバーパンク2077') return jsonResp(STORE_SEARCH_FIXTURES.cyberpunk_ja);
          if (term === 'Hades') return jsonResp(STORE_SEARCH_FIXTURES.hades_en);
          if (term === '하데스') return jsonResp(STORE_SEARCH_FIXTURES.hades_ko_weak_hit);
          if (term === 'Portal') return jsonResp(STORE_SEARCH_FIXTURES.portal_en);
          if (term === 'Portal 2') return jsonResp(STORE_SEARCH_FIXTURES.portal_en);
          if (term === 'Resident Evil 4' || term === 'Resident Evil 4 (2005)' || term === 'Resident Evil 4 Chainsaw Demo')
            return jsonResp(STORE_SEARCH_FIXTURES.re4_en_remake_conflict);
          if (term === 'The Witcher 3: Wild Hunt' || term === 'The Witcher 3: Wild Hunt — Remastered')
            return jsonResp(STORE_SEARCH_FIXTURES.witcher3_en_remastered);
          if (term === 'Wiedźmin 3: Dziki Gon' || term === 'Wiedźmin 3: Dziki Gon – Remaster')
            return jsonResp(STORE_SEARCH_FIXTURES.witcher3_pl_remaster);
          if (term === 'ELDEN RING') return jsonResp(STORE_SEARCH_FIXTURES.elden_ring_en);
          if (term === '艾尔登法环') return jsonResp(STORE_SEARCH_FIXTURES.elden_ring_zh_cn);
          if (term === '艾爾登法環') return jsonResp(STORE_SEARCH_FIXTURES.elden_ring_zh_tw);
          if (term === '博德之门3' && lang === 'schinese') return jsonResp(STORE_SEARCH_FIXTURES.bg3_zh_cn);
          if (term === '柏德之門3' && lang === 'tchinese') return jsonResp(STORE_SEARCH_FIXTURES.bg3_zh_tw);
          if (term === 'Duplicate Quest') return jsonResp(STORE_SEARCH_FIXTURES.same_name_duplicate_apps);
          if (term === 'Cyberpunk 2077: Phantom Liberty') return jsonResp(STORE_SEARCH_FIXTURES.cyberpunk_en);
          return jsonResp(STORE_SEARCH_FIXTURES.empty);
        }
        if (url.pathname.endsWith('/GetItems/v1/')) {
          if (extra?.getItemsError) {
            return new Response('Upstream error', { status: 500 });
          }
          const payload = JSON.parse(url.searchParams.get('input_json') ?? '{}') as {
            ids: Array<{ appid: number }>;
            context: { language: string };
          };
          return jsonResp(
            makeGetItemsResponse(
              payload.ids.map((i) => i.appid),
              payload.context.language,
            ),
          );
        }
        return jsonResp({}, 404);
      },
      undefined,
      budgets,
    );
  }

  it('resolves multilingual titles to the same AppID while keeping cc independent of language', async () => {
    const h = createResolverHarness();

    const en = await handleResolveGame({ library: h.library, resolver: h.resolver }, { query: 'Cyberpunk 2077' });
    const zh = await handleResolveGame(
      { library: h.library, resolver: h.resolver },
      { query: '赛博朋克2077', language: 'zh-CN', alternative_names: ['Cyberpunk 2077'] },
    );
    const ja = await handleResolveGame(
      { library: h.library, resolver: h.resolver },
      { query: 'サイバーパンク2077', language: 'ja' },
    );

    expect(en.resolution).toBe('resolved');
    expect(zh.resolution).toBe('resolved');
    expect(ja.resolution).toBe('resolved');
    expect(en.appid).toBe(1091500);
    expect(zh.appid).toBe(1091500);
    expect(ja.appid).toBe(1091500);
    expect(zh.name).toBe('赛博朋克 2077');
    expect(ja.name).toBe('サイバーパンク2077');

    // Verify cc stayed "US" for every StoreSearch call regardless of language
    const searchCalls = h.calls.filter((c) => c.pathname.endsWith('/api/storesearch/'));
    expect(searchCalls.length).toBeGreaterThan(0);
    for (const c of searchCalls) {
      expect(c.url.searchParams.get('cc')).toBe('US');
    }

    // Unsupported language falls back to default language and resolves via alternative_names with clear attribution
    const unsupported = await handleResolveGame(
      { library: h.library, resolver: h.resolver },
      { query: 'एल्डन रिंग', language: 'hi', alternative_names: ['ELDEN RING'] },
    );
    expect(unsupported.resolution).toBe('resolved');
    expect(unsupported.appid).toBe(1245620);
    expect(unsupported.identity_source).toBe('alternative_name_search');
    expect(unsupported.warnings?.some((w) => w.includes('hi'))).toBe(true);
    expect(unsupported.warnings?.some((w) => w.includes('alternative_names'))).toBe(true);
  });

  it('never relies on search rank or ownership; detects same-name, remake/edition, remaster, and original/alt conflicts', async () => {
    const h = createResolverHarness();

    // Real Steam returns "Hades II" before "Hades" -> still resolves strictly to Hades (1145360)
    const hades = await handleResolveGame({ library: h.library, resolver: h.resolver }, { query: 'Hades' });
    expect(hades.resolution).toBe('resolved');
    expect(hades.appid).toBe(1145360);

    // Real Steam returns "Portal 2" before "Portal" -> resolves strictly to Portal (400)
    const portal = await handleResolveGame({ library: h.library, resolver: h.resolver }, { query: 'Portal' });
    expect(portal.resolution).toBe('resolved');
    expect(portal.appid).toBe(400);

    // Resident Evil 4 (2023) vs Resident Evil 4 (2005) -> AMBIGUOUS!
    const re4 = await handleResolveGame(
      { library: h.library, resolver: h.resolver },
      { query: 'Resident Evil 4' },
    );
    expect(re4.resolution).toBe('ambiguous');
    expect(re4.appid).toBeNull();
    expect(re4.candidates.map((c) => c.appid)).toEqual(expect.arrayContaining([2050650, 254700]));

    // Explicitly specifying Resident Evil 4 (2005) resolves cleanly!
    const re4Classic = await handleResolveGame(
      { library: h.library, resolver: h.resolver },
      { query: 'Resident Evil 4 (2005)' },
    );
    expect(re4Classic.resolution).toBe('resolved');
    expect(re4Classic.appid).toBe(254700);

    // DLC and Demo exact queries resolve with accurate app_type
    const dlc = await handleResolveGame(
      { library: h.library, resolver: h.resolver },
      { query: 'Cyberpunk 2077: Phantom Liberty' },
    );
    expect(dlc.resolution).toBe('resolved');
    expect(dlc.appid).toBe(2138330);
    expect(dlc.app_type).toBe('dlc');

    const demo = await handleResolveGame(
      { library: h.library, resolver: h.resolver },
      { query: 'Resident Evil 4 Chainsaw Demo' },
    );
    expect(demo.resolution).toBe('resolved');
    expect(demo.appid).toBe(2231770);
    expect(demo.app_type).toBe('demo');

    // Same-name duplicate apps -> ambiguous
    const dup = await handleResolveGame(
      { library: h.library, resolver: h.resolver },
      { query: 'Duplicate Quest' },
    );
    expect(dup.resolution).toBe('ambiguous');
    expect(dup.appid).toBeNull();

    // Missing remaster suffix -> ambiguous even though 292030 is owned!
    const witcherNoSuffix = await handleResolveGame(
      { library: h.library, resolver: h.resolver },
      { query: 'The Witcher 3: Wild Hunt' },
    );
    expect(witcherNoSuffix.resolution).toBe('ambiguous');
    expect(witcherNoSuffix.appid).toBeNull();
    expect(witcherNoSuffix.candidates[0]!.appid).toBe(292030);

    // Original vs alternative_names conflict -> ambiguous
    const conflict = await handleResolveGame(
      { library: h.library, resolver: h.resolver },
      { query: 'Portal', alternative_names: ['Portal 2'] },
    );
    expect(conflict.resolution).toBe('ambiguous');
    expect(conflict.appid).toBeNull();
    expect(conflict.warnings?.some((w) => w.toLowerCase().includes('conflict'))).toBe(true);

    // Weak Korean hit conflicting with English alternative_names -> ambiguous (returns both)
    const koConflict = await handleResolveGame(
      { library: h.library, resolver: h.resolver },
      { query: '하데스', language: 'ko', alternative_names: ['Hades'] },
    );
    expect(koConflict.resolution).toBe('ambiguous');
    expect(koConflict.candidates.map((c) => c.appid)).toEqual(expect.arrayContaining([1145360, 3135730]));
  });

  it('preserves provided_appid even when GetItems fails, and rejects invalid URLs without HTTP calls', async () => {
    const h = createResolverHarness({ getItemsError: true });

    const direct = await handleResolveGame(
      { library: h.library, resolver: h.resolver },
      { query: 'https://store.steampowered.com/app/211420/DARK_SOULS/' },
    );
    expect(direct.resolution).toBe('resolved');
    expect(direct.appid).toBe(211420);
    expect(direct.identity_source).toBe('provided_appid');
    expect(direct.metadata_status).toBe('unavailable');
    expect(h.calls.filter((c) => c.pathname.endsWith('/api/storesearch/'))).toHaveLength(0);

    const badUrl = await handleResolveGame(
      { library: h.library, resolver: h.resolver },
      { query: 'https://store.steampowered.com/bundle/232/' },
    );
    expect(badUrl.resolution).toBe('error');
    expect(badUrl.appid).toBeNull();
    expect(badUrl.error_code).toBe('invalid_query');
  });

  it('falls back to personal library for delisted games, enforces fallback budget, and distinguishes StoreSearch error from clean not_found', async () => {
    // 1. Delisted game missing from StoreSearch resolves via GetOwnedGames native name
    const hFallback = createResolverHarness();
    const delisted = await handleResolveGame(
      { library: hFallback.library, resolver: hFallback.resolver },
      { query: 'DARK SOULS: Prepare To Die Edition' },
    );
    expect(delisted.resolution).toBe('resolved');
    expect(delisted.appid).toBe(211420);
    expect(delisted.identity_source).toBe('personal_library_fallback');

    // 1b. Unindexed wishlisted game missing from StoreSearch and Owned resolves via GetWishlist + GetItems
    const hWishlistFallback = createResolverHarness({
      owned: OWNED_GAMES_FIXTURES.explicit_empty_with_array,
      wishlist: WISHLIST_FIXTURES.verifiable_sample,
    });
    const wishlistedOnly = await handleResolveGame(
      { library: hWishlistFallback.library, resolver: hWishlistFallback.resolver },
      { query: 'Stardew Valley' },
    );
    expect(wishlistedOnly.resolution).toBe('resolved');
    expect(wishlistedOnly.appid).toBe(413150);
    expect(wishlistedOnly.identity_source).toBe('personal_wishlist_fallback');

    // 2. Clean not_found when StoreSearch and fallback both complete with 0 matches
    const hNotFound = createResolverHarness();
    const missing = await handleResolveGame(
      { library: hNotFound.library, resolver: hNotFound.resolver },
      { query: 'Definitely Nonexistent Game Title 999999' },
    );
    expect(missing.resolution).toBe('not_found');
    expect(missing.search_complete).toBe(true);
    expect(missing.appid).toBeNull();

    // 3. Fallback budget exceeded on large non-English fallback (with usable inspected items) -> search_complete=false + warning
    const hBudget = createHarness(
      (url) => {
        if (url.pathname.endsWith('/api/storesearch/')) return jsonResp(STORE_SEARCH_FIXTURES.empty);
        if (url.pathname.endsWith('/GetOwnedGames/v1/')) return jsonResp(makeLargeOwnedGamesFixture(200));
        if (url.pathname.endsWith('/GetWishlist/v1/')) return jsonResp(WISHLIST_FIXTURES.explicit_empty);
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
                name: `別のタイトル ${appid}`,
              })),
            },
          });
        }
        return jsonResp({}, 404);
      },
      undefined,
      { maxFallbackMetadataBatches: 1 },
    );
    const incomplete = await handleResolveGame(
      { library: hBudget.library, resolver: hBudget.resolver },
      { query: '存在しないゲームタイトル', language: 'ja' },
    );
    expect(incomplete.resolution).toBe('not_found');
    expect(incomplete.search_complete).toBe(false);
    expect(incomplete.error_code).toBe('request_budget_exceeded');
    expect(incomplete.warnings?.length).toBeGreaterThan(0);

    // 4. StoreSearch 503 failure -> resolution='error' (distinguishable from not_found!)
    const hError = createResolverHarness({ storeSearchError: true });
    const errored = await handleResolveGame(
      { library: hError.library, resolver: hError.resolver },
      { query: 'Cyberpunk 2077' },
    );
    expect(errored.resolution).toBe('error');
    expect(errored.search_complete).toBe(false);
    expect(errored.error_code).toBe('upstream_error');

    // 5. StoreSearch 0 + Owned explicit empty + Wishlist missing items ({response:{}}) -> resolution='error', NOT not_found!
    const hWishlistMissing = createResolverHarness({
      owned: OWNED_GAMES_FIXTURES.explicit_empty_with_array,
      wishlist: WISHLIST_FIXTURES.observed_unconfirmable_empty_object,
    });
    const incompleteFallbackErr = await handleResolveGame(
      { library: hWishlistMissing.library, resolver: hWishlistMissing.resolver },
      { query: 'No Match Anywhere' },
    );
    expect(incompleteFallbackErr.resolution).toBe('error');
    expect(incompleteFallbackErr.search_complete).toBe(false);
    expect(incompleteFallbackErr.error_code).toBe('invalid_response');
  });

  it('refuses to confirm single identity when search/verification is truncated or incomplete, distinguishes GetItems failure with vs without unknown competitors, and preserves Signal+ vs Signal', async () => {
    // 1. Candidate budget truncation (16 StoreSearch candidates, #16 is hidden homonym via GetItems)
    const hTruncated = createHarness((url) => {
      if (url.pathname.endsWith('/api/storesearch/')) {
        return jsonResp({
          total: 16,
          items: [
            { id: 1, type: 'app', name: 'Signal' },
            ...Array.from({ length: 15 }, (_, i) => ({
              id: i + 2,
              type: 'app',
              name: `Racer ${i + 2}`,
            })),
          ],
        });
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
              name: appid === 1 || appid === 16 ? 'Signal' : `Racer ${appid}`,
            })),
          },
        });
      }
      return jsonResp({}, 404);
    });
    const truncated = await handleResolveGame(
      { library: hTruncated.library, resolver: hTruncated.resolver },
      { query: 'Signal' },
    );
    expect(truncated.resolution).toBe('ambiguous');
    expect(truncated.appid).toBeNull();
    expect(truncated.search_complete).toBe(false);
    expect(truncated.error_code).toBe('request_budget_exceeded');
    expect(truncated.candidates[0]?.appid).toBe(1);
    expect(truncated.warnings?.length).toBeGreaterThan(0);

    // 2. Partial StoreSearch failure (alternative_names returns 503 while original matched) -> cannot confirm uniqueness
    const hAltFail = createHarness((url) => {
      if (url.pathname.endsWith('/api/storesearch/')) {
        if (url.searchParams.get('term') === 'Signal') {
          return jsonResp({ total: 1, items: [{ id: 1, type: 'app', name: 'Signal' }] });
        }
        return new Response('Service Unavailable', { status: 503 });
      }
      if (url.pathname.endsWith('/GetItems/v1/')) {
        return jsonResp({
          response: {
            store_items: [
              { item_type: 0, id: 1, appid: 1, success: 1, visible: true, type: 0, name: 'Signal' },
            ],
          },
        });
      }
      return jsonResp({}, 404);
    });
    const altFail = await handleResolveGame(
      { library: hAltFail.library, resolver: hAltFail.resolver },
      { query: 'Signal', alternative_names: ['Other title'] },
    );
    expect(altFail.resolution).toBe('ambiguous');
    expect(altFail.appid).toBeNull();
    expect(altFail.search_complete).toBe(false);
    expect(altFail.candidates[0]?.appid).toBe(1);

    // 3. Fallback homonym beyond 4-batch budget -> cannot confirm single identity
    const hFallbackTrunc = createHarness((url) => {
      if (url.pathname.endsWith('/api/storesearch/')) {
        return jsonResp({ total: 0, items: [] });
      }
      if (url.pathname.endsWith('/GetOwnedGames/v1/')) {
        return jsonResp({ response: { game_count: 1, games: [{ appid: 100, name: 'Signal' }] } });
      }
      if (url.pathname.endsWith('/GetWishlist/v1/')) {
        return jsonResp({
          response: {
            items: Array.from({ length: 201 }, (_, i) => ({ appid: 1000 + i, priority: i })),
          },
        });
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
              name: appid === 100 || appid === 1200 ? 'Signal' : `Fixture ${appid}`,
            })),
          },
        });
      }
      return jsonResp({}, 404);
    });
    const fbTrunc = await handleResolveGame(
      { library: hFallbackTrunc.library, resolver: hFallbackTrunc.resolver },
      { query: 'Signal' },
    );
    expect(fbTrunc.resolution).toBe('ambiguous');
    expect(fbTrunc.appid).toBeNull();
    expect(fbTrunc.search_complete).toBe(false);
    expect(fbTrunc.error_code).toBe('request_budget_exceeded');
    expect(fbTrunc.candidates.some((c) => c.appid === 100)).toBe(true);

    // 4a. GetItems fails with ONLY 1 exact StoreSearch candidate (strong evidence, zero unknown competitors) -> still resolves
    const hStrongNoComp = createHarness((url) => {
      if (url.pathname.endsWith('/api/storesearch/')) {
        return jsonResp({ total: 1, items: [{ id: 10, type: 'app', name: 'Signal' }] });
      }
      if (url.pathname.endsWith('/GetItems/v1/')) {
        return new Response('Internal Server Error', { status: 500 });
      }
      return jsonResp({}, 404);
    });
    const strongOnly = await handleResolveGame(
      { library: hStrongNoComp.library, resolver: hStrongNoComp.resolver },
      { query: 'Signal' },
    );
    expect(strongOnly.resolution).toBe('resolved');
    expect(strongOnly.appid).toBe(10);
    expect(strongOnly.metadata_status).toBe('unavailable');

    // 4b. GetItems fails with competing candidates present -> unknown competing item blocks confirmation
    const hUnknownComp = createHarness((url) => {
      if (url.pathname.endsWith('/api/storesearch/')) {
        return jsonResp({
          total: 2,
          items: [
            { id: 10, type: 'app', name: 'Signal' },
            { id: 11, type: 'app', name: 'Racer 11' },
          ],
        });
      }
      if (url.pathname.endsWith('/GetItems/v1/')) {
        return new Response('Internal Server Error', { status: 500 });
      }
      return jsonResp({}, 404);
    });
    const unknownComp = await handleResolveGame(
      { library: hUnknownComp.library, resolver: hUnknownComp.resolver },
      { query: 'Signal' },
    );
    expect(unknownComp.resolution).toBe('ambiguous');
    expect(unknownComp.appid).toBeNull();
    expect(unknownComp.search_complete).toBe(false);
    expect(unknownComp.candidates.map((c) => c.appid)).toEqual([10, 11]);

    // 5. Signal+ must NOT collapse to exact match on Signal
    const hPlus = createHarness((url) => {
      if (url.pathname.endsWith('/api/storesearch/')) {
        return jsonResp({ total: 1, items: [{ id: 10, type: 'app', name: 'Signal' }] });
      }
      if (url.pathname.endsWith('/GetItems/v1/')) {
        return jsonResp({
          response: {
            store_items: [
              { item_type: 0, id: 10, appid: 10, success: 1, visible: true, type: 0, name: 'Signal' },
            ],
          },
        });
      }
      return jsonResp({}, 404);
    });
    const plusRes = await handleResolveGame(
      { library: hPlus.library, resolver: hPlus.resolver },
      { query: 'Signal+' },
    );
    expect(plusRes.resolution).toBe('ambiguous');
    expect(plusRes.appid).toBeNull();
    expect(plusRes.candidates[0]?.appid).toBe(10);
    expect(plusRes.candidates[0]?.name).toBe('Signal');

    // 6. Personal fallback GetItems failure: strong owned match with empty wishlist resolves,
    //    whereas strong owned match with unnamed wishlist competitor stays ambiguous
    const hFbStrongOnly = createHarness((url) => {
      if (url.pathname.endsWith('/api/storesearch/')) return jsonResp({ total: 0, items: [] });
      if (url.pathname.endsWith('/GetOwnedGames/v1/')) {
        return jsonResp({ response: { game_count: 1, games: [{ appid: 100, name: 'Signal' }] } });
      }
      if (url.pathname.endsWith('/GetWishlist/v1/')) return jsonResp({ response: { items: [] } });
      if (url.pathname.endsWith('/GetItems/v1/')) return new Response('Server Error', { status: 500 });
      return jsonResp({}, 404);
    });
    const fbStrongOnly = await handleResolveGame(
      { library: hFbStrongOnly.library, resolver: hFbStrongOnly.resolver },
      { query: 'Signal' },
    );
    expect(fbStrongOnly.resolution).toBe('resolved');
    expect(fbStrongOnly.appid).toBe(100);
    expect(fbStrongOnly.identity_source).toBe('personal_library_fallback');
    expect(fbStrongOnly.metadata_status).toBe('unavailable');

    const hFbUnknownWishlist = createHarness((url) => {
      if (url.pathname.endsWith('/api/storesearch/')) return jsonResp({ total: 0, items: [] });
      if (url.pathname.endsWith('/GetOwnedGames/v1/')) {
        return jsonResp({ response: { game_count: 1, games: [{ appid: 100, name: 'Signal' }] } });
      }
      if (url.pathname.endsWith('/GetWishlist/v1/')) {
        return jsonResp({ response: { items: [{ appid: 200, priority: 1 }] } });
      }
      if (url.pathname.endsWith('/GetItems/v1/')) return new Response('Server Error', { status: 500 });
      return jsonResp({}, 404);
    });
    const fbUnknownWishlist = await handleResolveGame(
      { library: hFbUnknownWishlist.library, resolver: hFbUnknownWishlist.resolver },
      { query: 'Signal' },
    );
    expect(fbUnknownWishlist.resolution).toBe('ambiguous');
    expect(fbUnknownWishlist.appid).toBeNull();
    expect(fbUnknownWishlist.search_complete).toBe(false);
    expect(fbUnknownWishlist.candidates.some((c) => c.appid === 100)).toBe(true);
  });

  it('propagates in-flight GetItems failure to concurrent waiters without poisoning metadataCache and isolates languages', async () => {
    let callCount = 0;
    const h = createHarness(async (url) => {
      if (url.pathname.endsWith('/GetItems/v1/')) {
        callCount++;
        const req = JSON.parse(url.searchParams.get('input_json') ?? '{}') as {
          ids: Array<{ appid: number }>;
          context: { language: string };
        };
        if (callCount <= 3) {
          // First request fails across initial + 2 retries
          await new Promise((r) => setTimeout(r, 15));
          return new Response('Upstream error', { status: 500 });
        }
        return jsonResp({
          response: {
            store_items: req.ids.map(({ appid }) => ({
              item_type: 0,
              id: appid,
              appid,
              success: 1,
              visible: true,
              type: 0,
              name: `${req.context.language}-${appid}`,
            })),
          },
        });
      }
      return jsonResp({}, 404);
    });

    const scope = h.library.createScope();
    // Two concurrent fetches for the same (english, 10) share 1 failing in-flight call
    const [r1, r2] = await Promise.all([
      h.metadata.fetchMetadata(scope, [10], 'english'),
      h.metadata.fetchMetadata(scope, [10], 'english'),
    ]);
    expect(callCount).toBe(3); // 1 attempt + 2 retries, NOT 6!
    expect(r1.failedAppIds.has(10)).toBe(true);
    expect(r2.failedAppIds.has(10)).toBe(true);
    expect(r1.errorCode).toBe('upstream_error');
    expect(r2.errorCode).toBe('upstream_error');
    expect(scope.metadataCache.has('english:10')).toBe(false);

    // Subsequent fetch in same scope is NOT poisoned and succeeds; japanese stays isolated
    const r3 = await h.metadata.fetchMetadata(scope, [10], 'english');
    const r4 = await h.metadata.fetchMetadata(scope, [10], 'japanese');
    expect(r3.itemsByAppId.get(10)?.name).toBe('english-10');
    expect(r4.itemsByAppId.get(10)?.name).toBe('japanese-10');
  });

  it('detects upstream StoreSearch truncation via raw items length, blocks on omitted/unsuccessful competing GetItems, checks non-English owned homonyms, and keeps alt-only provenance consistent', async () => {
    // 1. Upstream StoreSearch total=16 with only 2 raw items -> blocks confirmation (search_complete=false)
    const hUpstreamTrunc = createHarness((url) => {
      if (url.pathname.endsWith('/api/storesearch/')) {
        return jsonResp({
          total: 16,
          items: [
            { id: 10, type: 'app', name: 'Signal' },
            { id: 11, type: 'app', name: 'Different Title' },
          ],
        });
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
    });
    const upTrunc = await handleResolveGame(
      { library: hUpstreamTrunc.library, resolver: hUpstreamTrunc.resolver },
      { query: 'Signal' },
    );
    expect(upTrunc.resolution).toBe('ambiguous');
    expect(upTrunc.appid).toBeNull();
    expect(upTrunc.search_complete).toBe(false);
    expect(upTrunc.candidates.map((c) => c.appid)).toEqual([10, 11]);

    // 2. Filtering non-app packages / invalid IDs / duplicates does NOT falsely trigger truncation when raw items.length === total
    const hFilteredNoTrunc = createHarness((url) => {
      if (url.pathname.endsWith('/api/storesearch/')) {
        return jsonResp({
          total: 4,
          items: [
            { id: 9991, type: 'sub', name: 'Signal Package' },
            { id: 10, type: 'app', name: 'Signal' },
            { id: 10, type: 'app', name: 'Signal' },
            { id: 0, type: 'app', name: 'Bad ID' },
          ],
        });
      }
      if (url.pathname.endsWith('/GetItems/v1/')) {
        return jsonResp({
          response: {
            store_items: [
              { item_type: 0, id: 10, appid: 10, success: 1, visible: true, type: 0, name: 'Signal' },
            ],
          },
        });
      }
      return jsonResp({}, 404);
    });
    const filteredOk = await handleResolveGame(
      { library: hFilteredNoTrunc.library, resolver: hFilteredNoTrunc.resolver },
      { query: 'Signal' },
    );
    expect(filteredOk.resolution).toBe('resolved');
    expect(filteredOk.appid).toBe(10);
    expect(filteredOk.search_complete).toBe(true);

    // 3. GetItems omits competing AppID OR returns explicit success !== 1 / blank name -> blocks confirmation
    for (const badCompetitor of [
      null, // omitted completely
      { item_type: 0, id: 11, appid: 0, success: 15, visible: false, name: '' }, // explicit success !== 1
      { item_type: 0, id: 11, appid: 11, success: 1, visible: true, type: 0, name: '   ' }, // missing usable name
    ]) {
      const hBadComp = createHarness((url) => {
        if (url.pathname.endsWith('/api/storesearch/')) {
          return jsonResp({
            total: 2,
            items: [
              { id: 10, type: 'app', name: 'Signal' },
              { id: 11, type: 'app', name: 'Different Title' },
            ],
          });
        }
        if (url.pathname.endsWith('/GetItems/v1/')) {
          const items = [
            { item_type: 0, id: 10, appid: 10, success: 1, visible: true, type: 0, name: 'Signal' },
            ...(badCompetitor ? [badCompetitor] : []),
          ];
          return jsonResp({ response: { store_items: items } });
        }
        return jsonResp({}, 404);
      });
      const res = await handleResolveGame(
        { library: hBadComp.library, resolver: hBadComp.resolver },
        { query: 'Signal' },
      );
      expect(res.resolution).toBe('ambiguous');
      expect(res.appid).toBeNull();
      expect(res.search_complete).toBe(false);
      expect(res.candidates.map((c) => c.appid)).toEqual([10, 11]);
    }

    // 4. Personal fallback in non-English language still checks other owned AppIDs even when one native name matched
    const hJaHomonym = createHarness((url) => {
      if (url.pathname.endsWith('/api/storesearch/')) return jsonResp({ total: 0, items: [] });
      if (url.pathname.endsWith('/GetOwnedGames/v1/')) {
        return jsonResp({
          response: {
            game_count: 2,
            games: [
              { appid: 10, name: 'シグナル' },
              { appid: 11, name: 'Different Title' },
            ],
          },
        });
      }
      if (url.pathname.endsWith('/GetWishlist/v1/')) return jsonResp({ response: { items: [] } });
      if (url.pathname.endsWith('/GetItems/v1/')) {
        const req = JSON.parse(url.searchParams.get('input_json') ?? '{}') as { ids: Array<{ appid: number }> };
        return jsonResp({
          response: {
            store_items: req.ids.map(({ appid }) => ({
              item_type: 0,
              id: appid,
              appid,
              success: 1,
              visible: true,
              type: 0,
              name: 'シグナル',
            })),
          },
        });
      }
      return jsonResp({}, 404);
    });
    const jaHomonym = await handleResolveGame(
      { library: hJaHomonym.library, resolver: hJaHomonym.resolver },
      { query: 'シグナル', language: 'ja' },
    );
    expect(jaHomonym.resolution).toBe('ambiguous');
    expect(jaHomonym.appid).toBeNull();
    expect(jaHomonym.search_complete).toBe(true);
    expect(jaHomonym.candidates.map((c) => c.appid).sort()).toEqual([10, 11]);

    // 4b. When localized owned inspection exceeds the 4-batch budget, native match stays unconfirmed
    const hJaBudget = createHarness((url) => {
      if (url.pathname.endsWith('/api/storesearch/')) return jsonResp({ total: 0, items: [] });
      if (url.pathname.endsWith('/GetOwnedGames/v1/')) {
        return jsonResp({
          response: {
            game_count: 220,
            games: [
              { appid: 10, name: 'シグナル' },
              ...Array.from({ length: 219 }, (_, i) => ({ appid: 1000 + i, name: `Other ${i}` })),
            ],
          },
        });
      }
      if (url.pathname.endsWith('/GetWishlist/v1/')) return jsonResp({ response: { items: [] } });
      if (url.pathname.endsWith('/GetItems/v1/')) {
        const req = JSON.parse(url.searchParams.get('input_json') ?? '{}') as { ids: Array<{ appid: number }> };
        return jsonResp({
          response: {
            store_items: req.ids.map(({ appid }) => ({
              item_type: 0,
              id: appid,
              appid,
              success: 1,
              visible: true,
              type: 0,
              name: appid === 10 ? 'シグナル' : `別のタイトル ${appid}`,
            })),
          },
        });
      }
      return jsonResp({}, 404);
    });
    const jaBudget = await handleResolveGame(
      { library: hJaBudget.library, resolver: hJaBudget.resolver },
      { query: 'シグナル', language: 'ja' },
    );
    expect(jaBudget.resolution).toBe('ambiguous');
    expect(jaBudget.appid).toBeNull();
    expect(jaBudget.search_complete).toBe(false);
    expect(jaBudget.error_code).toBe('request_budget_exceeded');

    // 5. Alternative-name-only exact match provenance matches top-level identity_source even when original query weakly discovered the same AppID first
    const hAltProv = createHarness((url) => {
      if (url.pathname.endsWith('/api/storesearch/')) {
        return jsonResp({ total: 1, items: [{ id: 10, type: 'app', name: 'The Witcher 3: Wild Hunt' }] });
      }
      if (url.pathname.endsWith('/GetItems/v1/')) {
        return jsonResp({
          response: {
            store_items: [
              { item_type: 0, id: 10, appid: 10, success: 1, visible: true, type: 0, name: 'The Witcher 3: Wild Hunt' },
            ],
          },
        });
      }
      return jsonResp({}, 404);
    });
    const altProv = await handleResolveGame(
      { library: hAltProv.library, resolver: hAltProv.resolver },
      { query: 'Witcher 3', alternative_names: ['The Witcher 3: Wild Hunt'] },
    );
    expect(altProv.resolution).toBe('resolved');
    expect(altProv.appid).toBe(10);
    expect(altProv.identity_source).toBe('alternative_name_search');
    expect(altProv.candidates[0]?.match_source).toBe('alternative_name_search');

    // 6. §5.3 alternative-name-only discovery where later GetItems matches the original localized title
    //    MUST still report identity_source='alternative_name_search', match_source='alternative_name_search', and a warning
    const hAltVerifiedOrig = createHarness((url) => {
      if (url.pathname.endsWith('/api/storesearch/')) {
        const term = url.searchParams.get('term');
        const items = term === 'Signal' ? [{ id: 10, type: 'app', name: 'Signal' }] : [];
        return jsonResp({ total: items.length, items });
      }
      if (url.pathname.endsWith('/GetItems/v1/')) {
        const req = JSON.parse(url.searchParams.get('input_json') ?? '{}') as {
          context: { language: string };
        };
        return jsonResp({
          response: {
            store_items: [
              {
                item_type: 0,
                id: 10,
                appid: 10,
                success: 1,
                visible: true,
                type: 0,
                name: req.context.language === 'japanese' ? 'シグナル' : 'Signal',
              },
            ],
          },
        });
      }
      return jsonResp({}, 404);
    });
    const altVerifiedOrig = await handleResolveGame(
      { library: hAltVerifiedOrig.library, resolver: hAltVerifiedOrig.resolver },
      { query: 'シグナル', language: 'ja', alternative_names: ['Signal'] },
    );
    expect(altVerifiedOrig.resolution).toBe('resolved');
    expect(altVerifiedOrig.appid).toBe(10);
    expect(altVerifiedOrig.name).toBe('シグナル');
    expect(altVerifiedOrig.identity_source).toBe('alternative_name_search');
    expect(altVerifiedOrig.candidates[0]?.match_source).toBe('alternative_name_search');
    expect(altVerifiedOrig.warnings?.some((w) => w.includes('alternative_names'))).toBe(true);

    // 7. Original StoreSearch weak hit on AppID 99 conflicting with alt-only discovery of AppID 10
    //    remains ambiguous even if GetItems returns the original localized title for AppID 10
    const hAltConflictOrigMeta = createHarness((url) => {
      if (url.pathname.endsWith('/api/storesearch/')) {
        const term = url.searchParams.get('term');
        if (term === 'シグナル' && url.searchParams.get('l') === 'japanese') {
          return jsonResp({ total: 1, items: [{ id: 99, type: 'app', name: '別のシグナル' }] });
        }
        if (term === 'Signal') {
          return jsonResp({ total: 1, items: [{ id: 10, type: 'app', name: 'Signal' }] });
        }
        return jsonResp({ total: 0, items: [] });
      }
      if (url.pathname.endsWith('/GetItems/v1/')) {
        const req = JSON.parse(url.searchParams.get('input_json') ?? '{}') as {
          ids: Array<{ appid: number }>;
          context: { language: string };
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
              name:
                appid === 10
                  ? req.context.language === 'japanese'
                    ? 'シグナル'
                    : 'Signal'
                  : '別のシグナル',
            })),
          },
        });
      }
      return jsonResp({}, 404);
    });
    const altConflictOrigMeta = await handleResolveGame(
      { library: hAltConflictOrigMeta.library, resolver: hAltConflictOrigMeta.resolver },
      { query: 'シグナル', language: 'ja', alternative_names: ['Signal'] },
    );
    expect(altConflictOrigMeta.resolution).toBe('ambiguous');
    expect(altConflictOrigMeta.appid).toBeNull();
    expect(altConflictOrigMeta.candidates.map((c) => c.appid)).toEqual(
      expect.arrayContaining([10, 99]),
    );
  });

  it('treats omitted, explicit success!=1, and blank-title GetItems items consistently as unverifiable in personal fallback while preserving trustworthy existing evidence', async () => {
    // 1. Owned 10 has exact native title 'シグナル', owned 11 has 'Different Title', language='ja':
    //    when GetItems for 11 is omitted, explicit success=15, or success=1 with blank title,
    //    resolver must NOT confirm appid=10, must set search_complete=false, and must preserve 10 in candidates.
    const badCompetitorVariants: Array<{ label: string; item: Record<string, unknown> | null }> = [
      { label: 'omitted', item: null },
      {
        label: 'explicit_negative_success_15',
        item: { item_type: 0, id: 11, appid: 0, success: 15, visible: false, name: '' },
      },
      {
        label: 'explicit_success_1_blank_title',
        item: { item_type: 0, id: 11, appid: 11, success: 1, visible: true, type: 0, name: '   ' },
      },
    ];

    for (const variant of badCompetitorVariants) {
      const h = createHarness((url) => {
        if (url.pathname.endsWith('/api/storesearch/')) return jsonResp({ total: 0, items: [] });
        if (url.pathname.endsWith('/GetOwnedGames/v1/')) {
          return jsonResp({
            response: {
              game_count: 2,
              games: [
                { appid: 10, name: 'シグナル' },
                { appid: 11, name: 'Different Title' },
              ],
            },
          });
        }
        if (url.pathname.endsWith('/GetWishlist/v1/')) return jsonResp({ response: { items: [] } });
        if (url.pathname.endsWith('/GetItems/v1/')) {
          const items: Array<Record<string, unknown>> = [
            { item_type: 0, id: 10, appid: 10, success: 1, visible: true, type: 0, name: 'シグナル' },
          ];
          if (variant.item) {
            items.push(variant.item);
          }
          return jsonResp({ response: { store_items: items } });
        }
        return jsonResp({}, 404);
      });

      const res = await handleResolveGame(
        { library: h.library, resolver: h.resolver },
        { query: 'シグナル', language: 'ja' },
      );
      expect(res.resolution, variant.label).toBe('ambiguous');
      expect(res.appid, variant.label).toBeNull();
      expect(res.search_complete, variant.label).toBe(false);
      expect(res.candidates.some((c) => c.appid === 10), variant.label).toBe(true);
      expect(res.warnings?.some((w) => /competing|unchecked/i.test(w)), variant.label).toBe(true);
    }

    // 2. Single blank-title / explicit-failure / omitted wishlist item with zero native candidates
    //    must report unreliable fallback failure (resolution='error', search_complete=false), NEVER complete not_found.
    for (const variant of badCompetitorVariants) {
      const h = createHarness((url) => {
        if (url.pathname.endsWith('/api/storesearch/')) return jsonResp({ total: 0, items: [] });
        if (url.pathname.endsWith('/GetOwnedGames/v1/')) {
          return jsonResp({ response: { game_count: 0, games: [] } });
        }
        if (url.pathname.endsWith('/GetWishlist/v1/')) {
          return jsonResp({ response: { items: [{ appid: 11, priority: 1 }] } });
        }
        if (url.pathname.endsWith('/GetItems/v1/')) {
          return jsonResp({
            response: { store_items: variant.item ? [variant.item] : [] },
          });
        }
        return jsonResp({}, 404);
      });

      const res = await handleResolveGame(
        { library: h.library, resolver: h.resolver },
        { query: 'Signal' },
      );
      expect(res.resolution, variant.label).toBe('error');
      expect(res.appid, variant.label).toBeNull();
      expect(res.search_complete, variant.label).toBe(false);
      expect(res.error_code, variant.label).toBe('upstream_error');
      expect(res.warnings?.length ?? 0, variant.label).toBeGreaterThan(0);
    }

    // 3. Preserves trustworthy existing current-language evidence: English query where all owned items
    //    already have native names and wishlist is empty still resolves delisted owned 10 even if GetItems returns success=15.
    const hDelistedEnglish = createHarness((url) => {
      if (url.pathname.endsWith('/api/storesearch/')) return jsonResp({ total: 0, items: [] });
      if (url.pathname.endsWith('/GetOwnedGames/v1/')) {
        return jsonResp({
          response: {
            game_count: 2,
            games: [
              { appid: 10, name: 'Signal' },
              { appid: 11, name: 'Different Title' },
            ],
          },
        });
      }
      if (url.pathname.endsWith('/GetWishlist/v1/')) return jsonResp({ response: { items: [] } });
      if (url.pathname.endsWith('/GetItems/v1/')) {
        return jsonResp({
          response: {
            store_items: [{ item_type: 0, id: 10, appid: 0, success: 15, visible: false, name: '' }],
          },
        });
      }
      return jsonResp({}, 404);
    });
    const delistedEnglish = await handleResolveGame(
      { library: hDelistedEnglish.library, resolver: hDelistedEnglish.resolver },
      { query: 'Signal' },
    );
    expect(delistedEnglish.resolution).toBe('resolved');
    expect(delistedEnglish.appid).toBe(10);
    expect(delistedEnglish.identity_source).toBe('personal_library_fallback');
    expect(delistedEnglish.search_complete).toBe(true);
    expect(delistedEnglish.metadata_status).toBe('unavailable');
  });
});
