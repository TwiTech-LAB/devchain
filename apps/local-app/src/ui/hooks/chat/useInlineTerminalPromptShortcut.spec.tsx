import { fireEvent, render, screen } from '@testing-library/react';
import { useInlineTerminalPromptShortcut } from './useInlineTerminalPromptShortcut';

function Harness({ enabled, onOpen }: { enabled: boolean; onOpen: () => void }) {
  useInlineTerminalPromptShortcut(enabled, onOpen);
  return (
    <>
      <div data-inline-terminal-input>
        <textarea aria-label="Terminal input" />
      </div>
      <textarea aria-label="Other input" />
    </>
  );
}

describe('useInlineTerminalPromptShortcut', () => {
  it('opens for the physical Alt+Shift+P chord from the inline terminal in capture phase', () => {
    const onOpen = jest.fn();
    render(<Harness enabled={true} onOpen={onOpen} />);
    const terminalInput = screen.getByRole('textbox', { name: 'Terminal input' });
    terminalInput.addEventListener('keydown', (event) => event.stopPropagation());

    fireEvent.keyDown(terminalInput, {
      code: 'KeyP',
      key: 'π',
      altKey: true,
      shiftKey: true,
    });

    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('ignores repeats, extra modifiers, other inputs, and disabled terminals', () => {
    const onOpen = jest.fn();
    const { rerender } = render(<Harness enabled={true} onOpen={onOpen} />);
    const terminalInput = screen.getByRole('textbox', { name: 'Terminal input' });

    fireEvent.keyDown(terminalInput, {
      code: 'KeyP',
      altKey: true,
      shiftKey: true,
      repeat: true,
    });
    fireEvent.keyDown(terminalInput, {
      code: 'KeyP',
      altKey: true,
      shiftKey: true,
      ctrlKey: true,
    });
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Other input' }), {
      code: 'KeyP',
      altKey: true,
      shiftKey: true,
    });

    rerender(<Harness enabled={false} onOpen={onOpen} />);
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Terminal input' }), {
      code: 'KeyP',
      altKey: true,
      shiftKey: true,
    });

    expect(onOpen).not.toHaveBeenCalled();
  });
});
