import { Injectable } from '@nestjs/common';
import type {
  ProviderAdapter,
  AddMcpServerOptions,
  McpServerEntry,
  BuildLaunchArgsInput,
  TerminalOutputBehavior,
} from './provider-adapter.interface';
import type { EffortCapability } from './capabilities';
import { ValidationError } from '../../../common/errors/error-types';
import { EnvBuilderError } from '../../sessions/utils/env-builder';

/** Env var opencode reads as a per-process JSON config overlay (highest layer). */
const OPENCODE_CONFIG_CONTENT_ENV = 'OPENCODE_CONFIG_CONTENT';

/**
 * env-builder rejects values >32KB; mirror that ceiling here so the failure is an
 * actionable OpenCode-specific message rather than a generic env error downstream.
 */
const MAX_CONFIG_CONTENT_BYTES = 32768;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Recursively merge `source` onto `target`, both PLAIN JSON objects. Nested plain
 * objects merge key-by-key; any non-object source value (scalar/array) replaces the
 * target value. Keys present only on `target` are preserved untouched — this is
 * what keeps unrelated pre-existing OPENCODE_CONFIG_CONTENT keys intact.
 */
function deepMergePlainObjects(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target };
  for (const [key, sourceValue] of Object.entries(source)) {
    const targetValue = result[key];
    result[key] =
      isPlainObject(targetValue) && isPlainObject(sourceValue)
        ? deepMergePlainObjects(targetValue, sourceValue)
        : sourceValue;
  }
  return result;
}

@Injectable()
export class OpencodeAdapter implements ProviderAdapter, EffortCapability {
  readonly providerName = 'opencode';
  readonly mcpMode = 'project_config' as const;
  readonly configFileName = 'opencode.json';

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

  binaryCheck(_alias: string): string[] {
    return ['--version'];
  }

  buildLaunchArgs({ mode, providerSessionId, profileOptionArgs }: BuildLaunchArgsInput): {
    argv: string[];
  } {
    if (mode === 'restore') {
      return { argv: ['--session', providerSessionId!, ...profileOptionArgs] };
    }
    return { argv: [...profileOptionArgs] };
  }

  /**
   * OpenCode effort is applied as a per-process env overlay, NOT an argv flag:
   * we merge `provider.<pid>.models.<mid>.options.reasoningEffort` into
   * `OPENCODE_CONFIG_CONTENT`, which opencode layers ABOVE the project
   * `opencode.json` with ZERO file writes (spike-verified precedence + deep merge,
   * v1.17.13). `argv` is returned unchanged.
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

    // Deep-merge onto any pre-existing OPENCODE_CONFIG_CONTENT (already resolved by
    // providerEnv < configEnv upstream), preserving every unrelated key.
    const existing = env[OPENCODE_CONFIG_CONTENT_ENV];
    let base: Record<string, unknown> = {};
    if (existing != null && existing !== '') {
      let parsed: unknown;
      try {
        parsed = JSON.parse(existing);
      } catch {
        throw new EnvBuilderError(
          `${OPENCODE_CONFIG_CONTENT_ENV} is not valid JSON — cannot merge the OpenCode effort overlay`,
        );
      }
      if (!isPlainObject(parsed)) {
        throw new EnvBuilderError(
          `${OPENCODE_CONFIG_CONTENT_ENV} must be a JSON object to merge the OpenCode effort overlay`,
        );
      }
      base = parsed;
    }

    // Compact serialization only — env-builder rejects newlines/control chars.
    const serialized = JSON.stringify(deepMergePlainObjects(base, overlay));
    if (serialized.length > MAX_CONFIG_CONTENT_BYTES) {
      throw new EnvBuilderError(
        `Merged ${OPENCODE_CONFIG_CONTENT_ENV} exceeds 32KB — reduce the pre-existing config content`,
      );
    }

    return { argv: args, env: { ...env, [OPENCODE_CONFIG_CONTENT_ENV]: serialized } };
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
