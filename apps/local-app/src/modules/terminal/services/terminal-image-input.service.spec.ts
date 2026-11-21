import type { FormSendInput } from '../dtos/ws-envelope.dto';
import { randomUUID } from 'node:crypto';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { ProcessExecutorOptions } from './process-executor/process-executor.port';
import { TerminalImageInputService } from './terminal-image-input.service';
import { HumanPromptInputService } from './human-prompt-input.service';
import { HumanPromptStateService } from './human-prompt-state.service';
import { TerminalIOService } from './terminal-io/terminal-io.service';
import { ShellForegroundError } from './terminal-io/delivery';
import { TerminalSessionRegistry } from './terminal-session/terminal-session-registry';

// Exercise the real pane queue and wire payload; hold only the process and storage boundaries.
function fixture(provider = 'claude') {
  const target = { name: 'agent-pane' };
  const gesture = { sessionId: randomUUID(), projectId: randomUUID(), gestureId: randomUUID() };
  const attachmentId = randomUUID() + '.png';
  const input = { ...gesture, kind: 'image-paste', index: 0, attachmentId };
  const path = `/private/session ' files/${attachmentId}`;
  const prompt = new HumanPromptStateService();
  const registry = new TerminalSessionRegistry(undefined, prompt);
  const session = registry.create(gesture.sessionId, target.name);
  session.subscribe('writer');
  const command = jest.fn(async ({ argv }: ProcessExecutorOptions) => {
    let stdout = '';
    if (argv.includes(';')) stdout = '%72 100 8 2\ncurrent draft';
    if (argv.at(-1) === '#{pane_id}') stdout = '%72';
    if (argv.at(-1) === '#{pane_pid}') stdout = '100';
    if (argv[0] === 'ps') stdout = '101';
    return { success: true, stdout, stderr: '', exitCode: 0, timedOut: false, truncated: false };
  });
  const io = new TerminalIOService({ run: command } as never, {} as never, prompt, {} as never);
  const gate = { isWritable: jest.fn(() => true) };
  const rows = {
    getSession: () => ({
      status: 'running',
      tmuxSessionId: target.name,
      providerNameAtLaunch: provider,
    }),
    getSessionProjectScope: () => ({ projectId: gesture.projectId }),
  };
  const images = { resolvePath: jest.fn(async () => path) };
  const service = new TerminalImageInputService(
    registry,
    rows as never,
    gate as never,
    images as never,
    prompt,
    new HumanPromptInputService(prompt, new EventEmitter2()),
    io,
  );
  expect(service.begin('writer', gesture).status).toBe('ready');
  const pastes = () => command.mock.calls.filter(([c]) => c.argv[1] === 'paste-buffer');
  return {
    target,
    gesture,
    input,
    path,
    registry,
    session,
    io,
    command,
    prompt,
    service,
    images,
    gate,
    pastes,
  };
}

