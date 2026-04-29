import type { FolderScopeEntry } from './scope.types';

export const BUILT_IN_SCOPE_DEFAULTS: FolderScopeEntry[] = [
  { folder: 'node_modules', purpose: 'excluded', reason: 'DevChain default', origin: 'default' },
  { folder: '.git', purpose: 'excluded', reason: 'DevChain default', origin: 'default' },
  { folder: 'dist', purpose: 'excluded', reason: 'DevChain default', origin: 'default' },
  { folder: '.next', purpose: 'excluded', reason: 'DevChain default', origin: 'default' },
  { folder: '__pycache__', purpose: 'excluded', reason: 'DevChain default', origin: 'default' },
  { folder: '.venv', purpose: 'excluded', reason: 'DevChain default', origin: 'default' },
  { folder: 'venv', purpose: 'excluded', reason: 'DevChain default', origin: 'default' },
];
