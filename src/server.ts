import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import type { ServerConfig } from './config.js';
import {
  sanitizeSecretText,
  SteamHttpClient,
  type FetchFn,
} from './clients/http.js';
import { SteamApiClient } from './clients/steam.js';
import {
  GameQuerySchema,
  GameStatusOutputSchema,
  GetGamesStatusInputSchema,
  GetGamesStatusOutputSchema,
  ListGamesInputSchema,
  ListOwnedGamesInputSchema,
  ListOwnedGamesOutputSchema,
  ListWishlistGamesOutputSchema,
  ResolveGameOutputSchema,
} from './schemas.js';
import { LibraryService } from './services/library.js';
import { MetadataService } from './services/metadata.js';
import { GameResolverService, type ResolverBudgetOptions } from './services/resolver.js';
import { handleListOwnedGames, handleListWishlistGames } from './tools/lists.js';
import { handleResolveGame } from './tools/resolve.js';
import { handleGetGameStatus, handleGetGamesStatus } from './tools/status.js';
import { PACKAGE_VERSION } from './version.js';

export const SERVER_NAME = 'steam-collection';
export const SERVER_VERSION = PACKAGE_VERSION;

export interface ServerDependenciesOverrides {
  readonly fetchFn?: FetchFn;
  readonly now?: () => number;
  readonly random?: () => number;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly maxRetries?: number;
  readonly baseRetryDelayMs?: number;
  readonly resolverBudgets?: ResolverBudgetOptions;
}

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

function redactExactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret) continue;
    out = out.split(secret).join('[REDACTED]');
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) {
      out = out.split(encoded).join('[REDACTED]');
    }
  }
  return out;
}

function buildSuccessResult<T extends Record<string, unknown>>(payload: T): CallToolResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload),
      },
    ],
    structuredContent: payload,
  };
}

function buildStructuredErrorResult<T extends Record<string, unknown>>(
  payload: T,
  secrets: readonly string[],
): CallToolResult {
  const safeJson = redactExactSecrets(JSON.stringify(payload), secrets);
  const safePayload = JSON.parse(safeJson) as Record<string, unknown>;
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: safeJson,
      },
    ],
    structuredContent: safePayload,
  };
}

function buildErrorResult(payload: Record<string, unknown>, secrets: readonly string[]): CallToolResult {
  const safeJson = sanitizeSecretText(JSON.stringify(payload), secrets);
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: safeJson,
      },
    ],
  };
}

function buildUnexpectedErrorResult(err: unknown, secrets: readonly string[], now: () => number): CallToolResult {
  const rawMessage = err instanceof Error ? err.message : 'Unexpected server error.';
  return buildErrorResult(
    {
      data_status: 'error',
      error_code: 'upstream_error',
      message: sanitizeSecretText(rawMessage, secrets),
      fetched_at: new Date(now()).toISOString(),
    },
    secrets,
  );
}

function isStatusItemTotalFailure(
  item: { resolution: string; owned: boolean | null; wishlisted: boolean | null },
  bothCollectionSourcesFailed: boolean,
): boolean {
  return (
    item.resolution === 'error' ||
    (item.resolution === 'resolved' &&
      bothCollectionSourcesFailed &&
      item.owned === null &&
      item.wishlisted === null)
  );
}

/**
 * Creates a stateless, read-only Steam Collection MCP server registering ONLY the 5 specified tools.
 */
