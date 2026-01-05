import { Injectable } from '@nestjs/common';
import { ProviderAdapter } from './provider-adapter.interface';
import { ClaudeAdapter } from './claude.adapter';
import { CodexAdapter } from './codex.adapter';
import { GeminiAdapter } from './gemini.adapter';
import { UnsupportedProviderError } from '../../../common/errors/error-types';

/**
 * Factory for resolving ProviderAdapter instances by provider name
 *
 * Supports known providers only (claude, codex, gemini).
 * Throws an error for unsupported provider names.
 */
@Injectable()
export class ProviderAdapterFactory {
  private readonly adapters: Map<string, ProviderAdapter>;

  constructor(
    claudeAdapter: ClaudeAdapter,
    codexAdapter: CodexAdapter,
    geminiAdapter: GeminiAdapter,
  ) {
    this.adapters = new Map<string, ProviderAdapter>([
      ['claude', claudeAdapter],
      ['codex', codexAdapter],
      ['gemini', geminiAdapter],
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
}
