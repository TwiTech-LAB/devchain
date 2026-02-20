import type { CreateSubscriber } from '../../storage/models/domain.models';
import type { DataSeeder, SeederContext } from '../services/data-seeder.service';

const SEEDER_NAME = '0005_seed_renew_instructions_subscriber';
const SEEDER_VERSION = 1;
const SUBSCRIBER_NAME = 'Renew instructions';
const EVENT_NAME = 'claude.hooks.session.started';
const PROJECT_BATCH_SIZE = 1000;

const RENEW_INSTRUCTIONS_SUBSCRIBER_CONFIG: Omit<CreateSubscriber, 'projectId'> = {
  name: SUBSCRIBER_NAME,
  description: null,
  enabled: true,
  eventName: EVENT_NAME,
  eventFilter: {
    field: 'source',
    operator: 'regex',
    value: 'resume|clear|compact',
  },
  actionType: 'send_agent_message',
  actionInputs: {
    text: {
      source: 'custom',
      customValue:
        'Your agent session id (sessionId): {{sessionIdShort}}\n' +
        'Your agent name: {{agentName}}\n' +
        '! Important: Re-load your agent profile by using devchain_get_agent_by_name to refresh SOP instructions and continue working !',
    },
    immediate: {
      source: 'custom',
      customValue: 'false',
    },
    submitKey: {
      source: 'custom',
      customValue: 'Enter',
    },
  },
  delayMs: 3000,
  cooldownMs: 2000,
  retryOnError: false,
  groupName: null,
  position: 0,
  priority: 0,
};

export async function runSeedRenewInstructionsSubscriber(ctx: SeederContext): Promise<void> {
  let created = 0;
  let skipped = 0;
  let totalProjects = 0;
  let offset = 0;

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

      const subscribers = await ctx.storage.findSubscribersByEventName(project.id, EVENT_NAME);
      const existing = subscribers.find((s) => s.name === SUBSCRIBER_NAME);

      if (existing) {
        skipped++;
        continue;
      }

      await ctx.storage.createSubscriber({
        projectId: project.id,
        ...RENEW_INSTRUCTIONS_SUBSCRIBER_CONFIG,
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
      skipped,
      totalProjects,
    },
    'Renew-instructions subscriber seeder completed',
  );
}

export const seedRenewInstructionsSubscriberSeeder: DataSeeder = {
  name: SEEDER_NAME,
  version: SEEDER_VERSION,
  run: runSeedRenewInstructionsSubscriber,
};
