const { cpSync, rmSync, mkdirSync, existsSync, writeFileSync } = require('fs');
const { join } = require('path');

function main() {
  const src = join(__dirname, '..', 'apps', 'local-app', 'dist');
  const dest = join(__dirname, '..', 'dist', 'server');
  const migrationsSrc = join(__dirname, '..', 'apps', 'local-app', 'drizzle');
  const migrationsDest = join(__dirname, '..', 'dist', 'drizzle');
  const templatesSrc = join(__dirname, '..', 'apps', 'local-app', 'templates');
  const templatesDest = join(__dirname, '..', 'dist', 'templates');
  const sharedSrc = join(__dirname, '..', 'packages', 'shared', 'dist');
  const sharedDest = join(__dirname, '..', 'dist', 'node_modules', '@devchain', 'shared');
  const proxmoxRoot = join(__dirname, '..', 'packages', 'proxmox-client');
  const proxmoxDist = join(proxmoxRoot, 'dist');
  const proxmoxPackage = join(proxmoxRoot, 'package.json');
  const proxmoxDest = join(
    __dirname,
    '..',
    'dist',
    'node_modules',
    '@devchain',
    'proxmox-client',
  );
  const overviewDest = join(
    __dirname,
    '..',
    'dist',
    'node_modules',
    '@devchain',
    'codebase-overview',
  );
  if (!existsSync(proxmoxDist) || !existsSync(proxmoxPackage)) {
    throw new Error(
      'Build @devchain/proxmox-client before packaging the Local App.',
    );
  }

  // This type-only package no longer exists, but dirty incremental builds may
  // still contain a previously materialized copy that must not reach npm packages.
  rmSync(overviewDest, { recursive: true, force: true });

  // Clean dest
  if (existsSync(dest)) {
    rmSync(dest, { recursive: true, force: true });
  }
  mkdirSync(dest, { recursive: true });

  // Copy recursively (Node >=16 supports recursive cpSync)
  cpSync(src, dest, { recursive: true });
  // eslint-disable-next-line no-console
  console.log(`Copied local-app build to ${dest}`);

  // Copy migrations folder
  if (existsSync(migrationsSrc)) {
    if (existsSync(migrationsDest)) {
      rmSync(migrationsDest, { recursive: true, force: true });
    }
    cpSync(migrationsSrc, migrationsDest, { recursive: true });
    // eslint-disable-next-line no-console
    console.log(`Copied migrations to ${migrationsDest}`);
  }

  // Copy templates folder
  if (existsSync(templatesSrc)) {
    if (existsSync(templatesDest)) {
      rmSync(templatesDest, { recursive: true, force: true });
    }
    cpSync(templatesSrc, templatesDest, { recursive: true });
    // eslint-disable-next-line no-console
    console.log(`Copied templates to ${templatesDest}`);
  }

  // Copy @devchain/shared package for runtime resolution
  if (existsSync(sharedSrc)) {
    if (existsSync(sharedDest)) {
      rmSync(sharedDest, { recursive: true, force: true });
    }
    mkdirSync(sharedDest, { recursive: true });
    cpSync(sharedSrc, sharedDest, { recursive: true });
    // Create a minimal package.json for module resolution
    const sharedPkg = {
      name: '@devchain/shared',
      version: '0.0.0',
      type: 'module',
      main: 'index.js',
      module: 'index.js',
      types: 'index.d.ts',
    };
    writeFileSync(join(sharedDest, 'package.json'), JSON.stringify(sharedPkg, null, 2));
    // eslint-disable-next-line no-console
    console.log(`Copied @devchain/shared to ${sharedDest}`);
  }

  rmSync(proxmoxDest, { recursive: true, force: true });
  mkdirSync(proxmoxDest, { recursive: true });
  cpSync(proxmoxDist, join(proxmoxDest, 'dist'), { recursive: true });
  cpSync(proxmoxPackage, join(proxmoxDest, 'package.json'));
  // eslint-disable-next-line no-console
  console.log(`Copied @devchain/proxmox-client to ${proxmoxDest}`);
}

main();
