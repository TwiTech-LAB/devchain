import type { ExternalSubtaskSnapshot } from '../models/external-provider.models';
import { managedSubtaskContentMatches } from './managed-subtask-content';

const snapshot: ExternalSubtaskSnapshot = {
  remoteTaskId: 'child-1',
  remoteKey: 'CHILD-1',
  parentRemoteTaskId: 'parent-1',
  workAreaRemoteId: 'list-1',
  ownershipToken: '11111111-1111-4111-8111-111111111111',
  title: 'Managed child',
  description: null,
};

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
