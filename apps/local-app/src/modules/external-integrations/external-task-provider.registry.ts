import { Inject, Injectable } from '@nestjs/common';
import { ValidationError } from '../../common/errors/error-types';
import type { IntegrationProvider } from '../storage/models/domain.models';
import type { ExternalProviderDescriptor } from './models/external-provider.models';
import { EXTERNAL_TASK_PROVIDERS, type ExternalTaskProvider } from './ports/external-task-provider';

@Injectable()
export class ExternalTaskProviderRegistry {
  private readonly providers: Map<IntegrationProvider, ExternalTaskProvider>;

  constructor(@Inject(EXTERNAL_TASK_PROVIDERS) providers: readonly ExternalTaskProvider[]) {
    this.providers = new Map();
    for (const provider of providers) {
      if (this.providers.has(provider.provider)) {
        throw new Error(`Duplicate external task provider: ${provider.provider}`);
      }
      if (
        provider.descriptor.provider !== provider.provider ||
        !provider.descriptor.displayName.trim() ||
        provider.descriptor.capabilities.myWork !== Boolean(provider.myWork)
      ) {
        throw new Error(`Invalid external task provider descriptor: ${provider.provider}`);
      }
      this.providers.set(provider.provider, provider);
    }
  }

  get(provider: IntegrationProvider): ExternalTaskProvider {
    const adapter = this.providers.get(provider);
    if (!adapter) {
      throw new ValidationError('Unsupported external integration provider.');
    }
    return adapter;
  }

  getSupportedProviders(): IntegrationProvider[] {
    return [...this.providers.keys()].sort();
  }

  getDescriptor(provider: IntegrationProvider): ExternalProviderDescriptor {
    return this.projectDescriptor(this.get(provider).descriptor);
  }

  getDescriptors(): ExternalProviderDescriptor[] {
    return this.getSupportedProviders().map((provider) => this.getDescriptor(provider));
  }

  private projectDescriptor(descriptor: ExternalProviderDescriptor): ExternalProviderDescriptor {
    return {
      provider: descriptor.provider,
      displayName: descriptor.displayName.trim(),
      capabilities: { myWork: descriptor.capabilities.myWork },
    };
  }
}
