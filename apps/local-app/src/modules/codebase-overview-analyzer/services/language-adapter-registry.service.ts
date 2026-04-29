import { Injectable } from '@nestjs/common';
import { extname } from 'path';
import type { FileRole, LanguageAdapter } from '@devchain/codebase-overview';
import { goAdapter } from './go-adapter';
import { javaAdapter } from './java-adapter';
import { phpAdapter } from './php-adapter';
import { pythonAdapter } from './python-adapter';
import { rubyAdapter } from './ruby-adapter';
import { rustAdapter } from './rust-adapter';
import { typescriptAdapter } from './typescript-adapter';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface FileAdapterEnrichment {
  role: FileRole | null;
  symbolCount: number | null;
  complexity: number | null;
  testPair: string | null;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class LanguageAdapterRegistryService {
  private readonly adapters: ReadonlyArray<LanguageAdapter> = [
    typescriptAdapter,
    pythonAdapter,
    phpAdapter,
    goAdapter,
    javaAdapter,
    rubyAdapter,
    rustAdapter,
  ];
  private readonly extensionIndex: ReadonlyMap<string, LanguageAdapter>;

  constructor() {
    const index = new Map<string, LanguageAdapter>();
    for (const adapter of this.adapters) {
      for (const ext of adapter.extensions) {
        index.set(ext.toLowerCase(), adapter);
      }
    }
    this.extensionIndex = index;
  }

  /** Find the adapter for a file path based on its extension. Returns null when unsupported. */
  getAdapter(filePath: string): LanguageAdapter | null {
    const ext = extname(filePath).toLowerCase();
    return this.extensionIndex.get(ext) ?? null;
  }

  /** Content-aware role classification. Returns null when no adapter matches or the adapter defers. */
  classifyRole(filePath: string, content: string): FileRole | null {
    const adapter = this.getAdapter(filePath);
    if (!adapter) return null;
    return adapter.classifyRole(filePath, content);
  }

  /** Extract import specifiers from file content. Returns null when no adapter matches. */
  extractImports(filePath: string, content: string): string[] | null {
    const adapter = this.getAdapter(filePath);
    if (!adapter?.extractImports) return null;
    return adapter.extractImports(content);
  }

  /** Count exported symbols. Returns null when no adapter matches. */
  countSymbols(filePath: string, content: string): number | null {
    const adapter = this.getAdapter(filePath);
    if (!adapter?.countSymbols) return null;
    return adapter.countSymbols(content);
  }

  /** Resolve an import specifier to a project file path. Returns null when no adapter matches or resolution fails. */
  resolveImport(filePath: string, specifier: string, allPaths: ReadonlySet<string>): string | null {
    const adapter = this.getAdapter(filePath);
    if (!adapter?.resolveImport) return null;
    return adapter.resolveImport(specifier, filePath, allPaths);
  }

  /** Compute cyclomatic complexity estimate. Returns null when no adapter matches. */
  computeComplexity(filePath: string, content: string): number | null {
    const adapter = this.getAdapter(filePath);
    if (!adapter?.computeComplexity) return null;
    return adapter.computeComplexity(content);
  }

  /** Detect the test pair (source↔test) for a file path. Returns null when no adapter matches or no pair found. */
  detectTestPair(filePath: string, allPaths: Set<string>): string | null {
    const adapter = this.getAdapter(filePath);
    if (!adapter?.detectTestPair) return null;
    return adapter.detectTestPair(filePath, allPaths);
  }
}
