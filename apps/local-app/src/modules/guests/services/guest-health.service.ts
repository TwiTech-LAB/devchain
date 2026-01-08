import { Injectable, Inject, OnModuleInit, OnModuleDestroy, forwardRef } from '@nestjs/common';
import { createLogger } from '../../../common/logging/logger';
import { STORAGE_SERVICE, StorageService } from '../../storage/interfaces/storage.interface';
import { TmuxService } from '../../terminal/services/tmux.service';
import { EventsService } from '../../events/services/events.service';
import { GuestsService } from './guests.service';
import { Guest } from '../../storage/models/domain.models';
import { GUEST_HEALTH_CHECK_INTERVAL_MS } from '../constants';

const logger = createLogger('GuestHealthService');

@Injectable()
export class GuestHealthService implements OnModuleInit, OnModuleDestroy {
  private healthCheckIntervals: Map<string, NodeJS.Timeout> = new Map();

  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    @Inject(forwardRef(() => TmuxService)) private readonly tmuxService: TmuxService,
    @Inject(forwardRef(() => EventsService)) private readonly eventsService: EventsService,
    @Inject(forwardRef(() => GuestsService)) private readonly guestsService: GuestsService,
  ) {
    logger.info('GuestHealthService initialized');
  }

  /**
   * On module init, coordinate the startup sequence:
   * 1. Register with GuestsService (for circular dependency)
   * 2. Tell GuestsService to clean up sandbox from previous run
   * 3. Resume health monitoring for remaining guests
   *
   * This ensures deterministic ordering: sandbox cleanup happens
   * BEFORE we start monitoring, preventing us from monitoring guests
   * that will immediately be deleted.
   */
  async onModuleInit(): Promise<void> {
    // Step 1: Register with GuestsService to avoid circular dependency
    this.guestsService.setHealthServiceRef(this);

    // Step 2: Clean up sandbox project from previous run
    // This deletes any guests from the ephemeral sandbox project
    await this.guestsService.initializeAndCleanup();

    // Step 3: Resume monitoring for remaining guests (those in real projects)
    await this.resumeMonitoringForExistingGuests();
  }

  /**
   * On module destroy, clear all health check timers
   */
  onModuleDestroy(): void {
    logger.info('GuestHealthService.onModuleDestroy: clearing all health check timers');
    for (const [guestId, interval] of this.healthCheckIntervals.entries()) {
      clearInterval(interval);
      logger.debug({ guestId }, 'Cleared health check interval');
    }
    this.healthCheckIntervals.clear();
  }

  /**
   * Resume health monitoring for all existing guests
   */
  private async resumeMonitoringForExistingGuests(): Promise<void> {
    try {
      const guests = await this.storage.listAllGuests();
      logger.info({ count: guests.length }, 'Resuming health monitoring for existing guests');

      for (const guest of guests) {
        // First check if the tmux session still exists
        const sessionExists = await this.tmuxService.hasSession(guest.tmuxSessionId);
        if (!sessionExists) {
          // Session is dead, clean up the guest
          logger.info(
            { guestId: guest.id, tmuxSessionId: guest.tmuxSessionId },
            'Tmux session dead on startup, cleaning up guest',
          );
          await this.handleGuestDeath(guest);
        } else {
          // Session exists, start monitoring
          this.startMonitoring(guest);
        }
      }
    } catch (error) {
      logger.error({ error: String(error) }, 'Failed to resume monitoring for existing guests');
    }
  }

  /**
   * Start health monitoring for a guest
   */
  startMonitoring(guest: Guest): void {
    // Stop existing monitoring if any
    this.stopMonitoring(guest.id);

    const interval = setInterval(async () => {
      await this.checkGuestHealth(guest);
    }, GUEST_HEALTH_CHECK_INTERVAL_MS);

    this.healthCheckIntervals.set(guest.id, interval);
    logger.info(
      { guestId: guest.id, intervalMs: GUEST_HEALTH_CHECK_INTERVAL_MS },
      'Started health monitoring for guest',
    );
  }

  /**
   * Stop health monitoring for a guest
   */
  stopMonitoring(guestId: string): void {
    const interval = this.healthCheckIntervals.get(guestId);
    if (interval) {
      clearInterval(interval);
      this.healthCheckIntervals.delete(guestId);
      logger.debug({ guestId }, 'Stopped health monitoring for guest');
    }
  }

  /**
   * Check health of a single guest
   */
  private async checkGuestHealth(guest: Guest): Promise<void> {
    try {
      const sessionExists = await this.tmuxService.hasSession(guest.tmuxSessionId);

      if (!sessionExists) {
        logger.info(
          { guestId: guest.id, tmuxSessionId: guest.tmuxSessionId },
          'Tmux session no longer exists, cleaning up guest',
        );
        await this.handleGuestDeath(guest);
      } else {
        // Update last seen timestamp
        await this.guestsService.updateGuestLastSeen(guest.id);
      }
    } catch (error) {
      logger.error({ guestId: guest.id, error: String(error) }, 'Error checking guest health');
    }
  }

  /**
   * Handle guest death - delete guest and publish event
   */
  private async handleGuestDeath(guest: Guest): Promise<void> {
    // Stop monitoring first
    this.stopMonitoring(guest.id);

    try {
      // Delete the guest record
      await this.guestsService.deleteGuest(guest.id);

      // Publish guest.unregistered event
      await this.eventsService.publish('guest.unregistered', {
        guestId: guest.id,
        projectId: guest.projectId,
        name: guest.name,
        tmuxSessionId: guest.tmuxSessionId,
        reason: 'tmux_session_died',
      });

      logger.info(
        { guestId: guest.id, tmuxSessionId: guest.tmuxSessionId },
        'Guest cleaned up after tmux session death',
      );
    } catch (error) {
      logger.error(
        { guestId: guest.id, error: String(error) },
        'Failed to clean up guest after tmux session death',
      );
    }
  }
}
