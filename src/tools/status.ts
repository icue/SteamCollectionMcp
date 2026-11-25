import type { ServerConfig } from '../config.js';
import {
  GameStatusOutputSchema,
  GetGamesStatusOutputSchema,
  type BatchGameStatusItem,
  type GameQuery,
  type GameStatusOutput,
  type GetGamesStatusInput,
  type GetGamesStatusOutput,
  type StatusCandidate,
} from '../schemas.js';
import type {
  LibraryService,
  OwnedListData,
  SourceFetchResult,
  WishlistListData,
} from '../services/library.js';
import type { MetadataFetchResult, MetadataService } from '../services/metadata.js';
import type {
  GameResolverService,
  ResolutionOutcome,
} from '../services/resolver.js';
import { buildStoreUrl, normalizeStrict, parseDirectIdentifier } from '../utils/identity.js';
import { resolveSteamLanguage, type SteamLanguage } from '../utils/languages.js';

export interface StatusToolDeps {
  readonly config: ServerConfig;
  readonly library: LibraryService;
  readonly metadata: MetadataService;
  readonly resolver: GameResolverService;
  readonly now?: () => number;
}

const DIRECT_METADATA_UNAVAILABLE_WARNING =
  'Metadata was unavailable for the provided AppID; identity_source is provided_appid and does not assert that this AppID is an active Steam Store game.';

function attachCandidateStatuses(
  outcome: ResolutionOutcome,
  ownedRes: SourceFetchResult<OwnedListData> | null,
  wishlistRes: SourceFetchResult<WishlistListData> | null,
): StatusCandidate[] {
  const ownedSet = ownedRes?.ok ? ownedRes.data.appidSet : null;
  const wishlistSet = wishlistRes?.ok ? wishlistRes.data.appidSet : null;

  return outcome.candidates.map((cand) => ({
    ...cand,
    owned: ownedSet !== null ? ownedSet.has(cand.appid) : null,
    wishlisted: wishlistSet !== null ? wishlistSet.has(cand.appid) : null,
  }));
}

function computeTopLevelMembership(
  outcome: ResolutionOutcome,
  ownedRes: SourceFetchResult<OwnedListData> | null,
  wishlistRes: SourceFetchResult<WishlistListData> | null,
): { owned: boolean | null; wishlisted: boolean | null } {
  if (outcome.resolution !== 'resolved' || outcome.appid === null) {
    return { owned: null, wishlisted: null };
  }
  const owned = ownedRes?.ok ? ownedRes.data.appidSet.has(outcome.appid) : null;
  const wishlisted = wishlistRes?.ok ? wishlistRes.data.appidSet.has(outcome.appid) : null;
  return { owned, wishlisted };
}

export function computeDeduplicationKey(query: GameQuery, defaultLanguage: SteamLanguage): string {
  const lang = resolveSteamLanguage(query.language, defaultLanguage).steamLanguage;
  const direct = parseDirectIdentifier(query.query);
  if (direct.kind === 'appid') {
    return JSON.stringify(['appid', direct.appid, lang]);
  }
  if (direct.kind === 'rejected_url' || direct.kind === 'invalid_numeric_id') {
    return JSON.stringify([direct.kind, query.query.trim(), lang]);
  }
  const normQuery = normalizeStrict(direct.original);
  const normAlts = [
    ...new Set(
      (query.alternative_names ?? [])
        .map((a) => normalizeStrict(a))
        .filter((a) => a.length > 0 && a !== normQuery),
    ),
  ].sort();
  return JSON.stringify(['name', normQuery, lang, normAlts]);
}

function applyDeferredDirectMetadata(
  outcome: ResolutionOutcome,
  metaRes: MetadataFetchResult,
  language: SteamLanguage,
): ResolutionOutcome {
  if (outcome.appid === null) {
    return outcome;
  }
  const meta = metaRes.itemsByAppId.get(outcome.appid);
  const found = meta?.found === true;
  const name = found ? meta.name : null;
  const appType = found ? meta.appType : 'unknown';
  const storeUrl = buildStoreUrl(outcome.appid);
  const warnings = [...outcome.warnings];

  if (!found) {
    for (const w of metaRes.warnings) {
      if (!warnings.includes(w)) {
        warnings.push(w);
      }
    }
    if (!warnings.includes(DIRECT_METADATA_UNAVAILABLE_WARNING)) {
      warnings.push(DIRECT_METADATA_UNAVAILABLE_WARNING);
    }
  }

  return {
    ...outcome,
    name,
    appType,
    metadataStatus: found ? 'complete' : 'unavailable',
    candidates: [
      {
        appid: outcome.appid,
        name,
        app_type: appType,
        requested_language: language,
        match_source: 'provided_appid',
        store_url: storeUrl,
      },
    ],
    warnings,
  };
}

