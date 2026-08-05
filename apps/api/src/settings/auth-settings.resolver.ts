import { Injectable } from '@nestjs/common';
import type { IAuthProviderSettings } from '@nexuspuppet/contracts';
import { SETTING_KINDS, SettingsStore, type SettingKind } from './settings.store';

/**
 * What `AUTH_PROVIDER_SETTINGS` binds to: stored auth configuration, nothing
 * else (ADR-0016 §4, issue #113).
 *
 * A deliberately tiny class, and separate from `SettingsService` for the reason
 * the audit forwarding resolver is separate from its service: the service
 * injects providers, and a provider injects this. Binding the token to the
 * service would close a dependency cycle the injector deadlocks on — silently,
 * and only where an enterprise provider is registered.
 *
 * ONLY A STORED ROW OVERRIDES. `resolve` answers null when nothing is stored or
 * when the environment is in force, because ADR-0016 §2 makes the environment
 * the bootstrap baseline and the provider was already built from it. Returning
 * the baseline here would be the same value by a longer path, and would make
 * `SETTINGS_SOURCE=env` — which the store already honours — look like it had
 * stopped working.
 */
@Injectable()
export class AuthSettingsResolver implements IAuthProviderSettings {
  constructor(private readonly store: SettingsStore) {}

  async resolve(source: string): Promise<unknown | null> {
    const kind = `auth.${source}`;
    if (!isSettingKind(kind)) return null;

    // Deliberately NOT caught. A store that cannot be read must reach the
    // provider as a failure, so it refuses the login rather than falling back
    // to a configuration an operator has replaced (see IAuthProviderSettings).
    const resolved = await this.store.resolve<unknown>(kind, () => null);

    return resolved.source === 'database' ? resolved.config : null;
  }
}

function isSettingKind(value: string): value is SettingKind {
  return (SETTING_KINDS as readonly string[]).includes(value);
}
