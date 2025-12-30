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
      main: 'index.js',
      types: 'index.d.ts',
    };
    writeFileSync(join(sharedDest, 'package.json'), JSON.stringify(sharedPkg, null, 2));
    // eslint-disable-next-line no-console
    console.log(`Copied @devchain/shared to ${sharedDest}`);
  }
}

main();

