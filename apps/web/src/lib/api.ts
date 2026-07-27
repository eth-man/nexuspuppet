import type { DeploymentCapabilities } from '@nexuspuppet/contracts';

/**
 * Server-side API client.
 *
 * The web tier holds no database credentials and no PuppetDB certificate
 * (C4 L2, ADR-0008). Everything goes through the API, which is the only place
 * authorization is decided.
 *
 * API_INTERNAL_URL is read at call time and never exposed to the browser — it
 * is not prefixed NEXT_PUBLIC_ for that reason.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Present on 501 responses: the capability this deployment lacks. */
    readonly capability?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function apiBase(): string {
  const base = process.env['API_INTERNAL_URL'];
  if (base === undefined || base === '') {
    throw new Error('API_INTERNAL_URL is not configured for the web tier.');
  }
  return base.replace(/\/$/, '');
}

interface FetchOptions {
  /**
   * Caching is explicit at every call site. Next 15+ no longer caches fetch by
   * default, and classification reads must never be cached — showing stale
   * classification after a save would misrepresent the estate (ADR-0008).
   */
  revalidateSeconds?: number;
  tags?: string[];
}

export async function apiGet<T>(path: string, options: FetchOptions = {}): Promise<T> {
  const { revalidateSeconds, tags } = options;

  const response = await fetch(`${apiBase()}${path}`, {
    headers: { accept: 'application/json' },
    next:
      revalidateSeconds === undefined
        ? { revalidate: 0 }
        : { revalidate: revalidateSeconds, ...(tags === undefined ? {} : { tags }) },
  });

  if (!response.ok) {
    let capability: string | undefined;
    let message = `${response.status} ${response.statusText}`;

    try {
      const body: unknown = await response.json();
      if (body !== null && typeof body === 'object') {
        const record = body as Record<string, unknown>;
        if (typeof record['message'] === 'string') message = record['message'];
        if (typeof record['capability'] === 'string') capability = record['capability'];
      }
    } catch {
      // Non-JSON error body; the status line is enough.
    }

    throw new ApiError(response.status, message, capability);
  }

  return (await response.json()) as T;
}

/** Drives which enterprise features the UI offers. A UI affordance only — the
 *  API rejects unavailable capabilities independently (ADR-0002). */
export function getCapabilities(): Promise<DeploymentCapabilities> {
  return apiGet<DeploymentCapabilities>('/capabilities', { revalidateSeconds: 60 });
}
