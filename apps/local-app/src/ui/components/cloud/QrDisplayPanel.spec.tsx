/** @jest-environment jsdom */

import { fireEvent, render, screen } from '@testing-library/react';
import { QrDisplayPanel } from './QrDisplayPanel';
import type { QrAuthStatus } from '../../hooks/useQrAuth';

// Mock QRCodeSVG
jest.mock('qrcode.react', () => ({
  QRCodeSVG: ({
    value,
    bgColor,
    fgColor,
    includeMargin,
    marginSize,
  }: {
    value: string;
    bgColor?: string;
    fgColor?: string;
    includeMargin?: boolean;
    marginSize?: number;
  }) => (
    <div
      data-testid="qr-code-svg"
      data-value={value}
      data-bg-color={bgColor}
      data-fg-color={fgColor}
      data-include-margin={String(includeMargin)}
      data-margin-size={String(marginSize)}
    />
  ),
}));

const defaultProps = {
  status: 'waiting' as QrAuthStatus,
  qrPayload: '{"v":1,"p":"abc","u":"http://localhost:3002","c":"ABCD","m":"claim"}',
  crossCheckCode: 'ABCD',
  expiresAt: new Date(Date.now() + 120_000),
  error: null,
  onCancel: jest.fn(),
  onRetry: jest.fn(),
};

describe('QrDisplayPanel', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  describe('waiting state', () => {
    it('shows QR payload, cross-check code and expiry countdown', () => {
      render(<QrDisplayPanel {...defaultProps} />);
      {
        const svg = screen.getByTestId('qr-code-svg');
        expect(svg).toBeInTheDocument();
        expect(svg).toHaveAttribute('data-value', defaultProps.qrPayload);
      }
      {
        const code = screen.getByTestId('qr-cross-check');
        expect(code).toHaveTextContent('ABCD');
        expect(code.className).toContain('text-2xl');
        expect(code.className).toContain('font-mono');
        expect(code.className).toContain('tracking-widest');
      }
      {
        const countdown = screen.getByTestId('qr-countdown');
        expect(countdown).toBeInTheDocument();
        expect(countdown.textContent).toContain('Expires in');
      }
    });

    it('renders QR code with scanner-friendly contrast and quiet zone', () => {
      render(<QrDisplayPanel {...defaultProps} />);
      const svg = screen.getByTestId('qr-code-svg');
      expect(svg).toHaveAttribute('data-bg-color', '#ffffff');
      expect(svg).toHaveAttribute('data-fg-color', '#000000');
      expect(svg).toHaveAttribute('data-include-margin', 'true');
      expect(svg).toHaveAttribute('data-margin-size', '4');
    });

    it('calls onCancel when Cancel button clicked', () => {
      const onCancel = jest.fn();
      render(<QrDisplayPanel {...defaultProps} onCancel={onCancel} />);
      fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
      expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it('renders countdown in red when <30 seconds', () => {
      render(<QrDisplayPanel {...defaultProps} expiresAt={new Date(Date.now() + 20_000)} />);
      const countdown = screen.getByTestId('qr-countdown');
      expect(countdown.className).toContain('text-destructive');
    });

    it('returns null when qrPayload is null', () => {
      const { container } = render(
        <QrDisplayPanel {...defaultProps} qrPayload={null} status="waiting" />,
      );
      expect(container.firstChild).toBeNull();
    });
  });

  describe('loading state', () => {
    it.each([
      { status: 'loading', text: 'Generating QR code...', retry: null, error: null },
      { status: 'expired', text: 'Code expired', retry: /generate new code/i, error: null },
      { status: 'denied', text: 'Sign-in denied', retry: /try again/i, error: null },
      { status: 'error', text: 'initiate:500', retry: /try again/i, error: 'initiate:500' },
      { status: 'finalizing', text: 'Finalizing...', retry: null, error: null },
    ] as const)('renders $status with its recovery action', ({ status, text, retry, error }) => {
      render(<QrDisplayPanel {...defaultProps} status={status} qrPayload={null} error={error} />);
      expect(screen.getByTestId(`qr-${status}`)).toBeInTheDocument();
      expect(screen.getByText(text)).toBeInTheDocument();
      if (retry) expect(screen.getByRole('button', { name: retry })).toBeInTheDocument();
    });
  });

  describe('expired state', () => {
    it('calls onRetry when retry button clicked', () => {
      const onRetry = jest.fn();
      render(
        <QrDisplayPanel {...defaultProps} status="expired" qrPayload={null} onRetry={onRetry} />,
      );
      fireEvent.click(screen.getByRole('button', { name: /generate new code/i }));
      expect(onRetry).toHaveBeenCalledTimes(1);
    });
  });

  describe('error state', () => {
    it('renders fallback message when error is null', () => {
      render(<QrDisplayPanel {...defaultProps} status="error" qrPayload={null} error={null} />);
      expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    });
  });

  describe('success state', () => {
    it('shows connected state without a safety number', () => {
      render(<QrDisplayPanel {...defaultProps} status="success" qrPayload={null} />);
      {
        expect(screen.getByTestId('qr-success')).toBeInTheDocument();
        expect(screen.getByText('Connected!')).toBeInTheDocument();
      }
      {
        expect(screen.queryByTestId('qr-safety-number')).not.toBeInTheDocument();
      }
    });

    it('renders the safety number to compare when provided', () => {
      render(
        <QrDisplayPanel
          {...defaultProps}
          status="success"
          qrPayload={null}
          safetyNumber="12345 67890 11111 22222 33333 44444 55555 66666"
        />,
      );
      expect(screen.getByTestId('qr-safety-number')).toBeInTheDocument();
      expect(
        screen.getByText('12345 67890 11111 22222 33333 44444 55555 66666'),
      ).toBeInTheDocument();
      expect(screen.getByText('should match the number on your phone')).toBeInTheDocument();
    });
  });
});
