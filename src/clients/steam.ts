import type { ServerConfig } from '../config.js';
import {
  UpstreamGetItemsResponseSchema,
  UpstreamGetOwnedGamesResponseSchema,
  UpstreamGetWishlistResponseSchema,
  UpstreamStoreSearchResponseSchema,
  type AppType,
} from '../schemas.js';
import { isValidAppId } from '../utils/identity.js';
import type { SteamLanguage } from '../utils/languages.js';
import {
  SteamClientError,
  type RequestExecutionContext,
  type RequestPriority,
  type SteamHttpClient,
} from './http.js';

export interface OwnedGameRecord {
  readonly appid: number;
  readonly name: string | null;
  readonly playtimeForever: number | null;
}

export interface OwnedGamesResult {
  readonly games: OwnedGameRecord[];
  readonly gameCount: number;
  readonly fetchedAt: string;
}

export interface WishlistRecord {
  readonly appid: number;
  readonly priority: number | null;
  readonly dateAdded: number | null;
}

export interface WishlistResult {
  readonly items: WishlistRecord[];
  readonly fetchedAt: string;
}

export interface StoreSearchItem {
  readonly appid: number;
  readonly name: string;
}

export interface StoreSearchResult {
  readonly total: number;
  readonly rawItemCount: number;
  readonly items: StoreSearchItem[];
  readonly fetchedAt: string;
}

export interface StoreItemMetadata {
  readonly appid: number;
  readonly found: boolean;
  readonly name: string | null;
  readonly appType: AppType;
  readonly requestedLanguage: SteamLanguage;
  readonly unlisted: boolean;
  readonly omitted?: boolean;
}

export interface GetItemsResult {
  readonly itemsByAppId: Map<number, StoreItemMetadata>;
  readonly fetchedAt: string;
}

/**
 * Maps Valve's EStoreAppType integer enum (observed on IStoreBrowseService/GetItems/v1/)
 * to normalized AppType strings. Unknown or omitted values remain "unknown".
 */
const STORE_APP_TYPE_MAP = new Map<number, AppType>([
  [0, 'game'],
  [1, 'demo'],
  [2, 'mod'],
  [3, 'movie'],
  [4, 'dlc'],
  [5, 'guide'],
  [6, 'software'],
  [7, 'video'],
  [8, 'series'],
  [9, 'episode'],
  [10, 'hardware'],
  [11, 'music'],
  [12, 'beta'],
  [13, 'tool'],
  [14, 'advertising'],
]);

