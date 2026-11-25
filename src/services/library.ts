import type { ServerConfig } from '../config.js';
import { SteamClientError, type RequestExecutionContext } from '../clients/http.js';
import type {
  OwnedGameRecord,
  SteamApiClient,
  StoreItemMetadata,
  WishlistRecord,
} from '../clients/steam.js';
import type { DataStatus, ErrorCode } from '../schemas.js';
import type { SteamLanguage } from '../utils/languages.js';

export interface OwnedListData {
  readonly games: OwnedGameRecord[];
  readonly appidSet: Set<number>;
  readonly gameCount: number;
}

export interface WishlistListData {
  readonly items: WishlistRecord[];
  readonly appidSet: Set<number>;
}

export type SourceFetchResult<T> =
  | {
      readonly ok: true;
      readonly data: T;
      readonly dataStatus: 'ok';
      readonly errorCode: null;
      readonly fetchedAt: string;
      readonly message: null;
    }
  | {
      readonly ok: false;
      readonly data: null;
      readonly dataStatus: Exclude<DataStatus, 'ok'>;
      readonly errorCode: ErrorCode;
      readonly fetchedAt: string;
      readonly message: string;
    };

export interface InFlightMetadataItem {
  readonly item: StoreItemMetadata;
  readonly failed: boolean;
  readonly errorCode: ErrorCode | null;
  readonly warning: string | null;
}

export interface MetadataInFlightEntry {
  state: 'queued' | 'dispatched';
  rank: number;
  ownerToken: symbol;
  settled: boolean;
  readonly onSettled: Array<() => void>;
  readonly promise: Promise<InFlightMetadataItem>;
  readonly resolve: (outcome: InFlightMetadataItem) => void;
}

interface LowPriorityWaiter {
  readonly deadlineMs: number;
  readonly now: () => number;
  readonly signal?: AbortSignal;
  readonly fallbackLanguage: SteamLanguage | null;
  resolve: () => boolean;
  reject: (err: unknown) => void;
}

interface FallbackStartWaiter {
  readonly deadlineMs: number;
  readonly now: () => number;
  readonly signal?: AbortSignal;
  readonly orderIndex: number;
  resolve: () => boolean;
  reject: (err: unknown) => void;
}

/**
 * Tracks one normal-priority Stage A task's live HTTP slot demand against a
 * ToolCallScope's LowPriorityGate. Tasks purely awaiting shared in-flight
 * metadata temporarily drop their demand to 0 so idle HTTP slots remain usable
 * by independent ready work without ever leaking counts on abort or error.
 */
export class NormalWorkLease {
  private units = 0;
  private released = false;

  constructor(
    private readonly gate: LowPriorityGate,
    initialUnits = 1,
  ) {
    this.setDemand(initialUnits);
  }

  setDemand(nextUnits: number): void {
    if (this.released) {
      return;
    }
    const clamped = Math.max(0, nextUnits);
    const delta = clamped - this.units;
    if (delta !== 0) {
      this.units = clamped;
      this.gate.adjustNormalWork(delta);
    }
  }

  release(): void {
    if (this.released) {
      return;
    }
    this.setDemand(0);
    this.released = true;
  }
}

/**
 * Call-scoped credit scheduler for low-priority metadata work (optional direct-AppID
 * display metadata and personal-list fallback GetItems).
 *
 * Dynamically reserves capacity for genuinely runnable higher-priority work in this call
 * (in-flight GetOwnedGames/GetWishlist calls and non-waiting Stage A StoreSearch/verification)
 * while opening idle slots immediately as higher-priority work settles or pauses on a shared
 * in-flight network request. Both cross-language and same-language independent fallback chunks
 * may use available idle slots up to maxConcurrency, while preferring direct-AppID metadata and
 * languages with fewer active fallback chunks when multiple low-priority waiters contend.
 */
