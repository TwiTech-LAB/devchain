import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ProviderAuthEntryItem } from './lib/remote-vm-contracts';
import { ReauthDialog } from './ReauthDialog';

let entries: ProviderAuthEntryItem[];
let retried: { operationId: string; providerAuth: Record<string, string> } | null;

function entry(
  partial: Partial<ProviderAuthEntryItem> & { id: string; provider: string },
): ProviderAuthEntryItem {
  return {
    kind: 'family',
    label: 'Entry',
    payloadKind: 'files',
    checkedOutRemoteId: null,
    createdAt: '2026-09-24T00:00:00.000Z',
    updatedAt: '2026-09-24T00:00:00.000Z',
    lastVerifiedAt: null,
    lastWritebackAt: null,
    ...partial,
  };
}

beforeEach(() => {
  entries = [];
  retried = null;
  global.fetch = jest.fn(async (url: string | undefined) => {
    if (String(url) === '/api/provider-auth') {
      return { ok: true, json: async () => ({ items: entries }) } as Response;
    }
    return { ok: true, json: async () => ({}) } as Response;
  }) as unknown as typeof fetch;
});

function renderDialog(remoteId: string | null = 'r-new') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ReauthDialog
        operationId="op9"
        providers={['codex', 'agy']}
        remoteId={remoteId}
        remoteNames={new Map([['r-lab', 'vm-lab']])}
        pending={false}
        onClose={jest.fn()}
        onRetry={(operationId, providerAuth) => {
          retried = { operationId, providerAuth };
        }}
      />
    </QueryClientProvider>,
  );
}

const trigger = (provider: string) =>
  screen.getByRole('combobox', { name: `${provider} login choice` });

describe('ReauthDialog', () => {
  it('sends choices for the failed providers only, through retry', async () => {
    entries = [entry({ id: 'e2', provider: 'agy', label: 'Agy login' })];
    renderDialog();

    expect(screen.queryByRole('combobox', { name: 'claude login choice' })).not.toBeInTheDocument();
    await waitFor(() => expect(trigger('agy')).toHaveTextContent('Agy login · Login'));

    await userEvent.click(trigger('codex'));
    await userEvent.click(
      await screen.findByRole('option', { name: 'New login (sign in during setup)' }),
    );
    await userEvent.click(screen.getByTestId('reauth-submit'));

    expect(retried).toEqual({
      operationId: 'op9',
      providerAuth: { codex: 'generate', agy: 'reuse:e2' },
    });
  });

  it('never preselects a Codex family that vm-lab holds for another VM', async () => {
    entries = [
      entry({ id: 'f1', provider: 'codex', label: 'Codex family', checkedOutRemoteId: 'r-lab' }),
    ];
    renderDialog();

    await userEvent.click(trigger('codex'));
    expect(
      await screen.findByRole('option', { name: 'Codex family · Login · on vm-lab' }),
    ).toHaveAttribute('aria-disabled', 'true');
    await userEvent.keyboard('{Escape}');
    expect(trigger('codex')).toHaveTextContent('None');

    await userEvent.click(screen.getByTestId('reauth-submit'));
    expect(retried).toEqual({ operationId: 'op9', providerAuth: {} });
  });
});
