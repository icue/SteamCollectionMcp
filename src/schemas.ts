import { z } from 'zod';
import { UINT32_MAX } from './utils/identity.js';

// --- Shared Enums ---

export const DataStatusSchema = z.enum(['ok', 'unavailable', 'rate_limited', 'error']);
export type DataStatus = z.infer<typeof DataStatusSchema>;

export const MetadataStatusSchema = z.enum(['complete', 'partial', 'unavailable', 'skipped']);
export type MetadataStatus = z.infer<typeof MetadataStatusSchema>;

export const ErrorCodeSchema = z.enum([
  'invalid_api_key',
  'access_denied',
  'rate_limited',
  'timeout',
  'invalid_response',
  'upstream_error',
  'request_budget_exceeded',
  'invalid_query',
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const AppTypeSchema = z.enum([
  'game',
  'demo',
  'mod',
  'movie',
  'dlc',
  'guide',
  'software',
  'video',
  'series',
  'episode',
  'hardware',
  'music',
  'beta',
  'tool',
  'advertising',
  'unknown',
]);
export type AppType = z.infer<typeof AppTypeSchema>;

export const ResolutionStatusSchema = z.enum(['resolved', 'ambiguous', 'not_found', 'error']);
export type ResolutionStatus = z.infer<typeof ResolutionStatusSchema>;

export const IdentitySourceSchema = z.enum([
  'provided_appid',
  'store_search',
  'alternative_name_search',
  'personal_library_fallback',
  'personal_wishlist_fallback',
]);
export type IdentitySource = z.infer<typeof IdentitySourceSchema>;

export const MatchSourceSchema = z.enum([
  'provided_appid',
  'original_query_search',
  'default_language_search',
  'alternative_name_search',
  'owned_library_fallback',
  'wishlist_fallback',
]);
export type MatchSource = z.infer<typeof MatchSourceSchema>;

export const PositiveUint32Schema = z.number().int().min(1).max(UINT32_MAX);

// --- Upstream Steam API Response Schemas ---

export const UpstreamOwnedGameItemSchema = z
  .object({
    appid: PositiveUint32Schema,
    name: z.string().optional(),
    playtime_forever: z.number().int().min(0).optional(),
  })
  .passthrough();

export const UpstreamGetOwnedGamesResponseSchema = z.object({
  response: z
    .object({
      game_count: z.number().int().min(0),
      games: z.array(UpstreamOwnedGameItemSchema).optional(),
    })
    .passthrough(),
});

export const UpstreamWishlistItemSchema = z
  .object({
    appid: PositiveUint32Schema,
    priority: z.number().int().min(0).optional(),
    date_added: z.number().int().min(0).optional(),
  })
  .passthrough();

export const UpstreamGetWishlistResponseSchema = z.object({
  response: z
    .object({
      items: z.array(UpstreamWishlistItemSchema),
    })
    .passthrough(),
});

export const UpstreamStoreSearchItemSchema = z
  .object({
    id: z.number().int().optional(),
    type: z.string().optional(),
    name: z.string().optional(),
  })
  .passthrough();

export const UpstreamStoreSearchResponseSchema = z
  .object({
    total: z.number().int().min(0),
    items: z.array(UpstreamStoreSearchItemSchema),
  })
  .passthrough();

export const UpstreamStoreBrowseItemSchema = z
  .object({
    id: z.number().int().min(0).optional(),
    appid: z.number().int().min(0).optional(),
    item_type: z.number().int().optional(),
    type: z.number().int().optional(),
    success: z.number().int().optional(),
    visible: z.boolean().optional(),
    unlisted: z.boolean().optional(),
    name: z.string().optional(),
  })
  .passthrough();

export const UpstreamGetItemsResponseSchema = z.object({
  response: z
    .object({
      store_items: z.array(UpstreamStoreBrowseItemSchema),
    })
    .passthrough(),
});

// --- MCP Tool Input Schemas ---

export const GameQuerySchema = z.object({
  query: z
    .string()
    .min(1)
    .superRefine((value, ctx) => {
      if (value.length === 0) {
        return;
      }
      const trimmedLength = value.trim().length;
      if (trimmedLength < 1) {
        ctx.addIssue({
          code: 'too_small',
          origin: 'string',
          minimum: 1,
          inclusive: true,
          message: 'Query must contain at least 1 non-whitespace character.',
        });
      } else if (trimmedLength > 300) {
        ctx.addIssue({
          code: 'too_big',
          origin: 'string',
          maximum: 300,
          inclusive: true,
          message: 'Query must be at most 300 characters after trimming surrounding whitespace.',
        });
      }
    })
    .describe(
      'Game title in any Unicode language, positive decimal Steam AppID (e.g. "292030"), or Steam Store app URL (https://store.steampowered.com/app/<appid>/).',
    ),
  language: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .optional()
    .describe(
      'Optional BCP 47 tag (e.g. "zh-CN", "ja", "pl", "pt-BR") or Steam API language code (e.g. "schinese", "japanese", "polish"). Defaults to STEAM_LANGUAGE.',
    ),
  alternative_names: z
    .array(z.string().trim().min(1).max(300))
    .max(10)
    .optional()
    .describe(
      'Optional caller-provided alternative, localized, or English titles to assist resolution when the query uses an unsupported language, unofficial translation, or alias.',
    ),
});
export type GameQuery = z.infer<typeof GameQuerySchema>;

export const ListGamesInputSchema = z.object({
  offset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe('Zero-based offset into the live sorted full list. Default: 0.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(500)
    .default(100)
    .describe('Page size (1 to 500). Default: 100.'),
  language: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .optional()
    .describe(
      'Optional BCP 47 tag or Steam API language code for localized game names. Defaults to STEAM_LANGUAGE.',
    ),
  include_metadata: z
    .boolean()
    .default(true)
    .describe(
      'When true (default), enriches only the current page via GetItems in the requested language. When false, skips GetItems and returns list-native fields only.',
    ),
});
export type ListGamesInput = z.infer<typeof ListGamesInputSchema>;

export const GetGamesStatusInputSchema = z.object({
  queries: z
    .array(GameQuerySchema)
    .min(1)
    .max(50)
    .describe(
      'Batch of 1 to 50 game queries. Prefer this tool over repeated get_game_status calls so owned library and wishlist are fetched only once per batch.',
    ),
});
export type GetGamesStatusInput = z.infer<typeof GetGamesStatusInputSchema>;

// --- MCP Tool Output Schemas ---

export const OwnedGameItemSchema = z.object({
  appid: PositiveUint32Schema,
  name: z.string().nullable(),
  requested_language: z.string().nullable(),
  app_type: AppTypeSchema,
  store_url: z.string(),
  playtime_forever: z.number().int().min(0).nullable(),
});
export type OwnedGameItem = z.infer<typeof OwnedGameItemSchema>;

export const WishlistGameItemSchema = z.object({
  appid: PositiveUint32Schema,
  name: z.string().nullable(),
  requested_language: z.string().nullable(),
  app_type: AppTypeSchema,
  store_url: z.string(),
  priority: z.number().int().min(0).nullable(),
  date_added: z.number().int().min(0).nullable(),
});
export type WishlistGameItem = z.infer<typeof WishlistGameItemSchema>;

export const ListOwnedGamesOutputSchema = z.object({
  list: z.literal('owned'),
  total: z.number().int().min(0),
  returned: z.number().int().min(0),
  offset: z.number().int().min(0),
  limit: z.number().int().min(1).max(500),
  has_more: z.boolean(),
  fetched_at: z.string(),
  data_status: DataStatusSchema,
  metadata_status: MetadataStatusSchema,
  requested_language: z.string().nullable(),
  warnings: z.array(z.string()).optional(),
  games: z.array(OwnedGameItemSchema),
});
export type ListOwnedGamesOutput = z.infer<typeof ListOwnedGamesOutputSchema>;

export const ListWishlistGamesOutputSchema = z.object({
  list: z.literal('wishlist'),
  total: z.number().int().min(0),
  returned: z.number().int().min(0),
  offset: z.number().int().min(0),
  limit: z.number().int().min(1).max(500),
  has_more: z.boolean(),
  fetched_at: z.string(),
  data_status: DataStatusSchema,
  metadata_status: MetadataStatusSchema,
  requested_language: z.string().nullable(),
  warnings: z.array(z.string()).optional(),
  games: z.array(WishlistGameItemSchema),
});
export type ListWishlistGamesOutput = z.infer<typeof ListWishlistGamesOutputSchema>;

export const ResolvedCandidateSchema = z.object({
  appid: PositiveUint32Schema,
  name: z.string().nullable(),
  app_type: AppTypeSchema,
  requested_language: z.string().nullable(),
  match_source: MatchSourceSchema,
  store_url: z.string(),
});
export type ResolvedCandidate = z.infer<typeof ResolvedCandidateSchema>;

export const StatusCandidateSchema = ResolvedCandidateSchema.extend({
  owned: z.boolean().nullable(),
  wishlisted: z.boolean().nullable(),
});
export type StatusCandidate = z.infer<typeof StatusCandidateSchema>;

export const ResolveGameOutputSchema = z.object({
  query: z.string(),
  resolution: ResolutionStatusSchema,
  appid: PositiveUint32Schema.nullable(),
  name: z.string().nullable(),
  app_type: AppTypeSchema.nullable(),
  requested_language: z.string().nullable(),
  identity_source: IdentitySourceSchema.nullable(),
  store_url: z.string().nullable(),
  metadata_status: MetadataStatusSchema,
  candidates: z.array(ResolvedCandidateSchema),
  search_complete: z.boolean(),
  error_code: ErrorCodeSchema.nullable().optional(),
  warnings: z.array(z.string()).optional(),
});
export type ResolveGameOutput = z.infer<typeof ResolveGameOutputSchema>;

export const GameStatusOutputSchema = z.object({
  query: z.string(),
  resolution: ResolutionStatusSchema,
  appid: PositiveUint32Schema.nullable(),
  identity_source: IdentitySourceSchema.nullable(),
  name: z.string().nullable(),
  app_type: AppTypeSchema.nullable(),
  requested_language: z.string().nullable(),
  metadata_status: MetadataStatusSchema,
  owned: z.boolean().nullable(),
  wishlisted: z.boolean().nullable(),
  owned_data_status: DataStatusSchema.nullable(),
  owned_error_code: ErrorCodeSchema.nullable(),
  owned_fetched_at: z.string().nullable(),
  wishlist_data_status: DataStatusSchema.nullable(),
  wishlist_error_code: ErrorCodeSchema.nullable(),
  wishlist_fetched_at: z.string().nullable(),
  store_url: z.string().nullable(),
  fetched_at: z.string(),
  search_complete: z.boolean(),
  error_code: ErrorCodeSchema.nullable().optional(),
  candidates: z.array(StatusCandidateSchema),
  warnings: z.array(z.string()).optional(),
});
export type GameStatusOutput = z.infer<typeof GameStatusOutputSchema>;

export const BatchGameStatusItemSchema = z.object({
  query: z.string(),
  resolution: ResolutionStatusSchema,
  appid: PositiveUint32Schema.nullable(),
  identity_source: IdentitySourceSchema.nullable(),
  name: z.string().nullable(),
  app_type: AppTypeSchema.nullable(),
  requested_language: z.string().nullable(),
  metadata_status: MetadataStatusSchema,
  owned: z.boolean().nullable(),
  wishlisted: z.boolean().nullable(),
  store_url: z.string().nullable(),
  search_complete: z.boolean(),
  error_code: ErrorCodeSchema.nullable().optional(),
  candidates: z.array(StatusCandidateSchema),
  warnings: z.array(z.string()).optional(),
});
export type BatchGameStatusItem = z.infer<typeof BatchGameStatusItemSchema>;

export const GetGamesStatusOutputSchema = z.object({
  total: z.number().int().min(1).max(50),
  owned_data_status: DataStatusSchema.nullable(),
  owned_error_code: ErrorCodeSchema.nullable(),
  owned_fetched_at: z.string().nullable(),
  wishlist_data_status: DataStatusSchema.nullable(),
  wishlist_error_code: ErrorCodeSchema.nullable(),
  wishlist_fetched_at: z.string().nullable(),
  fetched_at: z.string(),
  results: z.array(BatchGameStatusItemSchema),
  warnings: z.array(z.string()).optional(),
});
export type GetGamesStatusOutput = z.infer<typeof GetGamesStatusOutputSchema>;
