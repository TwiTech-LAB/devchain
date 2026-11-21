import {
  createTerminalClipboardPasteBinding,
  readClipboardImages,
} from './terminal-clipboard-paste';

const ctrlV = (type = 'keydown', repeat = false) =>
  new KeyboardEvent(type, { key: 'v', ctrlKey: true, repeat, cancelable: true });

describe('terminal clipboard paste binding', () => {
  const target = document.createElement('textarea');
  const onCtrlV = jest.fn();
  const onFiles = jest.fn();
  let binding: ReturnType<typeof createTerminalClipboardPasteBinding>;

  const paste = (clipboardData: object) => {
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: clipboardData });
    target.dispatchEvent(event);
    return event;
  };

  beforeEach(() => {
    jest.useFakeTimers();
    binding = createTerminalClipboardPasteBinding({ target, onFiles, onCtrlV });
  });

  afterEach(() => {
    binding.dispose();
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it('forwards one byte at key release when the browser sends no paste event', () => {
    const first = ctrlV();
    expect(binding.handleKeyEvent(first)).toBe(false);
    expect(first.defaultPrevented).toBe(false);
    expect(onCtrlV).not.toHaveBeenCalled();

    const repeat = ctrlV('keydown', true);
    expect(binding.handleKeyEvent(repeat)).toBe(false);
    expect(repeat.defaultPrevented).toBe(true);
    jest.advanceTimersByTime(1000);
    expect(onCtrlV).not.toHaveBeenCalled();
    binding.handleKeyEvent(new KeyboardEvent('keyup', { key: 'Control' }));
    binding.handleKeyEvent(ctrlV('keyup'));
    expect(onCtrlV.mock.calls).toEqual([['\x16']]);
  });

  it('lets xterm paste whitespace-only text without forwarding the control byte on release', () => {
    binding.handleKeyEvent(ctrlV());
    expect(paste({ getData: () => '  \n' }).defaultPrevented).toBe(false);
    binding.handleKeyEvent(ctrlV('keyup'));
    expect(onCtrlV).not.toHaveBeenCalled();
    expect(onFiles).not.toHaveBeenCalled();
  });

  it('consumes a delayed empty paste and forwards just one control byte', () => {
    binding.handleKeyEvent(ctrlV());
    jest.advanceTimersByTime(1000);
    expect(onCtrlV).not.toHaveBeenCalled();
    expect(paste({ getData: () => '' }).defaultPrevented).toBe(true);
    binding.handleKeyEvent(ctrlV('keyup'));
    expect(onCtrlV.mock.calls).toEqual([['\x16']]);
    expect(onFiles).not.toHaveBeenCalled();
  });

  it('waits for delayed files without forwarding SYN even if another key is pressed', () => {
    const file = new File(['image'], 'one.png');
    binding.handleKeyEvent(ctrlV());
    jest.advanceTimersByTime(1000);
    binding.handleKeyEvent(new KeyboardEvent('keydown', { key: 'a' }));
    expect(paste({ files: [file], getData: () => file.name }).defaultPrevented).toBe(true);
    const repeat = ctrlV('keydown', true);
    expect(binding.handleKeyEvent(repeat)).toBe(false);
    expect(repeat.defaultPrevented).toBe(true);
    binding.handleKeyEvent(ctrlV('keyup'));
    expect(onFiles.mock.calls).toEqual([[{ files: [file], browserFileCount: 1 }]]);
    expect(onCtrlV).not.toHaveBeenCalled();
  });

  it.each([
    ['text', { getData: () => 'clipboard text' }],
    ['files', { files: [new File(['image'], 'one.png')] }],
  ])('discards delayed %s after focus leaves without delivering a byte', (_, clipboardData) => {
    binding.handleKeyEvent(ctrlV());
    target.dispatchEvent(new FocusEvent('focusout'));
    jest.advanceTimersByTime(1000);
    expect(paste(clipboardData).defaultPrevented).toBe(true);
    binding.handleKeyEvent(ctrlV('keyup'));
    expect(onCtrlV).not.toHaveBeenCalled();
    expect(onFiles).not.toHaveBeenCalled();
  });

  it('cancels on window blur and allows a later ordinary paste after key release outside the terminal', () => {
    binding.handleKeyEvent(ctrlV());
    window.dispatchEvent(new FocusEvent('blur'));
    document.body.dispatchEvent(new KeyboardEvent('keyup', { key: 'v', bubbles: true }));
    expect(paste({ getData: () => 'later paste' }).defaultPrevented).toBe(false);
    expect(onCtrlV).not.toHaveBeenCalled();
  });

  it('keeps Ctrl+Shift+V text-only and leaves URI-only ordinary paste alone', () => {
    const clipboardData = { files: [new File(['image'], 'one.png')] };
    binding.handleKeyEvent(
      new KeyboardEvent('keydown', { key: 'V', ctrlKey: true, shiftKey: true }),
    );
    expect(paste(clipboardData).defaultPrevented).toBe(false);
    expect(paste({ types: ['text/uri-list', 'text/plain'] }).defaultPrevented).toBe(false);
    expect(onFiles).not.toHaveBeenCalled();
    expect(onCtrlV).not.toHaveBeenCalled();
  });

  it('counts inaccessible items and snapshots available files before returning from capture', async () => {
    const file = new File(['image'], 'one.png');
    const readHeader = jest.fn().mockRejectedValue(new Error('clipboard file removed'));
    jest
      .spyOn(file, 'slice')
      .mockReturnValue(Object.assign(new Blob(), { arrayBuffer: readHeader }));
    const getAsFile = jest.fn().mockReturnValueOnce(file).mockReturnValueOnce(null);
    const items = [
      { kind: 'file', getAsFile },
      { kind: 'file', getAsFile },
      { kind: 'string', getAsFile },
    ];

    binding.handleKeyEvent(ctrlV());
    expect(paste({ files: [file], items }).defaultPrevented).toBe(true);
    items.length = 0;
    expect(getAsFile).toHaveBeenCalledTimes(2);
    expect(onFiles.mock.calls).toEqual([[{ files: [file], browserFileCount: 2 }]]);
    await expect(readClipboardImages(onFiles.mock.calls[0][0])).resolves.toEqual({
      images: [],
      unreadableFileCount: 2,
      unsupportedFileCount: 0,
    });
    jest.runAllTimers();
    expect(onCtrlV).not.toHaveBeenCalled();
  });

  it('does not forward a pending key after disposal', () => {
    binding.handleKeyEvent(ctrlV());
    binding.dispose();
    document.body.dispatchEvent(new KeyboardEvent('keyup', { key: 'v', bubbles: true }));
    expect(onCtrlV).not.toHaveBeenCalled();
    expect(paste({ files: [new File(['image'], 'one.png')] }).defaultPrevented).toBe(false);
  });
});
