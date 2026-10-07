/* eslint-disable @typescript-eslint/no-require-imports */
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TwoInstances } from '../../common/test/two-instance.fixture';
import type { ProviderAuthPayload } from '../storage/models/domain.models';
import type { Remote } from '../storage/models/domain.models';

/**
 * Family write-back end to end: the host instance's watcher serves the login
 * files under the (shared) test HOME, home's health poll pulls changed files
 * through the proxy-free families route, and the vault entry re-encrypts.
 * `claim.json` in a temp etc dir puts the host in host role.
 */
describe('provider auth family write-back through the health poll', () => {
  let rootDir: string;
  let etcDir: string;
  let instances: TwoInstances;
  let remote: Remote;
  let waitForValue: typeof import('../../common/test/two-instance.fixture').waitForValue;
  let homeHome: string;

  const CODEX_V1 = '{"auth_mode":"chatgpt","tokens":{"refresh_token":"codex-r1"}}';
  const CODEX_V2 = '{"auth_mode":"chatgpt","tokens":{"refresh_token":"codex-r2"}}';
  const CODEX_V3 = '{"auth_mode":"chatgpt","tokens":{"refresh_token":"codex-r3"}}';
  const CODEX_V4 = '{"auth_mode":"chatgpt","tokens":{"refresh_token":"codex-r4"}}';
  const AGY_V1 = '{"token":"agy-t1"}';
  const AGY_V2 = '{"token":"agy-t2"}';

  beforeAll(async () => {
    rootDir = mkdtempSync(join(tmpdir(), 'devchain-family-writeback-'));
    etcDir = join(rootDir, 'etc');
    mkdirSync(etcDir);
    // Must be set before the app modules load: the host helper reads it through
    // the (cached) env config, which the fixture resets at startup.
    process.env.DEVCHAIN_HOST_ETC_DIR = etcDir;

    const fixture = require('../../common/test/two-instance.fixture');
    waitForValue = fixture.waitForValue;
    instances = await fixture.startTwoInstances();
    homeHome = process.env.HOME!;

    // Host role for the families route (both instances share this env in tests).
    writeFileSync(join(etcDir, 'claim.json'), '{}');
    remote = await instances.registerRemote('lab-host');
    await waitForValue(async () => {
      const response = await fetch(`${instances.home.url}/api/remotes`);
      const body = (await response.json()) as {
        items: Array<{ id: string; online: boolean; versionMatches: boolean }>;
      };
      const entry = body.items.find((item) => item.id === remote.id);
      return entry?.online && entry.versionMatches ? entry : null;
    }, 15_000);
  }, 60_000);

  afterAll(async () => {
    await instances?.close();
    delete process.env.DEVCHAIN_HOST_ETC_DIR;
    rmSync(rootDir, { recursive: true, force: true });
  });

  // Deterministic, strictly increasing mtimes: home's `since` filter keeps the
  // newest mtime across ALL family files, so a later write must never land on a
  // lower stamp than an earlier one (real clocks can collide within a ms).
  let fakeMtime = Date.now();

  // `fractionMs` gives the file time a fraction of a millisecond, as real file systems do.
  function writeHostFile(relativePath: string, content: string, fractionMs = 0): void {
    fakeMtime += 1000;
    const path = join(homeHome, relativePath);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content, { mode: 0o600 });
    const seconds = (fakeMtime + fractionMs) / 1000;
    utimesSync(path, seconds, seconds);
  }

  async function checkedOutFamily(provider: string, payload: ProviderAuthPayload) {
    const entry = await instances.home.storage.createProviderAuthEntry({
      provider,
      kind: 'family',
      label: `${provider} lab`,
      payload,
    });
    await instances.home.storage.checkoutProviderAuthEntry(entry.id, remote.id);
    return entry;
  }

  async function waitForEntryContent(entryId: string, expected: string): Promise<void> {
    await waitForValue(async () => {
      const payload = await instances.home.storage.readProviderAuthPayload(entryId);
      return payload.payloadKind === 'files' && payload.content === expected ? payload : null;
    }, 15_000);
  }

  let codexEntryId: string;

  it('writes a refreshed Codex family back into the checked-out vault entry', async () => {
    const entry = await checkedOutFamily('codex', { payloadKind: 'files', content: CODEX_V1 });
    codexEntryId = entry.id;
    writeHostFile('.codex/auth.json', CODEX_V2);

    await waitForEntryContent(entry.id, CODEX_V2);
    const meta = await instances.home.storage.getProviderAuthEntry(entry.id);
    expect(meta.lastWritebackAt).not.toBeNull();
  });

  it('keeps writing back after a file time with a fraction of a millisecond', async () => {
    // Home sends the newest file time back as `since`; a fraction must not make the host refuse it.
    writeHostFile('.codex/auth.json', CODEX_V3, 0.3618);
    await waitForEntryContent(codexEntryId, CODEX_V3);

    writeHostFile('.codex/auth.json', CODEX_V4);
    await waitForEntryContent(codexEntryId, CODEX_V4);

    const direct = await fetch(`${instances.host.url}/api/host/provider-auth/families?since=1.5`);
    expect(direct.status).toBe(200);
  });

  it('writes a refreshed Antigravity family back the same way', async () => {
    const entry = await checkedOutFamily('agy', { payloadKind: 'files', content: AGY_V1 });
    writeHostFile('.gemini/antigravity-cli/antigravity-oauth-token', AGY_V2);

    await waitForEntryContent(entry.id, AGY_V2);
    expect(
      (await instances.home.storage.getProviderAuthEntry(entry.id)).lastWritebackAt,
    ).not.toBeNull();
  });

  it('updates only the checked-out OpenCode oauth entry and leaves imported api entries alone', async () => {
    const oauthEntry = await checkedOutFamily('opencode', {
      payloadKind: 'opencode-entry',
      providerId: 'github',
      entry: { type: 'oauth', access: 'oc-old-access', refresh: 'oc-old-refresh' },
    });
    const apiEntry = await instances.home.storage.createProviderAuthEntry({
      provider: 'opencode',
      kind: 'static',
      label: 'openrouter · api',
      payload: {
        payloadKind: 'opencode-entry',
        providerId: 'openrouter',
        entry: { type: 'api', key: 'sk-openrouter-static' },
      },
    });

    // The VM's composed auth.json: the api entry rides along unchanged, the
    // oauth entry was refreshed by the CLI.
    writeHostFile(
      '.local/share/opencode/auth.json',
      `${JSON.stringify(
        {
          github: { type: 'oauth', access: 'oc-new-access', refresh: 'oc-new-refresh' },
          openrouter: { type: 'api', key: 'sk-openrouter-static' },
        },
        null,
        2,
      )}\n`,
    );

    await waitForValue(async () => {
      const payload = await instances.home.storage.readProviderAuthPayload(oauthEntry.id);
      return payload.payloadKind === 'opencode-entry' && payload.entry.access === 'oc-new-access'
        ? payload
        : null;
    }, 15_000);

    const apiPayload = await instances.home.storage.readProviderAuthPayload(apiEntry.id);
    expect(apiPayload).toEqual({
      payloadKind: 'opencode-entry',
      providerId: 'openrouter',
      entry: { type: 'api', key: 'sk-openrouter-static' },
    });
    expect(
      (await instances.home.storage.getProviderAuthEntry(apiEntry.id)).lastWritebackAt,
    ).toBeNull();
  });
});
