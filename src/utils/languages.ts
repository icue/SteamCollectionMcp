export const STEAM_LANGUAGES = [
  'arabic',
  'bulgarian',
  'schinese',
  'tchinese',
  'czech',
  'danish',
  'dutch',
  'english',
  'finnish',
  'french',
  'german',
  'greek',
  'hungarian',
  'indonesian',
  'italian',
  'japanese',
  'koreana',
  'malay',
  'norwegian',
  'polish',
  'portuguese',
  'brazilian',
  'romanian',
  'russian',
  'spanish',
  'latam',
  'swedish',
  'thai',
  'turkish',
  'ukrainian',
  'vietnamese',
] as const;

export type SteamLanguage = (typeof STEAM_LANGUAGES)[number];

const STEAM_LANGUAGE_SET = new Set<string>(STEAM_LANGUAGES);

/**
 * Exact BCP 47 tag (lowercased, hyphen-separated) to Steam API language code.
 * Uses a Map (never plain object property lookup) so inherited prototype keys
 * such as "constructor", "__proto__", "toString", or "hasOwnProperty" can never match.
 * Covers all 31 Steam Full Platform Supported languages from Valve documentation:
 * https://partner.steamgames.com/doc/store/localization/languages?l=english
 */
const EXACT_BCP47_TO_STEAM = new Map<string, SteamLanguage>([
  ['ar', 'arabic'],
  ['bg', 'bulgarian'],
  ['zh-cn', 'schinese'],
  ['zh-sg', 'schinese'],
  ['zh-hans', 'schinese'],
  ['zh-hans-cn', 'schinese'],
  ['zh-hans-sg', 'schinese'],
  ['zh-tw', 'tchinese'],
  ['zh-hk', 'tchinese'],
  ['zh-mo', 'tchinese'],
  ['zh-hant', 'tchinese'],
  ['zh-hant-tw', 'tchinese'],
  ['zh-hant-hk', 'tchinese'],
  ['zh-hant-mo', 'tchinese'],
  ['zh', 'schinese'],
  ['cs', 'czech'],
  ['da', 'danish'],
  ['nl', 'dutch'],
  ['en', 'english'],
  ['fi', 'finnish'],
  ['fr', 'french'],
  ['de', 'german'],
  ['el', 'greek'],
  ['hu', 'hungarian'],
  ['id', 'indonesian'],
  ['in', 'indonesian'],
  ['it', 'italian'],
  ['ja', 'japanese'],
  ['ko', 'koreana'],
  ['ms', 'malay'],
  ['no', 'norwegian'],
  ['nb', 'norwegian'],
  ['nn', 'norwegian'],
  ['pl', 'polish'],
  ['pt', 'portuguese'],
  ['pt-pt', 'portuguese'],
  ['pt-br', 'brazilian'],
  ['ro', 'romanian'],
  ['ru', 'russian'],
  ['es', 'spanish'],
  ['es-es', 'spanish'],
  ['es-419', 'latam'],
  ['sv', 'swedish'],
  ['th', 'thai'],
  ['tr', 'turkish'],
  ['uk', 'ukrainian'],
  ['vi', 'vietnamese'],
]);

const LATAM_SPANISH_REGIONS = new Set<string>([
  '419',
  'ar',
  'bo',
  'cl',
  'co',
  'cr',
  'cu',
  'do',
  'ec',
  'gt',
  'hn',
  'mx',
  'ni',
  'pa',
  'pe',
  'pr',
  'py',
  'sv',
  'uy',
  've',
]);

const PRIMARY_SUBTAG_TO_STEAM = new Map<string, SteamLanguage>([
  ['ar', 'arabic'],
  ['bg', 'bulgarian'],
  ['cs', 'czech'],
  ['da', 'danish'],
  ['nl', 'dutch'],
  ['en', 'english'],
  ['fi', 'finnish'],
  ['fr', 'french'],
  ['de', 'german'],
  ['el', 'greek'],
  ['hu', 'hungarian'],
  ['id', 'indonesian'],
  ['in', 'indonesian'],
  ['it', 'italian'],
  ['ja', 'japanese'],
  ['ko', 'koreana'],
  ['ms', 'malay'],
  ['no', 'norwegian'],
  ['nb', 'norwegian'],
  ['nn', 'norwegian'],
  ['pl', 'polish'],
  ['pt', 'portuguese'],
  ['ro', 'romanian'],
  ['ru', 'russian'],
  ['es', 'spanish'],
  ['sv', 'swedish'],
  ['th', 'thai'],
  ['tr', 'turkish'],
  ['uk', 'ukrainian'],
  ['vi', 'vietnamese'],
]);

