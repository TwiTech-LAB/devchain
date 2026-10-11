// File-level tests exercise YAML ranges and edits without a Docker engine or CLI.
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyComposeUserFix, composeUserFixProposal } from './docker-compose-user-fix';
import type { DockerOwnershipDecision, DockerUserFixProposal } from './docker-plan.dto';

let root: string;
let file: string;
let ownership: DockerOwnershipDecision;
const id = '33333333-3333-4333-8333-333333333333';
const replacement = '${DEVCHAIN_UID:-1000}:${DEVCHAIN_GID:-1000}';
const propose = () =>
  composeUserFixProposal(root, ownership, 'web-1', id) as Promise<DockerUserFixProposal>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'compose-user-fix-'));
  file = join(root, 'compose.yaml');
  ownership = {
    class: 'needs-user-fix',
    home: { uid: 1000, gid: 1000 },
    vm: { uid: 1001, gid: 1002 },
    compose: { directory: root, files: [file], service: 'web' },
  };
});
afterEach(async () => rm(root, { recursive: true, force: true }));

it.each(['"1000:1000"', "'1000:1000'", '1000:1000'])(
  'edits only the %s scalar and preserves Unicode, comments, CRLF, and file permissions',
  async (scalar) => {
    const before = `# λ config\r\nservices:\r\n  web:\r\n    image: busybox # retain\r\n    user: ${scalar}  # home owner\r\n    environment: [SECRET=keep-private]\r\n`;
    await writeFile(file, before, { mode: 0o640 });
    const proposal = await propose();
    expect(proposal).toMatchObject({
      id,
      service: 'web',
      container: 'web-1',
      file,
      line: 5,
      oldUser: '1000:1000',
      newUser: replacement,
      canApply: true,
    });
    expect(proposal.hint).toBe(
      'On this VM your user id is 1001. With this line, the container runs as your user on each machine: 1000 here, 1001 on the VM. Shells outside DevChain use the fallback, so `docker compose up` in a normal terminal at home keeps running as you.',
    );
    await applyComposeUserFix(root, proposal);
    const quote = /^["']/.exec(scalar)?.[0] ?? '';
    expect(await readFile(file, 'utf8')).toBe(
      before.replace(scalar, `${quote}${replacement}${quote}`),
    );
    expect((await stat(file)).mode & 0o777).toBe(0o640);
    expect(JSON.stringify(proposal)).not.toContain('keep-private');
  },
);

it.each(['1000', '"1000"', "'1000'"])('proposes only the uid for %s', async (scalar) => {
  await writeFile(file, `services:\n  web:\n    user: ${scalar}\n`);
  const proposal = await propose();
  expect(proposal.newUser).toBe('${DEVCHAIN_UID:-1000}');
  await applyComposeUserFix(root, proposal);
  expect(await readFile(file, 'utf8')).not.toContain('DEVCHAIN_GID');
});

it.each([
  ['scalar anchor', 'services:\n  web:\n    user: &owner "1000:1000"\n'],
  ['alias', 'x-owner: &owner "1000:1000"\nservices:\n  web:\n    user: *owner\n'],
  ['service alias', 'x-web: &web {user: "1000:1000"}\nservices:\n  web: *web\n'],
  [
    'extends',
    'services:\n  web:\n    extends: {file: base.yaml, service: web}\n    user: "1000:1000"\n',
  ],
  ['include', 'include: [base.yaml]\nservices:\n  web:\n    user: "1000:1000"\n'],
  ['interpolation', 'services:\n  web:\n    user: "${OTHER_UID:-1000}:${OTHER_GID:-1000}"\n'],
  ['folded scalar', 'services:\n  web:\n    user: >-\n      1000:1000\n'],
  ['missing user', 'services:\n  web:\n    image: busybox\n'],
  ['duplicate key', 'services:\n  web:\n    user: "1000:1000"\n    user: "1000"\n'],
  ['invalid YAML', 'services: [SECRET=parser-errors-must-stay-private\n'],
])('shows a manual proposal and refuses Apply for %s', async (_name, text) => {
  await writeFile(file, text);
  const proposal = await propose();
  expect(proposal.canApply).toBe(false);
  expect(proposal.reason).toBeTruthy();
  expect(JSON.stringify(proposal)).not.toContain('parser-errors-must-stay-private');
  await expect(applyComposeUserFix(root, proposal)).rejects.toMatchObject({
    code: 'DOCKER_USER_FIX_SHOW_ONLY',
  });
  expect(await readFile(file, 'utf8')).toBe(text);
});

it('shows the last source scalar but refuses Apply for several Compose files', async () => {
  const override = join(root, 'override.yaml');
  await writeFile(file, 'services:\n  web:\n    user: "1000"\n');
  await writeFile(override, 'services:\n  web:\n    user: "1000:1000"\n');
  ownership.compose!.files.push(override);
  expect(await propose()).toMatchObject({
    file: override,
    line: 3,
    oldUser: '1000:1000',
    canApply: false,
    reason: expect.stringContaining('Several Compose files'),
  });
});

it('shows an image user line to add without offering Apply', async () => {
  ownership.class = 'image-user-hint';
  await writeFile(file, 'services:\n  web:\n    image: busybox\n');
  const proposal = await propose();
  expect(proposal).toMatchObject({
    file,
    oldUser: null,
    newUser: replacement,
    canApply: false,
    reason: expect.stringContaining('Add this user line'),
  });
});

it('refuses a changed scalar and leaves the edited file untouched', async () => {
  await writeFile(file, 'services:\n  web:\n    user: "1000:1000"\n');
  const proposal = await propose();
  const changed = 'services:\n  web:\n    user: "2000:2000"\n';
  await writeFile(file, changed);
  await expect(applyComposeUserFix(root, proposal)).rejects.toMatchObject({
    code: 'DOCKER_USER_FIX_STALE',
    statusCode: 409,
  });
  expect(await readFile(file, 'utf8')).toBe(changed);
});

it('allows an unrelated edit while checking the planned scalar, then preserves that edit', async () => {
  await writeFile(file, 'services:\n  web:\n    user: "1000:1000"\n');
  const proposal = await propose();
  await writeFile(
    file,
    '# added since planning\nservices:\n  web:\n    user: "1000:1000" # keep\n',
  );
  await applyComposeUserFix(root, proposal);
  expect(await readFile(file, 'utf8')).toBe(
    `# added since planning\nservices:\n  web:\n    user: "${replacement}" # keep\n`,
  );
});

it('re-checks show-only restrictions added after the plan', async () => {
  await writeFile(file, 'services:\n  web:\n    user: "1000:1000"\n');
  const proposal = await propose();
  const changed = 'include: [extra.yaml]\nservices:\n  web:\n    user: "1000:1000"\n';
  await writeFile(file, changed);
  await expect(applyComposeUserFix(root, proposal)).rejects.toMatchObject({
    code: 'DOCKER_USER_FIX_SHOW_ONLY',
  });
  expect(await readFile(file, 'utf8')).toBe(changed);
});

it('refuses a symlink replacing the server-known file', async () => {
  await writeFile(file, 'services:\n  web:\n    user: "1000:1000"\n');
  const proposal = await propose();
  const other = join(root, 'other.yaml');
  await writeFile(other, 'services:\n  web:\n    user: "1000:1000"\n');
  await rm(file);
  await symlink(other, file);
  await expect(applyComposeUserFix(root, proposal)).rejects.toMatchObject({
    code: 'DOCKER_USER_FIX_STALE',
  });
  expect(await readFile(other, 'utf8')).not.toContain('DEVCHAIN_UID');
});

it('does not offer Apply when the cached Compose result no longer matches the source user', async () => {
  await writeFile(file, 'services:\n  web:\n    user: "2000"\n');
  expect(await composeUserFixProposal(root, ownership, 'web-1', id, '1000')).toMatchObject({
    canApply: false,
    reason: expect.stringContaining('no longer matches'),
  });
});

it('quotes a replacement inside a flow mapping while preserving the surrounding layout', async () => {
  await writeFile(file, 'services: {web: {image: busybox, user: 1000}} # keep\n');
  await applyComposeUserFix(root, await propose());
  expect(await readFile(file, 'utf8')).toBe(
    'services: {web: {image: busybox, user: "${DEVCHAIN_UID:-1000}"}} # keep\n',
  );
});

it('locates an unstarted project service in a single default Compose file', async () => {
  ownership.compose!.files = [];
  await writeFile(file, 'services:\n  web:\n    user: "1000:1000"\n');
  expect(await propose()).toMatchObject({ file, line: 3, canApply: true });
  await writeFile(join(root, 'compose.override.yaml'), 'services:\n  web:\n    user: "1000"\n');
  expect(await propose()).toMatchObject({
    canApply: false,
    reason: expect.stringContaining('Several Compose files'),
  });
});

it('keeps an environment-selected root Compose file set show-only', async () => {
  ownership.compose!.files = [];
  await writeFile(file, 'services:\n  web:\n    user: "1000:1000"\n');
  await writeFile(join(root, '.env'), 'COMPOSE_FILE=compose.yaml\nSECRET=must-never-escape\n');
  const proposal = await propose();
  expect(proposal).toMatchObject({
    file,
    line: 3,
    canApply: false,
    reason: expect.stringContaining('selected through the environment'),
  });
  expect(JSON.stringify(proposal)).not.toContain('must-never-escape');
});