export class LowPriorityGate {
  private readonly maxConcurrency: number;
  private activeCollectionSources = 0;
  private activeNormalWork = 0;
  private activeLowPriority = 0;
  private readonly activeFallbackByLanguage = new Map<SteamLanguage, number>();
  private readonly waiters: LowPriorityWaiter[] = [];
  private readonly fallbackStartWaiters: FallbackStartWaiter[] = [];
  private drainScheduled = false;

  constructor(maxConcurrency: number) {
    this.maxConcurrency = Math.max(1, maxConcurrency);
  }

  onCollectionStarted(): void {
    this.activeCollectionSources++;
  }

  onCollectionSettled(): void {
    if (this.activeCollectionSources > 0) {
      this.activeCollectionSources--;
    }
    this.drain();
  }

  acquireNormalLease(initialUnits = 1): NormalWorkLease {
    return new NormalWorkLease(this, initialUnits);
  }

  adjustNormalWork(delta: number): void {
    this.activeNormalWork = Math.max(0, this.activeNormalWork + delta);
    if (delta < 0) {
      this.drain();
    }
  }

  getActiveNormalWork(): number {
    return this.activeNormalWork;
  }

  hasFallbackStartWaiters(): boolean {
    return this.fallbackStartWaiters.length > 0;
  }

  private getCapacity(): number {
    return Math.max(
      0,
      this.maxConcurrency - this.activeCollectionSources - this.activeNormalWork,
    );
  }

  private scheduleDrain(): void {
    if (this.drainScheduled) {
      return;
    }
    this.drainScheduled = true;
    queueMicrotask(() => {
      this.drainScheduled = false;
      this.drain();
    });
  }

  private takeSlot(fallbackLanguage: SteamLanguage | null): void {
    this.activeLowPriority++;
    if (fallbackLanguage !== null) {
      this.activeFallbackByLanguage.set(
        fallbackLanguage,
        (this.activeFallbackByLanguage.get(fallbackLanguage) ?? 0) + 1,
      );
    }
  }

  private dropSlot(fallbackLanguage: SteamLanguage | null): void {
    if (this.activeLowPriority > 0) {
      this.activeLowPriority--;
    }
    if (fallbackLanguage !== null) {
      const count = (this.activeFallbackByLanguage.get(fallbackLanguage) ?? 0) - 1;
      if (count <= 0) {
        this.activeFallbackByLanguage.delete(fallbackLanguage);
      } else {
        this.activeFallbackByLanguage.set(fallbackLanguage, count);
      }
    }
  }

