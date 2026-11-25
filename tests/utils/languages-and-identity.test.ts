import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../src/config.js';
import {
  buildStoreUrl,
  isEditionVariantOf,
  isExactComparableMatch,
  isValidAppId,
  isValidSteamId64,
  normalizeComparable,
  normalizeLoose,
  normalizeStrict,
  parseDirectIdentifier,
  scoreCandidateForRanking,
  UINT32_MAX,
} from '../../src/utils/identity.js';
import {
  isSteamLanguage,
  mapToSteamLanguage,
  resolveSteamLanguage,
  STEAM_LANGUAGES,
} from '../../src/utils/languages.js';
import { TEST_STEAM_API_KEY, TEST_STEAM_ID } from '../fixtures/steam-responses.js';

describe('languages mapping', () => {
  it('supports all 31 Valve Steam Store platform languages directly', () => {
    expect(STEAM_LANGUAGES).toHaveLength(31);
    for (const lang of STEAM_LANGUAGES) {
      expect(isSteamLanguage(lang)).toBe(true);
      expect(mapToSteamLanguage(lang)).toBe(lang);
      expect(mapToSteamLanguage(lang.toUpperCase())).toBe(lang);
    }
  });

  it('maps BCP 47 tags and regional variants to Steam API codes', () => {
    const cases: Array<[string, string]> = [
      ['en', 'english'],
      ['en-US', 'english'],
      ['en_GB', 'english'],
      ['ja', 'japanese'],
      ['ja-JP', 'japanese'],
      ['ko', 'koreana'],
      ['ko-KR', 'koreana'],
      ['pl', 'polish'],
      ['pl-PL', 'polish'],
      ['pt', 'portuguese'],
      ['pt-PT', 'portuguese'],
      ['pt-BR', 'brazilian'],
      ['pt_br', 'brazilian'],
      ['zh-CN', 'schinese'],
      ['zh-SG', 'schinese'],
      ['zh-Hans', 'schinese'],
      ['zh-Hans-CN', 'schinese'],
      ['zh-Hans-TW', 'schinese'],
      ['zh-Hans-HK', 'schinese'],
      ['zh-Hans-MO', 'schinese'],
      ['zh-Hans-TW-u-ca-chinese', 'schinese'],
      ['zh-Hans-TW-pinyin', 'schinese'],
      ['zh-Hans-TW-x-custom', 'schinese'],
      ['zh-cmn-Hans-TW', 'schinese'],
      ['zh-TW', 'tchinese'],
      ['zh-HK', 'tchinese'],
      ['zh-MO', 'tchinese'],
      ['zh-Hant', 'tchinese'],
      ['zh-Hant-CN', 'tchinese'],
      ['zh-Hant-SG', 'tchinese'],
      ['zh-Hant-CN-u-nu-latn', 'tchinese'],
      ['zh-Hant-CN-wadegile', 'tchinese'],
      ['zh-Hant-CN-x-custom', 'tchinese'],
      ['zh-yue-Hant-CN', 'tchinese'],
      ['pt-BR-u-nu-latn', 'brazilian'],
      ['es-419-u-nu-latn', 'latam'],
      ['en-AU', 'english'],
      ['es', 'spanish'],
      ['es-ES', 'spanish'],
      ['es-419', 'latam'],
      ['es-MX', 'latam'],
      ['es-AR', 'latam'],
      ['ru', 'russian'],
      ['ar', 'arabic'],
      ['id', 'indonesian'],
      ['ms', 'malay'],
      ['nb', 'norwegian'],
      ['nn-NO', 'norwegian'],
      ['uk', 'ukrainian'],
      ['vi', 'vietnamese'],
      ['th', 'thai'],
      ['tr', 'turkish'],
    ];

    for (const [input, expected] of cases) {
      expect(mapToSteamLanguage(input)).toBe(expected);
    }
  });

  it('falls back to default language with a warning for unsupported languages and inherited prototype names', () => {
    expect(mapToSteamLanguage('hi')).toBeNull();
    expect(mapToSteamLanguage('he-IL')).toBeNull();
    expect(mapToSteamLanguage('fa')).toBeNull();

    // Prototype / inherited Object property names MUST never resolve to functions or truthy values
    const prototypeNames = [
      'constructor',
      'CONSTRUCTOR',
      '__proto__',
      'toString',
      'valueOf',
      'hasOwnProperty',
      'isPrototypeOf',
      'propertyIsEnumerable',
      'toLocaleString',
      'prototype',
    ];
    for (const name of prototypeNames) {
      expect(mapToSteamLanguage(name), `mapToSteamLanguage(${name})`).toBeNull();
      const resolved = resolveSteamLanguage(name, 'english');
      expect(resolved.supported).toBe(false);
      expect(resolved.steamLanguage).toBe('english');
      expect(typeof resolved.steamLanguage).toBe('string');
      expect(resolved.warning).toContain(name);
      expect(resolved.warning).toContain('english');
    }

    // Mixed-case BCP 47 tags and extension singletons (e.g. -x- / -u-) still map accurately
    expect(mapToSteamLanguage('Zh-Hant-TW')).toBe('tchinese');
    expect(mapToSteamLanguage('ZH_HANS_CN')).toBe('schinese');
    expect(mapToSteamLanguage('Pt_Br')).toBe('brazilian');
    expect(mapToSteamLanguage('es-ES-x-mx')).toBe('spanish');
    expect(mapToSteamLanguage('zh-Hans-u-ca-chinese')).toBe('schinese');
    expect(mapToSteamLanguage('ES-419')).toBe('latam');

    const res = resolveSteamLanguage('hi', 'english');
    expect(res.supported).toBe(false);
    expect(res.steamLanguage).toBe('english');
    expect(res.warning).toContain('hi');
    expect(res.warning).toContain('english');

    const omitted = resolveSteamLanguage(undefined, 'japanese');
    expect(omitted.supported).toBe(true);
    expect(omitted.steamLanguage).toBe('japanese');
    expect(omitted.warning).toBeUndefined();

    // Invalid BCP 47 syntax (empty extensions, duplicate regions/scripts/singletons/variants, out-of-position subtags)
    const malformedBcp47 = [
      'en-u',
      'en-US-GB',
      'en-x',
      'en-u-x-custom',
      'en-u-1',
      'en-u-ca-u-nu',
      'en-a-foo-a-bar',
      'en-fonipa-fonipa',
      'en-US-Hans',
      'en-Latn-Cyrl',
      'en-1996-US',
      'en-US-419',
      'en-foo-bar-baz-qux',
      'en-12',
      'en-123456789',
      'en-u-123456789',
      'en-x-123456789',
      'en--US',
      '-en',
      'en-',
      'en_u',
      'en_US_GB',
      // RFC 5646 §2.2.2 extlang Prefix mismatches, unknown extlangs, and multi-extlang tags
      'en-cmn',
      'EN_CMN',
      'en-yue',
      'en-arb',
      'en-zsm',
      'de-cmn',
      'fr-foo',
      'zh-arb',
      'ar-cmn',
      'ms-cmn',
      'zh-foo',
      'zh-cmn-yue',
      'zh-cmn-cmn',
    ];
    for (const badTag of malformedBcp47) {
      expect(mapToSteamLanguage(badTag), `expected null for ${badTag}`).toBeNull();
      const fallback = resolveSteamLanguage(badTag, 'english');
      expect(fallback.supported, `resolveSteamLanguage(${badTag})`).toBe(false);
      expect(fallback.steamLanguage, `resolveSteamLanguage(${badTag})`).toBe('english');
      expect(fallback.warning, `resolveSteamLanguage(${badTag})`).toContain(badTag);
    }

    // Valid BCP 47 variants, extensions, aliases, prefix-matched extlangs, and script-over-region combinations remain supported
    expect(mapToSteamLanguage('en-1996')).toBe('english');
    expect(mapToSteamLanguage('de-Latn-DE-1901')).toBe('german');
    expect(mapToSteamLanguage('en-US-u-ca-gregory')).toBe('english');
    expect(mapToSteamLanguage('en-US-u-ca-gregory-x-custom')).toBe('english');
    expect(mapToSteamLanguage('en-u-cmn')).toBe('english');
    expect(mapToSteamLanguage('en-x-cmn')).toBe('english');
    expect(mapToSteamLanguage('in-ID')).toBe('indonesian');
    expect(mapToSteamLanguage('zh-cmn')).toBe('schinese');
    expect(mapToSteamLanguage('zh-cmn-TW')).toBe('tchinese');
    expect(mapToSteamLanguage('zh-cmn-Hans-TW')).toBe('schinese');
    expect(mapToSteamLanguage('zh-cmn-Hant-CN')).toBe('tchinese');
    expect(mapToSteamLanguage('ar-arb')).toBe('arabic');
    expect(mapToSteamLanguage('ar-arz-EG')).toBe('arabic');
    expect(mapToSteamLanguage('ms-zsm')).toBe('malay');
    expect(mapToSteamLanguage('zh-Hans-TW')).toBe('schinese');
    expect(mapToSteamLanguage('zh-Hant-CN')).toBe('tchinese');
  });
});

