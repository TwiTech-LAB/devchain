import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useAllProjects } from '@/ui/hooks/useAllProjects';
import { SessionApiError, type ApiErrorPayload } from '@/ui/lib/http-json';
import {
  createVaultEntry,
  deleteVaultEntry,
  fetchVaultProjectContext,
  fetchVaultStatus,
  LOCKED_REMOTE_ACCESS_MESSAGE,
  listVaultAccess,
  listVaultEntries,
  listVaultGrants,
  listVaultUseApprovals,
  removeVaultUseApproval,
  replaceVaultEntryValue,
  setVaultProjectGrants,
  updateVaultEntry,
  type VaultEntry,
  type VaultFamilyAccess,
  type VaultGrant,
  type VaultProjectContext,
  type VaultStatus,
} from '@/ui/lib/vault';
import { VaultPage } from './VaultPage';

jest.mock('@/ui/lib/vault', () => ({
  ...jest.requireActual('@/ui/lib/vault'),
  fetchVaultStatus: jest.fn(),
  listVaultEntries: jest.fn(),
  listVaultGrants: jest.fn(),
  fetchVaultProjectContext: jest.fn(),
  createVaultEntry: jest.fn(),
  updateVaultEntry: jest.fn(),
  replaceVaultEntryValue: jest.fn(),
  deleteVaultEntry: jest.fn(),
  setVaultProjectGrants: jest.fn(),
  listVaultAccess: jest.fn(),
  listVaultUseApprovals: jest.fn(),
  removeVaultUseApproval: jest.fn(),
}));
jest.mock('@/ui/hooks/useAllProjects');

let mockSelectedProjectId: string | undefined;
jest.mock('@/ui/hooks/useProjectSelection', () => ({
  useSelectedProject: () => ({ selectedProjectId: mockSelectedProjectId }),
}));

const mocked = <T extends (...args: never[]) => unknown>(fn: T) =>
  fn as unknown as jest.MockedFunction<T>;
const statusMock = mocked(fetchVaultStatus);
const entriesMock = mocked(listVaultEntries);
const grantsMock = mocked(listVaultGrants);
const contextMock = mocked(fetchVaultProjectContext);
const createMock = mocked(createVaultEntry);
const updateMock = mocked(updateVaultEntry);
const replaceMock = mocked(replaceVaultEntryValue);
const deleteMock = mocked(deleteVaultEntry);
const saveGrantsMock = mocked(setVaultProjectGrants);
const accessMock = mocked(listVaultAccess);
const approvalsMock = mocked(listVaultUseApprovals);
const removeApprovalMock = mocked(removeVaultUseApproval);

const SECRET = 'sk-live-canary-value';

function status(overrides: Partial<VaultStatus> = {}): VaultStatus {
  return {
    state: 'unlocked',
    protection: 'keystore',
    reason: null,
    keystoreAvailable: true,
    recoveryCodePending: false,
    runtime: { protection: 'memory', lingerHint: false },
    ...overrides,
  };
}

function entry(overrides: Partial<VaultEntry> = {}): VaultEntry {
  return {
    id: 'e1',
    projectId: null,
    name: 'API_TOKEN',
    kind: 'secret',
    description: 'Token for the API',
    revision: 1,
    approvalRequired: false,
    lastUsedAt: null,
    createdAt: '2026-11-06T00:00:00.000Z',
    updatedAt: '2026-11-06T00:00:00.000Z',
    ...overrides,
  };
}

const grant = (
  entryId: string,
  projectId: string,
  familySlug: string | null = null,
  familyMatched = true,
): VaultGrant => ({
  entryId,
  projectId,
  familySlug,
  familyMatched,
});

const accessRow = (projectId: string, familySlug: string | null = null): VaultFamilyAccess => ({
  projectId,
  familySlug,
  familyMatched: true,
});

const lockedRefusal = () =>
  new SessionApiError('Unlock the Vault first.', 409, {
    details: { code: 'VAULT_LOCKED_REMOTE_ACCESS' },
  } as ApiErrorPayload);

const CONTEXT: VaultProjectContext = {
  roles: [
    { familySlug: 'coder', profileNames: ['Coder'], agentNames: ['Coder 1'] },
    { familySlug: 'reviewer', profileNames: ['Reviewer'], agentNames: [] },
  ],
  profilesWithoutRole: 0,
};

/** Renders the page again, for example after a test changes the project list. */
let rerenderPage: () => void = () => undefined;

