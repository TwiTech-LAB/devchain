import { Injectable } from '@nestjs/common';
import { SessionReaderAdapter } from './session-reader-adapter.interface';

/**
 * Factory for resolving SessionReaderAdapter instances by provider name.
 *
 * Adapters register themselves via the module's provider wiring.
 * Kept separate from MCP ProviderAdapterFactory to avoid circular dependencies.
 *
 * ## Registered providers
 *
 * | Provider  | Adapter class                  | Session file format          |
 * |-----------|-------------------------------|------------------------------|
 * | `claude`  | ClaudeSessionReaderAdapter     | JSONL (`~/.claude/projects/`) |
 * | `codex`   | CodexSessionReaderAdapter      | JSONL (`~/.codex/sessions/`)  |
 * | `gemini`  | GeminiSessionReaderAdapter     | JSON  (`~/.gemini/tmp/`)      |
 *
 * ## Adding a new provider adapter
 *
 * 1. Create a parser in `parsers/` (e.g., `parsers/my-provider.parser.ts`)
 * 2. Create an adapter in `adapters/` implementing `SessionReaderAdapter`
 *    - Set `providerName` to the provider's lowercase identifier
 *    - Set `allowedRoots` to the provider's session directory root(s)
 * 3. Add the provider root to `PROVIDER_ROOTS` in `TranscriptPathValidator`
 * 4. Register the adapter in `SessionReaderModule`:
 *    - Add to `providers` and `exports` arrays
 *    - Inject in constructor, call `adapterFactory.registerAdapter()`
 * 5. Add pricing data: update `isOpenAIModel`/`isGeminiModel` or add a new
 *    filter in `scripts/fetch-pricing-data.ts`, then regenerate `pricing.json`
 */
@Injectable()
export class SessionReaderAdapterFactory {
  private readonly adapters = new Map<string, SessionReaderAdapter>();

  /**
   * Register an adapter instance (called during module initialization)
   */
  registerAdapter(adapter: SessionReaderAdapter): void {
    this.adapters.set(adapter.providerName.toLowerCase(), adapter);
  }

  /**
   * Get an adapter for the specified provider (primary lookup).
   *
   * @param providerName - Name of the provider (case-insensitive)
   * @returns SessionReaderAdapter instance, or undefined if not supported
   */
  getAdapter(providerName: string): SessionReaderAdapter | undefined {
    return this.adapters.get(providerName.toLowerCase());
  }

  /**
   * Auto-detect an adapter by matching a file path against each adapter's
   * `allowedRoots`. Use this as a fallback when the provider name is unknown.
   *
   * Returns the first adapter whose `allowedRoots` contains a prefix match
   * for the given path. Returns undefined if no adapter matches.
   *
   * @param filePath - Absolute path to a session transcript file
   * @returns Matching adapter, or undefined
   */
  getAdapterForPath(filePath: string): SessionReaderAdapter | undefined {
    for (const adapter of this.adapters.values()) {
      if (adapter.allowedRoots.some((root) => filePath.startsWith(root))) {
        return adapter;
      }
    }
    return undefined;
  }

  /**
   * Check if a provider is supported
   *
   * @param providerName - Name of the provider to check (case-insensitive)
   * @returns true if the provider has a registered adapter
   */
  isSupported(providerName: string): boolean {
    return this.adapters.has(providerName.toLowerCase());
  }

  /**
   * Get list of supported provider names
   *
   * @returns Array of registered provider names
   */
  getSupportedProviders(): string[] {
    return Array.from(this.adapters.keys());
  }
}
