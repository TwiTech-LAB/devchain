import { Injectable } from '@nestjs/common';
import type {
  ProviderAdapter,
  AddMcpServerOptions,
  BuildLaunchArgsInput,
  McpServerEntry,
  TerminalOutputBehavior,
} from './provider-adapter.interface';
import type {
  McpCliCapability,
  TranscriptDiscoveryCapability,
  ProjectProvisioningCapability,
  ProvisioningResult,
  AuthProbeCapability,
  AuthProbeResult,
  EffortCapability,
  HookCapability,
  HookEnvContext,
} from './capabilities';
import { stripFlag } from '../../sessions/utils/profile-options';
import { CopilotTrustedFoldersService } from '../../core/services/copilot-trusted-folders.service';
import {
  CopilotAuthProbeService,
  COPILOT_AUTH_REMEDIATION,
} from '../../core/services/copilot-auth-probe.service';

/**
 * Adapter for the GitHub Copilot CLI (`copilot`, verified v1.0.65) — devchain
 * provider #6. Mental model: a Claude-family file/JSONL reader + Claude-family
 * CLI MCP, bound to its transcript by a deterministic `--session-id` launch
 * (NOT an agy-style DB/scan provider).
 *
 * Design is locked by spikes S1/S2 and reviewer decisions R1–R5:
 * - **Deterministic binding (R1, S2).** Copilot is the first provider where the
 *   provider session UUID IS devchain's own `sessions.id`: for `mode:'new'` we
 *   pass `--session-id <sessionId>`, and the reader (P1-4) derives the transcript
 *   path `~/.copilot/session-state/<sessionId>/events.jsonl` with zero scan, so
 *   `transcriptDiscoveryStrategy = 'first'`. S2 proved `--session-id` on a fresh
 *   uuid creates exactly that dir (first event `session.start.data.sessionId ===
 *   sessionId`); `sessionId` reaches `buildLaunchArgs` via the P1-2 launch-arg
 *   plumbing.
 * - **Restore via `--resume` (R2, S2).** Restore emits `--resume=<providerSessionId>`,
 *   which S2 proved is fail-closed (errors instead of forking a new session when
 *   the id is wrong/missing), unlike the dual-mode `--session-id`. Never
 *   `--continue` (resumes the most-recent session globally — non-deterministic).
 *   `providerSessionIdRequiredForRestore = true`.
 * - **TUI launch.** Copilot runs as a full-screen TUI, so `usesAlternateScreen`
 *   is kept on and the initial prompt is seeded at launch via
 *   `initialPromptSeedMode = 'argv'` (`-i <prompt>`) rather than the fragile
 *   post-launch paste.
 * - **MCP (R3).** Loopback, no auth: `copilot mcp add --transport http <alias>
 *   <url>` (NO `--header`), and `copilot mcp list --json` (pipe-safe — no TTY
 *   required). The registration flow itself is P1-3; this adapter only supplies
 *   the command shapes + JSON parse.
 *
 * No forced model/effort/context/permission flags here — those flow through
 * `profileOptionArgs` (and any preflight permission flags from S1/P1-8).
 */