describe('identity validation and parsing', () => {
  it('validates SteamID64 strictly as 17-digit decimal strings', () => {
    expect(isValidSteamId64('76561198000000001')).toBe(true);
    expect(isValidSteamId64('76561197960435530')).toBe(true);
    expect(isValidSteamId64('06561198000000001')).toBe(false);
    expect(isValidSteamId64('7656119800000000')).toBe(false);
    expect(isValidSteamId64('765611980000000012')).toBe(false);
    expect(isValidSteamId64('7656119800000000a')).toBe(false);
    expect(isValidSteamId64('')).toBe(false);
  });

  it('validates positive uint32 AppIDs and builds canonical store URLs', () => {
    expect(isValidAppId(1)).toBe(true);
    expect(isValidAppId(292030)).toBe(true);
    expect(isValidAppId(UINT32_MAX)).toBe(true);
    expect(isValidAppId(0)).toBe(false);
    expect(isValidAppId(-1)).toBe(false);
    expect(isValidAppId(UINT32_MAX + 1)).toBe(false);
    expect(isValidAppId(1.5)).toBe(false);
    expect(buildStoreUrl(292030)).toBe('https://store.steampowered.com/app/292030/');
  });

  it('parses valid AppIDs and trusted Steam Store /app/ URLs', () => {
    expect(parseDirectIdentifier('292030')).toEqual({
      kind: 'appid',
      appid: 292030,
      source: 'decimal_appid',
    });
    expect(parseDirectIdentifier('4294967295')).toEqual({
      kind: 'appid',
      appid: 4294967295,
      source: 'decimal_appid',
    });
    expect(
      parseDirectIdentifier('https://store.steampowered.com/app/1091500/Cyberpunk_2077/?l=schinese'),
    ).toEqual({
      kind: 'appid',
      appid: 1091500,
      source: 'store_app_url',
    });
    expect(parseDirectIdentifier('https://store.steampowered.com/app/400')).toEqual({
      kind: 'appid',
      appid: 400,
      source: 'store_app_url',
    });
  });

  it('rejects untrusted domains, /sub/, /bundle/, path traversal, SteamID64, and uint32 overflows as AppIDs', () => {
    const rejectedUrls = [
      'https://evil.example.com/app/1091500/',
      'https://store.steampowered.com.evil.com/app/1091500/',
      'https://steamcommunity.com/app/1091500/',
      'https://store.steampowered.com/sub/12345/',
      'https://store.steampowered.com/bundle/232/',
      'https://store.steampowered.com/app/0/',
      'https://store.steampowered.com/app/0480/',
      'https://store.steampowered.com/app/4294967296/',
      'https://store.steampowered.com/sub/123/../app/1091500/',
      'https://store.steampowered.com/sub/480/%2e%2e/%2e%2e/app/292030/',
      'https://store.steampowered.com/app/480/%2e%2e/292030/',
      'https://store.steampowered.com/app/480/%2e%2e/',
      'https://store.steampowered.com/app/480/.',
      'https://store.steampowered.com/app/480/..',
      'https://store.steampowered.com//app//480/',
      'https://store.steampowered.com/app//480/',
      'https://store.steampowered.com/app/480//',
      'https://store.steampowered.com/APP/480/',
      'https://store.steampowered.com/app/480/arbitrary/path/',
      'https://store.steampowered.com/app\\480/',
      'https://store.steampowered.com/app/480%2f292030/',
      'https://store.steampowered.com/a\tpp/480/',
      'https://user:pass@store.steampowered.com/app/1091500/',
      'https://store.steampowered.com:8443/app/1091500/',
      'https://store.steampowered.com:443/app/480/',
      'ftp://store.steampowered.com/app/1091500/',
      'store.steampowered.com/app/480/',
    ];

    for (const url of rejectedUrls) {
      const parsed = parseDirectIdentifier(url);
      expect(parsed.kind, `expected rejected_url for ${url}`).toBe('rejected_url');
    }

    // Valid canonical URLs with slug, UTF-8 percent-encoded slug, query string, and fragment still parse
    expect(
      parseDirectIdentifier('https://store.steampowered.com/app/480/Valid_Slug/?l=english#reviews'),
    ).toEqual({ kind: 'appid', appid: 480, source: 'store_app_url' });
    expect(
      parseDirectIdentifier('https://store.steampowered.com/app/1091500/%E8%B5%9B%E5%8D%9A%E6%9C%8B%E5%85%8B_2077/'),
    ).toEqual({ kind: 'appid', appid: 1091500, source: 'store_app_url' });

    expect(parseDirectIdentifier('0').kind).toBe('invalid_numeric_id');
    expect(parseDirectIdentifier('-42').kind).toBe('invalid_numeric_id');
    expect(parseDirectIdentifier('4294967296').kind).toBe('invalid_numeric_id');
    expect(parseDirectIdentifier('76561198000000001').kind).toBe('invalid_numeric_id');

    // Leading-zero numeric title stays a game name
    expect(parseDirectIdentifier('007')).toEqual({ kind: 'name', original: '007' });
  });

  it('normalizes Unicode NFKC, case, whitespace, symbols, and CJK spacing while preserving numbers and editions', () => {
    expect(normalizeStrict('  ウィッチャー３　ワイルドハント  ')).toBe('ウィッチャー3 ワイルドハント');

    // Trademark symbols must NOT become "tm" after NFKC
    expect(normalizeComparable('DARK SOULS™: Prepare To Die™ Edition')).toBe(
      'dark souls prepare to die edition',
    );
    expect(
      isExactComparableMatch(
        'Dark Souls: Prepare To Die Edition',
        'DARK SOULS™: Prepare To Die™ Edition',
      ),
    ).toBe(true);

    // CJK spacing normalization
    expect(isExactComparableMatch('赛博朋克2077', '赛博朋克 2077')).toBe(true);
    expect(isExactComparableMatch('博德之门 3', '博德之门3')).toBe(true);
    expect(isExactComparableMatch('サイバーパンク 2077', 'サイバーパンク2077')).toBe(true);

    // Preserves sequel numerals, editions, remasters, years, and semantic symbols (e.g. Signal+ vs Signal)
    expect(isExactComparableMatch('Hades', 'Hades II')).toBe(false);
    expect(isExactComparableMatch('Portal', 'Portal 2')).toBe(false);
    expect(isExactComparableMatch('Resident Evil 4', 'Resident Evil 4 (2005)')).toBe(false);
    expect(
      isExactComparableMatch('The Witcher 3: Wild Hunt', 'The Witcher 3: Wild Hunt — Remastered'),
    ).toBe(false);
    expect(isExactComparableMatch('Signal+', 'Signal')).toBe(false);
    expect(isExactComparableMatch('N++', 'N+')).toBe(false);
    expect(isExactComparableMatch('Signal!', 'Signal')).toBe(false);
    expect(isExactComparableMatch('Signal?', 'Signal')).toBe(false);
    expect(isExactComparableMatch('Signal-', 'Signal')).toBe(false);
    expect(isExactComparableMatch('《赛博朋克 2077：往日之影》', '赛博朋克2077：往日之影')).toBe(true);
    expect(isExactComparableMatch("Baldur's Gate 3", 'Baldur’s Gate 3')).toBe(true);

    // Loose normalization folds diacritics and punctuation strictly for ranking, NEVER for exact match
    expect(normalizeLoose('Wiedźmin 3: Dziki Gon')).toBe('wiedzmin 3 dziki gon');
    expect(normalizeLoose('Signal+')).toBe('signal');
    expect(scoreCandidateForRanking('Signal+', 'Signal')).toBe(95);
    expect(scoreCandidateForRanking('Resident Evil 4', 'Resident Evil 4 (2005)')).toBeGreaterThan(
      scoreCandidateForRanking('Resident Evil 4', 'Resident Evil 4 Chainsaw Demo'),
    );
  });

  it('distinguishes edition/year/remake variants from numbered sequels and companion soundtracks/demos', () => {
    expect(isEditionVariantOf('resident evil 4', 'resident evil 4 2005')).toBe(true);
    expect(isEditionVariantOf('dark souls', 'dark souls remastered')).toBe(true);
    expect(isEditionVariantOf('the witcher 3 wild hunt', 'the witcher 3 wild hunt remastered')).toBe(
      true,
    );
    expect(isEditionVariantOf('hades', 'hades ii')).toBe(false);
    expect(isEditionVariantOf('hades', 'hades ii original soundtrack')).toBe(false);
    expect(isEditionVariantOf('hades', 'hades original soundtrack')).toBe(false);
    expect(isEditionVariantOf('portal', 'portal 2')).toBe(false);
  });
});

