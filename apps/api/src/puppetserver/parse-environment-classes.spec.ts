import { parseEnumValues, parseEnvironmentClasses } from './parse-environment-classes';

/*
 * The fixtures are REAL. Every payload below was captured from
 * /puppet/v3/environment_classes on an OpenVox puppetserver 8.15.2
 * (Puppet 8.28.1), not written from the documentation — which, on this
 * endpoint, has already been wrong once about ETag support.
 */

/** Verbatim from the live server. */
const MEASURED = {
  name: 'production',
  files: [
    {
      path: '/etc/puppetlabs/code/environments/production/modules/jump_access/manifests/init.pp',
      classes: [
        {
          name: 'jump_access',
          params: [
            { name: 'pubkey', type: 'String[1]' },
            {
              name: 'users',
              type: 'Array[String[1]]',
              default_literal: ['root'],
              default_source: '["root"]',
            },
            {
              name: 'ensure',
              type: "Enum['absent', 'present']",
              default_literal: 'present',
              default_source: '"present"',
            },
            { name: 'target', type: 'Optional[String[1]]', default_source: 'undef' },
          ],
        },
      ],
    },
  ],
};

describe('parseEnvironmentClasses', () => {
  describe('the measured payload', () => {
    const { classes, fileErrors } = parseEnvironmentClasses(MEASURED);
    const params = classes[0]?.params ?? [];
    const byName = (name: string) => params.find((p) => p.name === name);

    it('finds the class and where it lives', () => {
      expect(classes).toHaveLength(1);
      expect(classes[0]?.name).toBe('jump_access');
      expect(classes[0]?.path).toContain('jump_access/manifests/init.pp');
      expect(fileErrors).toEqual([]);
    });

    /*
     * THE MOST USEFUL THING THE FORM CAN KNOW. `pubkey` has neither
     * default_literal nor default_source; `users` has both. That difference is
     * the whole of "required vs optional", and it is derived rather than
     * guessed.
     */
    it('marks a parameter with no default as required', () => {
      expect(byName('pubkey')?.kind).toBe('required');
      expect(byName('pubkey')).not.toHaveProperty('defaultValue');
    });

    it('prefills a literal default', () => {
      expect(byName('users')?.kind).toBe('literal');
      expect(byName('users')?.defaultValue).toEqual(['root']);
    });

    it('reads enum options out of the type so the form can offer a select', () => {
      expect(byName('ensure')?.kind).toBe('literal');
      expect(byName('ensure')?.defaultValue).toBe('present');
      expect(byName('ensure')?.enumValues).toEqual(['absent', 'present']);
    });

    /*
     * THIS TEST USED TO ASSERT THE BUG.
     *
     * It read "treats an undef default as required", and an operator caught the
     * consequence: their class declared four `Optional[String[1]] $x = undef`
     * parameters and the console demanded values for all of them, above a header
     * claiming "6 required parameters" on a class that has two.
     *
     * `= undef` IS a default. It is what makes such a parameter omissible. What
     * makes a parameter required is the absence of any `=` — which arrives as
     * neither default_literal nor default_source, as `pubkey` does.
     *
     * A test that pins the wrong behaviour is worse than no test: it converts a
     * mistake into a guarantee.
     */
    it('treats an undef default as OPTIONAL, because = undef is a default', () => {
      expect(byName('target')?.kind).toBe('undef');
      expect(byName('target')?.kind).not.toBe('required');
      // Nothing to prefill and nothing to evaluate — the honest label is
      // "optional", not "defaults to undef, computed at compile time".
      expect(byName('target')?.defaultValue).toBeUndefined();
      expect(byName('target')).not.toHaveProperty('defaultSource');
    });

    it('keeps the Puppet type signature verbatim', () => {
      expect(byName('users')?.type).toBe('Array[String[1]]');
      expect(byName('target')?.type).toBe('Optional[String[1]]');
    });
  });

  /*
   * THE BUG THIS PREVENTS. Reading `default_literal` for truthiness rather than
   * presence turns every false/0/"" default into "required" — wrong in a way
   * that passes every test written with a string default.
   */
  describe('falsy literal defaults', () => {
    it.each([
      ['false', false],
      ['zero', 0],
      ['empty string', ''],
      ['null', null],
    ])('treats a %s default as a literal, not as required', (_label, value) => {
      const { classes } = parseEnvironmentClasses({
        files: [
          {
            path: '/m.pp',
            classes: [{ name: 'c', params: [{ name: 'p', default_literal: value }] }],
          },
        ],
      });

      expect(classes[0]?.params[0]?.kind).toBe('literal');
      expect(classes[0]?.params[0]?.defaultValue).toBe(value);
    });
  });

  /*
   * Smart Proxy rewrites a $-prefixed default_source to ${…} because it
   * references another variable and resolves at compile time. Prefilling the
   * literal text would be quietly wrong.
   */
  describe('defaults that are expressions rather than values', () => {
    it('does not prefill a variable reference', () => {
      const { classes } = parseEnvironmentClasses({
        files: [
          {
            path: '/m.pp',
            classes: [
              {
                name: 'c',
                params: [{ name: 'p', type: 'String', default_source: '$facts["os"]' }],
              },
            ],
          },
        ],
      });

      const param = classes[0]?.params[0];
      expect(param?.kind).toBe('expression');
      expect(param).not.toHaveProperty('defaultValue');
      expect(param?.defaultSource).toBe('$facts["os"]');
    });

    it('treats a non-literal function call as an expression too', () => {
      const { classes } = parseEnvironmentClasses({
        files: [
          {
            path: '/m.pp',
            classes: [{ name: 'c', params: [{ name: 'p', default_source: 'lookup("k")' }] }],
          },
        ],
      });

      expect(classes[0]?.params[0]?.kind).toBe('expression');
    });
  });

  /*
   * A manifest puppetserver could not parse arrives as an `error` entry beside
   * the good files. Foreman passes these through rather than failing the
   * request; so do we, because one broken file must not blank the picker.
   */
  describe('files that failed to parse', () => {
    const payload = {
      files: [
        { path: '/broken.pp', error: { kind: 'PARSE_ERROR', msg: "Syntax error at '}'" } },
        { path: '/good.pp', classes: [{ name: 'works', params: [] }] },
      ],
    };

    it('still returns the classes from the files that did parse', () => {
      expect(parseEnvironmentClasses(payload).classes.map((c) => c.name)).toEqual(['works']);
    });

    it('names the broken file and why, rather than swallowing it', () => {
      const { fileErrors } = parseEnvironmentClasses(payload);

      expect(fileErrors).toHaveLength(1);
      expect(fileErrors[0]?.path).toBe('/broken.pp');
      expect(fileErrors[0]?.message).toBe("Syntax error at '}'");
    });
  });

  describe('tolerance of shapes we did not expect', () => {
    it.each([
      ['null', null],
      ['a string', 'nonsense'],
      ['an empty object', {}],
      ['files not an array', { files: 'no' }],
    ])('returns empty rather than throwing for %s', (_label, body) => {
      expect(() => parseEnvironmentClasses(body)).not.toThrow();
      expect(parseEnvironmentClasses(body).classes).toEqual([]);
    });

    it('skips unusable entries and keeps the usable ones', () => {
      const { classes } = parseEnvironmentClasses({
        files: [
          null,
          'nope',
          {
            path: '/a.pp',
            classes: [{ name: '' }, { noName: true }, { name: 'kept', params: 'not-an-array' }],
          },
        ],
      });

      expect(classes.map((c) => c.name)).toEqual(['kept']);
      expect(classes[0]?.params).toEqual([]);
    });
  });

  it('sorts classes so the picker does not reshuffle between fetches', () => {
    // puppetserver returns filesystem order, which nobody can predict.
    const { classes } = parseEnvironmentClasses({
      files: [
        { path: '/z.pp', classes: [{ name: 'zebra' }] },
        { path: '/a.pp', classes: [{ name: 'apple' }, { name: 'mango' }] },
      ],
    });

    expect(classes.map((c) => c.name)).toEqual(['apple', 'mango', 'zebra']);
  });
});

