/**
 * Sanitized test fixtures for Steam Collection MCP.
 *
 * Provenance:
 * - Anonymous StoreSearch, GetItems, and GetWishlist empty-object/400 shapes were
 *   directly observed via live anonymous HTTPS probes to store.steampowered.com and
 *   api.steampowered.com on 2026-11-25 (with zero credentials and no personal SteamIDs).
 * - GetOwnedGames and populated GetWishlist fixtures follow Valve's official
 *   IPlayerService/GetOwnedGames/v1 documentation and observed IWishlistService/GetWishlist/v1
 *   item structure using synthetic/public AppIDs and placeholder SteamID64 76561198000000001.
 */

export const TEST_STEAM_API_KEY = 'TEST_FAKE_STEAM_KEY_DO_NOT_USE_123456';
export const TEST_STEAM_ID = '76561198000000001';

/** Real observed anonymous StoreSearch payloads (trimmed to relevant fields, sanitized). */
export const STORE_SEARCH_FIXTURES = {
  cyberpunk_en: {
    total: 2,
    items: [
      { id: 1091500, type: 'app', name: 'Cyberpunk 2077' },
      { id: 2138330, type: 'app', name: 'Cyberpunk 2077: Phantom Liberty' },
    ],
  },
  cyberpunk_zh_cn: {
    total: 2,
    items: [
      { id: 1091500, type: 'app', name: '赛博朋克 2077' },
      { id: 2138330, type: 'app', name: '《赛博朋克 2077：往日之影》' },
    ],
  },
  cyberpunk_zh_tw_dlc_only: {
    total: 1,
    items: [{ id: 2138330, type: 'app', name: '《電馭叛客 2077：自由幻局》' }],
  },
  cyberpunk_ja: {
    total: 2,
    items: [
      { id: 1091500, type: 'app', name: 'サイバーパンク2077' },
      { id: 2138330, type: 'app', name: 'サイバーパンク2077：仮初めの自由' },
    ],
  },
  witcher3_en_remastered: {
    total: 5,
    items: [
      { id: 292030, type: 'app', name: 'The Witcher 3: Wild Hunt — Remastered' },
      { id: 5006530, type: 'app', name: 'The Witcher 3: Wild Hunt — Songs of the Past' },
      { id: 1229320, type: 'app', name: 'The Witcher 3: Wild Hunt — Remastered Soundtrack' },
      { id: 1233340, type: 'app', name: 'The Witcher 3: Wild Hunt - Blood and Wine Soundtrack' },
      { id: 1233280, type: 'app', name: 'The Witcher 3: Wild Hunt - Hearts of Stone Soundtrack' },
    ],
  },
  witcher3_pl_remaster: {
    total: 2,
    items: [
      { id: 292030, type: 'app', name: 'Wiedźmin 3: Dziki Gon – Remaster' },
      { id: 5006530, type: 'app', name: 'Wiedźmin 3: Dziki Gon – Pieśni przeszłości ' },
    ],
  },
  witcher3_ru_remastered: {
    total: 2,
    items: [
      { id: 292030, type: 'app', name: 'Ведьмак 3: Дикая Охота — Обновлённое издание' },
      { id: 5006530, type: 'app', name: 'Ведьмак 3: Дикая Охота — Баллады прошлого' },
    ],
  },
  witcher3_ja: {
    total: 2,
    items: [
      { id: 292030, type: 'app', name: 'ウィッチャー３　ワイルドハント　リマスター' },
      { id: 2684660, type: 'app', name: 'ウィッチャー3 REDkit' },
    ],
  },
  hades_en: {
    total: 6,
    items: [
      // Real Steam ranks Hades II before Hades — proves search rank cannot decide identity!
      { id: 1145350, type: 'app', name: 'Hades II' },
      { id: 1145360, type: 'app', name: 'Hades' },
      { id: 2950840, type: 'app', name: 'Hades II Original Soundtrack' },
      { id: 755800, type: 'app', name: "Hades' Star" },
      { id: 1206340, type: 'app', name: 'Hades Original Soundtrack' },
      { id: 3653720, type: 'app', name: 'Hades Harem' },
    ],
  },
  hades_ko_weak_hit: {
    total: 1,
    items: [{ id: 3135730, type: 'app', name: '세보그: 하데스' }],
  },
  portal_en: {
    total: 3,
    items: [
      // Real Steam ranks Portal 2 before Portal
      { id: 620, type: 'app', name: 'Portal 2' },
      { id: 400, type: 'app', name: 'Portal' },
      { id: 374040, type: 'app', name: 'Portal Knights' },
    ],
  },
  re4_en_remake_conflict: {
    total: 6,
    items: [
      { id: 2050650, type: 'app', name: 'Resident Evil 4' },
      { id: 2109300, type: 'app', name: 'Resident Evil 4 - Separate Ways' },
      { id: 254700, type: 'app', name: 'Resident Evil 4 (2005)' },
      { id: 2109315, type: 'app', name: 'Resident Evil 4 - The Mercenaries' },
      { id: 2593600, type: 'app', name: 'Resident Evil 4 Original Soundtrack' },
      { id: 2231770, type: 'app', name: 'Resident Evil 4 Chainsaw Demo' },
    ],
  },
  elden_ring_en: {
    total: 3,
    items: [
      { id: 1245620, type: 'app', name: 'ELDEN RING' },
      { id: 2622380, type: 'app', name: 'ELDEN RING NIGHTREIGN' },
      { id: 2778580, type: 'app', name: 'ELDEN RING Shadow of the Erdtree' },
    ],
  },
  elden_ring_zh_cn: {
    total: 3,
    items: [
      { id: 1245620, type: 'app', name: '艾尔登法环' },
      { id: 2622380, type: 'app', name: '艾尔登法环 黑夜君临' },
      { id: 2778580, type: 'app', name: '艾尔登法环 黄金树幽影' },
    ],
  },
  elden_ring_zh_tw: {
    total: 3,
    items: [
      { id: 1245620, type: 'app', name: '艾爾登法環' },
      { id: 2622380, type: 'app', name: '艾爾登法環 黑夜君臨' },
      { id: 2778580, type: 'app', name: '艾爾登法環 黃金樹幽影' },
    ],
  },
  bg3_zh_cn: {
    total: 1,
    items: [{ id: 1086940, type: 'app', name: '博德之门3' }],
  },
  bg3_zh_tw: {
    total: 1,
    items: [{ id: 1086940, type: 'app', name: '柏德之門3' }],
  },
  bg3_en: {
    total: 1,
    items: [{ id: 1086940, type: 'app', name: "Baldur's Gate 3" }],
  },
  mixed_non_app_types: {
    total: 4,
    items: [
      { id: 9991, type: 'sub', name: 'Cyberpunk 2077 Package' },
      { id: 9992, type: 'bundle', name: 'Cyberpunk 2077 Bundle' },
      { id: 1091500, type: 'app', name: 'Cyberpunk 2077' },
      { id: 0, type: 'app', name: 'Invalid Zero ID' },
    ],
  },
  same_name_duplicate_apps: {
    total: 2,
    items: [
      { id: 500001, type: 'app', name: 'Duplicate Quest' },
      { id: 500002, type: 'app', name: 'Duplicate Quest' },
    ],
  },
  empty: {
    total: 0,
    items: [],
  },
} as const;