function setup({
  vault = status(),
  entries = [] as VaultEntry[],
  grants = [] as VaultGrant[] | Error,
  access = ['pA', 'pB', 'pC', 'pD'].map((id) => accessRow(id)),
} = {}) {
  accessMock.mockResolvedValue(access);
  statusMock.mockResolvedValue(vault);
  entriesMock.mockResolvedValue(entries);
  if (grants instanceof Error) grantsMock.mockRejectedValue(grants);
  else grantsMock.mockResolvedValue(grants);
  contextMock.mockResolvedValue(CONTEXT);
  approvalsMock.mockResolvedValue([]);
  mocked(useAllProjects).mockReturnValue({
    projects: [
      { id: 'pA', name: 'Alpha' },
      { id: 'pB', name: 'Beta' },
      { id: 'pC', name: 'Crux' },
      { id: 'pD', name: 'Delta' },
      { id: 'pT', name: 'Template', isTemplate: true },
    ],
  } as unknown as ReturnType<typeof useAllProjects>);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  // A new element on each call: React skips a rerender with the same element object.
  const page = () => (
    <QueryClientProvider client={client}>
      <VaultPage />
    </QueryClientProvider>
  );
  const view = render(page());
  rerenderPage = () => view.rerender(page());
  return userEvent.setup();
}

function setProjects(projects: Array<{ id: string; name: string }>) {
  mocked(useAllProjects).mockReturnValue({ projects } as unknown as ReturnType<
    typeof useAllProjects
  >);
}

async function openAddDialog() {
  const button = await screen.findByRole('button', { name: 'Add entry' });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  return screen.findByRole('dialog', { name: 'Add Vault entry' });
}

async function openPanel(name = 'API_TOKEN') {
  fireEvent.click(await screen.findByRole('button', { name }));
  const panel = await screen.findByRole('dialog', { name });
  await within(panel).findByLabelText('Name');
  return panel;
}

async function openRowMenu(user: ReturnType<typeof userEvent.setup>, name = 'API_TOKEN') {
  await user.click(await screen.findByRole('button', { name: `Actions for ${name}` }));
  return screen.findByRole('menu');
}

