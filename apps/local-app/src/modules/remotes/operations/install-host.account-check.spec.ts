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

  it('exits 0 with no output when the home folder matches', () => {
    const result = run({ user: userName, home: homePath });
    expect(result).toMatchObject({ status: 0, stdout: '' });
  });

  it('exits 10 with the current home folder on stdout when it differs', () => {
    const result = run({ user: userName, home: '/srv/other home' });
    expect(result).toMatchObject({ status: 10, stdout: '/srv/other home' });
  });

  it("keeps getent's exit 2 when the account does not exist", () => {
    const result = run({ user: 'someone-else', home: homePath });
    expect(result).toMatchObject({ status: 2, stdout: '' });
  });
});
