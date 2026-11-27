import { createTestDatabase } from '../../../../common/test/test-database.helper';
import { assertNoLinkReleasePending, openLinkReleaseAttempt } from './pending-link-releases';

// Layer: module unit on a real SQLite schema; the records live in the settings table.
describe('pending link releases', () => {
  const task = (remoteTaskId: string) => ({
    projectId: 'p1',
    provider: 'jira' as const,
    remoteScopeKey: 'site-1',
    remoteTaskId,
  });

  it('forgets the release of a link home dropped when another task is checked', () => {
    const { sqlite } = createTestDatabase();
    // No external_task_links row: home's copy has dropped the link.
    openLinkReleaseAttempt(sqlite, 'gone-link', {
      projectId: 'p1',
      epicId: 'e1',
      tasks: [task('PARENT-1')],
    });

    assertNoLinkReleasePending(sqlite, task('OTHER-9'));

    const row = sqlite
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get('remotes.home.pendingLinkReleases') as { value: string };
    expect(JSON.parse(row.value)).toEqual({});
    sqlite.close();
  });
});
