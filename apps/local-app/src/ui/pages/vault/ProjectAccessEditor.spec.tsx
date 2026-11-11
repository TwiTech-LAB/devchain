import { useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  fetchVaultProjectContext,
  listVaultAccess,
  setVaultProjectGrants,
  type VaultEntry,
  type VaultEntryProjectAccess,
  type VaultFamilyAccess,
  type VaultGrantAccess,
  type VaultProjectContext,
} from '@/ui/lib/vault';
import { NO_AGENTS_YET, ProjectAccessEditor, sameGrantAccess } from './ProjectAccessEditor';

jest.mock('@/ui/lib/vault', () => ({
  ...jest.requireActual('@/ui/lib/vault'),
  fetchVaultProjectContext: jest.fn(),
  listVaultAccess: jest.fn(),
  setVaultProjectGrants: jest.fn(),
}));

const contextMock = fetchVaultProjectContext as jest.MockedFunction<
  typeof fetchVaultProjectContext
>;

const accessMock = listVaultAccess as jest.MockedFunction<typeof listVaultAccess>;
const saveGrantsMock = setVaultProjectGrants as jest.MockedFunction<typeof setVaultProjectGrants>;

const accessRow = (projectId: string, familySlug: string | null = null): VaultFamilyAccess => ({
  projectId,
  familySlug,
  familyMatched: true,
});

const PROJECTS = [
  { id: 'pA', name: 'Alpha' },
  { id: 'pB', name: 'Beta' },
  { id: 'pC', name: 'Crux' },
];

function context(overrides: Partial<VaultProjectContext> = {}): VaultProjectContext {
  return {
    roles: [
      {
        familySlug: 'coder',
        profileNames: ['Coder (Claude)', 'Coder (Codex)'],
        agentNames: ['Coder 1', 'Coder 2'],
      },
      { familySlug: 'reviewer', profileNames: ['Reviewer'], agentNames: [] },
    ],
    profilesWithoutRole: 0,
    ...overrides,
  };
}

function entry(overrides: Partial<VaultEntry>): VaultEntry {
  return {
    id: 'other',
    projectId: null,
    name: 'API_TOKEN',
    kind: 'secret',
    description: 'd',
    revision: 1,
    approvalRequired: false,
    lastUsedAt: null,
    createdAt: '2026-11-06T00:00:00.000Z',
    updatedAt: '2026-11-06T00:00:00.000Z',
    ...overrides,
  };
}

function setup({
  initial = [] as VaultEntryProjectAccess[],
  entries = [] as VaultEntry[],
  projectContext = context(),
  disabled = false,
  access = PROJECTS.map((project) => accessRow(project.id)),
} = {}) {
  contextMock.mockResolvedValue(projectContext);
  accessMock.mockResolvedValue(access);
  const onChange = jest.fn();
  const onOpenProjectAccess = jest.fn();
  function Harness() {
    const [value, setValue] = useState(initial);
    return (
      <ProjectAccessEditor
        value={value}
        onChange={(next) => {
          onChange(next);
          setValue(next);
        }}
        projects={PROJECTS}
        entryName=" API_TOKEN "
        entryId="e1"
        entries={entries}
        disabled={disabled}
        onOpenProjectAccess={disabled ? undefined : onOpenProjectAccess}
      />
    );
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>,
  );
  return { onChange, onOpenProjectAccess, lastValue: () => onChange.mock.calls.at(-1)?.[0] };
}

// Pure function: the cheapest layer that sees a change the Save would otherwise skip.
describe('sameGrantAccess', () => {
  it.each<[VaultGrantAccess, VaultGrantAccess]>([
    [{ mode: 'all' }, { mode: 'families', familySlugs: ['all'] }],
    [{ mode: 'none' }, { mode: 'families', familySlugs: ['none'] }],
    [{ mode: 'all' }, { mode: 'families', familySlugs: ['*'] }],
    [
      { mode: 'families', familySlugs: ['a,b'] },
      { mode: 'families', familySlugs: ['a', 'b'] },
    ],
  ])('tells %j from %j, whatever text a role slug holds', (a, b) => {
    expect(sameGrantAccess(a, b)).toBe(false);
  });
});

