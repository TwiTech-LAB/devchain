jest.mock('node-pty', () => ({
  spawn: jest.fn(),
}));

import { PtyService } from './pty.service';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ptyMod = require('node-pty') as { spawn: jest.Mock };

import type { TerminalActivityService } from './terminal-activity.service';
import type { SettingsService } from '../../settings/services/settings.service';
import type { SessionTerminalRuntimeService } from '../../session-terminal-runtime/session-terminal-runtime.service';

const makePtyProcess = () => ({
  onData: jest.fn().mockImplementation(() => {}),
  onExit: jest.fn().mockImplementation(() => {}),
  resize: jest.fn(),
  write: jest.fn(),
  kill: jest.fn(),
});

const createService = (opts?: {
  usesAlternateScreen?: boolean;
  needsLfNormalize?: boolean;
  registerOutputHandler?: boolean;
}) => {
  const outputHandler = jest.fn();

  const terminalActivity = {
    watchSession: jest.fn(),
    updateSuppression: jest.fn(),
    clearSession: jest.fn(),
  } as unknown as TerminalActivityService;

  const settingsService = {
    getSetting: jest.fn().mockReturnValue(undefined),
  } as unknown as SettingsService;

  const sessionTerminalRuntime = {
    getDescriptor: jest.fn().mockImplementation((sessionId: string) => ({
      sessionId,
      tmuxSessionName: `tmux_${sessionId}`,
      normalizeLf: opts?.needsLfNormalize ?? true,
      usesAlternateScreen: opts?.usesAlternateScreen ?? false,
    })),
  } as unknown as SessionTerminalRuntimeService;

  const mockMetricsService = {
    registerCacheStatsProvider: jest.fn(),
    registerStatsProvider: jest.fn(),
  } as never;

  const service = new PtyService(
    terminalActivity,
    settingsService,
    sessionTerminalRuntime,
    mockMetricsService,
  );
  if (opts?.registerOutputHandler !== false) {
    service.setOutputHandler(outputHandler);
  }

  return { service, outputHandler, terminalActivity, sessionTerminalRuntime };
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

  it('rejects missing output configuration before spawning a PTY', async () => {
    const { service } = createService({ registerOutputHandler: false });

    await expect(service.startStreaming('sid-unconfigured', 'tmux-unconfigured')).rejects.toThrow(
      'PTY output handler is not registered',
    );
    expect(ptyMod.spawn).not.toHaveBeenCalled();
  });

  it('rejects a second output handler registration', () => {
    const { service } = createService();

    expect(() => service.setOutputHandler(jest.fn())).toThrow(
      'PTY output handler is already registered',
    );
  });

  it('delivers processed frames synchronously and in source order', async () => {
    const { service, outputHandler } = createService({ needsLfNormalize: false });
    const observed: string[] = [];
    outputHandler.mockImplementation((_sessionId: string, data: string) => {
      observed.push(`handler:${data}`);
    });
    await service.startStreaming('sid-order', 'tmux-order');

    const ptyProc = ptyMod.spawn.mock.results[0].value;
    const onData = ptyProc.onData.mock.calls[0][0] as (data: string) => void;
    onData('first');
    observed.push('after:first');
    onData('second');
    observed.push('after:second');

    expect(observed).toEqual(['handler:first', 'after:first', 'handler:second', 'after:second']);
  });

  it.each([
    { options: undefined, expected: { cols: 80, rows: 24 } },
    { options: { cols: 0, rows: 40 }, expected: { cols: 80, rows: 40 } },
    { options: { cols: 120, rows: 0 }, expected: { cols: 120, rows: 24 } },
  ])('defaults PTY dimensions for $options', async ({ options, expected }) => {
    const { service } = createService();
    await service.startStreaming('dims-session', 'tmux-dims', options);
    expect(ptyMod.spawn).toHaveBeenCalledWith(
      'tmux',
      expect.any(Array),
      expect.objectContaining(expected),
    );
  });

  it('is idempotent — second call for same sessionId is a no-op', async () => {
    const { service } = createService();

    await service.startStreaming('sid-idem', 'tmux-idem', { cols: 100, rows: 30 });
    await service.startStreaming('sid-idem', 'tmux-idem', { cols: 200, rows: 50 });

    expect(ptyMod.spawn).toHaveBeenCalledTimes(1);
  });

  it('resolves both output-path policies once per stream', async () => {
    const { service, sessionTerminalRuntime } = createService({
      needsLfNormalize: false,
      usesAlternateScreen: true,
    });

    await service.startStreaming('sid-policy', 'tmux-policy');

    expect(sessionTerminalRuntime.getDescriptor).toHaveBeenCalledTimes(1);
    expect(sessionTerminalRuntime.getDescriptor).toHaveBeenCalledWith('sid-policy');
  });
});

