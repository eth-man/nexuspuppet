'use client';

/**
 * Browser-side API access.
 *
 * Everything goes to same-origin `/api/*`, which the route handler relays to
 * the API server-side (C4 L2). The browser never learns the API address and
 * never holds a token — session cookies are HttpOnly and travel automatically.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** PuppetDB is down but classification still works (ADR-0004 §6). */
  get isPuppetDbUnavailable(): boolean {
    return this.code === 'PUPPETDB_UNAVAILABLE';
  }

  get isUnauthenticated(): boolean {
    return this.status === 401;
  }

  get isForbidden(): boolean {
    return this.status === 403;
  }
}

interface ErrorBody {
  message?: unknown;
  error?: unknown;
  issues?: unknown;
}

async function toError(response: Response): Promise<ApiError> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return new ApiError(response.status, `${response.status} ${response.statusText}`);
  }

  const record = (body ?? {}) as ErrorBody;
  const message =
    typeof record.message === 'string'
      ? record.message
      : `${response.status} ${response.statusText}`;
  const code = typeof record.error === 'string' ? record.error : undefined;

  return new ApiError(response.status, message, code, body);
}

/**
 * A single in-flight refresh shared by all callers.
 *
 * Without this, a page that fires six queries on mount would issue six parallel
 * refreshes on expiry. Refresh tokens ROTATE and reuse revokes the whole family
 * (ADR-0006), so five of those six would present an already-consumed token —
 * and the user would be logged out by their own dashboard loading.
 */
let refreshInFlight: Promise<boolean> | null = null;

async function refreshSession(): Promise<boolean> {
  refreshInFlight ??= (async () => {
    try {
      const response = await fetch('/api/auth/refresh', {
        method: 'POST',
        credentials: 'same-origin',
      });
      return response.ok;
    } catch {
      return false;
    } finally {
      // Cleared on the next tick so concurrent callers all observe the same
      // result before a new attempt can begin.
      setTimeout(() => {
        refreshInFlight = null;
      }, 0);
    }
  })();

  return refreshInFlight;
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
  /** Internal: prevents a refresh loop. */
  retrying?: boolean;
}

export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, signal, retrying = false } = options;

  const response = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(signal === undefined ? {} : { signal }),
  });

  if (response.ok) {
    return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
  }

  const error = await toError(response);

  // The API distinguishes an expired token from an invalid one precisely so the
  // client can refresh instead of bouncing the user to a login screen.
  if (error.status === 401 && error.code === 'TOKEN_EXPIRED' && !retrying) {
    if (await refreshSession()) {
      return apiFetch<T>(path, { ...options, retrying: true });
    }
  }

  throw error;
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal): Promise<T> =>
    apiFetch<T>(path, signal === undefined ? {} : { signal }),
  post: <T>(path: string, body?: unknown): Promise<T> =>
    apiFetch<T>(path, { method: 'POST', body }),
  put: <T>(path: string, body?: unknown): Promise<T> => apiFetch<T>(path, { method: 'PUT', body }),
  patch: <T>(path: string, body?: unknown): Promise<T> =>
    apiFetch<T>(path, { method: 'PATCH', body }),
  delete: <T>(path: string): Promise<T> => apiFetch<T>(path, { method: 'DELETE' }),
};
