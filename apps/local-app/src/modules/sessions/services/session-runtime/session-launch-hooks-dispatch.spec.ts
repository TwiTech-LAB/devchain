/**
 * setupHooksConfig — per-provider hook-installer dispatch (P3-3).
 *
 * Proves the thin generic dispatch selects the right installer for a hook-capable
 * adapter (Claude → HooksConfigService UNCHANGED; Copilot → CopilotHooksConfigService),
 * keyed on adapter identity, and no-ops for a non-hook-capable adapter.
 */

// ── Module-level mocks (must precede imports) ──────────────────────────

jest.mock('../../../storage/db/sqlite-raw', () => ({
  getRawSqliteClient: (db: { session: { client: unknown } }) => db.session.client,
}));

jest.mock('../../../../common/logging/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

jest.mock('../../../../common/config/env.config', () => ({
  getEnvConfig: () => ({ HOST: '127.0.0.1', PORT: 3000 }),
}));

jest.mock('@devchain/shared', () => ({
  HostResolver: { buildInternalBaseUrl: () => 'http://127.0.0.1:3000' },
}));

// isHookCapable is controllable via the adapter's `hooksEnabled` marker so this
// suite can exercise the real dispatch (the broader pipeline spec stubs it false).
jest.mock('../../../providers/adapters/capabilities', () => ({
  isAutoCompactCapable: () => false,
  isHookCapable: (adapter: { hooksEnabled?: boolean }) => adapter?.hooksEnabled === true,
  isProjectProvisioningCapable: () => false,
}));

jest.mock('../../utils/tmux-naming.util', () => ({
  buildTmuxSessionName: (...args: string[]) => `tmux-${args.join('-')}`,
}));

// ── Imports ────────────────────────────────────────────────────────────

import { createLaunchPipelineHarness } from './__test-utils__/pipeline-harness';

type Harness = ReturnType<typeof createLaunchPipelineHarness>;

// setupHooksConfig is private; reach it via a typed bracket cast.
function setupHooksConfig(h: Harness, providerName: string, projectRoot: string): Promise<void> {
  return (
    h.pipeline as unknown as {
      setupHooksConfig: (p: { name: string }, root: string) => Promise<void>;
    }
  ).setupHooksConfig({ name: providerName }, projectRoot);
}

describe('SessionLaunchPipeline.setupHooksConfig — installer dispatch', () => {
  let h: Harness;

  beforeEach(() => {
    h = createLaunchPipelineHarness();
  });

  it.each([
    { providerName: 'copilot', hooksEnabled: true, copilotCalls: 1, claudeCalls: 0 },
    { providerName: 'claude', hooksEnabled: true, copilotCalls: 0, claudeCalls: 1 },
    { providerName: 'copilot', hooksEnabled: false, copilotCalls: 0, claudeCalls: 0 },
  ])(
    'dispatches $providerName hooks when enabled=$hooksEnabled',
    async ({ providerName, hooksEnabled, copilotCalls, claudeCalls }) => {
      h.mocks.providerAdapterFactory.getAdapter.mockReturnValue({ providerName, hooksEnabled });
      await setupHooksConfig(h, providerName, '/proj/root');
      expect(h.mocks.copilotHooksConfigService.ensureHooksConfig).toHaveBeenCalledTimes(
        copilotCalls,
      );
      expect(h.mocks.hooksConfigService.ensureHooksConfig).toHaveBeenCalledTimes(claudeCalls);
      if (copilotCalls)
        expect(h.mocks.copilotHooksConfigService.ensureHooksConfig).toHaveBeenCalledWith(
          '/proj/root',
        );
      if (claudeCalls)
        expect(h.mocks.hooksConfigService.ensureHooksConfig).toHaveBeenCalledWith('/proj/root');
    },
  );

  it('swallows installer errors (non-fatal launch path)', async () => {
    h.mocks.providerAdapterFactory.getAdapter.mockReturnValue({
      providerName: 'copilot',
      hooksEnabled: true,
    });
    h.mocks.copilotHooksConfigService.ensureHooksConfig.mockRejectedValueOnce(new Error('disk'));

    await expect(setupHooksConfig(h, 'copilot', '/proj/root')).resolves.toBeUndefined();
  });
});
