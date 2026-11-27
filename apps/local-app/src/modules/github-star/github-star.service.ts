import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { createLogger } from '../../common/logging/logger';
import { OnCatalogEvent } from '../events/catalog/on-catalog-event';
import type { EpicUpdatedEventPayload } from '../events/catalog/epic.updated';
import { EpicsService } from '../epics/services/epics.service';
import {
  REALTIME_BROADCASTER,
  type RealtimeBroadcaster,
} from '../realtime/ports/realtime-broadcaster.port';
import { SettingsService } from '../settings/services/settings.service';
import {
  GITHUB_STAR_CHANGED_EVENT,
  GITHUB_STAR_REPO_URL,
  type GithubStarAction,
  type GithubStarActionResponse,
  type GithubStarReason,
  type GithubStarState,
  type GithubStarStateResponse,
} from './github-star.dto';
import {
  GITHUB_STAR_GH,
  type GithubStarCheckResult,
  type GithubStarGh,
} from './github-star-gh.port';

const logger = createLogger('GithubStarService');

export const GITHUB_STAR_ON_VM = Symbol('GITHUB_STAR_ON_VM');

const LATER_COOLDOWN_MS = 3 * 24 * 60 * 60 * 1000;

function isEligible(state: GithubStarState, nowMs: number): boolean {
  return (
    state.status === 'active' &&
    state.pending === null &&
    (state.cooldownUntil === null || Date.parse(state.cooldownUntil) <= nowMs)
  );
}

function toResponse(state: GithubStarState): GithubStarStateResponse {
  return { pending: state.pending ? { ...state.pending, url: GITHUB_STAR_REPO_URL } : null };
}

/**
 * Asks the user to star the DevChain repo after a Phase epic is done or after
 * enough agent launches. Inactive on a claimed VM host: the home instance owns
 * the prompt.
 */
@Injectable()
export class GithubStarService {
  constructor(
    private readonly settings: SettingsService,
    private readonly epics: EpicsService,
    @Inject(GITHUB_STAR_GH) private readonly gh: GithubStarGh,
    @Inject(REALTIME_BROADCASTER) private readonly broadcaster: RealtimeBroadcaster,
    @Inject(GITHUB_STAR_ON_VM) private readonly onVm: () => boolean,
  ) {}

  getState(): GithubStarStateResponse {
    if (this.onVm()) return { pending: null };
    return toResponse(this.settings.getGithubStarState());
  }

  @OnCatalogEvent('session.started', { async: true })
  async handleSessionStarted(): Promise<void> {
    try {
      if (this.onVm()) return;
      // Launches counted while a prompt is open are discarded: Later resets them to 0.
      const isCounting = (state: GithubStarState) =>
        state.status === 'active' && state.pending === null;
      if (!isCounting(this.settings.getGithubStarState())) return;
      let reached = false;
      await this.settings.updateGithubStarState((state) => {
        if (!isCounting(state)) return state;
        const next = { ...state, launches: state.launches + 1 };
        reached = isEligible(next, Date.now()) && next.launches >= next.threshold;
        return next;
      });
      if (reached) await this.openPrompt('launches');
    } catch (error) {
      logger.error({ error }, 'Failed to count agent launch for the star prompt');
    }
  }

  @OnCatalogEvent('epic.updated', { async: true })
  async handleEpicUpdated(payload: EpicUpdatedEventPayload): Promise<void> {
    try {
      if (payload.parentId !== null) return;
      if (payload.changes.statusId?.currentName?.trim().toLowerCase() !== 'done') return;
      if (this.onVm()) return;
      if (this.settings.getGithubStarState().phaseDoneUsed) return;
      if (!(await this.isPhaseEpic(payload.epicId))) return;

      let eligible = false;
      await this.settings.updateGithubStarState((state) => {
        if (state.phaseDoneUsed) return state;
        eligible = isEligible(state, Date.now());
        return { ...state, phaseDoneUsed: true };
      });
      if (eligible) await this.openPrompt('phase-done');
    } catch (error) {
      logger.error(
        { error, epicId: payload.epicId },
        'Failed to handle Phase done for the star prompt',
      );
    }
  }

  async applyAction(promptId: string, action: GithubStarAction): Promise<GithubStarActionResponse> {
    if (this.onVm()) return { pending: null };
    const current = this.settings.getGithubStarState();
    if (current.pending?.id !== promptId) return toResponse(current);

    if (action === 'star') return this.star(promptId, current);

    const next = await this.update((state) => {
      if (state.pending?.id !== promptId) return state;
      if (action === 'later') {
        return {
          ...state,
          launches: 0,
          threshold: state.threshold * 2,
          cooldownUntil: new Date(Date.now() + LATER_COOLDOWN_MS).toISOString(),
          pending: null,
        };
      }
      return { ...state, status: 'dismissed', pending: null };
    });
    return toResponse(next);
  }

  private async star(
    promptId: string,
    current: GithubStarState,
  ): Promise<GithubStarActionResponse> {
    if (current.pending?.mode !== 'gh') {
      return { ...toResponse(current), result: 'fallback', url: GITHUB_STAR_REPO_URL };
    }

    const starred = await this.gh.star().catch((error: unknown) => {
      logger.warn({ error }, 'gh star failed');
      return false;
    });

    // A decision another tab made while gh ran wins, even over a successful star.
    let stillPending = false;
    const next = await this.update((state) => {
      if (state.pending?.id !== promptId) return state;
      stillPending = true;
      if (starred) return { ...state, status: 'starred', pending: null };
      if (state.pending.mode === 'web') return state;
      return { ...state, pending: { ...state.pending, mode: 'web' } };
    });
    if (!stillPending) return toResponse(next);
    return starred
      ? { ...toResponse(next), result: 'starred' }
      : { ...toResponse(next), result: 'fallback', url: GITHUB_STAR_REPO_URL };
  }

  /**
   * Runs the gh check outside any transaction, then re-checks eligibility on
   * a fresh read: another trigger or tab may have changed the state meanwhile.
   */
  private async openPrompt(reason: GithubStarReason): Promise<void> {
    const check = await this.gh
      .isAlreadyStarred()
      .catch((error: unknown): GithubStarCheckResult => {
        logger.warn({ error }, 'gh star check failed');
        return 'unknown';
      });
    await this.update((state) => {
      if (!isEligible(state, Date.now())) return state;
      if (reason === 'launches' && state.launches < state.threshold) return state;
      if (check === 'starred') return { ...state, status: 'starred' };
      return {
        ...state,
        pending: { id: randomUUID(), reason, mode: check === 'not-starred' ? 'gh' : 'web' },
      };
    });
  }

  private async isPhaseEpic(epicId: string): Promise<boolean> {
    const epic = await this.epics.getEpicById(epicId);
    if (epic.tags.some((tag) => tag.trim().toLowerCase() === 'backlog')) return false;
    const counts = await this.epics.countSubEpicsByStatus(epicId);
    return Object.values(counts).some((count) => count > 0);
  }

  /** Writes the state and, when it changed, tells clients to reload it. */
  private async update(
    mutate: (state: GithubStarState) => GithubStarState,
  ): Promise<GithubStarState> {
    let changed = false;
    const next = await this.settings.updateGithubStarState((state) => {
      const result = mutate(state);
      changed = result !== state;
      return result;
    });
    if (changed) {
      try {
        this.broadcaster.broadcastEvent('system', GITHUB_STAR_CHANGED_EVENT, {});
      } catch (error) {
        logger.warn({ error }, 'Failed to broadcast github_star_changed');
      }
    }
    return next;
  }
}
