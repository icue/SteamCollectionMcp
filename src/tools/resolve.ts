import { ResolveGameOutputSchema, type GameQuery, type ResolveGameOutput } from '../schemas.js';
import type { LibraryService } from '../services/library.js';
import type { GameResolverService } from '../services/resolver.js';

export interface ResolveToolDeps {
  readonly library: LibraryService;
  readonly resolver: GameResolverService;
}

export async function handleResolveGame(
  deps: ResolveToolDeps,
  input: GameQuery,
  signal?: AbortSignal,
): Promise<ResolveGameOutput> {
  const scope = deps.library.createScope(signal);
  const outcome = await deps.resolver.resolve(scope, input);

  return ResolveGameOutputSchema.parse({
    query: outcome.query,
    resolution: outcome.resolution,
    appid: outcome.appid,
    name: outcome.name,
    app_type: outcome.appType,
    requested_language: outcome.requestedLanguage,
    identity_source: outcome.identitySource,
    store_url: outcome.storeUrl,
    metadata_status: outcome.metadataStatus,
    candidates: outcome.candidates,
    search_complete: outcome.searchComplete,
    ...(outcome.errorCode !== null ? { error_code: outcome.errorCode } : {}),
    ...(outcome.warnings.length > 0 ? { warnings: outcome.warnings } : {}),
  });
}
