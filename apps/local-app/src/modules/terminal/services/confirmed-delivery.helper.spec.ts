import { deliverWithConfirmation } from './confirmed-delivery.helper';
import { PasteNotConfirmedError } from '../../../common/errors/error-types';
import type { TmuxService } from './tmux.service';
import type { TerminalSendCoordinatorService } from './terminal-send-coordinator.service';

describe('deliverWithConfirmation', () => {
  let mockTmux: jest.Mocked<Pick<TmuxService, 'pasteAndSubmit' | 'sendKeys'>>;
  let mockSendCoordinator: jest.Mocked<Pick<TerminalSendCoordinatorService, 'ensureAgentGap'>>;

  beforeEach(() => {
    mockTmux = {
      pasteAndSubmit: jest.fn().mockResolvedValue(undefined),
      sendKeys: jest.fn().mockResolvedValue(undefined),
    };
    mockSendCoordinator = {
      ensureAgentGap: jest.fn().mockResolvedValue(undefined),
    };
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('skipConfirmation: true', () => {
    it('returns discriminated skip result', async () => {
      const result = await deliverWithConfirmation(
        mockTmux as unknown as TmuxService,
        mockSendCoordinator as unknown as TerminalSendCoordinatorService,
        { tmuxSessionId: 'tmux-1', text: '/compact', agentId: 'agent-1', skipConfirmation: true },
      );

      expect(result).toMatchObject({ skipped: true, confirmed: true, nonce: '', retryCount: 0 });
    });

    it('calls pasteAndSubmit with raw text — no [MsgId:], no confirm, no nonce', async () => {
      await deliverWithConfirmation(
        mockTmux as unknown as TmuxService,
        mockSendCoordinator as unknown as TerminalSendCoordinatorService,
        { tmuxSessionId: 'tmux-1', text: '/compact', agentId: 'agent-1', skipConfirmation: true },
      );

      expect(mockTmux.pasteAndSubmit).toHaveBeenCalledTimes(1);
      const [, calledText, calledOpts] = mockTmux.pasteAndSubmit.mock.calls[0];
      expect(calledText).toBe('/compact');
      expect(calledOpts).not.toHaveProperty('confirm');
      expect(calledOpts).not.toHaveProperty('nonce');
      expect(calledOpts).toMatchObject({ bracketed: true });
    });

    it('still calls ensureAgentGap once for sequencing', async () => {
      await deliverWithConfirmation(
        mockTmux as unknown as TmuxService,
        mockSendCoordinator as unknown as TerminalSendCoordinatorService,
        { tmuxSessionId: 'tmux-1', text: '/compact', agentId: 'agent-1', skipConfirmation: true },
      );

      expect(mockSendCoordinator.ensureAgentGap).toHaveBeenCalledTimes(1);
      expect(mockSendCoordinator.ensureAgentGap).toHaveBeenCalledWith('agent-1', 1000);
    });

    it('does not enter the retry loop — pasteAndSubmit called exactly once', async () => {
      mockTmux.pasteAndSubmit.mockRejectedValueOnce(new PasteNotConfirmedError('tmux-1'));

      await expect(
        deliverWithConfirmation(
          mockTmux as unknown as TmuxService,
          mockSendCoordinator as unknown as TerminalSendCoordinatorService,
          {
            tmuxSessionId: 'tmux-1',
            text: '/compact',
            agentId: 'agent-1',
            skipConfirmation: true,
          },
        ),
      ).rejects.toThrow(PasteNotConfirmedError);

      expect(mockTmux.pasteAndSubmit).toHaveBeenCalledTimes(1);
      expect(mockTmux.sendKeys).not.toHaveBeenCalled();
    });
  });

  describe('skipConfirmation: false (default)', () => {
    it('appends [MsgId:] nonce and passes confirm: true', async () => {
      await deliverWithConfirmation(
        mockTmux as unknown as TmuxService,
        mockSendCoordinator as unknown as TerminalSendCoordinatorService,
        { tmuxSessionId: 'tmux-1', text: 'Hello', agentId: 'agent-1' },
      );

      expect(mockTmux.pasteAndSubmit).toHaveBeenCalledTimes(1);
      const [, calledText, calledOpts] = mockTmux.pasteAndSubmit.mock.calls[0];
      expect(calledText).toMatch(/\[MsgId:[0-9a-f]{7}\]$/);
      expect(calledOpts).toMatchObject({ confirm: true });
      expect(calledOpts).toHaveProperty('nonce');
    });

    it('returns confirmed: true with nonce on success', async () => {
      const result = await deliverWithConfirmation(
        mockTmux as unknown as TmuxService,
        mockSendCoordinator as unknown as TerminalSendCoordinatorService,
        { tmuxSessionId: 'tmux-1', text: 'Hello', agentId: 'agent-1' },
      );

      expect(result.confirmed).toBe(true);
      expect(result.nonce).toMatch(/^[0-9a-f]{7}$/);
      expect(result.skipped).toBeUndefined();
    });
  });
});