export function isSteamLanguage(value: string): value is SteamLanguage {
  return STEAM_LANGUAGE_SET.has(value);
}

const PRIMARY_LANG_REGEX = /^[a-z]{2,3}$/;
const EXTLANG_REGEX = /^[a-z]{3}$/;
const SCRIPT_REGEX = /^[a-z]{4}$/;
const REGION_REGEX = /^(?:[a-z]{2}|[0-9]{3})$/;
const VARIANT_REGEX = /^(?:[a-z0-9]{5,8}|[0-9][a-z0-9]{3})$/;
const EXTENSION_SINGLETON_REGEX = /^[0-9a-wy-z]$/;
const EXTENSION_SUBTAG_REGEX = /^[a-z0-9]{2,8}$/;
const PRIVATEUSE_SUBTAG_REGEX = /^[a-z0-9]{1,8}$/;

/**
 * IANA Language Subtag Registry `Type: extlang` subtags keyed by their mandatory
 * RFC 5646 §2.2.2 `Prefix` primary language subtag, scoped strictly to supported
 * Steam Store macrolanguages (`zh`, `ar`, `ms`).
 * All other supported Steam primary subtags (e.g. `en`, `de`, `fr`, `ja`, `ko`,
 * `es`, `pt`, `pl`, `ru`, `id`/`in`, `no`/`nb`/`nn`) have no registered IANA
 * extlang subtags, so any extlang paired with them (e.g. `en-cmn`) is rejected.
 */
const SUPPORTED_PRIMARY_EXTLANGS: ReadonlyMap<string, ReadonlySet<string>> = new Map<
  string,
  ReadonlySet<string>
>([
  [
    'zh',
    new Set<string>([
      'cdo',
      'cjy',
      'cmn',
      'cnp',
      'cpx',
      'csp',
      'czh',
      'czo',
      'gan',
      'hak',
      'hnm',
      'hsn',
      'luh',
      'lzh',
      'mnp',
      'nan',
      'sjc',
      'wuu',
      'yue',
    ]),
  ],
  [
    'ar',
    new Set<string>([
      'aao',
      'abh',
      'abv',
      'acm',
      'acq',
      'acw',
      'acx',
      'acy',
      'adf',
      'aeb',
      'aec',
      'afb',
      'ajp',
      'apc',
      'apd',
      'arb',
      'arq',
      'ars',
      'ary',
      'arz',
      'auz',
      'avl',
      'ayh',
      'ayl',
      'ayn',
      'ayp',
      'bbz',
      'pga',
      'shu',
      'ssh',
    ]),
  ],
  [
    'ms',
    new Set<string>([
      'bjn',
      'btj',
      'bve',
      'bvu',
      'coa',
      'dup',
      'hji',
      'jak',
      'jax',
      'kvb',
      'kvr',
      'kxd',
      'lce',
      'lcf',
      'liw',
      'max',
      'meo',
      'mfa',
      'mfb',
      'min',
      'mqg',
      'msi',
      'mui',
      'orn',
      'ors',
      'pel',
      'pse',
      'tmw',
      'urk',
      'vkk',
      'vkt',
      'xmm',
      'zlm',
      'zmi',
      'zsm',
    ]),
  ],
]);

/**
 * Validates RFC 5646 BCP 47 langtag structure (primary, optional single IANA extlang
 * matching its mandatory Prefix per RFC 5646 §2.2.2, optional script, optional region,
 * optional non-duplicate variants, optional non-duplicate non-empty extensions,
 * optional non-empty private-use) and extracts primary, script, and region subtags
 * strictly from their valid positions.
 */
