import type { ExternalSubtaskSnapshot } from '../models/external-provider.models';
import {
  managedSubtaskContentMatches,
  managedSubtaskHomeCandidates,
  redactManagedSubtaskContent,
} from './managed-subtask-content';

const snapshot: ExternalSubtaskSnapshot = {
  remoteTaskId: 'child-1',
  remoteKey: 'CHILD-1',
  parentRemoteTaskId: 'parent-1',
  workAreaRemoteId: 'list-1',
  ownershipToken: '11111111-1111-4111-8111-111111111111',
  title: 'Managed child',
  description: null,
};

describe('managedSubtaskHomeCandidates', () => {
  it('normalizes, rejects, deduplicates, and orders all candidate sources', () => {
    expect(
      managedSubtaskHomeCandidates('/home/project-owner/work/devchain', {
        environment: '/home/project-owner/work///',
        system: '/home/project-owner/',
      }),
    ).toEqual(['/home/project-owner/work', '/home/project-owner']);

    expect(
      managedSubtaskHomeCandidates('/Users/mac-owner/work/devchain', {
        environment: '',
        system: '/',
      }),
    ).toEqual(['/Users/mac-owner']);

    expect(() =>
      managedSubtaskHomeCandidates('relative/project', {
        environment: 'relative/home',
        system: '///',
      }),
    ).toThrow('Managed subtask home candidates could not be resolved');
  });
});

describe('redactManagedSubtaskContent', () => {
  const sources = {
    environment: '/home/user',
    system: '/Users/user',
  };

  const projectAliases = {
    owningProjectId: 'project-owner',
    projects: [
      { id: 'project-owner', name: 'DevChain', rootPath: '/home/user/repos/devchain' },
      {
        id: 'project-app',
        name: 'Local App',
        rootPath: '/home/user/repos/devchain/apps/local-app',
      },
    ],
  };

  it('redacts all valid title and description occurrences without mutating the input', () => {
    const content = {
      title: '/home/user/project and /Users/user/project',
      description: [
        '[/home/user/docs](/home/user/docs/readme.md)',
        '`/home/user/inline.ts`',
        '```text',
        '/Users/user/fenced.ts',
        '```',
        '"/home/user/quoted.ts", (/Users/user/example.ts)',
      ].join('\n'),
    };

    expect(redactManagedSubtaskContent(content, '/work/project', sources)).toEqual({
      title: '{home}/project and {home}/project',
      description: [
        '[{home}/docs]({home}/docs/readme.md)',
        '`{home}/inline.ts`',
        '```text',
        '{home}/fenced.ts',
        '```',
        '"{home}/quoted.ts", ({home}/example.ts)',
      ].join('\n'),
    });
    expect(content.title).toBe('/home/user/project and /Users/user/project');
  });

  it.each([' ', '"', ',', ')', ''])('redacts an exact home before %j', (suffix) => {
    expect(
      redactManagedSubtaskContent(
        { title: `/home/user${suffix}`, description: null },
        '/work/project',
        sources,
      ),
    ).toEqual({ title: `{home}${suffix}`, description: null });
  });

  it('keeps continuation lookalikes and unrelated URL fragments unchanged', () => {
    const content = {
      title: '/home/user-other /home/userfoo x/home/user/path',
      description: 'https://example.com/home/user/path',
    };

    expect(redactManagedSubtaskContent(content, '/work/project', sources)).toEqual(content);
  });

  it('uses the longest candidate before an overlapping home candidate', () => {
    expect(
      redactManagedSubtaskContent(
        { title: '/home/user/work/project', description: null },
        '/home/user/work/project-root',
        { environment: '/home/user', system: '/home/user/work' },
      ),
    ).toEqual({ title: '{home}/project', description: null });
  });

  it('replaces repeated nested project roots once and preserves suffixes and path boundaries', () => {
    const content = {
      title: [
        '/home/user/repos/devchain/apps/local-app/src/main.ts',
        '/home/user/repos/devchain/README.md',
        '/home/user/repos/devchain/apps/local-app-other',
        'x/home/user/repos/devchain/apps/local-app/src/main.ts',
      ].join(' | '),
      description:
        '(/home/user/repos/devchain/apps/local-app) /home/user/repos/devchain/apps/local-app',
    };

    expect(
      redactManagedSubtaskContent(content, '/home/user/repos/devchain', sources, projectAliases),
    ).toEqual({
      title: [
        '{project:Local App}/src/main.ts',
        '{project:DevChain}/README.md',
        '{project:DevChain}/apps/local-app-other',
        'x/home/user/repos/devchain/apps/local-app/src/main.ts',
      ].join(' | '),
      description: '({project:Local App}) {project:Local App}',
    });
  });

  it('accepts only non-root absolute POSIX roots and removes trailing separators', () => {
    expect(
      redactManagedSubtaskContent(
        {
          title: '/valid/root/file /relative/root/file /file',
          description: '/valid/root',
        },
        '/work/project',
        sources,
        {
          owningProjectId: 'valid',
          projects: [
            { id: 'empty', name: 'Empty', rootPath: '' },
            { id: 'relative', name: 'Relative', rootPath: 'relative/root' },
            { id: 'filesystem-root', name: 'Root', rootPath: '/' },
            { id: 'valid', name: 'Valid', rootPath: '/valid/root///' },
          ],
        },
      ),
    ).toEqual({
      title: '{project:Valid}/file /relative/root/file /file',
      description: '{project:Valid}',
    });
  });

  it('selects the owning project for equal roots before the lowest project ID', () => {
    const content = { title: '/workspace/shared/file', description: null };
    const projects = [
      { id: 'project-z', name: 'Owner', rootPath: '/workspace/shared' },
      { id: 'project-aa', name: 'Unrelated', rootPath: '/workspace/second' },
      { id: 'project-b', name: 'Second', rootPath: '/workspace/shared/' },
      { id: 'project-a', name: 'First', rootPath: '/workspace/shared//' },
    ];

    expect(
      redactManagedSubtaskContent(content, '/workspace/owner', sources, {
        owningProjectId: 'project-z',
        projects,
      }),
    ).toEqual({ title: '{project:Owner}/file', description: null });
    expect(
      redactManagedSubtaskContent(content, '/workspace/owner', sources, {
        owningProjectId: 'different-project',
        projects,
      }),
    ).toEqual({ title: '{project:First}/file', description: null });
  });

  it('preserves exact duplicate and metacharacter names through callback replacement', () => {
    const aliases = Object.freeze({
      owningProjectId: 'project-home',
      projects: Object.freeze([
        Object.freeze({ id: 'project-home', name: 'home', rootPath: '/workspace/home' }),
        Object.freeze({ id: 'project-a', name: '$&_[docs]-#', rootPath: '/workspace/docs' }),
        Object.freeze({
          id: 'project-b',
          name: '$&_[docs]-#',
          rootPath: '/workspace/docs-copy',
        }),
      ]),
    });
    const content = {
      title: '/workspace/home/file /workspace/docs/file /workspace/docs-copy/file',
      description: null,
    };

    expect(redactManagedSubtaskContent(content, '/workspace/home', sources, aliases)).toEqual({
      title: '{project:home}/file {project:$&_[docs]-#}/file {project:$&_[docs]-#}/file',
      description: null,
    });
    expect(content.title).toBe(
      '/workspace/home/file /workspace/docs/file /workspace/docs-copy/file',
    );
    expect(aliases).toEqual({
      owningProjectId: 'project-home',
      projects: [
        { id: 'project-home', name: 'home', rootPath: '/workspace/home' },
        { id: 'project-a', name: '$&_[docs]-#', rootPath: '/workspace/docs' },
        { id: 'project-b', name: '$&_[docs]-#', rootPath: '/workspace/docs-copy' },
      ],
    });
  });

  it('does not reprocess project aliases and applies home redaction afterward', () => {
    expect(
      redactManagedSubtaskContent(
        {
          title: '/workspace/first/file /home/user/private',
          description: '/workspace/second/file',
        },
        '/workspace/first',
        sources,
        {
          owningProjectId: 'project-first',
          projects: [
            {
              id: 'project-first',
              name: '/workspace/second from /home/user',
              rootPath: '/workspace/first',
            },
            { id: 'project-second', name: 'Second', rootPath: '/workspace/second' },
          ],
        },
      ),
    ).toEqual({
      title: '{project:/workspace/second from {home}}/file {home}/private',
      description: '{project:Second}/file',
    });
  });

  it('resolves home candidates before applying otherwise sufficient project aliases', () => {
    expect(() =>
      redactManagedSubtaskContent(
        { title: '/workspace/project/file', description: null },
        'relative/project',
        { environment: '', system: '/' },
        {
          owningProjectId: 'project-owner',
          projects: [{ id: 'project-owner', name: 'Project', rootPath: '/workspace/project' }],
        },
      ),
    ).toThrow('Managed subtask home candidates could not be resolved');
  });
});

