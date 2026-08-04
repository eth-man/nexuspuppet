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
});
