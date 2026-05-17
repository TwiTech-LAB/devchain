import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

function listSourceFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  return entries.flatMap((entry) => {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      return listSourceFiles(path);
    }
    return /\.(ts|tsx)$/.test(entry) ? [path] : [];
  });
}

describe('Registry/Projects boundary', () => {
  const registryDir = join(__dirname, '..', 'modules', 'registry');
  const forbiddenTokens = [
    'Projects' + 'Service',
    'Projects' + 'Module',
    'Project' + 'TemplateUpgradeService',
    'Project' + 'RegistryImportService',
    'ModuleRef',
  ];

  it('keeps Registry source free of Projects-owned service/module tokens', () => {
    const offenders = listSourceFiles(registryDir).flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      return forbiddenTokens
        .filter((token) => source.includes(token))
        .map((token) => `${relative(registryDir, file)} contains ${token}`);
    });

    expect(offenders).toEqual([]);
  });

  it('does not import ProjectsModule from RegistryModule', () => {
    const moduleSource = readFileSync(join(registryDir, 'registry.module.ts'), 'utf8');

    expect(moduleSource).not.toContain('Projects' + 'Module');
    expect(moduleSource).not.toContain('forwardRef');
  });
});
