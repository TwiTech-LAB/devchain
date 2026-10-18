import * as semver from 'semver';
import { dirname, join } from 'node:path';
import { z } from 'zod';

export const HostUpdateStatusSchema = z.object({
  state: z.enum(['pending', 'installing', 'installing_clis', 'restarting', 'done', 'failed']),
  version: z.string(),
  error: z.string().optional(),
  at: z.string(),
});
export type HostUpdateStatus = z.infer<typeof HostUpdateStatusSchema>;

export const HostDockerStatusSchema = z.object({
  jobId: z.string(),
  state: z.enum(['pending', 'installing', 'restarting', 'done', 'failed']),
  error: z.string().optional(),
  code: z.string().optional(),
  at: z.string(),
});
export type HostDockerStatus = z.infer<typeof HostDockerStatusSchema>;
export const HOST_HELPER_MIGRATION =
  'sudo npm install -g /opt/devchain-host/current/lib/node_modules/devchain-cli/dist/host-install/devchain-host-bootstrap.tgz';

export function getHostHelperMigration(binDir: string): string {
  if (binDir === '/usr/local/bin') return HOST_HELPER_MIGRATION;
  const root = dirname(binDir);
  const archive = join(
    root,
    'current/lib/node_modules/devchain-cli/dist/host-install/devchain-host-bootstrap.tgz',
  );
  const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
  return `sudo npm install -g --prefix ${quote(join(root, 'helper'))} ${quote(archive)}`;
}

export const HostUpdateRequestSchema = z
  .object({
    version: z.string().refine((value) => semver.valid(value) === value),
    // Only the helper checks the scheme.
    npmRegistry: z.string().url().optional(),
  })
  .strict();
