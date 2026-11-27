// Backend integration: the real preflight, registration port, CLI adapter, ensure service and child
// process executor are the cheapest layer that shows which home each MCP step reads and writes. Only
// the `codex` binary is a stand-in script, which keeps its registrations under `$CODEX_HOME`.
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostResolver } from '@devchain/shared';
import { getEnvConfig } from '../../../../common/config/env.config';
import { PreflightService, type PreflightResult } from '../../../core/services/preflight.service';
import { CodexAdapter } from '../../../providers/adapters/codex.adapter';
import { CopilotAdapter } from '../../../providers/adapters/copilot.adapter';
import type { ProviderAdapter } from '../../../providers/adapters/provider-adapter.interface';
import { CliMcpRegistrationAdapter } from '../../../providers/services/mcp-registration/cli-mcp-registration.adapter';
import { McpRegistrationPort } from '../../../providers/services/mcp-registration/mcp-registration.port';
import { McpProviderRegistrationService } from '../../../providers/services/mcp-provider-registration.service';
import { ProviderMcpEnsureService } from '../../../providers/services/provider-mcp-ensure.service';
import { ChildProcessExecutor } from '../../../terminal/services/process-executor/child-process-executor';
import { FakeProcessExecutor } from '../../../terminal/services/process-executor/fake-process-executor';
import { createProjectWriteGateStub } from '../../../storage/write-gate/testing/project-write-gate.stub';
import { createMockProvider } from '../../../../../test/factories/provider';
import { ensureMcpReadiness } from './ensure-mcp-readiness';

const logCalls: unknown[][] = [];
jest.mock('../../../../common/logging/logger', () => ({
  createLogger: () => {
    const record =
      () =>
      (...args: unknown[]) =>
        logCalls.push(args);
    return { info: record(), warn: record(), error: record(), debug: record() };
  },
}));

// FAKE_CODEX_MODE=fail echoes SENTINEL on both streams and fails; =mismatch lists a devchain
// endpoint that carries SENTINEL until an add. FAKE_CODEX_SLOW names a log that records a command
// that starts while another command of the same home runs.
const FAKE_CODEX = `#!/bin/sh
[ "$1" = "-c" ] && shift 2
home="\${CODEX_HOME:-$HOME/.codex}"
mkdir -p "$home"
file="$home/mcp.txt"
touch "$file"
if [ "$FAKE_CODEX_MODE" = "fail" ]; then echo "denied: $SENTINEL" >&2; echo "$SENTINEL"; exit 1; fi
held=
if [ -n "$FAKE_CODEX_SLOW" ]; then
  if mkdir "$home.lock" 2>/dev/null; then held=1; else echo overlap >> "$FAKE_CODEX_SLOW"; fi
  sleep 0.2
fi
case "$1 $2" in
  "mcp list")
    if [ "$FAKE_CODEX_MODE" = "mismatch" ] && [ ! -s "$file" ]; then
      echo "devchain http://127.0.0.1:9/$SENTINEL"
    else cat "$file"; fi ;;
  "mcp add") { grep -v "^$5 " "$file" || true; echo "$5 $4"; } > "$file.tmp" && mv "$file.tmp" "$file" ;;
  "mcp remove") { grep -v "^$3 " "$file" || true; } > "$file.tmp" && mv "$file.tmp" "$file" ;;
  *) exit 2 ;;
esac
status=$?
[ -n "$held" ] && rmdir "$home.lock"
exit $status
`;

const endpoint = () => {
  const env = getEnvConfig();
  return `${HostResolver.buildInternalBaseUrl({ host: env.HOST, port: env.PORT })}/mcp`;
};

/** The real MCP check and repair services for one provider, around a stand-in binary. */
function createMcpStack(name: string, adapter: ProviderAdapter, binPath: string, project: string) {
  const provider = createMockProvider({ id: `p-${name}`, name, binPath });
  const factory = {
    getAdapter: () => adapter,
    isSupported: (candidate: string) => candidate === name,
    getSupportedProviders: () => [name],
  };
  const storage = {
    findProjectByPath: async () => ({ id: 'project-1' }),
    listAgents: async () => ({ items: [] }),
    listProfileProviderConfigsByIds: async () => [],
    listProvidersByIds: async () => [provider],
    listProjects: async () => ({ items: [{ id: 'project-1', name: 'P', rootPath: project }] }),
    updateProviderMcpMetadata: async () => provider,
    getProviderEnvForProject: () => null,
  };
  const cli = new CliMcpRegistrationAdapter(factory as never, new ChildProcessExecutor());
  const registration = new McpProviderRegistrationService(
    new McpRegistrationPort(cli, {} as never, {} as never, factory as never),
    cli,
    factory as never,
    storage as never,
  );
  const tmux = new FakeProcessExecutor();
  tmux.setDefaultResponse({ type: 'success', stdout: 'tmux 3.3a' });
  const preflight = new PreflightService(storage as never, registration, factory as never, tmux);
  const ensure = new ProviderMcpEnsureService(
    storage as never,
    registration,
    factory as never,
    createProjectWriteGateStub() as never,
  );
  return { provider, factory, registration, preflight, ensure };
}
type McpStack = ReturnType<typeof createMcpStack>;

