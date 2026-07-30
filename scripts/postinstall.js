/*
  Postinstall verifier for native deps.
  - Restores bundled node-pty prebuilds if available.
  - Verifies the bundled better-sqlite3 artifact can open, query, and close.
  - Fails installation when better-sqlite3 is unusable.
*/

/* eslint-disable no-console */
const { dirname, join } = require('path');
const { existsSync, cpSync, mkdirSync } = require('fs');

/**
 * Restore bundled node-pty prebuilds to node_modules/node-pty/prebuilds.
 * This ensures users without build tools can still install.
 */
function restoreNodePtyPrebuilds() {
  const bundledDir = join(__dirname, '..', 'prebuilds', 'node-pty');
  if (!existsSync(bundledDir)) {
    // No bundled prebuilds, node-pty will use its own or compile
    return;
  }

  let nodePtyDir;
  try {
    const nodePtyPkg = require.resolve('node-pty/package.json');
    nodePtyDir = dirname(nodePtyPkg);
  } catch {
    console.warn('[devchain] node-pty not found, skipping prebuild restore');
    return;
  }

  const targetDir = join(nodePtyDir, 'prebuilds');
  const platformDir = `${process.platform}-${process.arch}`;
  const bundledPlatformDir = join(bundledDir, platformDir);
  const targetPlatformDir = join(targetDir, platformDir);

  // Only copy if we have prebuilds for this platform and target doesn't exist
  if (!existsSync(bundledPlatformDir)) {
    console.log(`[devchain] No bundled node-pty prebuilds for ${platformDir}`);
    return;
  }

  if (existsSync(targetPlatformDir)) {
    console.log('[devchain] node-pty prebuilds already present');
    return;
  }

  try {
    mkdirSync(targetDir, { recursive: true });
    cpSync(bundledPlatformDir, targetPlatformDir, { recursive: true });
    console.log(`[devchain] Restored node-pty prebuilds for ${platformDir}`);
  } catch (e) {
    console.warn('[devchain] Failed to restore node-pty prebuilds:', String(e && e.message || e));
  }
}

function tryLoad() {
  let db;
  try {
    const Database = require('better-sqlite3');
    db = new Database(':memory:');
    db.prepare('select 1').get();
    db.close();
    db = undefined;
    return true;
  } catch (e) {
    console.warn('[devchain] better-sqlite3 failed to load:', String(e && e.message || e));
    return false;
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        // The original load/query/close error is the actionable failure.
      }
    }
  }
}

function main() {
  if (process.env.DEVCHAIN_SKIP_POSTINSTALL) {
    console.log('[devchain] Skipping postinstall per DEVCHAIN_SKIP_POSTINSTALL');
    return;
  }

  // Restore bundled node-pty prebuilds first (before npm tries to compile)
  restoreNodePtyPrebuilds();

  if (tryLoad()) {
    console.log('[devchain] better-sqlite3 bundled artifact verified.');
    return;
  }

  console.error(
    `[devchain] better-sqlite3's bundled artifact is unavailable for ${process.platform}-${process.arch}.`,
  );
  process.exitCode = 1;
}

main();
