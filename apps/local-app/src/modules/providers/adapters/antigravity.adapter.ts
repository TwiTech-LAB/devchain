import { Injectable } from '@nestjs/common';
import type {
  ProviderAdapter,
  AddMcpServerOptions,
  BuildLaunchArgsInput,
  McpServerEntry,
  TerminalOutputBehavior,
} from './provider-adapter.interface';
import type {
  TranscriptDiscoveryCapability,
  GlobalMcpConfigCapability,
  ProjectProvisioningCapability,
  ProvisioningResult,
} from './capabilities';
import { AntigravityTrustedWorkspacesService } from '../../core/services/antigravity-trusted-workspaces.service';

/**
 * Adapter for Google Antigravity CLI (`agy`, v1.0.x) — a gemini+opencode hybrid
 * with a full-screen bubbletea TUI and a per-conversation SQLite store under
 * `~/.gemini/antigravity-cli/`.
 *
 * Design is locked by the P1-1 spike (`docs/spikes/agy-p1-1-spike-findings.md`):
 * - Initial prompt is seeded at launch via `initialPromptSeedMode = 'argv'` — agy
 *   is argv-only (spike (g): stdin is rejected with `flag needs an argument`). The
 *   shared launch pipeline (P1-2b) renders the prompt before `resolveLaunchConfig`
 *   and passes it here as `initialPrompt`; we emit it as `--prompt-interactive`
 *   (alias `-i`). NO post-launch paste and NO `launchInitialPromptBehavior`.
 * - Restore is the interactive TUI launch via `--conversation <id>` (conversation
 *   id = providerSessionId). Spike (f): print-mode `-p --conversation` hangs, so
 *   restore must NOT go through print mode — this adapter only produces the TUI
 *   restore argv.
 * - DB-backed discovery, like opencode: `transcriptDiscoveryStrategy = 'all'` and
 *   `providerSessionIdRequiredForRestore = true`.
 *
 * MCP (P2-1): agy has no `agy mcp add` (spike (b)). Its MCP servers live in a
 * single HOME-global JSON file `~/.gemini/config/mcp_config.json` (strace-proven
 * path; project-local `.agents/mcp_config.json` is read-but-ignored upstream) with
 * a gemini/windsurf-style `{ "mcpServers": { "<name>": { "serverUrl": … } } }`
 * shape — `serverUrl` is the required transport field for remote HTTP/SSE. This
 * differs from the opencode-flat `{ "mcp": { … } }` project config, so agy
 * implements `GlobalMcpConfigCapability` and `McpRegistrationPort` routes it to the
 * dedicated `AntigravityMcpRegistrationAdapter` (home-global file IO).
 */
@Injectable()
export class AntigravityAdapter
  implements
    ProviderAdapter,
    TranscriptDiscoveryCapability,
    GlobalMcpConfigCapability,
    ProjectProvisioningCapability
{
  readonly providerName = 'agy';

  // agy = ProjectProvisioningCapability adopter #2. Workspace trust must be
  // pre-written (spike (c): --dangerously-skip-permissions does NOT cover trust),
  // otherwise the full-screen TUI blocks on a trust prompt at launch.
  readonly requiresProjectProvisioning = true as const;

  constructor(private readonly trustedWorkspaces: AntigravityTrustedWorkspacesService) {}

  // agy's full-screen bubbletea TUI legitimately uses the terminal alternate
  // screen — keep it on and preserve its `?1049;1000h` (alt-screen + mouse) so
  // wheel events pass through to the TUI (mirrors opencode/gemini full-screen).
  readonly terminalOutputBehavior: TerminalOutputBehavior = { usesAlternateScreen: true };

  // Opt-in launch-time seeding (P1-2b). agy is argv-only per spike (g): the prompt
  // is emitted as a `--prompt-interactive <prompt>` argv value, not pasted.
  readonly initialPromptSeedMode = 'argv' as const;

  // TranscriptDiscoveryCapability — agy is DB-backed (per-conversation SQLite):
  // discovery is a structured match and restore needs the conversation id.
  readonly transcriptDiscoveryStrategy = 'all' as const;
  readonly providerSessionIdRequiredForRestore = true;

  buildLaunchArgs({
    mode,
    providerSessionId,
    profileOptionArgs,
    initialPrompt,
  }: BuildLaunchArgsInput): { argv: string[] } {
    if (mode === 'restore') {
      // Interactive TUI restore. DB watcher updates live once re-emitted with
      // providerSessionId by the restore pipeline.
      return { argv: ['--conversation', providerSessionId!, ...profileOptionArgs] };
    }

    // New session. Seed the initial prompt via argv when present; the pipeline
    // leaves `initialPrompt` undefined when no prompt is configured.
    if (initialPrompt) {
      return { argv: ['--prompt-interactive', initialPrompt, ...profileOptionArgs] };
    }
    return { argv: [...profileOptionArgs] };
  }

  /**
   * Pre-write workspace trust so the agy TUI launches non-interactively (no trust
   * prompt). Delegates to the dedicated `AntigravityTrustedWorkspacesService`
   * (both trust stores). Never throws: failures are surfaced as provisioning
   * warnings so a trust hiccup doesn't fail the whole project lifecycle op.
   */
  async provisionProjectPath(projectPath: string): Promise<ProvisioningResult> {
    try {
      const result = await this.trustedWorkspaces.ensure(projectPath);
      return { success: true, warnings: result.warnings };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        success: true,
        warnings: [
          {
            source: 'trusted_workspaces',
            level: 'warn',
            message,
            code: 'AGY_TRUST_PROVISION_FAILED',
          },
        ],
      };
    }
  }

  /**
   * GlobalMcpConfigCapability — parse agy's `~/.gemini/config/mcp_config.json`
   * (`{ "mcpServers": { "<name>": { "serverUrl"|"url": … } } }`) into discovered
   * entries. The home-global file IO lives in `AntigravityMcpRegistrationAdapter`;
   * the schema specifics (root key, transport field) live here. Caller handles
   * JSON parse / empty-file concerns.
   */
  parseGlobalMcpConfig(content: string): McpServerEntry[] {
    const config = JSON.parse(content);
    const servers = config?.mcpServers;
    if (!servers || typeof servers !== 'object') return [];

    const entries: McpServerEntry[] = [];
    for (const [alias, serverConfig] of Object.entries(servers)) {
      const cfg = serverConfig as Record<string, unknown>;
      // Remote MCP servers use `serverUrl` (agy's required field); accept a
      // legacy `url` defensively when discovering pre-existing entries.
      const endpoint = typeof cfg?.serverUrl === 'string' ? cfg.serverUrl : cfg?.url;
      if (typeof endpoint === 'string') {
        entries.push({ alias, endpoint, transport: 'HTTP' });
      }
    }
    return entries;
  }

  /**
   * GlobalMcpConfigCapability — build the per-server entry written under the
   * config's `mcpServers` map. devchain's MCP server is a remote HTTP endpoint, so
   * it is expressed via `serverUrl` (spike + capture: `url`/`httpUrl` are ignored).
   */
  buildGlobalMcpServerEntry(options: AddMcpServerOptions): {
    key: string;
    value: Record<string, unknown>;
  } {
    return {
      key: options.alias ?? 'devchain',
      value: { serverUrl: options.endpoint },
    };
  }
}
