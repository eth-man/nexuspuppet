import type { SearchOptions } from 'ldapts';
import { ldapConfigSchema } from './config';
import { directoryIdFrom, guidFromObjectGuid } from './directory-id';
import { LdaptsDirectory, type LdapClientLike } from './ldap-client';

/**
 * The stable id an account is linked by (ADR-0031).
 *
 * The vectors are Microsoft's GUID layout — Data1 uint32, Data2 uint16, Data3
 * uint16 little-endian, then Data4 as eight bytes in order — and were checked
 * independently against Python's `uuid.UUID(bytes_le=…)`, which implements
 * exactly that layout.
 */
describe('AD objectGUID → canonical GUID string', () => {
  it('reverses the first three fields and keeps the last two in order', () => {
    const bytes = Buffer.from('33221100554477668899aabbccddeeff', 'hex');
    expect(guidFromObjectGuid(bytes)).toBe('00112233-4455-6677-8899-aabbccddeeff');
  });

  it('decodes a realistic GUID', () => {
    const bytes = Buffer.from('8a4b1d93f5c0e14a9b2a6c7d8e9f0a1b', 'hex');
    expect(guidFromObjectGuid(bytes)).toBe('931d4b8a-c0f5-4ae1-9b2a-6c7d8e9f0a1b');
  });

  it('is NOT the bytes read straight through — the mistake this exists to avoid', () => {
    const bytes = Buffer.from('8a4b1d93f5c0e14a9b2a6c7d8e9f0a1b', 'hex');
    expect(guidFromObjectGuid(bytes)).not.toBe('8a4b1d93-f5c0-e14a-9b2a-6c7d8e9f0a1b');
  });

  it('refuses anything that is not exactly 16 bytes', () => {
    expect(guidFromObjectGuid(Buffer.alloc(15))).toBeNull();
    expect(guidFromObjectGuid(Buffer.alloc(17))).toBeNull();
  });
});

describe('directoryIdFrom', () => {
  it('reads a binary objectGUID, alone or as the first of several values', () => {
    const bytes = Buffer.from('33221100554477668899aabbccddeeff', 'hex');
    expect(directoryIdFrom(bytes, true)).toBe('00112233-4455-6677-8899-aabbccddeeff');
    expect(directoryIdFrom([bytes], true)).toBe('00112233-4455-6677-8899-aabbccddeeff');
  });

  it('reads an OpenLDAP entryUUID, normalised to lower case', () => {
    expect(directoryIdFrom('9C1E7A4B-5D3F-4A2E-8B6C-1D2E3F4A5B6C', false)).toBe(
      '9c1e7a4b-5d3f-4a2e-8b6c-1d2e3f4a5b6c',
    );
    expect(directoryIdFrom(['9c1e7a4b-5d3f-4a2e-8b6c-1d2e3f4a5b6c'], false)).toBe(
      '9c1e7a4b-5d3f-4a2e-8b6c-1d2e3f4a5b6c',
    );
  });

  it('answers null for nothing, for the wrong kind, and for a string that is no UUID', () => {
    expect(directoryIdFrom(undefined, true)).toBeNull();
    expect(directoryIdFrom(undefined, false)).toBeNull();
    // An objectGUID decoded as text by mistake: mangled, and refused.
    expect(directoryIdFrom('3"\u0011\u0000', true)).toBeNull();
    expect(directoryIdFrom('not-a-uuid', false)).toBeNull();
  });
});

/** What the client asks the directory for, and how it reads the answer. */
describe('LdaptsDirectory entry attributes (ADR-0031)', () => {
  function recording(entry: Record<string, unknown>): {
    factory: () => LdapClientLike;
    searches: SearchOptions[];
  } {
    const searches: SearchOptions[] = [];
    const client: LdapClientLike = {
      startTLS: async () => {},
      bind: async () => {},
      search: async (_base, options) => {
        searches.push(options ?? {});
        return { searchEntries: [entry as never], searchReferences: [] };
      },
      unbind: async () => {},
    };
    return { factory: () => client, searches };
  }

  it('AD: asks for UPN, sAMAccountName and objectGUID — the GUID as a Buffer — and decodes it', async () => {
    const config = ldapConfigSchema.parse({
      url: 'ldaps://dc01.corp.local:636',
      searchBase: 'dc=corp,dc=local',
      dialect: 'ad',
    });
    const { factory, searches } = recording({
      dn: 'CN=Jane Doe,OU=People,DC=corp,DC=local',
      mail: [],
      displayName: 'Jane Doe',
      memberOf: ['CN=Ops,DC=corp,DC=local'],
      userPrincipalName: 'jdoe@corp.local',
      sAMAccountName: 'jdoe',
      objectGUID: Buffer.from('8a4b1d93f5c0e14a9b2a6c7d8e9f0a1b', 'hex'),
    });

    const entry = await new LdaptsDirectory(config, { warn: () => {} }, factory).findEntry(
      '(sAMAccountName=jdoe)',
    );

    expect(searches[0]?.attributes).toEqual(
      expect.arrayContaining(['mail', 'userPrincipalName', 'sAMAccountName', 'objectGUID']),
    );
    expect(searches[0]?.explicitBufferAttributes).toEqual(['objectGUID']);
    expect(entry).toEqual({
      dn: 'CN=Jane Doe,OU=People,DC=corp,DC=local',
      // No Exchange: mail is empty, and that is fine.
      email: null,
      displayName: 'Jane Doe',
      groupDns: ['CN=Ops,DC=corp,DC=local'],
      upn: 'jdoe@corp.local',
      username: 'jdoe',
      directoryId: '931d4b8a-c0f5-4ae1-9b2a-6c7d8e9f0a1b',
    });
  });

  it('OpenLDAP: asks for uid and entryUUID by name — it is operational — as text', async () => {
    const config = ldapConfigSchema.parse({
      url: 'ldaps://ldap.example.com:636',
      searchBase: 'dc=example,dc=com',
    });
    const { factory, searches } = recording({
      dn: 'uid=jdoe,ou=people,dc=example,dc=com',
      mail: 'jdoe@example.com',
      uid: 'jdoe',
      entryUUID: '9c1e7a4b-5d3f-4a2e-8b6c-1d2e3f4a5b6c',
    });

    const entry = await new LdaptsDirectory(config, { warn: () => {} }, factory).findEntry(
      '(uid=jdoe)',
    );

    expect(searches[0]?.attributes).toEqual(expect.arrayContaining(['uid', 'entryUUID']));
    expect(searches[0]?.attributes).not.toContain('userPrincipalName');
    expect(searches[0]?.explicitBufferAttributes).toEqual([]);
    expect(entry).toMatchObject({
      email: 'jdoe@example.com',
      upn: null,
      username: 'jdoe',
      directoryId: '9c1e7a4b-5d3f-4a2e-8b6c-1d2e3f4a5b6c',
    });
  });
});