export function mapStoreAppType(rawType: number | undefined): AppType {
  if (rawType === undefined || !Number.isInteger(rawType)) {
    return 'unknown';
  }
  return STORE_APP_TYPE_MAP.get(rawType) ?? 'unknown';
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class SteamApiClient {
  private readonly http: SteamHttpClient;
  private readonly config: ServerConfig;

  constructor(http: SteamHttpClient, config: ServerConfig) {
    this.http = http;
    this.config = config;
  }

  get now(): () => number {
    return this.http.now;
  }

  /**
   * IPlayerService/GetOwnedGames/v1/ (authenticated with STEAM_API_KEY).
   * Strictly validates `response`, `game_count`, and `games`.
   * Empty library is accepted ONLY when `game_count === 0` with no contradictory fields.
   */
  async getOwnedGames(
    ctx: RequestExecutionContext,
    options: { includeAppInfo: boolean },
  ): Promise<OwnedGamesResult> {
    const { data, fetchedAt } = await this.http.getJson(
      'GetOwnedGames',
      {
        key: this.config.steamApiKey,
        steamid: this.config.steamId,
        include_appinfo: options.includeAppInfo ? 'true' : 'false',
        include_played_free_games: 'true',
        format: 'json',
      },
      ctx,
      { highPriority: true },
    );

    if (!isPlainRecord(data) || !isPlainRecord(data['response'])) {
      throw new SteamClientError({
        dataStatus: 'error',
        errorCode: 'invalid_response',
        endpoint: 'GetOwnedGames',
        message: 'GetOwnedGames response is missing a valid response object.',
      });
    }

    const rawResponse = data['response'];
    if (!Object.prototype.hasOwnProperty.call(rawResponse, 'game_count')) {
      throw new SteamClientError({
        dataStatus: 'unavailable',
        errorCode: 'invalid_response',
        endpoint: 'GetOwnedGames',
        message:
          'GetOwnedGames omitted game_count; library visibility or completeness cannot be confirmed.',
      });
    }

    const parsed = UpstreamGetOwnedGamesResponseSchema.safeParse(data);
    if (!parsed.success) {
      throw new SteamClientError({
        dataStatus: 'error',
        errorCode: 'invalid_response',
        endpoint: 'GetOwnedGames',
        message: 'GetOwnedGames response failed schema validation.',
      });
    }

    const { game_count: gameCount, games: rawGames } = parsed.data.response;

    if (gameCount === 0) {
      if (rawGames !== undefined && rawGames.length > 0) {
        throw new SteamClientError({
          dataStatus: 'error',
          errorCode: 'invalid_response',
          endpoint: 'GetOwnedGames',
          message: 'GetOwnedGames returned game_count=0 with non-empty games array.',
        });
      }
      return {
        games: [],
        gameCount: 0,
        fetchedAt,
      };
    }

    if (!Array.isArray(rawGames)) {
      throw new SteamClientError({
        dataStatus: 'error',
        errorCode: 'invalid_response',
        endpoint: 'GetOwnedGames',
        message: 'GetOwnedGames reported non-zero game_count but omitted games array.',
      });
    }

    if (rawGames.length !== gameCount) {
      throw new SteamClientError({
        dataStatus: 'error',
        errorCode: 'invalid_response',
        endpoint: 'GetOwnedGames',
        message: `GetOwnedGames game_count (${gameCount}) does not match games length (${rawGames.length}).`,
      });
    }

    const games: OwnedGameRecord[] = rawGames.map((item) => ({
      appid: item.appid,
      name: typeof item.name === 'string' && item.name.trim().length > 0 ? item.name : null,
      playtimeForever:
        typeof item.playtime_forever === 'number' ? item.playtime_forever : null,
    }));

    return {
      games,
      gameCount,
      fetchedAt,
    };
  }

  /**
   * IWishlistService/GetWishlist/v1/ (anonymous, no API key).
   * Accepts an empty wishlist ONLY when `response.items` is explicitly `[]`.
   * Missing `response.items` (e.g. `{ "response": {} }`) is rejected as unconfirmable.
   */
  async getWishlist(ctx: RequestExecutionContext): Promise<WishlistResult> {
    const { data, fetchedAt } = await this.http.getJson(
      'GetWishlist',
      {
        steamid: this.config.steamId,
      },
      ctx,
      { highPriority: true },
    );

    if (!isPlainRecord(data) || !isPlainRecord(data['response'])) {
      throw new SteamClientError({
        dataStatus: 'error',
        errorCode: 'invalid_response',
        endpoint: 'GetWishlist',
        message: 'GetWishlist response is missing a valid response object.',
      });
    }

    const rawResponse = data['response'];
    if (!Object.prototype.hasOwnProperty.call(rawResponse, 'items')) {
      throw new SteamClientError({
        dataStatus: 'unavailable',
        errorCode: 'invalid_response',
        endpoint: 'GetWishlist',
        message:
          'GetWishlist omitted response.items; cannot distinguish an empty wishlist from an inaccessible wishlist.',
      });
    }

    const parsed = UpstreamGetWishlistResponseSchema.safeParse(data);
    if (!parsed.success) {
      throw new SteamClientError({
        dataStatus: 'error',
        errorCode: 'invalid_response',
        endpoint: 'GetWishlist',
        message: 'GetWishlist response failed schema validation.',
      });
    }

    const items: WishlistRecord[] = parsed.data.response.items.map((item) => ({
      appid: item.appid,
      priority: typeof item.priority === 'number' ? item.priority : null,
      dateAdded: typeof item.date_added === 'number' ? item.date_added : null,
    }));

    return {
      items,
      fetchedAt,
    };
  }

  /**
   * store.steampowered.com/api/storesearch/ (anonymous, no API key).
   * Keeps only valid positive uint32 `type === "app"` entries with non-empty names.
   */
  async storeSearch(
    ctx: RequestExecutionContext,
    params: {
      term: string;
      language: SteamLanguage;
      countryCode?: string;
    },
  ): Promise<StoreSearchResult> {
    const { data, fetchedAt } = await this.http.getJson(
      'StoreSearch',
      {
        term: params.term,
        l: params.language,
        cc: params.countryCode ?? this.config.country,
      },
      ctx,
    );

    const parsed = UpstreamStoreSearchResponseSchema.safeParse(data);
    if (!parsed.success) {
      throw new SteamClientError({
        dataStatus: 'error',
        errorCode: 'invalid_response',
        endpoint: 'StoreSearch',
        message: 'StoreSearch response failed schema validation.',
      });
    }

    const items: StoreSearchItem[] = [];
    const seen = new Set<number>();
    for (const rawItem of parsed.data.items) {
      if (rawItem.type !== 'app') {
        continue;
      }
      if (typeof rawItem.id !== 'number' || !isValidAppId(rawItem.id)) {
        continue;
      }
      if (typeof rawItem.name !== 'string' || rawItem.name.trim().length === 0) {
        continue;
      }
      if (seen.has(rawItem.id)) {
        continue;
      }
      seen.add(rawItem.id);
      items.push({
        appid: rawItem.id,
        name: rawItem.name,
      });
    }

    return {
      total: parsed.data.total,
      rawItemCount: parsed.data.items.length,
      items,
      fetchedAt,
    };
  }

  /**
   * IStoreBrowseService/GetItems/v1/ (anonymous, no API key).
   * Correlates metadata strictly by AppID, never by array position.
   */
  async getItems(
    ctx: RequestExecutionContext,
    params: {
      appids: readonly number[];
      language: SteamLanguage;
      countryCode?: string;
    },
    options?: { readonly priority?: RequestPriority },
  ): Promise<GetItemsResult> {
    const uniqueAppIds: number[] = [];
    const requestedSet = new Set<number>();
    for (const appid of params.appids) {
      if (isValidAppId(appid) && !requestedSet.has(appid)) {
        requestedSet.add(appid);
        uniqueAppIds.push(appid);
      }
    }

    if (uniqueAppIds.length === 0) {
      return {
        itemsByAppId: new Map(),
        fetchedAt: new Date(this.http.now()).toISOString(),
      };
    }

    const inputJson = JSON.stringify({
      ids: uniqueAppIds.map((appid) => ({ appid })),
      context: {
        language: params.language,
        country_code: params.countryCode ?? this.config.country,
        steam_realm: 1,
      },
      data_request: {},
    });

    const { data, fetchedAt } = await this.http.getJson(
      'GetItems',
      {
        input_json: inputJson,
      },
      ctx,
      { priority: options?.priority ?? 'normal' },
    );

    const parsed = UpstreamGetItemsResponseSchema.safeParse(data);
    if (!parsed.success) {
      throw new SteamClientError({
        dataStatus: 'error',
        errorCode: 'invalid_response',
        endpoint: 'GetItems',
        message: 'GetItems response failed schema validation.',
      });
    }

    const itemsByAppId = new Map<number, StoreItemMetadata>();

    for (const rawItem of parsed.data.response.store_items) {
      // Observed live behavior:
      // - Valid app: success === 1, appid === <requested>, id === <requested>, item_type === 0
      // - Invalid/inaccessible app: success !== 1 (e.g. 15), appid === 0, id === <requested>, name === ""
      const responseAppId =
        typeof rawItem.appid === 'number' && isValidAppId(rawItem.appid)
          ? rawItem.appid
          : typeof rawItem.id === 'number' && isValidAppId(rawItem.id)
            ? rawItem.id
            : null;

      if (responseAppId === null || !requestedSet.has(responseAppId)) {
        continue;
      }

      if (rawItem.item_type !== undefined && rawItem.item_type !== 0) {
        continue;
      }

      const ok = rawItem.success === 1 && typeof rawItem.appid === 'number' && rawItem.appid === responseAppId;
      const trimmedName =
        ok && typeof rawItem.name === 'string' && rawItem.name.trim().length > 0
          ? rawItem.name
          : null;

      itemsByAppId.set(responseAppId, {
        appid: responseAppId,
        found: ok && trimmedName !== null,
        name: trimmedName,
        appType: ok ? mapStoreAppType(rawItem.type) : 'unknown',
        requestedLanguage: params.language,
        unlisted: rawItem.unlisted === true,
        omitted: false,
      });
    }

    // Ensure every requested AppID has an explicit entry even if Steam omitted it
    for (const appid of uniqueAppIds) {
      if (!itemsByAppId.has(appid)) {
        itemsByAppId.set(appid, {
          appid,
          found: false,
          name: null,
          appType: 'unknown',
          requestedLanguage: params.language,
          unlisted: false,
          omitted: true,
        });
      }
    }

    return {
      itemsByAppId,
      fetchedAt,
    };
  }
}
