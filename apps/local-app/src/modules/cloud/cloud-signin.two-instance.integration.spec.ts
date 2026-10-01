/* eslint-disable @typescript-eslint/no-require-imports */
import { createServer, type Server } from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { AddressInfo } from 'node:net';
import * as jose from 'jose';

/**
 * Cloud sign-in against a remote through home's `/r` proxy (master plan 3.10).
 * A local identity-service stand-in serves the JWKS and pre-signed tokens so the
 * host's real CloudSessionManager validation path runs; only the bridge tunnel
 * stays mocked (as in every two-instance spec).
 */
describe('cloud sign-in and instance label through the /r proxy', () => {
  let identityServer: Server;
  let identityUrl: string;
  let accessToken: string;
  let refreshToken: string;
  // Populated in beforeAll: the fixture must be required AFTER IDENTITY_SERVICE_URL
  // is set — the session manager reads it into a module-level constant at import.
  let instances: import('../../common/test/two-instance.fixture').TwoInstances;
  let remote: import('../storage/models/domain.models').Remote;

  beforeAll(async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const jwk = publicKey.export({ format: 'jwk' }) as { kty: string; crv: string; x: string };
    const jwks = { keys: [{ ...jwk, kid: 'test-key', use: 'sig', alg: 'EdDSA' }] };

    const mint = async () =>
      new jose.SignJWT({ email: 'user@example.com' })
        .setProtectedHeader({ alg: 'EdDSA', kid: 'test-key' })
        .setSubject('user-signin-1')
        .setExpirationTime('1h')
        .sign(privateKey);

    identityServer = createServer((req, res) => {
      if (req.url === '/.well-known/jwks.json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(jwks));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found', url: req.url }));
    });
    await new Promise<void>((resolve) => identityServer.listen(0, '127.0.0.1', resolve));
    identityUrl = `http://127.0.0.1:${(identityServer.address() as AddressInfo).port}`;

    process.env.IDENTITY_SERVICE_URL = identityUrl;
    [accessToken, refreshToken] = await Promise.all([mint(), mint()]);

    const { startTwoInstances } = require('../../common/test/two-instance.fixture');
    instances = await startTwoInstances();
    remote = await instances.registerRemote('lab-host');
  }, 60_000);

  afterAll(async () => {
    await instances?.close();
    identityServer?.close();
    delete process.env.IDENTITY_SERVICE_URL;
  });

  async function waitRemoteUsable() {
    const list = await fetch(`${instances.home.url}/api/remotes`);
    const body = (await list.json()) as {
      items: Array<{ id: string; online: boolean; versionMatches: boolean }>;
    };
    const entry = body.items.find((item) => item.id === remote.id);
    return entry?.online && entry.versionMatches ? entry : null;
  }

  it('stores the instance label set through the proxy in the host settings', async () => {
    await require('../../common/test/two-instance.fixture').waitForValue(waitRemoteUsable, 10_000);

    const response = await fetch(`${instances.home.url}/r/${remote.id}/api/cloud/instance-label`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'lab-host' }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ label: 'lab-host' });

    const stored = instances.host.sqlite
      .prepare("SELECT value FROM settings WHERE key = 'cloud.instanceLabel'")
      .get() as { value: string } | undefined;
    expect(stored?.value).toBe(JSON.stringify('lab-host'));
  });

  it('hands sign-in tokens to the host through the proxy and leaves home unchanged', async () => {
    const response = await fetch(`${instances.home.url}/r/${remote.id}/api/auth/cloud/tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accessToken, refreshToken }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      userId: 'user-signin-1',
      email: 'user@example.com',
    });

    const hostStatus = await fetch(`${instances.host.url}/api/auth/cloud/status`).then((r) =>
      r.json(),
    );
    expect(hostStatus).toMatchObject({ connected: true, userId: 'user-signin-1' });

    const homeStatus = await fetch(`${instances.home.url}/api/auth/cloud/status`).then((r) =>
      r.json(),
    );
    expect(homeStatus).toMatchObject({ connected: false });
  });
});
