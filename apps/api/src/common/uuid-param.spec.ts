import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { UuidParam } from './uuid-param';
import { NodeGroupsController } from '../classification/node-groups.controller';
import { UsersController } from '../auth/users.controller';

/**
 * A malformed identifier must be a bad request, not a server error.
 *
 * Found by the QA fuzzer walking to `/classification/not-a-uuid`: the id reached
 * Prisma, Postgres rejected it as invalid input syntax for uuid, and the
 * operator got **500** — where a well-formed but absent id correctly answers
 * 404. A stale bookmark and a truncated copy-paste both look exactly like this.
 */
describe('UuidParam', () => {
  it.each([
    'not-a-uuid',
    'nope',
    '123',
    '../etc',
    '00000000-0000-0000-0000',
    '',
    '00000000-0000-4000-8000-00000000000g',
  ])('rejects %j', (value) => {
    expect(() => UuidParam.transform(value)).toThrow(BadRequestException);
  });

  it('names the parameter problem rather than saying "invalid"', () => {
    try {
      UuidParam.transform('not-a-uuid');
      throw new Error('expected a rejection');
    } catch (error) {
      const body = (error as BadRequestException).getResponse() as {
        issues?: Array<{ message: string }>;
      };
      expect(body.issues?.[0]?.message).toMatch(/UUID/i);
    }
  });

  it('accepts a well-formed uuid', () => {
    const id = '6e7969f8-d24e-4b80-8ab8-fc0b53ddec23';
    expect(UuidParam.transform(id)).toBe(id);
  });
});

/**
 * The invariant, not the instance.
 *
 * The defect was never in one handler — it was the absence of a boundary, on
 * ten routes at once. A test naming a single route would let the eleventh
 * regress silently, so this reads Nest's own route metadata and asserts that
 * EVERY parameter called `id` has a pipe attached.
 *
 * A route added tomorrow without one fails here, which is the only place that
 * would notice before a user does.
 */
describe('every :id parameter is validated', () => {
  const controllers = [
    ['NodeGroupsController', NodeGroupsController],
    ['UsersController', UsersController],
  ] as const;

  for (const [name, controller] of controllers) {
    it(`${name} attaches a pipe to every id param`, () => {
      const methods = Object.getOwnPropertyNames(controller.prototype).filter(
        (key) => key !== 'constructor',
      );

      const unguarded: string[] = [];
      for (const method of methods) {
        const args = Reflect.getMetadata('__routeArguments__', controller, method) as
          Record<string, { data?: unknown; pipes?: unknown[] }> | undefined;
        if (args === undefined) continue;

        for (const arg of Object.values(args)) {
          if (arg.data === 'id' && (arg.pipes ?? []).length === 0) {
            unguarded.push(`${name}.${method}`);
          }
        }
      }

      // Named in the failure output, since "expected [] to equal [...]" alone
      // would not say which route lost its boundary.
      expect({ routesTakingAnUnvalidatedId: unguarded }).toEqual({
        routesTakingAnUnvalidatedId: [],
      });
    });
  }

  it('finds routes at all, so a metadata change cannot make this vacuous', () => {
    // Without this the suite would pass if Nest changed its metadata key and
    // every lookup returned undefined — a green test proving nothing.
    const methods = Object.getOwnPropertyNames(NodeGroupsController.prototype);
    const withIdParams = methods.filter((method) => {
      const args = Reflect.getMetadata('__routeArguments__', NodeGroupsController, method) as
        Record<string, { data?: unknown }> | undefined;
      return Object.values(args ?? {}).some((arg) => arg.data === 'id');
    });

    expect(withIdParams.length).toBeGreaterThanOrEqual(5);
  });
});
