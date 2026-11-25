import type { ServerConfig } from '../config.js';
import {
  ListOwnedGamesOutputSchema,
  ListWishlistGamesOutputSchema,
  type DataStatus,
  type ErrorCode,
  type ListGamesInput,
  type ListOwnedGamesOutput,
  type ListWishlistGamesOutput,
  type OwnedGameItem,
  type WishlistGameItem,
} from '../schemas.js';
import { paginateList, type LibraryService } from '../services/library.js';
import type { MetadataService } from '../services/metadata.js';
import { buildStoreUrl } from '../utils/identity.js';
import { resolveSteamLanguage } from '../utils/languages.js';

export interface ListToolDeps {
  readonly config: ServerConfig;
  readonly library: LibraryService;
  readonly metadata: MetadataService;
}

export interface ListToolErrorPayload {
  readonly list: 'owned' | 'wishlist';
  readonly data_status: Exclude<DataStatus, 'ok'>;
  readonly error_code: ErrorCode;
  readonly message: string;
  readonly fetched_at: string;
}

export type ListToolResult<T> =
  | { readonly ok: true; readonly output: T }
  | { readonly ok: false; readonly error: ListToolErrorPayload };

export async function handleListOwnedGames(
  deps: ListToolDeps,
  input: ListGamesInput,
  signal?: AbortSignal,
): Promise<ListToolResult<ListOwnedGamesOutput>> {
  const scope = deps.library.createScope(signal);
  const warnings: string[] = [];

  const langRes = resolveSteamLanguage(input.language, deps.config.language);
  if (input.include_metadata && langRes.warning) {
    warnings.push(langRes.warning);
  }
  const requestedLanguage = input.include_metadata ? langRes.steamLanguage : null;

  const ownedRes = await deps.library.getOwnedList(scope, {
    includeAppInfo: input.include_metadata,
  });

  if (!ownedRes.ok) {
    return {
      ok: false,
      error: {
        list: 'owned',
        data_status: ownedRes.dataStatus,
        error_code: ownedRes.errorCode,
        message: ownedRes.message,
        fetched_at: ownedRes.fetchedAt,
      },
    };
  }

  const page = paginateList(ownedRes.data.games, input.offset, input.limit);

  if (!input.include_metadata) {
    const games: OwnedGameItem[] = page.items.map((item) => ({
      appid: item.appid,
      name: null,
      requested_language: null,
      app_type: 'unknown',
      store_url: buildStoreUrl(item.appid),
      playtime_forever: item.playtimeForever,
    }));

    const output = ListOwnedGamesOutputSchema.parse({
      list: 'owned',
      total: page.total,
      returned: page.returned,
      offset: page.offset,
      limit: page.limit,
      has_more: page.hasMore,
      fetched_at: ownedRes.fetchedAt,
      data_status: 'ok',
      metadata_status: 'skipped',
      requested_language: null,
      ...(warnings.length > 0 ? { warnings } : {}),
      games,
    });
    return { ok: true, output };
  }

  const pageAppIds = page.items.map((item) => item.appid);
  const metaRes = await deps.metadata.fetchMetadata(scope, pageAppIds, langRes.steamLanguage);
  warnings.push(...metaRes.warnings);

  const games: OwnedGameItem[] = page.items.map((item) => {
    const meta = metaRes.itemsByAppId.get(item.appid);
    const name = meta?.found ? meta.name : item.name;
    const appType = meta?.found ? meta.appType : 'unknown';
    return {
      appid: item.appid,
      name,
      requested_language: requestedLanguage,
      app_type: appType,
      store_url: buildStoreUrl(item.appid),
      playtime_forever: item.playtimeForever,
    };
  });

  const output = ListOwnedGamesOutputSchema.parse({
    list: 'owned',
    total: page.total,
    returned: page.returned,
    offset: page.offset,
    limit: page.limit,
    has_more: page.hasMore,
    fetched_at: ownedRes.fetchedAt,
    data_status: 'ok',
    metadata_status: metaRes.metadataStatus,
    requested_language: requestedLanguage,
    ...(warnings.length > 0 ? { warnings } : {}),
    games,
  });

  return { ok: true, output };
}

export async function handleListWishlistGames(
  deps: ListToolDeps,
  input: ListGamesInput,
  signal?: AbortSignal,
): Promise<ListToolResult<ListWishlistGamesOutput>> {
  const scope = deps.library.createScope(signal);
  const warnings: string[] = [];

  const langRes = resolveSteamLanguage(input.language, deps.config.language);
  if (input.include_metadata && langRes.warning) {
    warnings.push(langRes.warning);
  }
  const requestedLanguage = input.include_metadata ? langRes.steamLanguage : null;

  const wishlistRes = await deps.library.getWishlist(scope);

  if (!wishlistRes.ok) {
    return {
      ok: false,
      error: {
        list: 'wishlist',
        data_status: wishlistRes.dataStatus,
        error_code: wishlistRes.errorCode,
        message: wishlistRes.message,
        fetched_at: wishlistRes.fetchedAt,
      },
    };
  }

  const page = paginateList(wishlistRes.data.items, input.offset, input.limit);

  if (!input.include_metadata) {
    const games: WishlistGameItem[] = page.items.map((item) => ({
      appid: item.appid,
      name: null,
      requested_language: null,
      app_type: 'unknown',
      store_url: buildStoreUrl(item.appid),
      priority: item.priority,
      date_added: item.dateAdded,
    }));

    const output = ListWishlistGamesOutputSchema.parse({
      list: 'wishlist',
      total: page.total,
      returned: page.returned,
      offset: page.offset,
      limit: page.limit,
      has_more: page.hasMore,
      fetched_at: wishlistRes.fetchedAt,
      data_status: 'ok',
      metadata_status: 'skipped',
      requested_language: null,
      ...(warnings.length > 0 ? { warnings } : {}),
      games,
    });
    return { ok: true, output };
  }

  const pageAppIds = page.items.map((item) => item.appid);
  const metaRes = await deps.metadata.fetchMetadata(scope, pageAppIds, langRes.steamLanguage);
  warnings.push(...metaRes.warnings);

  const games: WishlistGameItem[] = page.items.map((item) => {
    const meta = metaRes.itemsByAppId.get(item.appid);
    return {
      appid: item.appid,
      name: meta?.found ? meta.name : null,
      requested_language: requestedLanguage,
      app_type: meta?.found ? meta.appType : 'unknown',
      store_url: buildStoreUrl(item.appid),
      priority: item.priority,
      date_added: item.dateAdded,
    };
  });

  const output = ListWishlistGamesOutputSchema.parse({
    list: 'wishlist',
    total: page.total,
    returned: page.returned,
    offset: page.offset,
    limit: page.limit,
    has_more: page.hasMore,
    fetched_at: wishlistRes.fetchedAt,
    data_status: 'ok',
    metadata_status: metaRes.metadataStatus,
    requested_language: requestedLanguage,
    ...(warnings.length > 0 ? { warnings } : {}),
    games,
  });

  return { ok: true, output };
}
