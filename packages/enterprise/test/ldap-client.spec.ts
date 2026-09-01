import { ldapConfigSchema } from '../src/ldap/config';
import { LdapUnavailableError, LdaptsDirectory } from '../src/ldap/ldap-client';

// A name that cannot resolve, so these stay hermetic: no container, no network,
// and no dependence on whether anything happens to be listening locally.
const config = ldapConfigSchema.parse({
  url: 'ldap://directory.invalid:389',
  searchBase: 'ou=people,dc=example,dc=com',
  timeoutMs: 2000,
});

/**
 * The rest of LdaptsDirectory is a thin translation layer over `ldapts` and is
 * deliberately excluded from the coverage threshold: exercising it against a
 * mock proves only that the mock agrees with the assumptions in the same file.
 * Its real behaviour is covered by test/ldap/ldap-integration.spec.ts, which
 * runs against an actual OpenLDAP.
 *
 * What is worth asserting here is FAILURE CLASSIFICATION. Getting it wrong
 * means a directory outage reads to every user as a wrong password.
 */
describe('LdaptsDirectory when the directory cannot be reached', () => {
  it('classifies a transport failure as unavailable, never as a bad password', async () => {
    await expect(new LdaptsDirectory(config).findEntry('(mail=a@b.c)')).rejects.toBeInstanceOf(
      LdapUnavailableError,
    );
  });

  it('classifies a failed bind attempt the same way', async () => {
    await expect(
      new LdaptsDirectory(config).verifyCredentials('uid=a', 'secret'),
    ).rejects.toBeInstanceOf(LdapUnavailableError);
  });

  it('does not leak the password into the error', async () => {
    await expect(
      new LdaptsDirectory(config).verifyCredentials('uid=a', 'hunter2'),
    ).rejects.not.toThrow(/hunter2/);
  });
});
