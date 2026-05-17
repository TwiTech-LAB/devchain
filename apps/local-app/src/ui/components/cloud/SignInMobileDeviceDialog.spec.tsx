/** @jest-environment jsdom */

import { fireEvent, render, screen } from '@testing-library/react';
import { SignInMobileDeviceDialog } from './SignInMobileDeviceDialog';
import { useQrAuth } from '../../hooks/useQrAuth';
import { useCloudConnection } from '@/ui/hooks/useCloudConnection';

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

jest.mock('@/ui/hooks/useCloudConnection', () => ({
  useCloudConnection: jest.fn(),
}));

const mockUseQrAuth = useQrAuth as jest.MockedFunction<typeof useQrAuth>;

function mockConnected(connected: boolean) {
  (useCloudConnection as jest.Mock).mockReturnValue({
    status: {
      connected,
      userId: connected ? 'u1' : undefined,
      email: connected ? 'u@x.com' : undefined,
      identityServiceUrl: 'http://localhost:3002',
    },
    isLoading: false,
    disconnect: jest.fn(),
  });
}

describe('SignInMobileDeviceDialog', () => {
  beforeEach(() => {
    mockConnected(true);
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

  it('renders the trigger button', () => {
    render(<SignInMobileDeviceDialog identityServiceUrl="http://localhost:3002" />);
    expect(screen.getByTestId('sign-in-mobile-device-button')).toBeInTheDocument();
    expect(screen.getByText('Sign in mobile device')).toBeInTheDocument();
  });

  it('opens dialog on button click', () => {
    render(<SignInMobileDeviceDialog identityServiceUrl="http://localhost:3002" />);
    fireEvent.click(screen.getByTestId('sign-in-mobile-device-button'));
    expect(screen.getByText('Sign in your mobile with this account')).toBeInTheDocument();
    expect(screen.getByText(/scan from the devchain mobile app/i)).toBeInTheDocument();
  });

  it('mounts QrDisplayPanel with provision mode when dialog is open', () => {
    render(<SignInMobileDeviceDialog identityServiceUrl="http://localhost:3002" />);
    fireEvent.click(screen.getByTestId('sign-in-mobile-device-button'));
    expect(mockUseQrAuth).toHaveBeenCalledWith('http://localhost:3002', 'provision');
    expect(screen.getByTestId('qr-display-panel')).toBeInTheDocument();
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
    render(<SignInMobileDeviceDialog identityServiceUrl="http://localhost:3002" />);
    fireEvent.click(screen.getByTestId('sign-in-mobile-device-button'));
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('calls cancel and closes dialog on Cancel click', () => {
    const cancel = jest.fn();
    mockUseQrAuth.mockReturnValue({
      status: 'waiting',
      qrPayload: 'qr',
      crossCheckCode: 'ABCD',
      expiresAt: new Date(),
      channelId: 'ch-1',
      pollToken: 'pt-1',
      tokens: null,
      error: null,
      start: jest.fn(),
      cancel,
      retry: jest.fn(),
    });

    render(<SignInMobileDeviceDialog identityServiceUrl="http://localhost:3002" />);
    fireEvent.click(screen.getByTestId('sign-in-mobile-device-button'));
    expect(screen.getByTestId('qr-display-panel')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('qr-cancel'));
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
