import { Inject, Injectable } from '@nestjs/common';
import { STORAGE_SERVICE, type StorageService } from '../../storage/interfaces/storage.interface';
import type { Agent, ProfileProviderConfig, Provider } from '../../storage/models/domain.models';
import type { ProviderUsageAccount } from '../provider-usage.types';
import {
  buildEffectiveEnv,
  compareUsageAccounts,
  resolveUsageAccount,
} from './provider-usage-accounts';

export interface ResolvedUsageAccount {
  account: ProviderUsageAccount;
  env: Readonly<Record<string, string>>;
  binPath: string | null;
}

type AccountsStorage = Pick<
  StorageService,
  | 'getProject'
  | 'listAgents'
  | 'getAgent'
  | 'listProfileProviderConfigsByProfile'
  | 'getProvider'
  | 'getProviderEnvForProject'
>;

/** Lookups shared by the agents of one project list or one timer tick. */
export interface ResolveMemo {
  configsByProfile: Map<string, Promise<ProfileProviderConfig[]>>;
  providers: Map<string, Promise<Provider>>;
  /** Keyed by provider config and project: agents that share both share the account. */
  results: Map<string, ResolvedUsageAccount | null>;
}

const MAX_PROJECT_AGENTS = 1000;

@Injectable()
export class ProviderUsageAccountsService {
  constructor(@Inject(STORAGE_SERVICE) private readonly storage: AccountsStorage) {}

  /** One entry per distinct account, ordered claude, codex, agy. */
  async listForProject(projectId: string): Promise<ResolvedUsageAccount[]> {
    await this.storage.getProject(projectId);
    const { items: agents } = await this.storage.listAgents(projectId, {
      limit: MAX_PROJECT_AGENTS,
    });
    const memo = createMemo();
    const byKey = new Map<string, ResolvedUsageAccount>();
    for (const agent of agents) {
      const resolved = await this.resolveAgent(agent, memo);
      if (resolved && !byKey.has(resolved.account.key)) byKey.set(resolved.account.key, resolved);
    }
    return [...byKey.values()].sort((a, b) => compareUsageAccounts(a.account, b.account));
  }

  async resolveForAgent(
    agentId: string,
    memo: ResolveMemo = createMemo(),
  ): Promise<ResolvedUsageAccount | null> {
    const agent = await this.storage.getAgent(agentId);
    return this.resolveAgent(agent, memo);
  }

  /** Picks the provider config the way a launch does. */
  private async resolveAgent(
    agent: Agent,
    memo: ResolveMemo,
  ): Promise<ResolvedUsageAccount | null> {
    let configs = memo.configsByProfile.get(agent.profileId);
    if (!configs) {
      configs = this.storage.listProfileProviderConfigsByProfile(agent.profileId);
      memo.configsByProfile.set(agent.profileId, configs);
    }
    const profileConfigs = await configs;
    const config =
      profileConfigs.find((candidate) => candidate.id === agent.providerConfigId) ??
      profileConfigs[0];
    if (!config) return null;
    const resultKey = `${config.id}\0${agent.projectId}`;
    const known = memo.results.get(resultKey);
    if (known !== undefined) return known;

    let provider = memo.providers.get(config.providerId);
    if (!provider) {
      provider = this.storage.getProvider(config.providerId);
      memo.providers.set(config.providerId, provider);
    }
    const { id, name, binPath } = await provider;
    const env = buildEffectiveEnv(
      process.env,
      this.storage.getProviderEnvForProject(id, agent.projectId),
      config.env,
    );
    const account = resolveUsageAccount(name, env);
    const resolved = account ? { account, env, binPath } : null;
    memo.results.set(resultKey, resolved);
    return resolved;
  }
}

export function createMemo(): ResolveMemo {
  return { configsByProfile: new Map(), providers: new Map(), results: new Map() };
}
