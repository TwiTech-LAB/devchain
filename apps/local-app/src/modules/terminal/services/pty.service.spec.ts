jest.mock('node-pty', () => ({
  spawn: jest.fn(),
}));

import { PtyService } from './pty.service';
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const ptyMod = require('node-pty') as { spawn: jest.Mock };

import type { TerminalGateway } from '../gateways/terminal.gateway';
import type { TerminalActivityService } from './terminal-activity.service';
import type { TerminalIOService } from './terminal-io/terminal-io.service';
import type { SettingsService } from '../../settings/services/settings.service';
import type { SessionsService } from '../../sessions/services/sessions.service';

const makePtyProcess = () => ({
  onData: jest.fn().mockImplementation(() => {}),
  onExit: jest.fn().mockImplementation(() => {}),
  resize: jest.fn(),
  write: jest.fn(),
  kill: jest.fn(),
});

const createService = () => {
  const terminalGateway = {
    broadcastTerminalData: jest.fn(),
  } as unknown as TerminalGateway;

  const terminalActivity = {
    watchSession: jest.fn(),
    updateSuppression: jest.fn(),
    clearSession: jest.fn(),
  } as unknown as TerminalActivityService;

  const terminalIO = {} as unknown as TerminalIOService;

  const settingsService = {
    getSetting: jest.fn().mockReturnValue(undefined),
  } as unknown as SettingsService;

  const sessionsService = {
    shouldNormalizeLfFor: jest.fn().mockReturnValue(true),
  } as unknown as SessionsService;

  const service = new PtyService(
    terminalGateway,
    terminalActivity,
    terminalIO,
    settingsService,
    sessionsService,
  );

  return { service, terminalGateway, terminalActivity };
};

const makePtyProcessWithDims = (cols: number, rows: number) =>
  Object.assign(makePtyProcess(), { cols, rows });

describe('PtyService.startStreaming', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    ptyMod.spawn.mockReturnValue(makePtyProcess());
  });

  it('spawns PTY with client dimensions when provided', async () => {
    const { service } = createService();

    await service.startStreaming('sid-spawn', 'tmux-spawn', { cols: 120, rows: 40 });

    expect(ptyMod.spawn).toHaveBeenCalledWith(
      'tmux',
      ['attach-session', '-t', '=tmux-spawn'],
      expect.objectContaining({ cols: 120, rows: 40 }),
    );
  });

  it('falls back to 80x24 when no options provided', async () => {
    const { service } = createService();

    await service.startStreaming('sid-default', 'tmux-default');

    expect(ptyMod.spawn).toHaveBeenCalledWith(
      'tmux',
      expect.any(Array),
      expect.objectContaining({ cols: 80, rows: 24 }),
    );
  });

  it('falls back to 80 cols when cols is 0', async () => {
    const { service } = createService();

    await service.startStreaming('sid-zero-cols', 'tmux-zero', { cols: 0, rows: 40 });

    expect(ptyMod.spawn).toHaveBeenCalledWith(
      'tmux',
      expect.any(Array),
      expect.objectContaining({ cols: 80, rows: 40 }),
    );
  });

  it('falls back to 24 rows when rows is 0', async () => {
    const { service } = createService();

    await service.startStreaming('sid-zero-rows', 'tmux-zero', { cols: 120, rows: 0 });

    expect(ptyMod.spawn).toHaveBeenCalledWith(
      'tmux',
      expect.any(Array),
      expect.objectContaining({ cols: 120, rows: 24 }),
    );
  });

  it('is idempotent — second call for same sessionId is a no-op', async () => {
    const { service } = createService();

    await service.startStreaming('sid-idem', 'tmux-idem', { cols: 100, rows: 30 });
    await service.startStreaming('sid-idem', 'tmux-idem', { cols: 200, rows: 50 });

    expect(ptyMod.spawn).toHaveBeenCalledTimes(1);
  });
});

describe('PtyService.triggerRedraw', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    ptyMod.spawn.mockReturnValue(makePtyProcess());
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('is a no-op when no active session exists', async () => {
    const { service } = createService();
    await expect(service.triggerRedraw('nonexistent')).resolves.toBeUndefined();
  });

  it('skips jiggle when pty dimensions are unavailable', async () => {
    const { service } = createService();
    // makePtyProcess() has no cols/rows — dimensions are undefined
    await service.startStreaming('no-dims', 'tmux-no-dims');

    const jigglePromise = service.triggerRedraw('no-dims');
    jest.runAllTimers();
    await jigglePromise;

    const pty = ptyMod.spawn.mock.results[0].value;
    expect(pty.resize).not.toHaveBeenCalled();
  });

  it('performs shrink-then-restore resize jiggle and updates activity suppression', async () => {
    const { service, terminalActivity } = createService();
    ptyMod.spawn.mockReturnValue(makePtyProcessWithDims(120, 40));

    await service.startStreaming('jiggle-sid', 'jiggle-tmux', { cols: 120, rows: 40 });

    const jigglePromise = service.triggerRedraw('jiggle-sid');

    const pty = ptyMod.spawn.mock.results[0].value;
    // First resize fires synchronously before the await
    expect(pty.resize).toHaveBeenCalledWith(120, 39);

    jest.runAllTimers();
    await jigglePromise;

    expect(pty.resize).toHaveBeenCalledWith(120, 40);
    expect(terminalActivity.updateSuppression).toHaveBeenCalled();
  });

  it('does not throw when pty resize fails (non-fatal)', async () => {
    const { service } = createService();
    const ptyWithError = makePtyProcessWithDims(80, 24);
    (ptyWithError.resize as jest.Mock).mockImplementation(() => {
      throw new Error('SIGWINCH failed');
    });
    ptyMod.spawn.mockReturnValue(ptyWithError);

    await service.startStreaming('fail-sid', 'fail-tmux', { cols: 80, rows: 24 });

    await expect(service.triggerRedraw('fail-sid')).resolves.toBeUndefined();
  });
});
