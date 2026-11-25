import type { ServerConfig } from '../config.js';
import { SteamClientError } from '../clients/http.js';
import type { SteamApiClient, StoreItemMetadata } from '../clients/steam.js';
import type {
  AppType,
  ErrorCode,
  GameQuery,
  IdentitySource,
  MatchSource,
  MetadataStatus,
  ResolutionStatus,
  ResolvedCandidate,
} from '../schemas.js';
import {
  buildStoreUrl,
  isEditionVariantOf,
  isExactComparableMatch,
  normalizeComparable,
  normalizeStrict,
  parseDirectIdentifier,
  scoreCandidateForRanking,
} from '../utils/identity.js';
import { resolveSteamLanguage, type SteamLanguage } from '../utils/languages.js';
import type {
  LibraryService,
  NormalWorkLease,
  OwnedListData,
  SourceFetchResult,
  ToolCallScope,
  WishlistListData,
} from './library.js';
import type { MetadataFetchResult, MetadataService } from './metadata.js';

export interface ResolverBudgetOptions {
  readonly maxVerificationCandidates?: number;
  readonly maxReturnedCandidates?: number;
  readonly maxFallbackMetadataBatches?: number;
}

export interface ResolveOptions {
  /**
   * When true, skips per-item GetItems on direct AppIDs so status tools can
   * schedule collection lookups first and batch optional display metadata afterwards.
   */
  readonly deferDirectAppIdMetadata?: boolean;
  /**
   * Optional Stage A normal-priority lease passed through to normal candidate-verification
   * metadata calls so tasks purely waiting on shared in-flight metadata release slot demand.
   */
  readonly normalLease?: NormalWorkLease;
}

export interface PersonalFallbackOptions {
  /**
   * Optional Stage A lease handed off briefly across an already-settled collection lookup
   * until this fallback's first GetItems chunks are queued on scope.lowPriorityGate.
   */
  readonly handoffLease?: NormalWorkLease;
}

export interface ResolutionOutcome {
  readonly query: string;
  readonly resolution: ResolutionStatus;
  readonly appid: number | null;
  readonly name: string | null;
  readonly appType: AppType | null;
  readonly requestedLanguage: SteamLanguage | null;
  readonly identitySource: IdentitySource | null;
  readonly storeUrl: string | null;
  readonly metadataStatus: MetadataStatus;
  readonly candidates: ResolvedCandidate[];
  readonly searchComplete: boolean;
  readonly errorCode: ErrorCode | null;
  readonly warnings: string[];
}

export interface PendingPersonalFallback {
  readonly originalQuery: string;
  readonly originalTerm: string;
  readonly altNames: readonly string[];
  readonly requestedLanguage: SteamLanguage;
  readonly initialSearchComplete: boolean;
  readonly initialHadStoreSearchError: boolean;
  readonly initialStoreErrorCode: ErrorCode | null;
  readonly warnings: string[];
}

export type StorePhaseResult =
  | {
      readonly kind: 'done';
      readonly outcome: ResolutionOutcome;
    }
  | {
      readonly kind: 'needs_personal_fallback';
      readonly pending: PendingPersonalFallback;
    };

interface CandidateEvidence {
  readonly appid: number;
  readonly names: Set<string>;
  readonly namesByLang: Map<string, string>;
  readonly matchSources: Set<MatchSource>;
  readonly fromOriginalSearch: boolean;
  readonly fromAlternativeSearch: boolean;
  readonly fromOwnedFallback: boolean;
  readonly fromWishlistFallback: boolean;
  primaryMatchSource: MatchSource;
  appType: AppType;
  verifiedName: string | null;
  verifiedRequestedLang: SteamLanguage | null;
}

const DEFAULT_MAX_VERIFICATION_CANDIDATES = 15;
const DEFAULT_MAX_RETURNED_CANDIDATES = 10;
const DEFAULT_MAX_FALLBACK_METADATA_BATCHES = 4;

const NON_BASE_GAME_TYPES = new Set<AppType>([
  'dlc',
  'demo',
  'music',
  'video',
  'movie',
  'series',
  'episode',
  'guide',
  'tool',
  'hardware',
  'advertising',
]);

function isGameOrUnknownType(appType: AppType): boolean {
  return appType === 'game' || appType === 'unknown' || !NON_BASE_GAME_TYPES.has(appType);
}

function addCandidateEvidence(
  pool: Map<number, CandidateEvidence>,
  params: {
    appid: number;
    name: string | null;
    language: SteamLanguage | null;
    matchSource: MatchSource;
    fromOriginalSearch?: boolean;
    fromAlternativeSearch?: boolean;
    fromOwnedFallback?: boolean;
    fromWishlistFallback?: boolean;
    appType?: AppType;
  },
): CandidateEvidence {
  let existing = pool.get(params.appid);
  if (!existing) {
    existing = {
      appid: params.appid,
      names: new Set<string>(),
      namesByLang: new Map<string, string>(),
      matchSources: new Set<MatchSource>([params.matchSource]),
      fromOriginalSearch: params.fromOriginalSearch ?? false,
      fromAlternativeSearch: params.fromAlternativeSearch ?? false,
      fromOwnedFallback: params.fromOwnedFallback ?? false,
      fromWishlistFallback: params.fromWishlistFallback ?? false,
      primaryMatchSource: params.matchSource,
      appType: params.appType ?? 'unknown',
      verifiedName: null,
      verifiedRequestedLang: null,
    };
    pool.set(params.appid, existing);
  } else {
    existing.matchSources.add(params.matchSource);
    if (params.fromOriginalSearch) {
      (existing as { fromOriginalSearch: boolean }).fromOriginalSearch = true;
      if (
        existing.primaryMatchSource === 'alternative_name_search' ||
        existing.primaryMatchSource === 'default_language_search'
      ) {
        existing.primaryMatchSource = params.matchSource;
      }
    }
    if (params.fromAlternativeSearch) {
      (existing as { fromAlternativeSearch: boolean }).fromAlternativeSearch = true;
    }
    if (params.fromOwnedFallback) {
      (existing as { fromOwnedFallback: boolean }).fromOwnedFallback = true;
      if (existing.primaryMatchSource === 'wishlist_fallback') {
        existing.primaryMatchSource = 'owned_library_fallback';
      }
    }
    if (params.fromWishlistFallback) {
      (existing as { fromWishlistFallback: boolean }).fromWishlistFallback = true;
    }
    if (params.appType && params.appType !== 'unknown' && existing.appType === 'unknown') {
      existing.appType = params.appType;
    }
  }

  if (params.name && params.name.trim().length > 0) {
    existing.names.add(params.name);
    if (params.language) {
      if (!existing.namesByLang.has(params.language)) {
        existing.namesByLang.set(params.language, params.name);
      }
    }
  }

  return existing;
}

