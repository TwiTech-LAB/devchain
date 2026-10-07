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
  isProjectOwner: false,
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
    isUpdating: false,
    isDeleting: false,
    onEdit: jest.fn(),
    onDelete: jest.fn(),
    ...overrides,
  };
}

describe('AgentCard', () => {
  it('renders agent metadata and omits Chat session controls', () => {
    render(<AgentCard {...buildProps()} />);

    expect(screen.getByText('Agent One')).toBeInTheDocument();
    expect(screen.getByText('Default Profile')).toBeInTheDocument();
    expect(screen.getByText('A test agent description')).toBeInTheDocument();
    expect(screen.getByText(/6\/15\/2024/)).toBeInTheDocument();

    expect(screen.getByTestId('agent-card-agent-1')).toBeInTheDocument();

    expect(screen.queryByText('Project owner')).not.toBeInTheDocument();

    expect(screen.getByText('CLAUDE')).toBeInTheDocument();

    expect(screen.getByText('3 prompts')).toBeInTheDocument();

    expect(screen.queryByRole('button', { name: /launch session/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /restart session/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /terminate session/i })).not.toBeInTheDocument();
    expect(screen.queryByText('Last launched')).not.toBeInTheDocument();

    const avatars = screen.getAllByRole('img', { name: /avatar for agent agent one/i });
    expect(avatars.length).toBeGreaterThanOrEqual(1);
  });

  it.each(['name', 'profile'])('shows fallback for missing %s', (missing) => {
    render(
      <AgentCard
        {...buildProps(
          missing === 'name' ? { agent: { ...baseAgent, name: '' } } : { profile: undefined },
        )}
      />,
    );
    expect(
      screen.getByText(missing === 'name' ? 'Unnamed agent' : 'Unknown Profile'),
    ).toBeInTheDocument();
  });

  it('shows an accessible Project owner badge for the owner agent', () => {
    render(<AgentCard {...buildProps({ agent: { ...baseAgent, isProjectOwner: true } })} />);

    expect(screen.getByText('Project owner')).toBeInTheDocument();
    expect(screen.getByLabelText('Project owner')).toHaveTextContent('Project owner');
  });

  it('shows singular "prompt" for count of 1', () => {
    render(<AgentCard {...buildProps({ profile: { ...baseProfile, promptCount: 1 } })} />);

    expect(screen.getByText('1 prompt')).toBeInTheDocument();
  });

  it.each([null, { API_KEY: 'xxx' }])('shows config badge with env %s', (env) => {
    const agentWithConfig: AgentCardData = {
      ...baseAgent,
      providerConfig: {
        id: 'config-1',
        profileId: 'profile-1',
        providerId: 'provider-1',
        name: 'default',
        options: null,
        env,
      },
    };
    render(<AgentCard {...buildProps({ agent: agentWithConfig })} />);
    expect(screen.getByText(env ? 'default [env]' : 'default')).toBeInTheDocument();
  });

  // ---- Session lifecycle controls are Chat-only ----

  // ---- Edit and Delete ----

  it('calls onEdit with agent data when Edit clicked', async () => {
    const user = userEvent.setup();
    const onEdit = jest.fn();
    render(<AgentCard {...buildProps({ onEdit })} />);

    await user.click(screen.getByRole('button', { name: /edit/i }));

    expect(onEdit).toHaveBeenCalledWith(baseAgent);
  });

  it.each(['Edit', 'Delete'])('disables %s during its operation', (action) => {
    render(
      <AgentCard
        {...buildProps(action === 'Edit' ? { isUpdating: true } : { isDeleting: true })}
      />,
    );
    expect(screen.getByRole('button', { name: action })).toBeDisabled();
  });

  it('calls onDelete with agent data when Delete clicked', async () => {
    const user = userEvent.setup();
    const onDelete = jest.fn();
    render(<AgentCard {...buildProps({ onDelete })} />);

    await user.click(screen.getByRole('button', { name: /delete/i }));

    expect(onDelete).toHaveBeenCalledWith(baseAgent);
  });

  // ---- ARIA / Accessibility ----
});
