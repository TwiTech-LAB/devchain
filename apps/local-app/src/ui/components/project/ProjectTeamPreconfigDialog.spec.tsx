import { render, screen, fireEvent } from '@testing-library/react';
import {
  ProjectTeamPreconfigDialog,
  type ParsedTemplateTeam,
  type ParsedTemplateProfile,
  type TeamOverrideOutput,
} from './ProjectTeamPreconfigDialog';

const mockTeams: ParsedTemplateTeam[] = [
  {
    name: 'Dev Team',
    teamLeadAgentName: 'Lead Agent',
    memberAgentNames: ['Lead Agent', 'Worker Agent'],
    maxMembers: 5,
    maxConcurrentTasks: 3,
    allowTeamLeadCreateAgents: true,
    profileNames: ['Default Profile'],
    profileSelections: [{ profileName: 'Default Profile', configNames: ['claude-local'] }],
  },
  {
    name: 'Empty Team',
    teamLeadAgentName: null,
    memberAgentNames: [],
    allowTeamLeadCreateAgents: true,
    profileNames: [],
  },
];

const mockProfiles: ParsedTemplateProfile[] = [
  {
    name: 'Default Profile',
    providerConfigs: [
      { name: 'claude-local', providerName: 'claude' },
      { name: 'codex-local', providerName: 'codex' },
    ],
  },
];