function getBestDisplayName(candidate: CandidateEvidence, requestedLanguage: SteamLanguage): string | null {
  if (candidate.verifiedName) {
    return candidate.verifiedName;
  }
  const byRequested = candidate.namesByLang.get(requestedLanguage);
  if (byRequested) {
    return byRequested;
  }
  for (const name of candidate.names) {
    return name;
  }
  return null;
}

function candidateMatchesTermExact(candidate: CandidateEvidence, term: string): boolean {
  if (candidate.verifiedName && isExactComparableMatch(term, candidate.verifiedName)) {
    return true;
  }
  for (const name of candidate.names) {
    if (isExactComparableMatch(term, name)) {
      return true;
    }
  }
  return false;
}

function bestRankingScore(candidate: CandidateEvidence, terms: readonly string[]): number {
  let best = 0;
  const allNames: string[] = [];
  if (candidate.verifiedName) {
    allNames.push(candidate.verifiedName);
  }
  for (const n of candidate.names) {
    allNames.push(n);
  }
  for (const term of terms) {
    for (const name of allNames) {
      const score = scoreCandidateForRanking(term, name);
      if (score > best) {
        best = score;
      }
    }
  }
  return best;
}

function rankCandidates(
  candidates: readonly CandidateEvidence[],
  terms: readonly string[],
  requestedLanguage: SteamLanguage,
): CandidateEvidence[] {
  return [...candidates].sort((a, b) => {
    const scoreDiff = bestRankingScore(b, terms) - bestRankingScore(a, terms);
    if (scoreDiff !== 0) return scoreDiff;

    const aIsGame = a.appType === 'game' ? 1 : 0;
    const bIsGame = b.appType === 'game' ? 1 : 0;
    if (aIsGame !== bIsGame) return bIsGame - aIsGame;

    const aOrig = a.fromOriginalSearch ? 1 : 0;
    const bOrig = b.fromOriginalSearch ? 1 : 0;
    if (aOrig !== bOrig) return bOrig - aOrig;

    const nameA = getBestDisplayName(a, requestedLanguage) ?? '';
    const nameB = getBestDisplayName(b, requestedLanguage) ?? '';
    if (nameA.length !== nameB.length) return nameA.length - nameB.length;

    return a.appid - b.appid;
  });
}

function resolveEffectiveMatchSource(
  candidate: CandidateEvidence,
  originalTerm: string,
  altNames: readonly string[],
  isPersonalFallback: boolean,
): MatchSource {
  if (isPersonalFallback) {
    return candidate.primaryMatchSource;
  }
  if (!candidate.fromOriginalSearch && candidate.fromAlternativeSearch) {
    return 'alternative_name_search';
  }
  const exactOrig = candidateMatchesTermExact(candidate, originalTerm);
  const exactAlt =
    altNames.length > 0 && altNames.some((alt) => candidateMatchesTermExact(candidate, alt));
  if (!exactOrig && exactAlt) {
    return 'alternative_name_search';
  }
  if (exactOrig) {
    if (candidate.matchSources.has('original_query_search')) {
      return 'original_query_search';
    }
    if (candidate.matchSources.has('default_language_search')) {
      return 'default_language_search';
    }
  }
  return candidate.primaryMatchSource;
}

function toResolvedCandidate(
  candidate: CandidateEvidence,
  requestedLanguage: SteamLanguage,
  matchSourceOverride?: MatchSource,
): ResolvedCandidate {
  return {
    appid: candidate.appid,
    name: getBestDisplayName(candidate, requestedLanguage),
    app_type: candidate.appType,
    requested_language: candidate.verifiedRequestedLang ?? requestedLanguage,
    match_source: matchSourceOverride ?? candidate.primaryMatchSource,
    store_url: buildStoreUrl(candidate.appid),
  };
}

function isMetadataItemUsable(
  meta: StoreItemMetadata | undefined,
): meta is StoreItemMetadata & { readonly found: true; readonly name: string } {
  return Boolean(meta && meta.found && typeof meta.name === 'string' && meta.name.trim().length > 0);
}

interface MetadataEvidenceGaps {
  readonly skippedAppIds: Set<number>;
  readonly failedAppIds: Set<number>;
  readonly unusableAppIds: Set<number>;
}

/**
 * Classifies metadata availability gaps consistently across both StoreSearch
 * candidate verification and personal-list fallback: budget-skipped, HTTP/API
 * failed, or unusable (omitted, explicit success !== 1, or blank title).
 */
function collectMetadataEvidenceGaps(
  appIdsToCheck: Iterable<number>,
  metaRes: MetadataFetchResult,
  target?: MetadataEvidenceGaps,
): MetadataEvidenceGaps {
  const gaps: MetadataEvidenceGaps = target ?? {
    skippedAppIds: new Set<number>(),
    failedAppIds: new Set<number>(),
    unusableAppIds: new Set<number>(),
  };

  for (const appid of appIdsToCheck) {
    if (metaRes.skippedAppIds.has(appid)) {
      gaps.skippedAppIds.add(appid);
    } else if (metaRes.failedAppIds.has(appid)) {
      gaps.failedAppIds.add(appid);
    } else if (!isMetadataItemUsable(metaRes.itemsByAppId.get(appid))) {
      gaps.unusableAppIds.add(appid);
    }
  }

  return gaps;
}

function buildUnknownCompetitorCheck(params: {
  readonly gaps: MetadataEvidenceGaps;
  readonly failedErrorCode: ErrorCode | null;
  readonly context: 'store_verification' | 'personal_fallback';
}): (winnerAppId: number) => {
  hasUnknownCompetitors: boolean;
  errorCode: ErrorCode | null;
  reason: string | null;
} {
  const subject =
    params.context === 'personal_fallback'
      ? 'unchecked personal list items'
      : 'competing candidates';

  return (winnerAppId: number) => {
    for (const id of params.gaps.skippedAppIds) {
      if (id !== winnerAppId) {
        return {
          hasUnknownCompetitors: true,
          errorCode: 'request_budget_exceeded',
          reason:
            'Personal list fallback reached its metadata batch budget with unchecked personal list items remaining; cannot confirm unique single-game identity.',
        };
      }
    }
    for (const id of params.gaps.failedAppIds) {
      if (id !== winnerAppId) {
        return {
          hasUnknownCompetitors: true,
          errorCode: params.failedErrorCode ?? 'upstream_error',
          reason: `GetItems metadata verification failed for one or more ${subject}; cannot confirm unique single-game identity.`,
        };
      }
    }
    for (const id of params.gaps.unusableAppIds) {
      if (id !== winnerAppId) {
        return {
          hasUnknownCompetitors: true,
          errorCode: null,
          reason: `GetItems omitted or returned no usable title/metadata for one or more ${subject}; cannot confirm whether a competing item shares the title or is a variant.`,
        };
      }
    }
    return { hasUnknownCompetitors: false, errorCode: null, reason: null };
  };
}

