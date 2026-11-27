import { Inject, Injectable } from '@nestjs/common';
import { AppError, ValidationError } from '../../../common/errors/error-types';
import { STORAGE_SERVICE, type StorageService } from '../../storage/interfaces/storage.interface';
import {
  INTEGRATION_PROVIDER_IDS,
  type ExternalTaskLinkInput,
  type IntegrationCredentials,
  type IntegrationProvider,
} from '../../storage/models/domain.models';
import type { ExternalProviderTaskDetail } from '../models/external-provider.models';
import {
  jiraSiteHostname,
  normalizeExternalTaskSourceUrl,
  parseExternalTaskUrl,
} from '../models/external-task-source';
import { ExternalMyWorkService } from '../my-work/external-my-work.service';

export interface ExternalTaskReferenceInput {
  projectId: string;
  ref: string;
  provider?: IntegrationProvider;
}

/** The link row content a UI import would write for the same remote task. */
export interface ExternalTaskLinkPayload extends ExternalTaskLinkInput {
  sourceSnapshot: {
    remoteKey: string;
    title: string;
    description: string | null;
    webUrl: string;
    workAreaId: string;
    workAreaName: string;
    statusName: string;
  };
}

export interface ResolvedExternalTask {
  provider: IntegrationProvider;
  detail: ExternalProviderTaskDetail;
  link: ExternalTaskLinkPayload;
  /** Epic in this project already linked to the task, whatever connection wrote the link. */
  linkedEpicId: string | null;
}

const MAX_REF_LENGTH = 2_048;
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

type ResolverStorage = Pick<StorageService, 'listIntegrationConnections' | 'findExternalTaskLink'>;

/**
 * Turns an agent-supplied task reference (id, key or URL) into a verified
 * remote task and the link payload for it. The vendor read runs here, so call
 * it outside any DB transaction and recheck the returned connection id and
 * generation at commit.
 */
