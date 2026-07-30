'use client';

import { useEffect } from 'react';

/**
 * The root layout itself threw.
 *
 * The last backstop. This replaces the root layout rather than rendering inside
 * it, which is why it must ship its own `<html>` and `<body>` — and why it
 * cannot use the shared components or the auth provider, since the failure may
 * be in exactly those.
 *
 * The theme is therefore inlined. Importing `globals.css` here would be one more
 * thing able to fail on the path that exists for when things have already
 * failed, and an operator seeing a white flash of unstyled text is the outcome
 * this file exists to prevent.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[console] fatal error', error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '1rem',
          padding: '1.5rem',
          textAlign: 'center',
          background: '#0b0f14',
          color: '#e6edf3',
          fontFamily: 'ui-sans-serif, system-ui, sans-serif',
        }}
      >
        <p style={{ fontSize: '0.875rem', margin: 0 }}>NexusPuppet could not start this page</p>
        <p style={{ fontSize: '0.75rem', margin: 0, maxWidth: '28rem', color: '#8b949e' }}>
          Reloading usually clears it. If it persists, the console is unavailable — Puppet agent
          runs and the ENC files on disk are unaffected, so the estate keeps converging without it.
        </p>
        {error.digest !== undefined && (
          <p
            style={{
              fontSize: '0.6875rem',
              margin: 0,
              color: '#6e7681',
              fontFamily: 'ui-monospace, monospace',
            }}
          >
            Reference: {error.digest}
          </p>
        )}
        <button
          type="button"
          onClick={reset}
          style={{
            fontSize: '0.75rem',
            padding: '0.375rem 0.75rem',
            borderRadius: '0.25rem',
            border: '1px solid #21262d',
            background: '#0d1117',
            color: '#e6edf3',
            cursor: 'pointer',
          }}
        >
          Reload
        </button>
      </body>
    </html>
  );
}
