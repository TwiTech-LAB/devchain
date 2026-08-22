import { Test, TestingModule } from '@nestjs/testing';
import { DB_CONNECTION } from '../../storage/db/db.provider';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { E2eeDeviceStoreService, type E2eePeerDevice } from './e2ee-device-store.service';
import { PAIRED_DEVICE_WORKSPACE_ACCESS_REVOKED_EVENT } from '../events/paired-device-workspace-access.events';

// Test layer: module-unit with REAL :memory: SQLite. The directory is JSON-serialized
// to the settings table; a real DB proves the add/get/revoke persistence + reset paths.
describe('E2eeDeviceStoreService', () => {
  let service: E2eeDeviceStoreService;
  let sqlite: Database.Database;
  let eventEmitter: { emit: jest.Mock };

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        id TEXT PRIMARY KEY,
        key TEXT NOT NULL UNIQUE,
        value TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE project_workspaces (id TEXT PRIMARY KEY);
      CREATE TABLE paired_device_workspace_grants (
        device_kid TEXT NOT NULL, workspace_id TEXT NOT NULL,
        PRIMARY KEY (device_kid, workspace_id)
      )
    `);
    const db = drizzle(sqlite);
    eventEmitter = { emit: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        E2eeDeviceStoreService,
        { provide: DB_CONNECTION, useValue: db },
        { provide: EventEmitter2, useValue: eventEmitter },
      ],
    }).compile();

    service = module.get<E2eeDeviceStoreService>(E2eeDeviceStoreService);
  });

  afterEach(() => {
    sqlite.close();
  });

  const sample = (kid = 'a'.repeat(32)): Omit<E2eePeerDevice, 'addedAt' | 'trust'> => ({
    kid,
    publicKeyB64: Buffer.from(new Uint8Array(32).fill(1)).toString('base64'),
    label: 'Pixel 8',
  });

  it('returns an empty list when nothing is stored', () => {
    expect(service.list()).toEqual([]);
    expect(service.get('unknown')).toBeNull();
  });

  it('adds a peer device and retrieves it by kid', () => {
    const rec = service.add(sample());
    expect(rec.kid).toBe('a'.repeat(32));
    expect(rec.addedAt).toBeDefined();
    expect(rec.label).toBe('Pixel 8');

    const got = service.get('a'.repeat(32));
    expect(got).toEqual(rec);
  });

  it('persists across a new service instance (restart)', () => {
    service.add(sample('b'.repeat(32)));
    const restarted = new E2eeDeviceStoreService(drizzle(sqlite));
    expect(restarted.get('b'.repeat(32))?.publicKeyB64).toBeDefined();
    expect(restarted.list()).toHaveLength(1);
  });

  it('updates (overwrites) a device on re-add with the same kid', () => {
    service.add(sample('c'.repeat(32)));
    const updated = service.add({
      kid: 'c'.repeat(32),
      publicKeyB64: Buffer.from(new Uint8Array(32).fill(9)).toString('base64'),
    });
    expect(updated.label).toBeUndefined();
    expect(service.list()).toHaveLength(1);
    expect(service.get('c'.repeat(32))?.publicKeyB64).toBe(
      Buffer.from(new Uint8Array(32).fill(9)).toString('base64'),
    );
  });

  it('revokes a device by kid and returns true; false when unknown', () => {
    service.add(sample('d'.repeat(32)));
    expect(service.revoke('d'.repeat(32))).toBe(true);
    expect(service.get('d'.repeat(32))).toBeNull();
    expect(service.revoke('never')).toBe(false);
    expect(eventEmitter.emit).toHaveBeenCalledWith(PAIRED_DEVICE_WORKSPACE_ACCESS_REVOKED_EVENT, {
      deviceKid: 'd'.repeat(32),
      reason: 'device-revoked',
    });
  });

  it('clears orphan grants on first adoption but preserves grants on repeated same-kid adoption', () => {
    const kid = 'g'.repeat(32);
    sqlite.prepare('INSERT INTO project_workspaces (id) VALUES (?)').run('w1');
    const insertGrant = sqlite.prepare(
      'INSERT INTO paired_device_workspace_grants (device_kid, workspace_id) VALUES (?, ?)',
    );
    insertGrant.run(kid, 'w1');

    service.add(sample(kid));
    expect(
      sqlite.prepare('SELECT * FROM paired_device_workspace_grants WHERE device_kid = ?').all(kid),
    ).toEqual([]);

    insertGrant.run(kid, 'w1');
    service.add(sample(kid));
    expect(
      sqlite
        .prepare('SELECT workspace_id FROM paired_device_workspace_grants WHERE device_kid = ?')
        .all(kid),
    ).toEqual([{ workspace_id: 'w1' }]);
  });

  it('deletes grants on revoke and never transfers them through installId supersession', () => {
    const oldKid = 'h'.repeat(32);
    const newKid = 'i'.repeat(32);
    const installId = '11111111-1111-4111-8111-111111111111';
    sqlite.prepare('INSERT INTO project_workspaces (id) VALUES (?)').run('w1');
    service.add({ ...sample(oldKid), installId });
    sqlite
      .prepare(
        'INSERT INTO paired_device_workspace_grants (device_kid, workspace_id) VALUES (?, ?)',
      )
      .run(oldKid, 'w1');

    service.add({ ...sample(newKid), installId });

    expect(service.get(oldKid)).toBeNull();
    expect(
      sqlite.prepare('SELECT * FROM paired_device_workspace_grants ORDER BY device_kid').all(),
    ).toEqual([]);
    expect(eventEmitter.emit).toHaveBeenCalledWith(PAIRED_DEVICE_WORKSPACE_ACCESS_REVOKED_EVENT, {
      deviceKid: oldKid,
      reason: 'device-revoked',
    });
    sqlite
      .prepare(
        'INSERT INTO paired_device_workspace_grants (device_kid, workspace_id) VALUES (?, ?)',
      )
      .run(newKid, 'w1');
    expect(service.revoke(newKid)).toBe(true);
    expect(sqlite.prepare('SELECT * FROM paired_device_workspace_grants').all()).toEqual([]);
  });

  it('does not share a namespace with the keypair record', () => {
    service.add(sample());
    const keypairRow = sqlite
      .prepare("SELECT value FROM settings WHERE key = 'cloud.e2ee.keypair'")
      .get() as { value: string } | undefined;
    expect(keypairRow).toBeUndefined();
    const devicesRow = sqlite
      .prepare("SELECT value FROM settings WHERE key = 'cloud.e2ee.devices'")
      .get() as { value: string } | undefined;
    expect(devicesRow).toBeDefined();
  });

  it('resets gracefully if the stored directory is corrupt JSON', () => {
    service.add(sample());
    sqlite
      .prepare("UPDATE settings SET value = ? WHERE key = 'cloud.e2ee.devices'")
      .run('not-json');
    expect(service.list()).toEqual([]);
    // and is usable afterwards
    service.add(sample('e'.repeat(32)));
    expect(service.list()).toHaveLength(1);
  });

  describe('local aliases', () => {
    const INSTALL = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const pub = (fill: number) => Buffer.from(new Uint8Array(32).fill(fill)).toString('base64');

    it('persists an alias across restart and clears it without changing the reported label', () => {
      const kid = 'j'.repeat(32);
      service.add({ ...sample(kid), label: 'Reported phone' });
      expect(service.setLocalAlias(kid, 'My phone')).toMatchObject({
        label: 'Reported phone',
        localAlias: 'My phone',
      });
      expect(new E2eeDeviceStoreService(drizzle(sqlite)).get(kid)?.localAlias).toBe('My phone');

      expect(service.setLocalAlias(kid, null)).toMatchObject({ label: 'Reported phone' });
      expect(service.get(kid)).not.toHaveProperty('localAlias');
      expect(service.setLocalAlias('missing', 'Alias')).toBeNull();
    });

    it('keeps the alias while same-kid add/reconcile refresh the reported label', () => {
      const kid = 'k'.repeat(32);
      service.add({ kid, publicKeyB64: pub(1), label: 'Old label' });
      service.setLocalAlias(kid, 'Desk phone');

      const readded = service.add({ kid, publicKeyB64: pub(1), label: 'Fresh label' });
      expect(readded).toMatchObject({ label: 'Fresh label', localAlias: 'Desk phone' });

      const reconciled = service.reconcile({ kid, publicKeyB64: pub(1), label: 'Newest label' });
      expect(reconciled).toMatchObject({ label: 'Newest label', localAlias: 'Desk phone' });
    });

    it('keeps the alias when trust is verified', () => {
      const kid = 'l'.repeat(32);
      service.reconcile({ kid, publicKeyB64: pub(2), label: 'Phone' });
      service.setLocalAlias(kid, 'Personal');

      expect(service.markVerified(kid)).toMatchObject({
        trust: 'verified',
        label: 'Phone',
        localAlias: 'Personal',
      });
    });

    it('removes alias residue on revoke and install-id supersession', () => {
      const revokedKid = 'm'.repeat(32);
      service.add({ kid: revokedKid, publicKeyB64: pub(3) });
      service.setLocalAlias(revokedKid, 'Revoked alias');
      service.revoke(revokedKid);
      service.add({ kid: revokedKid, publicKeyB64: pub(3) });
      expect(service.get(revokedKid)?.localAlias).toBeUndefined();

      const oldKid = 'n'.repeat(32);
      const newKid = 'o'.repeat(32);
      service.add({ kid: oldKid, publicKeyB64: pub(4), installId: INSTALL });
      service.setLocalAlias(oldKid, 'Old alias');
      service.add(
        { kid: newKid, publicKeyB64: pub(5), installId: INSTALL },
        { evictVerified: true },
      );
      expect(service.get(oldKid)).toBeNull();
      expect(service.get(newKid)?.localAlias).toBeUndefined();
    });
  });

  describe('notification routing kid binding', () => {
    const pub = (fill: number) => Buffer.from(new Uint8Array(32).fill(fill)).toString('base64');
    const ROUTING_KID = 'kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k';
    const OTHER_ROUTING_KID = '7yNmI0TBXyYpXOZcaxXw8f3VvKdQmZLpR1sEgHtJbAo';

    it('binds a routing kid to a known device and persists it across restart', () => {
      const kid = 'p'.repeat(32);
      service.add({ kid, publicKeyB64: pub(6) });

      expect(service.setNotificationRoutingKid(kid, ROUTING_KID)).toMatchObject({
        kid,
        notificationRoutingKid: ROUTING_KID,
      });
      expect(new E2eeDeviceStoreService(drizzle(sqlite)).get(kid)?.notificationRoutingKid).toBe(
        ROUTING_KID,
      );
    });

    it('rebinding is deterministic and rebinding a new kid overwrites the old one', () => {
      const kid = 'q'.repeat(32);
      service.add({ kid, publicKeyB64: pub(7) });

      service.setNotificationRoutingKid(kid, ROUTING_KID);
      const rebound = service.setNotificationRoutingKid(kid, ROUTING_KID);
      expect(rebound?.notificationRoutingKid).toBe(ROUTING_KID);

      service.setNotificationRoutingKid(kid, OTHER_ROUTING_KID);
      expect(service.get(kid)?.notificationRoutingKid).toBe(OTHER_ROUTING_KID);
    });

    it('returns null for an unknown device or a malformed routing kid', () => {
      const kid = 'r'.repeat(32);
      service.add({ kid, publicKeyB64: pub(8) });

      expect(service.setNotificationRoutingKid('missing', ROUTING_KID)).toBeNull();
      expect(service.setNotificationRoutingKid(kid, 'short')).toBeNull();
      expect(service.setNotificationRoutingKid(kid, `+/${'x'.repeat(41)}=`)).toBeNull();
      expect(service.get(kid)?.notificationRoutingKid).toBeUndefined();
    });

    it('keeps the routing kid while same-kid add/reconcile refresh trust state', () => {
      const kid = 's'.repeat(32);
      service.add({ kid, publicKeyB64: pub(9) });
      service.setNotificationRoutingKid(kid, ROUTING_KID);

      const readded = service.add({ kid, publicKeyB64: pub(9) });
      expect(readded.notificationRoutingKid).toBe(ROUTING_KID);

      const reconciled = service.reconcile({ kid, publicKeyB64: pub(9) });
      expect(reconciled.notificationRoutingKid).toBe(ROUTING_KID);

      expect(service.markVerified(kid)?.notificationRoutingKid).toBe(ROUTING_KID);
    });

    it('drops the routing kid with the row on revoke', () => {
      const kid = 't'.repeat(32);
      service.add({ kid, publicKeyB64: pub(10) });
      service.setNotificationRoutingKid(kid, ROUTING_KID);

      service.revoke(kid);
      service.add({ kid, publicKeyB64: pub(10) });
      expect(service.get(kid)?.notificationRoutingKid).toBeUndefined();
    });
  });

  describe('idempotent re-pair (Task:7)', () => {
    it('overwrites a same-kid record in place on explicit re-pair — no duplicate', () => {
      const kid = 'p'.repeat(32);
      service.add({
        kid,
        publicKeyB64: Buffer.from(new Uint8Array(32).fill(1)).toString('base64'),
        trust: 'verified',
        verifiedVia: 'qr',
        verifiedAt: '2026-06-01T00:00:00.000Z',
      });
      // Store-level replacement for an explicitly re-paired record with the same lookup key.
      const repaired = service.add({
        kid,
        publicKeyB64: Buffer.from(new Uint8Array(32).fill(2)).toString('base64'),
        trust: 'verified',
        verifiedVia: 'qr',
        verifiedAt: '2026-06-22T00:00:00.000Z',
      });

      expect(service.list()).toHaveLength(1); // retired the old, no duplicate
      expect(repaired.publicKeyB64).toBe(
        Buffer.from(new Uint8Array(32).fill(2)).toString('base64'),
      );
      const restarted = new E2eeDeviceStoreService(drizzle(sqlite));
      expect(restarted.get(kid)?.verifiedAt).toBe('2026-06-22T00:00:00.000Z');
    });

    it('reconcile re-pair with the same key is a no-op overwrite (idempotent)', () => {
      const pub = Buffer.from(new Uint8Array(32).fill(3)).toString('base64');
      const first = service.reconcile({ kid: 'q'.repeat(32), publicKeyB64: pub });
      const second = service.reconcile({ kid: 'q'.repeat(32), publicKeyB64: pub });
      expect(service.list()).toHaveLength(1);
      expect(second.addedAt).toBe(first.addedAt); // unchanged record preserved
    });
  });

  describe('trust state (Task:4)', () => {
    it('defaults trust to unverified when not specified', () => {
      const rec = service.add(sample('f'.repeat(32)));
      expect(rec.trust).toBe('unverified');
      expect(rec.verifiedVia).toBeUndefined();
      expect(rec.verifiedAt).toBeUndefined();
    });

    it('persists a verified record with method + verifiedAt', () => {
      const rec = service.add({
        kid: 'g'.repeat(32),
        publicKeyB64: Buffer.from(new Uint8Array(32).fill(7)).toString('base64'),
        trust: 'verified',
        verifiedVia: 'qr',
        verifiedAt: '2026-06-22T00:00:00.000Z',
      });
      expect(rec.trust).toBe('verified');
      expect(rec.verifiedVia).toBe('qr');
      const restarted = new E2eeDeviceStoreService(drizzle(sqlite));
      expect(restarted.get('g'.repeat(32))?.trust).toBe('verified');
      expect(restarted.get('g'.repeat(32))?.verifiedVia).toBe('qr');
    });

    it('reconciles a brand-new key as unverified email-tofu (TOFU adopt)', () => {
      const rec = service.reconcile({
        kid: 'r'.repeat(32),
        publicKeyB64: Buffer.from(new Uint8Array(32).fill(3)).toString('base64'),
      });
      expect(rec.trust).toBe('unverified');
      expect(rec.adoptedVia).toBe('email-tofu');
      expect(service.get('r'.repeat(32))?.trust).toBe('unverified');
    });

    it('preserves a verified record when reconciling an unchanged key', () => {
      const pub = Buffer.from(new Uint8Array(32).fill(4)).toString('base64');
      service.add({ kid: 's'.repeat(32), publicKeyB64: pub, trust: 'verified', verifiedVia: 'qr' });
      const rec = service.reconcile({ kid: 's'.repeat(32), publicKeyB64: pub });
      expect(rec.trust).toBe('verified');
      expect(rec.verifiedVia).toBe('qr');
    });

    it('reverts to unverified when an existing device key changes (rotation)', () => {
      const kid = 't'.repeat(32);
      service.add({
        kid,
        publicKeyB64: Buffer.from(new Uint8Array(32).fill(5)).toString('base64'),
        trust: 'verified',
        verifiedVia: 'safety-number',
        verifiedAt: '2026-02-01T00:00:00.000Z',
      });
      const rotated = service.reconcile({
        kid,
        publicKeyB64: Buffer.from(new Uint8Array(32).fill(6)).toString('base64'),
      });
      expect(rotated.trust).toBe('unverified');
      expect(rotated.verifiedVia).toBeUndefined();
      expect(rotated.verifiedAt).toBeUndefined();
    });

    it('markVerified upgrades a TOFU record to verified via safety-number', () => {
      service.reconcile({
        kid: 'u'.repeat(32),
        publicKeyB64: Buffer.from(new Uint8Array(32).fill(8)).toString('base64'),
      });
      const verified = service.markVerified('u'.repeat(32), '2026-06-23T00:00:00.000Z');
      expect(verified?.trust).toBe('verified');
      expect(verified?.verifiedVia).toBe('safety-number');
      expect(verified?.verifiedAt).toBe('2026-06-23T00:00:00.000Z');
      // persisted
      expect(new E2eeDeviceStoreService(drizzle(sqlite)).get('u'.repeat(32))?.trust).toBe(
        'verified',
      );
    });

    it('markVerified returns null for an unknown device', () => {
      expect(service.markVerified('missing')).toBeNull();
    });

    it('normalizes a legacy record (no trust field) to unverified, never verified', () => {
      // Simulate a Task:3-era record persisted before the trust field existed.
      const legacy = {
        v: 1,
        devices: {
          ['h'.repeat(32)]: {
            kid: 'h'.repeat(32),
            publicKeyB64: Buffer.from(new Uint8Array(32).fill(2)).toString('base64'),
            addedAt: '2026-01-01T00:00:00.000Z',
          },
        },
      };
      const now = new Date().toISOString();
      sqlite
        .prepare(
          `INSERT INTO settings (id, key, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
        )
        .run('row-1', 'cloud.e2ee.devices', JSON.stringify(legacy), now, now);

      expect(service.get('h'.repeat(32))?.trust).toBe('unverified');
    });
  });

  describe('supersede-by-install-id (M2 paired-device-dedup, Task:3)', () => {
    // Canonical UUIDs (lowercase, hyphenated, v4/variant 8|9) — the shape the mobile mints.
    // Chosen with hex LETTERS so `.toUpperCase()` yields a genuinely non-canonical value.
    const INSTALL_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const INSTALL_B = 'bbbbbbbb-bbbb-4bbb-9bbb-bbbbbbbbbbbb';
    const pub = (fill: number) => Buffer.from(new Uint8Array(32).fill(fill)).toString('base64');

    // Replicates the push/viewport recipient-selection rule (most-recently-added usable
    // device) so we can prove selection lands on the live re-login key WITHOUT wiring the
    // crypto services: `list().filter(usable).sort(addedAt desc)[0]`.
    const selectPeerKid = (): string | undefined => {
      const usable = service.list().filter((d) => d.trust !== 'revoked');
      if (usable.length === 0) return undefined;
      return [...usable].sort((a, b) => (a.addedAt < b.addedAt ? 1 : -1))[0].kid;
    };

    it('QR complete (evictVerified:true) evicts ALL same-install rows — verified AND unverified', () => {
      service.add({
        kid: 'oldv'.repeat(8),
        publicKeyB64: pub(1),
        trust: 'verified',
        verifiedVia: 'qr',
        installId: INSTALL_A,
      });
      service.add({ kid: 'oldu'.repeat(8), publicKeyB64: pub(2), installId: INSTALL_A });
      expect(service.list()).toHaveLength(2); // both prior rows present

      const fresh = service.add(
        {
          kid: 'newk'.repeat(8),
          publicKeyB64: pub(3),
          trust: 'verified',
          verifiedVia: 'qr',
          installId: INSTALL_A,
        },
        { evictVerified: true },
      );

      expect(service.list()).toHaveLength(1);
      expect(service.list()[0].kid).toBe(fresh.kid);
    });

    it('TOFU adopt (evictVerified:false) evicts ONLY non-verified and PRESERVES verified (force-unpair defense)', () => {
      // A verified row (e.g. an earlier QR pairing) and a stale unverified row for the SAME phone.
      service.add({
        kid: 'vrfy'.repeat(8),
        publicKeyB64: pub(1),
        trust: 'verified',
        verifiedVia: 'qr',
        installId: INSTALL_A,
      });
      service.add({ kid: 'unvf'.repeat(8), publicKeyB64: pub(2), installId: INSTALL_A });

      // Plaintext-bootstrap re-login for the same install: a NEW unverified key.
      service.reconcile({ kid: 'newk'.repeat(8), publicKeyB64: pub(3) }, undefined, {
        installId: INSTALL_A,
        evictVerified: false,
      });

      const kids = service
        .list()
        .map((d) => d.kid)
        .sort();
      // stale unverified evicted; verified survives (must NOT be force-unpaired); new adopted.
      expect(kids).toEqual(['newk'.repeat(8), 'vrfy'.repeat(8)].sort());
      expect(service.get('vrfy'.repeat(8))?.trust).toBe('verified');
    });

    it('absent installId appends (today’s behavior — no eviction)', () => {
      service.add({ kid: 'a1'.repeat(16), publicKeyB64: pub(1), trust: 'verified' });
      service.add({ kid: 'a2'.repeat(16), publicKeyB64: pub(2) }, { evictVerified: true });
      expect(service.list()).toHaveLength(2);
      expect(service.list().every((d) => d.installId === undefined)).toBe(true);
    });

    it('invalid (non-canonical) installId is ignored for BOTH store and evict', () => {
      // Uppercase + a plainly-bad value are both non-canonical → never stored, never evict.
      service.add({
        kid: 'b1'.repeat(16),
        publicKeyB64: pub(1),
        installId: INSTALL_A.toUpperCase(),
      });
      service.add(
        { kid: 'b2'.repeat(16), publicKeyB64: pub(2), installId: 'not-a-uuid' },
        { evictVerified: true },
      );
      expect(service.list()).toHaveLength(2); // nothing evicted
      expect(service.get('b1'.repeat(16))?.installId).toBeUndefined(); // nothing stored
      expect(service.get('b2'.repeat(16))?.installId).toBeUndefined();
    });

    it('backfill: a same-key adopt persists installId onto a pre-installId record; next rotation dedupes', () => {
      const kidX = 'x'.repeat(32);
      // Pre-M2 row: reconciled without an installId.
      service.reconcile({ kid: kidX, publicKeyB64: pub(4) });
      expect(service.get(kidX)?.installId).toBeUndefined();

      // Same-key re-adopt now carrying an installId — reconcile returns the prior UNCHANGED,
      // but the installId must still be backfilled onto it.
      service.reconcile({ kid: kidX, publicKeyB64: pub(4) }, undefined, { installId: INSTALL_A });
      expect(service.get(kidX)?.installId).toBe(INSTALL_A);
      expect(new E2eeDeviceStoreService(drizzle(sqlite)).get(kidX)?.installId).toBe(INSTALL_A); // persisted

      // Next rotation (new kid, same install) dedupes the backfilled row.
      service.reconcile({ kid: 'y'.repeat(32), publicKeyB64: pub(5) }, undefined, {
        installId: INSTALL_A,
      });
      expect(service.list()).toHaveLength(1);
      expect(service.list()[0].kid).toBe('y'.repeat(32));
    });

    it('supersede is scoped to the matching install only (a different phone is untouched)', () => {
      service.add({
        kid: 'phb'.repeat(8) + 'bbbbbbbb',
        publicKeyB64: pub(1),
        installId: INSTALL_B,
      });
      service.add({ kid: 'olda'.repeat(8), publicKeyB64: pub(2), installId: INSTALL_A });
      service.add(
        { kid: 'newa'.repeat(8), publicKeyB64: pub(3), installId: INSTALL_A },
        { evictVerified: true },
      );
      const kids = service
        .list()
        .map((d) => d.kid)
        .sort();
      expect(kids).toEqual(['newa'.repeat(8), 'phb'.repeat(8) + 'bbbbbbbb'].sort()); // install B survives
    });

    it('SINGLE load/save: add-with-supersede persists in exactly ONE write (no add-then-evict window)', () => {
      service.add({ kid: 'stl'.repeat(8) + 'sssssss', publicKeyB64: pub(1), installId: INSTALL_A });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const saveSpy = jest.spyOn(service as any, 'save');
      service.add(
        { kid: 'liv'.repeat(8) + 'lllllll', publicKeyB64: pub(2), installId: INSTALL_A },
        { evictVerified: true },
      );
      expect(saveSpy).toHaveBeenCalledTimes(1); // one save == no intermediate persisted state
      // and the single persisted state already excludes the superseded row
      expect(new E2eeDeviceStoreService(drizzle(sqlite)).list().map((d) => d.kid)).toEqual([
        'liv'.repeat(8) + 'lllllll',
      ]);
      saveSpy.mockRestore();
    });

    it('recipient-selection proof: after a QR re-pair, selection lands on the live key with no stale same-install row', () => {
      service.add({
        kid: 'stale'.repeat(6) + 'ss',
        publicKeyB64: pub(1),
        trust: 'verified',
        verifiedVia: 'qr',
        addedAt: '2026-01-01T00:00:00.000Z',
        installId: INSTALL_A,
      });
      const live = service.add(
        {
          kid: 'live'.repeat(8),
          publicKeyB64: pub(2),
          trust: 'verified',
          verifiedVia: 'qr',
          addedAt: '2026-06-01T00:00:00.000Z',
          installId: INSTALL_A,
        },
        { evictVerified: true },
      );
      expect(selectPeerKid()).toBe(live.kid); // most-recently-added usable == the live re-login key
      expect(service.list().filter((d) => d.installId === INSTALL_A)).toHaveLength(1); // no stale same-install row
    });
  });

  describe('same-kid reconnect policy continuity (paired-kid-continuity)', () => {
    const INSTALL = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const pub = (fill: number) => Buffer.from(new Uint8Array(32).fill(fill)).toString('base64');

    const seedMultiWorkspaceGrants = (kid: string): void => {
      sqlite.exec("INSERT INTO project_workspaces (id) VALUES ('w1'), ('w2')");
      const insertGrant = sqlite.prepare(
        'INSERT INTO paired_device_workspace_grants (device_kid, workspace_id) VALUES (?, ?)',
      );
      insertGrant.run(kid, 'w1');
      insertGrant.run(kid, 'w2');
    };

    const grantsFor = (kid: string): string[] =>
      (
        sqlite
          .prepare(
            'SELECT workspace_id FROM paired_device_workspace_grants WHERE device_kid = ? ORDER BY workspace_id',
          )
          .all(kid) as Array<{ workspace_id: string }>
      ).map((row) => row.workspace_id);

    it('same-kid reconcile (email seam, unchanged key) preserves verified trust, alias, and multi-workspace grants', () => {
      const kid = 'same'.repeat(8);
      service.add({
        kid,
        publicKeyB64: pub(1),
        trust: 'verified',
        verifiedVia: 'qr',
        verifiedAt: '2026-06-01T00:00:00.000Z',
        installId: INSTALL,
      });
      service.setLocalAlias(kid, 'My Pixel');
      seedMultiWorkspaceGrants(kid);

      const reconnected = service.reconcile({ kid, publicKeyB64: pub(1) }, undefined, {
        installId: INSTALL,
        evictVerified: false,
      });

      expect(reconnected).toMatchObject({
        kid,
        trust: 'verified',
        verifiedVia: 'qr',
        localAlias: 'My Pixel',
        installId: INSTALL,
      });
      expect(grantsFor(kid)).toEqual(['w1', 'w2']);
      expect(service.list()).toHaveLength(1);
    });

    it('same-kid add (QR seam, evictVerified) stays verified and preserves alias and multi-workspace grants', () => {
      const kid = 'qrsm'.repeat(8);
      service.add({
        kid,
        publicKeyB64: pub(2),
        trust: 'verified',
        verifiedVia: 'qr',
        verifiedAt: '2026-06-01T00:00:00.000Z',
        installId: INSTALL,
      });
      service.setLocalAlias(kid, 'Desk phone');
      seedMultiWorkspaceGrants(kid);

      const rePaired = service.add(
        {
          kid,
          publicKeyB64: pub(2),
          trust: 'verified',
          verifiedVia: 'qr',
          verifiedAt: '2026-08-01T00:00:00.000Z',
          installId: INSTALL,
        },
        { evictVerified: true },
      );

      expect(rePaired).toMatchObject({
        kid,
        trust: 'verified',
        verifiedVia: 'qr',
        localAlias: 'Desk phone',
        installId: INSTALL,
      });
      expect(grantsFor(kid)).toEqual(['w1', 'w2']);
      expect(service.list()).toHaveLength(1);
    });

    it('un-pair deletes the row, alias, and grants; a same-kid re-adoption starts with neither', () => {
      const kid = 'unpr'.repeat(8);
      service.add({
        kid,
        publicKeyB64: pub(3),
        trust: 'verified',
        verifiedVia: 'qr',
        installId: INSTALL,
      });
      service.setLocalAlias(kid, 'Gone alias');
      seedMultiWorkspaceGrants(kid);

      expect(service.revoke(kid)).toBe(true);
      expect(service.get(kid)).toBeNull();
      expect(grantsFor(kid)).toEqual([]);

      const reAdopted = service.reconcile({ kid, publicKeyB64: pub(3) }, undefined, {
        installId: INSTALL,
      });

      expect(reAdopted).toMatchObject({ kid, trust: 'unverified', adoptedVia: 'email-tofu' });
      expect(reAdopted.localAlias).toBeUndefined();
      expect(grantsFor(kid)).toEqual([]);
      expect(service.list()).toHaveLength(1);
    });
  });
});
