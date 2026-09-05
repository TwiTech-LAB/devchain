import { homedir } from 'node:os';
import { posix } from 'node:path';
import type { IntegrationProvider, Project } from '../../storage/models/domain.models';
import type { ExternalSubtaskSnapshot } from '../models/external-provider.models';

export interface ManagedSubtaskContent {
  title: string;
  description: string | null;
}

export interface ManagedSubtaskHomeSources {
  environment: string | undefined;
  system: string;
}

export interface ManagedSubtaskProjectAliasInput {
  readonly owningProjectId: Project['id'];
  readonly projects: readonly Pick<Project, 'id' | 'name' | 'rootPath'>[];
}

interface ManagedSubtaskProjectAliasCandidate {
  id: Project['id'];
  name: Project['name'];
  rootPath: Project['rootPath'];
}

const PATH_CONTINUATION_CLASS = 'A-Za-z0-9._-';

function normalizeAbsolutePosixPath(candidate: string | null | undefined): string | null {
  if (!candidate || !posix.isAbsolute(candidate)) {
    return null;
  }
  const normalized = candidate.replace(/\/+$/u, '');
  return normalized || null;
}

function inferHomeFromProjectRoot(projectRoot: string): string | null {
  const normalizedRoot = normalizeAbsolutePosixPath(projectRoot);
  const match = normalizedRoot?.match(/^\/(home|Users)\/([^/]+)(?:\/|$)/u);
  return match ? `/${match[1]}/${match[2]}` : null;
}

export function managedSubtaskHomeCandidates(
  projectRoot: string,
  sources: ManagedSubtaskHomeSources = {
    environment: process.env.HOME,
    system: homedir(),
  },
): string[] {
  const candidates = [sources.environment, sources.system, inferHomeFromProjectRoot(projectRoot)]
    .map(normalizeAbsolutePosixPath)
    .filter((candidate): candidate is string => candidate !== null)
    .filter((candidate, index, candidates) => candidates.indexOf(candidate) === index)
    .sort((left, right) => right.length - left.length || left.localeCompare(right));
  if (candidates.length === 0) {
    throw new Error('Managed subtask home candidates could not be resolved');
  }
  return candidates;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function projectAliasCandidates(
  input: ManagedSubtaskProjectAliasInput | undefined,
): ManagedSubtaskProjectAliasCandidate[] {
  if (!input) {
    return [];
  }
  const candidates = input.projects
    .map((project): ManagedSubtaskProjectAliasCandidate | null => {
      const rootPath = normalizeAbsolutePosixPath(project.rootPath);
      return rootPath === null ? null : { ...project, rootPath };
    })
    .filter((project): project is ManagedSubtaskProjectAliasCandidate => project !== null)
    .sort((left, right) => {
      const rootLengthOrder = right.rootPath.length - left.rootPath.length;
      if (rootLengthOrder !== 0) {
        return rootLengthOrder;
      }
      const leftIsOwner = left.id === input.owningProjectId;
      const rightIsOwner = right.id === input.owningProjectId;
      if (leftIsOwner !== rightIsOwner) {
        return leftIsOwner ? -1 : 1;
      }
      if (left.id < right.id) {
        return -1;
      }
      if (left.id > right.id) {
        return 1;
      }
      return 0;
    });

  const seenRoots = new Set<string>();
  return candidates.filter((candidate) => {
    if (seenRoots.has(candidate.rootPath)) {
      return false;
    }
    seenRoots.add(candidate.rootPath);
    return true;
  });
}

function redactProjectPaths(
  value: string,
  candidates: readonly ManagedSubtaskProjectAliasCandidate[],
): string {
  if (candidates.length === 0) {
    return value;
  }
  const candidatesByRoot = new Map(candidates.map((candidate) => [candidate.rootPath, candidate]));
  const roots = candidates.map((candidate) => escapeRegExp(candidate.rootPath)).join('|');
  const pattern = new RegExp(
    `(^|[^${PATH_CONTINUATION_CLASS}])(${roots})(?=/|$|[^${PATH_CONTINUATION_CLASS}])`,
    'g',
  );
  return value.replace(pattern, (_match, boundary: string, rootPath: string) => {
    const candidate = candidatesByRoot.get(rootPath);
    return candidate ? `${boundary}{project:${candidate.name}}` : _match;
  });
}

function redactHomePaths(value: string, candidates: readonly string[]): string {
  return candidates.reduce((redacted, candidate) => {
    const pattern = new RegExp(
      `(^|[^${PATH_CONTINUATION_CLASS}])${escapeRegExp(candidate)}(?=/|$|[^${PATH_CONTINUATION_CLASS}])`,
      'g',
    );
    return redacted.replace(pattern, '$1{home}');
  }, value);
}

export function redactManagedSubtaskContent(
  content: ManagedSubtaskContent,
  projectRoot: string,
  sources?: ManagedSubtaskHomeSources,
  projectAliases?: ManagedSubtaskProjectAliasInput,
): ManagedSubtaskContent {
  const homeCandidates = managedSubtaskHomeCandidates(projectRoot, sources);
  const projectCandidates = projectAliasCandidates(projectAliases);
  const redact = (value: string): string =>
    redactHomePaths(redactProjectPaths(value, projectCandidates), homeCandidates);
  return {
    title: redact(content.title),
    description: content.description === null ? null : redact(content.description),
  };
}

function canonicalClickUpMarkdown(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  return value
    .replace(/\r\n/g, '\n')
    .replace(/^(\s*)[-*+]\s+/gm, '$1- ')
    .replace(/\\([\\`*_[\]<>#\-+])/g, '$1');
}

/** Compare only content DevChain owns after applying provider read-back rules. */
export function managedSubtaskContentMatches(
  provider: IntegrationProvider,
  snapshot: ExternalSubtaskSnapshot,
  desired: ManagedSubtaskContent,
): boolean {
  if (snapshot.title !== desired.title) {
    return false;
  }
  if (provider === 'clickup') {
    return (
      canonicalClickUpMarkdown(snapshot.description) ===
      canonicalClickUpMarkdown(desired.description)
    );
  }
  return snapshot.description === desired.description;
}
