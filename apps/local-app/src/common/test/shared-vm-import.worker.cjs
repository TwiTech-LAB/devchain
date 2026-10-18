// A real second SQLite writer pauses the production import after fence admission.
// Only the machine-wide fence filename is mapped into the test VM's filesystem.
const { parentPort, workerData } = require('node:worker_threads');
const path = require('node:path');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
require('reflect-metadata');
require('ts-node').register({
  project: path.join(workerData.appRoot, 'tsconfig.json'),
  transpileOnly: true,
  compilerOptions: { module: 'commonjs' },
});
const Database = require('better-sqlite3');
const { drizzle } = require('drizzle-orm/better-sqlite3');
const { LocalStorageService } = require(path.join(workerData.appRoot, 'src/modules/storage/local/local-storage.service.ts'));
const sqlite = new Database(workerData.database);
parentPort.postMessage({ phase: 'ready' });
const gate = new Int32Array(workerData.gate);
const originalRead = fs.readFileSync;
fs.readFileSync = function (file, ...args) {
  if (file !== '/etc/devchain-host/fence.json') return originalRead.call(fs, file, ...args);
  let value;
  let failure;
  try { value = originalRead.call(fs, workerData.fenceFile, ...args); } catch (error) { failure = error; }
  if (workerData.pause && failure?.code === 'ENOENT') {
    if (!sqlite.inTransaction) throw new Error('Admission did not run inside the write transaction');
    parentPort.postMessage({ phase: 'admitted' });
    if (Atomics.wait(gate, 0, 0, 10000) === 'timed-out') throw new Error('Roster did not reach the admitted writer');
    // The fixture releases at the native immediate-lock attempt, or after a
    // plain SELECT captures its rows. Only the busy-bound case delays commit.
    if (workerData.commitDelayMs) Atomics.wait(gate, 1, 0, workerData.commitDelayMs);
  }
  if (failure) throw failure;
  return value;
};
(async () => {
  try {
    const storage = new LocalStorageService(drizzle(sqlite));
    const now = new Date().toISOString();
    await storage.applyProjectReplica(workerData.replica, 'full', (summary) => ({
      id: randomUUID(), name: 'remote.project.synced', requestId: null, publishedAt: now,
      payload: { projectId: summary.projectId, changedEpicIds: summary.changedEpicIds,
        deletedEpicIds: summary.deletedEpicIds, workspaceId: workerData.replica.workspace.id,
        remoteId: null, cursor: now },
    }), { frozenAt: now, requireNewProjects: true });
    sqlite.close();
    parentPort.postMessage({ phase: 'done', committed: true });
  } catch (error) {
    sqlite.close();
    parentPort.postMessage({ phase: 'done', committed: false, code: error.code, message: error.message });
  }
})();
