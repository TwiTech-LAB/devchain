import { useState, useCallback, useEffect } from 'react';
import { QrCode } from 'lucide-react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { useQrAuth } from '../../hooks/useQrAuth';
import { QrDisplayPanel } from './QrDisplayPanel';

type AuthMode = 'idle' | 'sending' | 'sent' | 'error' | 'qr';

interface CloudAuthFormProps {
  identityServiceUrl: string;
  onMagicLinkSent?: () => void;
  onOAuthStarted?: () => void;
}

export function CloudAuthForm({
  identityServiceUrl,
  onMagicLinkSent,
  onOAuthStarted,
}: CloudAuthFormProps) {
  const [email, setEmail] = useState('');
  const [magicLinkState, setMagicLinkState] = useState<'idle' | 'sending' | 'sent' | 'error'>(
    'idle',
  );
  const [magicLinkError, setMagicLinkError] = useState('');
  const [authMode, setAuthMode] = useState<AuthMode>('idle');

  const handleOAuth = useCallback(() => {
    const redirectUri = window.location.origin + '/auth/cloud/callback';
    const url = `${identityServiceUrl}/auth/github?response_mode=fragment_full&redirect_uri=${encodeURIComponent(redirectUri)}`;
    window.open(url, 'devchain-cloud-auth', 'width=600,height=700');
    onOAuthStarted?.();
  }, [identityServiceUrl, onOAuthStarted]);

  const handleMagicLink = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!email.trim()) return;

      setMagicLinkState('sending');
      setMagicLinkError('');

      try {
        const redirectUri = window.location.origin + '/auth/cloud/callback';
        const response = await fetch(`${identityServiceUrl}/auth/magic-link/request`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: email.trim(),
            redirect_uri: redirectUri,
          }),
        });

        if (!response.ok) {
          throw new Error('Failed to send magic link');
        }

        setMagicLinkState('sent');
        onMagicLinkSent?.();
      } catch (err) {
        setMagicLinkState('error');
        setMagicLinkError(err instanceof Error ? err.message : 'Failed to send magic link');
      }
    },
    [email, identityServiceUrl, onMagicLinkSent],
  );

  if (authMode === 'qr') {
    return (
      <div className="space-y-3">
        <div>
          <p className="text-sm font-medium">Sign in with QR code</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Scan from the DevChain mobile app to sign in
          </p>
        </div>
        <QrAuthInline
          identityServiceUrl={identityServiceUrl}
          onCancel={() => setAuthMode('idle')}
        />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div>
        <p className="text-sm font-medium">Connect to DevChain Cloud</p>
        <p className="text-xs text-muted-foreground mt-0.5">Sign in to enable cloud features</p>
      </div>

      <Button variant="default" size="sm" className="w-full" onClick={handleOAuth}>
        Sign in with GitHub
      </Button>

      <div className="relative">
        <div className="absolute inset-0 flex items-center">
          <span className="w-full border-t" />
        </div>
        <div className="relative flex justify-center text-xs uppercase">
          <span className="bg-background px-2 text-muted-foreground">or</span>
        </div>
      </div>

      {magicLinkState === 'sent' ? (
        <p className="text-xs text-center text-muted-foreground py-2">
          Check your email for a sign-in link.
        </p>
      ) : (
        <form onSubmit={handleMagicLink} className="space-y-2">
          <Input
            type="email"
            placeholder="Email address"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="h-8 text-sm"
            required
          />
          <Button
            type="submit"
            variant="outline"
            size="sm"
            className="w-full"
            disabled={magicLinkState === 'sending'}
          >
            {magicLinkState === 'sending' ? 'Sending...' : 'Send magic link'}
          </Button>
          {magicLinkState === 'error' && (
            <p className="text-xs text-destructive">{magicLinkError}</p>
          )}
        </form>
      )}

      <div className="relative my-3">
        <div className="absolute inset-0 flex items-center">
          <span className="w-full border-t" />
        </div>
        <div className="relative flex justify-center text-xs uppercase">
          <span className="bg-background px-2 text-muted-foreground">or</span>
        </div>
      </div>

      <Button
        variant="outline"
        size="sm"
        className="w-full"
        onClick={() => setAuthMode('qr')}
        data-testid="qr-sign-in-button"
      >
        <QrCode className="mr-2 h-3.5 w-3.5" />
        Sign in with QR code
      </Button>
    </div>
  );
}

function QrAuthInline({
  identityServiceUrl,
  onCancel,
}: {
  identityServiceUrl: string;
  onCancel: () => void;
}) {
  const qr = useQrAuth(identityServiceUrl, 'claim');

  useEffect(() => {
    qr.start();
  }, []);

  useEffect(() => {
    if (qr.status === 'success' && qr.tokens) {
      fetch('/api/auth/cloud/tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accessToken: qr.tokens.accessToken,
          refreshToken: qr.tokens.refreshToken,
        }),
      }).catch(() => {});
    }
  }, [qr.status, qr.tokens]);

  return <QrDisplayPanel {...qr} onCancel={onCancel} onRetry={qr.retry} />;
}
