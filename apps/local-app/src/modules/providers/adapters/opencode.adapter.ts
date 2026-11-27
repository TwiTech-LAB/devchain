import { getProviderCliNoUpdateOptions, opencodeV2CommandArgs } from './provider-cli-policy';
import { Injectable } from '@nestjs/common';
import { OPENCODE_TRAITS } from './opencode.traits';
import type {
  ProviderAdapter,
  AddMcpServerOptions,
  McpServerEntry,
  BuildLaunchArgsInput,
  BuildLaunchArgsResult,
  TerminalOutputBehavior,
} from './provider-adapter.interface';
import type { EffortCapability } from './capabilities';
import type {
  CreateSessionSavePointInput,
  PrepareSessionForkLaunchInput,
  ProviderSessionTranscript,
  SessionSavePointCopy,
  SessionForkCapability,
  SessionForkLaunchResult,
} from './capabilities/session-fork.capability';
import { IOError, ValidationError } from '../../../common/errors/error-types';
import { ChildProcessExecutor } from '../../terminal/services/process-executor/child-process-executor';
import { ProcessExecutor } from '../../terminal/services/process-executor/process-executor.port';
import { assertSupportedOpencodeVersion, isOpencodeV2 } from './opencode-cli-version';
import { mergeOpencodeConfigContent } from './opencode-config-content';
import { buildOpencodeLaunchArgsV1 } from './opencode-launch.v1';
import { buildOpencodeLaunchArgsV2 } from './opencode-launch.v2';
import { isRecord } from './plugin-catalog.utils';
import { stripFlag } from '../utils/profile-options';

const FORK_TIMEOUT_MS = 60_000;
const FORK_MAX_OUTPUT_BYTES = 1024 * 1024;

@Injectable()
export class OpencodeAdapter implements ProviderAdapter, EffortCapability, SessionForkCapability {
  readonly providerName = 'opencode';
  readonly traits = OPENCODE_TRAITS;
  readonly launchEnv = getProviderCliNoUpdateOptions(this.providerName).env;
  readonly mcpMode = 'project_config' as const;
  readonly configFileName = 'opencode.json';
  readonly requiresCliVersion = true as const;
  readonly supportsForkForVersion = isOpencodeV2;

  // OpenCode effort is NOT a CLI flag — it is per-model JSON config
  // (`provider.<pid>.models.<mid>.options.reasoningEffort`), so the effective
  // model MUST be known to place the value (spike-verified, v1.17.13).
  readonly requiresModelForEffort = true as const;

  // Static seed/endpoint metadata. OpenCode passes reasoningEffort through to the
  // OpenAI-family `reasoning_effort` API param (spike finding); the default ladder
  // mirrors that scale. Anthropic-family models use a `thinking` budget instead and
  // ignore reasoningEffort — documented limitation (see provider-standards.md).
  readonly defaultEffortValues = ['minimal', 'low', 'medium', 'high'] as const;

  // OpenCode is a full-screen TUI: keep the terminal alternate screen on and
  // preserve its `?1049;1000h` (alt-screen + mouse-tracking) so wheel events pass
  // through to the TUI instead of scrolling our scrollback. Every other provider
  // leaves this unset (default false) and keeps alt-screen suppressed.
  readonly terminalOutputBehavior: TerminalOutputBehavior = { usesAlternateScreen: true };

  // TranscriptDiscoveryCapability — OpenCode is DB-backed: discovery is a
  // structured SQL match (handled by the DB-aware path in the persistence
  // listener), and restore needs the `ses_…` id (`--session <id>`).
  readonly transcriptDiscoveryStrategy = 'all' as const;
  readonly providerSessionIdRequiredForRestore = true;

  constructor(private readonly executor: ProcessExecutor = new ChildProcessExecutor()) {}

  addMcpServer(_options: AddMcpServerOptions): string[] {
    // OpenCode MCP is managed via opencode.json config file, not CLI.
    // Return version check as safe no-op fallback.
    return ['--version'];
  }