describe('ProjectTeamPreconfigDialog', () => {
  it('renders all teams', () => {
    render(
      <ProjectTeamPreconfigDialog
        open={true}
        teams={mockTeams}
        profiles={mockProfiles}
        onConfirm={jest.fn()}
        onCancel={jest.fn()}
      />,
    );

    expect(screen.getByText('Dev Team')).toBeInTheDocument();
    expect(screen.getByText('Empty Team')).toBeInTheDocument();
  });

  it('shows empty-team hint for teams with zero members', () => {
    render(
      <ProjectTeamPreconfigDialog
        open={true}
        teams={mockTeams}
        profiles={mockProfiles}
        onConfirm={jest.fn()}
        onCancel={jest.fn()}
      />,
    );

    fireEvent.click(screen.getByText('Empty Team'));
    expect(screen.getByText(/no members/)).toBeInTheDocument();
  });

  it('does not render the "Allow team lead to create team agents" toggle', () => {
    render(
      <ProjectTeamPreconfigDialog
        open={true}
        teams={mockTeams}
        profiles={mockProfiles}
        onConfirm={jest.fn()}
        onCancel={jest.fn()}
      />,
    );

    expect(screen.queryByText('Allow team lead to create team agents')).not.toBeInTheDocument();
    expect(document.getElementById('allow-lead-Dev Team')).toBeNull();
  });

  it('hides teams whose template has allowTeamLeadCreateAgents false or undefined', () => {
    const mixedTeams: ParsedTemplateTeam[] = [
      {
        name: 'Allowed Team',
        teamLeadAgentName: 'Lead',
        memberAgentNames: ['Lead'],
        allowTeamLeadCreateAgents: true,
        profileNames: [],
      },
      {
        name: 'Restricted Team',
        teamLeadAgentName: 'Lead',
        memberAgentNames: ['Lead'],
        allowTeamLeadCreateAgents: false,
        profileNames: [],
      },
      {
        name: 'Undefined-Flag Team',
        teamLeadAgentName: 'Lead',
        memberAgentNames: ['Lead'],
        profileNames: [],
      },
    ];

    const onConfirm = jest.fn();
    render(
      <ProjectTeamPreconfigDialog
        open={true}
        teams={mixedTeams}
        profiles={mockProfiles}
        onConfirm={onConfirm}
        onCancel={jest.fn()}
      />,
    );

    expect(screen.getByText('Allowed Team')).toBeInTheDocument();
    expect(screen.queryByText('Restricted Team')).not.toBeInTheDocument();
    expect(screen.queryByText('Undefined-Flag Team')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /create project/i }));

    const overrides = onConfirm.mock.calls[0][0] as TeamOverrideOutput[];
    expect(overrides).toHaveLength(1);
    expect(overrides[0].teamName).toBe('Allowed Team');
    expect(overrides[0].allowTeamLeadCreateAgents).toBe(true);
  });

  it('confirm composes teamOverrides with correct shape', () => {
    const onConfirm = jest.fn();
    render(
      <ProjectTeamPreconfigDialog
        open={true}
        teams={mockTeams}
        profiles={mockProfiles}
        onConfirm={onConfirm}
        onCancel={jest.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /create project/i }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    const overrides: TeamOverrideOutput[] = onConfirm.mock.calls[0][0];
    expect(overrides).toHaveLength(2);

    const devTeam = overrides.find((o) => o.teamName === 'Dev Team');
    expect(devTeam).toBeDefined();
    expect(devTeam!.allowTeamLeadCreateAgents).toBe(true);
    // Sliders are no longer rendered; overrides should not carry maxMembers/maxConcurrentTasks
    // so the backend keeps the template's values.
    expect(devTeam!.maxMembers).toBeUndefined();
    expect(devTeam!.maxConcurrentTasks).toBeUndefined();
  });

  it('cancel does not fire onConfirm', () => {
    const onConfirm = jest.fn();
    const onCancel = jest.fn();
    render(
      <ProjectTeamPreconfigDialog
        open={true}
        teams={mockTeams}
        profiles={mockProfiles}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('not shown when open is false', () => {
    render(
      <ProjectTeamPreconfigDialog
        open={false}
        teams={mockTeams}
        profiles={mockProfiles}
        onConfirm={jest.fn()}
        onCancel={jest.fn()}
      />,
    );

    expect(screen.queryByText('Configure Teams')).not.toBeInTheDocument();
  });

  it('Rule 1: allow-all emits profileSelections with empty configNames', () => {
    const onConfirm = jest.fn();
    const allowAllTeams: ParsedTemplateTeam[] = [
      {
        name: 'AllowAll Team',
        teamLeadAgentName: 'Lead',
        memberAgentNames: ['Lead'],
        allowTeamLeadCreateAgents: true,
        profileNames: ['Default Profile'],
      },
    ];

    render(
      <ProjectTeamPreconfigDialog
        open={true}
        teams={allowAllTeams}
        profiles={mockProfiles}
        onConfirm={onConfirm}
        onCancel={jest.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /create project/i }));

    const overrides = onConfirm.mock.calls[0][0] as TeamOverrideOutput[];
    const team = overrides.find((o) => o.teamName === 'AllowAll Team');
    expect(team).toBeDefined();
    expect(team!.profileSelections).toBeDefined();
    const ps = team!.profileSelections!.find((s) => s.profileName === 'Default Profile');
    expect(ps).toBeDefined();
    expect(ps!.configNames).toEqual([]);
  });

  it('Rule 2: subset emits explicit configNames', () => {
    const onConfirm = jest.fn();
    const subsetTeams: ParsedTemplateTeam[] = [
      {
        name: 'Subset Team',
        teamLeadAgentName: 'Lead',
        memberAgentNames: ['Lead'],
        allowTeamLeadCreateAgents: true,
        profileNames: ['Default Profile'],
        profileSelections: [{ profileName: 'Default Profile', configNames: ['claude-local'] }],
      },
    ];

    render(
      <ProjectTeamPreconfigDialog
        open={true}
        teams={subsetTeams}
        profiles={mockProfiles}
        onConfirm={onConfirm}
        onCancel={jest.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /create project/i }));

    const overrides = onConfirm.mock.calls[0][0] as TeamOverrideOutput[];
    const team = overrides.find((o) => o.teamName === 'Subset Team');
    expect(team!.profileSelections).toBeDefined();
    const ps = team!.profileSelections!.find((s) => s.profileName === 'Default Profile');
    expect(ps!.configNames).toEqual(['claude-local']);
  });

  it('Rule 3: all unchecked omits profile from profileSelections', () => {
    const onConfirm = jest.fn();
    const noProfileTeams: ParsedTemplateTeam[] = [
      {
        name: 'NoProfile Team',
        teamLeadAgentName: 'Lead',
        memberAgentNames: ['Lead'],
        allowTeamLeadCreateAgents: true,
        profileNames: [],
      },
    ];

    render(
      <ProjectTeamPreconfigDialog
        open={true}
        teams={noProfileTeams}
        profiles={mockProfiles}
        onConfirm={onConfirm}
        onCancel={jest.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /create project/i }));

    const overrides = onConfirm.mock.calls[0][0] as TeamOverrideOutput[];
    const team = overrides.find((o) => o.teamName === 'NoProfile Team');
    expect(team!.profileSelections).toBeUndefined();
  });
});