export class GameResolverService {
  private readonly steam: SteamApiClient;
  private readonly library: LibraryService;
  private readonly metadata: MetadataService;
  private readonly config: ServerConfig;
  private readonly maxVerificationCandidates: number;
  private readonly maxReturnedCandidates: number;
  private readonly maxFallbackMetadataBatches: number;

  constructor(
    steam: SteamApiClient,
    library: LibraryService,
    metadata: MetadataService,
    config: ServerConfig,
    budgets?: ResolverBudgetOptions,
  ) {
    this.steam = steam;
    this.library = library;
    this.metadata = metadata;
    this.config = config;
    this.maxVerificationCandidates =
      budgets?.maxVerificationCandidates ?? DEFAULT_MAX_VERIFICATION_CANDIDATES;
    this.maxReturnedCandidates = budgets?.maxReturnedCandidates ?? DEFAULT_MAX_RETURNED_CANDIDATES;
    this.maxFallbackMetadataBatches =
      budgets?.maxFallbackMetadataBatches ?? DEFAULT_MAX_FALLBACK_METADATA_BATCHES;
  }

  async resolve(
    scope: ToolCallScope,
    input: GameQuery,
    options?: ResolveOptions,
  ): Promise<ResolutionOutcome> {
    const storePhase = await this.resolveStorePhase(scope, input, options);
    if (storePhase.kind === 'done') {
      return storePhase.outcome;
    }
    return this.completePersonalFallback(scope, storePhase.pending);
  }

