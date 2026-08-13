import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/**
 * The id shared by everything written while serving ONE request (#229).
 *
 * WHY ASYNC LOCAL STORAGE RATHER THAN A PARAMETER. Twenty call sites write
 * audit rows, across six services, and most are several frames below the
 * controller that knows which request it is. Threading an id through all of
 * them would touch every signature in between, and — worse — the first place
 * somebody forgot to pass it would produce a row that silently belongs to no
 * operation. A row missing from a correlation query is invisible in exactly the
 * way this feature exists to prevent.
 *
 * So the id is set once, at the edge, and read once, in the sink. Nothing in
 * between knows it exists.
 *
 * NULL IS A LEGITIMATE ANSWER. Audit rows are also written outside any request
 * — bootstrap, the retention sweeper, background workers. Those genuinely
 * belong to no request, and inventing an id for them would imply an operation a
 * reader could go and look for.
 */
const storage = new AsyncLocalStorage<{ requestId: string }>();

/**
 * Run `fn` with a fresh request id in scope.
 *
 * Returns the id as well so a caller can put it on a response header, which is
 * what makes an operator's "it failed at 14:32" line up with the trail.
 */
export function runWithRequestId<T>(fn: (requestId: string) => T): T {
  const requestId = randomUUID();
  return storage.run({ requestId }, () => fn(requestId));
}

/** The current request's id, or null outside a request. */
export function currentRequestId(): string | null {
  return storage.getStore()?.requestId ?? null;
}
