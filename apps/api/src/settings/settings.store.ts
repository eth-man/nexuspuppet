import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * A Prisma client that may be the service or a caller's transaction (#103).
 *
 * Structural and NARROW — only the model this store touches — so a future edit
 * cannot reach unrelated tables from inside somebody else's transaction.
 *
 * Accepted by the WRITE methods only, deliberately. `resolve` and `describe`
 * read the row back, and a read that must see an uncommitted write needs the
 * same client; until they take one too, the four `save` call sites cannot be
 * wrapped without their audit `after` payload silently reporting the OLD value.
 * See the note on #103.
 */
export type SettingsWriteClient = Pick<PrismaService, 'providerSetting'>;
import { SecretBoxError, open, parseKey, seal } from './secret-box';

/**
 * The configurations an operator may store (ADR-0016 §1).
 *
 * A closed set, not an open key/value store. Anything here is something the
 * console renders and validates; a caller cannot invent a kind and have it
 * silently persisted.
 */
export const SETTING_KINDS = [
  'auth.ldap',
  /**
   * READ-ONLY today. Nothing writes this kind: an auth provider snapshots its
   * configuration at construction, so a stored row would be displayed and never
   * applied. It exists so `describe` resolves the same way for both directory
   * providers — from a row if one ever exists, otherwise from the running
   * provider's own report.
   */
  'auth.oidc',
  'audit.syslog',
  'audit.webhook',
  /** The operator's transport choice — which of the two audit kinds delivers. */
  'audit.forwarding',
  /**
   * Where operational notifications are POSTed (ADR-0021).
   *
   * SEPARATE from `audit.webhook`, which is not an accident of naming. That one
   * exists under `audit.export` and carries audit records; this one is core and
   * carries conditions only. Sharing a destination would make the boundary a
   * convention rather than something the transports enforce.
   */
  'notifications.webhook',
  /** The mail relay operational notifications go through (ADR-0021 §4). */
  'notifications.email',
] as const;
export type SettingKind = (typeof SETTING_KINDS)[number];

/** Where a resolved configuration came from. Reported to the console. */
export type SettingSource = 'database' | 'environment' | 'unset';

export interface ResolvedSetting<T> {
  source: SettingSource;
  /** Absent when `source` is 'unset'. */
  config: T | null;
  /** Whether a stored row exists and is switched off. */
  disabled: boolean;
  updatedAt: Date | null;
  updatedByEmail: string | null;
  /** Names of secret fields held for this kind. Never their values. */
  secretsHeld: string[];
}

export class SettingsStoreError extends Error {}

/**
 * Reads and writes configuration an operator can change from the console.
 *
 * TWO RULES, both from ADR-0016 §2, and both easier to get wrong than they look:
 *
 * 1. **Per configuration, never per field.** A kind resolves entirely from the
 *    database or entirely from the environment. Merging them produces a state
 *    no operator can reproduce from either source, and a bug report nobody can
 *    act on.
 * 2. **`SETTINGS_SOURCE=env` wins over everything.** Without that escape hatch,
 *    a configuration saved through the console that does not work leaves an
 *    operator unable to authenticate *and* unable to override it.
 */
@Injectable()
export class SettingsStore {
  private readonly logger = new Logger(SettingsStore.name);

  /** Null when no CONFIG_ENCRYPTION_KEY is configured. */
  private readonly key: Buffer | null;

  constructor(
    private readonly prisma: PrismaService,
    encryptionKey: string | undefined,
    private readonly forcedSource: 'db' | 'env' = 'db',
  ) {
    this.key = encryptionKey === undefined ? null : parseKey(encryptionKey);

    if (this.forcedSource === 'env') {
      // Loud, because it silently ignores everything an operator saved through
      // the console. Somebody who set it during a recovery and forgot will
      // otherwise spend an afternoon wondering why the UI has no effect.
      this.logger.warn(
        'SETTINGS_SOURCE=env — stored settings are ignored and the environment is authoritative.',
      );
    }
  }

  /** Whether stored secrets are possible at all in this deployment. */
  get canStoreSecrets(): boolean {
    return this.key !== null;
  }

  /**
   * Resolve one configuration.
   *
   * `fromEnv` supplies the environment baseline and is only consulted when no
   * usable stored row exists — never merged with one.
   */
  async resolve<T>(kind: SettingKind, fromEnv: () => T | null): Promise<ResolvedSetting<T>> {
    const envConfig = (): ResolvedSetting<T> => {
      const config = fromEnv();
      return {
        source: config === null ? 'unset' : 'environment',
        config,
        disabled: false,
        updatedAt: null,
        updatedByEmail: null,
        secretsHeld: [],
      };
    };

    if (this.forcedSource === 'env') return envConfig();

    const row = await this.prisma.providerSetting.findUnique({ where: { kind } });
    if (row === null) return envConfig();

    if (!row.enabled) {
      // A stored row that is switched off is NOT the same as an absent one.
      // Falling back to the environment here would resurrect a configuration an
      // operator deliberately turned off — which is the opposite of what the
      // switch is for.
      return {
        source: 'database',
        config: null,
        disabled: true,
        updatedAt: row.updatedAt,
        updatedByEmail: row.updatedByEmail,
        secretsHeld: [],
      };
    }

    const secrets = this.openSecrets(kind, row.secrets);

    return {
      source: 'database',
      // Secrets are merged into the config object HERE and nowhere else — this
      // is the only place the two halves come together, and the result never
      // leaves the server.
      config: { ...(row.config as object), ...secrets } as T,
      disabled: false,
      updatedAt: row.updatedAt,
      updatedByEmail: row.updatedByEmail,
      secretsHeld: Object.keys(secrets),
    };
  }

