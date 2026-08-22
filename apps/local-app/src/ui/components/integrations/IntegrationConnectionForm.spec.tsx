import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  IntegrationConnectionApiError,
  type ReplaceIntegrationConnectionInput,
} from '@/ui/hooks/useIntegrationConnections';
import { IntegrationConnectionForm } from './IntegrationConnectionForm';

const disconnected = {
  connected: false,
  generation: null,
  updatedAt: null,
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
          generation: 1,
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
