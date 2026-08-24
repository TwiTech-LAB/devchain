import { createCtrlCSelectionBinding } from './ctrl-c-selection-binding';

interface TerminalFixture {
  terminal: {
    attachCustomKeyEventHandler: jest.Mock;
    onSelectionChange: jest.Mock;
    hasSelection: jest.Mock;
    getSelection: jest.Mock;
    clearSelection: jest.Mock;
    element: HTMLElement | null;
  };
  handler: () => (event: KeyboardEvent) => boolean;
  changeSelection: (text: string) => void;
  selectionDisposed: jest.Mock;
}

function createTerminalFixture(
  initialSelection = 'selected text',
  withElement = true,
): TerminalFixture {
  let selection = initialSelection;
  let selectionChange: (() => void) | undefined;
  let keyHandler: ((event: KeyboardEvent) => boolean) | undefined;
  const selectionDisposed = jest.fn();
  const terminal = {
    attachCustomKeyEventHandler: jest.fn((handler: (event: KeyboardEvent) => boolean) => {
      keyHandler = handler;
    }),
    onSelectionChange: jest.fn((listener: () => void) => {
      selectionChange = listener;
      return { dispose: selectionDisposed };
    }),
    hasSelection: jest.fn(() => selection.length > 0),
    getSelection: jest.fn(() => selection),
    clearSelection: jest.fn(() => {
      selection = '';
      selectionChange?.();
    }),
    element: withElement ? document.createElement('div') : null,
  };

  return {
    terminal,
    handler: () => {
      if (!keyHandler) throw new Error('Custom key handler was not installed');
      return keyHandler;
    },
    changeSelection: (text: string) => {
      selection = text;
      selectionChange?.();
    },
    selectionDisposed,
  };
}

function keyEvent(
  type: 'keydown' | 'keypress' | 'keyup',
  overrides: Partial<KeyboardEvent> = {},
): KeyboardEvent {
  return {
    type,
    keyCode: 67,
    ctrlKey: true,
    altKey: false,
    metaKey: false,
    shiftKey: false,
    repeat: false,
    key: 'c',
    code: 'KeyC',
    preventDefault: jest.fn(),
    ...overrides,
  } as unknown as KeyboardEvent;
}

function serveCopyFromXterm(element: HTMLElement): jest.Mock {
  const execCommand = jest.fn(() => {
    const copyEvent = new Event('copy', { bubbles: true, cancelable: true });
    copyEvent.preventDefault();
    element.dispatchEvent(copyEvent);
    return true;
  });
  Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand });
  return execCommand;
}

