import { Injectable, Inject, OnModuleInit, forwardRef } from '@nestjs/common';
import { createLogger } from '../../../common/logging/logger';
import { ValidationError, ConflictError } from '../../../common/errors/error-types';
import { STORAGE_SERVICE, StorageService } from '../../storage/interfaces/storage.interface';
import { TmuxService } from '../../terminal/services/tmux.service';
import { EventsService } from '../../events/services/events.service';
import { RegisterGuestDto, RegisterGuestResultDto } from '../dtos/guest.dto';
import { GUEST_SANDBOX_PROJECT_NAME, GUEST_SANDBOX_ROOT_PATH } from '../constants';
import { Guest } from '../../storage/models/domain.models';

const logger = createLogger('GuestsService');

@Injectable()
export class GuestsService implements OnModuleInit {
  private guestHealthServiceRef?: { startMonitoring: (guest: Guest) => void };

  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    @Inject(forwardRef(() => TmuxService)) private readonly tmuxService: TmuxService,
    @Inject(forwardRef(() => EventsService)) private readonly eventsService: EventsService,
  ) {
    logger.info('GuestsService initialized');
  }

  /**
   * Set reference to GuestHealthService (to avoid circular dependency)
   */
  setHealthServiceRef(healthService: { startMonitoring: (guest: Guest) => void }): void {
    this.guestHealthServiceRef = healthService;
  }

  /**
   * On module init, we do nothing here.
   * Startup sequence is coordinated by GuestHealthService.onModuleInit which:
   * 1. Registers itself with GuestsService
   * 2. Calls initializeAndCleanup() to clean sandbox
   * 3. Resumes health monitoring for remaining guests
   * This ensures deterministic ordering: cleanup before monitoring.
   */
  async onModuleInit(): Promise<void> {
    // Startup is coordinated by GuestHealthService - see initializeAndCleanup()
  }

  /**
   * Initialize guests module: clean up sandbox from previous run.
   * Called by GuestHealthService during startup to ensure ordering.
   */
  async initializeAndCleanup(): Promise<void> {
    logger.info('GuestsService.initializeAndCleanup: cleaning up sandbox from previous run');
    await this.cleanupSandbox();
  }

  /**
   * Clean up the sandbox project if it exists
   */
  async cleanupSandbox(): Promise<void> {
    try {
      const sandboxProject = await this.storage.getProjectByRootPath(GUEST_SANDBOX_ROOT_PATH);
      if (sandboxProject) {
        logger.info({ projectId: sandboxProject.id }, 'Deleting sandbox project from previous run');
        await this.storage.deleteProject(sandboxProject.id);
      }
    } catch (error) {
      logger.warn({ error: String(error) }, 'Failed to cleanup sandbox project');
    }
  }

  /**
   * Get or create the sandbox project for guests without a matching project
   */
  async getOrCreateSandboxProject(): Promise<{ id: string; name: string }> {
    // Check if sandbox already exists
    const existing = await this.storage.getProjectByRootPath(GUEST_SANDBOX_ROOT_PATH);
    if (existing) {
      return { id: existing.id, name: existing.name };
    }

    // Create sandbox project
    const project = await this.storage.createProject({
      name: GUEST_SANDBOX_PROJECT_NAME,
      description: 'Ephemeral project for guest agents without a matching project directory',
      rootPath: GUEST_SANDBOX_ROOT_PATH,
      isTemplate: false,
    });

    logger.info({ projectId: project.id }, 'Created sandbox project');
    return { id: project.id, name: project.name };
  }

  /**
   * Register a new guest agent
   */
  async register(dto: RegisterGuestDto): Promise<RegisterGuestResultDto> {
    const { name, tmuxSessionId, description } = dto;

    logger.info({ name, tmuxSessionId }, 'Registering guest');

    // 1. Validate tmux session exists
    const sessionExists = await this.tmuxService.hasSession(tmuxSessionId);
    if (!sessionExists) {
      throw new ValidationError(`Tmux session "${tmuxSessionId}" does not exist`, {
        tmuxSessionId,
      });
    }

    // 2. Check tmux session not already registered as a guest
    const existingGuest = await this.storage.getGuestByTmuxSessionId(tmuxSessionId);
    if (existingGuest) {
      throw new ConflictError(
        `Tmux session "${tmuxSessionId}" is already registered as guest "${existingGuest.name}"`,
        { tmuxSessionId, existingGuestId: existingGuest.id, existingGuestName: existingGuest.name },
      );
    }

    // 3. Get the cwd of the tmux session
    const cwd = await this.tmuxService.getSessionCwd(tmuxSessionId);
    if (!cwd) {
      throw new ValidationError(
        `Could not determine working directory for tmux session "${tmuxSessionId}"`,
        { tmuxSessionId },
      );
    }

    logger.info({ tmuxSessionId, cwd }, 'Detected tmux session cwd');

    // 4. Find project containing this path, or create sandbox
    let projectId: string;
    let projectName: string;
    let isSandbox = false;

    const matchingProject = await this.storage.findProjectContainingPath(cwd);
    if (matchingProject) {
      projectId = matchingProject.id;
      projectName = matchingProject.name;
      logger.info({ projectId, projectName, cwd }, 'Found matching project for guest');
    } else {
      const sandbox = await this.getOrCreateSandboxProject();
      projectId = sandbox.id;
      projectName = sandbox.name;
      isSandbox = true;
      logger.info({ projectId, projectName, cwd }, 'No matching project, using sandbox');
    }

    // 5. Check name availability - must not conflict with existing agents or guests
    await this.validateNameAvailability(projectId, name);

    // 6. Create guest record
    const now = new Date().toISOString();
    const guest = await this.storage.createGuest({
      projectId,
      name,
      description: description ?? null,
      tmuxSessionId,
      lastSeenAt: now,
    });

    logger.info({ guestId: guest.id, projectId, name }, 'Guest registered');

    // 7. Start health monitoring
    if (this.guestHealthServiceRef) {
      this.guestHealthServiceRef.startMonitoring(guest);
    }

    // 8. Publish guest.registered event
    await this.eventsService.publish('guest.registered', {
      guestId: guest.id,
      projectId,
      name,
      tmuxSessionId,
      isSandbox,
    });

    // 9. Return guestId (used as sessionId for MCP tools)
    return {
      guestId: guest.id,
      projectId,
      projectName,
      isSandbox,
    };
  }

  /**
   * Validate that the name is not already used by an agent or guest in the project
   */
  private async validateNameAvailability(projectId: string, name: string): Promise<void> {
    // Check for existing agent with same name (case-insensitive)
    try {
      const existingAgent = await this.storage.getAgentByName(projectId, name);
      if (existingAgent) {
        throw new ConflictError(`Name "${name}" is already used by an agent in this project`, {
          projectId,
          name,
          existingAgentId: existingAgent.id,
        });
      }
    } catch (error) {
      // getAgentByName throws NotFoundError if not found - that's what we want
      if (!(error instanceof Error && error.name === 'NotFoundError')) {
        throw error;
      }
    }

    // Check for existing guest with same name (case-insensitive)
    const existingGuest = await this.storage.getGuestByName(projectId, name);
    if (existingGuest) {
      throw new ConflictError(`Name "${name}" is already used by a guest in this project`, {
        projectId,
        name,
        existingGuestId: existingGuest.id,
      });
    }
  }

  /**
   * Get a guest by ID
   */
  async getGuest(guestId: string): Promise<Guest> {
    return this.storage.getGuest(guestId);
  }

  /**
   * List all guests in a project
   */
  async listGuests(projectId: string): Promise<Guest[]> {
    return this.storage.listGuests(projectId);
  }

  /**
   * List all guests across all projects
   */
  async listAllGuests(): Promise<Guest[]> {
    return this.storage.listAllGuests();
  }

  /**
   * Delete a guest
   */
  async deleteGuest(guestId: string): Promise<void> {
    await this.storage.deleteGuest(guestId);
  }

  /**
   * Update guest last seen timestamp
   */
  async updateGuestLastSeen(guestId: string): Promise<Guest> {
    const now = new Date().toISOString();
    return this.storage.updateGuestLastSeen(guestId, now);
  }
}