  listMcpServers(): string[] {
    return ['mcp', 'list'];
  }

  removeMcpServer(_alias: string): string[] {
    // OpenCode has no mcp remove command; managed via config file.
    return ['--version'];
  }

  /** Without `cliVersion` (callers that skip the launch-pipeline probe) this builds OpenCode 1 argv. */
  buildLaunchArgs(input: BuildLaunchArgsInput): BuildLaunchArgsResult {
    if (input.cliVersion === undefined) return buildOpencodeLaunchArgsV1(input);
    const { major } = assertSupportedOpencodeVersion(
      input.cliVersion,
      input.providerBinPath ?? this.providerName,
    );
    return major === 2 ? buildOpencodeLaunchArgsV2(input) : buildOpencodeLaunchArgsV1(input);
  }

  async createSavePoint(input: CreateSessionSavePointInput): Promise<SessionSavePointCopy> {
    const copy = await this.forkSession(input);
    return {
      ...copy,
      discardUnboundTranscript: () => this.deleteSession(input, copy.providerSessionId),
    };
  }

  private async forkSession({
    providerSessionId,
    transcriptPath,
    projectPath,
    providerBinPath,
    cliVersion,
    helperEnv,
  }: CreateSessionSavePointInput): Promise<ProviderSessionTranscript> {
    if (!cliVersion || !this.supportsForkForVersion(cliVersion)) {
      throw new ValidationError('OpenCode save points and forks require OpenCode 2.');
    }
    const result = await this.runHelper({ providerBinPath, projectPath, helperEnv }, [
      'api',
      'session.fork',
      '--param',
      `sessionID=${providerSessionId}`,
      '--header',
      // A raw non-ASCII path is not a valid header value. OpenCode decodes this header.
      `x-opencode-directory:${encodeURIComponent(projectPath)}`,
      '-d',
      '{}',
    ]);
    const reply = parseForkOutput(result.stdout);
    if (!result.success || result.truncated) {
      if (isRecord(reply) && reply.kind === 'empty_session') {
        throw new ValidationError('OpenCode cannot save or fork a session with no messages.');
      }
      throw new IOError('OpenCode could not copy the session.', { timedOut: result.timedOut });
    }
    const childId = isRecord(reply) && isRecord(reply.data) ? reply.data.id : undefined;
    if (
      typeof childId !== 'string' ||
      !/^ses_[A-Za-z0-9]+$/.test(childId) ||
      childId === providerSessionId
    ) {
      throw new IOError('OpenCode returned an invalid fork session ID.');
    }
    return { providerSessionId: childId, transcriptPath };
  }

  async prepareForkLaunch(input: PrepareSessionForkLaunchInput): Promise<SessionForkLaunchResult> {
    const child = await this.forkSession(input);
    const discardUnboundTranscript = () => this.deleteSession(input, child.providerSessionId);
    const separator = input.profileOptionArgs.indexOf('--');
    const options =
      separator === -1 ? input.profileOptionArgs : input.profileOptionArgs.slice(0, separator);
    let launch: BuildLaunchArgsResult;
    try {
      launch = this.buildLaunchArgs({
        mode: 'restore',
        providerSessionId: child.providerSessionId,
        sessionId: input.sessionId,
        projectId: input.projectId,
        profileOptionArgs: [
          ...stripFlag(options, '--prompt'),
          ...input.profileOptionArgs.slice(options.length),
        ],
        env: input.env,
        cliVersion: input.cliVersion,
        providerBinPath: input.providerBinPath,
      });
    } catch (error) {
      await discardUnboundTranscript().catch(() => undefined);
      throw error;
    }
    return { ...child, ...launch, discardUnboundTranscript };
  }

  /** Deletes a copy that no DevChain row owns. The v2 API has no delete operation. */
  private async deleteSession(input: CreateSessionSavePointInput, sessionId: string) {
    const result = await this.runHelper(input, ['session', 'delete', sessionId]);
    if (!result.success) {
      throw new IOError('OpenCode could not delete the unbound fork.', {
        timedOut: result.timedOut,
      });
    }
  }