  waitForFallbackStart(
    deadlineMs: number,
    now: () => number,
    signal: AbortSignal | undefined,
    orderIndex: number,
  ): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(new Error('aborted'));
    }
    if (now() >= deadlineMs) {
      return Promise.reject(new Error('deadline_exceeded'));
    }

    if (this.activeNormalWork < this.maxConcurrency && this.fallbackStartWaiters.length === 0) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const remaining = Math.max(0, deadlineMs - now());

      const removeEntry = (): void => {
        const idx = this.fallbackStartWaiters.indexOf(entry);
        if (idx >= 0) {
          this.fallbackStartWaiters.splice(idx, 1);
        }
        cleanup();
      };

      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        removeEntry();
        reject(new Error('aborted'));
      };

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        removeEntry();
        reject(new Error('deadline_exceeded'));
      }, remaining);

      const cleanup = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };

      const entry: FallbackStartWaiter = {
        deadlineMs,
        now,
        signal,
        orderIndex,
        resolve: () => {
          if (settled) return false;
          settled = true;
          cleanup();
          resolve();
          return true;
        },
        reject: (err: unknown) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(err);
        },
      };

      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      this.fallbackStartWaiters.push(entry);
      if (this.activeNormalWork < this.maxConcurrency) {
        this.scheduleDrain();
      }
    });
  }

  async acquire(
    deadlineMs: number,
    now: () => number,
    signal: AbortSignal | undefined,
    fallbackLanguage: SteamLanguage | null,
  ): Promise<void> {
    if (signal?.aborted) {
      throw new Error('aborted');
    }
    if (now() >= deadlineMs) {
      throw new Error('deadline_exceeded');
    }

    const sameLangActive =
      fallbackLanguage !== null ? (this.activeFallbackByLanguage.get(fallbackLanguage) ?? 0) : 0;

    // Fast path when a slot is available, no waiters are queued, and this language has no active
    // fallback chunk yet. Additional chunks for an already-active language yield one microtask
    // through the fair waiter queue so peer languages or direct-AppID metadata arriving on the
    // same tick are never starved, while idle slots are still claimed immediately when uncontested.
    if (
      this.activeLowPriority < this.getCapacity() &&
      this.waiters.length === 0 &&
      sameLangActive === 0
    ) {
      this.takeSlot(fallbackLanguage);
      return;
    }

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const remaining = Math.max(0, deadlineMs - now());

      const removeEntry = (): void => {
        const idx = this.waiters.indexOf(entry);
        if (idx >= 0) {
          this.waiters.splice(idx, 1);
        }
        cleanup();
      };

      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        removeEntry();
        reject(new Error('aborted'));
      };

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        removeEntry();
        reject(new Error('deadline_exceeded'));
      }, remaining);

      const cleanup = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };

      const entry: LowPriorityWaiter = {
        deadlineMs,
        now,
        signal,
        fallbackLanguage,
        resolve: () => {
          if (settled) return false;
          settled = true;
          cleanup();
          resolve();
          return true;
        },
        reject: (err: unknown) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(err);
        },
      };

      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      this.waiters.push(entry);
      if (this.activeLowPriority < this.getCapacity()) {
        this.scheduleDrain();
      }
    });
  }

  release(fallbackLanguage: SteamLanguage | null): void {
    this.dropSlot(fallbackLanguage);
    this.drain();
  }

  private waiterPriorityScore(waiter: LowPriorityWaiter): number {
    if (waiter.fallbackLanguage === null) {
      return -1;
    }
    return this.activeFallbackByLanguage.get(waiter.fallbackLanguage) ?? 0;
  }

  private drain(): void {
    // 1. Prune and wake Stage B fallback starters once runnable Stage A work leaves an idle slot.
    let fIdx = 0;
    while (fIdx < this.fallbackStartWaiters.length) {
      const waiter = this.fallbackStartWaiters[fIdx]!;
      if (waiter.signal?.aborted) {
        this.fallbackStartWaiters.splice(fIdx, 1);
        waiter.reject(new Error('aborted'));
        continue;
      }
      if (waiter.now() >= waiter.deadlineMs) {
        this.fallbackStartWaiters.splice(fIdx, 1);
        waiter.reject(new Error('deadline_exceeded'));
        continue;
      }
      fIdx++;
    }
    if (this.activeNormalWork < this.maxConcurrency && this.fallbackStartWaiters.length > 0) {
      const ready = this.fallbackStartWaiters
        .splice(0, this.fallbackStartWaiters.length)
        .sort((a, b) => a.orderIndex - b.orderIndex);
      for (const waiter of ready) {
        waiter.resolve();
      }
    }

    // 2. Prune aborted/expired low-priority metadata waiters.
    let i = 0;
    while (i < this.waiters.length) {
      const waiter = this.waiters[i]!;
      if (waiter.signal?.aborted) {
        this.waiters.splice(i, 1);
        waiter.reject(new Error('aborted'));
        continue;
      }
      if (waiter.now() >= waiter.deadlineMs) {
        this.waiters.splice(i, 1);
        waiter.reject(new Error('deadline_exceeded'));
        continue;
      }
      i++;
    }

    // 3. Grant idle slots fairly: direct-AppID optional metadata first, then fallback languages
    //    with the fewest currently active chunks, falling back to FIFO. Never permanently caps
    //    same-language chunks to 1 when capacity is available.
    while (this.activeLowPriority < this.getCapacity() && this.waiters.length > 0) {
      let bestIdx = 0;
      let bestScore = this.waiterPriorityScore(this.waiters[0]!);
      for (let j = 1; j < this.waiters.length; j++) {
        const score = this.waiterPriorityScore(this.waiters[j]!);
        if (score < bestScore) {
          bestScore = score;
          bestIdx = j;
        }
      }
      const waiter = this.waiters.splice(bestIdx, 1)[0]!;
      this.takeSlot(waiter.fallbackLanguage);
      if (!waiter.resolve()) {
        this.dropSlot(waiter.fallbackLanguage);
      }
    }
  }
}