describe('managedSubtaskContentMatches', () => {
  it('accepts ClickUp bullet and escape normalization', () => {
    expect(
      managedSubtaskContentMatches(
        'clickup',
        {
          ...snapshot,
          description: '### Context\n*   Rationale: use devchain\\_get\\_prompt',
        },
        {
          title: 'Managed child',
          description: '### Context\n- Rationale: use devchain_get_prompt',
        },
      ),
    ).toBe(true);
  });

  it('accepts ClickUp escaping around project names with supported metacharacters', () => {
    expect(
      managedSubtaskContentMatches(
        'clickup',
        {
          ...snapshot,
          description: 'Path: {project:$&\\_\\[docs\\]\\-\\#}/README.md',
        },
        {
          title: 'Managed child',
          description: 'Path: {project:$&_[docs]-#}/README.md',
        },
      ),
    ).toBe(true);
  });

  it('still rejects real ClickUp content differences', () => {
    expect(
      managedSubtaskContentMatches(
        'clickup',
        { ...snapshot, description: '- Remote text' },
        { title: 'Managed child', description: '- Local text' },
      ),
    ).toBe(false);
  });

  it('keeps Jira comparison exact', () => {
    expect(
      managedSubtaskContentMatches(
        'jira',
        { ...snapshot, description: '* Remote list item' },
        { title: 'Managed child', description: '- Remote list item' },
      ),
    ).toBe(false);
  });
});
