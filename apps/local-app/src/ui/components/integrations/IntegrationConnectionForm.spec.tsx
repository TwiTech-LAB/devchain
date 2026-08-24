import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  IntegrationConnectionApiError,
  type ReplaceIntegrationConnectionInput,
} from '@/ui/hooks/useIntegrationConnections';
import { IntegrationConnectionForm } from './IntegrationConnectionForm';

const disconnected = {
  connected: false,
  connectionId: null,
  generation: null,
  subtaskSyncEnabled: false,
  syncSettingRevision: null,
  updatedAt: null,
} as const;

const connectedClickUp = {
  provider: 'clickup',
  connected: true,
  connectionId: 'connection-clickup',
  generation: 1,
  subtaskSyncEnabled: true,
  syncSettingRevision: 2,
  updatedAt: '2026-08-23T00:00:00.000Z',
} as const;

describe('IntegrationConnectionForm', () => {
  it('keeps ClickUp validation field-specific without submitting', async () => {
    const user = userEvent.setup();
    const onReplace = jest.fn();
    render(
      <IntegrationConnectionForm
        provider="clickup"
        connection={{ ...disconnected, provider: 'clickup' }}
        onReplace={onReplace}
        onDisconnect={jest.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: /connect clickup/i }));

    expect(await screen.findByText('Personal API token is required.')).toBeInTheDocument();
    expect(onReplace).not.toHaveBeenCalled();
  });

  it('submits the shared managed-subtask option off by default and when opted in', async () => {
    const user = userEvent.setup();
    const onReplace = jest.fn(async () => undefined);
    render(
      <IntegrationConnectionForm
        provider="clickup"
        connection={{ ...disconnected, provider: 'clickup' }}
        onReplace={onReplace}
        onDisconnect={jest.fn()}
      />,
    );

    const syncSwitch = screen.getByRole('switch', {
      name: 'Sync DevChain sub-epics as managed subtasks',
    });
    expect(syncSwitch).not.toBeChecked();
    await user.type(screen.getByLabelText('Personal API token'), 'first-token');
    await user.click(screen.getByRole('button', { name: /connect clickup/i }));
    expect(onReplace).toHaveBeenLastCalledWith({
      provider: 'clickup',
      token: 'first-token',
      subtaskSyncEnabled: false,
    });

    await user.click(syncSwitch);
    await user.type(screen.getByLabelText('Personal API token'), 'second-token');
    await user.click(screen.getByRole('button', { name: /connect clickup/i }));
    expect(onReplace).toHaveBeenLastCalledWith({
      provider: 'clickup',
      token: 'second-token',
      subtaskSyncEnabled: true,
    });
  });

  it('uses explicit classic Jira token wording with non-assertive scoped-token guidance', () => {
    render(
      <IntegrationConnectionForm
        provider="jira"
        connection={{ ...disconnected, provider: 'jira' }}
        onReplace={jest.fn()}
        onDisconnect={jest.fn()}
      />,
    );

    expect(screen.getByLabelText('Classic API token (without scopes)')).toBeInTheDocument();
    expect(
      screen.getByText('Scoped Jira API tokens may not work with this connection yet.'),
    ).toBeInTheDocument();
  });

  it('allows a connected Jira account to replace only its token', async () => {
    const user = userEvent.setup();
    const onReplace = jest.fn(async (_input: ReplaceIntegrationConnectionInput) => undefined);
    render(
      <IntegrationConnectionForm
        provider="jira"
        connection={{
          provider: 'jira',
          connected: true,
          connectionId: 'connection-jira',
          generation: 1,
          subtaskSyncEnabled: false,
          syncSettingRevision: 1,
          updatedAt: '2026-08-19T00:00:00.000Z',
        }}
        onReplace={onReplace}
        onDisconnect={jest.fn()}
      />,
    );

    await user.type(screen.getByLabelText('Classic API token (without scopes)'), 'new-token');
    await user.click(screen.getByRole('button', { name: /replace jira credentials/i }));

    expect(onReplace).toHaveBeenCalledWith({ provider: 'jira', token: 'new-token' });
  });

  it('requires explicit orphan acknowledgement before credential replacement or disconnect', async () => {
    const user = userEvent.setup();
    const onReplace = jest.fn(async () => undefined);
    const onDisconnect = jest.fn(async () => undefined);
    render(
      <IntegrationConnectionForm
        provider="clickup"
        connection={connectedClickUp}
        onReplace={onReplace}
        onDisconnect={onDisconnect}
        requiresOrphanRiskAcknowledgement
      />,
    );

    await user.type(screen.getByLabelText('Personal API token'), 'replacement-token');
    await user.click(screen.getByRole('button', { name: /replace clickup credentials/i }));
    expect(onReplace).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toHaveTextContent(/may already exist remotely/i);
    await user.click(screen.getByRole('button', { name: 'Acknowledge possible remote orphan' }));
    expect(onReplace).toHaveBeenCalledWith({
      provider: 'clickup',
      token: 'replacement-token',
      acknowledgeOrphanRisk: true,
    });

    await user.click(screen.getByRole('button', { name: 'Disconnect' }));
    await user.click(screen.getByRole('button', { name: 'Acknowledge possible remote orphan' }));
    expect(onDisconnect).toHaveBeenCalledWith('clickup', true);
  });

  it('offers orphan acknowledgement when the backend detects unresolved work', async () => {
    const user = userEvent.setup();
    const onReplace = jest
      .fn()
      .mockRejectedValueOnce(
        new IntegrationConnectionApiError('Acknowledgement required.', {
          providerReason: 'orphan_risk_ack_required',
        }),
      )
      .mockResolvedValueOnce(undefined);
    render(
      <IntegrationConnectionForm
        provider="clickup"
        connection={connectedClickUp}
        onReplace={onReplace}
        onDisconnect={jest.fn()}
      />,
    );

    await user.type(screen.getByLabelText('Personal API token'), 'replacement-token');
    await user.click(screen.getByRole('button', { name: /replace clickup credentials/i }));
    expect(onReplace).toHaveBeenNthCalledWith(1, {
      provider: 'clickup',
      token: 'replacement-token',
    });

    await user.click(
      await screen.findByRole('button', { name: 'Acknowledge possible remote orphan' }),
    );
    expect(onReplace).toHaveBeenNthCalledWith(2, {
      provider: 'clickup',
      token: 'replacement-token',
      acknowledgeOrphanRisk: true,
    });
  });

  it('preserves typed Jira input state after a server field error', async () => {
    const user = userEvent.setup();
    const onReplace = jest.fn(async () => {
      throw new IntegrationConnectionApiError('Invalid account email.', {
        code: 'validation_error',
        field: 'email',
      });
    });
    render(
      <IntegrationConnectionForm
        provider="jira"
        connection={{ ...disconnected, provider: 'jira' }}
        onReplace={onReplace}
        onDisconnect={jest.fn()}
      />,
    );

    await user.type(screen.getByLabelText('Jira site URL'), 'https://acme.atlassian.net');
    await user.type(screen.getByLabelText('Account email'), 'invalid@example.com');
    await user.type(screen.getByLabelText('Classic API token (without scopes)'), 'test-token');
    await user.click(screen.getByRole('button', { name: /connect jira/i }));

    expect(await screen.findByText('Invalid account email.')).toBeInTheDocument();
    expect(screen.getByLabelText('Jira site URL')).toHaveValue('https://acme.atlassian.net');
    expect(screen.getByLabelText('Account email')).toHaveValue('invalid@example.com');
    expect(screen.getByLabelText('Classic API token (without scopes)')).toHaveValue('test-token');
  });
});
