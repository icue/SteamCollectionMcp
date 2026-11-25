import { isValidSteamId64 } from './utils/identity.js';
import { isSteamLanguage, mapToSteamLanguage, type SteamLanguage } from './utils/languages.js';

export interface ServerConfig {
  readonly steamApiKey: string;
  readonly steamId: string;
  readonly country: string;
  readonly language: SteamLanguage;
  readonly httpTimeoutMs: number;
  readonly maxConcurrency: number;
  readonly metadataBatchSize: number;
  readonly toolTimeoutMs: number;
}

export class ConfigError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ConfigError';
    this.code = code;
  }
}

const COUNTRY_CODE_REGEX = /^[A-Za-z]{2}$/;
const INTEGER_STRING_REGEX = /^[0-9]+$/;

function parseIntInRange(
  raw: string | undefined,
  envName: string,
  defaultValue: number,
  min: number,
  max: number,
): number {
  if (raw === undefined || raw.trim() === '') {
    return defaultValue;
  }
  const trimmed = raw.trim();
  if (!INTEGER_STRING_REGEX.test(trimmed)) {
    throw new ConfigError(
      'invalid_config',
      `${envName} must be an integer between ${min} and ${max}.`,
    );
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new ConfigError(
      'invalid_config',
      `${envName} must be an integer between ${min} and ${max}.`,
    );
  }
  return parsed;
}

/**
 * Loads and validates all required and optional environment variables.
 * Never includes STEAM_API_KEY or raw secret values in thrown errors.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const rawApiKey = env['STEAM_API_KEY'];
  if (rawApiKey === undefined || rawApiKey.trim().length === 0) {
    throw new ConfigError(
      'missing_steam_api_key',
      'Missing required environment variable STEAM_API_KEY.',
    );
  }
  const steamApiKey = rawApiKey.trim();
  if (/[\s\r\n\u0000-\u001F\u007F]/.test(steamApiKey)) {
    throw new ConfigError(
      'invalid_steam_api_key',
      'STEAM_API_KEY must not contain whitespace or control characters.',
    );
  }

  const rawSteamId = env['STEAM_ID'];
  if (rawSteamId === undefined || rawSteamId.trim().length === 0) {
    throw new ConfigError(
      'missing_steam_id',
      'Missing required environment variable STEAM_ID (17-digit SteamID64 string).',
    );
  }
  const steamId = rawSteamId.trim();
  if (!isValidSteamId64(steamId)) {
    throw new ConfigError(
      'invalid_steam_id',
      'STEAM_ID must be a valid 17-digit decimal SteamID64 string.',
    );
  }

  const rawCountry = env['STEAM_COUNTRY'];
  let country = 'US';
  if (rawCountry !== undefined && rawCountry.trim().length > 0) {
    const trimmedCountry = rawCountry.trim();
    if (!COUNTRY_CODE_REGEX.test(trimmedCountry)) {
      throw new ConfigError(
        'invalid_steam_country',
        'STEAM_COUNTRY must be a two-letter ISO country code (e.g. US, JP, DE).',
      );
    }
    country = trimmedCountry.toUpperCase();
  }

  const rawLanguage = env['STEAM_LANGUAGE'];
  let language: SteamLanguage = 'english';
  if (rawLanguage !== undefined && rawLanguage.trim().length > 0) {
    const mapped = mapToSteamLanguage(rawLanguage);
    if (mapped === null || !isSteamLanguage(mapped)) {
      throw new ConfigError(
        'invalid_steam_language',
        'STEAM_LANGUAGE must be a supported Steam Store API language code or BCP 47 tag (e.g. english, schinese, ja, pt-BR).',
      );
    }
    language = mapped;
  }

  const httpTimeoutMs = parseIntInRange(
    env['STEAM_HTTP_TIMEOUT_MS'],
    'STEAM_HTTP_TIMEOUT_MS',
    10_000,
    1_000,
    60_000,
  );

  const maxConcurrency = parseIntInRange(
    env['STEAM_MAX_CONCURRENCY'],
    'STEAM_MAX_CONCURRENCY',
    2,
    1,
    8,
  );

  const metadataBatchSize = parseIntInRange(
    env['STEAM_METADATA_BATCH_SIZE'],
    'STEAM_METADATA_BATCH_SIZE',
    50,
    1,
    100,
  );

  const toolTimeoutMs = parseIntInRange(
    env['STEAM_TOOL_TIMEOUT_MS'],
    'STEAM_TOOL_TIMEOUT_MS',
    90_000,
    5_000,
    300_000,
  );

  if (httpTimeoutMs > toolTimeoutMs) {
    throw new ConfigError(
      'invalid_timeout_range',
      'STEAM_HTTP_TIMEOUT_MS must not exceed STEAM_TOOL_TIMEOUT_MS.',
    );
  }

  return Object.freeze({
    steamApiKey,
    steamId,
    country,
    language,
    httpTimeoutMs,
    maxConcurrency,
    metadataBatchSize,
    toolTimeoutMs,
  });
}
