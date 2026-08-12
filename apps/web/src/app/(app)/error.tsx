'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { AlertTriangle } from 'lucide-react';

/**
 * A render-time throw inside the console.
 *
 * React unmounts the whole subtree when a render throws, so without a boundary
 * the operator gets Next's default error screen — white, unstyled, outside the
 * shell — for what may be one broken panel on an otherwise working page. This
 * keeps the sidebar and offers a retry, because most of these are transient.
 *
 * This does NOT catch errors thrown in event handlers or in the query layer;
 * React boundaries never see those. Failed requests are handled where they
 * happen, by `QueryError`. This is the backstop for the ones nothing expected.
 */
export default function ConsoleError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // The rendered page deliberately does not show `error.message` — a thrown
    // string can carry a certname, a fact value, or a parameter, and this
    // screen is as likely to be photographed into a ticket as read. The console
    // has the detail for whoever is actually debugging.
    console.error('[console] unhandled render error', error);
  }, [error]);

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
      <AlertTriangle className="size-5 text-state-failed" aria-hidden />

      <div className="space-y-1.5">
        <p className="text-sm text-ink">This page failed to render</p>
        <p className="max-w-md text-xs text-ink-muted">
          Nothing was changed. Classification and Puppet agent runs are unaffected — this console
          only reads and writes through the API, and a page that fails to draw has not submitted
          anything.
        </p>
        {error.digest !== undefined && (
          <p className="pt-1 font-mono text-2xs text-ink-faint">
            Reference: {error.digest}
            <span className="ml-1.5 font-sans">— quote this in a bug report</span>
          </p>
        )}
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={reset}
          className="rounded border border-line bg-panel px-3 py-1.5 text-xs text-ink transition-colors hover:bg-panel-raised"
        >
          Try again
        </button>
        <Link
          href="/"
          className="rounded px-3 py-1.5 text-xs text-ink-muted transition-colors hover:text-ink"
        >
          Back to the dashboard
        </Link>
      </div>
    </div>
  );
}