/** `ensureMcpReadiness` for the stack's provider, as a restore to it runs it. */
const readiness = (stack: McpStack, project: string, configEnv: Record<string, string> | null) =>
  ensureMcpReadiness({
    storage: { getProviderEnvForProject: () => null },
    preflightService: stack.preflight,
    mcpEnsureService: stack.ensure,
    launchRules: stack.factory.getAdapter(),
    provider: stack.provider,
    projectId: 'project-1',
    projectRootPath: project,
    configEnv,
    requireProviderCheck: true,
  });

/** The stack provider's MCP status in each preflight run, in order. */
const mcpStatuses = async (stack: McpStack, runChecks: jest.SpyInstance) =>
  Promise.all(
    runChecks.mock.results.map(async ({ value }) => {
      const result = (await value) as PreflightResult;
      return result.providers.find((check) => check.id === stack.provider.id)?.mcpStatus;
    }),
  );

describe('ensureMcpReadiness in the destination config environment (Codex homes)', () => {
  const saved = { ...process.env };
  const secret = 'sk-test-not-a-real-key';
  let root: string;
  let defaultHome: string;
  let configHome: string;
  let project: string;
  let stack: McpStack;
  let runChecks: jest.SpyInstance;
  let ensureMcp: jest.SpyInstance;

  beforeEach(async () => {
    logCalls.length = 0;
    root = await mkdtemp(join(tmpdir(), 'mcp-codex-homes-'));
    defaultHome = join(root, 'default-codex');
    configHome = join(root, 'config-codex');
    project = join(root, 'project');
    await Promise.all([
      mkdir(defaultHome),
      mkdir(configHome),
      mkdir(project),
      mkdir(join(root, 'home')),
    ]);
    // Every home the stand-in or the trust writer could fall back to is inside `root`.
    process.env.HOME = join(root, 'home');
    process.env.CODEX_HOME = defaultHome;
    const codexBin = join(root, 'codex');
    await writeFile(codexBin, FAKE_CODEX);
    await chmod(codexBin, 0o755);
    await writeFile(join(defaultHome, 'mcp.txt'), `devchain ${endpoint()}\n`);

    stack = createMcpStack('codex', new CodexAdapter(), codexBin, project);
    runChecks = jest.spyOn(stack.preflight, 'runChecks');
    ensureMcp = jest.spyOn(stack.ensure, 'ensureMcp');
  });

  afterEach(async () => {
    process.env = { ...saved };
    await rm(root, { recursive: true, force: true });
  });

  const snapshot = async (dir: string) =>
    Promise.all(
      (await readdir(dir))
        .sort()
        .map(async (name) => [name, await readFile(join(dir, name), 'utf-8')]),
    );

  it("checks, repairs and rechecks in the config's CODEX_HOME and leaves the default home", async () => {
    const defaultBefore = await snapshot(defaultHome);

    await readiness(stack, project, { CODEX_HOME: configHome, OPENAI_API_KEY: secret });

    expect(await mcpStatuses(stack, runChecks)).toEqual(['warn', 'pass']);
    expect(ensureMcp).toHaveBeenCalledTimes(1);
    expect(await readFile(join(configHome, 'mcp.txt'), 'utf-8')).toMatch(/^devchain http/);
    expect(await snapshot(defaultHome)).toEqual(defaultBefore);
    const logged = JSON.stringify(logCalls);
    expect(logged).not.toContain(configHome);
    expect(logged).not.toContain(secret);
  });

  it.each(['fail', 'mismatch'])(
    'keeps child output of a session environment out of logs and errors (%s)',
    async (mode) => {
      const sentinel = 'sentinel-7f3a91';

      const error = await readiness(stack, project, {
        CODEX_HOME: configHome,
        FAKE_CODEX_MODE: mode,
        SENTINEL: sentinel,
      }).then(
        () => null,
        (failure: unknown) => failure,
      );

      if (mode === 'fail') {
        expect(error).toMatchObject({ message: 'MCP configuration failed after auto-ensure' });
      } else {
        expect(error).toBeNull();
      }
      const checks = await Promise.all(runChecks.mock.results.map(({ value }) => value));
      const surfaced = JSON.stringify([logCalls, checks, error, (error as Error | null)?.message]);
      expect(surfaced).not.toContain(sentinel);
      expect(ensureMcp).toHaveBeenCalledTimes(1);
    },
  );

  it('runs overlapping repairs of one home one at a time, and gives two homes their own', async () => {
    const overlaps = join(root, 'overlaps.log');
    const otherHome = join(root, 'other-codex');
    await mkdir(otherHome);
    const repair = (env: Record<string, string>) =>
      stack.ensure.ensureMcp(stack.provider, project, {
        env: { FAKE_CODEX_SLOW: overlaps, ...env },
      });

    const results = await Promise.all([
      repair({ CODEX_HOME: configHome, UNRELATED: 'a' }),
      repair({ CODEX_HOME: configHome, UNRELATED: 'b' }),
      repair({ CODEX_HOME: otherHome }),
    ]);

    expect(results.map((result) => result.success)).toEqual([true, true, true]);
    await expect(readFile(overlaps, 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' });
    for (const home of [configHome, otherHome]) {
      expect(await readFile(join(home, 'mcp.txt'), 'utf-8')).toMatch(/^devchain http/);
    }
  });

  it('checks in process.env when the caller gives no environment', async () => {
    await readiness(stack, project, null);

    expect(await mcpStatuses(stack, runChecks)).toEqual(['pass']);
    expect(ensureMcp).not.toHaveBeenCalled();
    expect(await readdir(configHome)).toEqual([]);
  });
});

// Keeps registrations under `${COPILOT_HOME:-$HOME/.copilot}/mcp.txt` and lists them as JSON.
const FAKE_COPILOT = `#!/bin/sh
home="\${COPILOT_HOME:-$HOME/.copilot}"
mkdir -p "$home"
file="$home/mcp.txt"
touch "$file"
case "$1 $2" in
  "mcp list") awk 'BEGIN { printf "{\\"mcpServers\\":{" }
    { if (NR > 1) printf ","; printf "\\"%s\\":{\\"type\\":\\"http\\",\\"url\\":\\"%s\\"}", $1, $2 }
    END { print "}}" }' "$file" ;;
  "mcp add") { grep -v "^$5 " "$file" || true; echo "$5 $6"; } > "$file.tmp" && mv "$file.tmp" "$file" ;;
  "mcp remove") { grep -v "^$3 " "$file" || true; } > "$file.tmp" && mv "$file.tmp" "$file" ;;
  *) exit 2 ;;
esac
`;

describe('ensureMcpReadiness in the session launch environment (Copilot homes)', () => {
  const saved = { ...process.env };
  let root: string;
  let ambientHome: string;
  let launchHome: string;
  let project: string;
  let stack: McpStack;
  let runChecks: jest.SpyInstance;
  let ensureMcp: jest.SpyInstance;

  beforeEach(async () => {
    logCalls.length = 0;
    root = await mkdtemp(join(tmpdir(), 'mcp-copilot-homes-'));
    ambientHome = join(root, 'ambient-copilot');
    launchHome = join(root, 'home', '.copilot');
    project = join(root, 'project');
    await Promise.all([mkdir(ambientHome), mkdir(launchHome, { recursive: true }), mkdir(project)]);
    // DevChain itself runs with COPILOT_HOME set; a launched session clears it and uses
    // `$HOME/.copilot`. Both homes are inside `root`.
    process.env.HOME = join(root, 'home');
    process.env.COPILOT_HOME = ambientHome;
    await writeFile(join(ambientHome, 'mcp.txt'), `devchain ${endpoint()}\n`);
    const copilotBin = join(root, 'copilot');
    await writeFile(copilotBin, FAKE_COPILOT);
    await chmod(copilotBin, 0o755);
    const adapter = new CopilotAdapter(
      { ensure: async () => ({ warnings: [] }) } as never,
      { isAuthenticated: async () => true } as never,
    );
    stack = createMcpStack('copilot', adapter, copilotBin, project);
    runChecks = jest.spyOn(stack.preflight, 'runChecks');
    ensureMcp = jest.spyOn(stack.ensure, 'ensureMcp');
  });

  afterEach(async () => {
    process.env = { ...saved };
    await rm(root, { recursive: true, force: true });
  });

  it('checks and repairs the launch account, not an inherited COPILOT_HOME', async () => {
    const ambientBefore = await readFile(join(ambientHome, 'mcp.txt'), 'utf-8');

    await readiness(stack, project, null);

    expect(await mcpStatuses(stack, runChecks)).toEqual(['warn', 'pass']);
    expect(ensureMcp).toHaveBeenCalledTimes(1);
    expect(await readFile(join(launchHome, 'mcp.txt'), 'utf-8')).toMatch(/^devchain http/);
    expect(await readFile(join(ambientHome, 'mcp.txt'), 'utf-8')).toBe(ambientBefore);
  });

  it('lists in the inherited COPILOT_HOME without a session environment, as the Providers page does', async () => {
    const result = await stack.registration.listRegistrations(stack.provider, { cwd: project });

    expect(result.entries).toEqual([
      expect.objectContaining({ alias: 'devchain', endpoint: endpoint() }),
    ]);
  });

  it('refuses a config COPILOT_HOME before any check or write, and names no value', async () => {
    const secretHome = join(root, 'secret-copilot-home');

    const refused = readiness(stack, project, { COPILOT_HOME: secretHome });

    await expect(refused).rejects.toMatchObject({
      message: expect.stringContaining('COPILOT_HOME is not supported for the copilot provider'),
    });
    const error = await refused.catch((failure: unknown) => failure);
    expect(JSON.stringify([error, (error as Error).message, logCalls])).not.toContain(secretHome);
    expect(runChecks).not.toHaveBeenCalled();
    expect(ensureMcp).not.toHaveBeenCalled();
    expect(await readdir(launchHome)).toEqual([]);
  });
});
