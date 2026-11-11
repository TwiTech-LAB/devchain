/**
 * The agent-request modal. UI component layer: what the user sees for each request
 * variant and what each answer sends are the behavior; the REST client and the home
 * socket are the mocked edges, the query cache is real.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useHomeSocket } from '@/ui/hooks/useHomeSocket';
import {
  approveVaultRequest,
  denyVaultRequest,
  fetchVaultRequests,
  fulfillVaultRequest,
  type VaultRequestView,
} from '@/ui/lib/vault-requests';
import { VaultRequestModal } from './VaultRequestModal';

jest.mock('@/ui/hooks/useHomeSocket', () => ({ useHomeSocket: jest.fn() }));
jest.mock('@/ui/lib/vault-requests', () => ({
  ...jest.requireActual('@/ui/lib/vault-requests'),
  fetchVaultRequests: jest.fn(),
  fulfillVaultRequest: jest.fn(),
  approveVaultRequest: jest.fn(),
  denyVaultRequest: jest.fn(),
}));

const listMock = fetchVaultRequests as jest.MockedFunction<typeof fetchVaultRequests>;
const fulfillMock = fulfillVaultRequest as jest.MockedFunction<typeof fulfillVaultRequest>;
const approveMock = approveVaultRequest as jest.MockedFunction<typeof approveVaultRequest>;
const denyMock = denyVaultRequest as jest.MockedFunction<typeof denyVaultRequest>;
const socketMock = useHomeSocket as jest.MockedFunction<typeof useHomeSocket>;

function request(overrides: Partial<VaultRequestView> = {}): VaultRequestView {
  return {
    requestId: 'r1',
    projectId: 'A',
    projectName: 'Alpha',
    sessionId: 's1',
    agentId: 'a1',
    agentName: 'Coder 1',
    familySlug: 'coder',
    type: 'create',
    name: 'STRIPE_KEY',
    description: 'Needed to run the payment tests',
    kind: 'secret',
    entryId: null,
    entryDescription: null,
    remoteName: null,
    createdAt: 0,
    expiresAt: 1,
    ...overrides,
  };
}

function renderModal() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <VaultRequestModal />
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

beforeEach(() => {
  jest.clearAllMocks();
  fulfillMock.mockResolvedValue({
    requestId: 'r1',
    status: 'fulfilled',
    permanent: false,
    entryId: null,
  });
  denyMock.mockResolvedValue();
  approveMock.mockImplementation((requestId, decision) =>
    Promise.resolve({ requestId, status: 'approved', decision }),
  );
});

const useRequest = (overrides: Partial<VaultRequestView> = {}) =>
  request({
    type: 'use',
    entryId: 'e1',
    description: '',
    entryDescription: 'Live key of the shop',
    ...overrides,
  });

const USE_ACTIONS = ['Approve for this session', 'Approve once', 'Never ask for this role'];

it.each([
  ['Approve for this session', 'session'],
  ['Approve once', 'once'],
  ['Never ask for this role', 'family'],
] as const)('answers a use request with "%s"', async (label, decision) => {
  listMock.mockResolvedValueOnce([useRequest()]).mockResolvedValue([]);
  const user = renderModal();

  expect(await screen.findByText(/Agent Coder 1 wants to use/)).toBeTruthy();
  expect(screen.queryByLabelText('Value')).toBeNull();
  await user.click(screen.getByRole('button', { name: label }));

  await waitFor(() => expect(approveMock).toHaveBeenCalledWith('r1', decision));
  expect(fulfillMock).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});

it.each([
  ['a requester without a role', { familySlug: null }, 'Never ask for this role'],
  ['a file entry', { kind: 'file' as const }, 'Approve once'],
])('hides one use action for %s', async (_case, overrides, hidden) => {
  listMock.mockResolvedValue([useRequest(overrides)]);
  renderModal();

  await screen.findByText(/Agent Coder 1 wants to use/);
  for (const label of USE_ACTIONS) {
    const button = screen.queryByRole('button', { name: label });
    if (label === hidden) expect(button).toBeNull();
    else expect(button).toBeTruthy();
  }
});

it('denies a use request with the optional reason on the shared deny route', async () => {
  listMock.mockResolvedValue([useRequest()]);
  const user = renderModal();

  await user.type(await screen.findByLabelText(/Reason if you deny/), 'Not in this run');
  await user.click(screen.getByRole('button', { name: 'Deny' }));

  await waitFor(() => expect(denyMock).toHaveBeenCalledWith('r1', 'Not in this run'));
  expect(approveMock).not.toHaveBeenCalled();
});

it('opens a request that was pending before the page loaded and gives it for one session', async () => {
  listMock.mockResolvedValueOnce([request()]).mockResolvedValue([]);
  const user = renderModal();

  expect(await screen.findByText('Needed to run the payment tests')).toBeTruthy();
  await user.type(screen.getByLabelText('Value'), 'sk-canary');
  await user.click(screen.getByLabelText(/This session only/));
  await user.click(screen.getByRole('button', { name: 'Give for this session' }));

  await waitFor(() =>
    expect(fulfillMock).toHaveBeenCalledWith('r1', { value: 'sk-canary', permanent: false }),
  );
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});

it('states the all-agents scope for a requester without a role before a permanent save', async () => {
  listMock.mockResolvedValue([request({ familySlug: null })]);
  const user = renderModal();

  const warning = /gives STRIPE_KEY to all agents of Alpha/;
  expect(await screen.findByText(warning)).toBeTruthy();
  expect(screen.getByText(/Choose "This session only"/)).toBeTruthy();

  await user.click(screen.getByLabelText(/This session only/));
  expect(screen.queryByText(warning)).toBeNull();
});

it('names the VM a mirrored request came from', async () => {
  listMock.mockResolvedValue([request({ remoteName: 'build-vm' })]);
  renderModal();
  expect(await screen.findByText(/Alpha · on VM build-vm · role coder/)).toBeTruthy();
});

it('names no VM for a request raised on this instance', async () => {
  listMock.mockResolvedValue([request()]);
  renderModal();
  expect(await screen.findByText(/Alpha · role coder/)).toBeTruthy();
  expect(screen.queryByText(/on VM/)).toBeNull();
});

it('approves a grant request without a value field', async () => {
  listMock.mockResolvedValue([
    request({
      type: 'grant',
      entryId: 'e1',
      entryDescription: 'Live key of the shop',
    }),
  ]);
  const user = renderModal();

  expect(await screen.findByText('Live key of the shop')).toBeTruthy();
  expect(screen.queryByLabelText('Value')).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Grant access' }));

  await waitFor(() => expect(fulfillMock).toHaveBeenCalledWith('r1', { permanent: true }));
});

it('denies with the optional reason', async () => {
  listMock.mockResolvedValue([request()]);
  const user = renderModal();

  await user.type(await screen.findByLabelText(/Reason if you deny/), 'Use the test key');
  await user.click(screen.getByRole('button', { name: 'Deny' }));

  await waitFor(() => expect(denyMock).toHaveBeenCalledWith('r1', 'Use the test key'));
});

it('loads the list again when a request frame arrives on the home socket', async () => {
  listMock.mockResolvedValueOnce([]).mockResolvedValue([request()]);
  renderModal();
  await waitFor(() => expect(listMock).toHaveBeenCalledTimes(1));

  const handlers = socketMock.mock.calls.at(-1)![0];
  handlers.message({ topic: 'system', type: 'session_recommendation', payload: {}, ts: '' });
  expect(listMock).toHaveBeenCalledTimes(1);
  handlers.message({
    topic: 'project/A/vault-requests',
    type: 'vault_request.pending',
    payload: {},
    ts: '',
  });

  expect(await screen.findByText('Needed to run the payment tests')).toBeTruthy();
});
