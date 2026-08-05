import { Injectable } from '@nestjs/common';
import type { BlockingRoleMapping } from '@nexuspuppet/contracts';
import { SettingsService } from '../settings/settings.service';
import type { MappingSource } from './roles.service';

/**
 * The OIDC role mappings, read through the settings seam (#110).
 *
 * Same arrangement and same fail-open rule as the LDAP source: core cannot
 * parse `OIDC_*` (ADR-0002), so it asks `describeOidc()`, which answers from a
 * stored row if one exists and otherwise from the running provider's own report
 * — which is how an environment-configured deployment, meaning every one of
 * them today, still gets its mappings seen.
 *
 * FAILS OPEN for the reason the LDAP source does: a settings read that fails
 * must not turn into an administrator unable to delete a role that nothing
 * references.
 */
@Injectable()
export class OidcMappingSource implements MappingSource {
  constructor(private readonly settings: SettingsService) {}

  async all(): Promise<Array<BlockingRoleMapping & { role: string }>> {
    try {
      const view = await this.settings.describeOidc();
      if (view.config === null) return [];

      const source: BlockingRoleMapping['source'] =
        view.source === 'database' ? 'database' : 'environment';

      return view.config.roleMappings.map((mapping) => ({
        // A claim value, not a DN. The field is named for LDAP's shape because
        // it predates the second provider; `provider` is what disambiguates.
        groupDn: mapping.group,
        role: mapping.role,
        source,
        provider: 'oidc',
      }));
    } catch {
      return [];
    }
  }
}

/**
 * Every directory's mappings, as one source.
 *
 * ADR-0018 §5 requires that deleting a role a mapping names is refused — and
 * says nothing about which directory configured it. `RolesService` therefore
 * takes one `MappingSource`, and this composes the providers behind it so
 * adding a third changes this list and nothing else.
 *
 * The guarantee was LDAP-only until now, and the gap was inert while OIDC could
 * name nothing but built-in roles: built-ins are not deletable, so there was
 * nothing to guard. Widening OIDC mappings to role names made it live.
 */
@Injectable()
export class DirectoryMappingSource implements MappingSource {
  private readonly sources: readonly MappingSource[];

  constructor(...sources: MappingSource[]) {
    this.sources = sources;
  }

  async all(): Promise<Array<BlockingRoleMapping & { role: string }>> {
    const collected = await Promise.all(this.sources.map((source) => source.all()));
    return collected.flat();
  }
}
