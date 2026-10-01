/**
 * The one place that knows how each provider's login material is stored and
 * placed on a VM. Shared by the vault service, the isolated-login generator,
 * and the write-back path — file paths, env keys, and entry kinds live here
 * once. Ground truth for the supported provider set is the adapter factory
 * (`providers/adapters/provider-adapter.factory.ts`), not this table.
 */

import type { ProviderAuthPayload } from '../storage/models/domain.models';

/** An env-var login (`CLAUDE_CODE_OAUTH_TOKEN=…`) pasted as a static entry. */
export interface ProviderAuthEnvSpec {
  kind: 'static';
  payloadKind: 'env';
  envKey: string;
}

/** A whole login file (`~/.codex/auth.json`) held by one VM at a time. */
export interface ProviderAuthFilesSpec {
  kind: 'family';
  payloadKind: 'files';
  /** Relative to the VM user's home; written 0600 inside 0700 directories. */
  filePath: string;
}

/** OpenCode: entries of the PC's `auth.json`, composed into one file per claim. */
export interface ProviderAuthOpencodeSpec {
  payloadKind: 'opencode-entry';
}

export type ProviderAuthAdapterSpec =
  | ProviderAuthEnvSpec
  | ProviderAuthFilesSpec
  | ProviderAuthOpencodeSpec;

const AGY_TOKEN_FILE_PATH = '.gemini/antigravity-cli/antigravity-oauth-token';

export const PROVIDER_AUTH_ADAPTERS: Record<string, ProviderAuthAdapterSpec> = {
  claude: { kind: 'static', payloadKind: 'env', envKey: 'CLAUDE_CODE_OAUTH_TOKEN' },
  copilot: { kind: 'static', payloadKind: 'env', envKey: 'COPILOT_GITHUB_TOKEN' },
  codex: { kind: 'family', payloadKind: 'files', filePath: '.codex/auth.json' },
  agy: { kind: 'family', payloadKind: 'files', filePath: AGY_TOKEN_FILE_PATH },
  opencode: { payloadKind: 'opencode-entry' },
};

/** Whether a stored payload fits its provider's spec; an OpenCode group fits the OpenCode spec. */
export function specAcceptsPayload(
  spec: ProviderAuthAdapterSpec,
  payloadKind: ProviderAuthPayload['payloadKind'],
): boolean {
  return (
    payloadKind === spec.payloadKind ||
    (spec.payloadKind === 'opencode-entry' && payloadKind === 'opencode-entries')
  );
}

/** The single `auth.json` every selected OpenCode entry is composed into. */
export const OPENCODE_AUTH_FILE_PATH = '.local/share/opencode/auth.json';

export function opencodeEntries(
  payload: ProviderAuthPayload,
): Record<string, Record<string, unknown>> {
  switch (payload.payloadKind) {
    case 'opencode-entry':
      return { [payload.providerId]: payload.entry };
    case 'opencode-entries':
      return payload.entries;
    default:
      return {};
  }
}

/** Where OpenCode keeps its credentials on this PC (import source). */
export function opencodePcAuthFilePath(homedir: string): string {
  return `${homedir}/${OPENCODE_AUTH_FILE_PATH}`;
}

/** The claim endpoint refuses these env keys; the vault refuses them earlier. */
export const RESERVED_PROVIDER_AUTH_ENV_KEYS: ReadonlySet<string> = new Set([
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'PATH',
  'HOST',
  'PORT',
  'NODE_OPTIONS',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'XDG_RUNTIME_DIR',
  'DBUS_SESSION_BUS_ADDRESS',
  'DEVCHAIN_HOST_TLS_KEY_FILE',
  'DEVCHAIN_HOST_TLS_CERT_FILE',
]);

export const PROVIDER_AUTH_ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** One file a claim places on the VM; matches the bootstrap claim contract. */
export interface ProviderAuthClaimFile {
  path: string;
  mode: '0600';
  contentBase64: string;
}