@Injectable()
export class ExternalTaskReferenceResolver {
  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: ResolverStorage,
    private readonly myWork: ExternalMyWorkService,
  ) {}

  async resolve(input: ExternalTaskReferenceInput): Promise<ResolvedExternalTask> {
    const ref = typeof input.ref === 'string' ? input.ref.trim() : '';
    if (!ref || ref.length > MAX_REF_LENGTH) {
      throw invalidReference('Give a task id, key or URL.', 'empty');
    }
    if (input.provider !== undefined && !INTEGRATION_PROVIDER_IDS.includes(input.provider)) {
      throw unsupportedProvider();
    }

    const connected = (await this.storage.listIntegrationConnections(input.projectId))
      .filter((connection) => connection.projectId === input.projectId)
      .map((connection) => connection.provider);
    const { provider, taskId, jiraHostname } = this.resolveProvider(ref, input.provider, connected);
    if (!connected.includes(provider)) {
      throw notConnected(provider);
    }
    const { detail, connection } = await this.readDetail(
      input.projectId,
      provider,
      taskId,
      jiraHostname,
    );
    const webUrl = normalizeExternalTaskSourceUrl(provider, detail.webUrl);
    if (!webUrl) {
      throw new ValidationError('The remote task source URL is unavailable.', {
        provider,
        reason: 'invalid_source_url',
      });
    }
    const link = await this.storage.findExternalTaskLink(
      input.projectId,
      provider,
      detail.location.scopeKey,
      detail.remoteId,
    );

    return {
      provider,
      detail,
      linkedEpicId: link?.epicId ?? null,
      link: {
        connectionId: connection.id,
        connectionGeneration: connection.generation,
        provider,
        remoteScopeKey: detail.location.scopeKey,
        remoteTaskId: detail.remoteId,
        sourceSnapshot: {
          remoteKey: detail.remoteKey,
          title: detail.title,
          description: detail.description,
          webUrl,
          workAreaId: detail.location.workAreaId,
          workAreaName: detail.location.workAreaName,
          statusName: detail.status.name,
        },
      },
    };
  }

  private resolveProvider(
    ref: string,
    explicit: IntegrationProvider | undefined,
    connected: IntegrationProvider[],
  ): { provider: IntegrationProvider; taskId: string; jiraHostname: string | null } {
    if (URL_SCHEME.test(ref)) {
      const parsed = parseExternalTaskUrl(ref);
      if (parsed.kind === 'unsupported_host') {
        throw unsupportedProvider();
      }
      if (parsed.kind === 'unsupported_path') {
        throw invalidReference(
          parsed.provider === 'clickup'
            ? 'Use a ClickUp task URL of the form https://app.clickup.com/t/<task id>. Custom task ids are not supported.'
            : 'Use a Jira issue URL of the form https://<site>.atlassian.net/browse/<KEY>.',
          'unsupported_url_path',
          parsed.provider,
        );
      }
      if (explicit !== undefined && explicit !== parsed.provider) {
        throw invalidReference(
          `The URL is a ${parsed.provider} task, but provider is ${explicit}.`,
          'provider_mismatch',
          parsed.provider,
        );
      }
      return {
        provider: parsed.provider,
        taskId: parsed.taskId,
        jiraHostname: parsed.provider === 'jira' ? parsed.hostname : null,
      };
    }
    if (/[\s/?#]/.test(ref)) {
      throw invalidReference('Give a task id, key or full https URL.', 'malformed');
    }
    if (explicit !== undefined) {
      return { provider: explicit, taskId: ref, jiraHostname: null };
    }
    if (connected.length === 1) {
      return { provider: connected[0], taskId: ref, jiraHostname: null };
    }
    throw new AppError(
      connected.length === 0
        ? 'No integration is connected in this project; connect ClickUp or Jira, then set provider.'
        : `Several integrations are connected; set provider to one of: ${connected.join(', ')}.`,
      'PROVIDER_REQUIRED',
      400,
      { connectedProviders: connected },
    );
  }

  private assertJiraSite(credentials: IntegrationCredentials, hostname: string): void {
    if (credentials.provider !== 'jira') {
      throw notConnected('jira');
    }
    const connectedHostname = jiraSiteHostname(credentials.siteUrl);
    if (connectedHostname !== hostname) {
      throw new AppError(
        'The Jira URL is on a different site than the Jira connection of this project.',
        'EXTERNAL_TASK_WRONG_SITE',
        400,
        { provider: 'jira', site: hostname, connectedSite: connectedHostname },
      );
    }
  }

  private async readDetail(
    projectId: string,
    provider: IntegrationProvider,
    taskId: string,
    jiraHostname: string | null,
  ): ReturnType<ExternalMyWorkService['readTaskDetail']> {
    try {
      // The site check runs on the credential snapshot that serves the read,
      // so a connection replaced after provider discovery cannot slip through.
      return await this.myWork.readTaskDetail(
        projectId,
        provider,
        taskId,
        jiraHostname === null
          ? undefined
          : (credentials) => this.assertJiraSite(credentials, jiraHostname),
      );
    } catch (error) {
      // The connection can go away between the check above and the read.
      if (error instanceof ValidationError && error.details?.reason === 'not_connected') {
        throw notConnected(provider);
      }
      throw error;
    }
  }
}

function notConnected(provider: IntegrationProvider): AppError {
  return new AppError(
    `${provider} is not connected in this project.`,
    'INTEGRATION_NOT_CONNECTED',
    400,
    { provider },
  );
}

function unsupportedProvider(): AppError {
  return new AppError(
    `Only ClickUp and Jira tasks are supported (${INTEGRATION_PROVIDER_IDS.join(', ')}).`,
    'UNSUPPORTED_PROVIDER',
    400,
    { supportedProviders: [...INTEGRATION_PROVIDER_IDS] },
  );
}

function invalidReference(
  message: string,
  reason: string,
  provider?: IntegrationProvider,
): AppError {
  return new AppError(message, 'EXTERNAL_TASK_REF_INVALID', 400, {
    reason,
    ...(provider ? { provider } : {}),
  });
}
