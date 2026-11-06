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
  McpCliCapability,
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
 * - **Terminal behavior is a hypothesis**: `terminalOutputBehavior` is left
 *   unset (alt-screen off, the broader default) since there is no tmux on this
 *   host to verify whether the CLI is a full-screen TUI.
 *
 * No `provider-cli-policy` entry: Devin exposes no flag/env to disable
 * auto-update, so the default (no-op) branch applies. No EffortCapability —
 * Devin encodes effort in the model id itself (`…-xhigh`, `…-max`).
 */
@Injectable()
export class DevinAdapter
  implements ProviderAdapter, McpCliCapability, TranscriptDiscoveryCapability, HookCapability
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

  // Registration uses the DEFAULT list-then-add strategy (NOT 'upsert'):
  // `devin mcp add` is slow (~18s when the URL is unreachable) and writes the
  // project-local scope (`<cwd>/.devin/mcp_config.local.json`), so we list
  // first and only add/remove when drift requires it.

  // ── HookCapability (3rd adopter; Claude-compatible hook JSON) ─────────────
  // Devin's lifecycle hooks are a LIFECYCLE precision feature, NOT discovery —
  // the transcript is already bound by `--export` at launch, so the hook
  // listener is an idempotent confirmation (same posture as Copilot).
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

  // ── McpCliCapability ───────────────────────────────────────────────────────
  // `devin mcp add` defaults to the project-local scope (`<cwd>/.devin/
  // mcp_config.local.json`); the ensure path supplies cwd = project root.

  addMcpServer(options: AddMcpServerOptions): string[] {
    const alias = options.alias ?? this.providerName;
    const args = ['mcp', 'add', '--transport', 'http', alias, options.endpoint];
    if (options.extraArgs?.length) {
      args.push(...options.extraArgs);
    }
    return args;
  }

  listMcpServers(): string[] {
    // `mcp list` has no machine-readable mode — fast, pipe-safe text output.
    return ['mcp', 'list'];
  }

  removeMcpServer(alias: string): string[] {
    return ['mcp', 'remove', alias];
  }

  parseListOutput(stdout: string, _stderr?: string): McpServerEntry[] {
    // `devin mcp list` prints bullet blocks:
    //   Configured MCP servers
    //     • <alias>
    //       Command: <stdio command>   (stdio servers — skipped)
    //       URL: <http url>            (http servers — returned)
    //       Source: <config file>
    // Command-only (stdio) entries are skipped; only URL entries are returned.
    const entries: McpServerEntry[] = [];
    const bulletRe = /^\s*[•*\-]\s+(\S+)\s*$/;
    let alias: string | null = null;

    for (const line of stdout.split(/\r?\n/)) {
      const bullet = bulletRe.exec(line);
      if (bullet) {
        alias = bullet[1];
        continue;
      }
      if (alias === null) continue;
      const url = /^\s*URL:\s*(\S+)\s*$/i.exec(line);
      if (url) {
        entries.push({ alias, endpoint: url[1], transport: 'HTTP' });
        alias = null;
        continue;
      }
      // A Command/Source line (or any other detail) leaves the block open for a
      // later URL line; nothing else to do.
    }

    return entries;
  }
}
