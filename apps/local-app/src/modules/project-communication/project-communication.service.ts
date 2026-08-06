import { Inject, Injectable, Logger } from '@nestjs/common';
import { getContainerScopedProjectId } from '../../common/config/container-scope';
import { NotFoundError } from '../../common/errors/error-types';
import { AgentMessageDeliveryService } from '../agent-message-delivery/agent-message-delivery.service';
import { STORAGE_SERVICE, type StorageService } from '../storage/interfaces/storage.interface';
import type { Agent, Project } from '../storage/models/domain.models';
import type {
  ProjectCommunicationError,
  ProjectCommunicationOutcome,
  ProjectDeliveryResult,
  ProjectDirectoryEntry,
  ProjectDirectoryOptions,
  ProjectDirectoryResult,
  SendToProjectInput,
} from './dtos/project-communication.types';

const SNAPSHOT_PAGE_SIZE = 100;

type CallerContext = { caller: Agent; sourceProject: Project };

@Injectable()
export class ProjectCommunicationService {
  private readonly logger = new Logger(ProjectCommunicationService.name);

  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    private readonly delivery: AgentMessageDeliveryService,
  ) {}

  async listTargets(
    callerAgentId: string | null | undefined,
    options: ProjectDirectoryOptions,
  ): Promise<ProjectCommunicationOutcome<ProjectDirectoryResult>> {
    let resolvedCallerAgentId: string | undefined;

    try {
      const authorized = await this.authorizeCaller(callerAgentId);
      if ('error' in authorized) {
        return authorized;
      }
      resolvedCallerAgentId = authorized.context.caller.id;
      if (getContainerScopedProjectId()) {
        return this.failure(
          'CROSS_PROJECT_UNAVAILABLE',
          'Cross-project communication is unavailable in this runtime',
        );
      }

      const projects = await this.collectProjectSnapshot();
      const candidates = projects.filter(
        (project) =>
          !project.isTemplate &&
          project.id.toLowerCase() !== authorized.context.sourceProject.id.toLowerCase(),
      );
      const owners = await this.storage.listProjectOwners(candidates.map(({ id }) => id));
      const ownerProjectIds = new Set(
        owners
          .filter(({ isProjectOwner }) => isProjectOwner)
          .map(({ projectId }) => projectId.toLowerCase()),
      );
      const directory = candidates
        .map<ProjectDirectoryEntry>((project) => ({
          id: project.id,
          shortId: this.shortId(project.id),
          name: project.name,
          description: project.description,
          hasProjectOwner: ownerProjectIds.has(project.id.toLowerCase()),
        }))
        .sort((left, right) => {
          const byName = this.compare(left.name.toLowerCase(), right.name.toLowerCase());
          return byName !== 0 ? byName : this.compare(left.id, right.id);
        });
      const limit = Math.max(0, Math.floor(options.limit));
      const offset = Math.max(0, Math.floor(options.offset));

      return {
        result: {
          projects: directory.slice(offset, offset + limit),
          total: directory.length,
          limit,
          offset,
        },
      };
    } catch {
      this.logger.error({
        code: 'PROJECT_COMMUNICATION_FAILED',
        ...(resolvedCallerAgentId ? { callerAgentId: resolvedCallerAgentId } : {}),
      });
      return this.failure(
        'PROJECT_COMMUNICATION_FAILED',
        'Unable to list projects for cross-project communication',
      );
    }
  }

  async sendToProject(
    input: SendToProjectInput,
  ): Promise<ProjectCommunicationOutcome<ProjectDeliveryResult>> {
    let resolvedCallerAgentId: string | undefined;
    let targetProjectId: string | undefined;

    try {
      const authorized = await this.authorizeCaller(input.callerAgentId);
      if ('error' in authorized) {
        return authorized;
      }
      const { caller, sourceProject } = authorized.context;
      resolvedCallerAgentId = caller.id;

      if (getContainerScopedProjectId()) {
        return this.failure(
          'CROSS_PROJECT_UNAVAILABLE',
          'Cross-project communication is unavailable in this runtime',
        );
      }
      if (sourceProject.isTemplate) {
        return this.failure(
          'SOURCE_TEMPLATE_NOT_ALLOWED',
          'Template projects cannot send cross-project messages',
        );
      }

      const matches = await this.storage.getProjectsByIdPrefix(input.recipientProjectId);
      if (matches.length === 0) {
        return this.failure('PROJECT_NOT_FOUND', 'No project matches that project ID');
      }
      if (matches.length > 1) {
        return this.failure('AMBIGUOUS_PROJECT', 'Project ID prefix matches multiple projects', {
          candidates: matches.map((project) => ({
            id: project.id,
            shortId: this.shortId(project.id),
            name: project.name,
          })),
        });
      }

      const targetProject = matches[0];
      targetProjectId = targetProject.id;
      if (targetProject.id.toLowerCase() === sourceProject.id.toLowerCase()) {
        return this.failure('SAME_PROJECT', 'Choose a project other than the current project');
      }
      if (targetProject.isTemplate) {
        return this.failure(
          'TARGET_TEMPLATE_NOT_ALLOWED',
          'Template projects cannot receive cross-project messages',
        );
      }

      const owners = await this.storage.listProjectOwners([targetProject.id]);
      const owner = owners.find(
        (candidate) =>
          candidate.isProjectOwner &&
          candidate.projectId.toLowerCase() === targetProject.id.toLowerCase(),
      );
      if (!owner) {
        return this.failure(
          'TARGET_PROJECT_OWNER_NOT_FOUND',
          'The target project does not currently have a Project Owner',
        );
      }

      const outcome = await this.delivery.deliverAgentMessage(
        [{ agentId: owner.id, agentName: owner.name }],
        {
          routingKind: 'project',
          sourceProjectId: sourceProject.id,
          sourceProjectName: sourceProject.name,
          targetProjectId: targetProject.id,
          targetProjectName: targetProject.name,
        },
        {
          kind: 'mcp.project',
          body: input.message,
          source: 'mcp.send_message',
          projectId: targetProject.id,
          senderName: caller.name,
          senderType: 'agent',
          senderAgentId: caller.id,
          sourceProjectId: sourceProject.id,
          sourceProjectName: sourceProject.name,
        },
      );
      const deliveryError =
        outcome.status === 'failed'
          ? {
              code: 'DELIVERY_FAILED' as const,
              message: 'Message delivery to the target Project Owner failed',
            }
          : undefined;

      return {
        result: {
          mode: 'project',
          targetProject: {
            id: targetProject.id,
            shortId: this.shortId(targetProject.id),
            name: targetProject.name,
          },
          deliveryStatus: outcome.status,
          ...(deliveryError ? { error: deliveryError } : {}),
        },
      };
    } catch {
      this.logger.error({
        code: 'PROJECT_COMMUNICATION_FAILED',
        ...(resolvedCallerAgentId ? { callerAgentId: resolvedCallerAgentId } : {}),
        ...(targetProjectId ? { targetProjectId } : {}),
      });
      return this.failure(
        'PROJECT_COMMUNICATION_FAILED',
        'Unable to deliver the cross-project message',
      );
    }
  }

  private async authorizeCaller(
    callerAgentId: string | null | undefined,
  ): Promise<{ readonly context: CallerContext } | { readonly error: ProjectCommunicationError }> {
    if (!callerAgentId) {
      return this.failure('AGENT_CONTEXT_REQUIRED', 'A current agent session is required');
    }

    let caller: Agent;
    try {
      caller = await this.storage.getAgent(callerAgentId);
    } catch (error) {
      if (error instanceof NotFoundError) {
        return this.failure('AGENT_CONTEXT_REQUIRED', 'A current agent session is required');
      }
      throw error;
    }
    if (!caller.isProjectOwner) {
      return this.failure(
        'FORBIDDEN_NOT_PROJECT_OWNER',
        'Only the current Project Owner can communicate across projects',
      );
    }

    try {
      const sourceProject = await this.storage.getProject(caller.projectId);
      return { context: { caller, sourceProject } };
    } catch (error) {
      if (error instanceof NotFoundError) {
        return this.failure(
          'SOURCE_PROJECT_NOT_FOUND',
          'The current agent project no longer exists',
        );
      }
      throw error;
    }
  }

  private async collectProjectSnapshot(): Promise<Project[]> {
    const projects: Project[] = [];
    let offset = 0;

    while (true) {
      const page = await this.storage.listProjects({ limit: SNAPSHOT_PAGE_SIZE, offset });
      projects.push(...page.items);
      offset += page.items.length;
      if (page.items.length === 0 || offset >= page.total) {
        return projects;
      }
    }
  }

  private failure(
    code: ProjectCommunicationError['code'],
    message: string,
    data?: unknown,
  ): { readonly error: ProjectCommunicationError } {
    return { error: { code, message, ...(data === undefined ? {} : { data }) } };
  }

  private shortId(projectId: string): string {
    return projectId.slice(0, 8);
  }

  private compare(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
  }
}
