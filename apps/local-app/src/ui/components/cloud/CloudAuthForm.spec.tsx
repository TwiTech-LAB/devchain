/** @jest-environment jsdom */

import { fireEvent, render, screen } from '@testing-library/react';
import { CloudAuthForm } from './CloudAuthForm';
import { useQrAuth } from '../../hooks/useQrAuth';

jest.mock('../../hooks/useQrAuth');
jest.mock('./QrDisplayPanel', () => ({
  QrDisplayPanel: ({
    status,
    onCancel,
    onRetry,
  }: {
    status: string;
    onCancel: () => void;
    onRetry: () => void;
  }) => (
    <div data-testid="qr-display-panel" data-status={status}>
      <button data-testid="qr-cancel" onClick={onCancel}>
        Cancel
      </button>
      <button data-testid="qr-retry" onClick={onRetry}>
        Retry
      </button>
    </div>
  ),
}));

const mockUseQrAuth = useQrAuth as jest.MockedFunction<typeof useQrAuth>;

describe('CloudAuthForm', () => {
  beforeEach(() => {
    mockUseQrAuth.mockReturnValue({
      status: 'idle',
      qrPayload: null,
      crossCheckCode: null,
      expiresAt: null,
      channelId: null,
      pollToken: null,
      tokens: null,
      error: null,
      start: jest.fn(),
      cancel: jest.fn(),
      retry: jest.fn(),
    });
  });

  function renderForm() {
    return render(<CloudAuthForm identityServiceUrl="http://localhost:3002" />);
  }

  describe('idle mode', () => {
    it('renders the channel-neutral subtitle', () => {
      renderForm();
      expect(screen.getByText('Sign in to enable cloud features')).toBeInTheDocument();
    });

    it('renders three auth options: GitHub, magic link, QR code', () => {
      renderForm();
      expect(screen.getByRole('button', { name: /sign in with github/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /send magic link/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /sign in with qr code/i })).toBeInTheDocument();
    });

    it('renders the QR sign-in button with correct testid', () => {
      renderForm();
      expect(screen.getByTestId('qr-sign-in-button')).toBeInTheDocument();
    });
  });

  describe('QR mode', () => {
    it('transitions to QR mode when QR button is clicked', () => {
      renderForm();
      fireEvent.click(screen.getByRole('button', { name: /sign in with qr code/i }));
      expect(screen.getByTestId('qr-display-panel')).toBeInTheDocument();
      expect(screen.getByText('Sign in with QR code')).toBeInTheDocument();
    });

    it('does not render GitHub/magic link when in QR mode', () => {
      renderForm();
      fireEvent.click(screen.getByRole('button', { name: /sign in with qr code/i }));
      expect(
        screen.queryByRole('button', { name: /sign in with github/i }),
      ).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /send magic link/i })).not.toBeInTheDocument();
    });

    it('calls useQrAuth with claim mode', () => {
      renderForm();
      fireEvent.click(screen.getByRole('button', { name: /sign in with qr code/i }));
      expect(mockUseQrAuth).toHaveBeenCalledWith('http://localhost:3002', 'claim');
    });

    it('calls start on mount', () => {
      const start = jest.fn();
      mockUseQrAuth.mockReturnValue({
        status: 'idle',
        qrPayload: null,
        crossCheckCode: null,
        expiresAt: null,
        channelId: null,
        pollToken: null,
        tokens: null,
        error: null,
        start,
        cancel: jest.fn(),
        retry: jest.fn(),
      });
      renderForm();
      fireEvent.click(screen.getByRole('button', { name: /sign in with qr code/i }));
      expect(start).toHaveBeenCalledTimes(1);
    });

    it('returns to idle mode when Cancel is clicked', () => {
      renderForm();
      fireEvent.click(screen.getByRole('button', { name: /sign in with qr code/i }));
      expect(screen.getByTestId('qr-display-panel')).toBeInTheDocument();

      fireEvent.click(screen.getByTestId('qr-cancel'));
      expect(screen.queryByTestId('qr-display-panel')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /sign in with github/i })).toBeInTheDocument();
    });

    it('posts tokens to /api/auth/cloud/tokens on success', () => {
      mockUseQrAuth.mockReturnValue({
        status: 'success',
        qrPayload: 'qr',
        crossCheckCode: 'ABCD',
        expiresAt: new Date(),
        channelId: 'ch-1',
        pollToken: 'pt-1',
        tokens: { accessToken: 'at-123', refreshToken: 'rt-456' },
        error: null,
        start: jest.fn(),
        cancel: jest.fn(),
        retry: jest.fn(),
      });

      renderForm();
      fireEvent.click(screen.getByRole('button', { name: /sign in with qr code/i }));

      const tokenCalls = (global.fetch as jest.Mock).mock.calls.filter(
        (call: [string, unknown]) => call[0] === '/api/auth/cloud/tokens',
      );
      expect(tokenCalls.length).toBeGreaterThan(0);
      expect(tokenCalls[0][1]).toEqual(
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ accessToken: 'at-123', refreshToken: 'rt-456' }),
        }),
      );
    });
  });
});
