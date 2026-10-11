import { constants } from 'node:fs';
import { access, lstat, open, readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parse as parseEnv } from 'dotenv';
import {
  isAlias,
  isMap,
  isNode,
  isScalar,
  LineCounter,
  parseDocument,
  visit,
  type Document,
} from 'yaml';
import { AppError } from '../../../common/errors/error-types';
import { within } from './docker-plan-files';
import { DEFAULT_COMPOSE_FILES } from './docker-project-compose';
import type {
  DockerComposeUserSource,
  DockerOwnershipDecision,
  DockerUserFixProposal,
} from './docker-plan.dto';

interface UserScalar {
  text: string;
  oldUser: string | null;
  line: number | null;
  range?: [number, number];
  style?: string;
  reason?: string;
}

/** Why the scalar cannot be edited automatically; undefined when it can. */
function manualEditReason(
  doc: Document,
  entry: unknown,
  scalar: unknown,
  result: UserScalar,
): string | undefined {
  if (doc.has('include')) return 'Compose include requires a manual edit, then Verify.';
  let anchors = false;
  visit(doc, (_key, node) => {
    if (isAlias(node) || (isNode(node) && 'anchor' in node && node.anchor)) anchors = true;
  });
  if (anchors) return 'Compose anchors or aliases require a manual edit, then Verify.';
  if (isMap(entry) && entry.has('extends'))
    return 'Compose extends requires a manual edit, then Verify.';
  if (!isScalar(scalar) || !result.range)
    return 'Add or update the service user line yourself, then Verify.';
  if (
    !['PLAIN', 'QUOTE_SINGLE', 'QUOTE_DOUBLE'].includes(scalar.type ?? '') ||
    /[\r\n]/.test(result.text.slice(...result.range)) ||
    !['string', 'number'].includes(typeof scalar.value) ||
    scalar.tag
  )
    return 'Only a plain, single-line user scalar can be applied automatically. Edit it yourself, then Verify.';
  if (result.oldUser?.includes('$'))
    return 'This user value already uses interpolation. Edit it yourself, then Verify.';
  return undefined;
}

/** Locate a scalar without serializing the document or disclosing parser errors. */
function userScalar(text: string, service: string): UserScalar {
  const lines = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lines });
  const result: UserScalar = { text, oldUser: null, line: null };
  if (doc.errors.length || !isMap(doc.contents))
    return {
      ...result,
      reason: 'The Compose file cannot be safely parsed. Edit it yourself, then Verify.',
    };
  const services = doc.get('services', true);
  const entry = isMap(services) ? services.get(service, true) : undefined;
  const scalar: unknown = isMap(entry) ? entry.get('user', true) : undefined;
  if (isNode(scalar) && scalar.range) result.line = lines.linePos(scalar.range[0]).line;
  if (isScalar(scalar)) {
    result.oldUser = String(scalar.value);
    result.style =
      scalar.type === 'PLAIN' && isMap(entry) && entry.flow ? 'QUOTE_DOUBLE' : scalar.type;
    if (scalar.range) result.range = [scalar.range[0], scalar.range[1]];
  } else if (isAlias(scalar)) {
    const value = scalar.resolve(doc);
    if (isScalar(value)) result.oldUser = String(value.value);
  }
  result.reason = manualEditReason(doc, entry, scalar, result);
  return result;
}

function scalarText(style: string | undefined, value: string): string {
  if (style === 'QUOTE_DOUBLE') return JSON.stringify(value);
  if (style === 'QUOTE_SINGLE') return `'${value}'`;
  return value;
}

async function projectFile(root: string, file: string): Promise<boolean> {
  const [actualRoot, actualFile, info] = await Promise.all([
    realpath(root),
    realpath(file),
    lstat(file),
  ]);
  // The editor refuses a symlinked file, including links to another file within the project.
  return info.isFile() && within(actualRoot, actualFile) && actualFile === resolve(file);
}

