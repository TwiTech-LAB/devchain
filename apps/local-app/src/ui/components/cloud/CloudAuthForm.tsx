import { useState, useCallback, useEffect } from 'react';
import { QrCode } from 'lucide-react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { useQrAuth } from '../../hooks/useQrAuth';
import { QrDisplayPanel } from './QrDisplayPanel';
import { HOME_BACKEND, apiFetch, type BackendId } from '@/ui/lib/api-transport';
import { completeCloudSignIn, openCloudOAuthPopup } from '@/ui/lib/cloud-target';

type AuthMode = 'idle' | 'sending' | 'sent' | 'error' | 'qr';

interface CloudAuthFormProps {
  identityServiceUrl: string;
  onMagicLinkSent?: () => void;
  onOAuthStarted?: () => void;
  /** Backend this form signs in and pairs with; defaults to This PC. */
  backend?: BackendId;
  /** The remote's name at home; sent as the instance label on a remote sign-in. */
  remoteName?: string | null;
}

export function CloudAuthForm({
  identityServiceUrl,
  onMagicLinkSent,
  onOAuthStarted,
  backend = HOME_BACKEND,
  remoteName = null,
}: CloudAuthFormProps) {
  const [email, setEmail] = useState('');
  const [magicLinkState, setMagicLinkState] = useState<'idle' | 'sending' | 'sent' | 'error'>(
    'idle',
  );
  const [magicLinkError, setMagicLinkError] = useState('');
  const [authMode, setAuthMode] = useState<AuthMode>('idle');

  const handleOAuth = useCallback(() => {
    openCloudOAuthPopup(identityServiceUrl, { backend, remoteName });
    onOAuthStarted?.();
  }, [identityServiceUrl, onOAuthStarted, backend, remoteName]);

  const handleMagicLink = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!email.trim()) return;

      setMagicLinkState('sending');
      setMagicLinkError('');

      try {
        const redirectUri = window.location.origin + '/auth/cloud/callback';
        const response = await apiFetch(
          `${identityServiceUrl}/auth/magic-link/request`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              email: email.trim(),
              redirect_uri: redirectUri,
            }),
          },
          { backend: 'home' },
        );

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
          backend={backend}
          remoteName={remoteName}
          onCancel={() => setAuthMode('idle')}
        />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <Button variant="default" size="default" className="w-full" onClick={handleOAuth}>
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
            className="h-9 text-sm"
            required
          />
          <Button
            type="submit"
            variant="outline"
            size="default"
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
        size="default"
        className="w-full"
        onClick={() => setAuthMode('qr')}
        data-testid="qr-sign-in-button"
      >
        <QrCode className="mr-2 h-4 w-4" />
        Sign in with QR code
      </Button>
    </div>
  );
}

function QrAuthInline({
  identityServiceUrl,
  backend,
  remoteName,
  onCancel,
}: {
  identityServiceUrl: string;
  backend: BackendId;
  remoteName: string | null;
  onCancel: () => void;
}) {
  const qr = useQrAuth(identityServiceUrl, 'claim', backend);

  useEffect(() => {
    qr.start();
  }, []);

  useEffect(() => {
    if (qr.status === 'success' && qr.tokens) {
      completeCloudSignIn({
        backend,
        remoteName,
        accessToken: qr.tokens.accessToken,
        refreshToken: qr.tokens.refreshToken ?? '',
      }).catch(() => {});
    }
  }, [qr.status, qr.tokens, backend, remoteName]);

  return <QrDisplayPanel {...qr} onCancel={onCancel} onRetry={qr.retry} />;
}
