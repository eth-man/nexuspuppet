import { sanitiseReturnTo } from './auth.controller';

/**
 * The open-redirect guard on the external-login return path.
 *
 * `returnTo` arrives in a query string and is reflected into a redirect after a
 * session cookie has been set. That is the textbook open redirect, and it is
 * worse than usual here: an attacker sends a victim to a genuine NexusPuppet
 * login URL, the victim authenticates for real, and lands on a lookalike site
 * already holding a valid session.
 *
 * So this is an allow-list of one shape — a path on this origin — rather than a
 * blocklist of known-bad prefixes. Blocklists lose to encoding tricks; there is
 * no encoding of an absolute URL that starts with exactly one slash and has no
 * scheme.
 */
describe('sanitiseReturnTo', () => {
  describe('accepts a path on this origin', () => {
    it.each(['/', '/nodes', '/classification/abc-123', '/nodes?status=failed', '/a/b/c#frag'])(
      '%p',
      (path) => {
        expect(sanitiseReturnTo(path)).toBe(path);
      },
    );
  });

  describe('falls back to / for anything that could leave the origin', () => {
    it.each([
      // Absolute URLs.
      ['https://evil.test/steal', 'a different origin entirely'],
      ['http://evil.test', 'the same, unencrypted'],
      // Protocol-relative: `//host` is a HOST, not a path, and browsers treat it
      // as one. This is the one that looks like a path and is not.
      ['//evil.test', 'protocol-relative'],
      ['//evil.test/path', 'protocol-relative with a path'],
      // Some browsers normalise a backslash to a slash when resolving, which
      // turns this into the protocol-relative case above.
      ['/\\evil.test', 'backslash after the slash'],
      // Not a path at all.
      ['nodes', 'relative without a leading slash'],
      ['javascript:alert(1)', 'a script URL'],
      ['', 'empty'],
    ])('%p — %s', (input) => {
      expect(sanitiseReturnTo(input)).toBe('/');
    });
  });

  it('falls back to / when absent', () => {
    expect(sanitiseReturnTo(undefined)).toBe('/');
  });

  /**
   * A path that merely CONTAINS a scheme-like substring is still a path, but
   * distinguishing "contains" from "starts with" reliably is harder than it
   * looks once encoding is involved. Rejecting is the safe answer, and costs a
   * user nothing: they land on the dashboard.
   */
  it('rejects a path containing a scheme rather than reasoning about it', () => {
    expect(sanitiseReturnTo('/redirect?next=https://evil.test')).toBe('/');
  });
});
