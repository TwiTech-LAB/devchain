import type { BuildLaunchArgsInput } from './provider-adapter.interface';

export function buildOpencodeLaunchArgsV1({
  mode,
  providerSessionId,
  profileOptionArgs,
}: BuildLaunchArgsInput): {
  argv: string[];
} {
  if (mode === 'restore') {
    return { argv: ['--session', providerSessionId!, ...profileOptionArgs] };
  }
  return { argv: [...profileOptionArgs] };
}