  /**
   * Executes Steps 1–4 (direct identifier, normalization, StoreSearch, and GetItems candidate
   * verification). When StoreSearch yields zero candidates with at least one successful search,
   * returns a pending personal-list fallback descriptor so batch callers can keep running fast
   * store queries on idle workers while slow personal fallback shares bounded low-priority I/O.
   */
  async resolveStorePhase(
    scope: ToolCallScope,
    input: GameQuery,
    options?: ResolveOptions,
  ): Promise<StorePhaseResult> {
    const warnings: string[] = [];
    const langResolution = resolveSteamLanguage(input.language, this.config.language);
    if (langResolution.warning) {
      warnings.push(langResolution.warning);
    }
    const requestedLanguage = langResolution.steamLanguage;
    const defaultLanguage = this.config.language;

    // Step 1: Direct identifier check (positive uint32 AppID or trusted store /app/ URL)
    const direct = parseDirectIdentifier(input.query);
    if (direct.kind === 'rejected_url' || direct.kind === 'invalid_numeric_id') {
      warnings.push(direct.reason);
      return {
        kind: 'done',
        outcome: {
          query: input.query,
          resolution: 'error',
          appid: null,
          name: null,
          appType: null,
          requestedLanguage,
          identitySource: null,
          storeUrl: null,
          metadataStatus: 'skipped',
          candidates: [],
          searchComplete: true,
          errorCode: 'invalid_query',
          warnings,
        },
      };
    }

    if (direct.kind === 'appid') {
      const storeUrl = buildStoreUrl(direct.appid);

      if (options?.deferDirectAppIdMetadata) {
        return {
          kind: 'done',
          outcome: {
            query: input.query,
            resolution: 'resolved',
            appid: direct.appid,
            name: null,
            appType: 'unknown',
            requestedLanguage,
            identitySource: 'provided_appid',
            storeUrl,
            metadataStatus: 'skipped',
            candidates: [
              {
                appid: direct.appid,
                name: null,
                app_type: 'unknown',
                requested_language: requestedLanguage,
                match_source: 'provided_appid',
                store_url: storeUrl,
              },
            ],
            searchComplete: true,
            errorCode: null,
            warnings,
          },
        };
      }

      const metaRes = await this.metadata.fetchMetadata(scope, [direct.appid], requestedLanguage);
      const itemMeta = metaRes.itemsByAppId.get(direct.appid);
      warnings.push(...metaRes.warnings);

      if (!itemMeta?.found) {
        warnings.push(
          'Metadata was unavailable for the provided AppID; identity_source is provided_appid and does not assert that this AppID is an active Steam Store game.',
        );
      }

      const name = itemMeta?.found ? itemMeta.name : null;
      const appType: AppType = itemMeta?.found ? itemMeta.appType : 'unknown';

      return {
        kind: 'done',
        outcome: {
          query: input.query,
          resolution: 'resolved',
          appid: direct.appid,
          name,
          appType,
          requestedLanguage,
          identitySource: 'provided_appid',
          storeUrl,
          metadataStatus: metaRes.metadataStatus,
          candidates: [
            {
              appid: direct.appid,
              name,
              app_type: appType,
              requested_language: requestedLanguage,
              match_source: 'provided_appid',
              store_url: storeUrl,
            },
          ],
          searchComplete: true,
          errorCode: null,
          warnings,
        },
      };
    }

    // Step 2 & 3: Name normalization & StoreSearch
    const originalTerm = direct.original;
    const dedupedAltNames: string[] = [];
    const seenAltStrict = new Set<string>([normalizeStrict(originalTerm)]);
    for (const rawAlt of input.alternative_names ?? []) {
      const trimmedAlt = rawAlt.trim();
      if (!trimmedAlt) continue;
      const strictAlt = normalizeStrict(trimmedAlt);
      if (seenAltStrict.has(strictAlt)) continue;
      seenAltStrict.add(strictAlt);
      dedupedAltNames.push(trimmedAlt);
    }

    const pool = new Map<number, CandidateEvidence>();
    let searchComplete = true;
    let hadStoreSearchError = false;
    let storeSearchSuccessCount = 0;
    let firstStoreErrorCode: ErrorCode | null = null;

    const runStoreSearch = async (
      term: string,
      language: SteamLanguage,
      matchSource: MatchSource,
      flags: { fromOriginalSearch?: boolean; fromAlternativeSearch?: boolean },
    ): Promise<boolean> => {
      try {
        const res = await this.steam.storeSearch(scope.execCtx, {
          term,
          language,
          countryCode: this.config.country,
        });
        storeSearchSuccessCount++;
        if (res.total > res.rawItemCount) {
          searchComplete = false;
          warnings.push(
            `StoreSearch reported ${res.total} total results for "${term}" (${language}) but returned only ${res.rawItemCount} raw item(s); results are truncated so single-game identity cannot be confirmed.`,
          );
        }
        for (const item of res.items) {
          addCandidateEvidence(pool, {
            appid: item.appid,
            name: item.name,
            language,
            matchSource,
            ...flags,
          });
        }
        return true;
      } catch (err) {
        searchComplete = false;
        hadStoreSearchError = true;
        const clientErr =
          err instanceof SteamClientError
            ? err
            : new SteamClientError({
                dataStatus: 'error',
                errorCode: 'upstream_error',
                endpoint: 'StoreSearch',
                message: 'StoreSearch request failed.',
              });
        if (firstStoreErrorCode === null) {
          firstStoreErrorCode = clientErr.errorCode;
        }
        if (!warnings.includes(clientErr.message)) {
          warnings.push(clientErr.message);
        }
        return false;
      }
    };

    // 3a. Search original query with requested language
    await runStoreSearch(originalTerm, requestedLanguage, 'original_query_search', {
      fromOriginalSearch: true,
    });

    const hasOriginalExactInRequested = [...pool.values()].some((c) =>
      candidateMatchesTermExact(c, originalTerm),
    );

    // 3b. When requestedLanguage differs from defaultLanguage and no exact match yet, also search default language
    if (
      !scope.execCtx.signal?.aborted &&
      requestedLanguage !== defaultLanguage &&
      !hasOriginalExactInRequested
    ) {
      await runStoreSearch(originalTerm, defaultLanguage, 'default_language_search', {
        fromOriginalSearch: true,
      });
    }

    // 3c. Search caller-provided alternative_names using default language
    for (const altName of dedupedAltNames) {
      if (scope.execCtx.signal?.aborted) {
        searchComplete = false;
        hadStoreSearchError = true;
        firstStoreErrorCode = firstStoreErrorCode ?? 'timeout';
        break;
      }
      await runStoreSearch(altName, defaultLanguage, 'alternative_name_search', {
        fromAlternativeSearch: true,
      });
    }

    // If every StoreSearch attempt failed and yielded zero candidates, return error
    if (pool.size === 0 && storeSearchSuccessCount === 0) {
      return {
        kind: 'done',
        outcome: {
          query: input.query,
          resolution: 'error',
          appid: null,
          name: null,
          appType: null,
          requestedLanguage,
          identitySource: null,
          storeUrl: null,
          metadataStatus: 'skipped',
          candidates: [],
          searchComplete: false,
          errorCode: firstStoreErrorCode ?? 'upstream_error',
          warnings,
        },
      };
    }

    const allTerms = [originalTerm, ...dedupedAltNames];

    // Step 4: Candidate verification via GetItems when StoreSearch returned candidates
    if (pool.size > 0) {
      const preRanked = rankCandidates([...pool.values()], allTerms, requestedLanguage);
      const truncatedCount = Math.max(0, preRanked.length - this.maxVerificationCandidates);
      const toVerify = preRanked.slice(0, this.maxVerificationCandidates);
      let incompleteErrorCode: ErrorCode | null = firstStoreErrorCode;

      if (truncatedCount > 0) {
        searchComplete = false;
        incompleteErrorCode = incompleteErrorCode ?? 'request_budget_exceeded';
        warnings.push(
          `Store search returned ${preRanked.length} candidates; only the top ${this.maxVerificationCandidates} were verified within candidate budget (${truncatedCount} unverified), so single-game identity cannot be confirmed.`,
        );
      }

      const verifyAppIds = toVerify.map((c) => c.appid);
      const metaRes = await this.metadata.fetchMetadata(scope, verifyAppIds, requestedLanguage, {
        normalLease: options?.normalLease,
      });
      warnings.push(...metaRes.warnings);
      this.applyMetadataToCandidates(pool, metaRes.itemsByAppId, requestedLanguage, true);

      const verifyGaps = collectMetadataEvidenceGaps(verifyAppIds, metaRes);
      let getItemsErrorCode: ErrorCode | null =
        metaRes.failedAppIds.size > 0 ? metaRes.errorCode : null;

      // If alternative_names were used and requestedLanguage !== defaultLanguage, also fetch defaultLanguage metadata
      // so alternative names can be verified against official default-language titles.
      if (dedupedAltNames.length > 0 && requestedLanguage !== defaultLanguage) {
        const defaultMetaRes = await this.metadata.fetchMetadata(
          scope,
          verifyAppIds,
          defaultLanguage,
          { normalLease: options?.normalLease },
        );
        warnings.push(...defaultMetaRes.warnings);
        this.applyMetadataToCandidates(pool, defaultMetaRes.itemsByAppId, defaultLanguage, false);
        collectMetadataEvidenceGaps(verifyAppIds, defaultMetaRes, verifyGaps);
        if (defaultMetaRes.failedAppIds.size > 0 && getItemsErrorCode === null) {
          getItemsErrorCode = defaultMetaRes.errorCode;
        }
      }

      const evaluated = this.evaluateCandidates({
        originalQuery: input.query,
        originalTerm,
        altNames: dedupedAltNames,
        candidates: toVerify,
        requestedLanguage,
        searchComplete,
        incompleteErrorCode,
        metadataStatus: metaRes.metadataStatus,
        warnings,
        isPersonalFallback: false,
        hasAnyFailedMetadata:
          verifyGaps.failedAppIds.size > 0 || verifyGaps.unusableAppIds.size > 0,
        failedMetadataErrorCode: getItemsErrorCode,
        checkUnknownCompetitorsForWinner: buildUnknownCompetitorCheck({
          gaps: verifyGaps,
          failedErrorCode: getItemsErrorCode,
          context: 'store_verification',
        }),
      });
      return { kind: 'done', outcome: evaluated };
    }

    // Step 5: Personal list fallback needed (StoreSearch returned 0 candidates)
    return {
      kind: 'needs_personal_fallback',
      pending: {
        originalQuery: input.query,
        originalTerm,
        altNames: dedupedAltNames,
        requestedLanguage,
        initialSearchComplete: searchComplete,
        initialHadStoreSearchError: hadStoreSearchError,
        initialStoreErrorCode: firstStoreErrorCode,
        warnings,
      },
    };
  }

  /**
   * Executes Step 5 (personal owned-library & wishlist fallback) using call-scoped
   * shared lists, call-scoped 4-batch metadata budget, and low-priority credit-scheduled GetItems.
   */
  async completePersonalFallback(
    scope: ToolCallScope,
    pending: PendingPersonalFallback,
    options?: PersonalFallbackOptions,
  ): Promise<ResolutionOutcome> {
    return this.resolveViaPersonalFallback({
      scope,
      handoffLease: options?.handoffLease,
      ...pending,
    });
  }

