import { getCapabilities, ApiError } from '@/lib/api';

/**
 * Walking-skeleton landing page: proves the web -> api hop and renders the
 * degraded state explicitly rather than as an empty page.
 *
 * The "API unreachable" branch is deliberate. Per ADR-0004, an unavailable
 * dependency is a named UI state showing what still works — never a blank
 * table or an endless spinner.
 */
export default async function HomePage() {
  let edition = 'unknown';
  let capabilities: string[] = [];
  let error: string | null = null;

  try {
    const deployment = await getCapabilities();
    edition = deployment.edition;
    capabilities = deployment.capabilities;
  } catch (caught) {
    error =
      caught instanceof ApiError
        ? `API returned ${caught.status}: ${caught.message}`
        : caught instanceof Error
          ? caught.message
          : 'Unknown error';
  }

  return (
    <main className="mx-auto max-w-4xl px-6 py-16">
      <h1 className="text-2xl font-semibold tracking-tight">NexusPuppet</h1>
      <p className="mt-2 text-sm text-slate-400">
        Puppet estate console — inventory, reports, and node classification.
      </p>

      {error === null ? (
        <dl className="mt-10 grid grid-cols-[max-content_1fr] gap-x-6 gap-y-3 text-sm">
          <dt className="text-slate-400">Edition</dt>
          <dd className="font-mono">{edition}</dd>
          <dt className="text-slate-400">Capabilities</dt>
          <dd className="font-mono">
            {capabilities.length > 0 ? capabilities.join(', ') : 'core only'}
          </dd>
        </dl>
      ) : (
        <div
          role="alert"
          className="mt-10 rounded-md border border-amber-700/50 bg-amber-950/30 p-4 text-sm"
        >
          <p className="font-medium text-amber-300">API unreachable</p>
          <p className="mt-1 font-mono text-xs text-amber-200/80">{error}</p>
          <p className="mt-3 text-slate-400">
            Classification already written to disk is unaffected — Puppet agent runs continue
            against the last materialized state.
          </p>
        </div>
      )}
    </main>
  );
}