describe('ProjectAccessEditor', () => {
  beforeEach(() => jest.resetAllMocks());

  /** Rows start collapsed; the header button (named by the project) expands one. */
  function expandRow(projectName: string) {
    const row = screen.getByRole('listitem', { name: projectName });
    fireEvent.click(within(row).getByRole('button', { name: projectName }));
    return row;
  }

  it('starts rows collapsed with a scope summary that keeps the cues visible', async () => {
    setup({
      initial: [
        { projectId: 'pA', mode: 'all' },
        { projectId: 'pB', mode: 'families', familySlugs: ['coder', 'reviewer'] },
      ],
      access: [accessRow('pB', 'reviewer')],
    });

    const alpha = screen.getByRole('listitem', { name: 'Alpha' });
    expect(within(alpha).getByRole('button', { name: 'Alpha' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(within(alpha).getByText('All agents')).toBeInTheDocument();
    expect(within(alpha).queryByRole('radio', { name: 'All agents' })).not.toBeInTheDocument();
    // Alpha has no access row at all: the Vault is off there, and the collapsed line says so.
    expect(await within(alpha).findByText('Vault off')).toBeInTheDocument();

    // Beta's chosen role outside the access stays visible while collapsed.
    const beta = screen.getByRole('listitem', { name: 'Beta' });
    expect(within(beta).getByText('2 roles')).toBeInTheDocument();
    expect(await within(beta).findByText('No Vault access')).toBeInTheDocument();

    const expanded = expandRow('Alpha');
    expect(await within(expanded).findByRole('radio', { name: 'All agents' })).toBeInTheDocument();
    expect(within(expanded).queryByText('Vault off')).not.toBeInTheDocument();
  });

  it('opens a project added in this session expanded', async () => {
    const user = userEvent.setup();
    setup();

    await user.click(screen.getByRole('button', { name: 'Add projects' }));
    await user.click(await screen.findByRole('checkbox', { name: 'Crux' }));
    await user.keyboard('{Escape}');

    const row = screen.getByRole('listitem', { name: 'Crux' });
    expect(within(row).getByRole('button', { name: 'Crux' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(await within(row).findByRole('radio', { name: 'All agents' })).toBeInTheDocument();
  });

  it('adds projects from the searchable picker with All agents, and removes them', async () => {
    const user = userEvent.setup();
    const { lastValue } = setup();

    await user.click(screen.getByRole('button', { name: 'Add projects' }));
    const search = await screen.findByLabelText('Search projects');
    await user.type(search, 'cr');
    expect(screen.queryByRole('checkbox', { name: 'Alpha' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'Crux' }));
    await user.clear(search);
    await user.click(screen.getByRole('checkbox', { name: 'Alpha' }));
    expect(lastValue()).toEqual([
      { projectId: 'pC', mode: 'all' },
      { projectId: 'pA', mode: 'all' },
    ]);

    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Remove Crux' }));
    await user.click(screen.getByRole('button', { name: 'Remove Alpha' }));
    expect(lastValue()).toEqual([]);
    expect(screen.getByText(/No projects\./)).toBeInTheDocument();
  });

  it('shows roles by profile names with their agents, and saves the chosen slugs', async () => {
    const { lastValue } = setup({
      initial: [{ projectId: 'pA', mode: 'all' }],
      projectContext: context({ profilesWithoutRole: 2 }),
    });
    const row = expandRow('Alpha');
    fireEvent.click(within(row).getByRole('radio', { name: 'Chosen roles' }));
    expect(lastValue()).toEqual([{ projectId: 'pA', mode: 'families', familySlugs: [] }]);

    const coder = await within(row).findByRole('checkbox', {
      name: /Coder \(Claude\), Coder \(Codex\)/,
    });
    expect(within(row).getByText('Choose at least one role.')).toBeInTheDocument();
    expect(coder).toHaveAccessibleDescription('Coder 1, Coder 2');
    expect(within(row).getByRole('checkbox', { name: /Reviewer/ })).toHaveAccessibleDescription(
      NO_AGENTS_YET,
    );
    expect(
      within(row).getByText('2 profiles have no role. Their agents get only All-agents entries.'),
    ).toBeInTheDocument();

    fireEvent.click(coder);
    expect(lastValue()).toEqual([{ projectId: 'pA', mode: 'families', familySlugs: ['coder'] }]);
    fireEvent.click(within(row).getByRole('radio', { name: 'All agents' }));
    expect(lastValue()).toEqual([{ projectId: 'pA', mode: 'all' }]);
  });

  it('keeps a role with no profile in the value until the user removes it', async () => {
    const { lastValue } = setup({
      initial: [{ projectId: 'pA', mode: 'families', familySlugs: ['old-role'] }],
    });
    expandRow('Alpha');
    expect(await screen.findByText('old-role: no profile has this role')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('checkbox', { name: /Reviewer/ }));
    expect(lastValue()).toEqual([
      { projectId: 'pA', mode: 'families', familySlugs: ['old-role', 'reviewer'] },
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'Remove role old-role' }));
    expect(lastValue()).toEqual([{ projectId: 'pA', mode: 'families', familySlugs: ['reviewer'] }]);
    expect(screen.queryByText(/no profile has this role/)).not.toBeInTheDocument();
  });

  it('warns on a project row whose project owns another entry with the same name', async () => {
    setup({
      initial: [
        { projectId: 'pA', mode: 'all' },
        { projectId: 'pB', mode: 'all' },
      ],
      entries: [
        entry({ id: 'e1', projectId: 'pA' }),
        entry({ id: 'beta-own', projectId: 'pB' }),
        entry({ id: 'beta-other', projectId: 'pA', name: 'OTHER' }),
      ],
    });

    const warning = 'This project also has its own API_TOKEN';
    expect(
      within(screen.getByRole('listitem', { name: 'Beta' })).getByText(warning),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole('listitem', { name: 'Alpha' })).queryByText(warning),
    ).not.toBeInTheDocument();
  });

  it('names the conflict, not shadowing, when the save keeps a project entry of that project', async () => {
    setup({
      initial: [{ projectId: 'pA', mode: 'all' }],
      entries: [
        entry({ id: 'e1', projectId: 'pA', name: 'OLD_NAME' }),
        entry({ id: 'alpha-own', projectId: 'pA' }),
      ],
    });

    const row = screen.getByRole('listitem', { name: 'Alpha' });
    expect(
      within(row).getByText('Alpha already has an entry named API_TOKEN. Choose another name.'),
    ).toBeInTheDocument();
    expect(within(row).queryByText(/also has its own/)).not.toBeInTheDocument();
  });

  it('marks a chosen role outside the access, and links to the Projects tab without a write', async () => {
    const user = userEvent.setup();
    const { onOpenProjectAccess } = setup({
      initial: [{ projectId: 'pA', mode: 'families', familySlugs: ['coder', 'reviewer'] }],
      access: [accessRow('pA', 'reviewer')],
    });
    const row = expandRow('Alpha');
    const coder = await within(row).findByRole('checkbox', { name: /Coder \(Claude\)/ });
    await within(row).findByText('No Vault access');
    expect(within(row).getAllByText('No Vault access')).toHaveLength(1);
    expect(coder.closest('li')).toHaveTextContent('No Vault access');
    expect(within(row).queryByRole('button', { name: /Add Vault access/ })).not.toBeInTheDocument();

    await user.click(
      within(row).getByRole('button', {
        name: 'Edit Vault access of Alpha on the Projects tab',
      }),
    );
    expect(onOpenProjectAccess).toHaveBeenCalledWith('pA');
    expect(saveGrantsMock).not.toHaveBeenCalled();
  });

  it('shows one Off cue for an Off project in both modes, with no role marks', async () => {
    const user = userEvent.setup();
    const { onOpenProjectAccess } = setup({
      initial: [{ projectId: 'pA', mode: 'all' }],
      access: [accessRow('pB')],
    });
    const row = expandRow('Alpha');
    const cue = 'The Vault is off in Alpha. Grants there stay inactive.';
    expect(await within(row).findByText(cue)).toBeInTheDocument();

    await user.click(within(row).getByRole('radio', { name: 'Chosen roles' }));
    await user.click(await within(row).findByRole('checkbox', { name: /Coder \(Claude\)/ }));
    expect(within(row).getByText(cue)).toBeInTheDocument();
    expect(within(row).queryByText('No Vault access')).not.toBeInTheDocument();

    await user.click(
      within(row).getByRole('button', { name: 'Edit Vault access of Alpha on the Projects tab' }),
    );
    expect(onOpenProjectAccess).toHaveBeenCalledWith('pA');
    expect(saveGrantsMock).not.toHaveBeenCalled();
  });

  it('offers no change when disabled', async () => {
    setup({
      initial: [{ projectId: 'pA', mode: 'families', familySlugs: ['coder', 'old-role'] }],
      disabled: true,
      access: [accessRow('pA', 'reviewer')],
    });
    expect(await screen.findAllByText('No Vault access')).toHaveLength(1);

    expect(await screen.findByRole('checkbox', { name: /Coder \(Claude\)/ })).toBeDisabled();
    expect(screen.getByRole('radio', { name: 'All agents' })).toBeDisabled();
    expect(await screen.findByText('old-role: no profile has this role')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
