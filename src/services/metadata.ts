import type { ServerConfig } from '../config.js';
import { SteamClientError, type RequestPriority } from '../clients/http.js';
import type { SteamApiClient, StoreItemMetadata } from '../clients/steam.js';
import type { ErrorCode, MetadataStatus } from '../schemas.js';
import { isValidAppId } from '../utils/identity.js';
import type { SteamLanguage } from '../utils/languages.js';
import type {
  InFlightMetadataItem,
  MetadataInFlightEntry,
  NormalWorkLease,
  ToolCallScope,
} from './library.js';

export interface MetadataBatchOptions {
  readonly maxBatches?: number;
  /**
   * When set, enforces a single shared fallback batch ceiling across the entire
   * ToolCallScope (`scope.fallbackMetadataBatchesUsed`) rather than per query.
   */
  readonly sharedFallbackBudgetLimit?: number;
  /**
   * Request scheduling priority on the shared HTTP semaphore.
   * Defaults to 'low' for personal fallback batches and 'normal' otherwise.
   */
  readonly priority?: RequestPriority;
  /**
   * Optional cap on simultaneous chunks dispatched by this call.
   * Defaults to config.maxConcurrency so both normal and low-priority/fallback
   * batches can utilize available HTTP slots up to configured concurrency.
   */
  readonly maxChunkConcurrency?: number;
  /**
   * Optional Stage A normal-priority lease whose slot demand is dynamically matched
   * to this caller's remaining owned chunks, dropping to 0 only while purely awaiting
   * unsettled shared/claimed in-flight metadata entries and atomically preserving 1
   * continuation unit once all waited entries settle.
   */
  readonly normalLease?: NormalWorkLease;
  /**
   * Optional callback invoked synchronously once any scheduled low-priority chunks
   * have been queued onto scope.lowPriorityGate (or immediately when no chunks are scheduled).
   */
  readonly onQueued?: () => void;
}

export interface MetadataFetchResult {
  readonly itemsByAppId: Map<number, StoreItemMetadata>;
  readonly metadataStatus: MetadataStatus;
  readonly budgetExceeded: boolean;
  readonly skippedCount: number;
  readonly skippedAppIds: Set<number>;
  readonly failedAppIds: Set<number>;
  readonly warnings: string[];
  readonly errorCode: ErrorCode | null;
}

export function metadataCacheKey(language: SteamLanguage, appid: number): string {
  return `${language}:${appid}`;
}

function makeMissingMetadataItem(appid: number, language: SteamLanguage): StoreItemMetadata {
  return {
    appid,
    found: false,
    name: null,
    appType: 'unknown',
    requestedLanguage: language,
    unlisted: false,
  };
}

function computeCallerRank(priority: RequestPriority, isFallbackBatch: boolean): number {
  if (priority === 'high') return 3;
  if (priority === 'normal') return 2;
  return isFallbackBatch ? 0 : 1;
}

/**
 * Stateless service for batching IStoreBrowseService/GetItems/v1/ requests.
 * Shares completed and in-flight results ONLY within the provided ToolCallScope;
 * distinguishes queued (not-yet-dispatched) keys from genuinely in-flight network
 * requests so higher-priority callers can claim/promote queued keys immediately
 * without duplicating HTTP calls or blocking on unrelated slow chunks.
 */
export class MetadataService {
  private readonly steam: SteamApiClient;
  private readonly config: ServerConfig;
  private readonly now: () => number;

  constructor(
    steam: SteamApiClient,
    config: ServerConfig,
    now?: () => number,
  ) {
    this.steam = steam;
    this.config = config;
    this.now = now ?? steam.now;
  }