  private applyMetadataToCandidates(
    pool: Map<number, CandidateEvidence>,
    itemsByAppId: ReadonlyMap<number, StoreItemMetadata>,
    language: SteamLanguage,
    isPrimaryLanguage: boolean,
  ): void {
    for (const [appid, meta] of itemsByAppId.entries()) {
      const cand = pool.get(appid);
      if (!cand || !meta.found) {
        continue;
      }
      if (meta.appType !== 'unknown') {
        cand.appType = meta.appType;
      }
      if (meta.name) {
        cand.names.add(meta.name);
        cand.namesByLang.set(language, meta.name);
        if (isPrimaryLanguage) {
          cand.verifiedName = meta.name;
          cand.verifiedRequestedLang = language;
        }
      }
    }
  }

  private async resolveViaPersonalFallback(params: {
    scope: ToolCallScope;
    handoffLease?: NormalWorkLease;
    originalQuery: string;
    originalTerm: string;
    altNames: readonly string[];
    requestedLanguage: SteamLanguage;
    initialSearchComplete: boolean;
    initialHadStoreSearchError: boolean;
    initialStoreErrorCode: ErrorCode | null;
    warnings: string[];
  }): Promise<ResolutionOutcome> {
    const { scope, handoffLease, originalQuery, originalTerm, altNames, requestedLanguage, warnings } = params;
    let searchComplete = params.initialSearchComplete;
    let hasUpstreamFailure = params.initialHadStoreSearchError;
    let fallbackErrorCode: ErrorCode | null = params.initialStoreErrorCode;

    const pushWarning = (msg: string): void => {
      if (!warnings.includes(msg)) {
        warnings.push(msg);
      }
    };

    try {
    // Start owned (with appinfo for native names) and wishlist in parallel, sharing in-flight promises in scope.
    // Consume whichever healthy source settles first without blocking on a slow/hanging peer source.
    const ownedPromise = this.library.getOwnedList(scope, { includeAppInfo: true });
    const wishlistPromise = this.library.getWishlist(scope);

    if (!scope.ownedSettled && !scope.wishlistSettled) {
      handoffLease?.release();
    }

    const settled: {
      owned: SourceFetchResult<OwnedListData> | null;
      wishlist: SourceFetchResult<WishlistListData> | null;
    } = { owned: null, wishlist: null };

    const ownedTracked = ownedPromise.then((res) => {
      settled.owned = res;
      return res;
    });
    const wishlistTracked = wishlistPromise.then((res) => {
      settled.wishlist = res;
      return res;
    });

    await Promise.race([ownedTracked, wishlistTracked]);

    const allTerms = [originalTerm, ...altNames];
    const fallbackPool = new Map<number, CandidateEvidence>();
    const ownedExactHitAppIds = new Set<number>();
    const ownedWithNativeName = new Set<number>();
    const inspectedRequestedIds = new Set<number>();
    const inspectedItemsByAppId = new Map<number, StoreItemMetadata>();
    const inspectedSkippedAppIds = new Set<number>();
    const inspectedFailedAppIds = new Set<number>();
    let getItemsErrorCode: ErrorCode | null = null;

    const inspectAppIds = async (
      candidateAppIds: readonly number[],
      releaseAfterQueue?: NormalWorkLease,
    ): Promise<void> => {
      const toFetch: number[] = [];
      for (const appid of candidateAppIds) {
        if (!inspectedRequestedIds.has(appid)) {
          inspectedRequestedIds.add(appid);
          toFetch.push(appid);
        }
      }
      if (toFetch.length === 0) {
        releaseAfterQueue?.release();
        return;
      }

      const metaRes = await this.metadata.fetchMetadata(scope, toFetch, requestedLanguage, {
        sharedFallbackBudgetLimit: this.maxFallbackMetadataBatches,
        priority: 'low',
        onQueued: () => releaseAfterQueue?.release(),
      });

      for (const w of metaRes.warnings) {
        pushWarning(w);
      }
      if (metaRes.budgetExceeded) {
        searchComplete = false;
        fallbackErrorCode = fallbackErrorCode ?? 'request_budget_exceeded';
      }
      for (const id of metaRes.skippedAppIds) {
        inspectedSkippedAppIds.add(id);
      }
      for (const id of metaRes.failedAppIds) {
        inspectedFailedAppIds.add(id);
      }
      if (metaRes.failedAppIds.size > 0) {
        hasUpstreamFailure = true;
        if (getItemsErrorCode === null) {
          getItemsErrorCode = metaRes.errorCode ?? 'upstream_error';
        }
        fallbackErrorCode = fallbackErrorCode ?? getItemsErrorCode;
      }

      const currentOwnedSet = settled.owned?.ok ? settled.owned.data.appidSet : null;
      const currentWishlistSet = settled.wishlist?.ok ? settled.wishlist.data.appidSet : null;

      for (const [appid, meta] of metaRes.itemsByAppId.entries()) {
        inspectedItemsByAppId.set(appid, meta);
        if (!isMetadataItemUsable(meta)) continue;
        const exactOrig = isExactComparableMatch(originalTerm, meta.name);
        const exactAlt = altNames.some((alt) => isExactComparableMatch(alt, meta.name));
        const looseScore = Math.max(...allTerms.map((t) => scoreCandidateForRanking(t, meta.name)));

        if (exactOrig || exactAlt || looseScore >= 55 || fallbackPool.has(appid)) {
          const isOwned = currentOwnedSet?.has(appid) ?? false;
          const isWishlisted = currentWishlistSet?.has(appid) ?? false;
          const matchSource: MatchSource = isOwned ? 'owned_library_fallback' : 'wishlist_fallback';
          const cand = addCandidateEvidence(fallbackPool, {
            appid,
            name: meta.name,
            language: requestedLanguage,
            matchSource,
            fromOriginalSearch: exactOrig || scoreCandidateForRanking(originalTerm, meta.name) >= 55,
            fromAlternativeSearch:
              exactAlt || altNames.some((alt) => scoreCandidateForRanking(alt, meta.name) >= 55),
            fromOwnedFallback: isOwned,
            fromWishlistFallback: isWishlisted,
            appType: meta.appType,
          });
          cand.verifiedName = meta.name;
          cand.verifiedRequestedLang = requestedLanguage;
          cand.appType = meta.appType;
        }
      }
    };

    const processOwnedNativeAndCollectIds = (res: SourceFetchResult<OwnedListData>): number[] => {
      if (!res.ok) {
        searchComplete = false;
        hasUpstreamFailure = true;
        fallbackErrorCode = fallbackErrorCode ?? res.errorCode;
        pushWarning(`Personal library fallback could not read owned games: ${res.message}`);
        return [];
      }

      // Pass 1: Match against GetOwnedGames native names (0 extra GetItems calls)
      for (const game of res.data.games) {
        if (game.name) {
          ownedWithNativeName.add(game.appid);
        }
        if (!game.name) continue;
        const exactOrig = isExactComparableMatch(originalTerm, game.name);
        const exactAlt = altNames.some((alt) => isExactComparableMatch(alt, game.name!));
        const looseScore = Math.max(...allTerms.map((t) => scoreCandidateForRanking(t, game.name)));

        if (exactOrig || exactAlt) {
          ownedExactHitAppIds.add(game.appid);
          addCandidateEvidence(fallbackPool, {
            appid: game.appid,
            name: game.name,
            language: null,
            matchSource: 'owned_library_fallback',
            fromOriginalSearch: exactOrig,
            fromAlternativeSearch: exactAlt && !exactOrig,
            fromOwnedFallback: true,
          });
        } else if (looseScore >= 55) {
          addCandidateEvidence(fallbackPool, {
            appid: game.appid,
            name: game.name,
            language: null,
            matchSource: 'owned_library_fallback',
            fromOriginalSearch: scoreCandidateForRanking(originalTerm, game.name) >= 55,
            fromAlternativeSearch: altNames.some((alt) => scoreCandidateForRanking(alt, game.name) >= 55),
            fromOwnedFallback: true,
          });
        }
      }

      const ids: number[] = [];
      const seen = new Set<number>();
      // Always prioritize matched owned candidates so they get app_type & requestedLanguage name
      for (const appid of ownedExactHitAppIds) {
        if (!seen.has(appid)) {
          seen.add(appid);
          ids.push(appid);
        }
      }
      // Owned games missing native names from GetOwnedGames
      for (const game of res.data.games) {
        if (!game.name && !seen.has(game.appid)) {
          seen.add(game.appid);
          ids.push(game.appid);
        }
      }
      // When searching in a non-English language, inspect remaining owned AppIDs within budget even if
      // a native owned name already matched, since another owned item may share the localized title.
      if (requestedLanguage !== 'english') {
        for (const game of res.data.games) {
          if (!seen.has(game.appid)) {
            seen.add(game.appid);
            ids.push(game.appid);
          }
        }
      }
      return ids;
    };

    const collectWishlistIds = (res: SourceFetchResult<WishlistListData>): number[] => {
      if (!res.ok) {
        searchComplete = false;
        hasUpstreamFailure = true;
        fallbackErrorCode = fallbackErrorCode ?? res.errorCode;
        pushWarning(`Personal list fallback could not read wishlist: ${res.message}`);
        return [];
      }
      return res.data.items.map((item) => item.appid);
    };

    // If both sources already settled in the same turn, inspect them in one combined prioritized batch;
    // otherwise inspect whichever source settled first immediately while concurrently waiting on the peer.
    if (settled.owned !== null && settled.wishlist !== null) {
      const ownedFinal = settled.owned;
      const wishlistFinal = settled.wishlist;
      const ownedIds = processOwnedNativeAndCollectIds(ownedFinal);
      const wishlistIds = collectWishlistIds(wishlistFinal);

      if (ownedFinal.ok || wishlistFinal.ok) {
        const combinedIds: number[] = [];
        const seenCombined = new Set<number>();
        for (const appid of ownedExactHitAppIds) {
          if (!seenCombined.has(appid)) {
            seenCombined.add(appid);
            combinedIds.push(appid);
          }
        }
        for (const appid of wishlistIds) {
          if (!seenCombined.has(appid)) {
            seenCombined.add(appid);
            combinedIds.push(appid);
          }
        }
        for (const appid of ownedIds) {
          if (!seenCombined.has(appid)) {
            seenCombined.add(appid);
            combinedIds.push(appid);
          }
        }
        await inspectAppIds(combinedIds, handoffLease);
      } else {
        handoffLease?.release();
      }
    } else if (settled.owned !== null) {
      const settledOwned = settled.owned;
      const ownedTask = (async (): Promise<void> => {
        const ownedIds = processOwnedNativeAndCollectIds(settledOwned);
        await inspectAppIds(ownedIds, handoffLease);
      })();
      const wishlistTask = (async (): Promise<void> => {
        const settledWishlist = await wishlistTracked;
        const wishlistIds = collectWishlistIds(settledWishlist);
        await inspectAppIds(wishlistIds);
      })();
      await Promise.all([ownedTask, wishlistTask]);
    } else {
      const settledWishlist = settled.wishlist!;
      const wishlistTask = (async (): Promise<void> => {
        const wishlistIds = collectWishlistIds(settledWishlist);
        await inspectAppIds(wishlistIds, handoffLease);
      })();
      const ownedTask = (async (): Promise<void> => {
        const settledOwned = await ownedTracked;
        const ownedIds = processOwnedNativeAndCollectIds(settledOwned);
        await inspectAppIds(ownedIds);
      })();
      await Promise.all([wishlistTask, ownedTask]);
    }

    const [finalOwned, finalWishlist] = await Promise.all([ownedTracked, wishlistTracked]);

    if (!finalOwned.ok && !finalWishlist.ok) {
      return {
        query: originalQuery,
        resolution: 'error',
        appid: null,
        name: null,
        appType: null,
        requestedLanguage,
        identitySource: null,
        storeUrl: null,
        metadataStatus: 'unavailable',
        candidates: [],
        searchComplete: false,
        errorCode: fallbackErrorCode ?? 'upstream_error',
        warnings,
      };
    }

    // Reconcile candidate source provenance against both final settled lists (deterministic for shared AppIDs)
    const ownedSet = finalOwned.ok ? finalOwned.data.appidSet : new Set<number>();
    const wishlistSet = finalWishlist.ok ? finalWishlist.data.appidSet : new Set<number>();
    for (const cand of fallbackPool.values()) {
      if (ownedSet.has(cand.appid)) {
        (cand as { fromOwnedFallback: boolean }).fromOwnedFallback = true;
        cand.matchSources.add('owned_library_fallback');
        if (cand.primaryMatchSource === 'wishlist_fallback') {
          cand.primaryMatchSource = 'owned_library_fallback';
        }
      }
      if (wishlistSet.has(cand.appid)) {
        (cand as { fromWishlistFallback: boolean }).fromWishlistFallback = true;
        cand.matchSources.add('wishlist_fallback');
      }
    }

    // Compute final unknown-name AppIDs and evidence gaps using both final settled sources
    const unknownNameAppIds = new Set<number>();
    if (finalWishlist.ok) {
      for (const item of finalWishlist.data.items) {
        if (
          !ownedExactHitAppIds.has(item.appid) &&
          (!ownedWithNativeName.has(item.appid) || requestedLanguage !== 'english')
        ) {
          unknownNameAppIds.add(item.appid);
        }
      }
    }
    if (finalOwned.ok) {
      for (const game of finalOwned.data.games) {
        if (!game.name) {
          unknownNameAppIds.add(game.appid);
        } else if (requestedLanguage !== 'english' && !ownedExactHitAppIds.has(game.appid)) {
          unknownNameAppIds.add(game.appid);
        }
      }
    }

    let metadataStatus: MetadataStatus = 'skipped';
    if (inspectedRequestedIds.size > 0) {
      let foundCount = 0;
      for (const appid of inspectedRequestedIds) {
        if (inspectedItemsByAppId.get(appid)?.found) {
          foundCount++;
        }
      }
      if (foundCount === inspectedRequestedIds.size) {
        metadataStatus = 'complete';
      } else if (foundCount > 0) {
        metadataStatus = 'partial';
      } else {
        metadataStatus = 'unavailable';
      }
    }

    const fallbackGaps: MetadataEvidenceGaps = {
      skippedAppIds: new Set<number>(),
      failedAppIds: new Set<number>(),
      unusableAppIds: new Set<number>(),
    };
    for (const appid of unknownNameAppIds) {
      if (inspectedSkippedAppIds.has(appid)) {
        fallbackGaps.skippedAppIds.add(appid);
      } else if (inspectedFailedAppIds.has(appid)) {
        fallbackGaps.failedAppIds.add(appid);
      } else if (!isMetadataItemUsable(inspectedItemsByAppId.get(appid))) {
        fallbackGaps.unusableAppIds.add(appid);
      }
    }

    if (
      inspectedFailedAppIds.size > 0 &&
      (fallbackGaps.failedAppIds.size > 0 || fallbackPool.size === 0)
    ) {
      searchComplete = false;
    }

    if (fallbackGaps.unusableAppIds.size > 0) {
      searchComplete = false;
      pushWarning(
        `GetItems omitted or returned no usable title/metadata for ${fallbackGaps.unusableAppIds.size} unchecked personal list AppID(s); cannot confirm unique single-game identity.`,
      );
    }

    if (fallbackPool.size === 0) {
      if (hasUpstreamFailure || fallbackGaps.unusableAppIds.size > 0) {
        pushWarning(
          hasUpstreamFailure
            ? 'Personal list fallback could not complete due to an upstream error; cannot confirm whether the game exists.'
            : 'Personal list fallback could not verify one or more unchecked personal list items because GetItems returned no usable title/metadata; cannot confirm whether the game exists.',
        );
        return {
          query: originalQuery,
          resolution: 'error',
          appid: null,
          name: null,
          appType: null,
          requestedLanguage,
          identitySource: null,
          storeUrl: null,
          metadataStatus,
          candidates: [],
          searchComplete: false,
          errorCode: fallbackErrorCode ?? 'upstream_error',
          warnings,
        };
      }
      if (!searchComplete) {
        pushWarning(
          'Search was incomplete; no matching candidates were found within available sources/budget, which does not confirm the game does not exist.',
        );
      }
      return {
        query: originalQuery,
        resolution: 'not_found',
        appid: null,
        name: null,
        appType: null,
        requestedLanguage,
        identitySource: null,
        storeUrl: null,
        metadataStatus,
        candidates: [],
        searchComplete,
        errorCode: !searchComplete ? fallbackErrorCode : null,
        warnings,
      };
    }

    const ranked = rankCandidates([...fallbackPool.values()], allTerms, requestedLanguage);
    return this.evaluateCandidates({
      originalQuery,
      originalTerm,
      altNames,
      candidates: ranked,
      requestedLanguage,
      searchComplete,
      incompleteErrorCode: fallbackErrorCode,
      metadataStatus,
      warnings,
      isPersonalFallback: true,
      hasAnyFailedMetadata:
        fallbackGaps.failedAppIds.size > 0 || fallbackGaps.unusableAppIds.size > 0,
      failedMetadataErrorCode: getItemsErrorCode,
      checkUnknownCompetitorsForWinner: buildUnknownCompetitorCheck({
        gaps: fallbackGaps,
        failedErrorCode: getItemsErrorCode,
        context: 'personal_fallback',
      }),
    });
    } finally {
      handoffLease?.release();
    }
  }

