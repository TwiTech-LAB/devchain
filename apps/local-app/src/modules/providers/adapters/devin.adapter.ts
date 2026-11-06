import { Injectable } from '@nestjs/common';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import * as os from 'node:os';
import { DEVIN_TRAITS } from './devin.traits';
import type {
  ProviderAdapter,
  AddMcpServerOptions,
  BuildLaunchArgsInput,
  McpServerEntry,
} from './provider-adapter.interface';
import type {
  ConfigFileMcpCapability,
  TranscriptDiscoveryCapability,
  HookCapability,
  HookEnvContext,
} from './capabilities';
import { devinTranscriptPath } from '../../../common/devin-transcript-paths';

/**
 * Adapter for the Devin CLI (`devin`, npm package `devin`, verified
 * v3000.11.234) — DevChain provider #6. Mental model: a Claude-family
 * file-based reader bound to a DevChain-OWNED transcript via `--export` (not a
 * provider-side store like Copilot's `~/.copilot`).
 *
 * - **Deterministic binding.** Devin has no `--session-id` flag, so the
 *   transcript is bound by pointing `--export` at a DevChain-owned path:
 *   `~/.devchain/provider-transcripts/devin/<sessions.id>.json`. The CLI
 *   rewrites the whole ATIF conversation there after every turn, and
 *   `devin -r <id> --export <newpath>` re-binds a RESTORE to the fresh path
 *   with the full old+new conversation — so `sessionId` is read on BOTH modes
 *   (unlike Copilot, which ignores it on restore). `transcriptDiscoveryStrategy
 *   = 'first'`: the reader derives the path from `sessions.id`, zero-scan.
 * - **Restore via `-r/--resume`** (`providerSessionIdRequiredForRestore`):
 *   Devin session ids are names like `functional-share`, surfaced from the
 *   export's top-level `session_id` — NOT the devchain id that names the file.
 * - **Argv prompt seeding.** `devin [OPTIONS] -- <PROMPT>` starts an
 *   interactive session; the prompt must come after `--`, at the end of argv.
 * - **Workspace trust.** `--respect-workspace-trust false` skips the trust
 *   prompt on every launch/restore — no pre-written trust file needed.
 * - **Terminal verification.** Interactive launch and restore were exercised
 *   in tmux on Ubuntu/WSL and an Ubuntu Remote VM with v3000.11.234.
 *   `terminalOutputBehavior` remains unset (the default); these checks do not
 *   establish alternate-screen behavior or exhaustive browser rendering.
 * - **MCP is config-file mode, NOT CLI mode.** `devin mcp list`/`get` redact
 *   URLs in ALL output (`URL: <redacted>`), so the endpoint can never be
 *   verified through CLI output — every ensure would see a phantom mismatch.
 *   Worse, `devin mcp remove` refuses entries owned by FOREIGN configs (devin
 *   aggregates other tools' files, e.g. the project's `opencode.json`), so the
 *   drift-repair remove aborts the whole launch. We therefore read/write the
 *   project-local `<cwd>/.devin/mcp_config.local.json` directly — the exact
 *   file `devin mcp add` (default local scope) produces:
 *   `{ "mcpServers": { "<name>": { "url": "…", "transport": "http" } } }`.
 *
 * No `provider-cli-policy` entry: Devin exposes no flag/env to disable
 * auto-update, so the default (no-op) branch applies. No EffortCapability —
 * Devin encodes effort in the model id itself (`…-xhigh`, `…-max`).
 */
