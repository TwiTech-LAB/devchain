import { randomBytes } from 'crypto';
import { chmod, mkdir, readFile, realpath, rename, stat, unlink, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
import { parse } from 'smol-toml';

const DEFAULT_CODEX_CONFIG_MODE = 0o600;
const DEFAULT_CODEX_HOME_MODE = 0o700;

export type CodexProjectTrustFailureCode =
  | 'CODEX_TRUST_CONFIG_INVALID'
  | 'CODEX_TRUST_CONFIG_READ_FAILED'
  | 'CODEX_TRUST_CONFIG_WRITE_FAILED'
  | 'CODEX_TRUST_CONFIG_VERIFY_FAILED';

export type CodexProjectTrustResult =
  | { success: true }
  | { success: false; code: CodexProjectTrustFailureCode; message: string };

interface FileLine {
  start: number;
  end: number;
  text: string;
}

type MultilineStringKind = 'basic' | 'literal' | null;

interface ProjectTableRange {
  headerEnd: number;
  end: number;
}

interface CodexProjectTrustContext {
  env?: Record<string, string>;
}

type ConfigParseResult = { success: true; value: Record<string, unknown> } | { success: false };

const writeTails = new Map<string, Promise<void>>();

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The launch env wins over this process's env; an empty value counts as unset. */
function resolveCodexHome(
  context: CodexProjectTrustContext | undefined,
  projectPath: string,
): string {
  const codexHome = context?.env?.CODEX_HOME || process.env.CODEX_HOME;
  if (codexHome) return resolve(projectPath, codexHome);
  return resolve(projectPath, context?.env?.HOME || homedir(), '.codex');
}

async function resolveProjectIdentities(projectPath: string): Promise<string[]> {
  const registeredPath = resolve(projectPath);
  try {
    const physicalPath = await realpath(registeredPath);
    return physicalPath === registeredPath ? [registeredPath] : [registeredPath, physicalPath];
  } catch {
    return [registeredPath];
  }
}

function parseConfig(raw: string): ConfigParseResult {
  try {
    const parsed: unknown = parse(raw);
    return isObjectRecord(parsed) ? { success: true, value: parsed } : { success: false };
  } catch {
    return { success: false };
  }
}

function isProjectTrusted(config: Record<string, unknown>, projectPath: string): boolean {
  const projects = config.projects;
  if (!isObjectRecord(projects)) return false;
  const projectConfig = projects[projectPath];
  return isObjectRecord(projectConfig) && projectConfig.trust_level === 'trusted';
}

function readLinesWithOffsets(content: string): FileLine[] {
  const lines: FileLine[] = [];
  let start = 0;
  while (start < content.length) {
    const newlineIndex = content.indexOf('\n', start);
    const end = newlineIndex < 0 ? content.length : newlineIndex + 1;
    const textEnd = newlineIndex < 0 ? content.length : newlineIndex;
    lines.push({ start, end, text: content.slice(start, textEnd) });
    start = end;
  }
  return lines;
}

function parseTableHeader(line: string): Record<string, unknown> | null {
  const candidate = line.trim();
  if (!candidate.startsWith('[')) return null;
  try {
    const parsed: unknown = parse(candidate);
    return isObjectRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function getProjectHeaderPath(line: string): string | null {
  const candidate = line.trim();
  if (!candidate.startsWith('[projects.') || candidate.startsWith('[[')) return null;
  const parsed = parseTableHeader(candidate);
  const projects = parsed?.projects;
  if (!isObjectRecord(projects)) return null;
  const paths = Object.keys(projects);
  if (paths.length !== 1) return null;
  const projectConfig = projects[paths[0]];
  if (!isObjectRecord(projectConfig)) return null;
  return Object.keys(projectConfig).length === 0 ? paths[0] : null;
}

function isTableHeader(line: string): boolean {
  return parseTableHeader(line) !== null;
}

function nextMultilineStringKind(line: string, current: MultilineStringKind): MultilineStringKind {
  let kind = current;
  let index = 0;
  while (index < line.length) {
    if (kind === 'basic') {
      if (line.startsWith('"""', index)) {
        kind = null;
        index += 3;
      } else if (line[index] === '\\') {
        index += 2;
      } else {
        index += 1;
      }
      continue;
    }
    if (kind === 'literal') {
      if (line.startsWith("'''", index)) {
        kind = null;
        index += 3;
      } else {
        index += 1;
      }
      continue;
    }

    const character = line[index];
    if (character === '#') break;
    if (character === '"' || character === "'") {
      const delimiter = character.repeat(3);
      if (line.startsWith(delimiter, index)) {
        kind = character === '"' ? 'basic' : 'literal';
        index += 3;
      } else {
        index += 1;
        while (index < line.length) {
          if (line[index] === character) {
            index += 1;
            break;
          }
          if (character === '"' && line[index] === '\\') index += 1;
          index += 1;
        }
      }
    } else {
      index += 1;
    }
  }
  return kind;
}

function findProjectTable(content: string, projectPath: string): ProjectTableRange | null {
  const lines = readLinesWithOffsets(content);
  let multilineString: MultilineStringKind = null;
  let targetHeader: FileLine | null = null;
  for (const line of lines) {
    if (multilineString === null) {
      if (targetHeader && isTableHeader(line.text)) {
        return { headerEnd: targetHeader.end, end: line.start };
      }
      if (targetHeader === null && getProjectHeaderPath(line.text) === projectPath) {
        targetHeader = line;
      }
    }
    multilineString = nextMultilineStringKind(line.text, multilineString);
  }
  return targetHeader ? { headerEnd: targetHeader.end, end: content.length } : null;
}

/**
 * JSON string escapes are valid TOML basic-string escapes. TOML also forbids a
 * raw DEL character, which JSON leaves unescaped.
 */
function escapeTomlBasicString(value: string): string {
  return JSON.stringify(value).replace(/\x7f/g, '\\u007f');
}

function newlineFor(content: string): string {
  return content.includes('\r\n') ? '\r\n' : '\n';
}

function appendProjectTrustTable(content: string, projectPath: string): string {
  const newline = newlineFor(content);
  const separator =
    content.length === 0 ? '' : content.endsWith('\n') ? newline : `${newline}${newline}`;
  return `${content}${separator}[projects.${escapeTomlBasicString(projectPath)}]${newline}trust_level = "trusted"${newline}`;
}

const TRUST_ASSIGNMENT =
  /^([ \t]*(?:trust_level|"trust_level"|'trust_level')[ \t]*=[ \t]*)(?:"(?:\\.|[^"\\])*"|'[^']*'|[^#]*?)([ \t]*(?:#.*)?\r?)$/;

function setExistingProjectTrust(content: string, table: ProjectTableRange): string {
  for (const line of readLinesWithOffsets(content)) {
    if (line.start < table.headerEnd || line.start >= table.end) continue;
    const match = TRUST_ASSIGNMENT.exec(line.text);
    if (!match) continue;
    const replacement = `${match[1]}"trusted"${match[2]}`;
    return `${content.slice(0, line.start)}${replacement}${content.slice(
      line.start + line.text.length,
    )}`;
  }

  const beforeNextTable = content.slice(0, table.end);
  const newline = newlineFor(content);
  const separator = beforeNextTable.endsWith('\n') ? '' : newline;
  return `${beforeNextTable}${separator}trust_level = "trusted"${newline}${content.slice(table.end)}`;
}

function applyProjectTrust(content: string, projectPath: string): string {
  const table = findProjectTable(content, projectPath);
  return table
    ? setExistingProjectTrust(content, table)
    : appendProjectTrustTable(content, projectPath);
}

async function resolveWriteMode(configPath: string): Promise<number> {
  try {
    return (await stat(configPath)).mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return DEFAULT_CODEX_CONFIG_MODE;
    throw error;
  }
}

async function writeConfigAtomically(
  configPath: string,
  content: string,
  mode: number,
): Promise<void> {
  const tempPath = `${configPath}.tmp.${randomBytes(8).toString('hex')}`;
  try {
    await writeFile(tempPath, content, { encoding: 'utf-8', mode });
    await chmod(tempPath, mode);
    await rename(tempPath, configPath);
  } catch (error) {
    try {
      await unlink(tempPath);
    } catch {
      // Preserve the original write error; temp cleanup is best-effort.
    }
    throw error;
  }
}

function failed(code: CodexProjectTrustFailureCode, message: string): CodexProjectTrustResult {
  return { success: false, code, message };
}

async function updateProjectTrust(
  configPath: string,
  projectPaths: string[],
): Promise<CodexProjectTrustResult> {
  await mkdir(dirname(configPath), { recursive: true, mode: DEFAULT_CODEX_HOME_MODE });

  let content: string;
  try {
    content = await readFile(configPath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      content = '';
    } else {
      return failed('CODEX_TRUST_CONFIG_READ_FAILED', 'Codex config could not be read.');
    }
  }

  const current = parseConfig(content);
  if (!current.success) {
    return failed('CODEX_TRUST_CONFIG_INVALID', 'Codex config contains invalid TOML.');
  }

  const missingPaths = projectPaths.filter((path) => !isProjectTrusted(current.value, path));
  if (missingPaths.length === 0) return { success: true };

  let updatedContent = content;
  for (const projectPath of missingPaths) {
    updatedContent = applyProjectTrust(updatedContent, projectPath);
  }

  const updated = parseConfig(updatedContent);
  if (!updated.success) {
    return failed(
      'CODEX_TRUST_CONFIG_INVALID',
      'Codex project trust could not be represented safely.',
    );
  }
  if (!projectPaths.every((path) => isProjectTrusted(updated.value, path))) {
    return failed('CODEX_TRUST_CONFIG_VERIFY_FAILED', 'Codex project trust could not be verified.');
  }

  try {
    await writeConfigAtomically(configPath, updatedContent, await resolveWriteMode(configPath));
  } catch {
    return failed('CODEX_TRUST_CONFIG_WRITE_FAILED', 'Codex config could not be updated.');
  }

  let writtenContent: string;
  try {
    writtenContent = await readFile(configPath, 'utf-8');
  } catch {
    return failed('CODEX_TRUST_CONFIG_VERIFY_FAILED', 'Codex project trust could not be verified.');
  }
  const written = parseConfig(writtenContent);
  if (!written.success || !projectPaths.every((path) => isProjectTrusted(written.value, path))) {
    return failed('CODEX_TRUST_CONFIG_VERIFY_FAILED', 'Codex project trust could not be verified.');
  }

  return { success: true };
}

function enqueueFileMutation(
  configPath: string,
  operation: () => Promise<CodexProjectTrustResult>,
): Promise<CodexProjectTrustResult> {
  const previous = writeTails.get(configPath) ?? Promise.resolve();
  const current = previous.then(operation, operation);
  const tail = current.then(
    () => undefined,
    () => undefined,
  );
  writeTails.set(configPath, tail);
  void tail.then(() => {
    if (writeTails.get(configPath) === tail) writeTails.delete(configPath);
  });
  return current;
}

/** Ensure Codex trusts the exact project root and its physical path identity. */
export async function ensureCodexProjectTrusted(
  projectPath: string,
  context?: CodexProjectTrustContext,
): Promise<CodexProjectTrustResult> {
  try {
    const projectPaths = await resolveProjectIdentities(projectPath);
    const configPath = join(resolveCodexHome(context, projectPaths[0]), 'config.toml');
    return await enqueueFileMutation(configPath, () =>
      updateProjectTrust(configPath, projectPaths),
    );
  } catch {
    return failed('CODEX_TRUST_CONFIG_WRITE_FAILED', 'Codex config could not be updated.');
  }
}