describe('PtyService alt-screen strip gate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    ptyMod.spawn.mockReturnValue(makePtyProcess());
  });

  // A combined alt-screen + mouse-tracking enable, exactly what a full-screen TUI emits.
  const COMBINED_DECSET = '\x1b[?1049;1000h';

  it('skips the strip for TUI providers — preserves combined ?1049;1000h (mouse-tracking survives)', async () => {
    const { service, outputHandler } = createService({ usesAlternateScreen: true });
    await service.startStreaming('tui-sid', 'tmux-tui');

    const ptyProc = ptyMod.spawn.mock.results[0].value;
    const onData = ptyProc.onData.mock.calls[0][0] as (d: string) => void;
    onData(COMBINED_DECSET);

    expect(outputHandler).toHaveBeenCalledWith('tui-sid', COMBINED_DECSET);
  });

  it('strips the alt-screen DECSET for non-TUI providers (default — scrollback preserved)', async () => {
    const { service, outputHandler } = createService({ usesAlternateScreen: false });
    await service.startStreaming('cli-sid', 'tmux-cli');

    const ptyProc = ptyMod.spawn.mock.results[0].value;
    const onData = ptyProc.onData.mock.calls[0][0] as (d: string) => void;
    onData(COMBINED_DECSET);

    // The whole DECSET is removed when it contains an alt-screen code.
    expect(outputHandler).toHaveBeenCalledWith('cli-sid', '');
  });
});

// mouseTrackingMode survival — the user-reported symptom: wheel events scroll
// our scrollback instead of the OpenCode TUI because xterm's mouseTrackingMode
// stays 'none' when the `?1000h` (mouse-tracking enable) is lost.
//
// On BOTH restoration paths (seeded reconnect + no-seed reconnect) the TUI
// repaints via triggerRedraw and re-emits a combined `ESC[?1049;1000h`. The PTY
// strip gate is path-independent (one onData handler), so these tests lock the
// survival for both paths at the cheapest layer. The redraw gating itself is
// covered in terminal.gateway.spec.ts (Task 2); the client wheel-forwarding
// logic is covered in useXterm.spec.ts.
describe('PtyService — OpenCode mouseTrackingMode survival (user-reported symptom)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    ptyMod.spawn.mockReturnValue(makePtyProcess());
  });

  it('preserves a standalone ?1000h mouse enable for BOTH provider types (no alt-screen code to strip)', async () => {
    // ?1000h alone contains no 47/1047/1049, so the sanitizer leaves it intact
    // regardless of provider policy — defensive assertion that the strip only
    // fires on alt-screen codes.
    const tui = createService({ usesAlternateScreen: true });
    await tui.service.startStreaming('tui-standalone', 'tmux-tui-standalone');
    let ptyProc = ptyMod.spawn.mock.results[0].value;
    let onData = ptyProc.onData.mock.calls[0][0] as (d: string) => void;
    onData('\x1b[?1000h');
    expect(tui.outputHandler).toHaveBeenLastCalledWith('tui-standalone', '\x1b[?1000h');

    jest.clearAllMocks();
    const cli = createService({ usesAlternateScreen: false });
    await cli.service.startStreaming('cli-standalone', 'tmux-cli-standalone');
    ptyProc = ptyMod.spawn.mock.results[0].value;
    onData = ptyProc.onData.mock.calls[0][0] as (d: string) => void;
    onData('\x1b[?1000h');
    expect(cli.outputHandler).toHaveBeenLastCalledWith('cli-standalone', '\x1b[?1000h');
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
