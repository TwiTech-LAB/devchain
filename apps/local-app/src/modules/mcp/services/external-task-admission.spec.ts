import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { externalTaskAdmission } from './external-task-admission';

describe('externalTaskAdmission', () => {
  let etcDir: string;

  beforeEach(() => {
    etcDir = mkdtempSync(join(tmpdir(), 'devchain-host-etc-'));
  });

  afterEach(() => {
    rmSync(etcDir, { recursive: true, force: true });
  });

  it('admits a loopback-bound app', () => {
    expect(externalTaskAdmission({ HOST: '127.0.0.1', DEVCHAIN_HOST_ETC_DIR: etcDir })).toBe(true);
  });

  it('refuses a non-loopback home that is not a claimed host', () => {
    expect(externalTaskAdmission({ HOST: '0.0.0.0', DEVCHAIN_HOST_ETC_DIR: etcDir })).toBe(false);
  });

  it('admits a claimed host bound to the network', () => {
    writeFileSync(join(etcDir, 'claim.json'), '{}');

    expect(externalTaskAdmission({ HOST: '0.0.0.0', DEVCHAIN_HOST_ETC_DIR: etcDir })).toBe(true);
  });
});
