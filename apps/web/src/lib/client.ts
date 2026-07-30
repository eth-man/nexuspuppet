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
  const base =
    typeof record.message === 'string'
      ? record.message
      : `${response.status} ${response.statusText}`;
  const code = typeof record.error === 'string' ? record.error : undefined;

  return new ApiError(response.status, withIssues(base, record.issues), code, body);
}

/**
 * Append the actual validation failures to the message.
 *
 * The API answers a rejected body with `{ message: "Invalid request
 * parameters", issues: [{ path, message }] }`. Only the first half was ever
 * shown, so a mistyped class name reported "Invalid request parameters" — which
 * names neither the field nor the reason, and is barely more useful than the
 * 500 it replaced.
 *
 * Capped at three: a form with a dozen bad fields should not render a wall of
 * text where a message belongs.
 */
function withIssues(message: string, issues: unknown): string {
  if (!Array.isArray(issues) || issues.length === 0) return message;

  const described = issues
    .slice(0, 3)
    .map((issue) => {
      const { path, message: detail } = (issue ?? {}) as { path?: unknown; message?: unknown };
      if (typeof detail !== 'string') return null;
      return typeof path === 'string' && path !== '' ? `${path}: ${detail}` : detail;
    })
    .filter((entry): entry is string => entry !== null);

  if (described.length === 0) return message;

  const more =
    issues.length > described.length ? ` (+${issues.length - described.length} more)` : '';
  return `${message} — ${described.join('; ')}${more}`;
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

  // ANY 401, not just TOKEN_EXPIRED.
  //
  // This used to require `error.code === 'TOKEN_EXPIRED'`, which the API only
  // sends when it receives an access token that has expired. The common case
  // never gets that far: the access cookie carries `expires` equal to the
  // token's own lifetime, so at 15 minutes the BROWSER deletes it and the next
  // request arrives carrying no token at all. The guard answers a bare 401
  // "Authentication required.", the condition above was false, and the operator
  // was bounced to the login screen — with a refresh cookie valid for another
  // thirty days sitting untouched in the jar.
  //
  // Reported as "constantly having to sign back in", and visible in a QA soak
  // as 1,731 console 401s. Proven by dropping only the access cookie: the app
  // went to /login without ever calling /api/auth/refresh.
  //
  // Keying on the code was the mistake, not the value of the code. The client
  // had to guess which of three 401 shapes the server would choose, and got it
  // wrong for the one that actually happens. Refreshing on any 401 needs no
  // such agreement: if the refresh cookie is good the request succeeds, and if
  // it is not, /auth/refresh fails and we fall through to the same place we
  // would have anyway — one wasted request on a genuinely anonymous caller.
  if (error.status === 401 && !retrying && !path.startsWith('/auth/refresh')) {
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
