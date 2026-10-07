import { TranscriptWatcherRehydrator } from './transcript-watcher-rehydrator.service';
import type { SessionsService } from '../../sessions/services/sessions.service';
import type { TranscriptWatcherService } from './transcript-watcher.service';

type RunningTranscriptSession = ReturnType<
  SessionsService['listRunningTranscriptSessions']
>[number];

function setup(running: RunningTranscriptSession[], startWatching = jest.fn()) {
  const sessions = {
    listRunningTranscriptSessions: jest.fn().mockReturnValue(running),
  } as unknown as SessionsService;
  const watcher = { startWatching } as unknown as TranscriptWatcherService;
  const rehydrator = new TranscriptWatcherRehydrator(sessions, watcher);
  return { rehydrator, sessions, startWatching };
}

describe('TranscriptWatcherRehydrator', () => {
  it('re-attaches a watcher for each running session with the persisted fields', async () => {
    const startWatching = jest.fn().mockResolvedValue(undefined);
    const { rehydrator } = setup(
      [
        {
          sessionId: 's1',
          transcriptPath: '/t/s1.jsonl',
          providerName: 'claude',
          providerSessionId: null,
        },
        {
          sessionId: 's2',
          transcriptPath: '/t/s2.db',
          providerName: 'opencode',
          providerSessionId: 'ses_2',
        },
      ],
      startWatching,
    );

    await rehydrator.onApplicationBootstrap();

    expect(startWatching).toHaveBeenCalledTimes(2);
    // null providerSessionId is passed through as undefined (file source)
    expect(startWatching).toHaveBeenCalledWith('s1', '/t/s1.jsonl', 'claude', undefined);
    // DB source carries its providerSessionId
    expect(startWatching).toHaveBeenCalledWith('s2', '/t/s2.db', 'opencode', 'ses_2');
  });

  it('keeps rehydrating remaining sessions when one fails', async () => {
    const startWatching = jest
      .fn()
      .mockRejectedValueOnce(new Error('cannot stat transcript'))
      .mockResolvedValue(undefined);
    const { rehydrator } = setup(
      [
        {
          sessionId: 's1',
          transcriptPath: '/t/s1',
          providerName: 'claude',
          providerSessionId: null,
        },
        {
          sessionId: 's2',
          transcriptPath: '/t/s2',
          providerName: 'claude',
          providerSessionId: null,
        },
      ],
      startWatching,
    );

    await expect(rehydrator.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(startWatching).toHaveBeenCalledTimes(2);
  });
});
