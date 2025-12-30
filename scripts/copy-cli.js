const { cpSync, mkdirSync, existsSync, chmodSync } = require('fs');
const { join } = require('path');

function main() {
  const src = join(__dirname, 'cli.js');
  const destDir = join(__dirname, '..', 'dist');
  const dest = join(destDir, 'cli.js');
  const libSrcDir = join(__dirname, 'lib');
  const libDestDir = join(destDir, 'lib');

  // Ensure dest dir exists
  if (!existsSync(destDir)) {
    mkdirSync(destDir, { recursive: true });
  }

  // Copy CLI file
  cpSync(src, dest);

  // Make it executable
  chmodSync(dest, 0o755);

  // Copy CLI support library (e.g., interactive-cli)
  // Ensure the lib directory exists and copy recursively so runtime requires work from dist
  if (existsSync(libSrcDir)) {
    mkdirSync(libDestDir, { recursive: true });
    cpSync(libSrcDir, libDestDir, { recursive: true });
  }

  // eslint-disable-next-line no-console
  console.log(`Copied CLI to ${dest}`);
  if (existsSync(libDestDir)) {
    console.log(`Copied CLI lib to ${libDestDir}`);
  }
}

main();
