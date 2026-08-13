import { auditLabel } from './audit-label';

describe('auditLabel', () => {
  /*
   * AFTER WINS. A rename is recorded under the new name, because that is what
   * the entity is called from then on and what somebody searching the trail
   * will type.
   */
  it('prefers the state after the change', () => {
    expect(auditLabel({ name: 'old-name' }, { name: 'new-name' })).toBe('new-name');
  });

  /*
   * THE CASE THE COLUMN EXISTS FOR. On a delete there is no `after`, and the
   * id can no longer be resolved because the row it pointed at is gone — so the
   * label is the only thing naming what was destroyed.
   */
  it('falls back to the state before, which is all a deletion has', () => {
    expect(auditLabel({ name: 'doomed-group' }, undefined)).toBe('doomed-group');
    expect(auditLabel({ name: 'doomed-group' }, null)).toBe('doomed-group');
  });

  describe('which field names the thing', () => {
    it.each([
      ['a group', { name: 'baseline-jump-access' }, 'baseline-jump-access'],
      ['a user', { email: 'ops@example.com' }, 'ops@example.com'],
      ['a pin', { certname: 'web01.example.com' }, 'web01.example.com'],
      ['a class assignment', { className: 'jump_access' }, 'jump_access'],
      ['a setting', { key: 'audit.retention' }, 'audit.retention'],
    ])('labels %s', (_label, payload, expected) => {
      expect(auditLabel(undefined, payload)).toBe(expected);
    });

    it('prefers name over the others when several are present', () => {
      expect(auditLabel(undefined, { key: 'k', email: 'e@x', name: 'the-name' })).toBe('the-name');
    });

    it('prefers email over key, because a user is not their settings key', () => {
      expect(auditLabel(undefined, { key: 'some.key', email: 'ops@example.com' })).toBe(
        'ops@example.com',
      );
    });
  });

  describe('values that are not labels', () => {
    /*
     * Coercing these would put "[object Object]" or "42" into an audit trail,
     * which is worse than an honest null — a reader can look an id up, but
     * cannot tell a nonsense label from a real one.
     */
    it.each([
      ['an object', { name: { first: 'x' } }],
      ['a number', { name: 42 }],
      ['a boolean', { name: true }],
      ['an empty string', { name: '' }],
      ['whitespace only', { name: '   ' }],
      ['null', { name: null }],
    ])('returns null for %s', (_label, payload) => {
      expect(auditLabel(undefined, payload)).toBeNull();
    });

    it.each([
      ['both absent', undefined, undefined],
      ['a payload with no naming field', undefined, { rank: 10, isEnabled: true }],
      ['an array', undefined, ['name', 'x']],
      ['a string payload', undefined, 'not-an-object'],
    ])('returns null when %s', (_label, before, after) => {
      expect(auditLabel(before, after)).toBeNull();
    });

    it('skips an unusable field and takes the next usable one', () => {
      // `name` is present but not a string; `certname` still names the thing.
      expect(auditLabel(undefined, { name: 42, certname: 'db01.example.com' })).toBe(
        'db01.example.com',
      );
    });
  });

  it('trims, so a stray newline does not become part of the name', () => {
    expect(auditLabel(undefined, { name: '  spaced  ' })).toBe('spaced');
  });

  /*
   * The column is VARCHAR(200). Truncating here — visibly, with an ellipsis —
   * beats letting Postgres reject the insert, because that would fail the
   * transaction carrying the CHANGE, not merely its label.
   */
  it('truncates visibly rather than overflowing the column', () => {
    const label = auditLabel(undefined, { name: 'x'.repeat(500) });

    expect(label).toHaveLength(200);
    expect(label?.endsWith('…')).toBe(true);
  });

  it('leaves a label exactly at the limit alone', () => {
    const exact = 'y'.repeat(200);

    expect(auditLabel(undefined, { name: exact })).toBe(exact);
  });
});
