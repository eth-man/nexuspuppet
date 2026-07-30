import Link from 'next/link';
import { Compass } from 'lucide-react';

/**
 * An unmatched URL.
 *
 * Without this file Next.js serves its own 404: white background, system font,
 * no navigation, no indication of which product you are even looking at. Found
 * by the QA fuzzer walking to a route that does not exist — which is also what a
 * bookmark saved before a rename, a link in an old runbook, and a URL truncated
 * by a chat client all look like.
 *
 * It is deliberately NOT inside the console shell. Next resolves the root
 * `not-found` outside every route group, so it cannot know whether the visitor
 * is signed in and must not imply a session that may not exist. It stays on
 * brand and offers one way back; the dashboard link lands on the authenticated
 * shell, which redirects to sign-in if there is no session.
 */
export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 px-6 text-center">
      <Compass className="size-6 text-ink-faint" aria-hidden />

      <div className="space-y-1.5">
        <h1 className="text-sm font-medium text-ink">This page does not exist</h1>
        <p className="max-w-sm text-xs text-ink-muted">
          The address may be misspelled, or it may point at something that has since been renamed or
          deleted.
        </p>
      </div>

      <Link
        href="/"
        className="rounded border border-line bg-panel px-3 py-1.5 text-xs text-ink transition-colors hover:bg-panel-raised"
      >
        Go to the dashboard
      </Link>
    </main>
  );
}