describe('config loading and secret safety', () => {
  it('loads defaults and normalizes country and BCP 47 language', () => {
    const cfg = loadConfig({
      STEAM_API_KEY: TEST_STEAM_API_KEY,
      STEAM_ID: TEST_STEAM_ID,
      STEAM_COUNTRY: 'jp',
      STEAM_LANGUAGE: 'zh-CN',
    });

    expect(cfg.steamApiKey).toBe(TEST_STEAM_API_KEY);
    expect(cfg.steamId).toBe(TEST_STEAM_ID);
    expect(typeof cfg.steamId).toBe('string');
    expect(cfg.country).toBe('JP');
    expect(cfg.language).toBe('schinese');
    expect(cfg.httpTimeoutMs).toBe(10_000);
    expect(cfg.maxConcurrency).toBe(2);
    expect(cfg.metadataBatchSize).toBe(50);
    expect(cfg.toolTimeoutMs).toBe(90_000);
  });

  it('rejects invalid config without leaking STEAM_API_KEY', () => {
    const secret = 'SUPER_SECRET_KEY_VALUE_XYZ987';
    expect(() => loadConfig({ STEAM_ID: TEST_STEAM_ID })).toThrowError(ConfigError);

    try {
      loadConfig({
        STEAM_API_KEY: `${secret} with space`,
        STEAM_ID: TEST_STEAM_ID,
      });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as Error).message).not.toContain(secret);
    }

    expect(() =>
      loadConfig({
        STEAM_API_KEY: secret,
        STEAM_ID: '12345',
      }),
    ).toThrowError(/SteamID64/);

    expect(() =>
      loadConfig({
        STEAM_API_KEY: secret,
        STEAM_ID: TEST_STEAM_ID,
        STEAM_HTTP_TIMEOUT_MS: '60000',
        STEAM_TOOL_TIMEOUT_MS: '30000',
      }),
    ).toThrowError(/must not exceed/);

    for (const badLang of [
      'klingon',
      'constructor',
      '__proto__',
      'toString',
      'hasOwnProperty',
      'en-u',
      'en-US-GB',
      'en-x',
      'en-US-Hans',
      'en-u-ca-u-nu',
      'en-cmn',
      'zh-arb',
      'ar-cmn',
      'zh-cmn-yue',
    ]) {
      try {
        loadConfig({
          STEAM_API_KEY: secret,
          STEAM_ID: TEST_STEAM_ID,
          STEAM_LANGUAGE: badLang,
        });
        expect.unreachable(`expected ConfigError for STEAM_LANGUAGE=${badLang}`);
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        expect((err as ConfigError).code).toBe('invalid_steam_language');
        expect((err as Error).message).toContain('STEAM_LANGUAGE');
        expect((err as Error).message).not.toContain(secret);
      }
    }

    // Script-over-region BCP 47 startup config keeps country code independent
    const cfgHansTw = loadConfig({
      STEAM_API_KEY: secret,
      STEAM_ID: TEST_STEAM_ID,
      STEAM_COUNTRY: 'US',
      STEAM_LANGUAGE: 'zh-Hans-TW',
    });
    expect(cfgHansTw.language).toBe('schinese');
    expect(cfgHansTw.country).toBe('US');

    const cfgHantCn = loadConfig({
      STEAM_API_KEY: secret,
      STEAM_ID: TEST_STEAM_ID,
      STEAM_COUNTRY: 'US',
      STEAM_LANGUAGE: 'zh-Hant-CN',
    });
    expect(cfgHantCn.language).toBe('tchinese');
    expect(cfgHantCn.country).toBe('US');
  });
});
