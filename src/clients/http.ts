import type { DataStatus, ErrorCode } from '../schemas.js';
import { PACKAGE_VERSION } from '../version.js';

export type SteamEndpointName = 'GetOwnedGames' | 'GetWishlist' | 'StoreSearch' | 'GetItems';

export interface SteamEndpointSpec {
  readonly name: SteamEndpointName;
  readonly host: 'api.steampowered.com' | 'store.steampowered.com';
  readonly path: string;
  readonly allowApiKey: boolean;
}

export const STEAM_ENDPOINTS: Readonly<Record<SteamEndpointName, SteamEndpointSpec>> = Object.freeze({
  GetOwnedGames: Object.freeze({
    name: 'GetOwnedGames',
    host: 'api.steampowered.com',
    path: '/IPlayerService/GetOwnedGames/v1/',
    allowApiKey: true,
  }),
  GetWishlist: Object.freeze({
    name: 'GetWishlist',
    host: 'api.steampowered.com',
    path: '/IWishlistService/GetWishlist/v1/',
    allowApiKey: false,
  }),
  StoreSearch: Object.freeze({
    name: 'StoreSearch',
    host: 'store.steampowered.com',
    path: '/api/storesearch/',
    allowApiKey: false,
  }),
  GetItems: Object.freeze({
    name: 'GetItems',
    host: 'api.steampowered.com',
    path: '/IStoreBrowseService/GetItems/v1/',
    allowApiKey: false,
  }),
});

export const USER_AGENT = `steam-collection-mcp/${PACKAGE_VERSION}`;
export const DEFAULT_MAX_RETRIES = 2;
export const DEFAULT_BASE_RETRY_DELAY_MS = 300;
export const MAX_RETRY_DELAY_MS = 10_000;

