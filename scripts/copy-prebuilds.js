/**
 * Copy native module prebuilds to the package prebuilds directory.
 * Run this during build to bundle prebuilds with the published package.
 */

const { cpSync, existsSync, mkdirSync, rmSync } = require('fs');
const { join, dirname } = require('path');

const ROOT_DIR = join(__dirname, '..');
const PREBUILDS_DIR = join(ROOT_DIR, 'prebuilds');

const MODULES_TO_BUNDLE = [
  {
    name: 'node-pty',
    // Try multiple locations for monorepo compatibility
    locations: [
      join(ROOT_DIR, 'node_modules', 'node-pty', 'prebuilds'),
      join(ROOT_DIR, 'apps', 'local-app', 'node_modules', 'node-pty', 'prebuilds'),
    ],
  },
];

function copyPrebuilds() {
  console.log('[copy-prebuilds] Bundling native module prebuilds...');

  for (const mod of MODULES_TO_BUNDLE) {
    const destDir = join(PREBUILDS_DIR, mod.name);

    // Find the first existing source
    let srcDir = null;
    for (const loc of mod.locations) {
      if (existsSync(loc)) {
        srcDir = loc;
        break;
      }
    }

    if (!srcDir) {
      console.warn(`[copy-prebuilds] WARN: No prebuilds found for ${mod.name}`);
      console.warn(`  Searched: ${mod.locations.join(', ')}`);
      continue;
    }

    // Clean and recreate destination
    if (existsSync(destDir)) {
      rmSync(destDir, { recursive: true });
    }
    mkdirSync(destDir, { recursive: true });

    // Copy prebuilds
    cpSync(srcDir, destDir, { recursive: true });
    console.log(`[copy-prebuilds] Copied ${mod.name} prebuilds from ${srcDir}`);
  }

  console.log('[copy-prebuilds] Done.');
}

copyPrebuilds();
