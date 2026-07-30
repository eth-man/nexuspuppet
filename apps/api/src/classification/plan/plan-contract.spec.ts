import { assignClassSchema, planRequestSchema } from '@nexuspuppet/contracts';

/**
 * The plan must accept exactly what the write accepts — no more.
 *
 * A plan that is MORE permissive than its write is the worse direction of
 * divergence: the preview reaches code the write would never have called. That
 * is not hypothetical. `className` was `z.string().min(1)` here while the write
 * used the Puppet identifier grammar, so `Profile::Monitoring` passed
 * validation, reached the ENC renderer, and its class-name assertion escaped as
 * a 500. An operator saw "internal server error" from a preview where the write
 * would have said "Not a valid Puppet class name".
 *
 * These tests compare the two schemas against the same inputs rather than
 * asserting a hardcoded list, so a future change to one is caught by the other.
 */

// A well-formed v4 UUID. Zod 4 checks the version and variant nibbles, so
// '1111-1111-...' is rejected outright and every case here would read as a
// className failure.
const GROUP = '6e7969f8-d24e-4b80-8ab8-fc0b53ddec23';

const plan = (className: string) =>
  planRequestSchema.safeParse({
    operation: 'assign-class',
    groupId: GROUP,
    className,
    params: {},
  }).success;

const write = (className: string) => assignClassSchema.safeParse({ className, params: {} }).success;

describe('plan contract: assign-class', () => {
  describe.each([
    ['profile::base', true],
    ['monitoring', true],
    ['profile::base::ssh', true],
    ['profile::my_class', true],
    // The ones that produced a 500.
    ['Profile::Monitoring', false],
    ['profile::monitoring ', false],
    [' profile::monitoring', false],
    ['profile::Monitoring', false],
    ['1profile', false],
    ['profile::', false],
    ['profile:base', false],
    ['profile-base', false],
    ['', false],
  ])('%j', (className, expected) => {
    it(`is ${expected ? 'accepted' : 'rejected'} by the write`, () => {
      expect(write(className)).toBe(expected);
    });

    it(`is ${expected ? 'accepted' : 'rejected'} by the plan`, () => {
      expect(plan(className)).toBe(expected);
    });

    it('is treated identically by both', () => {
      // The invariant. Either schema drifting breaks this, whichever moves.
      expect(plan(className)).toBe(write(className));
    });
  });
});

describe('plan contract: remove-class', () => {
  it('stays permissive, deliberately', () => {
    // Removing a name never puts it into a rendered document, so it cannot
    // reach the renderer's assertion — and if an invalid name ever did get
    // stored, refusing to preview its removal would leave no way to be rid of
    // it.
    const result = planRequestSchema.safeParse({
      operation: 'remove-class',
      groupId: GROUP,
      className: 'Profile::Legacy',
    });

    expect(result.success).toBe(true);
  });
});
