import { sanitizeEnvMap } from './project-export';

describe('sanitizeEnvMap', () => {
  it('returns null for null input', () => {
    expect(sanitizeEnvMap(null)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(sanitizeEnvMap(undefined)).toBeNull();
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

  it('redacts api_key (case-insensitive)', () => {
    expect(sanitizeEnvMap({ MY_API_KEY: 'secret123' })).toEqual({ MY_API_KEY: '***' });
    expect(sanitizeEnvMap({ api_key: 'secret123' })).toEqual({ api_key: '***' });
    expect(sanitizeEnvMap({ Api_Key_Custom: 'val' })).toEqual({ Api_Key_Custom: '***' });
  });

  it('redacts apikey (no underscore)', () => {
    expect(sanitizeEnvMap({ MYAPIKEY: 'val' })).toEqual({ MYAPIKEY: '***' });
  });

  it('redacts token', () => {
    expect(sanitizeEnvMap({ AUTH_TOKEN: 'val' })).toEqual({ AUTH_TOKEN: '***' });
    expect(sanitizeEnvMap({ GITHUB_TOKEN: 'ghp_xxx' })).toEqual({ GITHUB_TOKEN: '***' });
  });

  it('redacts secret', () => {
    expect(sanitizeEnvMap({ APP_SECRET: 'val' })).toEqual({ APP_SECRET: '***' });
  });

  it('redacts password', () => {
    expect(sanitizeEnvMap({ DB_PASSWORD: 'val' })).toEqual({ DB_PASSWORD: '***' });
  });

  it('redacts passwd', () => {
    expect(sanitizeEnvMap({ MY_PASSWD: 'val' })).toEqual({ MY_PASSWD: '***' });
  });

  it('redacts private_key', () => {
    expect(sanitizeEnvMap({ SSH_PRIVATE_KEY: 'val' })).toEqual({ SSH_PRIVATE_KEY: '***' });
  });

  it('redacts client_secret', () => {
    expect(sanitizeEnvMap({ OAUTH_CLIENT_SECRET: 'val' })).toEqual({ OAUTH_CLIENT_SECRET: '***' });
  });

  it('redacts access_key', () => {
    expect(sanitizeEnvMap({ AWS_ACCESS_KEY: 'val' })).toEqual({ AWS_ACCESS_KEY: '***' });
    expect(sanitizeEnvMap({ AWS_ACCESS_KEY_ID: 'AKIA' })).toEqual({ AWS_ACCESS_KEY_ID: '***' });
  });

  it('redacts bearer', () => {
    expect(sanitizeEnvMap({ BEARER_AUTH: 'val' })).toEqual({ BEARER_AUTH: '***' });
  });

  it('redacts credential and credentials', () => {
    expect(sanitizeEnvMap({ MY_CREDENTIAL: 'val' })).toEqual({ MY_CREDENTIAL: '***' });
    expect(sanitizeEnvMap({ GCP_CREDENTIALS: 'val' })).toEqual({ GCP_CREDENTIALS: '***' });
  });

  it('redacts service_account', () => {
    expect(sanitizeEnvMap({ SERVICE_ACCOUNT_KEY: 'val' })).toEqual({ SERVICE_ACCOUNT_KEY: '***' });
  });

  it('redacts ssh_key', () => {
    expect(sanitizeEnvMap({ DEPLOY_SSH_KEY: 'val' })).toEqual({ DEPLOY_SSH_KEY: '***' });
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

  it('redacts connection_string', () => {
    expect(sanitizeEnvMap({ DB_CONNECTION_STRING: 'val' })).toEqual({
      DB_CONNECTION_STRING: '***',
    });
  });

  it('redacts database_url', () => {
    expect(sanitizeEnvMap({ DATABASE_URL: 'postgres://...' })).toEqual({ DATABASE_URL: '***' });
  });

  it('redacts dsn', () => {
    expect(sanitizeEnvMap({ SENTRY_DSN: 'https://xxx@sentry' })).toEqual({ SENTRY_DSN: '***' });
  });

  it('redacts webhook_secret', () => {
    expect(sanitizeEnvMap({ WEBHOOK_SECRET: 'val' })).toEqual({ WEBHOOK_SECRET: '***' });
  });

  it('redacts signing_key', () => {
    expect(sanitizeEnvMap({ JWT_SIGNING_KEY: 'val' })).toEqual({ JWT_SIGNING_KEY: '***' });
  });

  it('redacts encryption_key', () => {
    expect(sanitizeEnvMap({ DATA_ENCRYPTION_KEY: 'val' })).toEqual({ DATA_ENCRYPTION_KEY: '***' });
  });

  it('handles mixed secret and non-secret keys', () => {
    const env = {
      NODE_ENV: 'production',
      API_KEY: 'sk-secret',
      LOG_LEVEL: 'info',
      DB_PASSWORD: 'pass123',
    };
    const result = sanitizeEnvMap(env);
    expect(result).toEqual({
      NODE_ENV: 'production',
      API_KEY: '***',
      LOG_LEVEL: 'info',
      DB_PASSWORD: '***',
    });
  });

  it('replaces original values with *** (not present in output)', () => {
    const secretValue = 'super-secret-value-12345';
    const result = sanitizeEnvMap({ MY_TOKEN: secretValue });
    expect(JSON.stringify(result)).not.toContain(secretValue);
    expect(result).toEqual({ MY_TOKEN: '***' });
  });

  it('returns empty record as-is (no keys to redact)', () => {
    expect(sanitizeEnvMap({})).toEqual({});
  });

  it('regression: false-positive guards and PAT boundary cases in a single env map', () => {
    const env = {
      // Must NOT be redacted (false-positive guards)
      PATH: '/usr/bin',
      PATTERN: 'glob',
      DISPATCH: 'async',
      PATIENCE: '100',
      AUTHOR_NAME: 'Jane',
      AUTHENTICATOR: 'oauth',
      // Must be redacted (PAT boundary matches)
      GITHUB_PAT: 'ghp_xxx',
      MY_PAT: 'val',
      PAT_TOKEN: 'val',
      GH_PAT_VALUE: 'val',
    };
    expect(sanitizeEnvMap(env)).toEqual({
      PATH: '/usr/bin',
      PATTERN: 'glob',
      DISPATCH: 'async',
      PATIENCE: '100',
      AUTHOR_NAME: 'Jane',
      AUTHENTICATOR: 'oauth',
      GITHUB_PAT: '***',
      MY_PAT: '***',
      PAT_TOKEN: '***',
      GH_PAT_VALUE: '***',
    });
  });
});
