import { Inject, Injectable } from '@nestjs/common';
import { ProviderAdapter } from './provider-adapter.interface';
import { ClaudeAdapter } from './claude.adapter';
import { CodexAdapter } from './codex.adapter';
import { OpencodeAdapter } from './opencode.adapter';
import { AntigravityAdapter } from './antigravity.adapter';
import { CopilotAdapter } from './copilot.adapter';
import { UnsupportedProviderError } from '../../../common/errors/error-types';
import { STORAGE_SERVICE, type StorageService } from '../../storage/interfaces/storage.interface';

/**
 * Factory for resolving ProviderAdapter instances by provider name
 *
 * Supports known providers only (claude, codex, opencode, agy, copilot).
 * Throws an error for unsupported provider names.
 */
@Injectable()
export class ProviderAdapterFactory {
  private readonly adapters: Map<string, ProviderAdapter>;

  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    claudeAdapter: ClaudeAdapter,
    codexAdapter: CodexAdapter,
    opencodeAdapter: OpencodeAdapter,
    antigravityAdapter: AntigravityAdapter,
    copilotAdapter: CopilotAdapter,
  ) {
    this.adapters = new Map<string, ProviderAdapter>([
      ['claude', claudeAdapter],
      ['codex', codexAdapter],
      ['opencode', opencodeAdapter],
      ['agy', antigravityAdapter],
      ['copilot', copilotAdapter],
    ]);
  }

  /**
   * Get an adapter for the specified provider
   *
   * @param providerName - Name of the provider (case-insensitive)
   * @throws UnsupportedProviderError if provider is not supported
   * @returns ProviderAdapter instance for the specified provider
   */
  getAdapter(providerName: string): ProviderAdapter {
    const normalized = providerName.toLowerCase();
    const adapter = this.adapters.get(normalized);
    if (!adapter) {
      throw new UnsupportedProviderError(normalized, this.getSupportedProviders());
    }
    return adapter;
  }

  /**
   * Check if a provider is supported
   *
   * @param providerName - Name of the provider to check (case-insensitive)
   * @returns true if the provider is supported, false otherwise
   */
  isSupported(providerName: string): boolean {
    return this.adapters.has(providerName.toLowerCase());
  }

  /**
   * Get list of supported provider names
   *
   * @returns Array of supported provider names
   */
  getSupportedProviders(): string[] {
    return Array.from(this.adapters.keys());
  }

  async getPostPasteDelayMsForAgent(agentId: string): Promise<number | undefined> {
    try {
      const agent = await this.storage.getAgent(agentId);
      if (!agent.providerConfigId) return undefined;

      const config = await this.storage.getProfileProviderConfig(agent.providerConfigId);

      let providerName = config.providerName;
      if (!providerName) {
        const provider = await this.storage.getProvider(config.providerId);
        providerName = provider.name;
      }
      if (!providerName) return undefined;

      const adapter = this.adapters.get(providerName.toLowerCase());
      return adapter?.runtimePromptBehavior?.postPasteDelayMs;
    } catch {
      return undefined;
    }
  }
}
