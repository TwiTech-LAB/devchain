import { Inject, Injectable, NotFoundException, forwardRef } from '@nestjs/common';
import { STORAGE_SERVICE, type StorageService } from '../../storage/interfaces/storage.interface';
import type { Watcher, CreateWatcher, UpdateWatcher } from '../../storage/models/domain.models';
import { WatcherRunnerService } from './watcher-runner.service';
import { createLogger } from '../../../common/logging/logger';

/**
 * Result of testing a watcher against current viewport.
 */
export interface TestWatcherResult {
  /** The watcher configuration */
  watcher: Watcher;
  /** Sessions that were checked */
  sessionsChecked: number;
  /** Results per session */
  results: Array<{
    sessionId: string;
    agentId: string | null;
    tmuxSessionId: string | null;
    viewport: string | null;
    viewportHash: string | null;
    conditionMatched: boolean;
  }>;
}

/**
 * WatchersService - Business logic for watcher CRUD operations.
 * Coordinates storage operations with runtime watcher management.
 */
@Injectable()
export class WatchersService {
  private readonly logger = createLogger('WatchersService');

  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    @Inject(forwardRef(() => WatcherRunnerService))
    private readonly watcherRunner: WatcherRunnerService,
  ) {}

  /**
   * List all watchers for a project.
   */
  async listWatchers(projectId: string): Promise<Watcher[]> {
    this.logger.debug({ projectId }, 'Listing watchers');
    return this.storage.listWatchers(projectId);
  }

  /**
   * Get a watcher by ID.
   * @throws NotFoundException if watcher not found
   */
  async getWatcher(id: string): Promise<Watcher> {
    this.logger.debug({ id }, 'Getting watcher');
    const watcher = await this.storage.getWatcher(id);
    if (!watcher) {
      throw new NotFoundException(`Watcher not found: ${id}`);
    }
    return watcher;
  }

  /**
   * Create a new watcher.
   * If enabled, starts the watcher immediately.
   */
  async createWatcher(data: CreateWatcher): Promise<Watcher> {
    this.logger.debug({ name: data.name, projectId: data.projectId }, 'Creating watcher');

    const watcher = await this.storage.createWatcher(data);

    // Start watcher if enabled
    if (watcher.enabled) {
      this.logger.debug({ watcherId: watcher.id }, 'Starting newly created watcher');
      await this.watcherRunner.startWatcher(watcher);
    }

    return watcher;
  }

  /**
   * Update an existing watcher.
   * Restarts the watcher if it was running or if enabled status changed.
   */
  async updateWatcher(id: string, data: UpdateWatcher): Promise<Watcher> {
    this.logger.debug({ id }, 'Updating watcher');

    // Verify watcher exists
    const existing = await this.getWatcher(id);

    // Update in storage
    const updated = await this.storage.updateWatcher(id, data);

    // Always stop existing watcher first (handles config changes)
    if (this.watcherRunner.isWatcherRunning(id)) {
      this.logger.debug({ watcherId: id }, 'Stopping watcher before restart');
      await this.watcherRunner.stopWatcher(id);
    }

    // Start if now enabled
    if (updated.enabled) {
      this.logger.debug({ watcherId: id }, 'Starting updated watcher');
      await this.watcherRunner.startWatcher(updated);
    } else if (existing.enabled && !updated.enabled) {
      this.logger.debug({ watcherId: id }, 'Watcher disabled');
    }

    return updated;
  }

  /**
   * Delete a watcher.
   * Stops the watcher first if running.
   */
  async deleteWatcher(id: string): Promise<void> {
    this.logger.debug({ id }, 'Deleting watcher');

    // Stop watcher if running
    if (this.watcherRunner.isWatcherRunning(id)) {
      this.logger.debug({ watcherId: id }, 'Stopping watcher before deletion');
      await this.watcherRunner.stopWatcher(id);
    }

    await this.storage.deleteWatcher(id);
  }

  /**
   * Toggle watcher enabled status.
   * Convenience method that delegates to updateWatcher.
   */
  async toggleWatcher(id: string, enabled: boolean): Promise<Watcher> {
    this.logger.debug({ id, enabled }, 'Toggling watcher');
    return this.updateWatcher(id, { enabled });
  }

  /**
   * List all enabled watchers across all projects.
   * Used by runtime initialization.
   */
  async listEnabledWatchers(): Promise<Watcher[]> {
    this.logger.debug('Listing all enabled watchers');
    return this.storage.listEnabledWatchers();
  }

  /**
   * Test a watcher against current terminal viewports.
   * Returns viewport preview and condition match status without triggering events.
   */
  async testWatcher(id: string): Promise<TestWatcherResult> {
    this.logger.debug({ id }, 'Testing watcher');

    const watcher = await this.getWatcher(id);
    const results = await this.watcherRunner.testWatcher(watcher);

    return {
      watcher,
      sessionsChecked: results.length,
      results,
    };
  }
}