  private evaluateCandidates(params: {
    originalQuery: string;
    originalTerm: string;
    altNames: readonly string[];
    candidates: readonly CandidateEvidence[];
    requestedLanguage: SteamLanguage;
    searchComplete: boolean;
    incompleteErrorCode: ErrorCode | null;
    metadataStatus: MetadataStatus;
    warnings: string[];
    isPersonalFallback: boolean;
    hasAnyFailedMetadata: boolean;
    failedMetadataErrorCode: ErrorCode | null;
    checkUnknownCompetitorsForWinner: (winnerAppId: number) => {
      hasUnknownCompetitors: boolean;
      errorCode: ErrorCode | null;
      reason: string | null;
    };
  }): ResolutionOutcome {
    const {
      originalQuery,
      originalTerm,
      altNames,
      candidates,
      requestedLanguage,
      searchComplete,
      incompleteErrorCode,
      metadataStatus,
      warnings,
      isPersonalFallback,
      hasAnyFailedMetadata,
      failedMetadataErrorCode,
      checkUnknownCompetitorsForWinner,
    } = params;

    const effectiveAmbiguousComplete = searchComplete && !hasAnyFailedMetadata;
    const effectiveAmbiguousError = !effectiveAmbiguousComplete
      ? (incompleteErrorCode ?? failedMetadataErrorCode)
      : null;

    const allTerms = [originalTerm, ...altNames];
    const ranked = rankCandidates(candidates, allTerms, requestedLanguage);
    const outCandidates = ranked
      .slice(0, this.maxReturnedCandidates)
      .map((c) =>
        toResolvedCandidate(
          c,
          requestedLanguage,
          resolveEffectiveMatchSource(c, originalTerm, altNames, isPersonalFallback),
        ),
      );

    // Identify exact comparable matches from original query vs alternative_names
    const originalExact = ranked.filter((c) => candidateMatchesTermExact(c, originalTerm));
    const altExact =
      altNames.length > 0
        ? ranked.filter((c) => altNames.some((alt) => candidateMatchesTermExact(c, alt)))
        : [];

    // Check original vs alternative name conflict:
    // 1. Both exact-matched different AppIDs
    if (originalExact.length > 0 && altExact.length > 0) {
      const origIds = new Set(originalExact.map((c) => c.appid));
      const altIds = new Set(altExact.map((c) => c.appid));
      const allIds = new Set([...origIds, ...altIds]);
      if (allIds.size > 1) {
        warnings.push(
          'Original query and alternative_names matched conflicting Steam AppIDs; returning ambiguous candidates.',
        );
        return this.buildAmbiguousOutcome(
          originalQuery,
          requestedLanguage,
          metadataStatus,
          outCandidates,
          effectiveAmbiguousComplete,
          effectiveAmbiguousError,
          warnings,
        );
      }
    }

    // 2. Original search returned candidate(s) that do NOT include the alternative-only exact match
    const originalFoundExact = isPersonalFallback
      ? originalExact
      : originalExact.filter((c) => c.fromOriginalSearch);
    if (originalFoundExact.length === 0 && altExact.length > 0) {
      const altIdSet = new Set(altExact.map((c) => c.appid));
      const conflictingOriginalCandidates = ranked.filter(
        (c) => c.fromOriginalSearch && !altIdSet.has(c.appid),
      );
      if (conflictingOriginalCandidates.length > 0) {
        warnings.push(
          'Original query search returned candidate AppID(s) conflicting with alternative_names match; returning ambiguous candidates.',
        );
        return this.buildAmbiguousOutcome(
          originalQuery,
          requestedLanguage,
          metadataStatus,
          outCandidates,
          effectiveAmbiguousComplete,
          effectiveAmbiguousError,
          warnings,
        );
      }
    }

    // Select candidate pool for unique exact match check
    const resolvedViaAltOnly = originalExact.length === 0 && altExact.length > 0;
    const exactPool = resolvedViaAltOnly ? altExact : originalExact;

    if (exactPool.length === 0) {
      warnings.push(
        'No candidate had a unique exact title match (preserving numbers, symbols, editions, and remasters); returning ambiguous candidates.',
      );
      return this.buildAmbiguousOutcome(
        originalQuery,
        requestedLanguage,
        metadataStatus,
        outCandidates,
        effectiveAmbiguousComplete,
        effectiveAmbiguousError,
        warnings,
      );
    }

    if (exactPool.length > 1) {
      warnings.push(
        `Multiple Steam applications (${exactPool.length}) matched the title exactly; returning ambiguous candidates.`,
      );
      return this.buildAmbiguousOutcome(
        originalQuery,
        requestedLanguage,
        metadataStatus,
        outCandidates,
        effectiveAmbiguousComplete,
        effectiveAmbiguousError,
        warnings,
      );
    }

    const winner = exactPool[0]!;
    const winnerMatchedTerms = resolvedViaAltOnly
      ? altNames.filter((alt) => candidateMatchesTermExact(winner, alt))
      : [originalTerm];
    const winnerComparable = normalizeComparable(winnerMatchedTerms[0] ?? originalTerm);

    // Check for edition/remake/year variant conflict against another game candidate (e.g. "Resident Evil 4" vs "Resident Evil 4 (2005)")
    const editionConflicts = ranked.filter((other) => {
      if (other.appid === winner.appid) return false;
      if (!isGameOrUnknownType(other.appType)) return false;
      const otherNames: string[] = [];
      if (other.verifiedName) otherNames.push(other.verifiedName);
      for (const n of other.names) otherNames.push(n);
      return otherNames.some((n) => isEditionVariantOf(winnerComparable, normalizeComparable(n)));
    });

    if (editionConflicts.length > 0) {
      warnings.push(
        'Found another Steam game that appears to be a year, remake, or edition variant of this title; returning ambiguous candidates.',
      );
      return this.buildAmbiguousOutcome(
        originalQuery,
        requestedLanguage,
        metadataStatus,
        outCandidates,
        effectiveAmbiguousComplete,
        effectiveAmbiguousError,
        warnings,
      );
    }

    // Refuse to confirm a single identity when search/verification was incomplete or unknown competing items exist
    const competitorCheck = checkUnknownCompetitorsForWinner(winner.appid);
    if (!searchComplete || competitorCheck.hasUnknownCompetitors) {
      if (competitorCheck.reason && !warnings.includes(competitorCheck.reason)) {
        warnings.push(competitorCheck.reason);
      } else if (!searchComplete) {
        warnings.push(
          'Search was incomplete and could have missed a homonym, variant, or conflicting AppID; cannot confirm single-game identity.',
        );
      }
      return this.buildAmbiguousOutcome(
        originalQuery,
        requestedLanguage,
        metadataStatus,
        outCandidates,
        false,
        incompleteErrorCode ?? competitorCheck.errorCode,
        warnings,
      );
    }

    // Determine identity_source honestly: never attribute a candidate discovered solely by
    // caller-provided alternative_names to original store_search even if later GetItems
    // metadata verified the localized original title.
    let identitySource: IdentitySource;
    if (isPersonalFallback) {
      identitySource = winner.fromOwnedFallback
        ? 'personal_library_fallback'
        : 'personal_wishlist_fallback';
      if (resolvedViaAltOnly) {
        warnings.push(
          'Resolved via caller-provided alternative_names during personal list fallback; Steam data did not confirm equivalence with the original query.',
        );
      }
    } else if (resolvedViaAltOnly) {
      identitySource = 'alternative_name_search';
      warnings.push(
        'Resolved via caller-provided alternative_names only; Steam data did not confirm equivalence with the original query.',
      );
    } else if (!winner.fromOriginalSearch && winner.fromAlternativeSearch) {
      identitySource = 'alternative_name_search';
      warnings.push(
        'Candidate was discovered only via caller-provided alternative_names (original query StoreSearch returned no match for this AppID); provenance is marked alternative_name_search.',
      );
    } else {
      identitySource = 'store_search';
    }

    const winnerName = getBestDisplayName(winner, requestedLanguage);
    return {
      query: originalQuery,
      resolution: 'resolved',
      appid: winner.appid,
      name: winnerName,
      appType: winner.appType,
      requestedLanguage,
      identitySource,
      storeUrl: buildStoreUrl(winner.appid),
      metadataStatus,
      candidates: outCandidates,
      searchComplete: true,
      errorCode: null,
      warnings,
    };
  }

  private buildAmbiguousOutcome(
    query: string,
    requestedLanguage: SteamLanguage,
    metadataStatus: MetadataStatus,
    candidates: ResolvedCandidate[],
    searchComplete: boolean,
    errorCode: ErrorCode | null,
    warnings: string[],
  ): ResolutionOutcome {
    return {
      query,
      resolution: 'ambiguous',
      appid: null,
      name: null,
      appType: null,
      requestedLanguage,
      identitySource: null,
      storeUrl: null,
      metadataStatus,
      candidates,
      searchComplete,
      errorCode,
      warnings,
    };
  }
}