/** What `buildClaimBundle` hands to the claim: static entries as env, families as files. */
export interface ProviderAuthClaimBundle {
  env: Record<string, string>;
  files: ProviderAuthClaimFile[];
}

// ── Isolated login (generator) ──────────────────────────────────────────────
// Commands and paths reproduce `scripts/remote-proofs/provider-auth.md`.

/** Environment changes applied on top of DevChain's own environment. */
export interface ProviderAuthLoginEnv {
  set: Record<string, string>;
  unset: string[];
}

/** One vault entry produced by a login, with the values to redact from output. */
export interface ProviderAuthGeneratedEntry {
  kind: 'static' | 'family';
  /** Appended to the entry label; OpenCode names the provider id. */
  labelSuffix?: string;
  payload: ProviderAuthPayload;
  secrets: string[];
}

/** Maps a CLI name to what runs it: a provider's configured binary, or the name on PATH. */
export type ProviderAuthBinResolver = (cli: string) => string;

export interface ProviderAuthVerifySpec {
  argv: string[];
  env: ProviderAuthLoginEnv;
  /** True when the command's combined output shows a working login. */
  accepts(output: string): boolean;
}

export type ProviderAuthCaptureSpec =
  /** Files relative to the isolated dir; ready once all exist and parse. */
  | { kind: 'files'; files: string[] }
  /** Once `whenFile` exists, the output of `command` (run in the isolation env) is the login. */
  | { kind: 'command'; whenFile: string; command(bin: ProviderAuthBinResolver): string[] };

export interface ProviderAuthLoginAdapter {
  isolationEnv(dir: string): ProviderAuthLoginEnv;
  /** Directories (relative to the isolated dir) created 0700 before the login starts. */
  prepareDirs: string[];
  loginCommand(bin: ProviderAuthBinResolver): string[];
  capture: ProviderAuthCaptureSpec;
  /** Files by relative path, or the capture command's stdout. Throws when the login is incomplete. */
  parse(captured: Record<string, string> | string): ProviderAuthGeneratedEntry[];
  verifyCommand(
    dir: string,
    entries: ProviderAuthGeneratedEntry[],
    bin: ProviderAuthBinResolver,
  ): ProviderAuthVerifySpec;
}

/** gh prefers these over its config dir, and Copilot over its own token variable. */
const GITHUB_TOKEN_VARIABLES = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
];

const OK_REPLY = /(^|\W)OK(\W|$)/;
const VERIFY_PROMPT = 'Reply with exactly: OK';

export type ProviderAuthVerifyOutcome = { ok: true } | { ok: false; hint: string };

/**
 * How a provider's login is checked, on the PC after an isolated login and on
 * a claimed host: the command (stdin from /dev/null) and its pass condition.
 * `agy` and `copilot` make one model call each.
 */
export interface ProviderAuthVerifyCheck {
  argv(bin: ProviderAuthBinResolver): string[];
  /** `opencodeProviderIds`: the OpenCode ids that must be listed. */
  check(output: string, context: { opencodeProviderIds: string[] }): ProviderAuthVerifyOutcome;
}

const alphanumeric = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');

const okReply = (output: string): ProviderAuthVerifyOutcome =>
  OK_REPLY.test(output) ? { ok: true } : { ok: false, hint: 'The CLI did not answer OK.' };