export function sanitizeSecretText(text: string, secrets: readonly string[]): string {
  let sanitized = text;
  for (const secret of secrets) {
    if (!secret) continue;
    sanitized = sanitized.split(secret).join('[REDACTED]');
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) {
      sanitized = sanitized.split(encoded).join('[REDACTED]');
    }
  }
  sanitized = sanitized.replace(/([?&]key=)[^&\s"'<>]+/gi, '$1[REDACTED]');
  sanitized = sanitized.replace(/\bkey=[^&\s"'<>]+/gi, 'key=[REDACTED]');
  sanitized = sanitized.replace(/(https?:\/\/[^\s"'<>?]+)\?[^\s"'<>]+/gi, '$1?[REDACTED]');
  return sanitized;
}

export class SteamClientError extends Error {
  readonly dataStatus: DataStatus;
  readonly errorCode: ErrorCode;
  readonly endpoint: SteamEndpointName;
  readonly httpStatus?: number;

  constructor(params: {
    dataStatus: DataStatus;
    errorCode: ErrorCode;
    endpoint: SteamEndpointName;
    message: string;
    httpStatus?: number;
  }) {
    super(params.message);
    this.name = 'SteamClientError';
    this.dataStatus = params.dataStatus;
    this.errorCode = params.errorCode;
    this.endpoint = params.endpoint;
    this.httpStatus = params.httpStatus;
  }
}

export interface RequestExecutionContext {
  readonly deadlineMs: number;
  readonly signal?: AbortSignal;
}

export type RequestPriority = 'high' | 'normal' | 'low';

interface SemaphoreWaiter {
  readonly signal?: AbortSignal;
  resolve: () => boolean;
  reject: (err: unknown) => void;
  cleanup: () => void;
}

export class Semaphore {
  private readonly max: number;
  private active = 0;
  private readonly highPriorityQueue: SemaphoreWaiter[] = [];
  private readonly normalPriorityQueue: SemaphoreWaiter[] = [];
  private readonly lowPriorityQueue: SemaphoreWaiter[] = [];

  constructor(max: number) {
    if (!Number.isInteger(max) || max < 1) {
      throw new RangeError('Semaphore max must be a positive integer.');
    }
    this.max = max;
  }

  async acquire(
    deadlineMs: number,
    now: () => number,
    signal?: AbortSignal,
    priority: RequestPriority | boolean = 'normal',
  ): Promise<void> {
    if (signal?.aborted) {
      throw new Error('aborted');
    }
    if (now() >= deadlineMs) {
      throw new Error('deadline_exceeded');
    }

    if (this.active < this.max) {
      this.active++;
      return;
    }

    const resolvedPriority: RequestPriority =
      typeof priority === 'boolean' ? (priority ? 'high' : 'normal') : priority;
    const targetQueue =
      resolvedPriority === 'high'
        ? this.highPriorityQueue
        : resolvedPriority === 'low'
          ? this.lowPriorityQueue
          : this.normalPriorityQueue;

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const remaining = Math.max(0, deadlineMs - now());

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

      const entry: SemaphoreWaiter = {
        signal,
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
        cleanup,
      };

      const removeEntry = (): void => {
        const idx = targetQueue.indexOf(entry);
        if (idx >= 0) {
          targetQueue.splice(idx, 1);
        }
        cleanup();
      };

      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      targetQueue.push(entry);
    });
  }

  release(): void {
    while (true) {
      const next =
        this.highPriorityQueue.shift() ??
        this.normalPriorityQueue.shift() ??
        this.lowPriorityQueue.shift();
      if (!next) {
        if (this.active > 0) {
          this.active--;
        }
        return;
      }
      if (next.signal?.aborted) {
        next.reject(new Error('aborted'));
        continue;
      }
      if (next.resolve()) {
        return;
      }
    }
  }
}

const PERMANENT_TLS_ERROR_CODES = new Set<string>([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_REVOKED',
  'CERT_UNTRUSTED',
  'CERT_REJECTED',
  'CERT_SIGNATURE_FAILURE',
  'CERT_CHAIN_TOO_LONG',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_TLS_INVALID_PROTOCOL_VERSION',
  'ERR_TLS_INVALID_PROTOCOL_METHOD',
  'ERR_TLS_REQUIRED_SERVER_NAME',
  'ERR_TLS_ALPN_CALLBACK_INVALID_RESULT',
  'ERR_SSL_CERTIFICATE_VERIFY_FAILED',
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'ERR_SSL_UNSUPPORTED_PROTOCOL',
  'ERR_SSL_NO_PROTOCOLS_AVAILABLE',
  'ERR_SSL_NO_CIPHER_MATCH',
  'ERR_SSL_TLSV1_ALERT_UNKNOWN_CA',
  'ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION',
  'ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE',
  'ERR_SSL_SSLV3_ALERT_BAD_CERTIFICATE',
  'ERR_SSL_SSLV3_ALERT_CERTIFICATE_EXPIRED',
  'ERR_SSL_SSLV3_ALERT_CERTIFICATE_UNKNOWN',
  'UNABLE_TO_GET_CRL',
  'CRL_NOT_YET_VALID',
  'CRL_HAS_EXPIRED',
  'INVALID_CA',
  'PATH_LENGTH_EXCEEDED',
  'INVALID_PURPOSE',
  'KEYUSAGE_NO_CERTSIGN',
  'HOSTNAME_MISMATCH',
]);

const PERMANENT_NON_TLS_ERROR_CODES = new Set<string>([
  'EACCES',
  'EPERM',
  'EAFNOSUPPORT',
  'EPROTONOSUPPORT',
  'EPROTOTYPE',
  'ESOCKTNOSUPPORT',
  'EPFNOSUPPORT',
  'EOPNOTSUPP',
  'ENOTSUP',
  'EADDRNOTAVAIL',
  'EINVAL',
  'ENOPROTOOPT',
  'ENOTSOCK',
  'EDESTADDRREQ',
  'EMSGSIZE',
  'ERR_INVALID_URL',
  'ERR_INVALID_PROTOCOL',
  'ERR_INVALID_ARG_TYPE',
  'ERR_INVALID_ARG_VALUE',
  'ERR_UNESCAPED_CHARACTERS',
  'ERR_INVALID_CHAR',
  'HPE_INVALID_METHOD',
  'HPE_INVALID_URL',
  'HPE_INVALID_VERSION',
  'UND_ERR_INVALID_ARG',
  'UND_ERR_INVALID_RETURN_VALUE',
  'UND_ERR_NOT_SUPPORTED',
  'UND_ERR_REQ_CONTENT_LENGTH_MISMATCH',
]);

function isPermanentTlsCode(code: string): boolean {
  return (
    PERMANENT_TLS_ERROR_CODES.has(code) ||
    code.startsWith('ERR_TLS_CERT_') ||
    code.startsWith('ERR_SSL_') ||
    code.startsWith('CERT_') ||
    code.startsWith('UNABLE_TO_VERIFY_') ||
    code.startsWith('UNABLE_TO_GET_ISSUER_CERT') ||
    code.includes('SELF_SIGNED')
  );
}

function classifyFailureNode(
  node: unknown,
  visited: Set<unknown>,
  depth: number,
): { readonly permanent: boolean; readonly isTls: boolean } {
  if (node === null || node === undefined || typeof node !== 'object' || depth > 8) {
    return { permanent: false, isTls: false };
  }
  if (visited.has(node)) {
    return { permanent: false, isTls: false };
  }
  visited.add(node);

  const rec = node as { code?: unknown; cause?: unknown; errors?: unknown };
  let selfPermanentNonTls = false;
  if (typeof rec.code === 'string' && rec.code.length > 0) {
    const code = rec.code.toUpperCase();
    if (isPermanentTlsCode(code)) {
      return { permanent: true, isTls: true };
    }
    if (PERMANENT_NON_TLS_ERROR_CODES.has(code)) {
      selfPermanentNonTls = true;
    }
  }

  let causePermanentNonTls = false;
  if (rec.cause !== undefined) {
    const causeClass = classifyFailureNode(rec.cause, visited, depth + 1);
    if (causeClass.isTls) {
      return causeClass;
    }
    causePermanentNonTls = causeClass.permanent;
  }

  let errorsPermanentNonTls = false;
  if (Array.isArray(rec.errors) && rec.errors.length > 0) {
    let allPermanent = true;
    for (const inner of rec.errors) {
      const innerClass = classifyFailureNode(inner, visited, depth + 1);
      if (innerClass.isTls) {
        return innerClass;
      }
      if (!innerClass.permanent) {
        allPermanent = false;
      }
    }
    errorsPermanentNonTls = allPermanent;
  }

  return {
    permanent: selfPermanentNonTls || causePermanentNonTls || errorsPermanentNonTls,
    isTls: false,
  };
}

/**
 * Classifies fetch/transport exceptions using structured Node/OpenSSL/Undici error codes
 * along the cause chain (including AggregateError.errors) without logging upstream details.
 * Permanent TLS/certificate errors, local permission denials (e.g. EACCES/EPERM), and
 * permanent address/protocol/configuration errors are never retried.
 * Transient socket/timeout failures and generic fetch rejections remain retryable within budget.
 */
export function classifyFetchFailure(err: unknown): {
  readonly permanent: boolean;
  readonly isTls: boolean;
} {
  return classifyFailureNode(err, new Set<unknown>(), 0);
}

export function parseRetryAfterMs(headerValue: string | null, nowMs: number): number | null {
  if (!headerValue) {
    return null;
  }
  const trimmed = headerValue.trim();
  if (/^[0-9]+$/.test(trimmed)) {
    const seconds = Number.parseInt(trimmed, 10);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return seconds * 1000;
    }
    return null;
  }
  const parsedDate = Date.parse(trimmed);
  if (Number.isFinite(parsedDate)) {
    return Math.max(0, parsedDate - nowMs);
  }
  return null;
}

export type FetchFn = typeof globalThis.fetch;

export interface SteamHttpClientOptions {
  readonly httpTimeoutMs: number;
  readonly maxConcurrency: number;
  readonly secrets?: readonly string[];
  readonly maxRetries?: number;
  readonly baseRetryDelayMs?: number;
  readonly fetchFn?: FetchFn;
  readonly now?: () => number;
  readonly random?: () => number;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new Error('aborted'));
  }
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function makeCancelledError(endpointName: SteamEndpointName, suffix = ''): SteamClientError {
  return new SteamClientError({
    dataStatus: 'unavailable',
    errorCode: 'timeout',
    endpoint: endpointName,
    message: `Request to ${endpointName} was cancelled${suffix}.`,
  });
}

function buildAllowlistedUrl(
  spec: SteamEndpointSpec,
  params: Readonly<Record<string, string>>,
): URL {
  const url = new URL(`https://${spec.host}${spec.path}`);

  for (const [k, v] of Object.entries(params)) {
    if (!spec.allowApiKey && k.toLowerCase() === 'key') {
      throw new SteamClientError({
        dataStatus: 'error',
        errorCode: 'upstream_error',
        endpoint: spec.name,
        message: `Refusing to attach API key to anonymous endpoint ${spec.name}.`,
      });
    }
    url.searchParams.set(k, v);
  }

  // Re-verify allowlist invariants after serialization
  if (
    url.protocol !== 'https:' ||
    url.hostname !== spec.host ||
    url.pathname !== spec.path ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== ''
  ) {
    throw new SteamClientError({
      dataStatus: 'error',
      errorCode: 'upstream_error',
      endpoint: spec.name,
      message: `Blocked non-allowlisted Steam URL for ${spec.name}.`,
    });
  }

  if (!spec.allowApiKey && url.searchParams.has('key')) {
    throw new SteamClientError({
      dataStatus: 'error',
      errorCode: 'upstream_error',
      endpoint: spec.name,
      message: `Blocked API key on anonymous endpoint ${spec.name}.`,
    });
  }

  return url;
}

export class SteamHttpClient {
  private readonly httpTimeoutMs: number;
  private readonly maxRetries: number;
  private readonly baseRetryDelayMs: number;
  private readonly secrets: readonly string[];
  private readonly semaphore: Semaphore;
  private readonly fetchFn: FetchFn;
  readonly now: () => number;
  private readonly random: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(options: SteamHttpClientOptions) {
    this.httpTimeoutMs = options.httpTimeoutMs;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.baseRetryDelayMs = options.baseRetryDelayMs ?? DEFAULT_BASE_RETRY_DELAY_MS;
    this.secrets = options.secrets ?? [];
    this.semaphore = new Semaphore(options.maxConcurrency);
    this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? (() => Date.now());
    this.random = options.random ?? (() => Math.random());
    this.sleep = options.sleep ?? defaultSleep;
  }

  sanitize(text: string): string {
    return sanitizeSecretText(text, this.secrets);
  }

  async getJson(
    endpointName: SteamEndpointName,
    params: Readonly<Record<string, string>>,
    ctx: RequestExecutionContext,
    options?: { readonly priority?: RequestPriority; readonly highPriority?: boolean },
  ): Promise<{ data: unknown; fetchedAt: string }> {
    const spec = STEAM_ENDPOINTS[endpointName];
    const url = buildAllowlistedUrl(spec, params);
    const priority: RequestPriority =
      options?.priority ?? (options?.highPriority === true ? 'high' : 'normal');

    let lastError: SteamClientError | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (ctx.signal?.aborted) {
        throw makeCancelledError(endpointName);
      }

      const remainingBeforeAcquire = ctx.deadlineMs - this.now();
      if (remainingBeforeAcquire <= 0) {
        throw (
          lastError ??
          new SteamClientError({
            dataStatus: 'unavailable',
            errorCode: 'timeout',
            endpoint: endpointName,
            message: `Tool timeout deadline exceeded before calling ${endpointName}.`,
          })
        );
      }

      try {
        await this.semaphore.acquire(ctx.deadlineMs, this.now, ctx.signal, priority);
      } catch (acquireErr) {
        if (
          ctx.signal?.aborted ||
          (acquireErr instanceof Error && acquireErr.message === 'aborted')
        ) {
          throw makeCancelledError(endpointName);
        }
        throw (
          lastError ??
          new SteamClientError({
            dataStatus: 'unavailable',
            errorCode: 'timeout',
            endpoint: endpointName,
            message: `Tool timeout deadline exceeded while waiting to call ${endpointName}.`,
          })
        );
      }

      let retryable = false;
      let retryAfterMs: number | null = null;

      try {
        // Re-check cancellation immediately after slot acquisition/handoff before starting fetch
        if (ctx.signal?.aborted) {
          throw makeCancelledError(endpointName);
        }

        const remainingForFetch = ctx.deadlineMs - this.now();
        if (remainingForFetch <= 0) {
          throw (
            lastError ??
            new SteamClientError({
              dataStatus: 'unavailable',
              errorCode: 'timeout',
              endpoint: endpointName,
              message: `Tool timeout deadline exceeded for ${endpointName}.`,
            })
          );
        }

        const attemptTimeoutMs = Math.min(this.httpTimeoutMs, remainingForFetch);
        const attemptController = new AbortController();
        let timedOut = false;

        const onParentAbort = (): void => {
          attemptController.abort();
        };
        ctx.signal?.addEventListener('abort', onParentAbort, { once: true });

        let timer: ReturnType<typeof setTimeout> | null = null;
        try {
          // Guard the listener-registration / fetch-initialization window against immediate aborts
          if (ctx.signal?.aborted) {
            throw makeCancelledError(endpointName);
          }

          timer = setTimeout(() => {
            timedOut = true;
            attemptController.abort();
          }, attemptTimeoutMs);

          let response: Response;
          try {
            response = await this.fetchFn(url.toString(), {
              method: 'GET',
              headers: {
                Accept: 'application/json',
                'User-Agent': USER_AGENT,
              },
              redirect: 'manual',
              credentials: 'omit',
              signal: attemptController.signal,
            });
          } catch (err) {
            if (ctx.signal?.aborted) {
              throw makeCancelledError(endpointName);
            }

            if (timedOut) {
              lastError = new SteamClientError({
                dataStatus: 'unavailable',
                errorCode: 'timeout',
                endpoint: endpointName,
                message: `Request to ${endpointName} timed out after ${attemptTimeoutMs}ms.`,
              });
              retryable = true;
            } else {
              const classification = classifyFetchFailure(err);
              if (classification.permanent) {
                lastError = new SteamClientError({
                  dataStatus: 'error',
                  errorCode: 'upstream_error',
                  endpoint: endpointName,
                  message: classification.isTls
                    ? `TLS certificate verification failed calling ${endpointName}.`
                    : `Permanent request error calling ${endpointName}.`,
                });
                retryable = false;
              } else {
                const rawMsg = err instanceof Error ? err.message : 'network error';
                const safeMsg = this.sanitize(rawMsg);
                lastError = new SteamClientError({
                  dataStatus: 'error',
                  errorCode: 'upstream_error',
                  endpoint: endpointName,
                  message: `Network error calling ${endpointName}: ${safeMsg}`,
                });
                retryable = true;
              }
            }
            // Break into retry decision below
            response = null as unknown as Response;
          }

          if (response) {
            if (ctx.signal?.aborted) {
              await drainBodyQuietly(response);
              throw makeCancelledError(endpointName);
            }

            const status = response.status;

            // Block redirects (never follow redirects that could leak API key or leave allowlist)
            if (status >= 300 && status < 400) {
              await drainBodyQuietly(response);
              throw new SteamClientError({
                dataStatus: 'error',
                errorCode: 'upstream_error',
                endpoint: endpointName,
                httpStatus: status,
                message: `Blocked unexpected HTTP redirect (${status}) from ${endpointName}.`,
              });
            }

            if (status === 429) {
              retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'), this.now());
              await drainBodyQuietly(response);
              lastError = new SteamClientError({
                dataStatus: 'rate_limited',
                errorCode: 'rate_limited',
                endpoint: endpointName,
                httpStatus: status,
                message: `Steam ${endpointName} rate limited the request (HTTP 429).`,
              });
              retryable = true;
            } else if (status >= 500 && status <= 599) {
              await drainBodyQuietly(response);
              lastError = new SteamClientError({
                dataStatus: 'error',
                errorCode: 'upstream_error',
                endpoint: endpointName,
                httpStatus: status,
                message: `Steam ${endpointName} returned server error HTTP ${status}.`,
              });
              retryable = true;
            } else if (status === 401) {
              await drainBodyQuietly(response);
              throw new SteamClientError({
                dataStatus: 'unavailable',
                errorCode: spec.allowApiKey ? 'invalid_api_key' : 'access_denied',
                endpoint: endpointName,
                httpStatus: status,
                message: spec.allowApiKey
                  ? `Steam ${endpointName} rejected authentication (HTTP 401). Check STEAM_API_KEY.`
                  : `Steam ${endpointName} denied access (HTTP 401).`,
              });
            } else if (status === 403) {
              const bodyText = await readBodyTextSafely(response);
              const looksLikeInvalidKey =
                spec.allowApiKey && /\bkey\b/i.test(bodyText) && /access is denied|verify/i.test(bodyText);
              throw new SteamClientError({
                dataStatus: 'unavailable',
                errorCode: looksLikeInvalidKey ? 'invalid_api_key' : 'access_denied',
                endpoint: endpointName,
                httpStatus: status,
                message: looksLikeInvalidKey
                  ? `Steam ${endpointName} rejected the Steam Web API key (HTTP 403).`
                  : `Steam ${endpointName} denied access (HTTP 403).`,
              });
            } else if (status < 200 || status >= 300) {
              await drainBodyQuietly(response);
              throw new SteamClientError({
                dataStatus: 'error',
                errorCode: 'upstream_error',
                endpoint: endpointName,
                httpStatus: status,
                message: `Steam ${endpointName} returned HTTP ${status}.`,
              });
            } else {
              // 2xx response — read and parse JSON within the attempt timeout
              let rawText: string;
              try {
                rawText = await response.text();
              } catch (readErr) {
                if (ctx.signal?.aborted) {
                  throw makeCancelledError(endpointName);
                }
                if (timedOut) {
                  lastError = new SteamClientError({
                    dataStatus: 'unavailable',
                    errorCode: 'timeout',
                    endpoint: endpointName,
                    message: `Timed out reading response body from ${endpointName}.`,
                  });
                  retryable = true;
                  rawText = '';
                } else {
                  const classification = classifyFetchFailure(readErr);
                  if (classification.permanent) {
                    throw new SteamClientError({
                      dataStatus: 'error',
                      errorCode: 'upstream_error',
                      endpoint: endpointName,
                      message: classification.isTls
                        ? `TLS certificate verification failed reading response from ${endpointName}.`
                        : `Permanent error reading response from ${endpointName}.`,
                    });
                  }
                  const safeMsg = this.sanitize(readErr instanceof Error ? readErr.message : 'stream error');
                  lastError = new SteamClientError({
                    dataStatus: 'error',
                    errorCode: 'upstream_error',
                    endpoint: endpointName,
                    message: `Failed reading response from ${endpointName}: ${safeMsg}`,
                  });
                  retryable = true;
                  rawText = '';
                }
              }

              if (!retryable) {
                if (ctx.signal?.aborted) {
                  throw makeCancelledError(endpointName);
                }
                let parsed: unknown;
                try {
                  parsed = JSON.parse(rawText);
                } catch {
                  throw new SteamClientError({
                    dataStatus: 'error',
                    errorCode: 'invalid_response',
                    endpoint: endpointName,
                    httpStatus: status,
                    message: `Steam ${endpointName} returned invalid JSON.`,
                  });
                }

                const fetchedAt = new Date(this.now()).toISOString();
                return { data: parsed, fetchedAt };
              }
            }
          }
        } finally {
          if (timer !== null) {
            clearTimeout(timer);
          }
          ctx.signal?.removeEventListener('abort', onParentAbort);
        }
      } finally {
        this.semaphore.release();
      }

      if (ctx.signal?.aborted) {
        throw makeCancelledError(endpointName);
      }

      if (!retryable || attempt >= this.maxRetries) {
        throw (
          lastError ??
          new SteamClientError({
            dataStatus: 'error',
            errorCode: 'upstream_error',
            endpoint: endpointName,
            message: `Request to ${endpointName} failed.`,
          })
        );
      }

      // Compute exponential backoff with jitter, honoring Retry-After and total call deadline
      const expDelay = this.baseRetryDelayMs * 2 ** attempt;
      const jitter = Math.floor(this.random() * this.baseRetryDelayMs);
      const backoffMs = Math.min(MAX_RETRY_DELAY_MS, expDelay + jitter);
      const waitMs = retryAfterMs !== null ? Math.max(retryAfterMs, backoffMs) : backoffMs;

      const remainingAfterAttempt = ctx.deadlineMs - this.now();
      if (waitMs >= remainingAfterAttempt || remainingAfterAttempt <= 0) {
        throw (
          lastError ??
          new SteamClientError({
            dataStatus: 'unavailable',
            errorCode: 'timeout',
            endpoint: endpointName,
            message: `Insufficient time remaining before tool deadline to retry ${endpointName}.`,
          })
        );
      }

      try {
        await this.sleep(waitMs, ctx.signal);
      } catch {
        throw makeCancelledError(endpointName, ' during retry backoff');
      }
    }

    throw (
      lastError ??
      new SteamClientError({
        dataStatus: 'error',
        errorCode: 'upstream_error',
        endpoint: endpointName,
        message: `Request to ${endpointName} exhausted retries.`,
      })
    );
  }
}

async function drainBodyQuietly(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // ignore cleanup failures
  }
}

async function readBodyTextSafely(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, 512);
  } catch {
    return '';
  }
}