export interface RawStoreItemFixture {
  item_type: number;
  id: number;
  appid: number;
  success: number;
  visible: boolean;
  name: string;
  type?: number;
  unlisted?: boolean;
}

/** Real observed anonymous GetItems store_items shapes (sanitized). */
export const GET_ITEMS_BY_LANG: Record<string, Record<number, RawStoreItemFixture>> = {
  english: {
    100: { item_type: 0, id: 100, appid: 100, success: 1, visible: true, type: 14, name: 'Counter-Strike: Condition Zero Deleted Scenes' },
    400: { item_type: 0, id: 400, appid: 400, success: 1, visible: true, type: 0, name: 'Portal' },
    620: { item_type: 0, id: 620, appid: 620, success: 1, visible: true, type: 0, name: 'Portal 2' },
    211420: { item_type: 0, id: 211420, appid: 211420, success: 1, visible: true, type: 0, name: 'DARK SOULS™: Prepare To Die™ Edition', unlisted: true },
    254700: { item_type: 0, id: 254700, appid: 254700, success: 1, visible: true, type: 0, name: 'Resident Evil 4 (2005)' },
    292030: { item_type: 0, id: 292030, appid: 292030, success: 1, visible: true, type: 0, name: 'The Witcher 3: Wild Hunt — Remastered' },
    317400: { item_type: 0, id: 317400, appid: 317400, success: 1, visible: true, type: 2, name: 'Portal Stories: Mel' },
    374040: { item_type: 0, id: 374040, appid: 374040, success: 1, visible: true, type: 0, name: 'Portal Knights' },
    413150: { item_type: 0, id: 413150, appid: 413150, success: 1, visible: true, type: 0, name: 'Stardew Valley' },
    431960: { item_type: 0, id: 431960, appid: 431960, success: 1, visible: true, type: 6, name: 'Wallpaper Engine' },
    755800: { item_type: 0, id: 755800, appid: 755800, success: 1, visible: true, type: 0, name: "Hades' Star" },
    1086940: { item_type: 0, id: 1086940, appid: 1086940, success: 1, visible: true, type: 0, name: "Baldur's Gate 3" },
    1091500: { item_type: 0, id: 1091500, appid: 1091500, success: 1, visible: true, type: 0, name: 'Cyberpunk 2077' },
    1145350: { item_type: 0, id: 1145350, appid: 1145350, success: 1, visible: true, type: 0, name: 'Hades II' },
    1145360: { item_type: 0, id: 1145360, appid: 1145360, success: 1, visible: true, type: 0, name: 'Hades' },
    1206340: { item_type: 0, id: 1206340, appid: 1206340, success: 1, visible: true, type: 11, name: 'Hades Original Soundtrack' },
    1229320: { item_type: 0, id: 1229320, appid: 1229320, success: 1, visible: true, type: 11, name: 'The Witcher 3: Wild Hunt — Remastered Soundtrack' },
    1233280: { item_type: 0, id: 1233280, appid: 1233280, success: 1, visible: true, type: 11, name: 'The Witcher 3: Wild Hunt - Hearts of Stone Soundtrack' },
    1233340: { item_type: 0, id: 1233340, appid: 1233340, success: 1, visible: true, type: 11, name: 'The Witcher 3: Wild Hunt - Blood and Wine Soundtrack' },
    1245620: { item_type: 0, id: 1245620, appid: 1245620, success: 1, visible: true, type: 0, name: 'ELDEN RING' },
    2050650: { item_type: 0, id: 2050650, appid: 2050650, success: 1, visible: true, type: 0, name: 'Resident Evil 4' },
    2109300: { item_type: 0, id: 2109300, appid: 2109300, success: 1, visible: true, type: 4, name: 'Resident Evil 4 - Separate Ways' },
    2109315: { item_type: 0, id: 2109315, appid: 2109315, success: 1, visible: true, type: 4, name: 'Resident Evil 4 - The Mercenaries' },
    2138330: { item_type: 0, id: 2138330, appid: 2138330, success: 1, visible: true, type: 4, name: 'Cyberpunk 2077: Phantom Liberty' },
    2231770: { item_type: 0, id: 2231770, appid: 2231770, success: 1, visible: true, type: 1, name: 'Resident Evil 4 Chainsaw Demo' },
    2593600: { item_type: 0, id: 2593600, appid: 2593600, success: 1, visible: true, type: 11, name: 'Resident Evil 4 Original Soundtrack' },
    2622380: { item_type: 0, id: 2622380, appid: 2622380, success: 1, visible: true, type: 0, name: 'ELDEN RING NIGHTREIGN' },
    2684660: { item_type: 0, id: 2684660, appid: 2684660, success: 1, visible: true, type: 13, name: 'The Witcher 3 REDkit' },
    2778580: { item_type: 0, id: 2778580, appid: 2778580, success: 1, visible: true, type: 4, name: 'ELDEN RING Shadow of the Erdtree' },
    2950840: { item_type: 0, id: 2950840, appid: 2950840, success: 1, visible: true, type: 11, name: 'Hades II Original Soundtrack' },
    3653720: { item_type: 0, id: 3653720, appid: 3653720, success: 1, visible: true, type: 0, name: 'Hades Harem' },
    5006530: { item_type: 0, id: 5006530, appid: 5006530, success: 1, visible: true, type: 4, name: 'The Witcher 3: Wild Hunt — Songs of the Past' },
    500001: { item_type: 0, id: 500001, appid: 500001, success: 1, visible: true, type: 0, name: 'Duplicate Quest' },
    500002: { item_type: 0, id: 500002, appid: 500002, success: 1, visible: true, type: 0, name: 'Duplicate Quest' },
    500099: { item_type: 0, id: 500099, appid: 500099, success: 1, visible: true, type: 99, name: 'Future Unknown Type App' },
    999999999: { item_type: 0, id: 999999999, appid: 0, success: 15, visible: false, name: '' },
  },
  schinese: {
    292030: { item_type: 0, id: 292030, appid: 292030, success: 1, visible: true, type: 0, name: '巫师3：狂猎 — 重制版' },
    431960: { item_type: 0, id: 431960, appid: 431960, success: 1, visible: true, type: 6, name: 'Wallpaper Engine：壁纸引擎' },
    1086940: { item_type: 0, id: 1086940, appid: 1086940, success: 1, visible: true, type: 0, name: '博德之门3' },
    1091500: { item_type: 0, id: 1091500, appid: 1091500, success: 1, visible: true, type: 0, name: '赛博朋克 2077' },
    // Observed real English fallback when schinese localized title does not exist on Steam:
    1145360: { item_type: 0, id: 1145360, appid: 1145360, success: 1, visible: true, type: 0, name: 'Hades' },
    1245620: { item_type: 0, id: 1245620, appid: 1245620, success: 1, visible: true, type: 0, name: '艾尔登法环' },
    2138330: { item_type: 0, id: 2138330, appid: 2138330, success: 1, visible: true, type: 4, name: '《赛博朋克 2077：往日之影》' },
    2622380: { item_type: 0, id: 2622380, appid: 2622380, success: 1, visible: true, type: 0, name: '艾尔登法环 黑夜君临' },
    2778580: { item_type: 0, id: 2778580, appid: 2778580, success: 1, visible: true, type: 4, name: '艾尔登法环 黄金树幽影' },
  },
  tchinese: {
    1086940: { item_type: 0, id: 1086940, appid: 1086940, success: 1, visible: true, type: 0, name: '柏德之門3' },
    1091500: { item_type: 0, id: 1091500, appid: 1091500, success: 1, visible: true, type: 0, name: 'Cyberpunk 2077' },
    1245620: { item_type: 0, id: 1245620, appid: 1245620, success: 1, visible: true, type: 0, name: '艾爾登法環' },
    2138330: { item_type: 0, id: 2138330, appid: 2138330, success: 1, visible: true, type: 4, name: '《電馭叛客 2077：自由幻局》' },
  },
  japanese: {
    292030: { item_type: 0, id: 292030, appid: 292030, success: 1, visible: true, type: 0, name: 'ウィッチャー３　ワイルドハント　リマスター' },
    1091500: { item_type: 0, id: 1091500, appid: 1091500, success: 1, visible: true, type: 0, name: 'サイバーパンク2077' },
    1145360: { item_type: 0, id: 1145360, appid: 1145360, success: 1, visible: true, type: 0, name: 'Hades' },
    2138330: { item_type: 0, id: 2138330, appid: 2138330, success: 1, visible: true, type: 4, name: 'サイバーパンク2077：仮初めの自由' },
    2231770: { item_type: 0, id: 2231770, appid: 2231770, success: 1, visible: true, type: 1, name: 'BIOHAZARD RE:4 Chainsaw Demo' },
  },
  polish: {
    292030: { item_type: 0, id: 292030, appid: 292030, success: 1, visible: true, type: 0, name: 'Wiedźmin 3: Dziki Gon – Remaster' },
    1091500: { item_type: 0, id: 1091500, appid: 1091500, success: 1, visible: true, type: 0, name: 'Cyberpunk 2077' },
    2138330: { item_type: 0, id: 2138330, appid: 2138330, success: 1, visible: true, type: 4, name: 'Cyberpunk 2077: Widmo wolności' },
  },
  koreana: {
    1091500: { item_type: 0, id: 1091500, appid: 1091500, success: 1, visible: true, type: 0, name: 'Cyberpunk 2077' },
    1145360: { item_type: 0, id: 1145360, appid: 1145360, success: 1, visible: true, type: 0, name: 'Hades' },
    1245620: { item_type: 0, id: 1245620, appid: 1245620, success: 1, visible: true, type: 0, name: 'ELDEN RING' },
    2138330: { item_type: 0, id: 2138330, appid: 2138330, success: 1, visible: true, type: 4, name: '사이버펑크 2077: 팬텀 리버티' },
    3135730: { item_type: 0, id: 3135730, appid: 3135730, success: 1, visible: true, type: 0, name: '세보그: 하데스' },
  },
  russian: {
    292030: { item_type: 0, id: 292030, appid: 292030, success: 1, visible: true, type: 0, name: 'Ведьмак 3: Дикая Охота — Обновлённое издание' },
    1091500: { item_type: 0, id: 1091500, appid: 1091500, success: 1, visible: true, type: 0, name: 'Cyberpunk 2077' },
    2138330: { item_type: 0, id: 2138330, appid: 2138330, success: 1, visible: true, type: 4, name: 'Cyberpunk 2077: Призрачная свобода' },
  },
};