describe('TTY image delivery', () => {
  it.each(['codex', 'agy'])(
    'represents an absolute path containing both quotes for %s',
    async (provider) => {
      const f = fixture(provider);
      const path = `/tmp/both ' and " quotes/${f.input.attachmentId}`;
      f.images.resolvePath.mockResolvedValue(path);
      expect((await f.service.paste('writer', f.input)).status).toBe('delivered');
      const representation =
        provider === 'agy'
          ? `"file:///tmp/both%20%27%20and%20%22%20quotes/${f.input.attachmentId}"`
          : `"/tmp/both ' and \\" quotes/${f.input.attachmentId}"`;
      expect(f.command.mock.calls.find(([c]) => c.argv[1] === 'load-buffer')?.[0].input).toBe(
        `\x1b[200~${representation}\x1b[201~`,
      );
    },
  );
  it('keeps the same draft through typed text, bracketed paste, editing keys and terminal replies', async () => {
    const f = fixture();
    for (const data of [
      'typed while uploading',
      '\x1b[200~first caption line\rsecond line\x1b[201~',
      '\x1bOD',
      '\x1b[12;34R',
    ]) {
      await f.io.sendControl(f.target, ['-l', '--', data]);
    }
    const first = f.service.paste('writer', f.input);
    const retry = f.service.paste('writer', f.input);
    for (const result of await Promise.all([first, retry])) expect(result.status).toBe('delivered');
    expect(f.command.mock.calls.find(([c]) => c.argv[1] === 'load-buffer')?.[0].input).toBe(
      `\x1b[200~"${f.path}"\x1b[201~`,
    );
    expect(f.pastes()).toHaveLength(1);
    expect(f.pastes()[0][0].argv.at(-1)).toBe('%72');
    expect(f.command.mock.calls.filter(([c]) => c.argv.includes('Enter'))).toEqual([]);
    expect(
      (await f.service.paste('writer', { ...f.input, attachmentId: randomUUID() + '.png' })).status,
    ).toBe('stale');
  });

  it.each(['submit', 'clear', 'history'] as const)(
    'rejects an uploaded file after %s even with no previous prompt ownership',
    async (kind) => {
      const inputs = {
        submit: [['Enter'], ['-l', '--', '\x1b[200~caption\x1b[201~\r']],
        clear: [['-l', '--', '\x15'], ['Escape']],
        history: [['Up'], ['Down'], ['-l', '--', '\x1bOA'], ['-l', '--', '\x1bOB']],
      }[kind];
      for (const keys of inputs) {
        const f = fixture();
        await f.io.sendControl(f.target, keys);
        expect((await f.service.paste('writer', f.input)).status).toBe('stale');
        expect(f.pastes()).toEqual([]);
      }
    },
  );

  it.each(['restore', 'writer returns', 'project freeze', 'cancel'])(
    'checks %s after preparing the buffer, immediately before the pane mutation',
    async (change) => {
      const f = fixture();
      const run = f.command.getMockImplementation()!;
      f.command.mockImplementation(async (command) => {
        if (command.argv[1] === 'load-buffer') {
          if (change === 'restore') {
            f.registry.dispose(f.gesture.sessionId);
            f.registry.create(f.gesture.sessionId, f.target.name).subscribe('writer');
          }
          if (change === 'writer returns') {
            f.session.subscribe('other');
            f.session.claimAuthority('other');
            f.session.claimAuthority('writer');
          }
          if (change === 'project freeze') f.gate.isWritable.mockReturnValue(false);
          if (change === 'cancel') f.service.end('writer', f.gesture);
        }
        return run(command);
      });
      expect((await f.service.paste('writer', f.input)).status).toBe('stale');
      expect(f.pastes()).toEqual([]);
      expect(f.command.mock.calls.some(([c]) => c.argv[1] === 'delete-buffer')).toBe(true);
    },
  );

  it('waits for the new Copilot chip inside the current composer before releasing subsequent pane writes', async () => {
    const f = fixture('copilot');
    const run = f.command.getMockImplementation()!;
    const chip = `[image: ${f.input.attachmentId}]`;
    const wrapped = chip.replace('-', '-\n  ');
    const rule = '─────────';
    const frames = [
      [rule, `❯ ${wrapped}`, rule],
      [`❯ ${chip}`, rule, `❯ ${chip}`, rule],
      [`❯ ${chip}`, rule, `❯ ${chip} ${chip}`, rule],
    ];
    let typing: Promise<void> | undefined;
    f.command.mockImplementation(async (cmd) => {
      const result = await run(cmd);
      if (cmd.argv[1] === 'paste-buffer') typing = f.io.sendControl(f.target, ['-l', '--', 'next']);
      if (cmd.argv[1] === 'capture-pane') {
        result.stdout = (frames.shift() ?? []).join('\n');
      }
      return result;
    });
    expect((await f.service.paste('writer', f.input)).status).toBe('recognized');
    await typing;
    expect(frames).toHaveLength(0);
    const captures = f.command.mock.calls
      .map(([cmd]) => cmd.argv)
      .filter((argv) => argv[1] === 'capture-pane');
    expect(captures.map((argv) => argv[argv.indexOf('-t') + 1])).toEqual(['%72', '%72', '%72']);
    expect(f.command.mock.calls.at(-1)?.[0].argv.at(-1)).toBe('next');
  });

  it('refuses composer writes when the active pane switches away from the pinned shell', async () => {
    const f = fixture();
    const run = f.command.getMockImplementation()!;
    let activePane = '%72';
    let pinnedPid = '100';
    f.command.mockImplementation(async (cmd) => {
      const result = await run(cmd);
      if (cmd.argv.at(-1) === '#{pane_id}') {
        result.stdout = activePane;
        activePane = '%73';
      }
      if (cmd.argv.at(-1) === '#{pane_pid}') {
        const target = cmd.argv.at(-2);
        const pane = target === `=${f.target.name}:` ? activePane : target;
        result.stdout = pane === '%72' ? pinnedPid : '200';
      }
      if (cmd.argv[0] === 'ps') result.stdout = cmd.argv.at(-1) === '100' ? '100' : '201';
      return result;
    });
    const guard = jest.fn();
    await f.io.withComposer(f.target, async (pane) => {
      await expect(pane.pasteImage(f.path, 'claude', guard)).rejects.toThrow(ShellForegroundError);
      activePane = '%72';
      await expect(pane.submit(guard)).rejects.toThrow(ShellForegroundError);
      activePane = '%72';
      pinnedPid = '';
      await expect(pane.submit(guard)).rejects.toThrow(ShellForegroundError);
    });
    expect(f.pastes()).toHaveLength(0);
    expect(f.command.mock.calls.filter(([cmd]) => cmd.argv.includes('Enter'))).toHaveLength(0);
  });

  it('ends a batch on an uncertain tmux result, including a retried item', async () => {
    const f = fixture();
    const run = f.command.getMockImplementation()!;
    f.command.mockImplementation(async (cmd) => ({
      ...(await run(cmd)),
      success: cmd.argv[1] !== 'paste-buffer',
    }));
    for (let attempt = 0; attempt < 2; attempt++)
      expect((await f.service.paste('writer', f.input)).status).toBe('uncertain');
    expect((await f.service.paste('writer', { ...f.input, index: 1 })).status).toBe('stale');
    expect(f.pastes()).toHaveLength(1);
  });
});

