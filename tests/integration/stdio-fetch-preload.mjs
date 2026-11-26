/**
 * Test-only preload script for real stdio child-process E2E tests.
 * Intercepts globalThis.fetch inside the spawned compiled dist/index.js process,
 * strictly asserts all host/path/key/redirect/cookie security invariants, and
 * serves deterministic sanitized Steam fixtures.
 */

import { readFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const EXPECTED_API_KEY = process.env.STEAM_API_KEY;
const ALLOWED_ENDPOINTS = new Map([
  ['api.steampowered.com/IPlayerService/GetOwnedGames/v1/', { allowKey: true }],
  ['api.steampowered.com/IWishlistService/GetWishlist/v1/', { allowKey: false }],
  ['store.steampowered.com/api/storesearch/', { allowKey: false }],
  ['api.steampowered.com/IStoreBrowseService/GetItems/v1/', { allowKey: false }],
]);

const mode = process.env.E2E_MOCK_MODE ?? 'ok';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);

  if (url.protocol !== 'https:') {
    throw new Error(`Security invariant violation: non-HTTPS protocol ${url.protocol}`);
  }
  const key = `${url.hostname}${url.pathname}`;
  const spec = ALLOWED_ENDPOINTS.get(key);
  if (!spec) {
    throw new Error(`Security invariant violation: non-allowlisted endpoint ${key}`);
  }
  if (!spec.allowKey && url.searchParams.has('key')) {
    throw new Error(`Security invariant violation: API key sent to anonymous endpoint ${key}`);
  }
  if (spec.allowKey && url.searchParams.get('key') !== EXPECTED_API_KEY) {
    throw new Error('Missing expected API key on GetOwnedGames');
  }
  if (init?.redirect !== 'manual') {
    throw new Error(`Security invariant violation: expected redirect="manual", got ${String(init?.redirect)}`);
  }
  const headers = new Headers(init?.headers ?? {});
  if (headers.has('cookie')) {
    throw new Error('Security invariant violation: Cookie header must not be sent');
  }
  if (headers.get('user-agent') !== `steam-collection-mcp/${version}`) {
    throw new Error('Steam User-Agent version must match package.json');
  }

  if (url.pathname === '/IPlayerService/GetOwnedGames/v1/') {
    if (mode === 'owned_fail') {
      return new Response('Access is denied. Verify key= parameter.', { status: 403 });
    }
    if (mode === 'ambiguous_sources_fail') {
      return new Response('Unauthorized', { status: 401 });
    }
    if (mode === 'mixed_partial_search') {
      return jsonResponse({ response: { game_count: 0, games: [] } });
    }
    if (mode === 'owned_sort') {
      return jsonResponse({
        response: {
          game_count: 7,
          games: [
            { appid: 1091500, name: 'Cyberpunk 2077', playtime_forever: 1200, rtime_last_played: 1700000100 },
            { appid: 1145360, name: 'Hades', playtime_forever: 300, rtime_last_played: 1700000500 },
            { appid: 1086940, name: "Baldur's Gate 3", playtime_forever: 500, rtime_last_played: 1700000500 },
            { appid: 1091500, name: 'Cyberpunk Duplicate', playtime_forever: 9999, rtime_last_played: 1700000900 },
            { appid: 1245620, name: 'ELDEN RING', playtime_forever: 4000, rtime_last_played: 0 },
            { appid: 1145350, name: 'Hades II', playtime_forever: 2000, rtime_last_played: 'invalid' },
            { appid: 10, name: 'Signal', playtime_forever: 100 },
          ],
        },
      });
    }
    if (mode === 'owned_sort_playtime') {
      return jsonResponse({
        response: {
          game_count: 7,
          games: [
            { appid: 1091500, name: 'Cyberpunk 2077', playtime_forever: 1200 },
            { appid: 1091500, name: 'Cyberpunk Duplicate', playtime_forever: 9999 },
            { appid: 1145360, name: 'Hades', playtime_forever: 300 },
            { appid: 1086940, name: "Baldur's Gate 3", playtime_forever: 300 },
            { appid: 10, name: 'Signal', playtime_forever: 0 },
            { appid: 1245620, name: 'ELDEN RING' },
            { appid: 1145350, name: 'Hades II' },
          ],
        },
      });
    }
    return jsonResponse({
      response: {
        game_count: 2,
        games: [
          { appid: 1091500, name: 'Cyberpunk 2077', playtime_forever: 1200 },
          { appid: 1145360, name: 'Hades', playtime_forever: 300 },
        ],
      },
    });
  }

  if (url.pathname === '/IWishlistService/GetWishlist/v1/') {
    if (mode === 'wishlist_unconfirmable') {
      return jsonResponse({ response: {} });
    }
    if (mode === 'ambiguous_sources_fail') {
      return new Response('Forbidden', { status: 403 });
    }
    if (mode === 'mixed_partial_search') {
      return jsonResponse({ response: { items: [] } });
    }
    return jsonResponse({
      response: {
        items: [
          { appid: 1086940, priority: 1, date_added: 1700000000 },
          { appid: 1245620, date_added: 1700000100 },
        ],
      },
    });
  }

  if (url.pathname === '/api/storesearch/') {
    if (mode === 'search_403') {
      return new Response('Forbidden', { status: 403 });
    }
    const term = url.searchParams.get('term') ?? '';
    if (mode === 'ambiguous_sources_fail') {
      if (term === 'Signal') {
        return jsonResponse({
          total: 2,
          items: [
            { id: 10, type: 'app', name: 'Signal' },
            { id: 11, type: 'app', name: 'Signal' },
          ],
        });
      }
      return new Response('Forbidden', { status: 403 });
    }
    if (mode === 'mixed_partial_search') {
      if (term === 'Unavailable') {
        return new Response('Forbidden', { status: 403 });
      }
      return jsonResponse({ total: 0, items: [] });
    }
    if (term === 'Hades') {
      return jsonResponse({
        total: 2,
        items: [
          { id: 1145350, type: 'app', name: 'Hades II' },
          { id: 1145360, type: 'app', name: 'Hades' },
        ],
      });
    }
    if (term === '赛博朋克2077' || term === 'Cyberpunk 2077') {
      return jsonResponse({
        total: 1,
        items: [
          {
            id: 1091500,
            type: 'app',
            name: url.searchParams.get('l') === 'schinese' ? '赛博朋克 2077' : 'Cyberpunk 2077',
          },
        ],
      });
    }
    return jsonResponse({ total: 0, items: [] });
  }

  if (url.pathname === '/IStoreBrowseService/GetItems/v1/') {
    const req = JSON.parse(url.searchParams.get('input_json') ?? '{}');
    const lang = req.context?.language ?? 'english';
    const names = {
      10: 'Signal',
      11: 'Signal',
      1091500: lang === 'schinese' ? '赛博朋克 2077' : 'Cyberpunk 2077',
      1145350: 'Hades II',
      1145360: 'Hades',
      1086940: lang === 'schinese' ? '博德之门3' : "Baldur's Gate 3",
      1245620: lang === 'schinese' ? '艾尔登法环' : 'ELDEN RING',
    };
    return jsonResponse({
      response: {
        store_items: (req.ids ?? []).map(({ appid }) =>
          names[appid]
            ? {
                item_type: 0,
                id: appid,
                appid,
                success: 1,
                visible: true,
                type: 0,
                name: names[appid],
              }
            : {
                item_type: 0,
                id: appid,
                appid: 0,
                success: 15,
                visible: false,
                name: '',
              },
        ),
      },
    });
  }

  return jsonResponse({}, 404);
};
