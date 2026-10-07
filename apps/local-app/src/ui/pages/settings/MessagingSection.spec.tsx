import { fireEvent, render, screen } from '@testing-library/react';
import { MessagingSection } from './MessagingSection';
import { useSettingsData } from './useSettingsData';
import { FOLLOW_NOTE } from '@/common/follow-note';

jest.mock('./useSettingsData');

const useSettingsDataMock = useSettingsData as jest.MockedFunction<typeof useSettingsData>;

const poolMutate = jest.fn();
const messagingMutate = jest.fn();

function mockSettingsData(settings: Record<string, unknown>) {
  useSettingsDataMock.mockReturnValue({
    settings,
    updateMessagePoolMutation: { mutate: poolMutate, isPending: false },
    updateMessagingMutation: { mutate: messagingMutate, isPending: false },
  } as unknown as ReturnType<typeof useSettingsData>);
}

describe('MessagingSection', () => {
  beforeEach(() => {
    poolMutate.mockReset();
    messagingMutate.mockReset();
  });

  it('keeps capacity editable and ignores delay ordering while ordinary pooling is disabled', () => {
    mockSettingsData({
      messagePool: {
        enabled: false,
        delayMs: 30000,
        maxWaitMs: 5000,
        maxMessages: 10,
        separator: '\n---\n',
      },
    });

    render(<MessagingSection />);

    expect(screen.getByLabelText('Debounce Delay (seconds)')).toBeDisabled();
    expect(screen.getByLabelText('Maximum Wait Time (seconds)')).toBeDisabled();
    expect(screen.getByLabelText('Message Separator')).toBeDisabled();
    expect(screen.getByLabelText('Maximum Messages')).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    expect(screen.queryByText('(Must be ≥ debounce delay)')).not.toBeInTheDocument();
    expect(screen.getByText(/Delivery on Idle remains queued/)).toBeInTheDocument();
    expect(
      screen.getByText(/Default-lane flush threshold and idle-lane hard capacity/),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Maximum Messages'), { target: { value: '12' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(poolMutate).toHaveBeenCalledWith({
      enabled: false,
      delayMs: 30000,
      maxWaitMs: 5000,
      maxMessages: 12,
      separator: '\n---\n',
    });
  });

  it('enforces maximum-wait ordering while ordinary pooling is enabled', () => {
    mockSettingsData({
      messagePool: {
        enabled: true,
        delayMs: 30000,
        maxWaitMs: 5000,
        maxMessages: 10,
        separator: '\n---\n',
      },
    });

    render(<MessagingSection />);

    expect(screen.getByText('(Must be ≥ debounce delay)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  describe('Message Delivery card', () => {
    const storedPool = {
      enabled: true,
      delayMs: 10000,
      maxWaitMs: 30000,
      maxMessages: 10,
      separator: '\n---\n',
    };

    it('renders both cards with the exact follow-note text and the Claude-only note', () => {
      mockSettingsData({ messagePool: storedPool, messaging: { followNote: true } });

      render(<MessagingSection />);

      expect(screen.getByText('Message Pooling')).toBeInTheDocument();
      expect(screen.getByText('Message Delivery')).toBeInTheDocument();
      expect(screen.getByText(FOLLOW_NOTE.trim())).toBeInTheDocument();
      expect(screen.getByText(/Applies to Claude sessions only/)).toBeInTheDocument();
    });

    it.each([undefined, false])('renders follow note setting %s', (followNote) => {
      mockSettingsData(
        followNote === undefined
          ? { messagePool: storedPool }
          : { messagePool: storedPool, messaging: { followNote } },
      );
      render(<MessagingSection />);
      const toggle = screen.getByRole('switch', {
        name: 'Type a follow note after DevChain messages',
      });
      if (followNote === false) expect(toggle).not.toBeChecked();
      else expect(toggle).toBeChecked();
    });

    it('saves the new value immediately when the switch flips, without Save', () => {
      mockSettingsData({ messagePool: storedPool, messaging: { followNote: false } });

      render(<MessagingSection />);
      fireEvent.click(
        screen.getByRole('switch', { name: 'Type a follow note after DevChain messages' }),
      );

      expect(messagingMutate).toHaveBeenCalledTimes(1);
      expect(messagingMutate).toHaveBeenCalledWith(
        { followNote: true },
        expect.objectContaining({ onError: expect.any(Function) }),
      );
      expect(poolMutate).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    });

    it('keeps unsaved pool edits after the switch saves and settings refetch', () => {
      mockSettingsData({ messagePool: storedPool, messaging: { followNote: true } });

      const { rerender } = render(<MessagingSection />);

      // First render loads the stored pool values.
      expect(screen.getByLabelText('Maximum Messages')).toHaveValue(10);

      fireEvent.change(screen.getByLabelText('Maximum Messages'), { target: { value: '12' } });
      fireEvent.click(
        screen.getByRole('switch', { name: 'Type a follow note after DevChain messages' }),
      );
      expect(messagingMutate).toHaveBeenCalledWith(
        { followNote: false },
        expect.objectContaining({ onError: expect.any(Function) }),
      );

      // Refetch: a new settings object whose pool values are unchanged.
      mockSettingsData({ messagePool: { ...storedPool }, messaging: { followNote: false } });
      rerender(<MessagingSection />);

      expect(screen.getByLabelText('Maximum Messages')).toHaveValue(12);
      expect(screen.getByLabelText('Debounce Delay (seconds)')).toHaveValue(10);
      expect(screen.getByRole('switch', { name: 'Enable Message Pooling' })).toBeChecked();
    });
  });
});
