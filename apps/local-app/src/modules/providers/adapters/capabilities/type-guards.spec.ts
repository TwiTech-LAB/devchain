import { ClaudeAdapter } from '../claude.adapter';
import { CodexAdapter } from '../codex.adapter';
import { OpencodeAdapter } from '../opencode.adapter';
import { AntigravityAdapter } from '../antigravity.adapter';
import { CopilotAdapter } from '../copilot.adapter';
import type { ProviderAdapter } from '../provider-adapter.interface';
import {
  isMcpCli,
  isGlobalMcpConfigCapable,
  isAutoCompactCapable,
  isEffortCapable,
  isHookCapable,
  isProjectProvisioningCapable,
  isTranscriptDiscoveryCapable,
} from './type-guards';

describe('type-guards', () => {
  const claude: ProviderAdapter = new ClaudeAdapter();
  const codex: ProviderAdapter = new CodexAdapter();
  const opencode: ProviderAdapter = new OpencodeAdapter();
  const antigravity: ProviderAdapter = new AntigravityAdapter();
  const copilot: ProviderAdapter = new CopilotAdapter();

  describe('isGlobalMcpConfigCapable', () => {
    it('returns true for Antigravity (agy — HOME-global mcp_config.json)', () => {
      expect(isGlobalMcpConfigCapable(antigravity)).toBe(true);
    });

    it('returns false for CLI and project-local config providers', () => {
      expect(isGlobalMcpConfigCapable(claude)).toBe(false);
      expect(isGlobalMcpConfigCapable(codex)).toBe(false);
      expect(isGlobalMcpConfigCapable(opencode)).toBe(false);
    });

    it('narrows type to GlobalMcpConfigCapability for agy', () => {
      if (isGlobalMcpConfigCapable(antigravity)) {
        expect(typeof antigravity.parseGlobalMcpConfig).toBe('function');
        expect(typeof antigravity.buildGlobalMcpServerEntry).toBe('function');
      }
    });
  });

  describe('isMcpCli (agy defaults to CLI but is routed by isGlobalMcpConfigCapable first)', () => {
    it('returns true for agy (no project_config mode) — the port checks global-config first', () => {
      // agy has no `mcpMode='project_config'`, so the loose isMcpCli default is
      // true; McpRegistrationPort.resolveAdapter MUST check isGlobalMcpConfigCapable
      // before isMcpCli so agy never routes to the CLI adapter.
      expect(isMcpCli(antigravity)).toBe(true);
      expect(isGlobalMcpConfigCapable(antigravity)).toBe(true);
    });
  });

  describe('isMcpCli', () => {
    it('returns true for Claude', () => {
      expect(isMcpCli(claude)).toBe(true);
    });

    it('returns true for Codex', () => {
      expect(isMcpCli(codex)).toBe(true);
    });

    it('returns false for OpenCode (project_config mode)', () => {
      expect(isMcpCli(opencode)).toBe(false);
    });

    it('narrows type to McpCliCapability for CLI providers', () => {
      if (isMcpCli(claude)) {
        expect(typeof claude.addMcpServer).toBe('function');
        expect(typeof claude.listMcpServers).toBe('function');
        expect(typeof claude.removeMcpServer).toBe('function');
        expect(typeof claude.binaryCheck).toBe('function');
        expect(typeof claude.parseListOutput).toBe('function');
      }
    });
  });

  describe('isAutoCompactCapable', () => {
    it('returns true for Claude', () => {
      expect(isAutoCompactCapable(claude)).toBe(true);
    });

    it('returns false for non-Claude adapters', () => {
      expect(isAutoCompactCapable(codex)).toBe(false);
      expect(isAutoCompactCapable(opencode)).toBe(false);
    });

    it('narrows type to AutoCompactCapability for Claude', () => {
      if (isAutoCompactCapable(claude)) {
        expect(typeof claude.applyAutoCompactConfig).toBe('function');
        expect(typeof claude.evaluateAutoCompactConfig).toBe('function');
      }
    });
  });

  describe('isEffortCapable', () => {
    it('returns true for the effort adopters (claude, codex, copilot argv + opencode env overlay)', () => {
      expect(isEffortCapable(claude)).toBe(true);
      expect(isEffortCapable(codex)).toBe(true);
      expect(isEffortCapable(copilot)).toBe(true);
      expect(isEffortCapable(opencode)).toBe(true);
    });

    it('returns false for agy (not effort-capable — effort is embedded in model names)', () => {
      expect(isEffortCapable(antigravity)).toBe(false);
    });

    it('flags opencode as per-model (requiresModelForEffort) but not the argv adopters', () => {
      if (isEffortCapable(opencode)) {
        expect(opencode.requiresModelForEffort).toBe(true);
      }
      if (isEffortCapable(claude)) {
        expect(claude.requiresModelForEffort).toBeUndefined();
      }
    });

    it('narrows type to EffortCapability, exposing defaultEffortValues + applyEffort', () => {
      if (isEffortCapable(claude)) {
        expect(Array.isArray(claude.defaultEffortValues)).toBe(true);
        expect(typeof claude.applyEffort).toBe('function');
      }
    });
  });

  describe('isHookCapable', () => {
    it('returns true for Claude and Copilot (the two HookCapability adopters)', () => {
      expect(isHookCapable(claude)).toBe(true);
      expect(isHookCapable(copilot)).toBe(true);
    });

    it('returns false for non-hook adapters', () => {
      expect(isHookCapable(codex)).toBe(false);
      expect(isHookCapable(opencode)).toBe(false);
      expect(isHookCapable(antigravity)).toBe(false);
    });

    it('narrows type to HookCapability for Claude', () => {
      if (isHookCapable(claude)) {
        expect(claude.hooksEnabled).toBe(true);
        expect(typeof claude.hooksEventName).toBe('string');
        expect(typeof claude.buildHookEnv).toBe('function');
      }
    });
  });

  describe('isProjectProvisioningCapable', () => {
    it('returns true for Antigravity (implements ProjectProvisioningCapability)', () => {
      expect(isProjectProvisioningCapable(antigravity)).toBe(true);
    });

    it('returns false for adapters without project provisioning', () => {
      expect(isProjectProvisioningCapable(claude)).toBe(false);
      expect(isProjectProvisioningCapable(codex)).toBe(false);
      expect(isProjectProvisioningCapable(opencode)).toBe(false);
    });

    it('narrows type to ProjectProvisioningCapability for Antigravity', () => {
      if (isProjectProvisioningCapable(antigravity)) {
        expect(antigravity.requiresProjectProvisioning).toBe(true);
        expect(typeof antigravity.provisionProjectPath).toBe('function');
      }
    });
  });

  describe('isTranscriptDiscoveryCapable', () => {
    it('returns true for Claude, Codex, and OpenCode', () => {
      expect(isTranscriptDiscoveryCapable(claude)).toBe(true);
      expect(isTranscriptDiscoveryCapable(codex)).toBe(true);
      expect(isTranscriptDiscoveryCapable(opencode)).toBe(true);
    });

    it('marks OpenCode as DB-backed: requires providerSessionId for restore', () => {
      if (isTranscriptDiscoveryCapable(opencode)) {
        expect(opencode.transcriptDiscoveryStrategy).toBe('all');
        expect(opencode.providerSessionIdRequiredForRestore).toBe(true);
      }
    });

    it('narrows type with correct strategy per provider', () => {
      if (isTranscriptDiscoveryCapable(claude)) {
        expect(claude.transcriptDiscoveryStrategy).toBe('first');
      }
      if (isTranscriptDiscoveryCapable(codex)) {
        expect(codex.transcriptContentSearchMaxBytes).toBe(65_536);
        expect(codex.contentMatchMaxCandidates).toBe(200);
        expect(codex.providerSessionIdRequiredForRestore).toBe(true);
      }
    });
  });
});
