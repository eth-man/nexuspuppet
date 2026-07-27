'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { ApiError } from '@/lib/client';

/**
 * TanStack Query configuration for an ops console.
 *
 * The defaults are tuned for a tool someone leaves open on a second monitor:
 * data should look live without hammering PuppetDB, and an authorization
 * failure must never be retried in a loop.
 */
export function QueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Inventory and reports are read constantly; a short stale window
            // keeps navigation instant without refetching on every hover.
            staleTime: 15_000,
            refetchOnWindowFocus: true,
            retry: (failureCount, error) => {
              // Retrying a 401/403 achieves nothing and, on a rotating refresh
              // token, actively harms: it burns attempts against a session the
              // server has already rejected.
              if (error instanceof ApiError) {
                if (error.isUnauthenticated || error.isForbidden) return false;
                // PuppetDB being down is a state to render, not a transient
                // blip to retry behind a spinner (ADR-0004 §6).
                if (error.isPuppetDbUnavailable) return false;
                if (error.status >= 400 && error.status < 500) return false;
              }
              return failureCount < 2;
            },
          },
          mutations: { retry: false },
        },
      }),
  );

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
