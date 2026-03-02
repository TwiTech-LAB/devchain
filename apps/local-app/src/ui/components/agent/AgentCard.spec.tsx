import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AgentCard } from './AgentCard';
import type {
  AgentCardProps,
  AgentCardData,
  AgentCardProfile,
  AgentCardProvider,
} from './AgentCard';

const baseProfile: AgentCardProfile = {
  id: 'profile-1',
  name: 'Default Profile',
  providerId: 'provider-1',
  provider: { id: 'provider-1', name: 'claude' },
  promptCount: 3,
};

const baseProvider: AgentCardProvider = {
  id: 'provider-1',
  name: 'claude',
};

const baseAgent: AgentCardData = {
  id: 'agent-1',
  projectId: 'project-1',
  profileId: 'profile-1',
  name: 'Agent One',
  description: 'A test agent description',
  profile: baseProfile,
  createdAt: '2024-06-15T00:00:00.000Z',
  updatedAt: '2024-06-15T00:00:00.000Z',
};

const providersById = new Map<string, AgentCardProvider>([['provider-1', baseProvider]]);

function buildProps(overrides?: Partial<AgentCardProps>): AgentCardProps {
  return {
    agent: baseAgent,
    profile: baseProfile,
    providerName: 'claude',
    providersById,
    presence: undefined,
    isLastUsed: false,
    isLaunching: false,
    isUpdating: false,
    isDeleting: false,
    controlsDisabled: false,
    isTerminating: false,
    isRestarting: false,
    onLaunch: jest.fn(),
    onRestart: jest.fn(),
    onTerminate: jest.fn(),
    onEdit: jest.fn(),
    onDelete: jest.fn(),
    ...overrides,
  };
}