@Injectable()
export class CopilotAdapter
  implements
    ProviderAdapter,
    McpCliCapability,
    TranscriptDiscoveryCapability,
    ProjectProvisioningCapability,
    AuthProbeCapability,
    EffortCapability,
    HookCapability
{
  readonly providerName = 'copilot';

  // Effort (`--effort=<value>`, alias `--reasoning-effort`). Static seed/endpoint
  // metadata — model, effort, and context tier all flow through profileOptionArgs.
  readonly defaultEffortValues = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

  // Copilot = ProjectProvisioningCapability adopter #3. Spike S1 proved the
  // untrusted-folder `-i` TUI HARD-BLOCKS on a trust modal that NO launch flag
  // bypasses, so the project path must be pre-written into copilot's
  // `trustedFolders[]` before launch (mirrors gemini/agy trust provisioning).
  readonly requiresProjectProvisioning = true as const;

  // R4 (two sources, two mechanisms): a relocated store (COPILOT_HOME) would pass
  // launch then fail read-time transcript-path validation (PROVIDER_ROOTS is
  // os.homedir()-relative).
  //  - AMBIENT/inherited COPILOT_HOME (from the devchain server's process.env) is
  //    STRIPPED from the child env via `env -u COPILOT_HOME` — neutralize, don't
  //    block, since the server's environment is not a user misconfiguration.
  //  - An EXPLICIT provider/config COPILOT_HOME is a deliberate unsupported
  //    override → hard-REJECTED before process start with a clear error.
  readonly launchUnsetEnv = ['COPILOT_HOME'] as const;
  readonly launchRejectEnv = ['COPILOT_HOME'] as const;

  constructor(
    private readonly trustedFolders: CopilotTrustedFoldersService,
    private readonly authProbe: CopilotAuthProbeService,
  ) {}

  // Full-screen TUI: keep alt-screen on (and preserve the combined
  // `?1049;1000h` alt-screen + mouse DECSET so wheel events pass through).
  readonly terminalOutputBehavior: TerminalOutputBehavior = { usesAlternateScreen: true };

  // Seed the initial prompt at launch as a `-i <prompt>` argv value (TUI; the
  // shared pipeline renders it before resolveLaunchConfig and skips the paste).
  readonly initialPromptSeedMode = 'argv' as const;

  // Deterministic binding (S2): the reader derives the single transcript path
  // from `sessions.id`, so discovery takes the first (only) derived candidate.
  readonly transcriptDiscoveryStrategy = 'first' as const;
  readonly providerSessionIdRequiredForRestore = true;

  // Registration uses the DEFAULT list-then-add strategy (we deliberately leave
  // `mcpProjectRegistrationStrategy` unset — NOT 'upsert'). S3-confirmed: `copilot
  // mcp add` is NOT idempotent — re-adding an existing alias ERRORS ("Server
  // already exists … remove it first"). list-then-add (CliMcpRegistrationAdapter)
  // checks first and only adds/removes-then-adds as needed, so re-ensure is safe.

  // ── HookCapability (2nd adopter; P3 lifecycle hooks) ───────────────────────
  // Copilot's lifecycle hooks (`sessionStart`/`agentStop`) are a LIFECYCLE
  // precision feature, NOT discovery — Phase-1 already binds the transcript via
  // `--session-id`. The hook listener is therefore an idempotent confirmation.
  readonly hooksEnabled = true as const;

  // The internal devchain event the relay publishes to. We deliberately REUSE
  // Claude's `claude.hooks.session.started` (event-name decision: option b) so the
  // existing `0005_seed_renew_instructions_subscriber` + event-fields catalog fire
  // for Copilot unchanged (the seeder's `source: resume|clear|compact` matcher
  // already lights up on Copilot `resume` and no-ops on `new` — spike P3-S1).
  // This is distinct from the provider HOOK KEYS the relay registers
  // (`SessionStart`/`Stop`, PascalCase per the spike — owned by the P3 config writer).
  readonly hooksEventName = 'claude.hooks.session.started';

  // Copilot's `sessionStart` payload carries NO transcriptPath (the path is
  // derived deterministically by the reader); only `agentStop` carries it. The
  // SessionStart-oriented flag is therefore false — the listener confirms by
  // provider session id, and uses the Stop-carried path only to validate-on-match.
  readonly hooksProvideTranscriptPath = false;

  // Same DEVCHAIN_* env contract as Claude — the relay reads these to attribute the
  // hook to a devchain session and no-ops when they're absent (blast-radius guard).
  buildHookEnv(context: HookEnvContext): Record<string, string> {
    return {
      DEVCHAIN_API_URL: context.apiUrl,
      DEVCHAIN_PROJECT_ID: context.projectId,
      DEVCHAIN_AGENT_ID: context.agentId,
      DEVCHAIN_SESSION_ID: context.sessionId,
      DEVCHAIN_TMUX_SESSION_NAME: context.tmuxSessionName,
    };
  }

  buildLaunchArgs({
    mode,
    providerSessionId,
    sessionId,
    profileOptionArgs,
    initialPrompt,
  }: BuildLaunchArgsInput): { argv: string[] } {
    if (mode === 'restore') {
      // Fail-closed restore (S2): `--resume=<id>` errors rather than silently
      // forking a new session; never `--continue`. Profile args follow.
      return { argv: [`--resume=${providerSessionId!}`, ...profileOptionArgs] };
    }

    // New session: ALWAYS bind the transcript by passing devchain's sessions.id
    // as the provider session UUID. Seed the initial prompt via `-i` when one is
    // configured (the pipeline leaves `initialPrompt` undefined otherwise).
    const argv = ['--session-id', sessionId!];
    if (initialPrompt) {
      argv.push('-i', initialPrompt);
    }
    argv.push(...profileOptionArgs);
    return { argv };
  }

  applyEffort(
    args: string[],
    env: Record<string, string>,
    effortValue: string,
  ): { argv: string[]; env: Record<string, string> } {
    // Strip both the canonical `--effort` and its `--reasoning-effort` alias (each
    // in `--flag value` and `--flag=value` forms) so no raw effort flag survives
    // to contradict the structured value, then inject the native `--effort=<v>`.
    let stripped = stripFlag(args, '--effort');
    stripped = stripFlag(stripped, '--reasoning-effort');
    return { argv: [`--effort=${effortValue}`, ...stripped], env };
  }

  // ── McpCliCapability ───────────────────────────────────────────────────────
  // Command shapes for the Copilot MCP CLI (R3). The registration flow lives in
  // P1-3; these builders + the JSON parser are the provider-specific surface.

  addMcpServer(options: AddMcpServerOptions): string[] {
    const alias = options.alias ?? this.providerName;
    // Remote HTTP transport, loopback-no-auth — no `--header` (R3).
    const args = ['mcp', 'add', '--transport', 'http', alias, options.endpoint];
    if (options.extraArgs?.length) {
      args.push(...options.extraArgs);
    }
    return args;
  }

  listMcpServers(): string[] {
    // `--json` is machine-readable and pipe-safe.
    return ['mcp', 'list', '--json'];
  }

  removeMcpServer(alias: string): string[] {
    return ['mcp', 'remove', alias];
  }

  binaryCheck(alias: string): string[] {
    // Copilot exposes `mcp get <name>` (no `mcp check`); used to probe a server.
    return ['mcp', 'get', alias];
  }

  parseListOutput(stdout: string, _stderr?: string): McpServerEntry[] {
    // `copilot mcp list --json` shape:
    // { "mcpServers": { "<alias>": { "type": "http", "url": "…", "source": … } } }
    const entries: McpServerEntry[] = [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      return entries;
    }

    const servers = (parsed as { mcpServers?: unknown })?.mcpServers;
    if (!servers || typeof servers !== 'object') return entries;

    for (const [alias, serverConfig] of Object.entries(servers as Record<string, unknown>)) {
      const cfg = serverConfig as Record<string, unknown>;
      const endpoint = typeof cfg?.url === 'string' ? cfg.url : undefined;
      if (!endpoint) continue;
      const transport = typeof cfg?.type === 'string' ? cfg.type.toUpperCase() : undefined;
      entries.push({ alias, endpoint, transport });
    }

    return entries;
  }

  /**
   * Pre-write the project path into copilot's `trustedFolders[]` so the
   * full-screen TUI launches without blocking on the trust modal (S1, Branch B).
   * Delegates to the dedicated `CopilotTrustedFoldersService` (atomic, serialized,
   * malformed-safe). Never throws: a trust hiccup is surfaced as a provisioning
   * warning so it doesn't fail the whole project lifecycle op.
   */
  async provisionProjectPath(projectPath: string): Promise<ProvisioningResult> {
    try {
      const result = await this.trustedFolders.ensure(projectPath);
      return { success: true, warnings: result.warnings };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        success: true,
        warnings: [
          {
            source: 'trusted_folders',
            level: 'warn',
            message,
            code: 'COPILOT_TRUST_PROVISION_FAILED',
          },
        ],
      };
    }
  }

  /**
   * Best-effort, NON-BLOCKING auth-state probe for preflight (S1). Surfaces a
   * warning (never a hard block) — the keyring is authoritative and not cheaply
   * inspectable, so `authenticated:false` is a hint, not a gate.
   */
  async probeAuth(): Promise<AuthProbeResult> {
    const authenticated = await this.authProbe.isAuthenticated();
    return { authenticated, remediation: COPILOT_AUTH_REMEDIATION };
  }
}