function parseBcp47Langtag(normalized: string): {
  primary: string;
  script: string | null;
  region: string | null;
} | null {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalized)) {
    return null;
  }

  const parts = normalized.split('-');
  let index = 0;

  const primary = parts[index];
  if (!primary || !PRIMARY_LANG_REGEX.test(primary)) {
    return null;
  }
  index++;

  // Optional RFC 5646 §2.2.2 extlang: at most 1 three-letter subtag whose IANA Prefix matches `primary`
  if (index < parts.length && EXTLANG_REGEX.test(parts[index]!)) {
    const allowedExtlangs = SUPPORTED_PRIMARY_EXTLANGS.get(primary);
    const extlang = parts[index]!;
    if (!allowedExtlangs || !allowedExtlangs.has(extlang)) {
      return null;
    }
    index++;
    // RFC 5646 §2.2.2 forbids combining multiple extlang subtags in one language tag
    if (index < parts.length && EXTLANG_REGEX.test(parts[index]!)) {
      return null;
    }
  }

  // Optional script: single 4-letter subtag
  let script: string | null = null;
  if (index < parts.length && SCRIPT_REGEX.test(parts[index]!)) {
    script = parts[index]!;
    index++;
  }

  // Optional region: single 2-letter or 3-digit subtag
  let region: string | null = null;
  if (index < parts.length && REGION_REGEX.test(parts[index]!)) {
    region = parts[index]!;
    index++;
  }

  // Optional variant subtags (RFC 5646 section 2.2.9 forbids duplicates)
  const seenVariants = new Set<string>();
  while (index < parts.length && VARIANT_REGEX.test(parts[index]!)) {
    const variant = parts[index]!;
    if (seenVariants.has(variant)) {
      return null;
    }
    seenVariants.add(variant);
    index++;
  }

  // Optional extension sequences: singleton (non-'x') + 1+ subtags (2..8 alphanum), no duplicate singletons
  const seenSingletons = new Set<string>();
  while (index < parts.length && EXTENSION_SINGLETON_REGEX.test(parts[index]!)) {
    const singleton = parts[index]!;
    if (seenSingletons.has(singleton)) {
      return null;
    }
    seenSingletons.add(singleton);
    index++;

    let extSubtagCount = 0;
    while (index < parts.length && EXTENSION_SUBTAG_REGEX.test(parts[index]!)) {
      extSubtagCount++;
      index++;
    }
    if (extSubtagCount === 0) {
      return null;
    }
  }

  // Optional private-use sequence: 'x' + 1+ subtags (1..8 alphanum)
  if (index < parts.length && parts[index] === 'x') {
    index++;
    let privateCount = 0;
    while (index < parts.length && PRIVATEUSE_SUBTAG_REGEX.test(parts[index]!)) {
      privateCount++;
      index++;
    }
    if (privateCount === 0) {
      return null;
    }
  }

  // Reject any leftover or out-of-position subtags (e.g. duplicate region, script after region)
  if (index !== parts.length) {
    return null;
  }

  return { primary, script, region };
}

/**
 * Maps a Steam API language code or BCP 47 tag to a supported Steam API language code.
 * Returns null if the input is malformed or not a supported Steam Store platform language.
 */
export function mapToSteamLanguage(input: string): SteamLanguage | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const normalized = trimmed.toLowerCase().replace(/_/g, '-');

  if (isSteamLanguage(normalized)) {
    return normalized;
  }

  const exact = EXACT_BCP47_TO_STEAM.get(normalized);
  if (exact !== undefined) {
    return exact;
  }

  const parsed = parseBcp47Langtag(normalized);
  if (parsed === null) {
    return null;
  }

  const { primary, script, region } = parsed;

  if (primary === 'zh') {
    if (script === 'hans') {
      return 'schinese';
    }
    if (script === 'hant') {
      return 'tchinese';
    }
    if (region === 'tw' || region === 'hk' || region === 'mo') {
      return 'tchinese';
    }
    if (region === 'cn' || region === 'sg') {
      return 'schinese';
    }
    return 'schinese';
  }

  if (primary === 'pt') {
    return region === 'br' ? 'brazilian' : 'portuguese';
  }

  if (primary === 'es') {
    if (region !== null && LATAM_SPANISH_REGIONS.has(region)) {
      return 'latam';
    }
    return 'spanish';
  }

  return PRIMARY_SUBTAG_TO_STEAM.get(primary) ?? null;
}

export interface LanguageResolution {
  steamLanguage: SteamLanguage;
  supported: boolean;
  input?: string;
  warning?: string;
}

/**
 * Resolves an optional caller language hint against supported Steam Store languages,
 * falling back to defaultLanguage with a warning when unsupported.
 */
export function resolveSteamLanguage(
  input: string | undefined,
  defaultLanguage: SteamLanguage,
): LanguageResolution {
  if (input === undefined || input.trim().length === 0) {
    return {
      steamLanguage: defaultLanguage,
      supported: true,
    };
  }

  const mapped = mapToSteamLanguage(input);
  if (mapped !== null) {
    return {
      steamLanguage: mapped,
      supported: true,
      input: input.trim(),
    };
  }

  return {
    steamLanguage: defaultLanguage,
    supported: false,
    input: input.trim(),
    warning: `Language "${input.trim()}" is not supported by Steam Store API; falling back to default language "${defaultLanguage}".`,
  };
}
