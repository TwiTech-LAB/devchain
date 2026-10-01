import Database from 'better-sqlite3';
import * as https from 'node:https';
import { X509Certificate } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { rootCertificates } from 'node:tls';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { ProxmoxClient } from '@devchain/proxmox-client';
import { LocalStorageService } from '../storage/local/local-storage.service';
import { IntegrationCredentialCipher } from '../storage/local/integration-credential-cipher';
import { AddressVmProvider } from './address-vm.provider';
import { VmProvidersController } from './vm-providers.controller';
import { VmProvidersService } from './vm-providers.service';

const MIGRATIONS_FOLDER = join(__dirname, '../../../drizzle');
const TOKEN_SECRET = 'plain-token-secret-123';

describe('VM provider storage and REST boundary', () => {
  let sqlite: Database.Database;
  let secretDirectory: string;
  let storage: LocalStorageService;
  let service: VmProvidersService;
  let controller: VmProvidersController;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    migrate(drizzle(sqlite), { migrationsFolder: MIGRATIONS_FOLDER });
    sqlite.pragma('foreign_keys = ON');
    secretDirectory = mkdtempSync(join(tmpdir(), 'devchain-vm-provider-secret-'));
    storage = new LocalStorageService(
      drizzle(sqlite),
      new IntegrationCredentialCipher({
        secretDirectory,
        machineIdentity: 'vm-provider:test',
      }),
    );
    service = new VmProvidersService(
      storage,
      new AddressVmProvider(),
      new ProxmoxClient({ requestTimeoutMs: 1000, maxResponseBytes: 64 * 1024 }),
    );
    controller = new VmProvidersController(service);
  });

  afterEach(() => {
    sqlite.close();
    if (secretDirectory) rmSync(secretDirectory, { recursive: true, force: true });
  });

  const input = {
    kind: 'proxmox' as const,
    name: 'Lab',
    apiUrl: 'https://pve.test:8006',
    node: 'hw',
    pool: 'devchain',
    storage: 'local-lvm',
    imageStorage: 'local',
    bridge: 'vmbr0',
    vmidMin: 100,
    vmidMax: 200,
    namePrefix: 'dc-',
    tag: 'devchain',
    sslFingerprint: 'AB'.repeat(32),
    tokenId: 'root@pam!devchain',
    tokenSecret: TOKEN_SECRET,
  };

  it('encrypts the token and omits both plaintext and ciphertext from REST responses', async () => {
    const created = await controller.create(input);
    const listed = await controller.list();
    const row = sqlite
      .prepare('SELECT token_secret_ciphertext FROM vm_provider_connections WHERE id = ?')
      .get(created.id) as { token_secret_ciphertext: string };

    expect(row.token_secret_ciphertext).toMatch(/^v1:/);
    expect(row.token_secret_ciphertext).not.toContain(TOKEN_SECRET);
    expect(await storage.readVmProviderTokenSecret(created.id)).toBe(TOKEN_SECRET);
    expect(JSON.stringify(created)).not.toContain(TOKEN_SECRET);
    expect(JSON.stringify(created)).not.toContain(row.token_secret_ciphertext);
    expect(JSON.stringify(listed)).not.toContain(TOKEN_SECRET);
    expect(JSON.stringify(listed)).not.toContain(row.token_secret_ciphertext);
    expect(listed.address.capabilities.create).toBe(false);
    expect(listed.items[0].capabilities.create).toBe(true);
    await expect(new AddressVmProvider().getPowerState('unused')).resolves.toBe('unknown');
  });

  it('round-trips optional CA PEM and leaf fingerprint over storage and REST', async () => {
    const caPem = rootCertificates[0];
    const created = await controller.create({ ...input, caPem });
    const listed = await controller.list();
    const row = sqlite
      .prepare(
        'SELECT ca_pem, ssl_fingerprint, token_secret_ciphertext FROM vm_provider_connections WHERE id = ?',
      )
      .get(created.id) as {
      ca_pem: string;
      ssl_fingerprint: string;
      token_secret_ciphertext: string;
    };

    expect(row.ca_pem).toBe(caPem);
    expect(row.ssl_fingerprint).toBe(input.sslFingerprint);
    expect(created).toMatchObject({ caPem, sslFingerprint: input.sslFingerprint });
    expect(listed.items[0]).toMatchObject({ caPem, sslFingerprint: input.sslFingerprint });
    expect(JSON.stringify(listed)).not.toContain(TOKEN_SECRET);
    expect(JSON.stringify(listed)).not.toContain(row.token_secret_ciphertext);
  });

  it('stores a Proxmox VM identity and spec, and supports provisioning without an address', async () => {
    const connection = await controller.create(input);
    const vmSpec = { cores: 4, memory: 4096, disk: 30 };
    const created = await storage.createRemote({
      name: 'dc-vm',
      kind: 'proxmox',
      baseUrl: 'http://10.0.0.7:4000',
      vmProviderConnectionId: connection.id,
      vmIdentity: '12345678-1234-1234-1234-123456789abc',
      vmSpec,
    });
    expect(await storage.getRemote(created.id)).toMatchObject({
      kind: 'proxmox',
      vmProviderConnectionId: connection.id,
      vmIdentity: '12345678-1234-1234-1234-123456789abc',
      vmSpec,
    });
    await expect(controller.delete(connection.id)).rejects.toThrow('used by a remote');

    const provisioning = await storage.createRemote({
      name: 'dc-next',
      kind: 'proxmox',
      baseUrl: null,
      vmProviderConnectionId: connection.id,
      vmIdentity: null,
      vmSpec,
    });
    expect(
      (await storage.listRemotes()).items.find((item) => item.id === provisioning.id)?.baseUrl,
    ).toBeNull();
    await storage.updateRemoteVmIdentity(provisioning.id, '12345678-1234-1234-1234-123456789abd');
    expect(
      (await storage.updateRemoteBaseUrl(provisioning.id, 'http://10.0.0.8:4000')).baseUrl,
    ).toBe('http://10.0.0.8:4000');
    expect(() =>
      sqlite.exec(`
      INSERT INTO remotes (id, name, base_url, kind, created_at, updated_at)
      VALUES ('bad-address', 'Bad', NULL, 'address', 'now', 'now')
    `),
    ).toThrow();
  });

  it('confirms a self-signed node fingerprint before storing or sending the token', async () => {
    const tlsDirectory = mkdtempSync(join(tmpdir(), 'devchain-vm-provider-onboarding-'));
    const keyPath = join(tlsDirectory, 'server.key');
    const certificatePath = join(tlsDirectory, 'server.crt');
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        keyPath,
        '-out',
        certificatePath,
        '-days',
        '2',
        '-subj',
        '/CN=127.0.0.1',
        '-addext',
        'subjectAltName=IP:127.0.0.1',
      ],
      { stdio: 'ignore' },
    );
    const certPem = readFileSync(certificatePath, 'utf8');
    const fingerprint = new X509Certificate(certPem).fingerprint256;
    const requests: Array<{ url: string; authorization: string | undefined }> = [];
    const permissions = Object.fromEntries(
      [
        'Pool.Audit',
        'VM.Allocate',
        'VM.Audit',
        'VM.Clone',
        'VM.Config.CPU',
        'VM.Config.Memory',
        'VM.Config.Disk',
        'VM.Config.Network',
        'VM.PowerMgmt',
        'VM.Monitor',
        'Datastore.Audit',
        'Datastore.AllocateSpace',
        'Datastore.AllocateTemplate',
        'SDN.Use',
        'Sys.AccessNetwork',
      ].map((privilege) => [privilege, 1]),
    );
    const fakeServer = https.createServer(
      { key: readFileSync(keyPath), cert: certPem },
      (request, response) => {
        const requestUrl = new URL(request.url ?? '/', 'https://127.0.0.1');
        requests.push({
          url: requestUrl.pathname + requestUrl.search,
          authorization: request.headers.authorization,
        });
        let data: unknown = { version: '8.2' };
        if (requestUrl.pathname.endsWith('/storage/local/content')) data = [];
        if (requestUrl.pathname === '/api2/json/cluster/nextid') data = '101';
        if (requestUrl.pathname === '/api2/json/access/permissions') {
          const path = requestUrl.searchParams.get('path') ?? '';
          data = path === '/vms/101' ? {} : { [path]: permissions };
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data }));
      },
    );
    await new Promise<void>((resolve) => fakeServer.listen(0, '127.0.0.1', resolve));

    try {
      const port = (fakeServer.address() as AddressInfo).port;
      const params = new URLSearchParams({
        pool: 'devchain',
        storage: 'local-lvm',
        imageStorage: 'local',
        bridge: 'vmbr0',
        fp: fingerprint,
        token: `devchain@pve!agent:${TOKEN_SECRET}`,
        ca: Buffer.from(certPem).toString('base64'),
      });
      const connectionString = `devchain-proxmox://127.0.0.1:${port}/hw?${params}`;

      const preview = await controller.connect({ connectionString });
      expect(preview).toEqual({
        confirmationRequired: true,
        fingerprint: fingerprint.replace(/:/g, '').match(/.{2}/g)?.join(':'),
        placement: {
          apiUrl: `https://127.0.0.1:${port}`,
          node: 'hw',
          pool: 'devchain',
          storage: 'local-lvm',
          imageStorage: 'local',
          bridge: 'vmbr0',
        },
      });
      expect(requests).toEqual([]);
      expect(await controller.list()).toMatchObject({ items: [] });

      const connected = await controller.connect({ connectionString, confirmFingerprint: true });
      expect(connected).toMatchObject({
        confirmationRequired: false,
        permissions: { ok: true, missing: [] },
      });
      expect(JSON.stringify(connected)).not.toContain(TOKEN_SECRET);
      expect(requests.length).toBeGreaterThan(0);
      expect(
        requests.every(
          (request) => request.authorization === `PVEAPIToken=devchain@pve!agent=${TOKEN_SECRET}`,
        ),
      ).toBe(true);

      const saved = sqlite
        .prepare(
          'SELECT api_url, ssl_fingerprint, ca_pem, token_secret_ciphertext FROM vm_provider_connections',
        )
        .get() as Record<string, string>;
      expect(saved.api_url).toBe(`https://127.0.0.1:${port}`);
      expect(saved.ssl_fingerprint).toBe(fingerprint.replace(/:/g, '').match(/.{2}/g)?.join(':'));
      expect(saved.ca_pem).toBe(certPem);
      expect(saved.token_secret_ciphertext).not.toContain(TOKEN_SECRET);
      expect(Object.values(saved).join('\n')).not.toContain(connectionString);
    } finally {
      await new Promise<void>((resolve, reject) =>
        fakeServer.close((error) => (error ? reject(error) : resolve())),
      );
      rmSync(tlsDirectory, { recursive: true, force: true });
    }
  });

  it('rejects a mismatched confirmed fingerprint without storing the connection or sending its token', async () => {
    const tlsDirectory = mkdtempSync(join(tmpdir(), 'devchain-vm-provider-mismatch-'));
    const keyPath = join(tlsDirectory, 'server.key');
    const certificatePath = join(tlsDirectory, 'server.crt');
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        keyPath,
        '-out',
        certificatePath,
        '-days',
        '2',
        '-subj',
        '/CN=127.0.0.1',
        '-addext',
        'subjectAltName=IP:127.0.0.1',
      ],
      { stdio: 'ignore' },
    );
    const certPem = readFileSync(certificatePath, 'utf8');
    const requests: string[] = [];
    const fakeServer = https.createServer(
      { key: readFileSync(keyPath), cert: certPem },
      (request, response) => {
        requests.push(request.url ?? '');
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: { version: '8.2' } }));
      },
    );
    await new Promise<void>((resolve) => fakeServer.listen(0, '127.0.0.1', resolve));

    try {
      const port = (fakeServer.address() as AddressInfo).port;
      const params = new URLSearchParams({
        pool: 'devchain',
        storage: 'local-lvm',
        imageStorage: 'local',
        bridge: 'vmbr0',
        fp: '00'.repeat(32),
        token: `devchain@pve!agent:${TOKEN_SECRET}`,
        ca: Buffer.from(certPem).toString('base64'),
      });
      const connectionString = `devchain-proxmox://127.0.0.1:${port}/hw?${params}`;
      await controller.connect({ connectionString });
      await expect(
        controller.connect({ connectionString, confirmFingerprint: true }),
      ).rejects.toThrow('Could not verify the Proxmox connection');
      expect(requests).toEqual([]);
      expect(await controller.list()).toMatchObject({ items: [] });
    } finally {
      await new Promise<void>((resolve, reject) =>
        fakeServer.close((error) => (error ? reject(error) : resolve())),
      );
      rmSync(tlsDirectory, { recursive: true, force: true });
    }
  });
});

