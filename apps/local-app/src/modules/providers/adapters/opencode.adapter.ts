import { getProviderCliNoUpdateOptions } from './provider-cli-policy';
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
import { ValidationError } from '../../../common/errors/error-types';
import { assertSupportedOpencodeVersion } from './opencode-cli-version';
import { mergeOpencodeConfigContent } from './opencode-config-content';
import { buildOpencodeLaunchArgsV1 } from './opencode-launch.v1';
import { buildOpencodeLaunchArgsV2 } from './opencode-launch.v2';

@Injectable()
export class OpencodeAdapter implements ProviderAdapter, EffortCapability {
  readonly providerName = 'opencode';
  readonly traits = OPENCODE_TRAITS;
  readonly launchEnv = getProviderCliNoUpdateOptions(this.providerName).env;
  readonly mcpMode = 'project_config' as const;
  readonly configFileName = 'opencode.json';
  readonly requiresCliVersion = true as const;

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
