import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { createLogger } from '../../../common/logging/logger';
import {
  STORAGE_SERVICE,
  type ProviderStorage,
  type RemoteStorage,
  type ReplicaProviderSettingsRow,
} from '../../storage/interfaces/storage.interface';
import { tryParseProviderEnv } from '../../storage/local/helpers/storage-helpers';
import { providerSettingsRevision } from '../host/host-provider-settings-revision';
import { RemoteHostClient } from '../operations/remote-host.client';

const logger = createLogger('RemoteProviderSettingsService');

/**
 * Home owns provider env, scopes and the two provider scalars; each health poll brings
 * a VM that holds a project up to home's values. Every VM gets every home provider:
 * the VM keeps scoped keys only for its own projects.
 */
@Injectable()
export class RemoteProviderSettingsService implements OnModuleDestroy {
  private readonly pushing = new Map<string, Promise<void>>();
  private stopped = false;

  constructor(
    @Inject(STORAGE_SERVICE)
    private readonly storage: Pick<RemoteStorage, 'listRemoteProjectBindings'> &
      Pick<ProviderStorage, 'listProviderSettingsSources' | 'listEnvScopesByProviderIds'>,
    private readonly host: RemoteHostClient,
  ) {}

  onModuleDestroy(): void {
    this.stopped = true;
  }

  pushIfChanged(remoteId: string): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const pending = this.pushing.get(remoteId);
    if (pending) return pending;
    const work = this.push(remoteId)
      .catch((error) =>
        logger.debug(
          { remoteId, error: String(error) },
          'Provider settings push failed; next poll will retry',
        ),
      )
      .finally(() => this.pushing.delete(remoteId));
    this.pushing.set(remoteId, work);
    return work;
  }

  private async push(remoteId: string): Promise<void> {
    const bindings = await this.storage.listRemoteProjectBindings();
    if (!bindings.some((binding) => binding.remoteId === remoteId && binding.state === 'remote'))
      return;
    const providers = this.buildRows();
    const revision = providerSettingsRevision(providers);
    const status = await this.host.getProviderSettingsStatus(remoteId);
    if (!this.stopped && status.appliedRevision !== revision)
      await this.host.putProviderSettings(remoteId, { revision, providers });
  }

  private buildRows(): ReplicaProviderSettingsRow[] {
    const sources = this.storage.listProviderSettingsSources();
    const scopes = this.storage.listEnvScopesByProviderIds(sources.map((source) => source.id));
    const rows: ReplicaProviderSettingsRow[] = [];
    for (const source of sources) {
      const env = tryParseProviderEnv(source.env);
      if (env === undefined) {
        // A null env would delete the VM's values; keep them until home's env is fixed.
        logger.debug({ provider: source.name }, 'Skipped provider with invalid env in push');
        continue;
      }
      rows.push({
        providerName: source.name,
        env,
        envScopes: scopes.get(source.id) ?? {},
        auto_compact_threshold: source.autoCompactThreshold,
        claude_launch_settings_json: source.claudeLaunchSettingsJson,
      });
    }
    return rows.sort((a, b) =>
      a.providerName < b.providerName ? -1 : a.providerName > b.providerName ? 1 : 0,
    );
  }
}
