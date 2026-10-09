// StorageModule initialization with real persisted rows is the cheapest layer
// that verifies binding order and admission without importing remotes modules.
import { Test, type TestingModule } from '@nestjs/testing';
import { ProjectFrozenError, ProjectRemoteError } from '../../../common/errors/error-types';
import { createTestDatabase } from '../../../common/test/test-database.helper';
import { DB_CONNECTION } from '../db/db.provider';
import { LocalStorageService } from '../local/local-storage.service';
import { StorageModule } from '../storage.module';
import { ProjectWriteGate } from './project-write-gate';

describe('ProjectWriteGate in StorageModule', () => {
  it('restores persisted ownership and freezes without a remotes module', async () => {
    const database = createTestDatabase();
    let module: TestingModule | undefined;
    try {
      const storage = new LocalStorageService(database.db);
      const owned = await storage.createProject({
        name: 'Remote project',
        rootPath: '/tmp/gate-remote-project',
        description: null,
        isTemplate: false,
      });
      const frozen = await storage.createProject({
        name: 'Frozen project',
        rootPath: '/tmp/gate-frozen-project',
        description: null,
        isTemplate: false,
      });
      const remote = await storage.createRemote({
        name: 'Build VM',
        baseUrl: 'https://build.example.test',
        kind: 'address',
      });
      await storage.createRemoteProjectBinding({ projectId: owned.id, remoteId: remote.id });
      await storage.updateRemoteProjectBinding(owned.id, { state: 'remote' });
      const frozenAt = '2026-09-22T10:00:00.000Z';
      await storage.setProjectFrozen(frozen.id, frozenAt);
      module = await Test.createTestingModule({ imports: [StorageModule] })
        .overrideProvider(DB_CONNECTION)
        .useValue(database.db)
        .compile();

      await module.init();

      const gate = module.get(ProjectWriteGate);
      expect(gate.getRemoteOwner(owned.id)).toEqual({
        projectId: owned.id,
        remoteId: remote.id,
        remoteName: remote.name,
        state: 'remote',
      });
      expect(() => gate.assertWritable(owned.id)).toThrow(ProjectRemoteError);
      expect(gate.getFrozenAt(frozen.id)).toBe(frozenAt);
      expect(() => gate.assertWritable(frozen.id)).toThrow(ProjectFrozenError);
      expect(gate.listNonWritableProjectIds()).toEqual([frozen.id, owned.id]);
    } finally {
      await module?.close();
      database.sqlite.close();
    }
  });
});