/**
 * Ephemeral state scoped strictly to ONE MCP tool call.
 * Released as soon as the tool call finishes — zero cross-call game data caching.
 */
export interface ToolCallScope {
  readonly execCtx: RequestExecutionContext;
  readonly metadataCache: Map<string, StoreItemMetadata>;
  readonly metadataInFlight: Map<string, MetadataInFlightEntry>;
  readonly lowPriorityGate: LowPriorityGate;
  fallbackMetadataBatchesUsed: number;
  ownedPromise: Promise<SourceFetchResult<OwnedListData>> | null;
  ownedSettled: boolean;
  ownedIncludesAppInfo: boolean;
  wishlistPromise: Promise<SourceFetchResult<WishlistListData>> | null;
  wishlistSettled: boolean;
}

export interface PageResult<T> {
  readonly total: number;
  readonly returned: number;
  readonly offset: number;
  readonly limit: number;
  readonly hasMore: boolean;
  readonly items: T[];
}

export function deduplicateAndSortOwned(records: readonly OwnedGameRecord[]): OwnedGameRecord[] {
  const byAppId = new Map<number, OwnedGameRecord>();
  for (const record of records) {
    const existing = byAppId.get(record.appid);
    if (!existing) {
      byAppId.set(record.appid, record);
    } else {
      byAppId.set(record.appid, {
        appid: existing.appid,
        name: existing.name ?? record.name,
        playtimeForever: existing.playtimeForever ?? record.playtimeForever,
      });
    }
  }
  return [...byAppId.values()].sort((a, b) => a.appid - b.appid);
}

export function deduplicateAndSortWishlist(records: readonly WishlistRecord[]): WishlistRecord[] {
  const byAppId = new Map<number, WishlistRecord>();
  for (const record of records) {
    const existing = byAppId.get(record.appid);
    if (!existing) {
      byAppId.set(record.appid, record);
    } else {
      byAppId.set(record.appid, {
        appid: existing.appid,
        priority: existing.priority ?? record.priority,
        dateAdded: existing.dateAdded ?? record.dateAdded,
      });
    }
  }

  return [...byAppId.values()].sort((a, b) => {
    if (a.priority === null && b.priority !== null) return 1;
    if (a.priority !== null && b.priority === null) return -1;
    if (a.priority !== null && b.priority !== null && a.priority !== b.priority) {
      return a.priority - b.priority;
    }
    return a.appid - b.appid;
  });
}

export function paginateList<T>(items: readonly T[], offset: number, limit: number): PageResult<T> {
  const total = items.length;
  const sliced = items.slice(offset, offset + limit);
  const returned = sliced.length;
  const hasMore = offset + returned < total;
  return {
    total,
    returned,
    offset,
    limit,
    hasMore,
    items: sliced,
  };
}

/**
 * Stateless service for live owned-library and wishlist fetches.
 * Shares in-flight Promises only within a single ToolCallScope.
 */
export class LibraryService {
  private readonly steam: SteamApiClient;
  private readonly config: ServerConfig;
  private readonly now: () => number;

  constructor(steam: SteamApiClient, config: ServerConfig, now: () => number = () => Date.now()) {
    this.steam = steam;
    this.config = config;
    this.now = now;
  }