describe('form image Send', () => {
  function request(f: ReturnType<typeof fixture>, mixed = true): FormSendInput {
    const image = { kind: 'image' as const, attachmentId: f.input.attachmentId };
    return {
      kind: 'form-send',
      sessionId: f.gesture.sessionId,
      projectId: f.gesture.projectId,
      sendId: randomUUID(),
      resume: false,
      segments: mixed ? [image, { kind: 'text', text: 'next segment' }, image] : [image],
    };
  }

  it('submits once Copilot renders the exact camera chip across two narrow composer rows', async () => {
    const f = fixture('copilot');
    const attachmentId = '3ad11254-83b8-4e8c-b0b7-59c02d4b8f4c.png';
    const prompt = 'PROBE 140391939 Acknowledge these images. ';
    const rule = '─'.repeat(71);
    const chipRow = `❯ ${prompt}[📷 3ad11254-83b8-4e8c-b`;
    const continuation = '  0b7-59c02d4b8f4c.png]';
    const frames = [
      [`❯ ${prompt}`],
      [chipRow, continuation.replace('png]', 'pngx]')],
      [chipRow, continuation.replace('0b7-', '0b7 -')],
      [chipRow, continuation],
    ];
    const run = f.command.getMockImplementation()!;
    f.images.resolvePath.mockResolvedValue(`/private/session files/${attachmentId}`);
    f.command.mockImplementation(async (cmd) => {
      const result = await run(cmd);
      if (cmd.argv[1] === 'capture-pane') {
        result.stdout = [rule, ...(frames.shift() ?? []), rule].join('\n');
      }
      return result;
    });
    const input = request(f);
    input.segments = [
      { kind: 'text', text: prompt },
      { kind: 'image', attachmentId },
    ];
    expect(await f.service.prepareFormSend('writer', input)()).toMatchObject({
      status: 'submitted',
      confirmedSegments: 2,
      acknowledgedImages: 1,
    });
    expect(frames).toHaveLength(0);
    expect(f.pastes()).toHaveLength(2);
    expect(f.command.mock.calls.filter(([cmd]) => cmd.argv.includes('Enter'))).toHaveLength(1);
  });

  it('submits an image-only draft once and returns its cached acknowledgement', async () => {
    const f = fixture();
    const input = request(f, false);
    const send = () => f.service.prepareFormSend('writer', input)();
    for (const outcome of await Promise.all([send(), send()])) {
      expect(outcome).toEqual({
        sendId: input.sendId,
        status: 'submitted',
        confirmedSegments: 1,
        acknowledgedImages: 1,
      });
    }
    expect(f.prompt.getState(f.target.name).phase).toBe('awaiting_stable_idle');
    expect((await send()).status).toBe('submitted');
    expect(
      (
        await f.service.prepareFormSend('writer', {
          ...input,
          segments: [...input.segments, ...input.segments],
        })()
      ).status,
    ).toBe('inspect');
    expect(f.pastes()).toHaveLength(1);
    expect(f.command.mock.calls.filter(([c]) => c.argv.includes('Enter'))).toHaveLength(1);
  });

  it('retries a pre-write failure on the same send ID without leaving an active human prompt', async () => {
    const f = fixture();
    const input = request(f, false);
    const run = f.command.getMockImplementation()!;
    let fail = true;
    f.command.mockImplementation(async (cmd) => {
      const result = await run(cmd);
      if (fail && cmd.argv[1] === 'load-buffer') {
        fail = false;
        result.success = false;
      }
      return result;
    });
    expect(await f.service.prepareFormSend('writer', input)()).toMatchObject({
      status: 'retryable',
      confirmedSegments: 0,
    });
    expect(f.prompt.getState(f.target.name).phase).toBe('awaiting_stable_idle');
    expect((await f.service.prepareFormSend('writer', { ...input, resume: true })()).status).toBe(
      'submitted',
    );
    expect(f.pastes()).toHaveLength(1);
  });

  it.each([
    'unchanged',
    'keypad',
    'ordinary typing',
    'screen changed',
    'restored',
    'writer changed',
  ] as const)('resumes a known prefix only in the original untouched pane (%s)', async (change) => {
    const f = fixture();
    const input = request(f);
    const run = f.command.getMockImplementation()!;
    let failed = false;
    let screenChanged = false;
    f.command.mockImplementation(async (cmd) => {
      const result = await run(cmd);
      if (!failed && cmd.input?.includes('next segment')) {
        failed = true;
        result.success = false;
      }
      if (screenChanged && cmd.argv.includes(';')) result.stdout += 'screen changed';
      return result;
    });
    const first = await f.service.prepareFormSend('writer', input)();
    expect(first).toMatchObject({
      status: 'retryable',
      confirmedSegments: 1,
      acknowledgedImages: 1,
    });
    expect(f.pastes()).toHaveLength(1);
    if (change === 'keypad') await f.io.sendControl(f.target, ['Enter']);
    if (change === 'ordinary typing') await f.io.sendControl(f.target, ['-l', '--', 'a']);
    if (change === 'screen changed') screenChanged = true;
    if (change === 'restored') {
      f.registry.dispose(input.sessionId);
      f.registry.create(input.sessionId, f.target.name).subscribe('writer');
    }
    if (change === 'writer changed') {
      f.session.subscribe('other');
      f.session.claimAuthority('other');
      f.session.claimAuthority('writer');
    }
    const result = await f.service.prepareFormSend('writer', { ...input, resume: true })();
    expect(result.status).toBe(change === 'unchanged' ? 'submitted' : 'inspect');
    expect(f.pastes()).toHaveLength(change === 'unchanged' ? 3 : 1);
    expect(f.command.mock.calls.filter(([c]) => c.argv.includes('Enter'))).toHaveLength(
      change === 'unchanged' || change === 'keypad' ? 1 : 0,
    );
  });

  it('keeps keypad Enter and another pane sender behind all segments and the form Enter', async () => {
    const f = fixture();
    const run = f.command.getMockImplementation()!;
    const external: Promise<unknown>[] = [];
    f.command.mockImplementation(async (cmd) => {
      if (cmd.argv[1] === 'paste-buffer' && !external.length) {
        external.push(f.io.sendControl(f.target, ['Enter']));
        external.push(
          f.io.deliverImmediate(f.target, 'other sender', {
            confirm: false,
            postPasteDelayMs: 0,
            submitKeys: [],
          }),
        );
      }
      return run(cmd);
    });
    expect((await f.service.prepareFormSend('writer', request(f))()).status).toBe('submitted');
    await Promise.all(external);
    const writes = f.command.mock.calls
      .map(([cmd]) => cmd.argv)
      .filter((argv) => ['paste-buffer', 'send-keys'].includes(argv[1]));
    expect(writes.map((argv) => argv[1])).toEqual([
      'paste-buffer',
      'paste-buffer',
      'paste-buffer',
      'send-keys',
      'send-keys',
      'paste-buffer',
    ]);
    expect(writes[3].slice(-2)).toEqual(['%72', 'Enter']);
    expect(writes[4].slice(-2)).toEqual(['=agent-pane:', 'Enter']);
  });

  it.each(['image write', 'final Enter'] as const)(
    'retains an ambiguous %s without replaying any mutation',
    async (phase) => {
      const f = fixture();
      const input = request(f, false);
      const run = f.command.getMockImplementation()!;
      f.command.mockImplementation(async (cmd) => ({
        ...(await run(cmd)),
        success: cmd.argv[1] !== (phase === 'image write' ? 'paste-buffer' : 'send-keys'),
      }));
      for (const resume of [false, true, false]) {
        const ack = await f.service.prepareFormSend('writer', { ...input, resume })();
        expect(ack).toMatchObject({
          status: 'inspect',
          confirmedSegments: phase === 'image write' ? 0 : 1,
        });
      }
      expect(f.pastes()).toHaveLength(1);
      expect(f.command.mock.calls.filter(([c]) => c.argv.includes('Enter'))).toHaveLength(
        phase === 'final Enter' ? 1 : 0,
      );
    },
  );

  it('rejects a queued Send after the original session instance was replaced', async () => {
    const f = fixture();
    const input = request(f);
    const queued = f.service.prepareFormSend('writer', input);
    f.registry.dispose(input.sessionId);
    f.registry.create(input.sessionId, f.target.name).subscribe('writer');
    expect((await queued()).status).toBe('rejected');
    expect(f.pastes()).toHaveLength(0);
  });
});