export function makeGetItemsResponse(appids: readonly number[], language: string): {
  response: { store_items: RawStoreItemFixture[] };
} {
  const langTable = GET_ITEMS_BY_LANG[language] ?? {};
  const enTable = GET_ITEMS_BY_LANG['english'] ?? {};
  const store_items = appids.map((appid) => {
    const found = langTable[appid] ?? enTable[appid];
    if (found) {
      return found;
    }
    return {
      item_type: 0,
      id: appid,
      appid: 0,
      success: 15,
      visible: false,
      name: '',
    };
  });
  return { response: { store_items } };
}

/** Documented GetOwnedGames response fixtures (synthetic account data). */
export const OWNED_GAMES_FIXTURES = {
  sample: {
    response: {
      game_count: 5,
      games: [
        { appid: 1091500, name: 'Cyberpunk 2077', playtime_forever: 1200 },
        { appid: 292030, name: 'The Witcher 3: Wild Hunt — Remastered', playtime_forever: 4500 },
        { appid: 211420, name: 'DARK SOULS™: Prepare To Die™ Edition', playtime_forever: 600 },
        { appid: 1145360, name: 'Hades', playtime_forever: 300 },
        { appid: 500099, name: 'Future Unknown Type App', playtime_forever: 0 },
      ],
    },
  },
  explicit_empty_with_array: {
    response: {
      game_count: 0,
      games: [],
    },
  },
  explicit_empty_omitted_games: {
    response: {
      game_count: 0,
    },
  },
  unconfirmable_empty_object: {
    response: {},
  },
  contradictory_zero_count_with_games: {
    response: {
      game_count: 0,
      games: [{ appid: 1091500, name: 'Cyberpunk 2077', playtime_forever: 10 }],
    },
  },
  contradictory_count_mismatch: {
    response: {
      game_count: 3,
      games: [{ appid: 1091500, name: 'Cyberpunk 2077', playtime_forever: 10 }],
    },
  },
} as const;

