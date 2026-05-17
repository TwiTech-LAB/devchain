import { Injectable } from '@nestjs/common';
import type {
  ProviderAdapter,
  AddMcpServerOptions,
  McpServerEntry,
  LaunchInitialPromptBehavior,
  BuildLaunchArgsInput,
} from './provider-adapter.interface';
import type {
  McpCliCapability,
  ProjectProvisioningCapability,
  ProvisioningResult,
  TranscriptDiscoveryCapability,
} from './capabilities';
import { GeminiTrustedFoldersService } from '../../core/services/gemini-trusted-folders.service';
import { createLogger } from '../../../common/logging/logger';

const logger = createLogger('GeminiAdapter');

@Injectable()
export class GeminiAdapter
  implements
    ProviderAdapter,
    McpCliCapability,
    ProjectProvisioningCapability,
    TranscriptDiscoveryCapability
{
  readonly providerName = 'gemini';
  readonly mcpListSpawnMode = 'pty' as const;
  readonly mcpProjectRegistrationStrategy = 'upsert' as const;
  readonly requiresProjectProvisioning = true as const;
  readonly transcriptDiscoveryStrategy = 'all' as const;
  readonly transcriptContentSearchMaxBytes = 32_768;
  readonly providerSessionIdRequiredForRestore = true;

  constructor(private readonly trustedFolders: GeminiTrustedFoldersService) {}
  // Verification (2026-05-03): `gemini mcp add` and `gemini mcp remove` are
  // pipe-safe — they exit 0/non-zero reliably even with empty stdout/stderr.
  // Only `mcp list` requires PTY (see mcpListSpawnMode).
  readonly launchInitialPromptBehavior: LaunchInitialPromptBehavior = {
    preKeys: ['Enter'],
    preDelayMs: 5000,
  };
  readonly runtimePromptBehavior = { postPasteDelayMs: 1500 };

  addMcpServer(options: AddMcpServerOptions): string[] {
    const alias = options.alias ?? 'devchain';
    // gemini mcp add --scope project -t http <alias> <endpoint>
    const args = ['mcp', 'add', '--scope', 'project', '-t', 'http', alias, options.endpoint];
    if (options.extraArgs?.length) {
      args.push(...options.extraArgs);
    }
    return args;
  }

  listMcpServers(): string[] {
    return ['mcp', 'list'];
  }

  removeMcpServer(alias: string): string[] {
    return ['mcp', 'remove', '--scope', 'project', alias];
  }

  binaryCheck(_alias: string): string[] {
    // Gemini has no separate check command, use list
    return ['mcp', 'list'];
  }

  buildLaunchArgs({ mode, providerSessionId, profileOptionArgs }: BuildLaunchArgsInput): {
    argv: string[];
  } {
    if (mode === 'restore') {
      return { argv: ['--resume', providerSessionId!, ...profileOptionArgs] };
    }
    return { argv: [...profileOptionArgs] };
  }

  parseListOutput(stdout: string, stderr?: string): McpServerEntry[] {
    // Gemini CLI outputs MCP list to stderr, not stdout.
    // Use stderr as fallback when stdout is empty.
    const output = stdout.trim() ? stdout : (stderr ?? '');

    // Gemini CLI output format:
    // Configured MCP servers:
    //
    // ✓ devchain: http://127.0.0.1:3000/mcp (sse) - Connected
    // ✗ server2: http://127.0.0.1:4000/mcp (sse) - Failed
    const entries: McpServerEntry[] = [];
    const lines = output.split('\n').filter((line) => line.trim().length > 0);

    for (const rawLine of lines) {
      const line = rawLine
        .replace(/\x1b\[[\d;?]*[A-Za-z]/g, '')
        .replace(/\x1b\][^\x07]*\x07/g, '')
        .replace(/\r/g, '');

      // Skip header lines (e.g., "Configured MCP servers:")
      if (line.toLowerCase().includes('configured mcp')) {
        continue;
      }

      // Parse format: "✓ alias: endpoint (transport) - status" or "✗ alias: ..."
      // Transport group is optional — Gemini CLI may omit it on some versions.
      const match = line.match(/[✓✗]?\s*(\S+):\s+(\S+)(?:\s+\(([^)]+)\))?/);
      if (match) {
        const [, alias, endpoint, transport] = match;
        entries.push({
          alias,
          endpoint,
          transport: transport ? transport.toUpperCase() : undefined,
        });
      }
    }

    return entries;
  }

  async provisionProjectPath(projectPath: string): Promise<ProvisioningResult> {
    const warnings: ProvisioningResult['warnings'] = [];

    try {
      const trustResult = await this.trustedFolders.ensure(projectPath);
      if (trustResult.action === 'distrusted_warning') {
        warnings.push({
          source: 'trusted_folders',
          level: 'warn',
          message: trustResult.message,
          code: 'GEMINI_PATH_DISTRUSTED',
        });
      } else if (trustResult.action === 'malformed_warning') {
        warnings.push({
          source: 'trusted_folders',
          level: 'warn',
          message: trustResult.message,
          code: 'GEMINI_TRUST_FILE_MALFORMED',
        });
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      logger.warn({ error, projectPath }, 'Failed to ensure Gemini trusted folders (non-fatal)');
      warnings.push({
        source: 'trusted_folders',
        level: 'warn',
        message: msg,
        code: 'GEMINI_TRUST_WRITE_FAILED',
      });
    }

    return { success: true, warnings };
  }
}
