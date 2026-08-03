import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { ConsoleTlsService } from '../src/system/console-tls.service';

/**
 * The certificate surface, against real files on a real filesystem.
 *
 * The states that matter are the ones an operator is actually in: no TLS at all
 * (most deployments), a certificate about to expire, a certificate for the wrong
 * name, and a path pointing at something that is not a certificate. Each has a
 * different next action, so each must be distinguishable in the response.
 */

const isRoot = process.getuid?.() === 0;

const generate = (dir: string, name: string, args: string[]): string => {
  const cert = join(dir, `${name}.pem`);
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      join(dir, `${name}.key`),
      '-out',
      cert,
      ...args,
    ],
    { stdio: 'ignore' },
  );
  return cert;
};

describe('console TLS status (integration)', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'nexuspuppet-tls-'));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports "not configured" without a path, and calls it no error', async () => {
    // The majority case: TLS terminated at the operator's own proxy. Rendering
    // this as a problem would train people to ignore the card.
    const status = await new ConsoleTlsService(null, null).status();

    expect(status.configured).toBe(false);
    expect(status.error).toBeNull();
    expect(status.certificate).toBeNull();
  });

  it('summarises a real certificate and confirms it covers the hostname', async () => {
    const cert = generate(dir, 'good', [
      '-days',
      '90',
      '-subj',
      '/CN=console.example.com',
      '-addext',
      'subjectAltName=DNS:console.example.com',
    ]);

    const status = await new ConsoleTlsService(cert, 'console.example.com').status();

    expect(status.configured).toBe(true);
    expect(status.error).toBeNull();
    expect(status.certificate?.subject).toContain('console.example.com');
    expect(status.certificate?.expired).toBe(false);
    expect(status.certificate?.daysRemaining).toBeGreaterThan(85);
    expect(status.coversExpectedHostname).toBe(true);
  });

  it('reports a hostname mismatch as false, which a browser will reject', async () => {
    const cert = generate(dir, 'wrongname', [
      '-days',
      '90',
      '-subj',
      '/CN=other.example.com',
      '-addext',
      'subjectAltName=DNS:other.example.com',
    ]);

    const status = await new ConsoleTlsService(cert, 'console.example.com').status();

    expect(status.coversExpectedHostname).toBe(false);
    // Still a perfectly valid certificate — the problem is which name it carries,
    // and conflating that with "unreadable" would send someone to the wrong fix.
    expect(status.error).toBeNull();
    expect(status.certificate).not.toBeNull();
  });

  it('distinguishes "not checked" from "does not match"', async () => {
    const cert = generate(dir, 'nohost', ['-days', '90', '-subj', '/CN=a.test']);

    const status = await new ConsoleTlsService(cert, null).status();

    // Null, not false. Nobody declared a hostname, so there is nothing to
    // disagree with, and an operator should not be told their certificate is
    // wrong because they did not set an optional variable.
    expect(status.coversExpectedHostname).toBeNull();
  });

  it('says the file is missing rather than failing opaquely', async () => {
    const status = await new ConsoleTlsService(join(dir, 'absent.pem'), null).status();

    expect(status.configured).toBe(true);
    expect(status.errorCode).toBe('missing');
    expect(status.certificate).toBeNull();
    // The KIND of failure, in words an operator can act on, and no server path.
    expect(status.error).toMatch(/no certificate is visible/i);
    expect(status.error).not.toMatch(/\//);
  });

  it('says a private key is not a certificate', async () => {
    // Pointing this at the key instead of the certificate is the obvious
    // mistake, and it must not read as "your certificate is corrupt".
    generate(dir, 'forkey', ['-days', '90', '-subj', '/CN=a.test']);

    const status = await new ConsoleTlsService(join(dir, 'forkey.key'), null).status();

    expect(status.errorCode).toBe('unparsable');
    expect(status.certificate).toBeNull();
    expect(status.error).toMatch(/not a readable certificate/i);
  });

  (isRoot ? it.skip : it)('names a permissions problem as one', async () => {
    const cert = generate(dir, 'unreadable', ['-days', '90', '-subj', '/CN=a.test']);
    chmodSync(cert, 0o000);

    try {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      try {
        const status = await new ConsoleTlsService(cert, null).status();

        expect(status.errorCode).toBe('unreadable');

        /*
         * The diagnosis moved to the LOG, and has to still be there.
         *
         * The path and the uid are what somebody with shell access needs, and
         * they were removed from the API response because a browser is not
         * where a filesystem path helps anybody. Removing them from the
         * response without keeping them in the log would have destroyed the
         * only means of diagnosing this, so that is asserted rather than
         * assumed.
         */
        const logged = warn.mock.calls.map((call) => String(call[0])).join('\n');
        expect(logged).toContain(cert);
        expect(logged).toMatch(/uid \d+/);

        // ...and none of it reaches the caller.
        expect(status.error).not.toContain(cert);
        expect(status.error).not.toMatch(/uid \d+/);
      } finally {
        warn.mockRestore();
      }
    } finally {
      chmodSync(cert, 0o644);
    }
  });

  it('never returns key material, whatever it is pointed at', async () => {
    // The load-bearing property of ADR-0013. Asserted rather than assumed,
    // because the cost of being wrong is a private key in an HTTP response.
    const cert = generate(dir, 'leakcheck', ['-days', '90', '-subj', '/CN=a.test']);
    const key = readFileSync(join(dir, 'leakcheck.key'), 'utf8');

    const status = await new ConsoleTlsService(cert, null).status();
    const serialised = JSON.stringify(status);

    expect(serialised).not.toContain('PRIVATE KEY');
    expect(serialised).not.toContain(key.slice(100, 200));
    // Nor the public certificate body — the summary is metadata, not the file.
    expect(serialised).not.toContain('BEGIN CERTIFICATE');
  });
});
