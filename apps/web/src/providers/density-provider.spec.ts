import { DENSITY_BOOTSTRAP, DENSITY_STORAGE_KEY } from './density-provider';

/*
 * THE RISK THIS FILE EXISTS FOR.
 *
 * The pre-paint bootstrap is a STRING, duplicating the provider's rule so the
 * attribute is applied before first paint. Two copies of one rule in two forms
 * eventually disagree, and the symptom — the whole layout resizing a moment
 * after load — is exactly what the bootstrap was added to prevent.
 *
 * So the bootstrap is executed here against stubs, rather than merely
 * inspected.
 */

interface Stub {
  attributes: Record<string, string>;
  removed: string[];
}

function runBootstrap(stored: string | null, options: { throwOnRead?: boolean } = {}): Stub {
  const stub: Stub = { attributes: {}, removed: [] };

  const globals = globalThis as unknown as Record<string, unknown>;
  const previous = { localStorage: globals['localStorage'], document: globals['document'] };

  globals['localStorage'] = {
    getItem(key: string) {
      if (options.throwOnRead === true) throw new Error('site data blocked');
      return key === DENSITY_STORAGE_KEY ? stored : null;
    },
  };
  globals['document'] = {
    documentElement: {
      setAttribute(name: string, value: string) {
        stub.attributes[name] = value;
      },
      removeAttribute(name: string) {
        stub.removed.push(name);
      },
    },
  };

  try {
    new Function(DENSITY_BOOTSTRAP)();
  } finally {
    globals['localStorage'] = previous.localStorage;
    globals['document'] = previous.document;
  }

  return stub;
}

describe('DENSITY_BOOTSTRAP', () => {
  it.each([
    ['comfortable', 'comfortable'],
    ['large', 'large'],
  ])('applies data-density for a stored %s preference', (stored, expected) => {
    expect(runBootstrap(stored).attributes['data-density']).toBe(expected);
  });

  /*
   * Compact is the ABSENCE of an override, not a value. Keeping it that way
   * means the bootstrap, the CSS and the provider all have one less state to
   * agree about — and a fresh install is byte-identical to before this feature.
   */
  it.each([
    ['nothing stored', null],
    ['compact', 'compact'],
    ['a value from a future version', 'enormous'],
    ['an empty string', ''],
  ])('sets no attribute for %s', (_label, stored) => {
    expect(runBootstrap(stored).attributes['data-density']).toBeUndefined();
  });

  /*
   * localStorage throws outright in a browser with site data blocked. A
   * density preference is not worth a blank page.
   */
  it('survives storage being unreadable', () => {
    expect(() => runBootstrap(null, { throwOnRead: true })).not.toThrow();
    expect(runBootstrap(null, { throwOnRead: true }).attributes['data-density']).toBeUndefined();
  });

  it('reads the same storage key the provider writes', () => {
    // Drift here is invisible until someone reloads and their choice is gone.
    expect(DENSITY_BOOTSTRAP).toContain(JSON.stringify(DENSITY_STORAGE_KEY));
  });
});
