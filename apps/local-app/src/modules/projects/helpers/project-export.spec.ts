import { sanitizeEnvMap } from './project-export';

describe('sanitizeEnvMap', () => {
  it('returns null for null input', () => {
    expect(sanitizeEnvMap(null)).toBeNull();
  });

  it('preserves non-secret keys', () => {
    const env = {
      NODE_ENV: 'production',
      LOG_LEVEL: 'debug',
      AUTHOR_NAME: 'Jane',
      AUTHENTICATOR: 'oauth',
      PORT: '3000',
    };
    const result = sanitizeEnvMap(env);
    expect(result).toEqual(env);
  });

  it.each<{ label: string; env: Record<string, string> }>([
    {
      label: 'redacts api_key (case-insensitive)',
      env: { MY_API_KEY: 'secret123', api_key: 'secret123', Api_Key_Custom: 'val' },
    },
    { label: 'redacts apikey (no underscore)', env: { MYAPIKEY: 'val' } },
    { label: 'redacts token', env: { AUTH_TOKEN: 'val', GITHUB_TOKEN: 'ghp_xxx' } },
    { label: 'redacts secret', env: { APP_SECRET: 'val' } },
    { label: 'redacts password', env: { DB_PASSWORD: 'val' } },
    { label: 'redacts passwd', env: { MY_PASSWD: 'val' } },
    { label: 'redacts private_key', env: { SSH_PRIVATE_KEY: 'val' } },
    { label: 'redacts client_secret', env: { OAUTH_CLIENT_SECRET: 'val' } },
    { label: 'redacts access_key', env: { AWS_ACCESS_KEY: 'val', AWS_ACCESS_KEY_ID: 'AKIA' } },
    { label: 'redacts bearer', env: { BEARER_AUTH: 'val' } },
    {
      label: 'redacts credential and credentials',
      env: { MY_CREDENTIAL: 'val', GCP_CREDENTIALS: 'val' },
    },
    { label: 'redacts service_account', env: { SERVICE_ACCOUNT_KEY: 'val' } },
    { label: 'redacts ssh_key', env: { DEPLOY_SSH_KEY: 'val' } },
    { label: 'redacts connection_string', env: { DB_CONNECTION_STRING: 'val' } },
    { label: 'redacts database_url', env: { DATABASE_URL: 'postgres://...' } },
    { label: 'redacts dsn', env: { SENTRY_DSN: 'https://xxx@sentry' } },
    { label: 'redacts webhook_secret', env: { WEBHOOK_SECRET: 'val' } },
    { label: 'redacts signing_key', env: { JWT_SIGNING_KEY: 'val' } },
    { label: 'redacts encryption_key', env: { DATA_ENCRYPTION_KEY: 'val' } },
  ])('$label', ({ env }) => {
    expect(sanitizeEnvMap(env)).toEqual(
      Object.fromEntries(Object.keys(env).map((key) => [key, '***'])),
    );
  });

  it('redacts PAT-shaped keys (boundary-aware)', () => {
    expect(sanitizeEnvMap({ GITHUB_PAT: 'ghp_xxx' })).toEqual({ GITHUB_PAT: '***' });
    expect(sanitizeEnvMap({ MY_PAT: 'val' })).toEqual({ MY_PAT: '***' });
    expect(sanitizeEnvMap({ PAT_TOKEN: 'val' })).toEqual({ PAT_TOKEN: '***' });
    expect(sanitizeEnvMap({ GH_PAT_VALUE: 'val' })).toEqual({ GH_PAT_VALUE: '***' });
    expect(sanitizeEnvMap({ pat: 'val' })).toEqual({ pat: '***' });
  });

  it('does NOT redact keys that merely contain "pat" as a substring', () => {
    const env = {
      PATH: '/usr/bin',
      PATTERN: 'glob',
      DISPATCH: 'async',
      PATIENCE: '100',
    };
    expect(sanitizeEnvMap(env)).toEqual(env);
  });

  it('returns empty record as-is (no keys to redact)', () => {
    expect(sanitizeEnvMap({})).toEqual({});
  });
});