export async function handleGetGameStatus(
  deps: StatusToolDeps,
  input: GameQuery,
  signal?: AbortSignal,
): Promise<GameStatusOutput> {
  const now = deps.now ?? (() => Date.now());
  const scope = deps.library.createScope(signal);

  const collectionState: {
    promise: Promise<[SourceFetchResult<OwnedListData>, SourceFetchResult<WishlistListData>]> | null;
  } = { promise: null };

  const ensureCollectionSources = (): Promise<
    [SourceFetchResult<OwnedListData>, SourceFetchResult<WishlistListData>]
  > => {
    if (collectionState.promise === null) {
      collectionState.promise = Promise.all([
        deps.library.getOwnedList(scope, { includeAppInfo: false }),
        deps.library.getWishlist(scope),
      ]);
    }
    return collectionState.promise;
  };

  // Determine identity first (per Spec 6.3); defer optional direct-AppID display metadata
  // so collection sources are read only after identity is known (except during personal fallback)
  // and slow collection fetches never block candidate verification.
  let outcome = await deps.resolver.resolve(scope, input, {
    deferDirectAppIdMetadata: true,
  });

  let ownedRes: SourceFetchResult<OwnedListData> | null = null;
  let wishlistRes: SourceFetchResult<WishlistListData> | null = null;

  const needsCollectionLookup =
    outcome.resolution === 'resolved' ||
    (outcome.resolution === 'ambiguous' && outcome.candidates.length > 0);

  if (needsCollectionLookup) {
    const collectionPromise = ensureCollectionSources();
    if (
      outcome.resolution === 'resolved' &&
      outcome.identitySource === 'provided_appid' &&
      outcome.appid !== null &&
      outcome.metadataStatus === 'skipped' &&
      outcome.requestedLanguage !== null
    ) {
      const deferredLang = outcome.requestedLanguage;
      const deferredAppId = outcome.appid;
      // Launch optional direct-AppID display metadata concurrently behind scope.lowPriorityGate:
      // it never starts before high-priority collection sources claim slots, yet runs immediately
      // on an idle HTTP slot if one collection source completes while the other hangs.
      const [[ownedOut, wishlistOut], metaRes] = await Promise.all([
        collectionPromise,
        deps.metadata.fetchMetadata(scope, [deferredAppId], deferredLang, { priority: 'low' }),
      ]);
      ownedRes = ownedOut;
      wishlistRes = wishlistOut;
      outcome = applyDeferredDirectMetadata(outcome, metaRes, deferredLang);
    } else {
      [ownedRes, wishlistRes] = await collectionPromise;
    }
  } else {
    // Reuse any source fetches that already ran during personal list fallback
    const [o, w] = await Promise.all([
      scope.ownedPromise ?? Promise.resolve(null),
      scope.wishlistPromise ?? Promise.resolve(null),
    ]);
    ownedRes = o;
    wishlistRes = w;
  }

  const { owned, wishlisted } = computeTopLevelMembership(outcome, ownedRes, wishlistRes);
  const candidates = attachCandidateStatuses(outcome, ownedRes, wishlistRes);
  const fetchedAt =
    ownedRes?.fetchedAt ?? wishlistRes?.fetchedAt ?? new Date(now()).toISOString();

  const warnings = [...outcome.warnings];
  if (ownedRes && !ownedRes.ok) {
    warnings.push(`Owned library unavailable (${ownedRes.errorCode}): ${ownedRes.message}`);
  }
  if (wishlistRes && !wishlistRes.ok) {
    warnings.push(`Wishlist unavailable (${wishlistRes.errorCode}): ${wishlistRes.message}`);
  }

  return GameStatusOutputSchema.parse({
    query: outcome.query,
    resolution: outcome.resolution,
    appid: outcome.appid,
    identity_source: outcome.identitySource,
    name: outcome.name,
    app_type: outcome.appType,
    requested_language: outcome.requestedLanguage,
    metadata_status: outcome.metadataStatus,
    owned,
    wishlisted,
    owned_data_status: ownedRes ? ownedRes.dataStatus : null,
    owned_error_code: ownedRes ? ownedRes.errorCode : null,
    owned_fetched_at: ownedRes ? ownedRes.fetchedAt : null,
    wishlist_data_status: wishlistRes ? wishlistRes.dataStatus : null,
    wishlist_error_code: wishlistRes ? wishlistRes.errorCode : null,
    wishlist_fetched_at: wishlistRes ? wishlistRes.fetchedAt : null,
    store_url: outcome.storeUrl,
    fetched_at: fetchedAt,
    search_complete: outcome.searchComplete,
    ...(outcome.errorCode !== null ? { error_code: outcome.errorCode } : {}),
    candidates,
    ...(warnings.length > 0 ? { warnings } : {}),
  });
}