async function sourceFiles(
  source: DockerComposeUserSource,
): Promise<{ files: string[]; reason?: string }> {
  if (source.files.length) return { files: source.files };
  let env: Record<string, string> = {};
  try {
    env = parseEnv(await readFile(join(source.directory, '.env')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      return {
        files: [],
        reason:
          'The Compose source-file relationship is unavailable. Edit it yourself, then Verify.',
      };
  }
  const encoded = process.env.COMPOSE_FILE ?? env.COMPOSE_FILE;
  if (encoded) {
    // An environment-selected file set can itself use interpolation or another env file.
    return {
      files: encoded.includes('$')
        ? []
        : encoded
            .split(process.env.COMPOSE_PATH_SEPARATOR ?? env.COMPOSE_PATH_SEPARATOR ?? ':')
            .filter(Boolean)
            .map((file) => resolve(source.directory, file)),
      reason:
        'The Compose file set is selected through the environment. Edit it yourself, then Verify.',
    };
  }
  const candidates = [
    ...DEFAULT_COMPOSE_FILES,
    'compose.override.yaml',
    'compose.override.yml',
    'docker-compose.override.yaml',
    'docker-compose.override.yml',
  ];
  const files: string[] = [];
  for (const name of candidates) {
    const file = join(source.directory, name);
    if (
      await access(file).then(
        () => true,
        () => false,
      )
    )
      files.push(file);
  }
  return {
    files,
    ...(files.length === 0
      ? { reason: 'The source Compose file is unavailable. Edit it yourself, then Verify.' }
      : {}),
  };
}

export async function composeUserFixProposal(
  root: string,
  ownership: DockerOwnershipDecision,
  container: string | null,
  id: string,
  resolvedUser?: string,
): Promise<DockerUserFixProposal | null> {
  const source = ownership.compose;
  if (!source || !['needs-user-fix', 'image-user-hint'].includes(ownership.class)) return null;
  const located = await sourceFiles(source);
  const files = located.files;
  let file: string | null = files[0] ? resolve(source.directory, files[0]) : null;
  let scalar: UserScalar = { text: '', oldUser: null, line: null };
  let reason = located.reason;
  // Later files can override a scalar. Show its location, but never edit a multi-file set.
  for (const path of files) {
    const candidate = resolve(source.directory, path);
    try {
      if (!(await projectFile(root, candidate))) {
        reason =
          'Only a regular Compose file inside this project can be edited. Edit it yourself, then Verify.';
        continue;
      }
      const read = userScalar(await readFile(candidate, 'utf8'), source.service);
      if (read.oldUser !== null || scalar.oldUser === null) {
        file = candidate;
        scalar = read;
      }
    } catch {
      reason = 'The source Compose file is unavailable. Edit it yourself, then Verify.';
    }
  }
  const imageHint = ownership.class === 'image-user-hint';
  if (files.length > 1) reason = 'Several Compose files require a manual edit, then Verify.';
  else if (imageHint)
    reason = 'The user is inherited from the image. Add this user line yourself, then Verify.';
  else reason ??= scalar.reason;
  if (!reason && resolvedUser !== undefined && scalar.oldUser !== resolvedUser)
    reason =
      'The source user no longer matches the Compose resolution. Verify or get a fresh plan.';
  const uidOnly = !imageHint && /^\d+$/.test(resolvedUser ?? scalar.oldUser ?? '');
  const newUser = `\${DEVCHAIN_UID:-${ownership.home.uid}}${uidOnly ? '' : `:\${DEVCHAIN_GID:-${ownership.home.gid}}`}`;
  return {
    id,
    service: source.service,
    container,
    file,
    line: scalar.line,
    oldUser: imageHint ? null : scalar.oldUser,
    newUser,
    canApply: !reason && Boolean(scalar.range),
    ...(reason ? { reason } : {}),
    hint: `On this VM your user id is ${ownership.vm.uid}. With this line, the container runs as your user on each machine: ${ownership.home.uid} here, ${ownership.vm.uid} on the VM. Shells outside DevChain use the fallback, so \`docker compose up\` in a normal terminal at home keeps running as you.`,
  };
}

/** The caller supplies a server-issued relationship, never a client path or replacement. */
export async function applyComposeUserFix(
  root: string,
  proposal: DockerUserFixProposal,
): Promise<void> {
  if (!proposal.canApply || !proposal.file)
    throw new AppError(
      proposal.reason ?? 'This proposal requires a manual edit, then Verify.',
      'DOCKER_USER_FIX_SHOW_ONLY',
      422,
    );
  try {
    if (!(await projectFile(root, proposal.file)))
      throw new AppError(
        'The Compose file relationship changed. Get a fresh plan.',
        'DOCKER_USER_FIX_STALE',
        409,
      );
    const handle = await open(proposal.file, constants.O_RDWR | constants.O_NOFOLLOW);
    try {
      if (!(await handle.stat()).isFile())
        throw new AppError(
          'The Compose file relationship changed. Get a fresh plan.',
          'DOCKER_USER_FIX_STALE',
          409,
        );
      const scalar = userScalar(await handle.readFile('utf8'), proposal.service);
      if (scalar.oldUser !== proposal.oldUser)
        throw new AppError(
          'The service user changed since the plan. Get a fresh plan.',
          'DOCKER_USER_FIX_STALE',
          409,
        );
      if (scalar.reason || !scalar.range)
        throw new AppError(
          scalar.reason ?? 'This proposal requires a manual edit, then Verify.',
          'DOCKER_USER_FIX_SHOW_ONLY',
          422,
        );
      const replacement = scalarText(scalar.style, proposal.newUser);
      const edited =
        scalar.text.slice(0, scalar.range[0]) + replacement + scalar.text.slice(scalar.range[1]);
      const data = Buffer.from(edited, 'utf8');
      for (let offset = 0; offset < data.length; ) {
        const written = await handle.write(data, offset, data.length - offset, offset);
        offset += written.bytesWritten;
      }
      await handle.truncate(data.length);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(
      'The Compose file could not be edited. Get a fresh plan or edit it yourself, then Verify.',
      'DOCKER_USER_FIX_UNAVAILABLE',
      422,
    );
  }
}