describe('AgentCard', () => {
  it('renders agent name, profile, description, and created date', () => {
    render(<AgentCard {...buildProps()} />);

    expect(screen.getByText('Agent One')).toBeInTheDocument();
    expect(screen.getByText('Default Profile')).toBeInTheDocument();
    expect(screen.getByText('A test agent description')).toBeInTheDocument();
    expect(screen.getByText(/6\/15\/2024/)).toBeInTheDocument();
  });

  it('renders data-testid with agent id', () => {
    render(<AgentCard {...buildProps()} />);

    expect(screen.getByTestId('agent-card-agent-1')).toBeInTheDocument();
  });

  it('shows "Unnamed agent" when agent name is empty', () => {
    render(<AgentCard {...buildProps({ agent: { ...baseAgent, name: '' } })} />);

    expect(screen.getByText('Unnamed agent')).toBeInTheDocument();
  });

  it('shows "Unknown Profile" when profile is undefined', () => {
    render(<AgentCard {...buildProps({ profile: undefined })} />);

    expect(screen.getByText('Unknown Profile')).toBeInTheDocument();
  });

  it('shows "Last launched" badge when isLastUsed is true', () => {
    render(<AgentCard {...buildProps({ isLastUsed: true })} />);

    expect(screen.getByText('Last launched')).toBeInTheDocument();
  });

  it('does not show "Last launched" badge when isLastUsed is false', () => {
    render(<AgentCard {...buildProps({ isLastUsed: false })} />);

    expect(screen.queryByText('Last launched')).not.toBeInTheDocument();
  });

  it('shows provider name badge', () => {
    render(<AgentCard {...buildProps({ providerName: 'claude' })} />);

    expect(screen.getByText('CLAUDE')).toBeInTheDocument();
  });

  it('shows prompt count badge', () => {
    render(<AgentCard {...buildProps()} />);

    expect(screen.getByText('3 prompts')).toBeInTheDocument();
  });

  it('shows singular "prompt" for count of 1', () => {
    render(<AgentCard {...buildProps({ profile: { ...baseProfile, promptCount: 1 } })} />);

    expect(screen.getByText('1 prompt')).toBeInTheDocument();
  });

  it('shows provider config badge when agent has providerConfig', () => {
    const agentWithConfig: AgentCardData = {
      ...baseAgent,
      providerConfig: {
        id: 'config-1',
        profileId: 'profile-1',
        providerId: 'provider-1',
        name: 'default',
        options: null,
        env: null,
      },
    };
    render(<AgentCard {...buildProps({ agent: agentWithConfig })} />);

    expect(screen.getByText('default')).toBeInTheDocument();
  });

  it('shows [env] suffix on provider config badge when env is set', () => {
    const agentWithConfig: AgentCardData = {
      ...baseAgent,
      providerConfig: {
        id: 'config-1',
        profileId: 'profile-1',
        providerId: 'provider-1',
        name: 'custom-config',
        options: null,
        env: { API_KEY: 'xxx' },
      },
    };
    render(<AgentCard {...buildProps({ agent: agentWithConfig })} />);

    expect(screen.getByText('custom-config [env]')).toBeInTheDocument();
  });

  // ---- Session controls: Launch ----

  it('shows Launch Session button when no active session', () => {
    render(<AgentCard {...buildProps({ presence: undefined })} />);

    expect(screen.getByRole('button', { name: /launch session/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /restart session/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /terminate session/i })).not.toBeInTheDocument();
  });

  it('calls onLaunch with agent id when Launch clicked', async () => {
    const user = userEvent.setup();
    const onLaunch = jest.fn();
    render(<AgentCard {...buildProps({ onLaunch })} />);

    await user.click(screen.getByRole('button', { name: /launch session/i }));

    expect(onLaunch).toHaveBeenCalledWith('agent-1');
  });

  it('disables Launch button when controlsDisabled is true', () => {
    render(<AgentCard {...buildProps({ controlsDisabled: true })} />);

    expect(screen.getByRole('button', { name: /launch session/i })).toBeDisabled();
  });

  it('shows Launching spinner when isLaunching is true', () => {
    render(<AgentCard {...buildProps({ isLaunching: true })} />);

    expect(screen.getByText('Launching…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /launch session/i })).toBeDisabled();
  });

  // ---- Session controls: Restart & Terminate ----

  it('shows Restart and Terminate buttons when agent has active session', () => {
    render(<AgentCard {...buildProps({ presence: { online: true, sessionId: 'sess-1' } })} />);

    expect(screen.getByRole('button', { name: /restart session/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /terminate session/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /launch session/i })).not.toBeInTheDocument();
  });

  it('calls onRestart with agent id and session id when Restart clicked', async () => {
    const user = userEvent.setup();
    const onRestart = jest.fn();
    render(
      <AgentCard
        {...buildProps({
          presence: { online: true, sessionId: 'sess-1' },
          onRestart,
        })}
      />,
    );

    await user.click(screen.getByRole('button', { name: /restart session/i }));

    expect(onRestart).toHaveBeenCalledWith('agent-1', 'sess-1');
  });

  it('calls onTerminate with agent id and session id when Terminate clicked', async () => {
    const user = userEvent.setup();
    const onTerminate = jest.fn();
    render(
      <AgentCard
        {...buildProps({
          presence: { online: true, sessionId: 'sess-1' },
          onTerminate,
        })}
      />,
    );

    await user.click(screen.getByRole('button', { name: /terminate session/i }));

    expect(onTerminate).toHaveBeenCalledWith('agent-1', 'sess-1');
  });

  it('shows Restarting spinner when isRestarting is true', () => {
    render(
      <AgentCard
        {...buildProps({
          presence: { online: true, sessionId: 'sess-1' },
          isRestarting: true,
        })}
      />,
    );

    expect(screen.getByText('Restarting…')).toBeInTheDocument();
  });

  it('shows Terminating spinner when isTerminating is true', () => {
    render(
      <AgentCard
        {...buildProps({
          presence: { online: true, sessionId: 'sess-1' },
          isTerminating: true,
        })}
      />,
    );

    expect(screen.getByText('Terminating…')).toBeInTheDocument();
  });

  it('disables Restart when anyBusy (isLaunching || isTerminating || isRestarting)', () => {
    render(
      <AgentCard
        {...buildProps({
          presence: { online: true, sessionId: 'sess-1' },
          isTerminating: true,
        })}
      />,
    );

    expect(screen.getByRole('button', { name: /restart session/i })).toBeDisabled();
  });

  // ---- Edit and Delete ----

  it('calls onEdit with agent data when Edit clicked', async () => {
    const user = userEvent.setup();
    const onEdit = jest.fn();
    render(<AgentCard {...buildProps({ onEdit })} />);

    await user.click(screen.getByRole('button', { name: /edit/i }));

    expect(onEdit).toHaveBeenCalledWith(baseAgent);
  });

  it('disables Edit button when isUpdating is true', () => {
    render(<AgentCard {...buildProps({ isUpdating: true })} />);

    expect(screen.getByRole('button', { name: /edit/i })).toBeDisabled();
  });

  it('calls onDelete with agent data when Delete clicked', async () => {
    const user = userEvent.setup();
    const onDelete = jest.fn();
    render(<AgentCard {...buildProps({ onDelete })} />);

    await user.click(screen.getByRole('button', { name: /delete/i }));

    expect(onDelete).toHaveBeenCalledWith(baseAgent);
  });

  it('disables Delete button when isDeleting is true', () => {
    render(<AgentCard {...buildProps({ isDeleting: true })} />);

    expect(screen.getByRole('button', { name: /delete/i })).toBeDisabled();
  });

  // ---- ARIA / Accessibility ----

  it('renders accessible avatar with aria-label', () => {
    render(<AgentCard {...buildProps()} />);

    const avatars = screen.getAllByRole('img', { name: /avatar for agent agent one/i });
    expect(avatars.length).toBeGreaterThanOrEqual(1);
  });
});
