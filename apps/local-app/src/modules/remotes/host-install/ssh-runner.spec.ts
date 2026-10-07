import { createServer, type Server as NetServer } from 'node:net';
import { utils } from 'ssh2';
import { hostKey, startFakeSsh } from '../../../common/test/fake-ssh.server';
import {
  resolveSshCommandTimeoutMs,
  SSH_COMMAND_TIMEOUT_MS,
  SSH_MAX_CAPTURE_BYTES,
  SshRunner,
} from './ssh-runner';

async function unusedPort(): Promise<number> {
  const server: NetServer = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No TCP port');
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe('SshRunner host verification', () => {
  const runner = new SshRunner();
  const credentials = { user: 'tester', password: 'connection-secret' };

  it('uses 30 seconds by default, honors a longer request, and lets the absolute deadline win', () => {
    const now = 1_000_000;

    expect(resolveSshCommandTimeoutMs({}, now)).toBe(SSH_COMMAND_TIMEOUT_MS);
    expect(resolveSshCommandTimeoutMs({ timeoutMs: 120_000 }, now)).toBe(120_000);
    expect(resolveSshCommandTimeoutMs({ timeoutMs: 120_000, deadlineAt: now + 45_000 }, now)).toBe(
      45_000,
    );
  });

  it('classifies connection failures without disclosing credentials', async () => {
    const port = await unusedPort();

    await expect(runner.connect({ host: '127.0.0.1', port, credentials })).rejects.toMatchObject({
      code: 'SSH_CONNECT_FAILED',
      message: expect.not.stringContaining(credentials.password),
    });
  });

  it('authenticates each install session with a valid public-key signature', async () => {
    const clientKey = utils.generateKeyPairSync('rsa', { bits: 2_048 });
    const parsed = utils.parseKey(clientKey.public);
    if (parsed instanceof Error) throw parsed;
    let verifiedSignatures = 0;
    const server = await startFakeSsh(hostKey(), 0, 'ok', (context) => {
      if (context.method !== 'publickey') {
        context.reject(['publickey']);
        return;
      }
      if (!parsed.getPublicSSH().equals(context.key.data)) {
        context.reject(['publickey']);
        return;
      }
      if (context.signature && context.blob) {
        if (!parsed.verify(context.blob, context.signature, context.hashAlgo)) {
          context.reject(['publickey']);
          return;
        }
        verifiedSignatures += 1;
      }
      context.accept();
    });
    const keyCredentials = { user: 'tester', privateKey: clientKey.private };

    try {
      await runner.connect({ host: '127.0.0.1', port: server.port, credentials: keyCredentials });
      await runner.withSession(
        { host: '127.0.0.1', port: server.port, credentials: keyCredentials },
        (session) => session.exec('check'),
      );
      await runner.withSession(
        { host: '127.0.0.1', port: server.port, credentials: keyCredentials },
        (session) => session.exec('install'),
      );

      expect(verifiedSignatures).toBe(3);
    } finally {
      await server.close();
    }
  });

  it('explains when a key-only VM does not offer password authentication', async () => {
    const server = await startFakeSsh(hostKey(), 0, '', (context) => context.reject(['publickey']));
    try {
      await expect(
        runner.connect({ host: '127.0.0.1', port: server.port, credentials }),
      ).rejects.toMatchObject({
        code: 'SSH_AUTH_FAILED',
        message: 'The VM accepts only: publickey. Choose a private key.',
      });
    } finally {
      await server.close();
    }
  });

  it('explains when a VM refuses the configured public key', async () => {
    const wrongKey = hostKey();
    const server = await startFakeSsh(hostKey(), 0, '', (context) => context.reject(['publickey']));
    try {
      await expect(
        runner.connect({
          host: '127.0.0.1',
          port: server.port,
          credentials: { user: 'ubuntu', privateKey: wrongKey },
        }),
      ).rejects.toMatchObject({
        code: 'SSH_AUTH_FAILED',
        message:
          'The VM refused the private key login for ubuntu. Check the SSH user and the authorized key.',
      });
    } finally {
      await server.close();
    }
  });

  it('classifies a synchronous private-key parse failure without disclosing the key', async () => {
    const privateKey = 'invalid-private-key-secret';

    await expect(
      runner.connect({
        host: '127.0.0.1',
        port: 22,
        credentials: { user: 'ubuntu', privateKey },
      }),
    ).rejects.toMatchObject({
      code: 'SSH_KEY_INVALID',
      message: expect.not.stringContaining(privateKey),
    });
  });

  it('records the first host key and refuses a changed key on a later connection', async () => {
    const first = await startFakeSsh(hostKey());
    const port = first.port;
    const fingerprint = await runner.connect({ host: '127.0.0.1', port, credentials });
    await first.close();

    const second = await startFakeSsh(hostKey(), port);
    try {
      expect(fingerprint).toMatch(/^SHA256:/);
      await expect(
        runner.connect({
          host: '127.0.0.1',
          port,
          credentials,
          expectedFingerprint: fingerprint,
        }),
      ).rejects.toMatchObject({ code: 'SSH_HOST_KEY_CHANGED' });
    } finally {
      await second.close();
    }
  });

  it('scrubs every credential value from captured stdout and stderr', async () => {
    const privateKey = hostKey();
    const passphrase = 'PASSPHRASE-SECRET';
    const sudoPassword = 'SUDO-SECRET';
    const output = [credentials.password, privateKey, passphrase, sudoPassword].join(' ');
    const server = await startFakeSsh(hostKey(), 0, output);
    try {
      const result = await runner.withSession(
        {
          host: '127.0.0.1',
          port: server.port,
          credentials: { ...credentials, privateKey, passphrase, sudoPassword },
        },
        (session) => session.exec('credential-output'),
      );

      expect(result.stdout).toBe('[REDACTED] [REDACTED] [REDACTED] [REDACTED]');
      expect(result.stderr).toBe(result.stdout);
      for (const secret of [credentials.password, privateKey, passphrase, sudoPassword]) {
        expect(JSON.stringify(result)).not.toContain(secret);
      }
    } finally {
      await server.close();
    }
  });

  it('uploads a generated block through SFTP to a mktemp file with mode 0600', async () => {
    const server = await startFakeSsh(hostKey());
    try {
      const path = await runner.withSession(
        { host: '127.0.0.1', port: server.port, credentials },
        (session) => session.uploadTemp('generated host install block'),
      );

      expect(path).toBe('/tmp/devchain-host-install.fake123');
      expect(server.files.get(path)?.toString()).toBe('generated host install block');
      expect(server.modes.get(path)).toBe(0o600);
    } finally {
      await server.close();
    }
  });

  it('times out a command whose channel never finishes and remains usable for retry', async () => {
    const hanging = await startFakeSsh(hostKey(), 0, '__DEVCHAIN_HANG__');
    try {
      await expect(
        runner.withSession({ host: '127.0.0.1', port: hanging.port, credentials }, (session) =>
          session.exec('hang', '', { timeoutMs: 25 }),
        ),
      ).rejects.toMatchObject({ code: 'SSH_COMMAND_TIMEOUT' });
    } finally {
      await hanging.close();
    }

    const retry = await startFakeSsh(hostKey(), 0, 'retry completed');
    try {
      await expect(
        runner.withSession({ host: '127.0.0.1', port: retry.port, credentials }, (session) =>
          session.exec('retry'),
        ),
      ).resolves.toMatchObject({ code: 0, stdout: 'retry completed' });
    } finally {
      await retry.close();
    }
  });

  it('retains only the configured output tail while data is received', async () => {
    const output = `${'discarded-'.repeat(20_000)}${'x'.repeat(SSH_MAX_CAPTURE_BYTES + 10_000)}`;
    const server = await startFakeSsh(hostKey(), 0, output);
    try {
      const result = await runner.withSession(
        { host: '127.0.0.1', port: server.port, credentials },
        (session) => session.exec('large-output'),
      );

      expect(Buffer.byteLength(result.stdout)).toBe(SSH_MAX_CAPTURE_BYTES);
      expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(SSH_MAX_CAPTURE_BYTES);
      expect(Buffer.byteLength(result.stderr)).toBeGreaterThan(0);
      expect(result.stdout).toBe('x'.repeat(SSH_MAX_CAPTURE_BYTES));
    } finally {
      await server.close();
    }
  });

  it('redacts credentials split across chunks and the retained-tail boundary', async () => {
    const password = 'boundary-secret-value';
    const prefix = 'p'.repeat(100);
    const suffix = 'q'.repeat(SSH_MAX_CAPTURE_BYTES - '[REDACTED]'.length);
    const server = await startFakeSsh(hostKey(), 0, [
      prefix,
      'boundary-',
      'secret-',
      'value',
      suffix,
    ]);
    try {
      const result = await runner.withSession(
        {
          host: '127.0.0.1',
          port: server.port,
          credentials: { user: 'tester', password },
        },
        (session) => session.exec('split-secret'),
      );

      expect(Buffer.byteLength(result.stdout)).toBe(SSH_MAX_CAPTURE_BYTES);
      expect(result.stdout).toBe(`[REDACTED]${suffix}`);
      expect(result.stdout).not.toContain(password);
      expect(result.stdout).not.toContain('boundary-');
      expect(result.stdout).not.toContain('secret-value');
      expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(SSH_MAX_CAPTURE_BYTES);
      expect(result.stderr).not.toContain(password);
      expect(result.stderr).not.toContain('boundary-');
      expect(result.stderr).not.toContain('secret-value');
    } finally {
      await server.close();
    }
  });
});
