import type { NotificationEmailSettings } from '@nexuspuppet/contracts';

/*
 * What gets handed to nodemailer, which is where the encryption choice either
 * means what it says or quietly does something else.
 *
 * Mocked at the module boundary rather than by sending mail: the property under
 * test is the transport OPTIONS, and a real SMTP conversation would test
 * nodemailer instead.
 */
const created: Array<Record<string, unknown>> = [];

jest.mock('nodemailer', () => ({
  createTransport: (options: Record<string, unknown>) => {
    created.push(options);
    return {
      sendMail: async () => ({ messageId: 'test' }),
      close: () => undefined,
    };
  },
}));

import { NotificationEmailTransport } from './notification-email.transport';

const base: NotificationEmailSettings = {
  host: 'relay.example.com',
  port: 25,
  encryption: 'none',
  from: 'nexuspuppet@example.com',
  to: 'ops@example.com',
  rejectUnauthorized: true,
  timeoutMs: 10_000,
};

const payload = {
  conditionKey: 'test',
  title: 'Test',
  body: 'body',
  severity: 'info',
} as never;

describe('NotificationEmailTransport options', () => {
  beforeEach(() => {
    created.length = 0;
  });

  /*
   * THE BUG THIS EXISTS FOR. Without ignoreTLS, nodemailer upgrades
   * opportunistically the moment a relay advertises STARTTLS — so an operator
   * who chose no encryption still got a TLS handshake, and a plaintext relay
   * with a self-signed certificate failed with `self-signed certificate`.
   * Reported from a real deployment against a port-25 relay.
   */
  it('does not negotiate TLS at all when encryption is none', async () => {
    await new NotificationEmailTransport().deliver(base, payload);

    expect(created[0]?.['ignoreTLS']).toBe(true);
    expect(created[0]?.['secure']).toBe(false);
    expect(created[0]?.['requireTLS']).toBeUndefined();
  });

  it('requires the upgrade for starttls, and does not ignore TLS', async () => {
    await new NotificationEmailTransport().deliver(
      { ...base, encryption: 'starttls', port: 587 },
      payload,
    );

    expect(created[0]?.['requireTLS']).toBe(true);
    expect(created[0]?.['ignoreTLS']).toBeUndefined();
    expect(created[0]?.['secure']).toBe(false);
  });

  // `secure` is implicit TLS from the first byte, which is a different thing
  // from STARTTLS wearing a confusingly similar name.
  it('uses implicit TLS for tls', async () => {
    await new NotificationEmailTransport().deliver(
      { ...base, encryption: 'tls', port: 465 },
      payload,
    );

    expect(created[0]?.['secure']).toBe(true);
    expect(created[0]?.['ignoreTLS']).toBeUndefined();
  });

  it('passes the self-signed opt-out through only when asked', async () => {
    await new NotificationEmailTransport().deliver(
      { ...base, encryption: 'starttls', rejectUnauthorized: false },
      payload,
    );

    expect(created[0]?.['tls']).toEqual({ rejectUnauthorized: false });
  });

  it('leaves certificate verification on by default', async () => {
    await new NotificationEmailTransport().deliver({ ...base, encryption: 'starttls' }, payload);

    expect(created[0]?.['tls']).toBeUndefined();
  });
});
