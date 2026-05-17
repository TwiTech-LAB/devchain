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
    it('renders QR code via QRCodeSVG', () => {
      render(<QrDisplayPanel {...defaultProps} />);
      const svg = screen.getByTestId('qr-code-svg');
      expect(svg).toBeInTheDocument();
      expect(svg).toHaveAttribute('data-value', defaultProps.qrPayload);
    });

    it('renders QR code with scanner-friendly contrast and quiet zone', () => {
      render(<QrDisplayPanel {...defaultProps} />);
      const svg = screen.getByTestId('qr-code-svg');
      expect(svg).toHaveAttribute('data-bg-color', '#ffffff');
      expect(svg).toHaveAttribute('data-fg-color', '#000000');
      expect(svg).toHaveAttribute('data-include-margin', 'true');
      expect(svg).toHaveAttribute('data-margin-size', '4');
    });

    it('renders cross-check code in large mono font', () => {
      render(<QrDisplayPanel {...defaultProps} />);
      const code = screen.getByTestId('qr-cross-check');
      expect(code).toHaveTextContent('ABCD');
      expect(code.className).toContain('text-2xl');
      expect(code.className).toContain('font-mono');
      expect(code.className).toContain('tracking-widest');
    });

    it('renders verification code label', () => {
      render(<QrDisplayPanel {...defaultProps} />);
      expect(screen.getByText('Verification code')).toBeInTheDocument();
      expect(screen.getByText('should match the code on your phone')).toBeInTheDocument();
    });

    it('renders countdown timer', () => {
      render(<QrDisplayPanel {...defaultProps} />);
      const countdown = screen.getByTestId('qr-countdown');
      expect(countdown).toBeInTheDocument();
      expect(countdown.textContent).toContain('Expires in');
    });

    it('renders Cancel button', () => {
      render(<QrDisplayPanel {...defaultProps} />);
      expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
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
    it('renders loading spinner with text', () => {
      render(<QrDisplayPanel {...defaultProps} status="loading" qrPayload={null} />);
      expect(screen.getByTestId('qr-loading')).toBeInTheDocument();
      expect(screen.getByText('Generating QR code...')).toBeInTheDocument();
    });
  });

  describe('expired state', () => {
    it('renders expired message with retry button', () => {
      render(<QrDisplayPanel {...defaultProps} status="expired" qrPayload={null} />);
      expect(screen.getByTestId('qr-expired')).toBeInTheDocument();
      expect(screen.getByText('Code expired')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /generate new code/i })).toBeInTheDocument();
    });

    it('calls onRetry when retry button clicked', () => {
      const onRetry = jest.fn();
      render(
        <QrDisplayPanel {...defaultProps} status="expired" qrPayload={null} onRetry={onRetry} />,
      );
      fireEvent.click(screen.getByRole('button', { name: /generate new code/i }));
      expect(onRetry).toHaveBeenCalledTimes(1);
    });
  });

  describe('denied state', () => {
    it('renders denied message with retry button', () => {
      render(<QrDisplayPanel {...defaultProps} status="denied" qrPayload={null} />);
      expect(screen.getByTestId('qr-denied')).toBeInTheDocument();
      expect(screen.getByText('Sign-in denied')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
    });
  });

  describe('error state', () => {
    it('renders error message with retry button', () => {
      render(
        <QrDisplayPanel {...defaultProps} status="error" qrPayload={null} error="initiate:500" />,
      );
      expect(screen.getByTestId('qr-error')).toBeInTheDocument();
      expect(screen.getByText('initiate:500')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
    });

    it('renders fallback message when error is null', () => {
      render(<QrDisplayPanel {...defaultProps} status="error" qrPayload={null} error={null} />);
      expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    });
  });

  describe('success state', () => {
    it('renders Connected! message', () => {
      render(<QrDisplayPanel {...defaultProps} status="success" qrPayload={null} />);
      expect(screen.getByTestId('qr-success')).toBeInTheDocument();
      expect(screen.getByText('Connected!')).toBeInTheDocument();
    });

    it('does not render any token values in the DOM', () => {
      const { container } = render(
        <QrDisplayPanel {...defaultProps} status="success" qrPayload={null} />,
      );
      const html = container.innerHTML;
      expect(html).not.toContain('accessToken');
      expect(html).not.toContain('refreshToken');
      expect(html).not.toContain('token');
    });
  });

  describe('finalizing state', () => {
    it('renders finalizing spinner', () => {
      render(<QrDisplayPanel {...defaultProps} status="finalizing" qrPayload={null} />);
      expect(screen.getByTestId('qr-finalizing')).toBeInTheDocument();
      expect(screen.getByText('Finalizing...')).toBeInTheDocument();
    });
  });
});
