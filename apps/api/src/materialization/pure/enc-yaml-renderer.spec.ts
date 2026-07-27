import { parse } from 'yaml';
import {
  renderEncDocument,
  renderDefaultDocument,
  InvalidEncDocumentError,
} from './enc-yaml-renderer';
import type { EncDocument } from '@nexuspuppet/contracts';

const doc = (over: Partial<EncDocument> = {}): EncDocument => ({
  classes: {},
  parameters: {},
  ...over,
});

describe('renderEncDocument', () => {
  it('produces YAML Puppet can consume', () => {
    const { yaml } = renderEncDocument(
      doc({
        classes: { 'profile::base': { ntp_servers: ['a.pool', 'b.pool'] } },
        parameters: { datacenter: 'dc1' },
        environment: 'production',
      }),
    );

    const parsed = parse(yaml);
    expect(parsed).toEqual({
      classes: { 'profile::base': { ntp_servers: ['a.pool', 'b.pool'] } },
      parameters: { datacenter: 'dc1' },
      environment: 'production',
    });
  });

  it('starts with a document marker and a do-not-edit warning', () => {
    const { yaml } = renderEncDocument(doc());
    expect(yaml.startsWith('---\n')).toBe(true);
    expect(yaml).toContain('Managed by NexusPuppet');
  });

  it('emits classes and parameters even when empty, so the shape is stable', () => {
    const parsed = parse(renderEncDocument(doc()).yaml);
    expect(parsed).toEqual({ classes: {}, parameters: {} });
  });

  it('omits environment when absent rather than emitting null', () => {
    const { yaml } = renderEncDocument(doc({ classes: { 'profile::x': {} } }));
    expect(yaml).not.toContain('environment');
  });

  // Determinism is what makes content-hash change detection correct. Without it
  // every materialization pass rewrites every file in the estate.
  describe('determinism', () => {
    it('is byte-identical across repeated renders', () => {
      const d = doc({ classes: { 'profile::b': { z: 1, a: 2 } }, parameters: { m: 1 } });
      expect(renderEncDocument(d).yaml).toBe(renderEncDocument(d).yaml);
    });

    it('is independent of key insertion order', () => {
      const a = renderEncDocument(
        doc({
          classes: { 'profile::z': { beta: 1, alpha: 2 }, 'profile::a': {} },
          parameters: { second: 2, first: 1 },
        }),
      );
      const b = renderEncDocument(
        doc({
          classes: { 'profile::a': {}, 'profile::z': { alpha: 2, beta: 1 } },
          parameters: { first: 1, second: 2 },
        }),
      );
      expect(a.yaml).toBe(b.yaml);
      expect(a.contentHash).toBe(b.contentHash);
    });

    it('sorts nested parameter keys too', () => {
      const { yaml } = renderEncDocument(
        doc({ classes: { 'profile::app': { cfg: { zulu: 1, alpha: 2 } } } }),
      );
      expect(yaml.indexOf('alpha')).toBeLessThan(yaml.indexOf('zulu'));
    });

    // Arrays are ordered data, not a set — reordering them changes meaning.
    it('preserves array order', () => {
      const { yaml } = renderEncDocument(
        doc({ classes: { 'profile::app': { hosts: ['z', 'a', 'm'] } } }),
      );
      expect(parse(yaml).classes['profile::app'].hosts).toEqual(['z', 'a', 'm']);
    });

    it('changes the hash when content changes', () => {
      const a = renderEncDocument(doc({ parameters: { dc: 'dc1' } }));
      const b = renderEncDocument(doc({ parameters: { dc: 'dc2' } }));
      expect(a.contentHash).not.toBe(b.contentHash);
      expect(a.contentHash).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('validation', () => {
    it.each([
      ['Profile::Base', 'capitalised'],
      ['profile-base', 'hyphenated'],
      ['1profile', 'leading digit'],
      ['profile::', 'trailing separator'],
      ['profile base', 'containing a space'],
    ])('rejects %s (%s)', (className) => {
      expect(() => renderEncDocument(doc({ classes: { [className]: {} } }))).toThrow(
        InvalidEncDocumentError,
      );
    });

    it.each(['profile', 'profile::base', 'profile::base::deep', 'a_b::c_d'])(
      'accepts %s',
      (className) => {
        expect(() => renderEncDocument(doc({ classes: { [className]: {} } }))).not.toThrow();
      },
    );
  });

  describe('values that break naive YAML emitters', () => {
    it.each([
      ['a string that looks like a bool', { v: 'yes' }],
      ['a string that looks like a number', { v: '0755' }],
      ['a string that looks like null', { v: 'null' }],
      ['a colon-containing string', { v: 'key: value' }],
      ['a multi-line string', { v: 'line1\nline2' }],
      ['a unicode string', { v: 'héllo-wörld-日本' }],
      ['an empty string', { v: '' }],
      ['a null', { v: null }],
      ['a nested structure', { v: { a: [1, { b: 'c' }] } }],
    ])('round-trips %s', (_label, params) => {
      const { yaml } = renderEncDocument(doc({ classes: { 'profile::t': params } }));
      expect(parse(yaml).classes['profile::t']).toEqual(params);
    });

    it('preserves a certname-like key containing dots', () => {
      const { yaml } = renderEncDocument(doc({ parameters: { 'a.b.c': 'v' } }));
      expect(parse(yaml).parameters).toEqual({ 'a.b.c': 'v' });
    });
  });
});

describe('renderDefaultDocument', () => {
  // Guarantees an unknown node gets a defined classification rather than a
  // compilation failure (ADR-0003).
  it('renders a valid, empty classification', () => {
    expect(parse(renderDefaultDocument().yaml)).toEqual({ classes: {}, parameters: {} });
  });

  it('can pin a default environment', () => {
    expect(parse(renderDefaultDocument('production').yaml).environment).toBe('production');
  });
});