  async fetchMetadata(
    scope: ToolCallScope,
    appids: readonly number[],
    language: SteamLanguage,
    options?: MetadataBatchOptions,
  ): Promise<MetadataFetchResult> {
    const uniqueAppIds: number[] = [];
    const seen = new Set<number>();
    for (const appid of appids) {
      if (isValidAppId(appid) && !seen.has(appid)) {
        seen.add(appid);
        uniqueAppIds.push(appid);
      }
    }

    const itemsByAppId = new Map<number, StoreItemMetadata>();
    const skippedAppIds = new Set<number>();
    const failedAppIds = new Set<number>();

    if (uniqueAppIds.length === 0) {
      options?.onQueued?.();
      return {
        itemsByAppId,
        metadataStatus: 'complete',
        budgetExceeded: false,
        skippedCount: 0,
        skippedAppIds,
        failedAppIds,
        warnings: [],
        errorCode: null,
      };
    }

    const isFallbackBatch = options?.sharedFallbackBudgetLimit !== undefined;
    const requestPriority: RequestPriority =
      options?.priority ?? (isFallbackBatch ? 'low' : 'normal');
    const callerRank = computeCallerRank(requestPriority, isFallbackBatch);
    const chunkConcurrencyLimit = options?.maxChunkConcurrency ?? this.config.maxConcurrency;

    // Partition synchronously before any await:
    // - Completed entries hit scope.metadataCache immediately.
    // - Truly dispatched (or equal/higher-rank queued) entries are awaited without duplication.
    // - Lower-rank queued entries (not yet sent on the wire) are eligible to be claimed/promoted
    //   into this higher-rank caller's own batch so higher-priority work never waits behind
    //   unrelated hanging low-priority chunks.
    const sharedEntries: Array<{ appid: number; entry: MetadataInFlightEntry }> = [];
    const candidateWorkAppIds: number[] = [];
    const claimableEntries = new Map<number, MetadataInFlightEntry>();

    for (const appid of uniqueAppIds) {
      const key = metadataCacheKey(language, appid);
      const cached = scope.metadataCache.get(key);
      if (cached) {
        itemsByAppId.set(appid, cached);
        continue;
      }
      const existing = scope.metadataInFlight.get(key);
      if (existing) {
        if (existing.state === 'queued' && callerRank > existing.rank) {
          claimableEntries.set(appid, existing);
          candidateWorkAppIds.push(appid);
        } else {
          sharedEntries.push({ appid, entry: existing });
        }
        continue;
      }
      candidateWorkAppIds.push(appid);
    }

    const batchSize = this.config.metadataBatchSize;
    const allChunks: number[][] = [];
    for (let i = 0; i < candidateWorkAppIds.length; i += batchSize) {
      allChunks.push(candidateWorkAppIds.slice(i, i + batchSize));
    }

    let effectiveMaxBatches = options?.maxBatches;
    if (options?.sharedFallbackBudgetLimit !== undefined) {
      const remaining = Math.max(
        0,
        options.sharedFallbackBudgetLimit - scope.fallbackMetadataBatchesUsed,
      );
      effectiveMaxBatches =
        effectiveMaxBatches !== undefined
          ? Math.min(effectiveMaxBatches, remaining)
          : remaining;
    }

    let chunksToRun = allChunks;
    let budgetExceeded = false;
    const warnings: string[] = [];
    let firstErrorCode: ErrorCode | null = null;

    if (effectiveMaxBatches !== undefined && allChunks.length > effectiveMaxBatches) {
      const allowed = Math.max(0, effectiveMaxBatches);
      chunksToRun = allChunks.slice(0, allowed);
      const skippedChunks = allChunks.slice(allowed);
      const newlySkipped: number[] = [];
      for (const skippedChunk of skippedChunks) {
        for (const id of skippedChunk) {
          const claimable = claimableEntries.get(id);
          if (claimable) {
            // Do not claim an existing queued entry if our own budget skips it; just await it.
            sharedEntries.push({ appid: id, entry: claimable });
            claimableEntries.delete(id);
          } else {
            skippedAppIds.add(id);
            newlySkipped.push(id);
          }
        }
      }
      if (newlySkipped.length > 0) {
        budgetExceeded = true;
        firstErrorCode = 'request_budget_exceeded';
        const budgetLabel =
          options?.sharedFallbackBudgetLimit ?? options?.maxBatches ?? allowed;
        warnings.push(
          `Metadata fetch reached batch budget (${budgetLabel}); ${skippedAppIds.size} AppID(s) were not fetched.`,
        );
      }
    }

    // Reserve shared call-scoped fallback batches synchronously before any await
    if (options?.sharedFallbackBudgetLimit !== undefined && chunksToRun.length > 0) {
      scope.fallbackMetadataBatchesUsed += chunksToRun.length;
    }

    // Register queued entries (or atomically claim lower-rank queued entries) synchronously before any await
    interface ScheduledChunk {
      readonly ownerToken: symbol;
      readonly entries: Array<{ appid: number; key: string; entry: MetadataInFlightEntry }>;
    }

    const scheduledChunks: ScheduledChunk[] = chunksToRun.map((chunk) => {
      const ownerToken = Symbol('metadata-chunk');
      const entries: Array<{ appid: number; key: string; entry: MetadataInFlightEntry }> = [];
      for (const appid of chunk) {
        const key = metadataCacheKey(language, appid);
        const claimed = claimableEntries.get(appid);
        if (claimed && claimed.state === 'queued' && callerRank > claimed.rank) {
          claimed.ownerToken = ownerToken;
          claimed.rank = callerRank;
          entries.push({ appid, key, entry: claimed });
        } else {
          let resolvePromise!: (outcome: InFlightMetadataItem) => void;
          const promise = new Promise<InFlightMetadataItem>((resolve) => {
            resolvePromise = resolve;
          });
          const entry: MetadataInFlightEntry = {
            state: 'queued',
            rank: callerRank,
            ownerToken,
            settled: false,
            onSettled: [],
            promise,
            resolve: (outcome: InFlightMetadataItem) => {
              if (entry.settled) {
                return;
              }
              entry.settled = true;
              resolvePromise(outcome);
              const listeners = entry.onSettled.splice(0, entry.onSettled.length);
              for (const listener of listeners) {
                listener();
              }
            },
          };
          scope.metadataInFlight.set(key, entry);
          entries.push({ appid, key, entry });
        }
      }
      return { ownerToken, entries };
    });

    const allWaitEntries: Array<{ appid: number; entry: MetadataInFlightEntry }> = [
      ...sharedEntries,
      ...scheduledChunks.flatMap((c) =>
        c.entries.map(({ appid, entry }) => ({ appid, entry })),
      ),
    ];

    const refundFallbackBatch = (): void => {
      if (isFallbackBatch && scope.fallbackMetadataBatchesUsed > 0) {
        scope.fallbackMetadataBatchesUsed--;
      }
    };

    const normalLease = requestPriority === 'normal' ? options?.normalLease : undefined;
    let remainingOwnedChunks = scheduledChunks.length;
    let pendingWaitEntries = 0;
    let fetchFinished = false;

    const computeNormalLeaseDemand = (): number => {
      if (scope.execCtx.signal?.aborted) {
        return 0;
      }
      if (remainingOwnedChunks > 0) {
        return Math.min(remainingOwnedChunks, this.config.maxConcurrency);
      }
      // Pause normal-priority demand (drop to 0) only while genuinely waiting on
      // unsettled shared/claimed in-flight entries. Once all waited entries settle
      // (or on a cache hit), atomically hand 1 unit back to the caller's continuation
      // so queued low-priority work cannot steal the slot before a required follow-up
      // step (e.g., default-language verification or collection startup) or lease release.
      return pendingWaitEntries > 0 ? 0 : 1;
    };

    const syncNormalLeaseDemand = (): void => {
      if (normalLease && !fetchFinished) {
        normalLease.setDemand(computeNormalLeaseDemand());
      }
    };
    const decrementOwnedChunk = (): void => {
      if (remainingOwnedChunks > 0) {
        remainingOwnedChunks--;
        syncNormalLeaseDemand();
      }
    };

    if (normalLease) {
      for (const { entry } of allWaitEntries) {
        if (!entry.settled) {
          pendingWaitEntries++;
          entry.onSettled.push(() => {
            if (pendingWaitEntries > 0) {
              pendingWaitEntries--;
            }
            syncNormalLeaseDemand();
          });
        }
      }
    }

    const runScheduledChunks = async (): Promise<void> => {
      if (scheduledChunks.length === 0) {
        return;
      }

      const workerCount = Math.max(
        1,
        Math.min(chunkConcurrencyLimit, this.config.maxConcurrency, scheduledChunks.length),
      );
      let nextIndex = 0;

      const worker = async (): Promise<void> => {
        while (true) {
          const idx = nextIndex++;
          const scheduled = scheduledChunks[idx];
          if (!scheduled) {
            return;
          }

          const { ownerToken, entries } = scheduled;
          const getStillOwned = () => entries.filter(({ entry }) => entry.ownerToken === ownerToken);

          const usesLowPriorityGate = requestPriority === 'low';
          const fallbackGateLang = isFallbackBatch ? language : null;
          let acquiredGate = false;
          let dispatched = false;

          try {
            // If higher-priority callers already claimed every AppID in this queued chunk,
            // skip dispatching and refund the unused fallback batch slot.
            if (getStillOwned().length === 0) {
              refundFallbackBatch();
              continue;
            }

            if (usesLowPriorityGate) {
              try {
                await scope.lowPriorityGate.acquire(
                  scope.execCtx.deadlineMs,
                  this.now,
                  scope.execCtx.signal,
                  fallbackGateLang,
                );
                acquiredGate = true;
              } catch (gateErr) {
                const cancelled =
                  scope.execCtx.signal?.aborted ||
                  (gateErr instanceof Error && gateErr.message === 'aborted');
                throw new SteamClientError({
                  dataStatus: 'unavailable',
                  errorCode: 'timeout',
                  endpoint: 'GetItems',
                  message: cancelled
                    ? 'Request to GetItems was cancelled while waiting for low-priority slot.'
                    : 'Tool timeout deadline exceeded while waiting for low-priority GetItems slot.',
                });
              }
            }

            // Re-check ownership right before network dispatch (some or all keys may have been
            // promoted/claimed by a higher-priority caller while we waited at the gate).
            const toDispatch = getStillOwned();
            if (toDispatch.length === 0) {
              refundFallbackBatch();
              continue;
            }

            if (scope.execCtx.signal?.aborted) {
              throw new SteamClientError({
                dataStatus: 'unavailable',
                errorCode: 'timeout',
                endpoint: 'GetItems',
                message: 'Request to GetItems was cancelled.',
              });
            }

            // Mark strictly the dispatched AppIDs as genuinely in-flight on the network
            for (const { entry } of toDispatch) {
              entry.state = 'dispatched';
            }
            dispatched = true;

            const res = await this.steam.getItems(
              scope.execCtx,
              {
                appids: toDispatch.map(({ appid }) => appid),
                language,
              },
              { priority: requestPriority },
            );

            for (const { appid, key, entry } of toDispatch) {
              const item = res.itemsByAppId.get(appid) ?? makeMissingMetadataItem(appid, language);
              scope.metadataCache.set(key, item);
              if (scope.metadataInFlight.get(key) === entry) {
                scope.metadataInFlight.delete(key);
              }
              entry.resolve({
                item,
                failed: false,
                errorCode: null,
                warning: null,
              });
            }
          } catch (err) {
            const remainingOwned = getStillOwned();
            if (remainingOwned.length === 0) {
              refundFallbackBatch();
              continue;
            }
            if (!dispatched) {
              refundFallbackBatch();
            }

            const clientErr =
              err instanceof SteamClientError
                ? err
                : new SteamClientError({
                    dataStatus: 'error',
                    errorCode: 'upstream_error',
                    endpoint: 'GetItems',
                    message: 'GetItems batch request failed.',
                  });

            for (const { appid, key, entry } of remainingOwned) {
              const fallbackItem = makeMissingMetadataItem(appid, language);
              // Never poison metadataCache with transient/upstream HTTP failures
              if (scope.metadataInFlight.get(key) === entry) {
                scope.metadataInFlight.delete(key);
              }
              entry.resolve({
                item: fallbackItem,
                failed: true,
                errorCode: clientErr.errorCode,
                warning: clientErr.message,
              });
            }
          } finally {
            if (acquiredGate) {
              scope.lowPriorityGate.release(fallbackGateLang);
            }
            decrementOwnedChunk();
          }
        }
      };

      const workers = Array.from({ length: workerCount }, () => worker());
      await Promise.all(workers);
    };

    const awaitAllOutcomes = async (): Promise<void> => {
      if (allWaitEntries.length === 0) {
        return;
      }
      const outcomes = await Promise.all(
        allWaitEntries.map(async ({ appid, entry }) => ({
          appid,
          outcome: await entry.promise,
        })),
      );
      for (const { appid, outcome } of outcomes) {
        itemsByAppId.set(appid, outcome.item);
        if (outcome.failed) {
          failedAppIds.add(appid);
          if (firstErrorCode === null && outcome.errorCode !== null) {
            firstErrorCode = outcome.errorCode;
          }
          if (outcome.warning && !warnings.includes(outcome.warning)) {
            warnings.push(outcome.warning);
          }
        }
      }
    };

    syncNormalLeaseDemand();
    try {
      const chunksPromise = runScheduledChunks();
      options?.onQueued?.();
      await Promise.all([chunksPromise, awaitAllOutcomes()]);
    } finally {
      fetchFinished = true;
      if (normalLease) {
        normalLease.setDemand(scope.execCtx.signal?.aborted ? 0 : 1);
      }
    }

    let foundCount = 0;
    for (const appid of uniqueAppIds) {
      const meta = itemsByAppId.get(appid);
      if (meta?.found) {
        foundCount++;
      } else if (!meta) {
        itemsByAppId.set(appid, makeMissingMetadataItem(appid, language));
      }
    }

    let metadataStatus: MetadataStatus;
    if (foundCount === uniqueAppIds.length) {
      metadataStatus = 'complete';
    } else if (foundCount > 0) {
      metadataStatus = 'partial';
    } else {
      metadataStatus = 'unavailable';
    }

    return {
      itemsByAppId,
      metadataStatus,
      budgetExceeded,
      skippedCount: skippedAppIds.size,
      skippedAppIds,
      failedAppIds,
      warnings,
      errorCode: firstErrorCode,
    };
  }
}
