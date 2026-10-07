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
      safetyNumber: null,
      start: jest.fn(),
      cancel: jest.fn(),
      retry: jest.fn(),
    });
  });

  it('pairs against the given backend when one is passed', () => {
    render(
      <SignInMobileDeviceDialog identityServiceUrl="http://localhost:3002" backend="remote-1" />,
    );
    fireEvent.click(screen.getByTestId('sign-in-mobile-device-button'));
    expect(mockUseQrAuth).toHaveBeenCalledWith('http://localhost:3002', 'provision', 'remote-1');
  });

  it('starts mobile provisioning and shows its QR dialog', () => {
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
      safetyNumber: null,
      start,
      cancel: jest.fn(),
      retry: jest.fn(),
    });
    render(<SignInMobileDeviceDialog identityServiceUrl="http://localhost:3002" />);
    {
      fireEvent.click(screen.getByTestId('sign-in-mobile-device-button'));
      expect(start).toHaveBeenCalledTimes(1);
    }
    {
      expect(screen.getByTestId('sign-in-mobile-device-button')).toBeInTheDocument();
      expect(screen.getByText('Sign in mobile device')).toBeInTheDocument();
    }
    {
      expect(screen.getByText('Sign in your mobile with this account')).toBeInTheDocument();
      expect(screen.getByText(/scan from the devchain mobile app/i)).toBeInTheDocument();
    }
    {
      expect(mockUseQrAuth).toHaveBeenCalledWith('http://localhost:3002', 'provision', undefined);
      expect(screen.getByTestId('qr-display-panel')).toBeInTheDocument();
    }
  });

  it.each([
    { size: undefined, expected: 'h-9' },
    { size: 'default', expected: 'h-10' },
  ] as const)('renders $size trigger', ({ size, expected }) => {
    render(
      <SignInMobileDeviceDialog identityServiceUrl="http://localhost:3002" triggerSize={size} />,
    );
    const button = screen.getByTestId('sign-in-mobile-device-button');
    expect(button).toHaveClass(expected);
    expect(button).not.toHaveClass(expected === 'h-9' ? 'h-10' : 'h-9');
  });

  it('applies triggerClassName to the trigger button', () => {
    render(
      <SignInMobileDeviceDialog
        identityServiceUrl="http://localhost:3002"
        triggerClassName="w-full custom-class"
      />,
    );
    const btn = screen.getByTestId('sign-in-mobile-device-button');
    expect(btn).toHaveClass('w-full');
    expect(btn).toHaveClass('custom-class');
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
      safetyNumber: null,
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
