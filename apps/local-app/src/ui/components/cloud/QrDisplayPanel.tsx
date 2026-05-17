import { useState, useEffect } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Button } from '../ui/button';
import type { QrAuthStatus } from '../../hooks/useQrAuth';

interface QrDisplayPanelProps {
  status: QrAuthStatus;
  qrPayload: string | null;
  crossCheckCode: string | null;
  expiresAt: Date | null;
  error: string | null;
  onCancel: () => void;
  onRetry: () => void;
}

export function QrDisplayPanel({
  status,
  qrPayload,
  crossCheckCode,
  expiresAt,
  error,
  onCancel,
  onRetry,
}: QrDisplayPanelProps) {
  const [secondsRemaining, setSecondsRemaining] = useState(0);

  useEffect(() => {
    if (!expiresAt) return;
    const tick = () => {
      const ms = expiresAt.getTime() - Date.now();
      setSecondsRemaining(Math.max(0, Math.floor(ms / 1000)));
    };
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [expiresAt]);

  if (status === 'loading') {
    return (
      <div className="text-center py-8 space-y-2" data-testid="qr-loading">
        <div className="animate-spin h-6 w-6 border-2 border-primary border-t-transparent rounded-full mx-auto" />
        <p className="text-sm text-muted-foreground">Generating QR code...</p>
      </div>
    );
  }

  if (status === 'expired') {
    return (
      <div className="text-center py-8 space-y-3" data-testid="qr-expired">
        <p className="text-sm font-medium">Code expired</p>
        <Button variant="outline" size="sm" onClick={onRetry}>
          Generate new code
        </Button>
      </div>
    );
  }

  if (status === 'denied') {
    return (
      <div className="text-center py-8 space-y-3" data-testid="qr-denied">
        <p className="text-sm font-medium">Sign-in denied</p>
        <Button variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="text-center py-8 space-y-3" data-testid="qr-error">
        <p className="text-sm text-destructive">{error || 'Something went wrong'}</p>
        <Button variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      </div>
    );
  }

  if (status === 'success') {
    return (
      <div className="text-center py-8 space-y-2" data-testid="qr-success">
        <p className="text-sm font-medium text-green-600">Connected!</p>
      </div>
    );
  }

  if (status === 'finalizing') {
    return (
      <div className="text-center py-8 space-y-2" data-testid="qr-finalizing">
        <div className="animate-spin h-6 w-6 border-2 border-primary border-t-transparent rounded-full mx-auto" />
        <p className="text-sm text-muted-foreground">Finalizing...</p>
      </div>
    );
  }

  if (!qrPayload || !crossCheckCode) return null;

  return (
    <div className="space-y-4 max-w-xs mx-auto" data-testid="qr-waiting">
      <div className="flex justify-center">
        <QRCodeSVG
          value={qrPayload}
          size={220}
          level="M"
          bgColor="#ffffff"
          fgColor="#000000"
          includeMargin
          marginSize={4}
        />
      </div>
      <div className="text-center space-y-1">
        <p className="text-xs text-muted-foreground">Verification code</p>
        <code className="text-2xl font-mono tracking-widest font-bold" data-testid="qr-cross-check">
          {crossCheckCode}
        </code>
        <p className="text-xs text-muted-foreground">should match the code on your phone</p>
      </div>
      <p
        className={`text-center text-xs ${secondsRemaining < 30 ? 'text-destructive' : 'text-muted-foreground'}`}
        data-testid="qr-countdown"
      >
        Expires in {Math.floor(secondsRemaining / 60)}:
        {String(secondsRemaining % 60).padStart(2, '0')}
      </p>
      <Button variant="outline" size="sm" className="w-full" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}