export function createSteamCollectionServer(
  config: ServerConfig,
  overrides?: ServerDependenciesOverrides,
): McpServer {
  const secrets = [config.steamApiKey];
  const now = overrides?.now ?? (() => Date.now());

  const http = new SteamHttpClient({
    httpTimeoutMs: config.httpTimeoutMs,
    maxConcurrency: config.maxConcurrency,
    secrets,
    maxRetries: overrides?.maxRetries,
    baseRetryDelayMs: overrides?.baseRetryDelayMs,
    fetchFn: overrides?.fetchFn,
    now,
    random: overrides?.random,
    sleep: overrides?.sleep,
  });

  const steam = new SteamApiClient(http, config);
  const library = new LibraryService(steam, config, now);
  const metadata = new MetadataService(steam, config, now);
  const resolver = new GameResolverService(
    steam,
    library,
    metadata,
    config,
    overrides?.resolverBudgets,
  );

  const server = new McpServer(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.registerTool(
    'list_owned_games',
    {
      title: 'List Owned Steam Games',
      description:
        'Fetches the configured Steam account owned games live from Steam (no cross-call cache), deduplicates and sorts the full library (sort_by="appid" ascending by default; "last_played" by last-played time newest to oldest—not total playtime or completion time; "playtime_asc" or "playtime_desc" by cumulative playtime_forever in minutes shortest to longest or longest to shortest, where 0 is valid; missing sort values are placed last in all modes with AppID ascending tie-break), and returns one local page (default offset=0, limit=100, max 500). Enriches only the current page via GetItems when include_metadata=true; set include_metadata=false to skip GetItems. Note: cross-page calls refresh live data with no snapshot guarantee; deduplicate by appid if paginating. For checking specific games, prefer get_games_status (batch) or get_game_status.',
      inputSchema: ListOwnedGamesInputSchema,
      outputSchema: ListOwnedGamesOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args, ctx) => {
      try {
        const result = await handleListOwnedGames({ config, library, metadata }, args, ctx.mcpReq.signal);
        if (!result.ok) {
          return buildErrorResult(result.error as unknown as Record<string, unknown>, secrets);
        }
        return buildSuccessResult(result.output);
      } catch (err) {
        return buildUnexpectedErrorResult(err, secrets, now);
      }
    },
  );

  server.registerTool(
    'list_wishlist_games',
    {
      title: 'List Steam Wishlist Games',
      description:
        'Fetches the configured Steam account public wishlist live from Steam (no cross-call cache), deduplicates and sorts by priority ascending (missing priority last, then AppID ascending), and returns one local page (default offset=0, limit=100, max 500). Enriches only the current page via GetItems when include_metadata=true; set include_metadata=false to skip GetItems. Note: cross-page calls refresh live data with no snapshot guarantee. For checking specific games, prefer get_games_status (batch) or get_game_status.',
      inputSchema: ListGamesInputSchema,
      outputSchema: ListWishlistGamesOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args, ctx) => {
      try {
        const result = await handleListWishlistGames(
          { config, library, metadata },
          args,
          ctx.mcpReq.signal,
        );
        if (!result.ok) {
          return buildErrorResult(result.error as unknown as Record<string, unknown>, secrets);
        }
        return buildSuccessResult(result.output);
      } catch (err) {
        return buildUnexpectedErrorResult(err, secrets, now);
      }
    },
  );

  server.registerTool(
    'resolve_game',
    {
      title: 'Resolve Steam Game Identity',
      description:
        'Resolves a game title (in any Unicode language), positive uint32 AppID, or Steam Store /app/<appid>/ URL to a Steam AppID without asserting collection membership. Only returns resolution="resolved" on a direct AppID/URL or a unique, verified exact title match. On ambiguity, unsupported Steam languages, unofficial translations, or edition/remake conflicts, supply alternative_names, edition/version details, or the exact Steam AppID. To check ownership/wishlist status for multiple games, prefer get_games_status.',
      inputSchema: GameQuerySchema,
      outputSchema: ResolveGameOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args, ctx) => {
      try {
        const output = await handleResolveGame({ library, resolver }, args, ctx.mcpReq.signal);
        if (output.resolution === 'error') {
          return buildStructuredErrorResult(output, secrets);
        }
        return buildSuccessResult(output);
      } catch (err) {
        return buildUnexpectedErrorResult(err, secrets, now);
      }
    },
  );

  server.registerTool(
    'get_game_status',
    {
      title: 'Get Single Game Collection Status',
      description:
        'Resolves a single game (by multilingual title, AppID, or Steam Store /app/<appid>/ URL) and checks live ownership and wishlist membership independently (boolean | null; null when unresolved or when a data source is unavailable). Prefer get_games_status when checking multiple games so the library and wishlist are fetched only once. When a title is ambiguous or uses an unsupported language, provide alternative_names, edition/version details, or the AppID.',
      inputSchema: GameQuerySchema,
      outputSchema: GameStatusOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args, ctx) => {
      try {
        const output = await handleGetGameStatus(
          { config, library, metadata, resolver, now },
          args,
          ctx.mcpReq.signal,
        );
        const ownedFailed = output.owned_data_status !== null && output.owned_data_status !== 'ok';
        const wishlistFailed =
          output.wishlist_data_status !== null && output.wishlist_data_status !== 'ok';
        if (isStatusItemTotalFailure(output, ownedFailed && wishlistFailed)) {
          return buildStructuredErrorResult(output, secrets);
        }
        return buildSuccessResult(output);
      } catch (err) {
        return buildUnexpectedErrorResult(err, secrets, now);
      }
    },
  );

  server.registerTool(
    'get_games_status',
    {
      title: 'Batch Get Games Collection Status',
      description:
        'Preferred tool for checking 1 to 50 games at once. Resolves each query (multilingual title, AppID, or Steam Store /app/<appid>/ URL), deduplicates work while preserving input order and original queries, and fetches the owned library and wishlist live at most once each per batch. Supports partial success when individual resolutions or one upstream source fail. On ambiguity or unsupported languages, supply alternative_names, edition/version details, or an AppID.',
      inputSchema: GetGamesStatusInputSchema,
      outputSchema: GetGamesStatusOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args, ctx) => {
      try {
        const output = await handleGetGamesStatus(
          { config, library, metadata, resolver, now },
          args,
          ctx.mcpReq.signal,
        );
        const ownedFailed = output.owned_data_status !== null && output.owned_data_status !== 'ok';
        const wishlistFailed =
          output.wishlist_data_status !== null && output.wishlist_data_status !== 'ok';
        const bothCollectionSourcesFailed = ownedFailed && wishlistFailed;
        const allItemsFailed =
          output.results.length > 0 &&
          output.results.every((item) => isStatusItemTotalFailure(item, bothCollectionSourcesFailed));
        if (allItemsFailed) {
          return buildStructuredErrorResult(output, secrets);
        }
        return buildSuccessResult(output);
      } catch (err) {
        return buildUnexpectedErrorResult(err, secrets, now);
      }
    },
  );

  return server;
}
