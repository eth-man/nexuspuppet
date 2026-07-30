import { AccountController } from './users.controller';
import { REFRESH_COOKIE, type AuthenticatedRequest } from './auth.guard';
import type { UsersService } from './users.service';

/**
 * The wiring, not the policy.
 *
 * `UsersService.changeOwnPassword` spares the caller's own session, but only if
 * the controller hands it the caller's refresh token — and the way to get that
 * wrong is well documented here. An OIDC route once read `request.cookies`,
 * which this application never populates because it registers no cookie-parser,
 * and shipped with fifteen passing tests: every one of them built a fake request
 * supplying a field the real app does not produce.
 *
 * So these tests set `headers.cookie` — the thing Node actually delivers — and
 * assert on what the service receives. A controller reading `request.cookies`
 * fails here rather than in production, one access-token lifetime after someone
 * changed their password.
 */
describe('AccountController.changePassword', () => {
  const changeOwnPassword = jest.fn().mockResolvedValue(undefined);
  const controller = new AccountController({ changeOwnPassword } as unknown as UsersService);

  const BODY = { currentPassword: 'old-and-long-enough', newPassword: 'new-and-long-enough' };

  const requestWith = (cookie?: string) =>
    ({
      principal: { userId: 'u1', email: 'u@example.com', role: 'OPERATOR', permissions: [] },
      headers: { ...(cookie === undefined ? {} : { cookie }), 'user-agent': 'jest' },
      ip: '10.0.0.1',
    }) as unknown as AuthenticatedRequest;

  /** The token the service was asked to spare, whatever it was. */
  const sparedToken = () => changeOwnPassword.mock.calls.at(-1)?.[4] as string | undefined;

  beforeEach(() => changeOwnPassword.mockClear());

  it('passes the refresh cookie through to the service', async () => {
    await controller.changePassword(BODY, requestWith(`${REFRESH_COOKIE}=abc123`));
    expect(sparedToken()).toBe('abc123');
  });

  it('finds it among other cookies, in any position', async () => {
    await controller.changePassword(
      BODY,
      requestWith(`theme=dark; ${REFRESH_COOKIE}=abc123; other=1`),
    );
    expect(sparedToken()).toBe('abc123');
  });

  it('passes undefined when the cookie is absent, so nothing is spared', async () => {
    // The safe direction: a caller without the cookie loses every session
    // rather than silently keeping them all.
    await controller.changePassword(BODY, requestWith('theme=dark'));
    expect(sparedToken()).toBeUndefined();
  });

  it('passes undefined when there is no Cookie header at all', async () => {
    await controller.changePassword(BODY, requestWith(undefined));
    expect(sparedToken()).toBeUndefined();
  });

  it('does not read request.cookies, which this app never populates', async () => {
    // The specific historical mistake, pinned. A request carrying ONLY the
    // parsed-cookies shape must yield nothing, because the real server never
    // produces that shape — a controller reading it would look correct in a
    // test built the same wrong way.
    const request = requestWith(undefined) as unknown as Record<string, unknown>;
    request['cookies'] = { [REFRESH_COOKIE]: 'from-a-parser-that-is-not-registered' };

    await controller.changePassword(BODY, request as unknown as AuthenticatedRequest);
    expect(sparedToken()).toBeUndefined();
  });
});
