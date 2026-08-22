import type {
  IntegrationCredentials,
  IntegrationProvider,
} from '../../storage/models/domain.models';
import type {
  ExternalDescriptionEditCapability,
  ExternalMyWorkCapability,
  ExternalOwnedMutationsCapability,
  ExternalProviderAccount,
  ExternalProviderDescriptor,
  ExternalTimeEntryMutationsCapability,
} from '../models/external-provider.models';

export const EXTERNAL_TASK_PROVIDERS = Symbol('EXTERNAL_TASK_PROVIDERS');

export interface ExternalTaskProvider {
  readonly provider: IntegrationProvider;
  readonly descriptor: ExternalProviderDescriptor;
  readonly myWork?: ExternalMyWorkCapability;
  readonly ownedMutations?: ExternalOwnedMutationsCapability;
  readonly descriptionEdit?: ExternalDescriptionEditCapability;
  readonly timeEntryMutations?: ExternalTimeEntryMutationsCapability;
  verifyCredentials(credentials: IntegrationCredentials): Promise<ExternalProviderAccount>;
}
