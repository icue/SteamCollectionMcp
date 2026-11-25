export const UINT32_MAX = 4_294_967_295;

const STEAM_ID64_REGEX = /^[1-9][0-9]{16}$/;
const CANONICAL_POSITIVE_INT_REGEX = /^[1-9][0-9]{0,9}$/;
const SIGNED_OR_ZERO_INT_REGEX = /^-?[0-9]+$/;
const TRUSTED_STORE_HOST = 'store.steampowered.com';

export function isValidSteamId64(value: string): boolean {
  return STEAM_ID64_REGEX.test(value);
}

export function isValidAppId(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= UINT32_MAX;
}

export function buildStoreUrl(appid: number): string {
  if (!isValidAppId(appid)) {
    throw new RangeError(`Invalid Steam AppID: ${String(appid)}`);
  }
  return `https://store.steampowered.com/app/${appid}/`;
}

export type DirectIdentifierResult =
  | {
      kind: 'appid';
      appid: number;
      source: 'decimal_appid' | 'store_app_url';
    }
  | {
      kind: 'rejected_url';
      reason: string;
    }
  | {
      kind: 'invalid_numeric_id';
      reason: string;
    }
  | {
      kind: 'name';
      original: string;
    };

function parsePositiveUint32String(raw: string): number | null {
  if (!CANONICAL_POSITIVE_INT_REGEX.test(raw)) {
    return null;
  }
  const big = BigInt(raw);
  if (big < 1n || big > BigInt(UINT32_MAX)) {
    return null;
  }
  return Number(big);
}

function looksLikeUrl(trimmed: string): boolean {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    return true;
  }
  if (/^store\.steampowered\.com\//i.test(trimmed)) {
    return true;
  }
  return false;
}

/**
 * Parses direct Steam identifiers without ever performing network calls.
 * - Accepts positive uint32 decimal AppIDs (1..4294967295, no leading zeros).
 * - Accepts trusted Steam Store `/app/<appid>` URLs on `store.steampowered.com`.
 * - Rejects untrusted domains, `/sub/`, `/bundle/`, non-app store paths, path traversal,
 *   SteamID64s, zero, negative numbers, and uint32 overflows.
 */
