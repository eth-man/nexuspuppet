import { Injectable } from '@nestjs/common';
import type { BlockingRoleMapping } from '@nexuspuppet/contracts';
import { SettingsService } from '../settings/settings.service';
import type { MappingSource } from './roles.service';

/**
 * The directory mappings, read through the settings seam.
 *
 * Core cannot parse the enterprise layer's LDAP environment variables
 * (ADR-0002), and it does not have to: `describeLdap()` already answers with
 * whatever is in force — a stored configuration, or the running provider's own
 * report of what it was built from (#70). Both carry the mappings, and both
 * know which they are.
 *
 * FAILS OPEN, deliberately, and this is the one place that is right. If the
 * settings cannot be read, this reports no blocking mappings and a deletion
 * proceeds. The alternative is refusing every deletion whenever the directory
 * configuration is unreadable — turning a reporting failure into an
 * administrative one, and leaving an operator unable to tidy up a role that
 * nothing references.
 */
@Injectable()
export class LdapMappingSource implements MappingSource {
  constructor(private readonly settings: SettingsService) {}

  async all(): Promise<Array<BlockingRoleMapping & { role: string }>> {
    try {
      const view = await this.settings.describeLdap();
      if (view.config === null) return [];

      const source: BlockingRoleMapping['source'] =
        view.source === 'database' ? 'database' : 'environment';

      return view.config.roleMappings.map((mapping) => ({
        groupDn: mapping.groupDn,
        role: mapping.role,
        source,
      }));
    } catch {
      return [];
    }
  }
}
