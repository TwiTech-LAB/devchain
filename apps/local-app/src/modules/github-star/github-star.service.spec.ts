import { EventEmitter2 } from '@nestjs/event-emitter';
import type Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { createTestDatabase } from '../../common/test/test-database.helper';
import type { EpicUpdatedEventPayload } from '../events/catalog/epic.updated';
import type { EpicsService } from '../epics/services/epics.service';
import { SettingsService } from '../settings/services/settings.service';
import type { GithubStarState } from './github-star.dto';
import type { GithubStarCheckResult, GithubStarGh } from './github-star-gh.port';
import { GithubStarService } from './github-star.service';

// Layer: service unit over a real in-memory settings table. All rules live in one
// JSON row, so only the real row shows restart survival and the post-check re-read.

const DAY_MS = 24 * 60 * 60 * 1000;
const START = new Date('2026-01-01T00:00:00.000Z').getTime();

describe('GithubStarService', () => {
  let sqlite: Database.Database;
  let db: BetterSQLite3Database;
  let settings: SettingsService;
  let gh: jest.Mocked<GithubStarGh>;
  let epics: { getEpicById: jest.Mock; countSubEpicsByStatus: jest.Mock };
  let broadcaster: { broadcastEvent: jest.Mock };
  let onVm: boolean;
  let service: GithubStarService;

  function createService(): GithubStarService {
    return new GithubStarService(
      settings,
      epics as unknown as EpicsService,
      gh,
      broadcaster,
      () => onVm,
    );
  }

  beforeEach(() => {
    jest.useFakeTimers({ now: START, doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    ({ sqlite, db } = createTestDatabase());
    settings = new SettingsService(db, new EventEmitter2());
    gh = {
      isAlreadyStarred: jest.fn().mockResolvedValue('not-starred'),
      star: jest.fn().mockResolvedValue(true),
    };
    epics = {
      getEpicById: jest.fn().mockResolvedValue({ id: 'phase', tags: ['Phase:1'] }),
      countSubEpicsByStatus: jest.fn().mockResolvedValue({ done: 3 }),
    };
    broadcaster = { broadcastEvent: jest.fn() };
    onVm = false;
    service = createService();
  });

  afterEach(() => {
    sqlite.close();
    jest.useRealTimers();
  });

  async function seed(patch: Partial<GithubStarState>): Promise<void> {
    await settings.updateGithubStarState((state) => ({ ...state, ...patch }));
  }

  async function launch(times = 1): Promise<void> {
    for (let i = 0; i < times; i += 1) await service.handleSessionStarted();
  }

  function phaseDone(overrides: Partial<EpicUpdatedEventPayload> = {}): Promise<void> {
    return service.handleEpicUpdated({
      epicId: 'phase',
      projectId: 'project',
      parentId: null,
      version: 2,
      epicTitle: 'Phase 1',
      changes: { statusId: { previous: 's1', current: 's2', currentName: ' Done ' } },
      ...overrides,
    });
  }

  function pendingId(): string {
    const pending = service.getState().pending;
    if (!pending) throw new Error('expected a pending prompt');
    return pending.id;
  }

  describe('launch trigger', () => {
    it('opens one prompt at the 50th launch', async () => {
      await launch(49);
      expect(service.getState().pending).toBeNull();

      await launch();
      const id = pendingId();
      expect(service.getState().pending).toEqual({
        id,
        reason: 'launches',
        mode: 'gh',
        url: 'https://github.com/TwiTech-LAB/devchain',
      });
      expect(broadcaster.broadcastEvent).toHaveBeenCalledWith('system', 'github_star_changed', {});

      await launch(5);
      expect(pendingId()).toBe(id);
      expect(gh.isAlreadyStarred).toHaveBeenCalledTimes(1);
    });

    it('needs 100 new launches and 3 days after Later', async () => {
      await seed({ launches: 49 });
      await launch();
      await service.applyAction(pendingId(), 'later');

      await launch(100);
      expect(service.getState().pending).toBeNull();

      jest.setSystemTime(START + 3 * DAY_MS);
      await launch();
      expect(service.getState().pending?.reason).toBe('launches');
    });

    it('opens no prompt before 100 new launches even after the cooldown', async () => {
      await seed({ launches: 49 });
      await launch();
      await service.applyAction(pendingId(), 'later');

      jest.setSystemTime(START + 4 * DAY_MS);
      await launch(99);
      expect(service.getState().pending).toBeNull();
      await launch();
      expect(service.getState().pending).not.toBeNull();
    });

    it('opens one prompt when two launches cross the threshold during a slow check', async () => {
      await seed({ launches: 49 });
      await Promise.all([service.handleSessionStarted(), service.handleSessionStarted()]);

      expect(gh.isAlreadyStarred).toHaveBeenCalledTimes(2);
      expect(service.getState().pending).not.toBeNull();
      expect(broadcaster.broadcastEvent).toHaveBeenCalledTimes(1);
    });

    it.each<[string, () => void, 'gh' | 'web']>([
      ['not starred', () => gh.isAlreadyStarred.mockResolvedValue('not-starred'), 'gh'],
      ['unknown', () => gh.isAlreadyStarred.mockResolvedValue('unknown'), 'web'],
      ['a failing check', () => gh.isAlreadyStarred.mockRejectedValue(new Error('boom')), 'web'],
    ])('opens the prompt in the mode for %s', async (_name, arrange, mode) => {
      arrange();
      await seed({ launches: 49 });
      await launch();
      expect(service.getState().pending?.mode).toBe(mode);
    });

    it('stops all prompts when the check finds the repo already starred', async () => {
      gh.isAlreadyStarred.mockResolvedValue('starred' satisfies GithubStarCheckResult);
      await seed({ launches: 49 });
      await launch();
      await phaseDone();

      expect(service.getState().pending).toBeNull();
      expect(settings.getGithubStarState()).toMatchObject({ status: 'starred', launches: 50 });
      expect(gh.isAlreadyStarred).toHaveBeenCalledTimes(1);
    });
  });

  describe('Phase done trigger', () => {
    it('opens one prompt once per install', async () => {
      await phaseDone();
      const id = pendingId();
      expect(service.getState().pending?.reason).toBe('phase-done');

      await service.applyAction(id, 'later');
      jest.setSystemTime(START + 10 * DAY_MS);
      await phaseDone();
      expect(service.getState().pending).toBeNull();
    });

    it.each<[string, () => Promise<void>]>([
      ['a sub-epic', () => phaseDone({ parentId: 'parent' })],
      [
        'a status other than done',
        () =>
          phaseDone({
            changes: { statusId: { previous: 'a', current: 'b', currentName: 'Review' } },
          }),
      ],
      [
        'a status change without a name',
        () => phaseDone({ changes: { statusId: { previous: 'a', current: 'b' } } }),
      ],
      [
        'an epic without sub-epics',
        () => {
          epics.countSubEpicsByStatus.mockResolvedValueOnce({});
          return phaseDone();
        },
      ],
      [
        'a Backlog-tagged epic',
        () => {
          epics.getEpicById.mockResolvedValueOnce({ id: 'phase', tags: ['Backlog'] });
          return phaseDone();
        },
      ],
    ])('ignores %s and keeps the moment', async (_name, act) => {
      await act();
      expect(service.getState().pending).toBeNull();

      await phaseDone();
      expect(service.getState().pending?.reason).toBe('phase-done');
    });

    it.each<[string, Partial<GithubStarState>]>([
      ['in cooldown', { cooldownUntil: new Date(START + DAY_MS).toISOString() }],
      ['with an open prompt', { pending: { id: 'open', reason: 'launches', mode: 'web' } }],
    ])('consumes the moment without a prompt when %s', async (_name, patch) => {
      await seed(patch);
      await phaseDone();

      expect(settings.getGithubStarState()).toMatchObject({ phaseDoneUsed: true, ...patch });
      expect(gh.isAlreadyStarred).not.toHaveBeenCalled();
    });
  });

  describe('actions', () => {
    beforeEach(async () => {
      await seed({ launches: 49 });
      await launch();
      broadcaster.broadcastEvent.mockClear();
    });

    it('ignores an action for a prompt that is no longer pending', async () => {
      const id = pendingId();
      const before = settings.getGithubStarState();

      await expect(service.applyAction('stale', 'later')).resolves.toEqual(service.getState());
      await expect(service.applyAction('stale', 'star')).resolves.toEqual(service.getState());
      expect(settings.getGithubStarState()).toEqual(before);
      expect(gh.star).not.toHaveBeenCalled();

      await service.applyAction(id, 'later');
      await service.applyAction(id, 'later');
      expect(settings.getGithubStarState().threshold).toBe(100);
    });

    it.each(['never', 'opened'] as const)('%s stops all prompts', async (action) => {
      await service.applyAction(pendingId(), action);
      jest.setSystemTime(START + 30 * DAY_MS);
      await seed({ launches: 1000 });
      await launch();
      await phaseDone();

      expect(settings.getGithubStarState()).toMatchObject({ status: 'dismissed', pending: null });
      expect(broadcaster.broadcastEvent).toHaveBeenCalledTimes(1);
    });

    it('stars through gh and stops all prompts', async () => {
      await expect(service.applyAction(pendingId(), 'star')).resolves.toEqual({
        pending: null,
        result: 'starred',
      });
      await seed({ launches: 1000 });
      await launch();

      expect(settings.getGithubStarState()).toMatchObject({ status: 'starred', pending: null });
    });

    it('keeps the prompt in web mode when gh cannot star', async () => {
      gh.star.mockResolvedValue(false);
      const id = pendingId();

      const response = await service.applyAction(id, 'star');

      expect(response).toEqual({
        pending: expect.objectContaining({ id, mode: 'web' }),
        result: 'fallback',
        url: 'https://github.com/TwiTech-LAB/devchain',
      });
      expect(broadcaster.broadcastEvent).toHaveBeenCalledTimes(1);

      await service.applyAction(id, 'star');
      expect(gh.star).toHaveBeenCalledTimes(1);
    });

    const NEXT_PROMPT = { id: 'next', reason: 'phase-done', mode: 'web' } as const;
    it.each<[string, boolean, (id: string) => Promise<unknown>, Partial<GithubStarState>]>([
      ['succeeds after Later', true, (id) => service.applyAction(id, 'later'), { threshold: 100 }],
      [
        'fails after Don’t ask again',
        false,
        (id) => service.applyAction(id, 'never'),
        {
          status: 'dismissed',
        },
      ],
      [
        'succeeds after a new prompt replaced it',
        true,
        async (id) => {
          await service.applyAction(id, 'later');
          await seed({ pending: NEXT_PROMPT });
        },
        { status: 'active', pending: NEXT_PROMPT },
      ],
    ])('keeps the other tab decision when gh %s', async (_name, ok, otherTab, expected) => {
      let settle!: (value: boolean) => void;
      gh.star.mockReturnValue(new Promise<boolean>((resolve) => (settle = resolve)));
      const id = pendingId();

      const starring = service.applyAction(id, 'star');
      expect(gh.star).toHaveBeenCalledTimes(1);
      await otherTab(id);
      const decided = settings.getGithubStarState();
      settle(ok);

      await expect(starring).resolves.toEqual(service.getState());
      expect(settings.getGithubStarState()).toEqual(decided);
      expect(decided).toMatchObject({ pending: null, ...expected });
      expect(broadcaster.broadcastEvent).toHaveBeenCalledTimes(1);
    });
  });

  it('keeps the pending prompt and the cooldown across a restart', async () => {
    await seed({ launches: 49 });
    await launch();
    const id = pendingId();

    const restart = () => {
      settings = new SettingsService(db, new EventEmitter2());
      service = createService();
    };
    restart();
    expect(pendingId()).toBe(id);

    await service.applyAction(id, 'later');
    restart();
    await seed({ launches: 500 });
    await launch();
    expect(service.getState().pending).toBeNull();
    expect(settings.getGithubStarState().cooldownUntil).toBe(
      new Date(START + 3 * DAY_MS).toISOString(),
    );
  });

  it('does nothing on a claimed VM host', async () => {
    await seed({ launches: 49 });
    onVm = true;

    await launch(5);
    await phaseDone();

    expect(settings.getGithubStarState()).toMatchObject({ launches: 49, phaseDoneUsed: false });
    expect(epics.getEpicById).not.toHaveBeenCalled();
    expect(service.getState()).toEqual({ pending: null });

    await seed({ pending: { id: 'p', reason: 'launches', mode: 'gh' } });
    await expect(service.applyAction('p', 'never')).resolves.toEqual({ pending: null });
    expect(settings.getGithubStarState().status).toBe('active');
  });

  it('reads an invalid stored row as the default state', async () => {
    sqlite
      .prepare(
        `INSERT INTO settings (id, key, value, created_at, updated_at)
         VALUES ('row', 'githubStar.state', '{"status":"bogus"}', 'now', 'now')`,
      )
      .run();

    await launch();
    expect(settings.getGithubStarState()).toMatchObject({ status: 'active', launches: 1 });
  });
});