describe('createCtrlCSelectionBinding', () => {
  const originalExecCommand = Object.getOwnPropertyDescriptor(document, 'execCommand');
  const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

  beforeEach(() => {
    jest.useFakeTimers();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: jest.fn().mockResolvedValue(undefined) },
    });
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: jest.fn(() => false),
    });
  });

  afterEach(() => {
    jest.useRealTimers();
    if (originalExecCommand) Object.defineProperty(document, 'execCommand', originalExecCommand);
    else delete (document as Document & { execCommand?: unknown }).execCommand;
    if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
    else delete (navigator as Navigator & { clipboard?: unknown }).clipboard;
  });

  // Pure unit is the cheapest reliable layer for xterm's keyCode contract and localized labels.
  it('uses keyCode 67 even when localized key and physical code diverge', () => {
    const fixture = createTerminalFixture();
    const execCommand = serveCopyFromXterm(fixture.terminal.element!);
    createCtrlCSelectionBinding({ terminal: fixture.terminal, enabled: true });
    const event = keyEvent('keydown', { key: 'ç', code: 'KeyX' });

    expect(fixture.handler()(event)).toBe(false);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(execCommand).toHaveBeenCalledWith('copy');
  });

  // Pure unit is the cheapest reliable layer for the complete modifier eligibility matrix.
  it.each([
    ['Alt', { altKey: true }],
    ['Meta', { metaKey: true }],
    ['Shift', { shiftKey: true }],
    ['missing Control', { ctrlKey: false }],
  ])('passes through Ctrl+C-ineligible %s modifiers', (_label, modifiers) => {
    const fixture = createTerminalFixture();
    createCtrlCSelectionBinding({ terminal: fixture.terminal, enabled: true });
    const event = keyEvent('keydown', modifiers);

    expect(fixture.handler()(event)).toBe(true);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(document.execCommand).not.toHaveBeenCalled();
  });

  // Pure unit is the cheapest reliable layer for setting and empty-selection short circuits.
  it('passes through when disabled or when xterm has no selection', () => {
    const disabled = createTerminalFixture();
    createCtrlCSelectionBinding({ terminal: disabled.terminal, enabled: false });
    expect(disabled.handler()(keyEvent('keydown'))).toBe(true);

    const empty = createTerminalFixture('');
    createCtrlCSelectionBinding({ terminal: empty.terminal, enabled: true });
    expect(empty.handler()(keyEvent('keydown'))).toBe(true);
    expect(document.execCommand).not.toHaveBeenCalled();
  });

  // Pure unit is the cheapest reliable layer for the held-key state machine and pass-through events.
  it('consumes every C keydown while latched and releases on C or Control keyup', () => {
    const fixture = createTerminalFixture();
    serveCopyFromXterm(fixture.terminal.element!);
    createCtrlCSelectionBinding({ terminal: fixture.terminal, enabled: true });
    const handler = fixture.handler();

    expect(handler(keyEvent('keydown'))).toBe(false);
    const repeated = keyEvent('keydown', { ctrlKey: false, shiftKey: true, repeat: true });
    expect(handler(repeated)).toBe(false);
    expect(repeated.preventDefault).toHaveBeenCalledTimes(1);
    expect(document.execCommand).toHaveBeenCalledTimes(1);
    expect(handler(keyEvent('keypress'))).toBe(true);
    expect(handler(keyEvent('keyup'))).toBe(true);

    fixture.changeSelection('next selection');
    expect(handler(keyEvent('keydown'))).toBe(false);
    expect(handler(keyEvent('keyup', { keyCode: 17, key: 'Control', code: 'ControlLeft' }))).toBe(
      true,
    );
    fixture.changeSelection('third selection');
    expect(handler(keyEvent('keydown'))).toBe(false);
    expect(document.execCommand).toHaveBeenCalledTimes(3);
  });

  // Pure unit is the cheapest reliable layer for focus/disposal cleanup without browser timing noise.
  it('releases on capture-phase focusout and disposal, then leaves the retained handler inert', () => {
    const fixture = createTerminalFixture();
    serveCopyFromXterm(fixture.terminal.element!);
    const removeSpy = jest.spyOn(fixture.terminal.element!, 'removeEventListener');
    const binding = createCtrlCSelectionBinding({ terminal: fixture.terminal, enabled: true });
    const handler = fixture.handler();

    expect(handler(keyEvent('keydown'))).toBe(false);
    fixture.terminal.element!.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    fixture.changeSelection('after focusout');
    expect(handler(keyEvent('keydown'))).toBe(false);

    binding.dispose();
    expect(handler(keyEvent('keydown'))).toBe(true);
    expect(fixture.selectionDisposed).toHaveBeenCalledTimes(1);
    expect(removeSpy).toHaveBeenCalledWith('focusout', expect.any(Function), true);
  });

  // Pure unit with fake timers is the cheapest reliable proof that synchronous copy clears later.
  it('accepts only a default-prevented copy event, removes its observer, and clears in a macrotask', () => {
    const fixture = createTerminalFixture();
    const addSpy = jest.spyOn(fixture.terminal.element!, 'addEventListener');
    const removeSpy = jest.spyOn(fixture.terminal.element!, 'removeEventListener');
    serveCopyFromXterm(fixture.terminal.element!);
    createCtrlCSelectionBinding({ terminal: fixture.terminal, enabled: true });

    expect(fixture.handler()(keyEvent('keydown'))).toBe(false);
    expect(fixture.terminal.clearSelection).not.toHaveBeenCalled();
    expect(addSpy).toHaveBeenCalledWith('copy', expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith('copy', expect.any(Function));

    jest.runOnlyPendingTimers();
    expect(fixture.terminal.clearSelection).toHaveBeenCalledTimes(1);
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });

  // Pure unit is the cheapest reliable layer for rejecting an observed but unserved copy event.
  it('uses the fallback when the observed copy event was not default-prevented', async () => {
    const fixture = createTerminalFixture('not served');
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: jest.fn(() => {
        fixture.terminal.element!.dispatchEvent(
          new Event('copy', { bubbles: true, cancelable: true }),
        );
        return true;
      }),
    });
    createCtrlCSelectionBinding({ terminal: fixture.terminal, enabled: true });

    expect(fixture.handler()(keyEvent('keydown'))).toBe(false);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('not served');
    await Promise.resolve();

    expect(fixture.terminal.clearSelection).toHaveBeenCalledTimes(1);
  });

  // Pure unit is the cheapest reliable layer for the missing-element Clipboard API fallback.
  it('falls back with captured text when terminal.element is missing and clears after success', async () => {
    const fixture = createTerminalFixture('fallback text', false);
    createCtrlCSelectionBinding({ terminal: fixture.terminal, enabled: true });

    expect(fixture.handler()(keyEvent('keydown'))).toBe(false);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('fallback text');
    expect(fixture.terminal.clearSelection).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(fixture.terminal.clearSelection).toHaveBeenCalledTimes(1);
  });

  // Pure unit is the cheapest reliable layer for rejected clipboard promises and repeat bounding.
  it('retains selection and reports blocked clipboard feedback once when fallback fails', async () => {
    const blocked = new Error('denied');
    const writeText = jest.fn().mockRejectedValue(blocked);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const fixture = createTerminalFixture();
    const onClipboardBlocked = jest.fn();
    createCtrlCSelectionBinding({
      terminal: fixture.terminal,
      enabled: true,
      onClipboardBlocked,
    });

    expect(fixture.handler()(keyEvent('keydown'))).toBe(false);
    expect(fixture.handler()(keyEvent('keydown', { repeat: true }))).toBe(false);
    await Promise.resolve();
    await Promise.resolve();

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(fixture.terminal.clearSelection).not.toHaveBeenCalled();
    expect(onClipboardBlocked).toHaveBeenCalledWith(blocked);
  });

  // Pure unit is the cheapest reliable layer for an identical-text replacement async race.
  it('does not let a late fallback success clear a newer selection with identical text', async () => {
    let resolveWrite: (() => void) | undefined;
    const writeText = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveWrite = resolve;
        }),
    );
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const fixture = createTerminalFixture('same text');
    createCtrlCSelectionBinding({ terminal: fixture.terminal, enabled: true });

    expect(fixture.handler()(keyEvent('keydown'))).toBe(false);
    fixture.changeSelection('same text');
    resolveWrite?.();
    await Promise.resolve();

    expect(fixture.terminal.clearSelection).not.toHaveBeenCalled();
  });

  // Pure unit is the cheapest reliable layer for fencing two copy attempts without text changes.
  it('uses the copy nonce so an older attempt cannot clear the current attempt', async () => {
    const resolvers: Array<() => void> = [];
    const writeText = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const fixture = createTerminalFixture('unchanged selection');
    createCtrlCSelectionBinding({ terminal: fixture.terminal, enabled: true });
    const handler = fixture.handler();

    expect(handler(keyEvent('keydown'))).toBe(false);
    expect(handler(keyEvent('keyup'))).toBe(true);
    expect(handler(keyEvent('keydown'))).toBe(false);
    resolvers[0]?.();
    await Promise.resolve();
    expect(fixture.terminal.clearSelection).not.toHaveBeenCalled();

    resolvers[1]?.();
    await Promise.resolve();
    expect(fixture.terminal.clearSelection).toHaveBeenCalledTimes(1);
  });

  // Pure unit is the cheapest reliable layer for the final hasSelection deferred-clear guard.
  it('does not clear after success when xterm no longer has an active selection', async () => {
    let resolveWrite: (() => void) | undefined;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: jest.fn(
          () =>
            new Promise<void>((resolve) => {
              resolveWrite = resolve;
            }),
        ),
      },
    });
    const fixture = createTerminalFixture();
    createCtrlCSelectionBinding({ terminal: fixture.terminal, enabled: true });

    expect(fixture.handler()(keyEvent('keydown'))).toBe(false);
    fixture.terminal.hasSelection.mockReturnValue(false);
    resolveWrite?.();
    await Promise.resolve();

    expect(fixture.terminal.clearSelection).not.toHaveBeenCalled();
  });

  // Pure unit with fake timers is the cheapest reliable layer for disposal fencing a deferred clear.
  it('does not run a synchronous-copy clear after disposal', () => {
    const fixture = createTerminalFixture();
    serveCopyFromXterm(fixture.terminal.element!);
    const binding = createCtrlCSelectionBinding({ terminal: fixture.terminal, enabled: true });

    expect(fixture.handler()(keyEvent('keydown'))).toBe(false);
    binding.dispose();
    jest.runOnlyPendingTimers();

    expect(fixture.terminal.clearSelection).not.toHaveBeenCalled();
  });
});
