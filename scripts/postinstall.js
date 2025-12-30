/*
  Postinstall verifier for native deps.
  - Verifies better-sqlite3 can load.
  - If not, attempts a rebuild.
  - Provides actionable errors without failing install unless absolutely necessary.
*/

/* eslint-disable no-console */
const { spawnSync } = require('child_process');
const { dirname } = require('path');

function tryLoad() {
  try {
    const Database = require('better-sqlite3');
    const db = new Database(':memory:');
    db.prepare('select 1').get();
    return true;
  } catch (e) {
    console.warn('[devchain] better-sqlite3 failed to load:', String(e && e.message || e));
    return false;
  }
}

async function main() {
  if (process.env.DEVCHAIN_SKIP_POSTINSTALL) {
    console.log('[devchain] Skipping postinstall per DEVCHAIN_SKIP_POSTINSTALL');
    return;
  }

  if (tryLoad()) {
    console.log('[devchain] better-sqlite3 prebuild present.');
    return;
  }

  // Prefer fetching upstream prebuilds for better-sqlite3
  try {
    const prebuildInstallBin = require.resolve('prebuild-install/bin.js');
    const betterPkg = require.resolve('better-sqlite3/package.json');
    const betterDir = dirname(betterPkg);
    console.log('[devchain] Attempting to fetch better-sqlite3 prebuilds via prebuild-install...');
    const pr = spawnSync(process.execPath, [prebuildInstallBin], {
      stdio: 'inherit',
      cwd: betterDir,
    });
    if (pr.status === 0 && tryLoad()) {
      console.log('[devchain] better-sqlite3 prebuild installed.');
      return;
    }
  } catch (e) {
    console.warn('[devchain] prebuild-install not available or failed:', String(e && e.message || e));
  }

  console.log('[devchain] Attempting `npm rebuild better-sqlite3` to compile native binary...');
  const res = spawnSync(process.env.npm_execpath || 'npm', ['rebuild', 'better-sqlite3'], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  if (res.status !== 0) {
    console.warn('[devchain] Rebuild failed. You may need build tools (python3, make, C/C++ toolchain).');
  }

  if (!tryLoad()) {
    const supported = (process.platform === 'linux' || process.platform === 'darwin') &&
      (process.arch === 'x64' || process.arch === 'arm64');
    console.error('[devchain] better-sqlite3 is not available. Devchain may not run without it.');
    if (!supported) {
      console.error(`[devchain] Unsupported platform/arch for prebuilds: ${process.platform}-${process.arch}.`);
      console.error('Please use a supported platform (linux/darwin x64/arm64) or install build tools to compile from source.');
    } else {
      console.error('If you lack compilers, ensure your platform is supported by better-sqlite3 prebuilds or install build tools.');
    }
  }
}

main().catch((e) => {
  console.error('[devchain] postinstall error:', e);
});
