import { isNewer, parseVersion } from './version';

/**
 * The comparison behind "an update is available".
 *
 * Worth testing for one reason above all: a string comparison says 0.9.0 is
 * newer than 0.10.0, and that is the shape of mistake nobody notices until the
 * tenth minor release.
 */
describe('version comparison', () => {
  it('reads the usual shapes', () => {
    expect(parseVersion('1.2.3')).toEqual([1, 2, 3]);
    expect(parseVersion('v1.2.3')).toEqual([1, 2, 3]);
    expect(parseVersion('v1.2.3-rc.1')).toEqual([1, 2, 3]);
    expect(parseVersion('nightly')).toBeNull();
  });

  it('orders by number, not by text', () => {
    // The case a string comparison gets wrong.
    expect(isNewer('0.10.0', '0.9.0')).toBe(true);
    expect(isNewer('0.9.0', '0.10.0')).toBe(false);
  });

  it('is strict about being newer', () => {
    expect(isNewer('1.0.0', '1.0.0')).toBe(false);
    expect(isNewer('1.0.1', '1.0.0')).toBe(true);
    expect(isNewer('2.0.0', '1.9.9')).toBe(true);
    expect(isNewer('1.0.0', '2.0.0')).toBe(false);
  });

  /**
   * An unrecognised tag answers "no update", never "yes".
   *
   * A permanent badge an operator cannot clear by upgrading is worse than no
   * badge: they learn to ignore it, including on the release where it is real.
   */
  it('says no when it cannot tell', () => {
    expect(isNewer('nightly', '1.0.0')).toBe(false);
    expect(isNewer('1.0.0', 'unknown')).toBe(false);
    expect(isNewer('', '1.0.0')).toBe(false);
  });

  /*
   * A BUILD BETWEEN RELEASES, now that the image stamps `git describe`
   * (`v1.8.0-3-gabc1234` three commits past the tag).
   *
   * The suffix must not make the deployment look OLDER than the release it is
   * actually ahead of. A semver library would read `-3-gabc1234` as a
   * pre-release and sort it BEFORE 1.8.0, so a console built from main would
   * show a permanent "update available" pointing at a release it already
   * contains. This parser takes the leading triple and ignores the rest, which
   * is the behaviour that makes the stamp safe — and the reason it is pinned
   * here rather than left to the regex.
   */
  it('treats a describe suffix as the release it descends from', () => {
    expect(parseVersion('v1.8.0-3-gabc1234')).toEqual([1, 8, 0]);
    expect(parseVersion('v1.8.0-3-gabc1234-dirty')).toEqual([1, 8, 0]);

    // Already has it: no badge.
    expect(isNewer('v1.8.0', 'v1.8.0-3-gabc1234')).toBe(false);
    // Genuinely behind, despite the suffix: badge.
    expect(isNewer('v1.9.0', 'v1.8.0-3-gabc1234')).toBe(true);
  });

  /*
   * `git describe --always` on a repository with no tags in reach yields a bare
   * abbreviated hash. Unparseable, so it answers "no update" — the same silence
   * as any other tag this cannot read, rather than a badge nobody can clear.
   */
  it('says no for a bare commit hash', () => {
    expect(parseVersion('abc1234')).toBeNull();
    expect(isNewer('v1.9.0', 'abc1234')).toBe(false);
  });
});
