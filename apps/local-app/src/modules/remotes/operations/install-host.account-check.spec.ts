import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accountHomeCheckCommand } from './install-host.operation';

// Exit codes and quoting are shell semantics; only a real POSIX sh proves them. A stub getent
// on PATH stands in for the VM's account database.
describe('accountHomeCheckCommand', () => {
  const userName = "o'brien x";
  const homePath = "/home/o'brien $HOME x";
  let fakeBin: string;

  beforeAll(() => {
    fakeBin = mkdtempSync(join(tmpdir(), 'devchain-account-check-'));
    writeFileSync(
      join(fakeBin, 'getent'),
      '#!/bin/sh\n' +
        '[ "$1" = passwd ] && [ "$2" = "$FAKE_USER" ] || exit 2\n' +
        `printf '%s:x:1000:1000::%s:/bin/bash\\n' "$2" "$FAKE_HOME"\n`,
    );
    chmodSync(join(fakeBin, 'getent'), 0o755);
  });

  afterAll(() => rmSync(fakeBin, { recursive: true, force: true }));

  function run(account: { user: string; home: string }) {
    // sshd hands the command string to the login shell as `-c <command>`.
    return spawnSync('/bin/sh', ['-c', accountHomeCheckCommand(userName, homePath)], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        FAKE_USER: account.user,
        FAKE_HOME: account.home,
      },
    });
  }

  it.each([
    ['matching home', { user: userName, home: homePath }, 0, ''],
    ['different home', { user: userName, home: '/srv/other home' }, 10, '/srv/other home'],
    ['missing account', { user: 'someone-else', home: homePath }, 2, ''],
  ] as const)('reports shell exit and output for %s', (_case, account, status, stdout) => {
    expect(run(account)).toMatchObject({ status, stdout });
  });
});
