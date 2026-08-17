/**
 * Reading the class list from puppetserver (ADR-0024).
 *
 * A SUGGESTION SOURCE, never a source of truth. Everything here is optional at
 * runtime: with `PUPPETSERVER_URL` unset no client exists, and every consumer
 * must behave exactly as it did before this file — free-text class names and a
 * JSON parameter box (ADR-0024 §9).
 */

/** How a parameter's default was expressed in the manifest. */
export type ClassParameterDefaultKind =
  /** A literal we can prefill: `default_literal` was present. */
  | 'literal'
  /**
   * An expression, not a value — `default_source` began with `$`, so the
   * default references another variable and resolves at compile time.
   *
   * Foreman's Smart Proxy rewrites these to `${…}` rather than treating them as
   * strings, because prefilling `$facts` as the literal text "$facts" would be
   * quietly wrong. We show the source as a hint and prefill nothing.
   */
  | 'expression'
  /**
   * Declared `= undef`, which IS a default — the parameter may be omitted.
   *
   * REPORTED BY AN OPERATOR, because the first version of this called it
   * `required`. `Optional[String[1]] $cloud = undef` is optional: the `= undef`
   * is what makes it so. A parameter with no `=` at all is the required one, and
   * conflating the two told people four optional parameters were mandatory —
   * and claimed "6 required parameters" on a class that has two.
   *
   * Distinct from `expression` because there is nothing to evaluate and nothing
   * to show: the honest label is "optional", not "defaults to undef, computed at
   * compile time".
   */
  | 'undef'
  /** No default of any kind — no `=` in the declaration. Genuinely REQUIRED. */
  | 'required';

export interface ClassParameterSuggestion {
  name: string;
  /** Puppet type signature verbatim, e.g. `Enum['absent', 'present']`. */
  type: string | null;
  kind: ClassParameterDefaultKind;
  /** Present only when `kind` is `literal`. Safe to prefill. */
  defaultValue?: unknown;
  /** Raw manifest text of the default. Shown as a hint, never prefilled. */
  defaultSource?: string;
  /**
   * Options parsed out of an `Enum[...]` type, so the form can render a select
   * rather than a free-text box. Empty when the type is not an enum.
   */
  enumValues: string[];
}

export interface ClassSuggestion {
  name: string;
  /** Manifest the class was declared in — the answer to "which module?". */
  path: string | null;
  params: ClassParameterSuggestion[];
}

/**
 * A manifest puppetserver could not parse.
 *
 * Reported rather than swallowed: one broken file must not blank the picker,
 * and an operator whose class is missing deserves to know the file is at fault
 * rather than concluding the feature is broken (ADR-0024, prior art).
 */
export interface ClassFileError {
  path: string | null;
  message: string;
}

/** Why the suggestion list is unavailable or incomplete. */
export type ClassIndexStatus =
  /** Suggestions are live. */
  | 'ok'
  /** `PUPPETSERVER_URL` is unset. The feature is off; say nothing. */
  | 'disabled'
  /** puppetserver refused us — almost always a missing `auth.conf` rule. */
  | 'forbidden'
  /** Timed out, refused, TLS failure, 50x. */
  | 'unavailable';

export interface ClassIndex {
  status: ClassIndexStatus;
  /** The environment these suggestions describe. Never assume `production`. */
  environment: string;
  classes: ClassSuggestion[];
  /** Manifests that failed to parse. Non-empty means the list is incomplete. */
  fileErrors: ClassFileError[];
  /**
   * When this was fetched, ISO-8601, or null when never fetched.
   *
   * SHOWN, not hidden. A list that is a few minutes stale is harmless; one that
   * looks authoritative and is silently wrong is not (ADR-0024 §6).
   */
  fetchedAt: string | null;
  /** True when served from cache rather than fetched during this request. */
  cached: boolean;
  /**
   * Operator-facing explanation for any status other than `ok` — including the
   * `auth.conf` rule to add on a 403. Never a raw stack trace.
   */
  message?: string;
  /**
   * Set by a refresh that produced a byte-identical list.
   *
   * The two-cache trap of ADR-0024 §8: with `environment-class-cache-enabled`
   * on, puppetserver keeps serving pre-deployment classes until its own
   * environment cache is flushed. Without this the refresh looks broken.
   */
  unchangedAfterRefresh?: boolean;
}

/**
 * Injection token for the puppetserver client.
 *
 * DELIBERATELY NOT IN `TOKENS`/`CAPABILITY_TOKENS`. Those enumerate enterprise
 * SEAMS — each must have a core default and each is a place the enterprise layer
 * may legitimately substitute an implementation (ADR-0002, ADR-0006). This is
 * neither: it is an optional integration whose value is `null` when the operator
 * has not configured it, and which the enterprise layer has no business
 * replacing. Listing it there would have made "every seam has a core default"
 * mean less than it says.
 */
export const PUPPETSERVER_CLIENT = Symbol.for('nexuspuppet.PuppetServerClient');

/** Read-only, one endpoint. A second is a superseding ADR, not a new method. */
export interface IPuppetServerClient {
  /**
   * Classes in one environment.
   *
   * `etag` is an optimisation only. puppetserver returns one solely when
   * `environment-class-cache-enabled` is true, which is off by default, so
   * every caller must work without it (ADR-0024 §6).
   */
  listEnvironmentClasses(
    environment: string,
    etag: string | null,
  ): Promise<{ notModified: boolean; body: unknown; etag: string | null }>;
}

/** Thrown when puppetserver refuses, times out, or cannot be reached. */
export class PuppetServerUnavailableError extends Error {
  readonly statusCode: number | null;

  constructor(message: string, options: { statusCode?: number | null; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'PuppetServerUnavailableError';
    this.statusCode = options.statusCode ?? null;
  }
}
