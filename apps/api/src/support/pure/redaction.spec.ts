import { addCounts, emptyCounts, MIN_SECRET_LENGTH, prepareSecrets, redact } from './redaction';

const none = prepareSecrets([]);

/*
 * PEM markers ASSEMBLED, never written out. CI refuses any committed file
 * containing a private-key header (the "no committed secrets" guard), and
 * that guard is worth more than a readable fixture.
 */
const pemBegin = (type = ''): string => ['-----BEGIN', `${type}PRIVATE KEY-----`].join(' ');
const pemEnd = (type = ''): string => ['-----END', `${type}PRIVATE KEY-----`].join(' ');

describe('redaction', () => {
  describe('literal secret values', () => {
    it('replaces every occurrence and names the variable', () => {
      const secrets = prepareSecrets([{ name: 'JWT_SECRET', value: 'hunter2-hunter2' }]);
      const { text, counts } = redact('a hunter2-hunter2 b hunter2-hunter2', secrets);

      expect(text).toBe('a [REDACTED:JWT_SECRET] b [REDACTED:JWT_SECRET]');
      expect(counts['secret-value']).toBe(2);
    });

    /*
     * Most of the bundle is JSON. A secret containing a quote or a backslash is
     * written as \" or \\ once serialised, and a search for the raw value
     * walks straight past it.
     */
    it('finds a value in its JSON-escaped form too', () => {
      const value = 'pa"ss\\word!';
      const secrets = prepareSecrets([{ name: 'POSTGRES_PASSWORD', value }]);
      const serialised = JSON.stringify({ password: value });

      const { text } = redact(serialised, secrets);

      expect(text).toBe('{"password":"[REDACTED:POSTGRES_PASSWORD]"}');
      expect(text).not.toContain('ss\\\\word');
    });

    it('replaces the longer of two overlapping values first, so neither leaks a remainder', () => {
      const secrets = prepareSecrets([
        { name: 'POSTGRES_PASSWORD', value: 's3cretpw' },
        { name: 'DATABASE_URL', value: 'postgresql://np:s3cretpw@db:5432/np' },
      ]);

      const { text } = redact('url=postgresql://np:s3cretpw@db:5432/np pw=s3cretpw', secrets);

      expect(text).toBe('url=[REDACTED:DATABASE_URL] pw=[REDACTED:POSTGRES_PASSWORD]');
    });

    it('skips values too short to replace safely, and reports them by name', () => {
      const secrets = prepareSecrets([
        { name: 'SHORT', value: 'abc' },
        { name: 'EMPTY', value: '' },
        { name: 'OK', value: 'x'.repeat(MIN_SECRET_LENGTH) },
      ]);

      expect(secrets.tooShort).toEqual(['SHORT']);
      expect(redact('abc xxxxxx', secrets).text).toBe('abc [REDACTED:OK]');
    });

    /*
     * Found on a real container: POSTGRES_PASSWORD equals the password inside
     * DATABASE_URL, the two shared one needle, and the manifest listed only the
     * name the needle was labelled with — so a secret that WAS searched for
     * looked as though it was not.
     */
    it('reports every searched name, even when two share one value', () => {
      const secrets = prepareSecrets([
        { name: 'POSTGRES_PASSWORD', value: 'shared-value' },
        { name: 'DATABASE_URL.password', value: 'shared-value' },
      ]);

      expect(secrets.searched).toEqual(['DATABASE_URL.password', 'POSTGRES_PASSWORD']);
      expect(secrets.patterns).toEqual([{ name: 'DATABASE_URL.password', needle: 'shared-value' }]);
    });

    it('labels a shared value the same way whatever order it arrived in', () => {
      const a = prepareSecrets([
        { name: 'B', value: 'shared-value' },
        { name: 'A', value: 'shared-value' },
      ]);
      const b = prepareSecrets([
        { name: 'A', value: 'shared-value' },
        { name: 'B', value: 'shared-value' },
      ]);
      expect(a).toEqual(b);
    });

    it('does not depend on the order secrets were supplied in', () => {
      const a = prepareSecrets([
        { name: 'A', value: 'same-length-1' },
        { name: 'B', value: 'same-length-2' },
      ]);
      const b = prepareSecrets([
        { name: 'B', value: 'same-length-2' },
        { name: 'A', value: 'same-length-1' },
      ]);
      expect(a).toEqual(b);
    });

    it('treats regex metacharacters in a value literally', () => {
      const secrets = prepareSecrets([{ name: 'T', value: '.*+?^${}()|[]' }]);
      expect(redact('keep this .*+?^${}()|[] and this', secrets).text).toBe(
        'keep this [REDACTED:T] and this',
      );
    });
  });

  describe('PEM private keys', () => {
    it('masks a whole block of any key type, keeping text around it', () => {
      for (const type of ['', 'RSA ', 'EC ', 'ENCRYPTED ', 'OPENSSH ']) {
        const pem = `${pemBegin(type)}\nMIIEv...\nabc=\n${pemEnd(type)}`;
        const { text, counts } = redact(`before\n${pem}\nafter`, none);
        expect(text).toBe('before\n[REDACTED:PEM-PRIVATE-KEY]\nafter');
        expect(counts['pem-private-key']).toBe(1);
      }
    });

    it('masks a block serialised into a JSON string', () => {
      const json = JSON.stringify({
        key: `${pemBegin()}\nAAAA\n${pemEnd()}\n`,
      });
      expect(redact(json, none).text).toBe('{"key":"[REDACTED:PEM-PRIVATE-KEY]\\n"}');
    });

    it('masks a BEGIN with no END to the end of the line', () => {
      const { text } = redact(`x ${pemBegin('RSA ')}MIIEsecretstuff\nnext line`, none);
      expect(text).toBe('x [REDACTED:PEM-PRIVATE-KEY]\nnext line');
    });

    it('leaves certificates, which are public, alone', () => {
      const cert = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----';
      expect(redact(cert, none).text).toBe(cert);
    });
  });

  describe('URL credentials', () => {
    it('masks user:password@ and keeps the host, which support needs', () => {
      const { text, counts } = redact(
        'connecting to postgresql://nexus:Sup3r@db:5432/np?schema=public',
        none,
      );
      // `Sup3r@db` — the password contains no @, so the first @ ends userinfo.
      expect(text).toBe(
        'connecting to postgresql://[REDACTED:URL-CREDENTIALS]@db:5432/np?schema=public',
      );
      expect(counts['url-credentials']).toBe(1);
    });

    it('masks a token used as a username', () => {
      expect(redact('https://ghp_abcdef123456@github.com/org/repo.git', none).text).toBe(
        'https://[REDACTED:URL-CREDENTIALS]@github.com/org/repo.git',
      );
    });

    it('does not touch URLs without userinfo, or an @ later in the path', () => {
      const text = 'https://puppetdb.example.com:8081/pdb/query/v4 and https://x.test/a/b@c';
      expect(redact(text, none).text).toBe(text);
    });
  });

  describe('JWTs', () => {
    it('masks a three-segment eyJ token', () => {
      const jwt =
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
      const { text, counts } = redact(`Bearer ${jwt} trailing`, none);
      expect(text).toBe('Bearer [REDACTED:JWT] trailing');
      expect(counts.jwt).toBe(1);
    });

    it('leaves dotted identifiers that merely start with eyJ-like text alone', () => {
      expect(redact('eyJ.a.b version 1.2.3', none).text).toBe('eyJ.a.b version 1.2.3');
    });
  });

  describe('email addresses', () => {
    it('masks identities', () => {
      const { text, counts } = redact(
        'Upgraded password hash parameters for admin@corp.example.',
        none,
      );
      expect(text).toBe('Upgraded password hash parameters for [REDACTED:EMAIL].');
      expect(counts.email).toBe(1);
    });

    it('does not mistake package@version or a certname for an address', () => {
      const text = '@nestjs/core@11.1.28 on web01.corp.example.com';
      expect(redact(text, none).text).toBe(text);
    });
  });

  it('applies every rule in one pass and counts each', () => {
    const secrets = prepareSecrets([{ name: 'LDAP_BIND_PASSWORD', value: 'bindpass-123' }]);
    const input = [
      'bind with bindpass-123',
      'ldaps://svc:other@dc01.corp:636',
      'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJlLXZhbHVl',
      'user jane@corp.example',
      `${pemBegin()}\nabc\n${pemEnd()}`,
    ].join('\n');

    const { text, counts } = redact(input, secrets);

    expect(counts).toEqual({
      'secret-value': 1,
      'pem-private-key': 1,
      'url-credentials': 1,
      jwt: 1,
      email: 1,
    });
    for (const leaked of ['bindpass-123', 'other', 'jane@', 'eyJzdWIi', 'abc\n']) {
      expect(text).not.toContain(leaked);
    }
  });

  it('is idempotent: redacting twice changes nothing further', () => {
    const secrets = prepareSecrets([{ name: 'S', value: 'abcdefgh' }]);
    const once = redact('abcdefgh https://u:p@h x@y.example', secrets).text;
    const twice = redact(once, secrets);
    expect(twice.text).toBe(once);
    expect(twice.counts).toEqual(emptyCounts());
  });

  it('keepEmails switches off the email rule and nothing else', () => {
    const secrets = prepareSecrets([{ name: 'S', value: 'abcdefgh' }]);
    const input =
      'jane@corp.example abcdefgh https://u:p@h eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl';

    const { text, counts } = redact(input, secrets, { keepEmails: true });

    expect(text).toContain('jane@corp.example');
    expect(text).toContain('[REDACTED:S]');
    expect(text).toContain('[REDACTED:URL-CREDENTIALS]');
    expect(text).toContain('[REDACTED:JWT]');
    expect(counts.email).toBe(0);
  });

  it('adds counts', () => {
    const total = emptyCounts();
    addCounts(total, { ...emptyCounts(), jwt: 2 });
    addCounts(total, { ...emptyCounts(), jwt: 1, email: 4 });
    expect(total).toMatchObject({ jwt: 3, email: 4 });
  });
});