export async function handleGetGamesStatus(
  deps: StatusToolDeps,
  input: GetGamesStatusInput,
  signal?: AbortSignal,
): Promise<GetGamesStatusOutput> {
  const now = deps.now ?? (() => Date.now());
  const scope = deps.library.createScope(signal);

  // Deduplicate unique queries while preserving exact input order, original query text,
  // and per-input unsupported language warnings without bleeding warnings across entries.
  const uniqueKeys: string[] = [];
  const uniqueQueries = new Map<string, GameQuery>();
  const keyPerIndex: string[] = [];
  const extraLangWarningPerIndex: Array<string | null> = [];

  for (const q of input.queries) {
    const langRes = resolveSteamLanguage(q.language, deps.config.language);
    const key = computeDeduplicationKey(q, deps.config.language);
    keyPerIndex.push(key);
    extraLangWarningPerIndex.push(langRes.warning ?? null);
    if (!uniqueQueries.has(key)) {
      uniqueKeys.push(key);
      uniqueQueries.set(key, {
        ...q,
        language: langRes.steamLanguage,
      });
    }
  }

  // Phase 1: Synchronously classify and resolve direct identifiers (0 network calls)
  const outcomeByKey = new Map<string, ResolutionOutcome>();
  const directAppIdKeys: string[] = [];
  const nameKeys: string[] = [];

  for (const key of uniqueKeys) {
    const q = uniqueQueries.get(key)!;
    const direct = parseDirectIdentifier(q.query);
    if (direct.kind === 'appid') {
      directAppIdKeys.push(key);
      const outcome = await deps.resolver.resolve(scope, q, {
        deferDirectAppIdMetadata: true,
      });
      outcomeByKey.set(key, outcome);
    } else if (direct.kind === 'rejected_url' || direct.kind === 'invalid_numeric_id') {
      const outcome = await deps.resolver.resolve(scope, q, {
        deferDirectAppIdMetadata: true,
      });
      outcomeByKey.set(key, outcome);
    } else {
      nameKeys.push(key);
    }
  }

  // Shared single-call collection fetchers (1x GetOwnedGames and 1x GetWishlist max per batch)
  const includeAppInfoForOwned = nameKeys.length > 0;
  const collectionState: {
    promise: Promise<[SourceFetchResult<OwnedListData>, SourceFetchResult<WishlistListData>]> | null;
  } = { promise: null };

  const ensureCollectionSources = (): Promise<
    [SourceFetchResult<OwnedListData>, SourceFetchResult<WishlistListData>]
  > => {
    if (collectionState.promise === null) {
      collectionState.promise = Promise.all([
        deps.library.getOwnedList(scope, { includeAppInfo: includeAppInfoForOwned }),
        deps.library.getWishlist(scope),
      ]);
    }
    return collectionState.promise;
  };

  // Build optional direct-AppID display metadata groups per language right after Phase 1
  const deferredByLang = new Map<SteamLanguage, number[]>();
  for (const key of directAppIdKeys) {
    const outcome = outcomeByKey.get(key);
    if (
      outcome &&
      outcome.resolution === 'resolved' &&
      outcome.identitySource === 'provided_appid' &&
      outcome.appid !== null &&
      outcome.metadataStatus === 'skipped' &&
      outcome.requestedLanguage !== null
    ) {
      let arr = deferredByLang.get(outcome.requestedLanguage);
      if (!arr) {
        arr = [];
        deferredByLang.set(outcome.requestedLanguage, arr);
      }
      arr.push(outcome.appid);
    }
  }
  const deferredDirectTasks = [...deferredByLang.entries()].map(([lang, appids]) => ({
    lang,
    appids,
  }));

  // Phase 2: When any direct AppID is already known, immediately start high-priority owned & wishlist
  // fetches synchronously so they claim/queue ahead of name queries and optional display metadata,
  // without stalling fast independent paths if one collection source is slow.
  if (directAppIdKeys.length > 0) {
    void ensureCollectionSources();
  }

  // Phase 3: Ready-driven scheduling bounded strictly at the real HTTP concurrency semaphore.
  // Logical tasks waiting on shared in-flight metadata or queued fallback work never consume
  // HTTP concurrency slots:
  // 1) All unique name queries enter Stage A (StoreSearch + candidate verification) with a
  //    live NormalWorkLease that drops to 0 whenever a query is only awaiting a shared
  //    in-flight GetItems promise.
  // 2) Optional direct-AppID display metadata runs concurrently behind scope.lowPriorityGate
  //    so it never preempts healthy collection lookups or runnable Stage A work yet uses any
  //    idle HTTP slot immediately.
  // 3) Name queries that need Stage B personal fallback start as soon as runnable Stage A
  //    work leaves an idle HTTP slot (in deterministic input order when queued), sharing
  //    in-flight owned/wishlist lists, per-language GetItems promises, and the call-scoped
  //    4-batch fallback budget without exceeding configured HTTP concurrency.
  if (nameKeys.length > 0 || deferredDirectTasks.length > 0) {
    const normalLeases = nameKeys.map(() => scope.lowPriorityGate.acquireNormalLease(1));

    const nameTasks = nameKeys.map(async (key, orderIndex) => {
      const q = uniqueQueries.get(key)!;
      const lease = normalLeases[orderIndex]!;
      let stageResult: Awaited<ReturnType<typeof deps.resolver.resolveStorePhase>>;
      try {
        stageResult = await deps.resolver.resolveStorePhase(scope, q, {
          deferDirectAppIdMetadata: true,
          normalLease: lease,
        });
      } catch (err) {
        lease.release();
        throw err;
      }

      if (stageResult.kind === 'done') {
        outcomeByKey.set(key, stageResult.outcome);
        if (
          stageResult.outcome.resolution === 'resolved' ||
          (stageResult.outcome.resolution === 'ambiguous' &&
            stageResult.outcome.candidates.length > 0)
        ) {
          void ensureCollectionSources();
        }
        lease.release();
        return;
      }

      try {
        const otherNormalActive = scope.lowPriorityGate.getActiveNormalWork() - 1;
        if (
          otherNormalActive >= deps.config.maxConcurrency ||
          scope.lowPriorityGate.hasFallbackStartWaiters()
        ) {
          // Enqueue BEFORE releasing the lease so all waiting fallbacks are sorted by
          // orderIndex and woken together on the same microtask turn in deterministic input order.
          const startWait = scope.lowPriorityGate.waitForFallbackStart(
            scope.execCtx.deadlineMs,
            now,
            scope.execCtx.signal,
            orderIndex,
          );
          lease.release();
          try {
            await startWait;
          } catch {
            // Deadline exceeded or aborted while waiting; still delegate to completePersonalFallback
            // so it returns a structured timeout/incomplete ResolutionOutcome without extra fetches.
          }
          const outcome = await deps.resolver.completePersonalFallback(scope, stageResult.pending);
          outcomeByKey.set(key, outcome);
        } else {
          const outcome = await deps.resolver.completePersonalFallback(
            scope,
            stageResult.pending,
            { handoffLease: lease },
          );
          outcomeByKey.set(key, outcome);
        }
      } finally {
        lease.release();
      }
    });

    const deferredTasks = deferredDirectTasks.map(async (task) => {
      // Collection sources are already started in Phase 2; scope.lowPriorityGate ensures
      // optional display metadata never preempts healthy collection lookups or runnable
      // Stage A work while utilizing any idle HTTP slot immediately.
      void ensureCollectionSources();
      const metaRes = await deps.metadata.fetchMetadata(scope, task.appids, task.lang, {
        priority: 'low',
      });
      for (const [key, outcome] of outcomeByKey.entries()) {
        if (
          outcome.resolution === 'resolved' &&
          outcome.identitySource === 'provided_appid' &&
          outcome.appid !== null &&
          outcome.metadataStatus === 'skipped' &&
          outcome.requestedLanguage === task.lang
        ) {
          outcomeByKey.set(key, applyDeferredDirectMetadata(outcome, metaRes, task.lang));
        }
      }
    });

    await Promise.all([...nameTasks, ...deferredTasks]);
  }

  // Phase 4: Settle collection sources once (reusing any in-flight or completed scope fetches)
  const anyNeedsCollectionLookup = [...outcomeByKey.values()].some(
    (o) => o.resolution === 'resolved' || (o.resolution === 'ambiguous' && o.candidates.length > 0),
  );

  let ownedRes: SourceFetchResult<OwnedListData> | null = null;
  let wishlistRes: SourceFetchResult<WishlistListData> | null = null;

  if (anyNeedsCollectionLookup) {
    [ownedRes, wishlistRes] = await ensureCollectionSources();
  } else if (collectionState.promise !== null) {
    [ownedRes, wishlistRes] = await collectionState.promise;
  } else {
    [ownedRes, wishlistRes] = await Promise.all([
      scope.ownedPromise ?? Promise.resolve(null),
      scope.wishlistPromise ?? Promise.resolve(null),
    ]);
  }

  const batchWarnings: string[] = [];
  if (ownedRes && !ownedRes.ok) {
    batchWarnings.push(`Owned library unavailable (${ownedRes.errorCode}): ${ownedRes.message}`);
  }
  if (wishlistRes && !wishlistRes.ok) {
    batchWarnings.push(`Wishlist unavailable (${wishlistRes.errorCode}): ${wishlistRes.message}`);
  }

  const results: BatchGameStatusItem[] = input.queries.map((originalInput, i) => {
    const key = keyPerIndex[i]!;
    const outcome = outcomeByKey.get(key)!;
    const { owned, wishlisted } = computeTopLevelMembership(outcome, ownedRes, wishlistRes);
    const candidates = attachCandidateStatuses(outcome, ownedRes, wishlistRes);

    // Combine outcome warnings with any language warning specific to this input item
    const itemWarnings = [...outcome.warnings];
    const extraLangWarn = extraLangWarningPerIndex[i];
    if (extraLangWarn && !itemWarnings.includes(extraLangWarn)) {
      itemWarnings.unshift(extraLangWarn);
    }

    return {
      query: originalInput.query,
      resolution: outcome.resolution,
      appid: outcome.appid,
      identity_source: outcome.identitySource,
      name: outcome.name,
      app_type: outcome.appType,
      requested_language: outcome.requestedLanguage,
      metadata_status: outcome.metadataStatus,
      owned,
      wishlisted,
      store_url: outcome.storeUrl,
      search_complete: outcome.searchComplete,
      ...(outcome.errorCode !== null ? { error_code: outcome.errorCode } : {}),
      candidates,
      ...(itemWarnings.length > 0 ? { warnings: itemWarnings } : {}),
    };
  });

  const fetchedAt =
    ownedRes?.fetchedAt ?? wishlistRes?.fetchedAt ?? new Date(now()).toISOString();

  return GetGamesStatusOutputSchema.parse({
    total: results.length,
    owned_data_status: ownedRes ? ownedRes.dataStatus : null,
    owned_error_code: ownedRes ? ownedRes.errorCode : null,
    owned_fetched_at: ownedRes ? ownedRes.fetchedAt : null,
    wishlist_data_status: wishlistRes ? wishlistRes.dataStatus : null,
    wishlist_error_code: wishlistRes ? wishlistRes.errorCode : null,
    wishlist_fetched_at: wishlistRes ? wishlistRes.fetchedAt : null,
    fetched_at: fetchedAt,
    results,
    ...(batchWarnings.length > 0 ? { warnings: batchWarnings } : {}),
  });
}
