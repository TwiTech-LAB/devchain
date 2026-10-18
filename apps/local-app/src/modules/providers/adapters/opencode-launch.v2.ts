import type { BuildLaunchArgsInput, BuildLaunchArgsResult } from './provider-adapter.interface';
import { mergeOpencodeConfigContent } from './opencode-config-content';
import { opencodeV2CommandArgs } from './provider-cli-policy';
import { extractModelFromArgs, stripFlag } from '../utils/profile-options';

/**
 * The v2 TUI rejects `--model` (prints usage and exits), so the model moves into
 * OPENCODE_CONFIG_CONTENT, which the TUI also honors on `--session` restore.
 */
export function buildOpencodeLaunchArgsV2({
  mode,
  providerSessionId,
  profileOptionArgs,
  env,
}: BuildLaunchArgsInput): BuildLaunchArgsResult {
  const model = extractModelFromArgs(profileOptionArgs);
  const optionArgs = stripFlag(stripFlag(profileOptionArgs, '--model'), '-m');
  const argv = opencodeV2CommandArgs([
    ...(mode === 'restore' ? ['--session', providerSessionId!] : []),
    ...optionArgs,
  ]);
  if (!model) return { argv };
  return { argv, env: mergeOpencodeConfigContent(env ?? {}, { model }, 'model') };
}