describe('parseEnumValues', () => {
  it.each([
    ["Enum['absent', 'present']", ['absent', 'present']],
    ['Enum["a","b"]', ['a', 'b']],
    ["Enum['only']", ['only']],
    ['String[1]', []],
    ['Optional[String[1]]', []],
    [null, []],
    ['Enum[]', []],
  ])('%s -> %j', (type, expected) => {
    expect(parseEnumValues(type)).toEqual(expected);
  });

  it('ignores unquoted members rather than offering them as choices', () => {
    // A bare or interpolated member is not a literal choice we can offer, and
    // guessing one into a dropdown would produce an unassignable value.
    expect(parseEnumValues("Enum[$var, 'real']")).toEqual(['real']);
  });
});

/*
 * The reported class, verbatim in shape (#falcon). Four parameters declared
 * `Optional[String[1]] $x = undef` were shown as required, and the dialog
 * announced "6 required parameters" for a class with two.
 */
describe('the falcon class an operator reported', () => {
  const FALCON = {
    files: [
      {
        path: '/etc/puppetlabs/code/environments/production/modules/falcon/manifests/init.pp',
        classes: [
          {
            name: 'falcon',
            params: [
              {
                name: 'ensure',
                type: "Enum['absent', 'present']",
                default_literal: 'present',
                default_source: "'present'",
              },
              { name: 'client_id', type: 'Variant[String[1], Sensitive[String]]' },
              { name: 'client_secret', type: 'Variant[String[1], Sensitive[String]]' },
              { name: 'cloud', type: 'Optional[String[1]]', default_source: 'undef' },
              { name: 'tags', type: 'Optional[String[1]]', default_source: 'undef' },
              {
                name: 'sensor_update_policy',
                type: 'Optional[String[1]]',
                default_source: 'undef',
              },
              { name: 'provisioning_token', type: 'Optional[String[1]]', default_source: 'undef' },
            ],
          },
        ],
      },
    ],
  };

  const params = parseEnvironmentClasses(FALCON).classes[0]?.params ?? [];
  const kind = (name: string) => params.find((p) => p.name === name)?.kind;

  it('requires only the two parameters that have no default', () => {
    expect(params.filter((p) => p.kind === 'required').map((p) => p.name)).toEqual([
      'client_id',
      'client_secret',
    ]);
  });

  it.each(['cloud', 'tags', 'sensor_update_policy', 'provisioning_token'])(
    '%s is optional, not required',
    (name) => {
      expect(kind(name)).toBe('undef');
      expect(kind(name)).not.toBe('required');
    },
  );

  it('still reads the enum default correctly', () => {
    expect(kind('ensure')).toBe('literal');
    expect(params.find((p) => p.name === 'ensure')?.enumValues).toEqual(['absent', 'present']);
  });
});