it('migrates existing remote rows without losing a binding', () => {
  const legacy = new Database(':memory:');
  try {
    legacy.exec(`
      CREATE TABLE remotes (id text PRIMARY KEY NOT NULL, name text NOT NULL,
        base_url text NOT NULL, kind text NOT NULL, credential_ciphertext text,
        created_at text NOT NULL, updated_at text NOT NULL);
      CREATE TABLE remote_project_bindings (project_id text PRIMARY KEY NOT NULL,
        remote_id text NOT NULL REFERENCES remotes(id));
      INSERT INTO remotes VALUES ('old-remote', 'Old', 'http://10.0.0.1', 'address', NULL, 'now', 'now');
      INSERT INTO remote_project_bindings VALUES ('project-1', 'old-remote');
    `);
    legacy.pragma('foreign_keys = ON');
    const migration = readFileSync(join(MIGRATIONS_FOLDER, '0092_amazing_synch.sql'), 'utf8');
    for (const statement of migration.split('--> statement-breakpoint')) {
      if (statement.trim()) legacy.exec(statement);
    }
    expect(
      legacy.prepare('SELECT id, base_url, vm_identity, vm_spec_json FROM remotes').get(),
    ).toEqual({
      id: 'old-remote',
      base_url: 'http://10.0.0.1',
      vm_identity: null,
      vm_spec_json: null,
    });
    expect(legacy.prepare('SELECT remote_id FROM remote_project_bindings').get()).toEqual({
      remote_id: 'old-remote',
    });
    expect(legacy.pragma('foreign_key_check')).toEqual([]);
  } finally {
    legacy.close();
  }
});
