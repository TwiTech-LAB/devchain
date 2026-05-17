import { useEffect, useState } from 'react';

type CallbackState = 'processing' | 'success' | 'error';

function parseFragment(hash: string): Record<string, string> {
  const params: Record<string, string> = {};
  const stripped = hash.startsWith('#') ? hash.slice(1) : hash;
  for (const pair of stripped.split('&')) {
    const [key, ...rest] = pair.split('=');
    if (key) {
      params[key] = decodeURIComponent(rest.join('='));
    }
  }
  return params;
}

export function CloudCallbackPage() {
  const [state, setState] = useState<CallbackState>('processing');
  const [error, setError] = useState<string>('');

  useEffect(() => {
    const fragment = window.location.hash;
    if (!fragment) {
      setState('error');
      setError('No authentication data received.');
      return;
    }

    const params = parseFragment(fragment);
    const accessToken = params.access_token;
    const refreshToken = params.refresh_token;

    if (!accessToken || !refreshToken) {
      setState('error');
      setError('Missing authentication tokens.');
      return;
    }

    // Clear the fragment from the URL to prevent token leakage in history
    window.history.replaceState(null, '', window.location.pathname);

    fetch('/api/auth/cloud/tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessToken, refreshToken }),
    })
      .then(async (response) => {
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          throw new Error((body as Record<string, string>).message || 'Failed to store tokens');
        }
        setState('success');

        // Auto-close popup after a short delay
        if (window.opener) {
          setTimeout(() => window.close(), 1500);
        }
      })
      .catch((err: Error) => {
        setState('error');
        setError(err.message);
      });
  }, []);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100vh',
        fontFamily: 'system-ui, sans-serif',
        padding: '2rem',
        backgroundColor: 'hsl(var(--background, 0 0% 100%))',
        color: 'hsl(var(--foreground, 0 0% 3.9%))',
      }}
    >
      {state === 'processing' && (
        <div style={{ textAlign: 'center' }}>
          <div
            style={{
              width: 32,
              height: 32,
              border: '3px solid hsl(var(--muted, 0 0% 96.1%))',
              borderTopColor: 'hsl(var(--primary, 0 0% 9%))',
              borderRadius: '50%',
              animation: 'spin 0.8s linear infinite',
              margin: '0 auto 1rem',
            }}
          />
          <p>Connecting to cloud...</p>
          <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
        </div>
      )}
      {state === 'success' && (
        <div style={{ textAlign: 'center' }}>
          <p style={{ fontSize: '1.25rem', fontWeight: 600 }}>Connected to cloud</p>
          <p style={{ marginTop: '0.5rem', opacity: 0.7 }}>
            {window.opener ? 'This window will close automatically.' : 'You can close this tab.'}
          </p>
        </div>
      )}
      {state === 'error' && (
        <div style={{ textAlign: 'center' }}>
          <p
            style={{
              fontSize: '1.25rem',
              fontWeight: 600,
              color: 'hsl(var(--destructive, 0 84.2% 60.2%))',
            }}
          >
            Connection failed
          </p>
          <p style={{ marginTop: '0.5rem', opacity: 0.7 }}>{error}</p>
          <button
            onClick={() => window.close()}
            style={{
              marginTop: '1rem',
              padding: '0.5rem 1rem',
              cursor: 'pointer',
              border: '1px solid hsl(var(--border, 0 0% 89.8%))',
              borderRadius: '0.375rem',
              backgroundColor: 'transparent',
              color: 'inherit',
            }}
          >
            Close
          </button>
        </div>
      )}
    </div>
  );
}