  createScope(signal?: AbortSignal): ToolCallScope {
    return {
      execCtx: {
        deadlineMs: this.now() + this.config.toolTimeoutMs,
        signal,
      },
      metadataCache: new Map(),
      metadataInFlight: new Map(),
      lowPriorityGate: new LowPriorityGate(this.config.maxConcurrency),
      fallbackMetadataBatchesUsed: 0,
      ownedPromise: null,
      ownedSettled: false,
      ownedIncludesAppInfo: false,
      wishlistPromise: null,
      wishlistSettled: false,
    };
  }

  getOwnedList(
    scope: ToolCallScope,
    options: { includeAppInfo: boolean },
  ): Promise<SourceFetchResult<OwnedListData>> {
    if (scope.ownedPromise !== null) {
      return scope.ownedPromise;
    }

    scope.ownedIncludesAppInfo = options.includeAppInfo;
    scope.lowPriorityGate.onCollectionStarted();
    scope.ownedPromise = (async (): Promise<SourceFetchResult<OwnedListData>> => {
      try {
        const res = await this.steam.getOwnedGames(scope.execCtx, {
          includeAppInfo: options.includeAppInfo,
        });
        const sorted = deduplicateAndSortOwned(res.games);
        const appidSet = new Set<number>(sorted.map((g) => g.appid));
        return {
          ok: true,
          data: {
            games: sorted,
            appidSet,
            gameCount: res.gameCount,
          },
          dataStatus: 'ok',
          errorCode: null,
          fetchedAt: res.fetchedAt,
          message: null,
        };
      } catch (err) {
        const clientErr =
          err instanceof SteamClientError
            ? err
            : new SteamClientError({
                dataStatus: 'error',
                errorCode: 'upstream_error',
                endpoint: 'GetOwnedGames',
                message: 'Failed to fetch owned games from Steam.',
              });
        return {
          ok: false,
          data: null,
          dataStatus: clientErr.dataStatus === 'ok' ? 'error' : clientErr.dataStatus,
          errorCode: clientErr.errorCode,
          fetchedAt: new Date(this.now()).toISOString(),
          message: clientErr.message,
        };
      } finally {
        scope.ownedSettled = true;
        scope.lowPriorityGate.onCollectionSettled();
      }
    })();

    return scope.ownedPromise;
  }

  getWishlist(scope: ToolCallScope): Promise<SourceFetchResult<WishlistListData>> {
    if (scope.wishlistPromise !== null) {
      return scope.wishlistPromise;
    }

    scope.lowPriorityGate.onCollectionStarted();
    scope.wishlistPromise = (async (): Promise<SourceFetchResult<WishlistListData>> => {
      try {
        const res = await this.steam.getWishlist(scope.execCtx);
        const sorted = deduplicateAndSortWishlist(res.items);
        const appidSet = new Set<number>(sorted.map((item) => item.appid));
        return {
          ok: true,
          data: {
            items: sorted,
            appidSet,
          },
          dataStatus: 'ok',
          errorCode: null,
          fetchedAt: res.fetchedAt,
          message: null,
        };
      } catch (err) {
        const clientErr =
          err instanceof SteamClientError
            ? err
            : new SteamClientError({
                dataStatus: 'error',
                errorCode: 'upstream_error',
                endpoint: 'GetWishlist',
                message: 'Failed to fetch wishlist from Steam.',
              });
        return {
          ok: false,
          data: null,
          dataStatus: clientErr.dataStatus === 'ok' ? 'error' : clientErr.dataStatus,
          errorCode: clientErr.errorCode,
          fetchedAt: new Date(this.now()).toISOString(),
          message: clientErr.message,
        };
      } finally {
        scope.wishlistSettled = true;
        scope.lowPriorityGate.onCollectionSettled();
      }
    })();

    return scope.wishlistPromise;
  }
}