export function parseDirectIdentifier(rawQuery: string): DirectIdentifierResult {
  const trimmed = rawQuery.trim();

  if (looksLikeUrl(trimmed)) {
    if (!/^https?:\/\//i.test(trimmed)) {
      return {
        kind: 'rejected_url',
        reason: 'Only explicit https://store.steampowered.com/app/<appid>/ URLs are accepted as Steam Store links.',
      };
    }

    // Reject control characters, whitespace, and backslashes BEFORE WHATWG URL normalization
    if (/[\s\u0000-\u001F\u007F\\]/.test(trimmed)) {
      return {
        kind: 'rejected_url',
        reason: 'Steam Store URL contains disallowed whitespace, control characters, or backslashes.',
      };
    }

    const schemeIdx = trimmed.indexOf('://');
    const afterScheme = trimmed.slice(schemeIdx + 3);
    const delimMatch = /[/?#]/.exec(afterScheme);
    const rawAuthority = delimMatch ? afterScheme.slice(0, delimMatch.index) : afterScheme;
    const rawRest = delimMatch ? afterScheme.slice(delimMatch.index) : '';

    // Strictly validate raw authority before URL normalization (blocks credentials, custom ports, untrusted hosts)
    if (rawAuthority.toLowerCase() !== TRUSTED_STORE_HOST) {
      if (rawAuthority.includes('@') || rawAuthority.includes(':')) {
        return {
          kind: 'rejected_url',
          reason: 'Steam Store URL must not include credentials or a custom port.',
        };
      }
      return {
        kind: 'rejected_url',
        reason: `Untrusted URL domain "${rawAuthority}"; only ${TRUSTED_STORE_HOST} /app/<appid>/ URLs are accepted.`,
      };
    }

    const rawPath = rawRest.split(/[?#]/, 1)[0] ?? '';

    // Strictly validate raw path BEFORE URL normalization can collapse encoded dot-segments or duplicate slashes
    if (!rawPath.startsWith('/')) {
      return {
        kind: 'rejected_url',
        reason: 'Steam Store URL must specify a canonical /app/<appid>/ path.',
      };
    }

    if (rawPath.includes('//') || /%(?:2f|5c)/i.test(rawPath)) {
      return {
        kind: 'rejected_url',
        reason: 'Steam Store URL contains disallowed duplicate or encoded slash path segments.',
      };
    }

    const rawSegments = rawPath.slice(1).split('/');
    if (rawPath.endsWith('/')) {
      rawSegments.pop();
    }

    if (rawSegments.length === 0 || rawSegments.some((seg) => seg.length === 0)) {
      return {
        kind: 'rejected_url',
        reason: 'Steam Store URL contains empty path segments.',
      };
    }

    // Reject any raw or percent-encoded dot-segments anywhere in the raw path
    for (const seg of rawSegments) {
      if (seg === '.' || seg === '..') {
        return {
          kind: 'rejected_url',
          reason: 'Steam Store URL contains disallowed dot path segments.',
        };
      }
      if (seg.includes('%')) {
        let decodedSeg: string;
        try {
          decodedSeg = decodeURIComponent(seg);
        } catch {
          return {
            kind: 'rejected_url',
            reason: 'Steam Store URL contains malformed percent-encoding in its path.',
          };
        }
        if (
          decodedSeg === '.' ||
          decodedSeg === '..' ||
          decodedSeg.includes('/') ||
          decodedSeg.includes('\\') ||
          /[\u0000-\u001F\u007F]/.test(decodedSeg)
        ) {
          return {
            kind: 'rejected_url',
            reason: 'Steam Store URL contains disallowed encoded path segments.',
          };
        }
      }
    }

    const kindSegment = rawSegments[0];
    if (kindSegment !== 'app') {
      return {
        kind: 'rejected_url',
        reason: `Unsupported Steam Store URL path "/${kindSegment ?? ''}/"; only canonical "/app/<appid>/" URLs identify a Steam AppID (not /sub/ or /bundle/).`,
      };
    }

    if (rawSegments.length < 2 || rawSegments.length > 3) {
      return {
        kind: 'rejected_url',
        reason:
          'Steam Store URL path must be canonical "/app/<appid>/" or "/app/<appid>/<slug>/" with no extra path segments.',
      };
    }

    const idSegment = rawSegments[1]!;
    const appid = parsePositiveUint32String(idSegment);
    if (appid === null) {
      return {
        kind: 'rejected_url',
        reason: 'Steam Store /app/ URL does not contain a valid positive uint32 AppID.',
      };
    }

    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return {
        kind: 'rejected_url',
        reason: 'Malformed URL cannot be parsed as a Steam Store app link.',
      };
    }

    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return {
        kind: 'rejected_url',
        reason: 'Unsupported URL protocol; expected https://store.steampowered.com/app/<appid>/.',
      };
    }

    if (parsed.username !== '' || parsed.password !== '' || parsed.port !== '') {
      return {
        kind: 'rejected_url',
        reason: 'Steam Store URL must not include credentials or a custom port.',
      };
    }

    if (parsed.hostname.toLowerCase() !== TRUSTED_STORE_HOST) {
      return {
        kind: 'rejected_url',
        reason: `Untrusted URL domain "${parsed.hostname}"; only ${TRUSTED_STORE_HOST} /app/<appid>/ URLs are accepted.`,
      };
    }

    // Confirm parsed pathname did not alter segment structure during URL parsing
    const parsedSegments = parsed.pathname.slice(1).split('/');
    if (parsed.pathname.endsWith('/')) {
      parsedSegments.pop();
    }
    if (
      parsedSegments.length !== rawSegments.length ||
      parsedSegments[0] !== 'app' ||
      parsedSegments[1] !== idSegment
    ) {
      return {
        kind: 'rejected_url',
        reason: 'Steam Store URL path changed unexpectedly during normalization and was rejected.',
      };
    }

    return {
      kind: 'appid',
      appid,
      source: 'store_app_url',
    };
  }

  // Pure integer check
  if (SIGNED_OR_ZERO_INT_REGEX.test(trimmed)) {
    // Keep leading-zero numeric titles like "007" as name queries
    if (trimmed.length > 1 && trimmed.startsWith('0')) {
      return { kind: 'name', original: trimmed };
    }

    const appid = parsePositiveUint32String(trimmed);
    if (appid !== null) {
      return {
        kind: 'appid',
        appid,
        source: 'decimal_appid',
      };
    }

    if (isValidSteamId64(trimmed)) {
      return {
        kind: 'invalid_numeric_id',
        reason: 'Input is a 17-digit SteamID64, not a Steam AppID.',
      };
    }

    return {
      kind: 'invalid_numeric_id',
      reason: 'Numeric input is outside the valid positive uint32 Steam AppID range (1..4294967295).',
    };
  }

  return {
    kind: 'name',
    original: trimmed,
  };
}

/**
 * Strict Unicode normalization: NFKC, lowercase folding, trimmed & collapsed whitespace.
 * Preserves all digits, edition names, and punctuation.
 */
export function normalizeStrict(value: string): string {
  return value.normalize('NFKC').toLowerCase().trim().replace(/\s+/g, ' ');
}

const CJK_CHAR_CLASS = '\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}';
const CJK_AFTER_SPACE = new RegExp(`([${CJK_CHAR_CLASS}])\\s+(?=[${CJK_CHAR_CLASS}0-9a-z])`, 'gu');
const ALNUM_BEFORE_CJK = new RegExp(`([0-9a-z])\\s+(?=[${CJK_CHAR_CLASS}])`, 'gu');

/**
 * Canonical title comparison normalization for exact identity verification.
 * - Strips trademark/copyright symbols (™ ® ©) BEFORE NFKC so ™ does not become "tm".
 * - Applies NFKC + lowercase folding.
 * - Normalizes typographic quote/apostrophe variants.
 * - Strips controlled title-wrapper noise (outer CJK book-title brackets, parenthesized suffixes like "(2005)").
 * - Normalizes interior structural title separators (colons, hyphens/typographic dashes, middle dots)
 *   WITHOUT stripping semantic variant symbols (such as "+", "!", "?", "*", "#", "&", "=", "/", ".", ";")
 *   or leading/trailing symbols.
 * - Normalizes CJK-adjacent spacing (e.g. "赛博朋克 2077" === "赛博朋克2077").
 * - Strictly PRESERVES all numbers, Roman numerals, subtitles, semantic symbols, and edition/remake/DLC/demo words.
 */
export function normalizeComparable(value: string): string {
  const withoutSymbols = value.replace(/[\u2122\u00AE\u00A9]/g, '');
  let s = withoutSymbols.normalize('NFKC').toLowerCase().trim();

  // Normalize curly quotes/apostrophes to ASCII equivalents (preserves the quote/apostrophe itself)
  s = s.replace(/[\u2018\u2019\u2032\u0060]/g, "'");
  s = s.replace(/[\u201C\u201D\u2033]/g, '"');

  // Strip balanced outer CJK book/title brackets (e.g. "《赛博朋克 2077：往日之影》")
  s = s.replace(/^[《「『【〈]\s*(.+?)\s*[》」』】〉]$/u, '$1');

  // Unwrap parenthesized trailing/interior qualifiers such as "(2005)" or "(Remastered)" while preserving inner tokens
  s = s.replace(/(?<=\S)\s*\(([^()]+)\)/g, ' $1');

  // Normalize single interior structural separators (colon, hyphen, typographic dashes, middle dots) to space.
  // Trailing/leading separators (e.g. "Signal-") and semantic symbols (e.g. "Signal+", "N++") are preserved.
  s = s.replace(/(?<=\S)\s*[:\-\u2010-\u2015\u2212·•・]\s*(?=\S)/gu, ' ');

  // Collapse whitespace
  s = s.trim().replace(/\s+/g, ' ');

  // Normalize spacing between CJK characters and adjacent CJK/alphanumeric characters
  s = s.replace(CJK_AFTER_SPACE, '$1');
  s = s.replace(ALNUM_BEFORE_CJK, '$1');

  return s.trim();
}

/**
 * Loose normalization (punctuation/symbol & accent/diacritic folded) strictly for candidate ranking/ordering,
 * NEVER as proof of exact identity.
 */
export function normalizeLoose(value: string): string {
  let s = normalizeComparable(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .normalize('NFC');
  s = s.replace(/[《》「」『』【】〈〉（）()[\]{}:;,.!?/\\|"'`~^*+_=<>·•・\-@#$%&]/g, ' ');
  s = s.trim().replace(/\s+/g, ' ');
  s = s.replace(CJK_AFTER_SPACE, '$1');
  s = s.replace(ALNUM_BEFORE_CJK, '$1');
  return s.trim();
}

export function isExactComparableMatch(a: string, b: string): boolean {
  const na = normalizeComparable(a);
  const nb = normalizeComparable(b);
  return na.length > 0 && na === nb;
}

const EDITION_VARIANT_KEYWORDS = new Set<string>([
  'remastered',
  'remaster',
  'remake',
  'definitive',
  'edition',
  'goty',
  'complete',
  'directors',
  'director',
  'cut',
  'hd',
  'classic',
  'original',
  'anniversary',
  'special',
  'ultimate',
  'enhanced',
  'royal',
  'extended',
  'redux',
  'reforged',
  'reborn',
  'gold',
  'platinum',
  'deluxe',
  'legacy',
  'collection',
  'vr',
  '重制版',
  '重置版',
  '决定版',
  '终极版',
  '特别版',
  '年度版',
  '完全版',
  '重製版',
  '決定版',
  '終極版',
  '特別版',
  'リマスター',
  'リメイク',
  'обновлённое',
  'обновленное',
  'издание',
]);

const NON_EDITION_COMPANION_KEYWORDS = new Set<string>([
  'soundtrack',
  'ost',
  'demo',
  'dlc',
  'artbook',
  'pack',
  'bundle',
  'mod',
  'tool',
  'redkit',
  'sdk',
  'playtest',
  'beta',
  'trailer',
  '原声带',
  '原聲帶',
  '试玩版',
  '試玩版',
  'サウンドトラック',
]);

const SEQUEL_LEADING_TOKENS = new Set<string>([
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  '10',
  'ii',
  'iii',
  'iv',
  'v',
  'vi',
  'vii',
  'viii',
  'ix',
  'x',
]);

const YEAR_TOKEN_REGEX = /^(?:19[7-9][0-9]|20[0-3][0-9])$/;

/**
 * Returns true if `otherComparable` looks like a year/remake/edition variant
 * of `baseComparable` (e.g. "resident evil 4" vs "resident evil 4 2005" or
 * "dark souls" vs "dark souls remastered"), NOT a numbered sequel like "hades ii"
 * or "portal 2", and NOT a soundtrack/demo/DLC companion app.
 */
export function isEditionVariantOf(baseComparable: string, otherComparable: string): boolean {
  if (!baseComparable || !otherComparable || baseComparable === otherComparable) {
    return false;
  }

  let suffix = '';
  if (otherComparable.startsWith(`${baseComparable} `)) {
    suffix = otherComparable.slice(baseComparable.length + 1).trim();
  } else if (otherComparable.startsWith(baseComparable)) {
    // Handle CJK where no space separates base and suffix (e.g. "巫师3狂猎重制版")
    const remainder = otherComparable.slice(baseComparable.length).trim();
    if (/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(remainder)) {
      suffix = remainder;
    } else {
      return false;
    }
  } else {
    return false;
  }

  if (suffix.length === 0) {
    return false;
  }

  const tokens = suffix.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) {
    return false;
  }

  // Sequel titles (e.g. "hades ii", "hades ii original soundtrack", "portal 2") are NOT edition variants
  if (SEQUEL_LEADING_TOKENS.has(tokens[0]!)) {
    return false;
  }

  // Companion apps (soundtracks, demos, DLC packs, artbooks, tools) are NOT edition variants
  for (const token of tokens) {
    if (NON_EDITION_COMPANION_KEYWORDS.has(token)) {
      return false;
    }
  }
  for (const kw of NON_EDITION_COMPANION_KEYWORDS) {
    if (kw.length >= 2 && /[^\x00-\x7F]/.test(kw) && suffix.includes(kw)) {
      return false;
    }
  }

  for (const token of tokens) {
    if (YEAR_TOKEN_REGEX.test(token) || EDITION_VARIANT_KEYWORDS.has(token)) {
      return true;
    }
  }

  for (const kw of EDITION_VARIANT_KEYWORDS) {
    if (kw.length >= 2 && /[^\x00-\x7F]/.test(kw) && suffix.includes(kw)) {
      return true;
    }
  }

  return false;
}

/**
 * Computes a loose ranking score in [0, 100] purely for ordering ambiguous candidates.
 */
export function scoreCandidateForRanking(query: string, candidateName: string | null): number {
  if (!candidateName) {
    return 0;
  }

  const qComp = normalizeComparable(query);
  const cComp = normalizeComparable(candidateName);
  if (!qComp || !cComp) {
    return 0;
  }

  if (qComp === cComp) {
    return 100;
  }

  const qLoose = normalizeLoose(query);
  const cLoose = normalizeLoose(candidateName);
  if (qLoose === cLoose) {
    return 95;
  }

  if (isEditionVariantOf(qComp, cComp) || isEditionVariantOf(cComp, qComp)) {
    return 85;
  }

  if (cLoose.startsWith(`${qLoose} `) || cLoose.startsWith(qLoose)) {
    return 70;
  }

  if (cLoose.includes(qLoose)) {
    return 55;
  }

  const qTokens = new Set(qLoose.split(/\s+/).filter(Boolean));
  const cTokens = new Set(cLoose.split(/\s+/).filter(Boolean));
  if (qTokens.size === 0 || cTokens.size === 0) {
    return 0;
  }

  let overlap = 0;
  for (const t of qTokens) {
    if (cTokens.has(t)) {
      overlap++;
    }
  }

  if (overlap === 0) {
    return 5;
  }

  const precision = overlap / cTokens.size;
  const recall = overlap / qTokens.size;
  return Math.round(10 + 40 * ((2 * precision * recall) / (precision + recall)));
}
