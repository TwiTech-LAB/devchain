import type { CreateWatcher } from '../../storage/models/domain.models';
import type { DataSeeder, SeederContext } from '../services/data-seeder.service';

const SEEDER_NAME = '0001_seed_compact_on_idle_watcher';
const SEEDER_VERSION = 2;
const WATCHER_NAME = 'Compact on idle';
const PROJECT_BATCH_SIZE = 1000;

const COMPACT_ON_IDLE_WATCHER_CONFIG: Omit<CreateWatcher, 'projectId' | 'scopeFilterId'> = {
  name: WATCHER_NAME,
  description: 'Triggers compact request when session is idle and context is at 0%',
  enabled: true,
  scope: 'provider',
  pollIntervalMs: 60000,
  viewportLines: 20,
  idleAfterSeconds: 20,
  condition: {
    type: 'regex',
    pattern: 'Context low \\(0% remaining\\)',
  },
  cooldownMs: 180000,
  cooldownMode: 'until_clear',
  eventName: 'watcher.conversation.compact_request',
};

export async function runSeedCompactOnIdleWatcher(ctx: SeederContext): Promise<void> {
  let created = 0;
  let updated = 0;
  let skipped = 0;
  let totalProjects = 0;
  let offset = 0;

  const providers = await ctx.storage.listProviders();
  const claudeProvider = providers.items.find((provider) => provider.name === 'claude');
  if (!claudeProvider) {
    ctx.logger.warn(
      { seederName: SEEDER_NAME, seederVersion: SEEDER_VERSION },
      'Claude provider not found; skipping compact-on-idle watcher seeder',
    );
    return;
  }
  const claudeProviderId = claudeProvider.id;

  while (true) {
    const result = await ctx.storage.listProjects({
      limit: PROJECT_BATCH_SIZE,
      offset,
    });

    if (result.items.length === 0) {
      break;
    }

    for (const project of result.items) {
      totalProjects++;
      const watchers = await ctx.storage.listWatchers(project.id);
      const existingWatcher = watchers.find((watcher) => watcher.name === WATCHER_NAME);

      if (existingWatcher) {
        if (existingWatcher.scopeFilterId !== claudeProviderId) {
          await ctx.watchersService.updateWatcher(existingWatcher.id, {
            scopeFilterId: claudeProviderId,
          });
          updated++;
        } else {
          skipped++;
        }
        continue;
      }

      await ctx.watchersService.createWatcher({
        projectId: project.id,
        scopeFilterId: claudeProviderId,
        ...COMPACT_ON_IDLE_WATCHER_CONFIG,
      });
      created++;
    }

    offset += result.items.length;
    if (offset >= result.total) {
      break;
    }
  }

  ctx.logger.info(
    {
      seederName: SEEDER_NAME,
      seederVersion: SEEDER_VERSION,
      created,
      updated,
      skipped,
      totalProjects,
    },
    'Compact-on-idle watcher seeder completed',
  );
}

export const seedCompactOnIdleWatcherSeeder: DataSeeder = {
  name: SEEDER_NAME,
  version: SEEDER_VERSION,
  run: runSeedCompactOnIdleWatcher,
};