describe('VaultPage', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('adds an entry to two projects with chosen roles in one, and never shows the value', async () => {
    const user = setup();
    createMock.mockResolvedValue(entry());
    const dialog = await openAddDialog();

    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'API_TOKEN' } });
    fireEvent.change(within(dialog).getByLabelText('Description'), {
      target: { value: 'Token for the API' },
    });
    fireEvent.change(within(dialog).getByLabelText('Value'), { target: { value: SECRET } });
    await user.click(within(dialog).getByRole('button', { name: 'Add projects' }));
    expect(screen.queryByRole('checkbox', { name: 'Template' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'Alpha' }));
    await user.click(screen.getByRole('checkbox', { name: 'Beta' }));
    await user.keyboard('{Escape}');
    const beta = within(dialog).getByRole('listitem', { name: 'Beta' });
    await user.click(within(beta).getByRole('radio', { name: 'Chosen roles' }));
    await user.click(await within(beta).findByRole('checkbox', { name: /Coder/ }));
    entriesMock.mockResolvedValue([entry()]);
    await user.click(within(dialog).getByRole('button', { name: 'Add entry' }));

    await waitFor(() =>
      expect(createMock).toHaveBeenCalledWith({
        projects: [
          { projectId: 'pA', mode: 'all' },
          { projectId: 'pB', mode: 'families', familySlugs: ['coder'] },
        ],
        name: 'API_TOKEN',
        kind: 'secret',
        description: 'Token for the API',
        value: SECRET,
        approvalRequired: false,
      }),
    );
    expect(await screen.findByRole('button', { name: 'API_TOKEN' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue(SECRET)).not.toBeInTheDocument();
    expect(screen.queryByText(SECRET)).not.toBeInTheDocument();
  });

  it('adds a file entry with no project from an uploaded file', async () => {
    setup();
    createMock.mockResolvedValue(entry({ name: 'KEY_FILE', kind: 'file' }));
    const dialog = await openAddDialog();

    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'KEY_FILE' } });
    fireEvent.change(within(dialog).getByLabelText('Kind'), { target: { value: 'file' } });
    fireEvent.change(within(dialog).getByLabelText('Description'), {
      target: { value: 'SSH key' },
    });
    const file = new File(['line1\nline2\n'], 'id_ed25519');
    Object.defineProperty(file, 'text', { value: () => Promise.resolve('line1\nline2\n') });
    fireEvent.change(within(dialog).getByLabelText('Upload file'), { target: { files: [file] } });
    await waitFor(() =>
      expect(within(dialog).getByLabelText('File content')).toHaveValue('line1\nline2\n'),
    );
    fireEvent.click(within(dialog).getByRole('switch', { name: 'Require approval on use' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add entry' }));

    await waitFor(() =>
      expect(createMock).toHaveBeenCalledWith({
        projects: [],
        name: 'KEY_FILE',
        kind: 'file',
        description: 'SSH key',
        value: 'line1\nline2\n',
        approvalRequired: true,
      }),
    );
  });

  it('turns on the approval gate in the side panel and names the locked refusal', async () => {
    const user = setup({ entries: [entry()], grants: [] });
    updateMock.mockRejectedValue(lockedRefusal());

    const panel = await openPanel();
    expect(within(panel).queryByText('Roles that are not asked')).not.toBeInTheDocument();
    await user.click(within(panel).getByRole('switch', { name: 'Require approval on use' }));
    await user.click(within(panel).getByRole('button', { name: 'Save changes' }));

    expect(updateMock).toHaveBeenCalledWith('e1', { approvalRequired: true });
    expect(await within(panel).findByText(LOCKED_REMOTE_ACCESS_MESSAGE)).toHaveAttribute(
      'role',
      'alert',
    );
    expect(within(panel).getByRole('switch', { name: 'Require approval on use' })).toBeChecked();
  });

  it('marks a gated entry and removes a "never ask" role approval from the Access section', async () => {
    const user = setup({
      entries: [entry({ approvalRequired: true })],
      grants: [grant('e1', 'pA')],
    });
    const approval = { entryId: 'e1', projectId: 'pA', familySlug: 'coder', createdAt: 'T' };
    approvalsMock.mockResolvedValue([approval]);
    removeApprovalMock.mockResolvedValue([]);

    const row = (await screen.findByRole('button', { name: 'API_TOKEN' })).closest('tr')!;
    expect(within(row).getByText('approval')).toBeInTheDocument();
    const panel = await openPanel();
    const access = within(panel).getByRole('region', { name: 'Access' });
    expect(
      within(panel)
        .getAllByRole('region')
        .map((region) => region.getAttribute('aria-labelledby')),
    ).toEqual(['vault-entry-access', 'vault-use-approvals']);
    expect(within(access).getByRole('switch', { name: 'Require approval on use' })).toBeChecked();
    const item = await within(access).findByRole('listitem', { name: 'Alpha: Coder' });
    expect(
      within(access).getByText('Remove takes effect at once, not with Save changes.'),
    ).toBeInTheDocument();
    await user.click(within(item).getByRole('button', { name: /Remove the approval/ }));

    expect(removeApprovalMock.mock.calls[0][0]).toEqual(approval);
    expect(await within(panel).findByText(/No role skips the approval/)).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Save changes' })).toBeDisabled();
    expect(approvalsMock).toHaveBeenCalledWith('e1');
  });

  it('renders the Projects chips of every entry from one grants call', async () => {
    setup({
      entries: [entry(), entry({ id: 'e2', name: 'SOLO' }), entry({ id: 'e3', name: 'NARROW' })],
      grants: [
        grant('e1', 'pA'),
        grant('e1', 'pB'),
        grant('e1', 'pC'),
        grant('e1', 'pD'),
        grant('e3', 'pC', 'coder'),
        grant('e3', 'pC', 'reviewer'),
      ],
    });

    const row = (name: string) => screen.getByRole('button', { name }).closest('tr')!;
    await screen.findByText('Alpha: All agents');
    expect(
      within(row('API_TOKEN'))
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['Alpha: All agents', 'Beta: All agents', 'Crux: All agents', '+1']);
    expect(within(row('SOLO')).getByText('No projects')).toBeInTheDocument();
    expect(within(row('NARROW')).getByText('Crux: 2 roles')).toBeInTheDocument();
    expect(grantsMock).toHaveBeenCalledTimes(1);
    expect(grantsMock).toHaveBeenCalledWith();
  });

  it('saves a rename and a project change in the side panel with one PATCH', async () => {
    const user = setup({ entries: [entry()], grants: [grant('e1', 'pA')] });
    updateMock.mockResolvedValue(entry({ name: 'NEW_TOKEN' }));

    const panel = await openPanel();
    expect(within(panel).getByText('Revision 1')).toBeInTheDocument();
    expect(within(panel).getByText('Shared entry')).toBeInTheDocument();
    const saveButton = within(panel).getByRole('button', { name: 'Save changes' });
    expect(saveButton).toBeDisabled();
    fireEvent.change(within(panel).getByLabelText('Name'), { target: { value: 'NEW_TOKEN' } });
    await user.click(within(panel).getByRole('button', { name: 'Remove Alpha' }));
    await user.click(within(panel).getByRole('button', { name: 'Add projects' }));
    await user.click(screen.getByRole('checkbox', { name: 'Beta' }));
    await user.keyboard('{Escape}');
    await user.click(saveButton);

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(updateMock).toHaveBeenCalledWith('e1', {
      name: 'NEW_TOKEN',
      projects: [{ projectId: 'pB', mode: 'all' }],
    });
    expect(entriesMock.mock.calls.length).toBeGreaterThan(1);
    expect(grantsMock.mock.calls.length).toBeGreaterThan(1);
  });

  it('names the owner, and says when the project list makes the entry shared on save', async () => {
    const user = setup({ entries: [entry({ projectId: 'pA' })], grants: [grant('e1', 'pA')] });
    const panel = await openPanel();
    expect(within(panel).getByText('Entry of Alpha')).toBeInTheDocument();
    const becomesShared = /^Becomes a shared entry on save/;
    expect(within(panel).queryByText(becomesShared)).not.toBeInTheDocument();

    await user.click(within(panel).getByRole('button', { name: 'Add projects' }));
    await user.click(screen.getByRole('checkbox', { name: 'Beta' }));
    await user.keyboard('{Escape}');
    expect(within(panel).getByText(becomesShared)).toBeInTheDocument();
    expect(within(panel).getByText('Entry of Alpha')).toBeInTheDocument();

    await user.click(within(panel).getByRole('button', { name: 'Remove Beta' }));
    expect(within(panel).queryByText(becomesShared)).not.toBeInTheDocument();
  });

  it('leaves a dirty side panel for an Off project on the Projects tab only after a confirm', async () => {
    const user = setup({
      entries: [entry()],
      grants: [grant('e1', 'pB')],
      access: [accessRow('pA')],
    });
    const panel = await openPanel();
    const beta = within(panel).getByRole('listitem', { name: 'Beta' });
    await user.click(within(beta).getByRole('button', { name: 'Beta' }));
    expect(
      await within(beta).findByText('The Vault is off in Beta. Grants there stay inactive.'),
    ).toBeInTheDocument();
    fireEvent.change(within(panel).getByLabelText('Name'), { target: { value: 'NEW_TOKEN' } });

    const link = { name: 'Edit Vault access of Beta on the Projects tab' };
    await user.click(within(beta).getByRole('button', link));
    await user.click(await screen.findByRole('button', { name: 'Keep editing' }));
    expect(screen.getByRole('dialog', { name: 'API_TOKEN' })).toBeInTheDocument();

    await user.click(within(beta).getByRole('button', link));
    await user.click(await screen.findByRole('button', { name: 'Discard changes' }));
    const tab = await screen.findByRole('tabpanel', { name: 'Projects' });
    expect(await within(tab).findByRole('table', { name: 'Access in Beta' })).toBeInTheDocument();
    expect(within(tab).getByText(/^The Vault is off in Beta\./)).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'API_TOKEN' })).not.toBeInTheDocument(),
    );
    expect(updateMock).not.toHaveBeenCalled();
    expect(saveGrantsMock).not.toHaveBeenCalled();
  });

  it('keeps the side panel open and shows the server message when the save fails', async () => {
    setup({ entries: [entry()], grants: [] });
    updateMock.mockRejectedValue(new Error('A shared entry named NEW_TOKEN already exists.'));

    const panel = await openPanel();
    fireEvent.change(within(panel).getByLabelText('Name'), { target: { value: 'NEW_TOKEN' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Save changes' }));

    expect(
      await within(panel).findByText('A shared entry named NEW_TOKEN already exists.'),
    ).toHaveAttribute('role', 'alert');
    expect(screen.getByRole('dialog', { name: 'API_TOKEN' })).toBeInTheDocument();
    expect(within(panel).getByLabelText('Name')).toHaveValue('NEW_TOKEN');
  });

  it('asks before it closes the side panel with unsaved changes', async () => {
    const user = setup({ entries: [entry()], grants: [] });

    let panel = await openPanel();
    await user.click(within(panel).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    panel = await openPanel();
    fireEvent.change(within(panel).getByLabelText('Description'), { target: { value: 'Draft' } });
    await user.click(within(panel).getByRole('button', { name: 'Close' }));
    const confirm = await screen.findByRole('dialog', { name: 'Discard unsaved changes?' });
    await user.click(within(confirm).getByRole('button', { name: 'Keep editing' }));
    expect(within(panel).getByLabelText('Description')).toHaveValue('Draft');

    await user.keyboard('{Escape}');
    await user.click(
      within(await screen.findByRole('dialog', { name: 'Discard unsaved changes?' })).getByRole(
        'button',
        { name: 'Discard changes' },
      ),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('replaces the value and deletes an entry from the row menu', async () => {
    const user = setup({ entries: [entry()] });
    replaceMock.mockResolvedValue(entry({ revision: 2 }));
    deleteMock.mockResolvedValue(undefined);

    await user.click(
      within(await openRowMenu(user)).getByRole('menuitem', { name: 'Replace value' }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Replace value of API_TOKEN' });
    expect(within(dialog).getByLabelText('Value')).toHaveValue('');
    fireEvent.change(within(dialog).getByLabelText('Value'), { target: { value: SECRET } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Replace value' }));
    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith('e1', SECRET));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.queryByDisplayValue(SECRET)).not.toBeInTheDocument();

    await user.click(within(await openRowMenu(user)).getByRole('menuitem', { name: 'Delete' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith('e1'));
  });

  it('disables value writes and shows the unlock banner when locked', async () => {
    const user = setup({
      vault: status({ state: 'locked', protection: 'recovery', reason: 'recovery_required' }),
      entries: [entry()],
    });

    expect(await screen.findByLabelText('Unlock with recovery code')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add entry' })).toBeDisabled();
    const menu = await openRowMenu(user);
    expect(within(menu).getByRole('menuitem', { name: 'Replace value' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(within(menu).getByRole('menuitem', { name: 'Edit' })).not.toHaveAttribute(
      'aria-disabled',
    );
  });

  it("shows home's snapshot read-only on a claimed VM", async () => {
    setup({
      vault: status({
        state: 'not_set_up',
        protection: null,
        reason: 'claimed_host',
        vmCache: { cacheReady: true, cacheUnavailable: null },
      }),
      entries: [entry()],
      grants: [grant('e1', 'pA', 'coder')],
    });

    expect(await screen.findByText('Alpha: 1 role')).toBeInTheDocument();
    expect(screen.getByText('Vault managed by home')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add entry' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Actions for/ })).not.toBeInTheDocument();

    const panel = await openPanel();
    expect(within(panel).getByLabelText('Name')).toBeDisabled();
    expect(await within(panel).findByRole('checkbox', { name: /Coder/ })).toBeDisabled();
    expect(
      within(panel)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['']);
    expect(within(panel).getByRole('button', { name: 'Close' })).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole('button', { name: 'Close' }));

    const matrix = await openProjectsTab(userEvent.setup());
    expect(
      await within(matrix).findByRole('checkbox', { name: 'API_TOKEN for Coder in Alpha' }),
    ).toBeDisabled();
    expect(within(matrix).queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    expect(within(matrix).queryByRole('button', { name: 'Add entry' })).not.toBeInTheDocument();
    expect(within(matrix).getByRole('switch', { name: 'Vault in Alpha' })).toBeDisabled();
    expect(within(matrix).getByRole('radio', { name: 'All agents' })).toBeDisabled();
  });
});

async function openProjectsTab(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('tab', { name: 'Projects' }));
  return screen.findByRole('tabpanel', { name: 'Projects' });
}

async function chooseProject(panel: HTMLElement, name: string) {
  fireEvent.click(within(panel).getByRole('combobox', { name: 'Project' }));
  fireEvent.click(await screen.findByRole('option', { name }));
}

describe('VaultPage Projects tab', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockSelectedProjectId = undefined;
    (Element as unknown as { prototype: { scrollIntoView: unknown } }).prototype.scrollIntoView =
      jest.fn();
  });

  it('opens on the app-selected project instead of the first one', async () => {
    mockSelectedProjectId = 'pB';
    const user = setup();
    const panel = await openProjectsTab(user);
    expect(within(panel).getByRole('combobox', { name: 'Project' })).toHaveTextContent('Beta');
  });

  it('shows own and shared entries against the roles, and All agents covers every role', async () => {
    const user = setup({
      entries: [
        entry(),
        entry({ id: 'e2', name: 'OWN_KEY', projectId: 'pA' }),
        entry({ id: 'e3', name: 'BETA_KEY', projectId: 'pB' }),
        entry({ id: 'e4', name: 'DUP_KEY' }),
        entry({ id: 'e5', name: 'DUP_KEY', projectId: 'pA' }),
      ],
      grants: [grant('e1', 'pA')],
    });
    const panel = await openProjectsTab(user);
    const table = await within(panel).findByRole('table', { name: 'Access in Alpha' });

    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((header) => header.textContent),
    ).toEqual(['Entry', 'All agents', 'Coder1 agent', 'ReviewerNo agents']);
    expect(
      within(table)
        .getAllByRole('row')
        .slice(1)
        .map((row) => row.getAttribute('aria-label')),
    ).toEqual(['API_TOKEN', 'OWN_KEY', 'DUP_KEY', 'DUP_KEY']);
    const coder = within(table).getByRole('checkbox', { name: 'API_TOKEN for Coder in Alpha' });
    expect(coder).toBeChecked();
    expect(coder).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(coder);
    expect(coder).toBeChecked();
    expect(within(panel).getByText('No changes')).toBeInTheDocument();

    const [shared, own] = within(table).getAllByRole('row', { name: 'DUP_KEY' });
    expect(within(shared).getByText('This project also has its own DUP_KEY')).toBeInTheDocument();
    expect(within(own).getByText('Only this project')).toBeInTheDocument();
    expect(within(own).queryByText(/also has its own/)).not.toBeInTheDocument();
  });

  it('saves only the changed rows in one request, keeps an unmatched role, and refreshes', async () => {
    const user = setup({
      entries: [entry(), entry({ id: 'e2', name: 'OTHER_KEY' })],
      grants: [grant('e1', 'pA', 'coder'), grant('e1', 'pA', 'ghost', false), grant('e2', 'pA')],
    });
    const panel = await openProjectsTab(user);
    await user.click(
      await within(panel).findByRole('checkbox', { name: 'API_TOKEN for Reviewer in Alpha' }),
    );
    const otherAll = within(panel).getByRole('checkbox', {
      name: 'OTHER_KEY for All agents in Alpha',
    });
    await user.click(otherAll);
    expect(within(panel).getByText('2 changes')).toBeInTheDocument();
    await user.click(otherAll);
    expect(within(panel).getByText('1 change')).toBeInTheDocument();

    saveGrantsMock.mockRejectedValueOnce(new Error('The grants could not be saved'));
    await user.click(within(panel).getByRole('button', { name: 'Save' }));
    expect(await within(panel).findByRole('alert')).toHaveTextContent(
      'The grants could not be saved',
    );
    expect(within(panel).getByText('1 change')).toBeInTheDocument();

    saveGrantsMock.mockResolvedValue([]);
    grantsMock.mockResolvedValue([
      grant('e1', 'pA', 'coder'),
      grant('e1', 'pA', 'ghost', false),
      grant('e1', 'pA', 'reviewer'),
      grant('e2', 'pA'),
    ]);
    const loads = grantsMock.mock.calls.length;
    await user.click(within(panel).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(within(panel).getByText('No changes')).toBeInTheDocument());
    expect(saveGrantsMock).toHaveBeenLastCalledWith(
      'pA',
      [{ entryId: 'e1', mode: 'families', familySlugs: ['coder', 'ghost', 'reviewer'] }],
      undefined,
    );
    expect(grantsMock.mock.calls.length).toBeGreaterThan(loads);
    expect(
      within(panel).getByRole('checkbox', { name: 'API_TOKEN for Reviewer in Alpha' }),
    ).toBeChecked();

    await user.click(
      within(panel).getByRole('button', { name: 'Remove role ghost from API_TOKEN' }),
    );
    await user.click(within(panel).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(saveGrantsMock).toHaveBeenLastCalledWith(
        'pA',
        [{ entryId: 'e1', mode: 'families', familySlugs: ['coder', 'reviewer'] }],
        undefined,
      ),
    );
  });

  it('brings the roles back when All agents turns off, and saves none for a row with no role', async () => {
    const user = setup({ entries: [entry()], grants: [grant('e1', 'pA', 'coder')] });
    const panel = await openProjectsTab(user);
    const all = await within(panel).findByRole('checkbox', {
      name: 'API_TOKEN for All agents in Alpha',
    });
    const coder = within(panel).getByRole('checkbox', { name: 'API_TOKEN for Coder in Alpha' });

    await user.click(all);
    await user.click(all);
    expect(coder).toBeChecked();
    expect(within(panel).getByText('No changes')).toBeInTheDocument();

    await user.click(coder);
    saveGrantsMock.mockResolvedValue([]);
    await user.click(within(panel).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(saveGrantsMock).toHaveBeenCalledWith(
        'pA',
        [{ entryId: 'e1', mode: 'none' }],
        undefined,
      ),
    );
  });

  it('keeps an unsaved draft on its own project when the project list changes', async () => {
    const user = setup({ entries: [entry()] });
    const panel = await openProjectsTab(user);
    await user.click(
      await within(panel).findByRole('checkbox', { name: 'API_TOKEN for All agents in Alpha' }),
    );
    expect(within(panel).getByText('1 change')).toBeInTheDocument();

    // A new project that sorts first does not take the place of the shown project.
    setProjects([
      { id: 'p0', name: 'Aardvark' },
      { id: 'pA', name: 'Alpha' },
      { id: 'pB', name: 'Beta' },
    ]);
    rerenderPage();
    expect(
      within(panel).getByRole('checkbox', { name: 'API_TOKEN for All agents in Alpha' }),
    ).toBeChecked();
    expect(within(panel).getByText('1 change')).toBeInTheDocument();

    // The shown project is deleted: its draft does not move to the project shown now.
    setProjects([
      { id: 'p0', name: 'Aardvark' },
      { id: 'pB', name: 'Beta' },
    ]);
    rerenderPage();
    expect(
      await within(panel).findByRole('checkbox', { name: 'API_TOKEN for All agents in Aardvark' }),
    ).not.toBeChecked();
    expect(within(panel).getByText('No changes')).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(saveGrantsMock).not.toHaveBeenCalled();
  });

  it('shows no matrix to edit when the grants cannot be loaded', async () => {
    const user = setup({ entries: [entry()], grants: new Error('Grants could not be loaded') });
    const panel = await openProjectsTab(user);

    expect(await within(panel).findByRole('alert')).toHaveTextContent('Grants could not be loaded');
    expect(within(panel).queryByRole('table')).not.toBeInTheDocument();
    expect(within(panel).queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('asks before leaving the project or the tab with unsaved changes', async () => {
    const user = setup({ entries: [entry()] });
    const panel = await openProjectsTab(user);
    await user.click(
      await within(panel).findByRole('checkbox', { name: 'API_TOKEN for All agents in Alpha' }),
    );

    await chooseProject(panel, 'Beta');
    const confirm = await screen.findByRole('dialog', { name: 'Discard unsaved changes?' });
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(within(panel).getByRole('combobox', { name: 'Project' })).toHaveTextContent('Alpha');
    expect(within(panel).getByText('1 change')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Entries' }));
    const leave = await screen.findByRole('dialog', { name: 'Discard unsaved changes?' });
    await user.click(within(leave).getByRole('button', { name: 'Discard' }));
    expect(await screen.findByRole('tab', { name: 'Entries', selected: true })).toBeInTheDocument();
  });

  it('opens Add entry with the selected project, and its Off cue selects that project here', async () => {
    const user = setup({ access: [accessRow('pA'), accessRow('pB')] });
    const panel = await openProjectsTab(user);
    expect(await within(panel).findByText('No entries yet. Add an entry.')).toBeInTheDocument();

    await chooseProject(panel, 'Beta');
    const add = within(panel).getByRole('button', { name: 'Add entry' });
    await waitFor(() => expect(add).toBeEnabled());
    await user.click(add);
    const dialog = await screen.findByRole('dialog', { name: 'Add Vault entry' });
    const beta = within(dialog).getByRole('listitem', { name: 'Beta' });
    await user.click(within(beta).getByRole('button', { name: 'Beta' }));
    expect(within(beta).getByRole('radio', { name: 'All agents' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(within(dialog).queryByRole('listitem', { name: 'Alpha' })).not.toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Add projects' }));
    await user.click(screen.getByRole('checkbox', { name: 'Crux' }));
    await user.keyboard('{Escape}');
    await user.click(
      await within(dialog).findByRole('button', {
        name: 'Edit Vault access of Crux on the Projects tab',
      }),
    );
    expect(
      await within(panel).findByRole('region', { name: 'Vault access in Crux' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Add Vault entry' })).not.toBeInTheDocument();
    expect(createMock).not.toHaveBeenCalled();
  });

  it('turns the Vault on in a project with one access request', async () => {
    const user = setup({ access: [] });
    const panel = await openProjectsTab(user);
    const section = await within(panel).findByRole('region', { name: 'Vault access in Alpha' });
    expect(
      within(section).getByText(/^Off\. .*Vault instructions automatically/),
    ).toBeInTheDocument();
    const banner = /^The Vault is off in Alpha\. The grants below stay inactive/;
    expect(within(panel).getAllByText(banner)).toHaveLength(1);

    await user.click(within(section).getByRole('switch', { name: 'Vault in Alpha' }));
    expect(within(panel).getByText('1 change')).toBeInTheDocument();
    expect(within(panel).queryByText(banner)).not.toBeInTheDocument();
    saveGrantsMock.mockResolvedValue([]);
    accessMock.mockResolvedValue([accessRow('pA')]);
    await user.click(within(panel).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(within(panel).getByText('No changes')).toBeInTheDocument());
    expect(saveGrantsMock.mock.calls).toEqual([['pA', [], { mode: 'all' }]]);
    expect(within(section).getByRole('switch', { name: 'Vault in Alpha' })).toBeChecked();
  });

  it('narrows the Vault to chosen roles, and needs a role first', async () => {
    const user = setup();
    const panel = await openProjectsTab(user);
    const section = await within(panel).findByRole('region', { name: 'Vault access in Alpha' });

    await user.click(within(section).getByRole('radio', { name: 'Chosen roles' }));
    expect(within(section).getByText('Choose at least one role.')).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Save' })).toBeDisabled();

    await user.click(await within(section).findByRole('checkbox', { name: /Coder/ }));
    saveGrantsMock.mockResolvedValue([]);
    await user.click(within(panel).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(saveGrantsMock).toHaveBeenCalledWith('pA', [], {
        mode: 'families',
        familySlugs: ['coder'],
      }),
    );
  });

  it('turns the Vault off only after a confirm that names the consequence', async () => {
    const user = setup({ entries: [entry()] });
    const panel = await openProjectsTab(user);
    const section = await within(panel).findByRole('region', { name: 'Vault access in Alpha' });
    await user.click(within(section).getByRole('switch', { name: 'Vault in Alpha' }));
    await user.click(within(panel).getByRole('button', { name: 'Save' }));

    const confirm = await screen.findByRole('dialog', { name: 'Turn off the Vault in Alpha?' });
    expect(confirm).toHaveTextContent('Agents of Alpha lose Vault access at once');
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(saveGrantsMock).not.toHaveBeenCalled();

    saveGrantsMock.mockResolvedValue([]);
    await user.click(within(panel).getByRole('button', { name: 'Save' }));
    const again = await screen.findByRole('dialog', { name: 'Turn off the Vault in Alpha?' });
    await user.click(within(again).getByRole('button', { name: 'Turn off' }));
    await waitFor(() => expect(saveGrantsMock).toHaveBeenCalledWith('pA', [], { mode: 'none' }));
  });

  it('marks the roles with grants and no Vault access, and saves the access with the cells at once', async () => {
    const user = setup({
      entries: [entry()],
      grants: [grant('e1', 'pA', 'coder')],
      access: [],
    });
    const panel = await openProjectsTab(user);
    const table = await within(panel).findByRole('table', { name: 'Access in Alpha' });
    const [, , coder, reviewer] = within(table).getAllByRole('columnheader');
    await waitFor(() => expect(within(coder).getByText('No Vault access')).toBeInTheDocument());
    expect(within(reviewer).queryByText('No Vault access')).not.toBeInTheDocument();
    const addAccess = () =>
      user.click(within(coder).getByRole('button', { name: 'Add Vault access for Coder' }));
    const reviewerCell = () =>
      user.click(within(table).getByRole('checkbox', { name: 'API_TOKEN for Reviewer in Alpha' }));

    await addAccess();
    expect(within(coder).queryByText('No Vault access')).not.toBeInTheDocument();
    expect(within(panel).getByText('1 change')).toBeInTheDocument();
    await user.click(within(panel).getByRole('button', { name: 'Discard' }));
    expect(within(panel).getByText('No changes')).toBeInTheDocument();
    expect(within(coder).getByText('No Vault access')).toBeInTheDocument();

    await addAccess();
    await reviewerCell();
    expect(within(panel).getByText('2 changes')).toBeInTheDocument();
    const accessLoads = accessMock.mock.calls.length;
    saveGrantsMock.mockRejectedValueOnce(new Error('The grants could not be saved'));
    await user.click(within(panel).getByRole('button', { name: 'Save' }));
    expect(await within(panel).findByRole('alert')).toHaveTextContent(
      'The grants could not be saved',
    );
    expect(within(panel).getByText('2 changes')).toBeInTheDocument();
    expect(accessMock.mock.calls.length).toBe(accessLoads);

    saveGrantsMock.mockResolvedValue([]);
    await user.click(within(panel).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saveGrantsMock).toHaveBeenCalledTimes(2));
    expect(saveGrantsMock.mock.calls).toEqual([
      [
        'pA',
        [{ entryId: 'e1', mode: 'families', familySlugs: ['coder', 'reviewer'] }],
        { mode: 'families', familySlugs: ['coder'] },
      ],
      [
        'pA',
        [{ entryId: 'e1', mode: 'families', familySlugs: ['coder', 'reviewer'] }],
        { mode: 'families', familySlugs: ['coder'] },
      ],
    ]);
  });

  it('names the locked-Vault refusal when a save is refused for it', async () => {
    const user = setup({ entries: [entry()] });
    const panel = await openProjectsTab(user);
    await user.click(
      await within(panel).findByRole('checkbox', { name: 'API_TOKEN for All agents in Alpha' }),
    );
    saveGrantsMock.mockRejectedValue(lockedRefusal());
    await user.click(within(panel).getByRole('button', { name: 'Save' }));

    expect(await within(panel).findByRole('alert')).toHaveTextContent(LOCKED_REMOTE_ACCESS_MESSAGE);
    expect(within(panel).getByText('1 change')).toBeInTheDocument();
  });
});
