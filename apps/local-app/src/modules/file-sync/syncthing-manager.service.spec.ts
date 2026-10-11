import { Test, type TestingModule } from '@nestjs/testing';
import fs from 'fs';
import disk from 'fs/promises';
import { createLogger } from '../../common/logging/logger';
import { FILE_SYNC_PATHS, createProductionFileSyncPaths } from './file-sync-paths';
import { SyncthingLauncher, type SyncthingProcess } from './syncthing-launcher';
import { SyncthingRestClient } from './syncthing-rest.client';
import { SyncthingSettingsStore } from './syncthing-settings.store';
import {
  DEFAULT_SYNCTHING_MANAGER_TIMINGS,
  SYNCTHING_MANAGER_TIMINGS,
  SyncthingManager,
} from './syncthing-manager.service';

// Unit: launch decisions and folder PATCHes are observable through mocked OS/REST boundaries.
jest.mock('net', () => {
  let port = 12000;
  return {
    createServer: () => ({
      once: jest.fn(),
      listen: (_port: number, _host: string, ready: () => void) => ready(),
      address: () => ({ port: port++ }),
      close: (closed: () => void) => closed(),
    }),
  };
});
jest.mock('../../common/logging/logger', () => ({
  createLogger: jest.fn(() => ({ warn: jest.fn(), info: jest.fn() })),
}));

const managerLogger = jest
  .mocked(createLogger)
  .mock.results.find((r, i) => jest.mocked(createLogger).mock.calls[i][0] === 'SyncthingManager')
  ?.value as { warn: jest.Mock };

describe('SyncthingManager ownership', () => {
  let moduleRef: TestingModule;
  let manager: SyncthingManager;
  let folders: Array<{ id: string; copyOwnershipFromParent?: boolean }>;
  let worker: SyncthingProcess;
  let exited: () => void;
  let alive: boolean;
  const launcher = {
    findBinary: jest.fn(),
    spawn: jest.fn(),
    findChildPid: jest.fn(),
    hasOwnershipCapabilities: jest.fn(),
    isAlive: jest.fn(),
    kill: jest.fn(),
  };

  beforeEach(async () => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    jest.spyOn(disk, 'mkdir').mockResolvedValue(undefined);
    jest.spyOn(fs, 'existsSync').mockReturnValue(false);
    jest.spyOn(SyncthingRestClient.prototype, 'ping').mockResolvedValue();
    jest.spyOn(SyncthingRestClient.prototype, 'patchOptions').mockResolvedValue();
    jest.spyOn(SyncthingRestClient.prototype, 'restartRequired').mockResolvedValue(false);
    jest.spyOn(SyncthingRestClient.prototype, 'deviceId').mockResolvedValue('VM');
    jest.spyOn(SyncthingRestClient.prototype, 'shutdown').mockImplementation(async () => {
      alive = false;
      exited();
    });
    folders = [
      { id: 'code:p1', copyOwnershipFromParent: false },
      { id: 'git:p1' },
      { id: 'other', copyOwnershipFromParent: false },
    ];
    jest
      .spyOn(SyncthingRestClient.prototype, 'request')
      .mockImplementation(async (method, path, body) => {
        if (method === 'GET' && path === '/rest/config/folders') return folders;
        if (method === 'PATCH') {
          const folder = folders.find((f) => path.endsWith(encodeURIComponent(f.id)));
          if (folder) Object.assign(folder, body);
        }
        return {};
      });
    launcher.findBinary.mockResolvedValue({ found: true, path: '/syncthing', version: 'v2.1.5' });
    launcher.spawn.mockImplementation(async () => {
      alive = true;
      worker = {
        pid: 100,
        exited: new Promise<void>((resolve) => {
          exited = resolve;
        }),
        hasExited: () => !alive,
      };
      return worker;
    });
    launcher.findChildPid.mockResolvedValue(101);
    launcher.hasOwnershipCapabilities.mockResolvedValue(true);
    launcher.isAlive.mockImplementation(() => alive);
    moduleRef = await Test.createTestingModule({
      providers: [
        SyncthingManager,
        { provide: SyncthingLauncher, useValue: launcher },
        { provide: FILE_SYNC_PATHS, useValue: createProductionFileSyncPaths('/home/test') },
        { provide: SyncthingSettingsStore, useValue: { read: () => null, write: jest.fn() } },
        { provide: SYNCTHING_MANAGER_TIMINGS, useValue: DEFAULT_SYNCTHING_MANAGER_TIMINGS },
      ],
    }).compile();
    manager = moduleRef.get(SyncthingManager);
  });

  afterEach(async () => {
    await moduleRef?.close();
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  async function crash(): Promise<void> {
    alive = false;
    exited();
    await jest.advanceTimersByTimeAsync(DEFAULT_SYNCTHING_MANAGER_TIMINGS.restartBaseDelayMs * 4);
  }

  it('checks the worker after API readiness and reconciles true then false on relaunch', async () => {
    await manager.ensureRunning();
    expect(launcher.hasOwnershipCapabilities).toHaveBeenCalledWith(101);
    expect(
      jest.mocked(SyncthingRestClient.prototype.ping).mock.invocationCallOrder[0],
    ).toBeLessThan(launcher.hasOwnershipCapabilities.mock.invocationCallOrder[0]);
    expect(manager.getState().privileged).toBe(true);
    expect(folders).toEqual([
      { id: 'code:p1', copyOwnershipFromParent: true },
      { id: 'git:p1', copyOwnershipFromParent: true },
      { id: 'other', copyOwnershipFromParent: false },
    ]);
    launcher.hasOwnershipCapabilities.mockResolvedValue(false);
    await crash();
    expect(manager.getState()).toMatchObject({ running: true, privileged: false });
    expect(launcher.hasOwnershipCapabilities).toHaveBeenCalledTimes(2);
    expect(folders).toEqual([
      { id: 'code:p1', copyOwnershipFromParent: false },
      { id: 'git:p1', copyOwnershipFromParent: false },
      { id: 'other', copyOwnershipFromParent: false },
    ]);
  });

  it('checks the launched PID when there is no monitor child', async () => {
    launcher.findChildPid.mockResolvedValue(null);
    await manager.ensureRunning();
    expect(launcher.hasOwnershipCapabilities).toHaveBeenCalledWith(100);
  });

  it.each([false, true])(
    'warns once only when claimed=%s across unprivileged launches',
    async (claimed) => {
      jest.mocked(fs.existsSync).mockReturnValue(claimed);
      launcher.hasOwnershipCapabilities.mockResolvedValue(false);
      await manager.ensureRunning();
      await crash();
      expect(
        managerLogger.warn.mock.calls.filter(
          ([message]) => typeof message === 'string' && message.includes('ownership capabilities'),
        ),
      ).toHaveLength(claimed ? 1 : 0);
    },
  );
});