  /** Runs an OpenCode 2 helper command in the project with the helper environment. */
  private runHelper(
    input: Pick<CreateSessionSavePointInput, 'providerBinPath' | 'projectPath' | 'helperEnv'>,
    args: string[],
  ) {
    return this.executor.run({
      argv: opencodeV2CommandArgs([input.providerBinPath, ...args]),
      cwd: input.projectPath,
      env: getProviderCliNoUpdateOptions(this.providerName, input.helperEnv).env,
      mode: 'pipe',
      timeout: FORK_TIMEOUT_MS,
      outputLimits: { maxBytes: FORK_MAX_OUTPUT_BYTES },
    });
  }

  /**
   * OpenCode effort is applied as a per-process env overlay, NOT an argv flag:
   * we merge `provider.<pid>.models.<mid>.options.reasoningEffort` into
   * `OPENCODE_CONFIG_CONTENT`, which opencode layers ABOVE the project
   * `opencode.json` with ZERO file writes (spike-verified precedence + deep merge,
   * v1.17.13). OpenCode 2 accepts the same overlay shape and applies it to the
   * model request. `argv` is returned unchanged.
   *
   * `effectiveModel` is the pre-resolved model string (agent override → config
   * default → raw `--model`); `pid` = substring before the FIRST `/`, `mid` = the
   * remainder (may itself contain `/`).
   */
  applyEffort(
    args: string[],
    env: Record<string, string>,
    effortValue: string,
    effectiveModel?: string,
  ): { argv: string[]; env: Record<string, string> } {
    // Fail-fast (no silent skip, no warning lane): effort is active but no model
    // is resolvable from ANY source.
    if (!effectiveModel) {
      throw new ValidationError(
        'OpenCode effort override requires a model — set one on the config or agent',
      );
    }

    const slashIndex = effectiveModel.indexOf('/');
    if (slashIndex <= 0 || slashIndex === effectiveModel.length - 1) {
      throw new ValidationError('OpenCode effort override requires provider/model model format');
    }
    const pid = effectiveModel.slice(0, slashIndex);
    const mid = effectiveModel.slice(slashIndex + 1);

    // The overlay this launch contributes.
    const overlay: Record<string, unknown> = {
      provider: { [pid]: { models: { [mid]: { options: { reasoningEffort: effortValue } } } } },
    };

    return { argv: args, env: mergeOpencodeConfigContent(env, overlay, 'effort overlay') };
  }

  parseListOutput(_stdout: string, _stderr?: string): McpServerEntry[] {
    // OpenCode mcp list outputs TUI-formatted text with box-drawing chars.
    // Config-file mode reads opencode.json directly instead.
    return [];
  }

  /**
   * Parse MCP entries from opencode.json config file content.
   * Caller is responsible for handling JSON parse errors.
   */
  parseProjectConfig(content: string): McpServerEntry[] {
    const config = JSON.parse(content);
    const mcp = config?.mcp;
    if (!mcp || typeof mcp !== 'object') return [];

    const entries: McpServerEntry[] = [];
    for (const [alias, serverConfig] of Object.entries(mcp)) {
      const cfg = serverConfig as Record<string, unknown>;
      if (cfg?.url && typeof cfg.url === 'string') {
        entries.push({
          alias,
          endpoint: cfg.url,
          transport: typeof cfg.type === 'string' ? cfg.type.toUpperCase() : 'REMOTE',
        });
      }
    }
    return entries;
  }

  /**
   * Build the MCP config entry to write into opencode.json.
   */
  buildMcpConfigEntry(options: AddMcpServerOptions): {
    key: string;
    value: Record<string, unknown>;
  } {
    return {
      key: options.alias ?? 'devchain',
      value: {
        type: 'remote',
        url: options.endpoint,
      },
    };
  }
}

function parseForkOutput(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}