  /**
   * What the console may see: configuration without secret values.
   *
   * Deliberately a separate method rather than a flag on `resolve`. A boolean
   * that decides whether a response contains credentials is one careless call
   * site away from leaking them; two methods with different return types are
   * not.
   */
  async describe<T>(kind: SettingKind, fromEnv: () => T | null): Promise<ResolvedSetting<T>> {
    const resolved = await this.resolve<T>(kind, fromEnv);
    if (resolved.config === null) return resolved;

    const redacted = { ...(resolved.config as Record<string, unknown>) };
    for (const field of resolved.secretsHeld) delete redacted[field];

    return { ...resolved, config: redacted as T };
  }

  /**
   * Store a configuration, splitting secrets from the rest.
   *
   * `secretFields` names which keys are secret; everything else is stored in
   * clear. Naming them at the call site rather than inferring from the value
   * means a new field is a deliberate decision about whether it is sensitive,
   * not an accident of what it happens to be called.
   */
  /**
   * @param tx join a caller's transaction (#103, ADR-0005).
   *
   * Safe ONLY where the caller does not read the row back to build its audit
   * payload. `describe`/`resolve` still read on this.prisma, so a caller that
   * re-reads inside the transaction sees the pre-write state.
   */
  async save(
    kind: SettingKind,
    config: Record<string, unknown>,
    secretFields: readonly string[],
    updatedByEmail: string,
    tx?: SettingsWriteClient,
  ): Promise<void> {
    const db = tx ?? this.prisma;
    const secrets: Record<string, unknown> = {};
    const plain: Record<string, unknown> = {};

    for (const [name, value] of Object.entries(config)) {
      if (secretFields.includes(name)) {
        // An absent secret means "keep the stored one", not "set it to
        // undefined" — the console never sends back a value it was not given.
        if (value !== undefined && value !== null && value !== '') secrets[name] = value;
      } else {
        plain[name] = value;
      }
    }

    const hasSecrets = Object.keys(secrets).length > 0;

    if (hasSecrets && this.key === null) {
      throw new SettingsStoreError(
        'This configuration holds a secret, and CONFIG_ENCRYPTION_KEY is not set. ' +
          'Generate one with `openssl rand -base64 32` and restart before saving credentials.',
      );
    }

    const existing = await db.providerSetting.findUnique({ where: { kind } });
    const carriedForward = existing === null ? {} : this.openSecrets(kind, existing.secrets);
    const merged = { ...carriedForward, ...secrets };

    const sealed =
      this.key !== null && Object.keys(merged).length > 0
        ? Buffer.from(seal(this.key, merged))
        : null;

    await db.providerSetting.upsert({
      where: { kind },
      create: { kind, config: plain as object, secrets: sealed, updatedByEmail },
      update: { config: plain as object, secrets: sealed, updatedByEmail },
    });
  }

  /** Switch a stored configuration off without discarding it. */
  async setEnabled(
    kind: SettingKind,
    enabled: boolean,
    updatedByEmail: string,
    tx?: SettingsWriteClient,
  ): Promise<void> {
    await (tx ?? this.prisma).providerSetting.update({
      where: { kind },
      data: { enabled, updatedByEmail },
    });
  }

  /**
   * Discard a stored configuration entirely, falling back to the environment.
   *
   * @param tx join a caller's transaction, so the change and its audit record
   * commit together and the sink can enqueue delivery (#103, ADR-0005).
   */
  async clear(kind: SettingKind, tx?: SettingsWriteClient): Promise<void> {
    await (tx ?? this.prisma).providerSetting.deleteMany({ where: { kind } });
  }

  private openSecrets(kind: SettingKind, sealed: Uint8Array | null): Record<string, unknown> {
    if (sealed === null || sealed.length === 0) return {};

    if (this.key === null) {
      // Refuse rather than continue without them. A deployment that believes it
      // is binding to a directory with stored credentials must not quietly bind
      // anonymously, or fall through to a different configuration.
      throw new SettingsStoreError(
        `Stored settings for "${kind}" hold encrypted secrets, but CONFIG_ENCRYPTION_KEY is not set. ` +
          'Set the key this deployment was configured with, or clear the stored settings.',
      );
    }

    try {
      return open<Record<string, unknown>>(this.key, Buffer.from(sealed));
    } catch (error) {
      if (error instanceof SecretBoxError) {
        throw new SettingsStoreError(
          `Stored settings for "${kind}" could not be decrypted: ${error.message}`,
        );
      }
      throw error;
    }
  }
}