export function makeLargeOwnedGamesFixture(count: number): {
  response: {
    game_count: number;
    games: Array<{ appid: number; name: string; playtime_forever: number }>;
  };
} {
  const games = Array.from({ length: count }, (_, idx) => ({
    appid: 10_000 + (count - idx), // deliberately unsorted to verify deterministic sorting
    name: `Simulated Library Game ${count - idx}`,
    playtime_forever: idx % 500,
  }));
  return {
    response: {
      game_count: count,
      games,
    },
  };
}

/** Observed & documented GetWishlist fixtures. */
export const WISHLIST_FIXTURES = {
  sample: {
    response: {
      items: [
        { appid: 1245620, date_added: 1700000100 }, // missing priority -> must sort last!
        { appid: 1086940, priority: 2, date_added: 1700000000 },
        { appid: 413150, priority: 1, date_added: 1699000000 },
        { appid: 400, priority: 2, date_added: 1698000000 }, // tie on priority=2 -> appid 400 before 1086940!
        { appid: 999999999, priority: 5, date_added: 1700000500 }, // missing metadata -> must NOT be dropped!
      ],
    },
  },
  verifiable_sample: {
    response: {
      items: [
        { appid: 1245620, date_added: 1700000100 },
        { appid: 1086940, priority: 2, date_added: 1700000000 },
        { appid: 413150, priority: 1, date_added: 1699000000 },
        { appid: 400, priority: 2, date_added: 1698000000 },
      ],
    },
  },
  explicit_empty: {
    response: {
      items: [],
    },
  },
  // Observed verbatim on live anonymous probe for private/nonexistent profiles:
  observed_unconfirmable_empty_object: {
    response: {},
  },
} as const;