/** The first JSON object in `output`, or null. */
function firstJsonObject(output: string): Record<string, unknown> | null {
  const start = output.indexOf('{');
  const end = output.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try {
    const parsed: unknown = JSON.parse(output.slice(start, end + 1));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export const PROVIDER_AUTH_VERIFY: Record<string, ProviderAuthVerifyCheck> = {
  claude: {
    argv: (bin) => [bin('claude'), 'auth', 'status'],
    check: (output) => {
      const status = firstJsonObject(output);
      if (!status || status.loggedIn !== true) {
        return { ok: false, hint: 'Claude is not logged in; check CLAUDE_CODE_OAUTH_TOKEN.' };
      }
      if (status.authMethod !== 'oauth_token') {
        // Stored credentials win over the token variable.
        return {
          ok: false,
          hint: `Claude uses ${String(status.authMethod)} instead of the token: remove ~/.claude/.credentials.json on the host.`,
        };
      }
      return { ok: true };
    },
  },
  codex: {
    argv: (bin) => [bin('codex'), 'login', 'status'],
    check: (output) =>
      output.includes('Logged in') ? { ok: true } : { ok: false, hint: 'Codex is not logged in.' },
  },
  // The list shows display names ("OpenAI oauth"), so ids match loosely.
  opencode: {
    argv: (bin) => [bin('opencode'), 'auth', 'list'],
    check: (output, { opencodeProviderIds }) => {
      const listed = alphanumeric(output);
      const missing = opencodeProviderIds.filter((id) => !listed.includes(alphanumeric(id)));
      return missing.length === 0
        ? { ok: true }
        : { ok: false, hint: `OpenCode does not list ${missing.join(', ')}.` };
    },
  },
  agy: {
    argv: (bin) => [bin('agy'), '-p', VERIFY_PROMPT],
    check: okReply,
  },
  copilot: {
    argv: (bin) => [bin('copilot'), '-p', VERIFY_PROMPT, '--allow-all-tools'],
    check: okReply,
  },
};

function opencodeIds(entries: ProviderAuthGeneratedEntry[]): string[] {
  return entries.flatMap((entry) => Object.keys(opencodeEntries(entry.payload)));
}

function verifySpec(
  provider: string,
  env: ProviderAuthLoginEnv,
  entries: ProviderAuthGeneratedEntry[],
  bin: ProviderAuthBinResolver,
): ProviderAuthVerifySpec {
  const verify = PROVIDER_AUTH_VERIFY[provider];
  return {
    argv: verify.argv(bin),
    env,
    accepts: (output) => verify.check(output, { opencodeProviderIds: opencodeIds(entries) }).ok,
  };
}

function jsonObject(content: string, what: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(content);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${what} is not a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

/** Every string leaf long enough to be a credential; used only for redaction. */
function stringLeaves(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    if (value.length >= 8) out.push(value);
  } else if (value && typeof value === 'object') {
    for (const child of Object.values(value)) stringLeaves(child, out);
  }
  return out;
}

function filesOf(captured: Record<string, string> | string): Record<string, string> {
  if (typeof captured === 'string') throw new Error('expected captured files');
  return captured;
}

function familyFile(content: string, what: string): ProviderAuthGeneratedEntry {
  const parsed = jsonObject(content, what);
  return {
    kind: 'family',
    payload: { payloadKind: 'files', content },
    secrets: stringLeaves(parsed),
  };
}

// Each login's verify runs in the same isolation env as the login itself.
const codexIsolation = (dir: string): ProviderAuthLoginEnv => ({
  set: { CODEX_HOME: dir },
  unset: [],
});
// With only the bus variable unset, agy still finds `$XDG_RUNTIME_DIR/bus`
// and uses the PC keyring; an empty runtime dir makes it use the file store.
const agyIsolation = (dir: string): ProviderAuthLoginEnv => ({
  set: { HOME: `${dir}/home`, XDG_RUNTIME_DIR: `${dir}/run` },
  unset: ['DBUS_SESSION_BUS_ADDRESS'],
});
// Only `data` moves; OpenCode's config, cache and state stay under $HOME.
const opencodeIsolation = (dir: string): ProviderAuthLoginEnv => ({
  set: { XDG_DATA_HOME: dir },
  unset: [],
});
const AGY_CAPTURE_FILE = `home/${AGY_TOKEN_FILE_PATH}`;

export const PROVIDER_AUTH_LOGIN_ADAPTERS: Record<string, ProviderAuthLoginAdapter> = {
  codex: {
    isolationEnv: codexIsolation,
    prepareDirs: [],
    loginCommand: (bin) => [bin('codex'), 'login'],
    capture: { kind: 'files', files: ['auth.json'] },
    parse: (captured) => {
      const content = filesOf(captured)['auth.json'];
      const entry = familyFile(content, 'auth.json');
      const tokens = jsonObject(content, 'auth.json').tokens;
      if (!tokens || typeof tokens !== 'object') throw new Error('auth.json has no tokens');
      return [entry];
    },
    verifyCommand: (dir, entries, bin) => verifySpec('codex', codexIsolation(dir), entries, bin),
  },
  agy: {
    isolationEnv: agyIsolation,
    prepareDirs: ['home', 'run'],
    loginCommand: (bin) => [bin('agy')],
    capture: { kind: 'files', files: [AGY_CAPTURE_FILE] },
    parse: (captured) => {
      const content = filesOf(captured)[AGY_CAPTURE_FILE];
      const entry = familyFile(content, 'antigravity-oauth-token');
      if (!jsonObject(content, 'antigravity-oauth-token').token) {
        throw new Error('antigravity-oauth-token has no token');
      }
      return [entry];
    },
    verifyCommand: (dir, entries, bin) => verifySpec('agy', agyIsolation(dir), entries, bin),
  },
  opencode: {
    isolationEnv: opencodeIsolation,
    prepareDirs: [],
    loginCommand: (bin) => [bin('opencode'), 'auth', 'login'],
    capture: { kind: 'files', files: ['opencode/auth.json'] },
    parse: (captured) => {
      const auth = jsonObject(filesOf(captured)['opencode/auth.json'], 'auth.json');
      const entries: ProviderAuthGeneratedEntry[] = [];
      for (const [providerId, entry] of Object.entries(auth)) {
        // `api` keys are reusable and imported from the PC's own file instead.
        if (!entry || typeof entry !== 'object' || (entry as { type?: unknown }).type !== 'oauth') {
          continue;
        }
        entries.push({
          kind: 'family',
          labelSuffix: providerId,
          payload: {
            payloadKind: 'opencode-entry',
            providerId,
            entry: entry as Record<string, unknown>,
          },
          secrets: stringLeaves(entry),
        });
      }
      if (entries.length === 0) throw new Error('auth.json has no oauth login');
      return entries;
    },
    verifyCommand: (dir, entries, bin) =>
      verifySpec('opencode', opencodeIsolation(dir), entries, bin),
  },
  copilot: {
    isolationEnv: (dir) => ({ set: { GH_CONFIG_DIR: dir }, unset: GITHUB_TOKEN_VARIABLES }),
    prepareDirs: [],
    // Without --insecure-storage gh writes the token to the PC keyring.
    loginCommand: (bin) => [
      bin('gh'),
      'auth',
      'login',
      '-h',
      'github.com',
      '-p',
      'https',
      '-w',
      '--insecure-storage',
    ],
    capture: {
      kind: 'command',
      whenFile: 'hosts.yml',
      command: (bin) => [bin('gh'), 'auth', 'token'],
    },
    parse: (captured) => {
      if (typeof captured !== 'string') throw new Error('expected the gh auth token output');
      const token = captured.trim();
      if (!/^[A-Za-z0-9_]{20,255}$/.test(token)) throw new Error('gh auth token printed no token');
      return [
        {
          kind: 'static',
          payload: { payloadKind: 'env', envKey: 'COPILOT_GITHUB_TOKEN', value: token },
          secrets: [token],
        },
      ];
    },
    verifyCommand: (dir, entries, bin) => {
      const payload = entries[0]?.payload;
      const token = payload?.payloadKind === 'env' ? payload.value : '';
      return verifySpec(
        'copilot',
        {
          set: { COPILOT_GITHUB_TOKEN: token, GH_CONFIG_DIR: dir },
          unset: GITHUB_TOKEN_VARIABLES,
        },
        entries,
        bin,
      );
    },
  },
};
