import { Injectable } from '@nestjs/common';
import { readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { getEnvConfig } from '../../../common/config/env.config';
import { InstanceUserNameSchema } from '../../../common/config/vm-destroy-fence';
import { ForbiddenError, IOError } from '../../../common/errors/error-types';
import { HostHelperService } from './host-helper.service';
import { SharedVmCountSchema } from './shared-vm.contract';
import type { SharedVmNotify, SharedVmNotifyResult, SharedVmRoster } from './shared-vm.contract';

const PEER_TIMEOUT_MS = 2000;
const ClaimSchema = z.object({
  userName: InstanceUserNameSchema,
  port: z.number().int().min(1024).max(65535),
  version: z.string().optional(),
});
type Claim = z.infer<typeof ClaimSchema>;

@Injectable()
export class HostSharedVmService {
  constructor(private readonly helper: HostHelperService) {}

  async roster(): Promise<SharedVmRoster> {
    this.helper.assertClaimedHost();
    const instances = await Promise.all(
      this.registry().map(async (claim) => {
        let connectedCount: number | 'unknown' = 'unknown';
        let connectedProjectIds: string[] | 'unknown' = 'unknown';
        try {
          const response = await fetch(
            `http://127.0.0.1:${claim.port}/api/host/shared-vm/connected-count`,
            {
              signal: AbortSignal.timeout(PEER_TIMEOUT_MS),
              redirect: 'error',
            },
          );
          if (response.ok) {
            const occupancy = SharedVmCountSchema.parse(await response.json());
            connectedCount = occupancy.connectedCount;
            connectedProjectIds = occupancy.connectedProjectIds;
          } else await response.body?.cancel();
        } catch {
          // An unresponsive or incompatible instance must never look empty.
        }
        return {
          user: claim.userName,
          port: claim.port,
          version: claim.version ?? null,
          connectedCount,
          connectedProjectIds,
        };
      }),
    );
    return { instances };
  }

  async notify(notice: SharedVmNotify): Promise<SharedVmNotifyResult> {
    const owner = this.assertOwner();
    const body = JSON.stringify({
      ...notice,
      fromUser: owner.userName,
      at: new Date().toISOString(),
    });
    const results = await Promise.all(
      this.registry()
        .filter((claim) => claim.userName !== owner.userName)
        .map(async (claim) => {
          let delivered = false;
          try {
            const response = await fetch(
              `http://127.0.0.1:${claim.port}/api/host/shared-vm/inbox`,
              {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body,
                signal: AbortSignal.timeout(PEER_TIMEOUT_MS),
                redirect: 'error',
              },
            );
            delivered = response.ok;
            await response.body?.cancel();
          } catch {
            // Notices are one attempt per instance; the result lets home report failures.
          }
          return { user: claim.userName, delivered };
        }),
    );
    return { results };
  }

  assertOwner(): Claim {
    this.helper.assertClaimedHost();
    const ownDir = resolve(getEnvConfig().DEVCHAIN_HOST_ETC_DIR);
    const ownerDir = this.registryDir();
    if (ownDir !== ownerDir) {
      throw new ForbiddenError('Only the VM owner can set a destroy fence or notify other users.', {
        code: 'VM_OWNER_REQUIRED',
      });
    }
    const owner = this.readClaim(join(ownerDir, 'claim.json'));
    if (!owner) throw new IOError('The VM owner claim is missing.');
    return owner;
  }

  private registryDir(): string {
    const own = resolve(getEnvConfig().DEVCHAIN_HOST_ETC_DIR);
    return basename(dirname(own)) === 'instances' ? dirname(dirname(own)) : own;
  }

  private registry(): Claim[] {
    const root = this.registryDir();
    const claims: Claim[] = [];
    const owner = this.readClaim(join(root, 'claim.json'));
    if (owner) claims.push(owner);
    let entries;
    try {
      entries = readdirSync(join(root, 'instances'), { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return claims;
      throw new IOError('Cannot read the VM instance registry.');
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !InstanceUserNameSchema.safeParse(entry.name).success) {
        throw new IOError('The VM instance registry is invalid.');
      }
      const claim = this.readClaim(join(root, 'instances', entry.name, 'claim.json'));
      if (claim && claim.userName !== entry.name)
        throw new IOError('The VM instance claim does not match its user.');
      if (claim) claims.push(claim);
    }
    return claims;
  }

  private readClaim(file: string): Claim | null {
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new IOError('Cannot read the VM instance claim.');
    }
    try {
      return ClaimSchema.parse(JSON.parse(raw));
    } catch {
      throw new IOError('The VM instance claim is invalid.');
    }
  }
}