@Injectable()
export class DevinAdapter
  implements ProviderAdapter, ConfigFileMcpCapability, TranscriptDiscoveryCapability, HookCapability
{
  readonly providerName = 'devin';
  readonly traits = DEVIN_TRAITS;

  // The prompt is seeded at launch as the argv tail after `--` (interactive
  // session; the shared pipeline renders it before resolveLaunchConfig).
  readonly initialPromptSeedMode = 'argv' as const;

  // The reader derives the export path from `sessions.id` — discovery takes the
  // first (only) derived candidate.
  readonly transcriptDiscoveryStrategy = 'first' as const;
  readonly providerSessionIdRequiredForRestore = true;

  // ── ConfigFileMcpCapability ──────────────────────────────────────────────
  // `mcpMode = 'project_config'` routes MCP ensure/preflight through
  // ConfigFileMcpRegistrationAdapter (file IO) instead of the CLI adapter —
  // see the class docblock for why `devin mcp list`/`remove` cannot be used.
  // `configFileName` is relative to the project root (path.join handles the
  // `.devin/` subdir); `.local.json` is devin's uncommitted local scope, the
  // same file `devin mcp add` writes by default.
  readonly mcpMode = 'project_config' as const;
  readonly configFileName = '.devin/mcp_config.local.json';
  readonly mcpConfigRootKey = 'mcpServers' as const;

  // ── HookCapability (3rd adopter; Claude-compatible hook JSON) ─────────────
  // Hooks provide the native provider session id before the first export
  // exists. Discovery derives the path from `--export` and retries on idle
  // because Devin may only materialize the file after a turn completes.
  readonly hooksEnabled = true as const;
  // Devin's stdin payload carries no `transcript_path`; the reader derives it.
  readonly hooksProvideTranscriptPath = false;

  // Same DEVCHAIN_* env contract as Claude, plus a provider tag so relays that
  // run under BOTH providers' hook configs (Devin also executes the project's
  // .claude hooks) can tell which relay family should handle the event.
  buildHookEnv(context: HookEnvContext): Record<string, string> {
    return {
      DEVCHAIN_API_URL: context.apiUrl,
      DEVCHAIN_PROJECT_ID: context.projectId,
      DEVCHAIN_AGENT_ID: context.agentId,
      DEVCHAIN_SESSION_ID: context.sessionId,
      DEVCHAIN_TMUX_SESSION_NAME: context.tmuxSessionName,
      DEVCHAIN_HOOK_PROVIDER: this.providerName,
    };
  }

  buildLaunchArgs({
    mode,
    providerSessionId,
    sessionId,
    profileOptionArgs,
    initialPrompt,
  }: BuildLaunchArgsInput): { argv: string[] } {
    if (!sessionId) {
      throw new Error(
        'Devin launch requires the devchain sessionId to bind its --export transcript path',
      );
    }
    // `--export` errors when the parent dir is missing — create it up front.
    const exportPath = devinTranscriptPath(os.homedir(), sessionId);
    mkdirSync(dirname(exportPath), { recursive: true, mode: 0o700 });

    if (mode === 'restore') {
      // `devin -r <id> --export <newpath>` re-writes the FULL conversation (old
      // + new turns) to the fresh path — the restore re-binds deterministically.
      return {
        argv: [
          '--resume',
          providerSessionId!,
          '--export',
          exportPath,
          '--respect-workspace-trust',
          'false',
          ...profileOptionArgs,
        ],
      };
    }

    // New: interactive launch with an optional prompt seeded after `--`.
    const argv = [
      '--export',
      exportPath,
      '--respect-workspace-trust',
      'false',
      ...profileOptionArgs,
    ];
    if (initialPrompt) {
      argv.push('--', initialPrompt);
    }
    return { argv };
  }

  /**
   * Parse MCP entries from `.devin/mcp_config.local.json` content.
   * Caller is responsible for handling JSON parse errors.
   *
   * Only URL-bearing entries are returned: devin's file mixes transports under
   * one `mcpServers` map — remote servers carry `{ "url": …, "transport": … }`
   * while stdio servers carry `{ "command": …, "args": […] }` with no `url`,
   * and stdio entries have no endpoint to compare against the devchain URL.
   */
  parseProjectConfig(content: string): McpServerEntry[] {
    const config = JSON.parse(content);
    const servers = config?.mcpServers;
    if (!servers || typeof servers !== 'object') return [];

    const entries: McpServerEntry[] = [];
    for (const [alias, serverConfig] of Object.entries(servers)) {
      const cfg = serverConfig as Record<string, unknown> | null;
      if (typeof cfg?.url === 'string') {
        entries.push({
          alias,
          endpoint: cfg.url,
          transport: typeof cfg.transport === 'string' ? cfg.transport.toUpperCase() : 'HTTP',
        });
      }
    }
    return entries;
  }

  /**
   * Build the MCP config entry written under the file's `mcpServers` map —
   * byte-identical to what `devin mcp add --transport http <name> <url>`
   * produces for the local project scope.
   */
  buildMcpConfigEntry(options: AddMcpServerOptions): {
    key: string;
    value: Record<string, unknown>;
  } {
    return {
      key: options.alias ?? 'devchain',
      value: { url: options.endpoint, transport: 'http' },
    };
  }
}
