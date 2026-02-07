import { Injectable, OnModuleInit, OnModuleDestroy, Inject, forwardRef } from '@nestjs/common';
import { createHash } from 'crypto';
import { createLogger } from '../../../common/logging/logger';
import { STORAGE_SERVICE, type StorageService } from '../../storage/interfaces/storage.interface';
import type { Watcher, TriggerCondition } from '../../storage/models/domain.models';
import { SessionsService } from '../../sessions/services/sessions.service';
import { TmuxService } from '../../terminal/services/tmux.service';
import { EventsService } from '../../events/services/events.service';
import type { SessionDto } from '../../sessions/dtos/sessions.dto';

/**
 * Cache TTL for viewport captures (2 seconds).
 * Multiple watchers may poll the same session; caching reduces tmux overhead.
 */
const CAPTURE_TTL_MS = 2000;

/**
 * Cache entry for viewport capture
 */
interface CaptureCache {
  text: string;
  ts: number;
}

/**
 * WatcherRunnerService - Phase 2 Implementation
 * Manages terminal watcher polling lifecycle.
 * Polls terminal viewports, matches patterns, and triggers events.
 */
@Injectable()
export class WatcherRunnerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = createLogger('WatcherRunnerService');

  // State maps for runtime management
  private readonly pollIntervals = new Map<string, NodeJS.Timeout>();
  private readonly cooldowns = new Map<string, number>(); // key: `${watcherId}:${sessionId}`, value: timestamp
  private readonly lastConditionState = new Map<string, boolean>(); // key: `${watcherId}:${sessionId}`
  private readonly lastTriggeredHash = new Map<string, string>(); // key: `${watcherId}:${sessionId}`
  private readonly triggerCounts = new Map<string, number>(); // key: `${watcherId}:${sessionId}`
  private readonly captureCache = new Map<string, CaptureCache>(); // key: `${tmuxSessionId}:${lines}`
  private readonly inFlight = new Set<string>(); // watcherId

  // Watcher config cache (avoid repeated DB reads during poll)
  private readonly watcherConfigs = new Map<string, Watcher>();

  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    @Inject(forwardRef(() => SessionsService)) private readonly sessionsService: SessionsService,
    @Inject(forwardRef(() => TmuxService)) private readonly tmuxService: TmuxService,
    @Inject(forwardRef(() => EventsService)) private readonly eventsService: EventsService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.logger.info('WatcherRunnerService initializing...');

    try {
      const enabledWatchers = await this.storage.listEnabledWatchers();
      this.logger.info(`Found ${enabledWatchers.length} enabled watcher(s)`);

      for (const watcher of enabledWatchers) {
        await this.startWatcher(watcher);
      }

      this.logger.info('WatcherRunnerService initialized successfully');
    } catch (error) {
      this.logger.error({ error }, 'Failed to initialize WatcherRunnerService');
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.logger.info('WatcherRunnerService shutting down...');

    // Clear all intervals
    for (const [watcherId, interval] of this.pollIntervals) {
      clearInterval(interval);
      this.logger.debug({ watcherId }, 'Cleared interval');
    }

    // Clear all state maps
    this.pollIntervals.clear();
    this.cooldowns.clear();
    this.lastConditionState.clear();
    this.lastTriggeredHash.clear();
    this.triggerCounts.clear();
    this.captureCache.clear();
    this.inFlight.clear();
    this.watcherConfigs.clear();

    this.logger.info('WatcherRunnerService destroyed');
  }

  /**
   * Start watching a specific watcher configuration.
   * Creates a polling interval that checks matching sessions.
   */
  async startWatcher(watcher: Watcher): Promise<void>;
  async startWatcher(watcherId: string): Promise<void>;
  async startWatcher(watcherOrId: Watcher | string): Promise<void> {
    let watcher: Watcher | null;

    if (typeof watcherOrId === 'string') {
      watcher = await this.storage.getWatcher(watcherOrId);
      if (!watcher) {
        this.logger.warn({ watcherId: watcherOrId }, 'Cannot start watcher: not found');
        return;
      }
    } else {
      watcher = watcherOrId;
    }

    const watcherId = watcher.id;

    // Stop existing if any
    if (this.pollIntervals.has(watcherId)) {
      await this.stopWatcher(watcherId);
    }

    // Cache watcher config
    this.watcherConfigs.set(watcherId, watcher);

    // Create polling interval
    const interval = setInterval(() => {
      this.pollWatcher(watcherId).catch((err) => {
        this.logger.error({ watcherId, error: err }, 'Error in watcher poll cycle');
      });
    }, watcher.pollIntervalMs);

    this.pollIntervals.set(watcherId, interval);

    this.logger.info(
      {
        watcherId,
        name: watcher.name,
        pollIntervalMs: watcher.pollIntervalMs,
        scope: watcher.scope,
      },
      'Started watcher',
    );
  }

  /**
   * Stop watching a specific watcher configuration.
   * Clears polling interval and ALL related state.
   */
  async stopWatcher(watcherId: string): Promise<void> {
    // Clear interval
    const interval = this.pollIntervals.get(watcherId);
    if (interval) {
      clearInterval(interval);
      this.pollIntervals.delete(watcherId);
    }

    // Clean up ALL state for this watcher (prefix matching)
    const prefix = `${watcherId}:`;

    // Use spread to avoid iterator invalidation during deletion
    for (const key of [...this.cooldowns.keys()]) {
      if (key.startsWith(prefix)) {
        this.cooldowns.delete(key);
      }
    }

    for (const key of [...this.lastConditionState.keys()]) {
      if (key.startsWith(prefix)) {
        this.lastConditionState.delete(key);
      }
    }

    for (const key of [...this.lastTriggeredHash.keys()]) {
      if (key.startsWith(prefix)) {
        this.lastTriggeredHash.delete(key);
      }
    }

    for (const key of [...this.triggerCounts.keys()]) {
      if (key.startsWith(prefix)) {
        this.triggerCounts.delete(key);
      }
    }

    // Remove from inFlight
    this.inFlight.delete(watcherId);

    // Remove from config cache
    this.watcherConfigs.delete(watcherId);

    this.logger.info({ watcherId }, 'Stopped watcher');
  }

  /**
   * Restart a watcher (e.g., after config update).
   */
  async restartWatcher(watcherId: string): Promise<void> {
    this.logger.debug({ watcherId }, 'Restarting watcher');
    await this.stopWatcher(watcherId);

    const watcher = await this.storage.getWatcher(watcherId);
    if (watcher && watcher.enabled) {
      await this.startWatcher(watcher);
    }
  }

  /**
   * Poll cycle for a single watcher.
   * Gets matching sessions and checks each one for condition matches.
   */
  private async pollWatcher(watcherId: string): Promise<void> {
    // Guard against overlapping polls
    if (this.inFlight.has(watcherId)) {
      this.logger.debug({ watcherId }, 'Poll skipped: already in flight');
      return;
    }

    const watcher = this.watcherConfigs.get(watcherId);
    if (!watcher) {
      this.logger.warn({ watcherId }, 'Poll skipped: watcher config not found');
      return;
    }

    this.inFlight.add(watcherId);

    try {
      const sessions = await this.getMatchingSessions(watcher);

      this.logger.debug(
        { watcherId, name: watcher.name, sessionCount: sessions.length },
        'Poll cycle starting',
      );

      // Check each session independently - error in one shouldn't stop others
      for (const session of sessions) {
        try {
          await this.checkSession(watcher, session);
        } catch (error) {
          this.logger.error(
            { watcherId, sessionId: session.id, error: String(error) },
            'Error checking session',
          );
        }
      }
    } finally {
      this.inFlight.delete(watcherId);
    }
  }

  /**
   * Check a single session against a watcher's conditions.
   *
   * Orchestrates the full check flow:
   * 1. Apply optional idle gate (activity state + idle duration).
   * 2. Validate tmuxSessionId and capture viewport.
   * 3. Match condition and check trigger eligibility (cooldown + dedup).
   * 4. Trigger event if eligible.
   *
   * @returns Object with check results for testing/logging
   */
  async checkSession(
    watcher: Watcher,
    session: SessionDto,
  ): Promise<{
    skipped: boolean;
    reason?: string;
    matched?: boolean;
    triggered?: boolean;
    viewportHash?: string;
  }> {
    const watcherId = watcher.id;
    const sessionId = session.id;

    // Idle gate: if configured, session must be idle long enough before viewport capture.
    if (watcher.idleAfterSeconds > 0) {
      if (session.activityState !== 'idle') {
        const { viewportHash } = this.checkTriggerEligibility(
          watcher,
          sessionId,
          'idle-gate:not-idle',
          false,
        );
        return { skipped: false, matched: false, triggered: false, viewportHash };
      }

      if (!session.lastActivityAt) {
        this.logger.debug(
          { watcherId, sessionId },
          'Session idle gate failed: no lastActivityAt; treating as not matched',
        );
        const { viewportHash } = this.checkTriggerEligibility(
          watcher,
          sessionId,
          'idle-gate:no-timestamp',
          false,
        );
        return { skipped: false, matched: false, triggered: false, viewportHash };
      }

      const lastActivityTs = Date.parse(session.lastActivityAt);
      if (Number.isNaN(lastActivityTs)) {
        this.logger.debug(
          { watcherId, sessionId, lastActivityAt: session.lastActivityAt },
          'Session idle gate failed: invalid lastActivityAt; treating as not matched',
        );
        const { viewportHash } = this.checkTriggerEligibility(
          watcher,
          sessionId,
          'idle-gate:no-timestamp',
          false,
        );
        return { skipped: false, matched: false, triggered: false, viewportHash };
      }

      const idleDurationMs = Date.now() - lastActivityTs;
      if (idleDurationMs < watcher.idleAfterSeconds * 1000) {
        const { viewportHash } = this.checkTriggerEligibility(
          watcher,
          sessionId,
          'idle-gate:not-enough',
          false,
        );
        return { skipped: false, matched: false, triggered: false, viewportHash };
      }
    }

    // Skip sessions without tmux session
    if (!session.tmuxSessionId) {
      this.logger.debug({ watcherId, sessionId }, 'Session skipped: no tmuxSessionId');
      return { skipped: true, reason: 'no_tmux_session' };
    }

    // Capture viewport
    const viewport = await this.captureViewport(session.tmuxSessionId, watcher.viewportLines);

    if (!viewport) {
      this.logger.debug(
        { watcherId, sessionId, tmuxSessionId: session.tmuxSessionId },
        'Session skipped: empty viewport',
      );
      return { skipped: true, reason: 'empty_viewport' };
    }

    // Match condition
    const conditionMatched = this.matchCondition(watcher.condition, viewport);

    // Check trigger eligibility (handles cooldown + dedup)
    const { shouldTrigger, viewportHash } = this.checkTriggerEligibility(
      watcher,
      sessionId,
      viewport,
      conditionMatched,
    );

    if (shouldTrigger) {
      // Increment trigger count
      const triggerCount = this.incrementTriggerCount(watcherId, sessionId);

      this.logger.info(
        {
          watcherId,
          watcherName: watcher.name,
          sessionId,
          agentId: session.agentId,
          triggerCount,
          viewportHash,
        },
        'Watcher triggered',
      );

      // Trigger the event (placeholder - actual publishing in next task)
      await this.triggerEvent(watcher, session, viewport, viewportHash, triggerCount);

      return { skipped: false, matched: conditionMatched, triggered: true, viewportHash };
    }

    return { skipped: false, matched: conditionMatched, triggered: false, viewportHash };
  }

  /**
   * Trigger a watcher event by publishing to 'terminal.watcher.triggered'.
   *
   * Constructs the event payload with:
   * - Watcher identification (id, name, customEventName)
   * - Session context (sessionId, agentId, agentName, projectId)
   * - Viewport data (snippet of last 500 chars, hash)
   * - Match details (matched pattern)
   * - Trigger metadata (count, timestamp)
   *
   * @param watcher - The watcher configuration
   * @param session - The session that triggered
   * @param viewport - The captured viewport text
   * @param viewportHash - Hash of viewport for dedup tracking
   * @param triggerCount - How many times this watcher+session has triggered
   */
  async triggerEvent(
    watcher: Watcher,
    session: SessionDto,
    viewport: string,
    viewportHash: string,
    triggerCount: number,
  ): Promise<void> {
    // Look up agent name if agentId present
    const agent = session.agentId ? await this.storage.getAgent(session.agentId) : null;

    const payload = {
      watcherId: watcher.id,
      watcherName: watcher.name,
      customEventName: watcher.eventName,
      sessionId: session.id,
      agentId: session.agentId ?? null,
      agentName: agent?.name ?? null,
      projectId: watcher.projectId,
      viewportSnippet: viewport.slice(-500), // Last 500 chars
      viewportHash,
      matchedPattern: watcher.condition.pattern,
      triggerCount,
      triggeredAt: new Date().toISOString(),
    };

    await this.eventsService.publish('terminal.watcher.triggered', payload);

    this.logger.info(
      {
        watcherId: watcher.id,
        watcherName: watcher.name,
        customEventName: watcher.eventName,
        sessionId: session.id,
        agentId: session.agentId,
        triggerCount,
      },
      'Published watcher triggered event',
    );
  }

  /**
   * Get sessions matching the watcher's scope filter.
   * Filters active sessions by scope type:
   * - 'all': All active sessions for the project
   * - 'agent': Sessions where agentId matches scopeFilterId
   * - 'profile': Sessions where agent's profileId matches scopeFilterId
   * - 'provider': Sessions where agent's profile's providerId matches scopeFilterId
   *
   * Sessions without agentId are excluded from agent/profile/provider scopes.
   */
  async getMatchingSessions(watcher: Watcher): Promise<SessionDto[]> {
    const allSessions = await this.sessionsService.listActiveSessions(watcher.projectId);

    switch (watcher.scope) {
      case 'all':
        return allSessions;

      case 'agent':
        // Filter by exact agentId match
        return allSessions.filter(
          (session) => session.agentId && session.agentId === watcher.scopeFilterId,
        );

      case 'profile': {
        // Get agents for project and find those with matching profileId
        const agents = await this.storage.listAgents(watcher.projectId);
        const matchingAgentIds = new Set(
          agents.items
            .filter((agent) => agent.profileId === watcher.scopeFilterId)
            .map((agent) => agent.id),
        );

        // Filter sessions where agentId is in matching set
        return allSessions.filter(
          (session) => session.agentId && matchingAgentIds.has(session.agentId),
        );
      }

      case 'provider': {
        // Get agents for project
        const agents = await this.storage.listAgents(watcher.projectId);

        // Find agents whose config's providerId matches scopeFilterId
        // Falls back to profile.providerId for agents without providerConfigId
        const matchingAgentIds = new Set<string>();

        // Cache for config lookups (configId -> providerId)
        const configProviderCache = new Map<string, string>();
        // Cache for profile lookups (profileId -> providerId) - fallback
        // Undefined means profile has no legacy providerId
        const profileProviderCache = new Map<string, string | undefined>();

        for (const agent of agents.items) {
          let providerId: string | undefined;

          // Try to get providerId from config first (new path)
          if (agent.providerConfigId) {
            providerId = configProviderCache.get(agent.providerConfigId);

            if (providerId === undefined) {
              try {
                const config = await this.storage.getProfileProviderConfig(agent.providerConfigId);
                providerId = config.providerId;
                configProviderCache.set(agent.providerConfigId, providerId);
              } catch {
                // Config not found, fall back to profile
                this.logger.debug(
                  { agentId: agent.id, providerConfigId: agent.providerConfigId },
                  'Provider config not found, falling back to profile',
                );
              }
            }
          }

          // Fallback: get providerId from first profile config if no providerConfigId
          // Note: profile.providerId removed in Phase 4, configs are the only source
          if (providerId === undefined) {
            // Use has() to distinguish "not cached" from "cached as undefined"
            if (profileProviderCache.has(agent.profileId)) {
              providerId = profileProviderCache.get(agent.profileId);
            } else {
              try {
                const configs = await this.storage.listProfileProviderConfigsByProfile(
                  agent.profileId,
                );
                providerId = configs.length > 0 ? configs[0].providerId : undefined;
                profileProviderCache.set(agent.profileId, providerId);
              } catch {
                // Profile configs not found, skip this agent
                continue;
              }
            }
          }

          if (providerId === watcher.scopeFilterId) {
            matchingAgentIds.add(agent.id);
          }
        }

        // Filter sessions where agentId is in matching set
        return allSessions.filter(
          (session) => session.agentId && matchingAgentIds.has(session.agentId),
        );
      }

      default:
        // Unknown scope, return empty array
        this.logger.warn({ watcherId: watcher.id, scope: watcher.scope }, 'Unknown watcher scope');
        return [];
    }
  }

  /**
   * Capture viewport text from a tmux session with caching.
   *
   * 1. Checks cache for valid entry (within TTL)
   * 2. On cache miss/expired, calls tmuxService.capturePane()
   * 3. Stores result in cache
   * 4. Returns captured text (empty string on failure)
   *
   * @param tmuxSessionId - The tmux session name
   * @param lines - Number of lines to capture from viewport
   * @returns Captured text without ANSI codes, or empty string on failure
   */
  async captureViewport(tmuxSessionId: string, lines: number): Promise<string> {
    const key = `${tmuxSessionId}:${lines}`;

    // Check cache first
    const cached = this.captureCache.get(key);
    if (cached) {
      const age = Date.now() - cached.ts;
      if (age < CAPTURE_TTL_MS) {
        this.logger.debug(
          { tmuxSessionId, lines, cacheAge: age },
          'Cache hit for viewport capture',
        );
        return cached.text;
      }
      // Expired, remove stale entry
      this.captureCache.delete(key);
    }

    // Cache miss or expired - call tmux
    this.logger.debug({ tmuxSessionId, lines }, 'Cache miss, capturing viewport from tmux');

    try {
      // false = strip ANSI codes for clean text matching
      const text = await this.tmuxService.capturePane(tmuxSessionId, lines, false);

      // Store in cache
      this.captureCache.set(key, { text, ts: Date.now() });

      return text;
    } catch (error) {
      this.logger.warn({ tmuxSessionId, lines, error }, 'Failed to capture viewport from tmux');
      return '';
    }
  }

  /**
   * Get cached viewport capture without calling tmux.
   * Returns null if cache miss or expired.
   * Useful for checking cache state without triggering capture.
   */
  getCachedCapture(tmuxSessionId: string, lines: number): string | null {
    const key = `${tmuxSessionId}:${lines}`;
    const cached = this.captureCache.get(key);

    if (!cached) {
      return null;
    }

    const age = Date.now() - cached.ts;
    if (age > CAPTURE_TTL_MS) {
      this.captureCache.delete(key);
      return null;
    }

    return cached.text;
  }

  /**
   * Manually set cached viewport capture.
   * Useful for testing or pre-warming cache.
   */
  setCachedCapture(tmuxSessionId: string, lines: number, text: string): void {
    const key = `${tmuxSessionId}:${lines}`;
    this.captureCache.set(key, { text, ts: Date.now() });
  }

  /**
   * Clear all cached viewport captures.
   * Called during module destroy.
   */
  clearCaptureCache(): void {
    this.captureCache.clear();
  }

  /**
   * Match a trigger condition against viewport text.
   *
   * @param condition - The trigger condition to match
   * @param text - The viewport text to match against
   * @returns true if condition matches, false otherwise
   *
   * Supported condition types:
   * - 'contains': true if text includes pattern
   * - 'regex': true if pattern regex matches text (with optional flags)
   * - 'not_contains': true if text does NOT include pattern
   *
   * Error handling:
   * - Invalid regex patterns log error and return false
   * - Unknown condition types log warning and return false
   */
  matchCondition(condition: TriggerCondition, text: string): boolean {
    try {
      switch (condition.type) {
        case 'contains':
          return text.includes(condition.pattern);

        case 'regex': {
          const regex = new RegExp(condition.pattern, condition.flags || '');
          return regex.test(text);
        }

        case 'not_contains':
          return !text.includes(condition.pattern);

        default:
          // Unknown condition type
          this.logger.warn(
            { conditionType: (condition as { type: string }).type },
            'Unknown condition type in matchCondition',
          );
          return false;
      }
    } catch (error) {
      // Handle invalid regex or other errors
      this.logger.error(
        { condition, error: String(error) },
        'Error in matchCondition (likely invalid regex)',
      );
      return false;
    }
  }

  /**
   * Get the cooldown state for a watcher+session pair.
   */
  isOnCooldown(watcherId: string, sessionId: string): boolean {
    const key = `${watcherId}:${sessionId}`;
    const cooldownUntil = this.cooldowns.get(key);

    if (!cooldownUntil) {
      return false;
    }

    return Date.now() < cooldownUntil;
  }

  /**
   * Set the cooldown for a watcher+session pair.
   */
  setCooldown(watcherId: string, sessionId: string, durationMs: number): void {
    const key = `${watcherId}:${sessionId}`;
    this.cooldowns.set(key, Date.now() + durationMs);
  }

  /**
   * Clear the cooldown for a watcher+session pair (for until_clear mode).
   */
  clearCooldown(watcherId: string, sessionId: string): void {
    const key = `${watcherId}:${sessionId}`;
    this.cooldowns.delete(key);
  }

  /**
   * Compute a hash of viewport text for deduplication.
   * Uses SHA-256 truncated to 16 hex chars (64 bits).
   */
  computeViewportHash(viewport: string): string {
    return createHash('sha256').update(viewport).digest('hex').slice(0, 16);
  }

  /**
   * Check if a trigger should fire based on cooldown mode and deduplication.
   *
   * This method handles the complete trigger decision logic:
   * 1. Hash-based deduplication (skip if same viewport as last trigger)
   * 2. Cooldown check (time-based or until_clear)
   * 3. Transition detection for until_clear mode
   * 4. State updates when triggered
   *
   * @param watcher - The watcher configuration
   * @param sessionId - The session ID
   * @param viewport - The captured viewport text
   * @param conditionMatched - Whether the condition matched
   * @returns Object with shouldTrigger boolean and viewportHash
   */
  checkTriggerEligibility(
    watcher: Watcher,
    sessionId: string,
    viewport: string,
    conditionMatched: boolean,
  ): { shouldTrigger: boolean; viewportHash: string } {
    const watcherId = watcher.id;
    const viewportHash = this.computeViewportHash(viewport);
    const previousState = this.getLastConditionState(watcherId, sessionId);

    // Always update the condition state
    this.setLastConditionState(watcherId, sessionId, conditionMatched);

    if (conditionMatched) {
      // Cooldown check based on mode
      if (watcher.cooldownMode === 'time') {
        // Time-based cooldown
        if (this.isOnCooldown(watcherId, sessionId)) {
          this.logger.debug(
            { watcherId, sessionId },
            'Skipping trigger: time-based cooldown active',
          );
          return { shouldTrigger: false, viewportHash };
        }

        // Hash-based deduplication is only applied when cooldownMs=0 (no time throttle).
        // When cooldownMs>0, the cooldown already prevents spamming and we allow periodic
        // re-triggers even if the viewport content is unchanged.
        if (watcher.cooldownMs === 0) {
          const lastHash = this.getLastTriggeredHash(watcherId, sessionId);
          if (lastHash === viewportHash) {
            this.logger.debug(
              { watcherId, sessionId, viewportHash },
              'Skipping trigger: viewport unchanged (hash dedup)',
            );
            return { shouldTrigger: false, viewportHash };
          }
        }
      } else if (watcher.cooldownMode === 'until_clear') {
        // until_clear: only trigger on false -> true transition
        if (previousState === true) {
          this.logger.debug(
            { watcherId, sessionId },
            'Skipping trigger: until_clear mode, condition already true',
          );
          return { shouldTrigger: false, viewportHash };
        }
        // Also check if cooldown entry exists (condition was never cleared)
        if (this.cooldowns.has(`${watcherId}:${sessionId}`)) {
          this.logger.debug(
            { watcherId, sessionId },
            'Skipping trigger: until_clear mode, cooldown not cleared',
          );
          return { shouldTrigger: false, viewportHash };
        }
      }

      // All checks passed - should trigger
      // Set cooldown and hash
      this.setCooldown(watcherId, sessionId, watcher.cooldownMs);
      this.setLastTriggeredHash(watcherId, sessionId, viewportHash);

      this.logger.debug(
        { watcherId, sessionId, viewportHash, cooldownMode: watcher.cooldownMode },
        'Trigger approved',
      );
      return { shouldTrigger: true, viewportHash };
    } else {
      // Condition is false
      if (watcher.cooldownMode === 'until_clear') {
        // Clear the cooldown when condition becomes false
        this.clearCooldown(watcherId, sessionId);
        this.logger.debug(
          { watcherId, sessionId },
          'Cleared cooldown: condition no longer matches (until_clear mode)',
        );
      }
      return { shouldTrigger: false, viewportHash };
    }
  }

  /**
   * Get the last condition state (for until_clear mode).
   */
  getLastConditionState(watcherId: string, sessionId: string): boolean | undefined {
    const key = `${watcherId}:${sessionId}`;
    return this.lastConditionState.get(key);
  }

  /**
   * Set the last condition state.
   */
  setLastConditionState(watcherId: string, sessionId: string, matched: boolean): void {
    const key = `${watcherId}:${sessionId}`;
    this.lastConditionState.set(key, matched);
  }

  /**
   * Get the last triggered hash (for deduplication).
   */
  getLastTriggeredHash(watcherId: string, sessionId: string): string | undefined {
    const key = `${watcherId}:${sessionId}`;
    return this.lastTriggeredHash.get(key);
  }

  /**
   * Set the last triggered hash.
   */
  setLastTriggeredHash(watcherId: string, sessionId: string, hash: string): void {
    const key = `${watcherId}:${sessionId}`;
    this.lastTriggeredHash.set(key, hash);
  }

  /**
   * Get and increment the trigger count.
   */
  incrementTriggerCount(watcherId: string, sessionId: string): number {
    const key = `${watcherId}:${sessionId}`;
    const current = this.triggerCounts.get(key) ?? 0;
    const next = current + 1;
    this.triggerCounts.set(key, next);
    return next;
  }

  /**
   * Get the current trigger count.
   */
  getTriggerCount(watcherId: string, sessionId: string): number {
    const key = `${watcherId}:${sessionId}`;
    return this.triggerCounts.get(key) ?? 0;
  }

  /**
   * Check if a watcher is currently running.
   */
  isWatcherRunning(watcherId: string): boolean {
    return this.pollIntervals.has(watcherId);
  }

  /**
   * Get all running watcher IDs.
   */
  getRunningWatcherIds(): string[] {
    return [...this.pollIntervals.keys()];
  }

  /**
   * Test a watcher against current terminal viewports.
   * Applies optional idle gate first, then captures viewport and checks condition without
   * triggering events.
   * Used for testing/previewing watcher configuration.
   *
   * @param watcher - The watcher configuration to test
   * @returns Array of results per session with viewport preview and match status
   */
  async testWatcher(watcher: Watcher): Promise<
    Array<{
      sessionId: string;
      agentId: string | null;
      tmuxSessionId: string | null;
      viewport: string | null;
      viewportHash: string | null;
      conditionMatched: boolean;
    }>
  > {
    this.logger.debug({ watcherId: watcher.id, name: watcher.name }, 'Testing watcher');

    const sessions = await this.getMatchingSessions(watcher);
    const results: Array<{
      sessionId: string;
      agentId: string | null;
      tmuxSessionId: string | null;
      viewport: string | null;
      viewportHash: string | null;
      conditionMatched: boolean;
    }> = [];

    for (const session of sessions) {
      if (watcher.idleAfterSeconds > 0) {
        if (session.activityState !== 'idle') {
          const idleGateViewport = '[idle gate: session busy]';
          results.push({
            sessionId: session.id,
            agentId: session.agentId ?? null,
            tmuxSessionId: session.tmuxSessionId,
            viewport: idleGateViewport,
            viewportHash: this.computeViewportHash(idleGateViewport),
            conditionMatched: false,
          });
          continue;
        }

        if (!session.lastActivityAt) {
          const idleGateViewport = '[idle gate: no activity timestamp]';
          results.push({
            sessionId: session.id,
            agentId: session.agentId ?? null,
            tmuxSessionId: session.tmuxSessionId,
            viewport: idleGateViewport,
            viewportHash: this.computeViewportHash(idleGateViewport),
            conditionMatched: false,
          });
          continue;
        }

        const lastActivityTs = Date.parse(session.lastActivityAt);
        if (Number.isNaN(lastActivityTs)) {
          const idleGateViewport = '[idle gate: invalid activity timestamp]';
          results.push({
            sessionId: session.id,
            agentId: session.agentId ?? null,
            tmuxSessionId: session.tmuxSessionId,
            viewport: idleGateViewport,
            viewportHash: this.computeViewportHash(idleGateViewport),
            conditionMatched: false,
          });
          continue;
        }

        const idleDurationMs = Date.now() - lastActivityTs;
        if (idleDurationMs < watcher.idleAfterSeconds * 1000) {
          const idleGateViewport = '[idle gate: not enough idle time]';
          results.push({
            sessionId: session.id,
            agentId: session.agentId ?? null,
            tmuxSessionId: session.tmuxSessionId,
            viewport: idleGateViewport,
            viewportHash: this.computeViewportHash(idleGateViewport),
            conditionMatched: false,
          });
          continue;
        }
      }

      if (!session.tmuxSessionId) {
        results.push({
          sessionId: session.id,
          agentId: session.agentId ?? null,
          tmuxSessionId: null,
          viewport: null,
          viewportHash: null,
          conditionMatched: false,
        });
        continue;
      }

      try {
        const viewport = await this.captureViewport(session.tmuxSessionId, watcher.viewportLines);
        const viewportHash = viewport ? this.computeViewportHash(viewport) : null;
        const conditionMatched = viewport
          ? this.matchCondition(watcher.condition, viewport)
          : false;

        results.push({
          sessionId: session.id,
          agentId: session.agentId ?? null,
          tmuxSessionId: session.tmuxSessionId,
          viewport: viewport || null,
          viewportHash,
          conditionMatched,
        });
      } catch (error) {
        this.logger.warn(
          { watcherId: watcher.id, sessionId: session.id, error: String(error) },
          'Error testing session',
        );
        results.push({
          sessionId: session.id,
          agentId: session.agentId ?? null,
          tmuxSessionId: session.tmuxSessionId,
          viewport: null,
          viewportHash: null,
          conditionMatched: false,
        });
      }
    }

    this.logger.debug(
      { watcherId: watcher.id, sessionsChecked: results.length },
      'Watcher test completed',
    );

    return results;
  }
}
