import { Inject, Injectable, Logger } from '@nestjs/common';
import { NotFoundError } from '../../common/errors/error-types';
import { AgentMessageDeliveryService } from '../agent-message-delivery/agent-message-delivery.service';
import { ProjectWriteAdmissionService } from '../remotes/admission/project-write-admission.service';
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
    private readonly admission: ProjectWriteAdmissionService,
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

      const sourceWorkspaceId = authorized.context.sourceProject.workspaceId;
      const projects = await this.collectProjectSnapshot(sourceWorkspaceId);
      const candidates = projects.filter(
        (project) =>
          this.sameId(project.workspaceId, sourceWorkspaceId) &&
          !project.isTemplate &&
          !this.sameId(project.id, authorized.context.sourceProject.id) &&
          this.admission.getRemoteOwner(project.id) === null,
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

    try {
      const authorized = await this.authorizeCaller(input.callerAgentId);
      if ('error' in authorized) {
        return authorized;
      }
      const { caller, sourceProject } = authorized.context;
      resolvedCallerAgentId = caller.id;

      if (sourceProject.isTemplate) {
        return this.failure(
          'SOURCE_TEMPLATE_NOT_ALLOWED',
          'Template projects cannot send cross-project messages',
        );
      }

      const matches = (await this.storage.getProjectsByIdPrefix(input.recipientProjectId)).filter(
        (project) => this.sameId(project.workspaceId, sourceProject.workspaceId),
      );
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
      if (this.sameId(targetProject.id, sourceProject.id)) {
        return this.failure('SAME_PROJECT', 'Choose a project other than the current project');
      }
      if (targetProject.isTemplate) {
        return this.failure(
          'TARGET_TEMPLATE_NOT_ALLOWED',
          'Template projects cannot receive cross-project messages',
        );
      }
      const notWritable = this.checkTargetWritable(targetProject.id);
      if (notWritable) {
        return notWritable;
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

      const currentProjects = await this.recheckDeliveryProjects(sourceProject, targetProject);
      if ('error' in currentProjects) {
        return currentProjects;
      }
      const currentSourceProject = currentProjects.context.sourceProject;
      const currentTargetProject = currentProjects.context.targetProject;

      const outcome = await this.delivery.deliverAgentMessage(
        [{ agentId: owner.id, agentName: owner.name }],
        {
          routingKind: 'project',
          sourceProjectId: currentSourceProject.id,
          sourceProjectName: currentSourceProject.name,
          targetProjectId: currentTargetProject.id,
          targetProjectName: currentTargetProject.name,
        },
        {
          kind: 'mcp.project',
          body: input.message,
          source: 'mcp.send_message',
          projectId: currentTargetProject.id,
          senderName: caller.name,
          senderType: 'agent',
          senderAgentId: caller.id,
          sourceProjectId: currentSourceProject.id,
          sourceProjectName: currentSourceProject.name,
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
            id: currentTargetProject.id,
            shortId: this.shortId(currentTargetProject.id),
            name: currentTargetProject.name,
          },
          deliveryStatus: outcome.status,
          ...(deliveryError ? { error: deliveryError } : {}),
        },
      };
    } catch {
      this.logger.error({
        code: 'PROJECT_COMMUNICATION_FAILED',
        ...(resolvedCallerAgentId ? { callerAgentId: resolvedCallerAgentId } : {}),
      });
      return this.failure(
        'PROJECT_COMMUNICATION_FAILED',
        'Unable to deliver the cross-project message',
      );
    }
  }

  /** A remote-owned or frozen project cannot run its Project Owner here. */
  private checkTargetWritable(
    projectId: string,
  ): { readonly error: ProjectCommunicationError } | null {
    const remote = this.admission.getRemoteOwner(projectId);
    if (remote) {
      return this.failure(
        'PROJECT_REMOTE',
        'The target project is connected to a remote; message it there',
        { projectId, remoteId: remote.remoteId, remoteName: remote.remoteName },
      );
    }
    if (!this.admission.isWritable(projectId)) {
      return this.failure(
        'PROJECT_FROZEN',
        'The target project is frozen for a remote handoff; try again later',
        { projectId },
      );
    }
    return null;
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

  private async recheckDeliveryProjects(
    sourceProject: Project,
    targetProject: Project,
  ): Promise<
    | { readonly context: { readonly sourceProject: Project; readonly targetProject: Project } }
    | { readonly error: ProjectCommunicationError }
  > {
    let currentSourceProject: Project;
    try {
      currentSourceProject = await this.storage.getProject(sourceProject.id);
    } catch (error) {
      if (error instanceof NotFoundError) {
        return this.failure(
          'SOURCE_PROJECT_NOT_FOUND',
          'The current agent project no longer exists',
        );
      }
      throw error;
    }

    // Prefix resolution used the original source workspace. Fail closed if it moved
    // rather than reusing a target selected under a now-stale authorization scope.
    if (!this.sameId(currentSourceProject.workspaceId, sourceProject.workspaceId)) {
      return this.failure('PROJECT_NOT_FOUND', 'No project matches that project ID');
    }

    let currentTargetProject: Project;
    try {
      currentTargetProject = await this.storage.getProject(targetProject.id);
    } catch (error) {
      if (error instanceof NotFoundError) {
        return this.failure('PROJECT_NOT_FOUND', 'No project matches that project ID');
      }
      throw error;
    }

    if (!this.sameId(currentTargetProject.workspaceId, currentSourceProject.workspaceId)) {
      return this.failure('PROJECT_NOT_FOUND', 'No project matches that project ID');
    }
    if (currentSourceProject.isTemplate) {
      return this.failure(
        'SOURCE_TEMPLATE_NOT_ALLOWED',
        'Template projects cannot send cross-project messages',
      );
    }
    if (currentTargetProject.isTemplate) {
      return this.failure(
        'TARGET_TEMPLATE_NOT_ALLOWED',
        'Template projects cannot receive cross-project messages',
      );
    }

    return {
      context: {
        sourceProject: currentSourceProject,
        targetProject: currentTargetProject,
      },
    };
  }

  private async collectProjectSnapshot(workspaceId: string): Promise<Project[]> {
    const projects: Project[] = [];
    let offset = 0;

    while (true) {
      const page = await this.storage.listProjects({
        workspaceId,
        limit: SNAPSHOT_PAGE_SIZE,
        offset,
      });
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

  private sameId(left: string, right: string): boolean {
    return left.toLowerCase() === right.toLowerCase();
  }
}
