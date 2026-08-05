import type { SettingsService } from '../settings/settings.service';
import { DirectoryMappingSource, OidcMappingSource } from './directory-mapping-source';
import type { MappingSource } from './roles.service';

/** A settings service answering exactly what describeOidc needs to return. */
function settingsReporting(
  view: {
    source: 'database' | 'environment' | 'unset';
    roleMappings: Array<{ group: string; role: string }>;
  } | null,
): SettingsService {
  return {
    describeOidc: async () =>
      view === null
        ? { source: 'unset', config: null }
        : { source: view.source, config: { roleMappings: view.roleMappings } },
  } as unknown as SettingsService;
}

describe('OidcMappingSource', () => {
  it('reports nothing when OIDC is not configured', async () => {
    expect(await new OidcMappingSource(settingsReporting(null)).all()).toEqual([]);
  });

  /**
   * The case that matters for #110: every OIDC deployment today configures
   * through the environment, so a source that only saw stored rows would leave
   * the deletion guard exactly as blind as it was.
   */
  it('sees mappings that came from the environment, not just stored ones', async () => {
    const source = new OidcMappingSource(
      settingsReporting({
        source: 'environment',
        roleMappings: [{ group: 'auditors', role: 'auditor' }],
      }),
    );

    expect(await source.all()).toEqual([
      { groupDn: 'auditors', role: 'auditor', source: 'environment', provider: 'oidc' },
    ]);
  });

  it('marks a stored configuration as such, so the message points at the right place', async () => {
    const source = new OidcMappingSource(
      settingsReporting({ source: 'database', roleMappings: [{ group: 'ops', role: 'OPERATOR' }] }),
    );

    expect((await source.all())[0]?.source).toBe('database');
  });

  /**
   * Fails OPEN, deliberately: a settings read that throws must not leave an
   * administrator unable to delete a role that nothing references.
   */
  it('reports nothing when the settings cannot be read', async () => {
    const broken = {
      describeOidc: async () => {
        throw new Error('database is down');
      },
    } as unknown as SettingsService;

    expect(await new OidcMappingSource(broken).all()).toEqual([]);
  });
});

describe('DirectoryMappingSource', () => {
  const fixed = (
    entries: Array<{ groupDn: string; role: string; provider: string }>,
  ): MappingSource => ({
    all: async () => entries.map((e) => ({ ...e, source: 'environment' as const })),
  });

  it('returns every directory’s mappings, so the guard sees all of them', async () => {
    const composite = new DirectoryMappingSource(
      fixed([{ groupDn: 'cn=ops,dc=example,dc=test', role: 'OPERATOR', provider: 'ldap' }]),
      fixed([{ groupDn: 'auditors', role: 'auditor', provider: 'oidc' }]),
    );

    const all = await composite.all();

    expect(all).toHaveLength(2);
    expect(all.map((m) => m.provider).sort()).toEqual(['ldap', 'oidc']);
  });

  it('is empty when no directory is configured', async () => {
    expect(await new DirectoryMappingSource(fixed([]), fixed([])).all()).toEqual([]);
  });
});
