/**
 * Dependency-injection tokens for every seam in NexusPuppet.
 *
 * A seam is an interface in this package plus a token here, bound to exactly
 * one implementation in apps/api/src/app.module.ts. They exist because they
 * keep authentication, authorization, audit and storage independently
 * testable — a consumer depends on the interface, and a test hands it a fake —
 * not because anything outside the API replaces them (ADR-0027).
 *
 * Tokens are unique symbols so that two copies of this package cannot silently
 * resolve to different providers.
 */

/**
 * The single declaration of every seam.
 *
 * One object rather than seven independent exports, so the runtime list and the
 * type below are DERIVED from it and cannot drift apart. Adding a seam here
 * adds it to both, which is what lets the container tests cover a new token
 * without anyone remembering to update them.
 *
 * The individual exports beneath are unchanged — same names, same Symbol.for
 * identities — so nothing that already imports them notices.
 */
const TOKENS = {
  AUTH_PROVIDER: Symbol.for('nexuspuppet.AuthProvider'),
  AUTHORIZATION_POLICY: Symbol.for('nexuspuppet.AuthorizationPolicy'),
  USER_DIRECTORY: Symbol.for('nexuspuppet.UserDirectory'),
  AUDIT_SINK: Symbol.for('nexuspuppet.AuditSink'),
  PUPPETDB_CLIENT: Symbol.for('nexuspuppet.PuppetDbClient'),
  ENC_FILE_WRITER: Symbol.for('nexuspuppet.EncFileWriter'),
  AUDIT_TRANSPORT: Symbol.for('nexuspuppet.AuditTransport'),
  AUTH_PROVIDERS: Symbol.for('nexuspuppet.AuthProviders'),
} as const;

export const AUTH_PROVIDER = TOKENS.AUTH_PROVIDER;
export const AUTHORIZATION_POLICY = TOKENS.AUTHORIZATION_POLICY;
export const USER_DIRECTORY = TOKENS.USER_DIRECTORY;
export const AUDIT_SINK = TOKENS.AUDIT_SINK;
export const PUPPETDB_CLIENT = TOKENS.PUPPETDB_CLIENT;
export const ENC_FILE_WRITER = TOKENS.ENC_FILE_WRITER;
export const AUDIT_TRANSPORT = TOKENS.AUDIT_TRANSPORT;

/**
 * Every authentication provider this deployment can dispatch to (ADR-0015).
 *
 * PLURAL, and additive. `AUTH_PROVIDER` is a single binding that a directory
 * provider used to replace, which meant enabling a directory did not shadow
 * local authentication — it removed it, and locked every local account out with
 * no way back short of writing to the database by hand.
 *
 * The local provider is always the first member of this list, and the wiring
 * test asserts it, so an administrator can always get in. A login is
 * dispatched by the account's `authSource` matching a provider's `source`;
 * nothing chains or falls back.
 */
export const AUTH_PROVIDERS = TOKENS.AUTH_PROVIDERS;

/**
 * The Postgres audit sink, exposed so the forwarding sink can COMPOSE over it.
 *
 * Not in `TOKENS`: nothing replaces this, the forwarding sink bound to
 * AUDIT_SINK depends on it. It delegates the transactional Postgres write here
 * and then enqueues the record for forwarding, without owning a database write
 * of its own.
 *
 * The alternative was a forwarding sink that OWNS the write, which would mean
 * replacing the local audit trail rather than adding to it. An estate should not
 * lose its Postgres audit log because it gained a SIEM.
 */
export const CORE_AUDIT_SINK = Symbol.for('nexuspuppet.CoreAuditSink');

/**
 * The queue that carries an audit record to an external system.
 *
 * Also not in `TOKENS`: the outbox owns the storage and the worker, and the
 * forwarding sink uses this to enqueue. A token so the sink depends on the
 * interface, and is unit-tested against a fake queue.
 */
export const AUDIT_DELIVERY_OUTBOX = Symbol.for('nexuspuppet.AuditDeliveryOutbox');

/**
 * The resolver for stored audit-forwarding settings (ADR-0016 §5).
 *
 * The forwarding transport asks it which transport is active and with what
 * configuration — secrets included, server-side only. A token for the same
 * reason as the outbox above: the transport is tested against a fake.
 */
export const AUDIT_FORWARDING_SETTINGS = Symbol.for('nexuspuppet.AuditForwardingSettings');

/**
 * The reader for stored authentication-provider settings (ADR-0016 §4).
 *
 * A directory provider asks it what an operator has configured, through this
 * interface so the provider is tested against a fake store.
 *
 * This is what makes ADR-0016 §4's claim true. Without it a provider snapshots
 * its configuration at construction, and everything saved through the settings
 * screen is displayed back and never applied — which is what the screen looked
 * like it was doing, and was not.
 */
export const AUTH_PROVIDER_SETTINGS = Symbol.for('nexuspuppet.AuthProviderSettings');

/**
 * Every seam, enumerable at runtime.
 *
 * Exists so a test can assert properties of ALL of them — that each has exactly
 * one binding, and that nothing bypasses one by injecting its implementation
 * directly. Both defects have shipped here before; enumerating the tokens is
 * what turns finding them from an audit into a permanent guarantee.
 */
export const CAPABILITY_TOKENS: readonly symbol[] = Object.values(TOKENS);

/** Name for a token, for messages that have to say WHICH seam is wrong. */
export function capabilityTokenName(token: symbol): string {
  return Object.entries(TOKENS).find(([, value]) => value === token)?.[0] ?? String(token);
}

export type CapabilityToken = (typeof TOKENS)[keyof typeof TOKENS];
