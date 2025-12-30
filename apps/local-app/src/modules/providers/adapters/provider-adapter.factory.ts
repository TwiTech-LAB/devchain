import { Injectable } from '@nestjs/common';
import { ProviderAdapter } from './provider-adapter.interface';
import { ClaudeAdapter } from './claude.adapter';
import { CodexAdapter } from './codex.adapter';

/**
 * Factory for resolving ProviderAdapter instances by provider name
 *
 * Supports known providers only (claude, codex).
 * Throws an error for unsupported provider names.
 */
@Injectable()
export class ProviderAdapterFactory {
  private readonly adapters: Map<string, ProviderAdapter>;

  constructor() {
    this.adapters = new Map<string, ProviderAdapter>([
      ['claude', new ClaudeAdapter()],
      ['codex', new CodexAdapter()],
    ]);
  }

  /**
   * Get an adapter for the specified provider
   *
   * @param providerName - Name of the provider (case-sensitive)
   * @throws Error if provider is not supported
   * @returns ProviderAdapter instance for the specified provider
   */
  getAdapter(providerName: string): ProviderAdapter {
    const adapter = this.adapters.get(providerName);
    if (!adapter) {
      throw new Error(
        `Unsupported provider: ${providerName}. Supported providers: ${this.getSupportedProviders().join(', ')}`,
      );
    }
    return adapter;
  }

  /**
   * Check if a provider is supported
   *
   * @param providerName - Name of the provider to check
   * @returns true if the provider is supported, false otherwise
   */
  isSupported(providerName: string): boolean {
    return this.adapters.has(providerName);
  }

  /**
   * Get list of supported provider names
   *
   * @returns Array of supported provider names
   */
  getSupportedProviders(): string[] {
    return Array.from(this.adapters.keys());
  }
}
