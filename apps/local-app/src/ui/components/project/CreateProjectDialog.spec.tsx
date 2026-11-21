import { render, screen } from '@testing-library/react';
import type { SetupPreviewResponse } from '@/ui/pages/projects/lib/project-contracts';
import { CreateProjectDialog } from './CreateProjectDialog';

const defaultProps = {
  open: true,
  onOpenChange: jest.fn(),
  onSubmit: jest.fn(),
  templateSourceTab: 'template' as const,
  onTemplateSourceTabChange: jest.fn(),
  templateFormData: {
    name: 'New Project',
    description: '',
    rootPath: '/work/new-project',
    templateId: 'starter',
    version: '',
    templatePath: '',
    workspaceId: 'default',
  },
  onNameChange: jest.fn(),
  onDescriptionChange: jest.fn(),
  onVersionChange: jest.fn(),
  templates: [{ slug: 'starter', name: 'Starter', source: 'bundled' as const }],
  sortedVersions: ['2.0.0', '1.0.0'],
  onTemplateChange: jest.fn(),
  onTemplatePathChange: jest.fn(),
  onTemplateFilePathChange: jest.fn(),
  templatePathValidation: { isAbsolute: true, exists: true, checked: true },
  templateFilePathValidation: {
    isAbsolute: false,
    exists: false,
    checked: false,
    isFile: false,
  },
  onCancel: jest.fn(),
  isSubmitting: false,
};

function preview(installedProviders: string[]): SetupPreviewResponse {
  return {
    payload: {
      version: 1,
      prompts: [],
      profiles: [
        {
          id: 'profile-1',
          name: 'Coder Profile',
          provider: { name: 'claude' },
          providerConfigs: [
            { name: 'opus', providerName: 'claude' },
            { name: 'gpt', providerName: 'codex' },
          ],
        },
      ],
      agents: [
        {
          name: 'Coder',
          profileId: 'profile-1',
          isProjectOwner: false,
          providerConfigName: 'opus',
        },
        {
          name: 'Reviewer',
          profileId: 'profile-1',
          isProjectOwner: false,
          providerConfigName: 'gpt',
        },
      ],
      statuses: [],
      watchers: [],
      subscribers: [],
      teams: [
        {
          name: 'Core',
          memberAgentNames: ['Coder'],
          allowTeamLeadCreateAgents: true,
          profileNames: ['Coder Profile'],
        },
      ],
      providerModels: [],
      providerEfforts: [],
      presets: [],
      scheduledEpics: [],
    },
    providerSummary: [],
    familyAlternatives: [],
    presetProviderCoverage: [],
    localAvailability: {
      installedProviders: installedProviders.map((name) => ({ id: name, name })),
    },
  };
}

describe('CreateProjectDialog', () => {
  it('shows template cards with descriptions and details only on the selected card', () => {
    const templates = [
      {
        slug: 'starter',
        name: 'Starter',
        source: 'bundled' as const,
        description: 'Plan and build',
      },
      { slug: 'other', name: 'Other', source: 'registry' as const, description: null },
    ];
    const { rerender } = render(
      <CreateProjectDialog
        {...defaultProps}
        templates={templates}
        selectedTemplatePreview={preview(['Codex'])}
      />,
    );

    const [selected, other] = screen.getAllByRole('radio');
    expect(selected).toBeChecked();
    expect(selected).toHaveTextContent('Plan and build');
    expect(selected).toHaveTextContent('2 agents · 1 teams · 0 ready-made setups');
    expect(selected).toHaveTextContent('Works with the providers you have: codex');
    expect(other).not.toBeChecked();
    expect(other).toHaveTextContent(/^OtherDownloaded$/);

    rerender(
      <CreateProjectDialog
        {...defaultProps}
        templates={templates}
        selectedTemplatePreview={preview([])}
      />,
    );
    expect(selected).toHaveTextContent(
      'Cannot run with the providers you have: Coder, Reviewer. This template supports: claude, codex.',
    );

    rerender(<CreateProjectDialog {...defaultProps} templates={templates} />);
    expect(selected).not.toHaveTextContent('agents');
  });

  it('renders version choice only for registry templates with available versions', () => {
    const { rerender } = render(
      <CreateProjectDialog {...defaultProps} selectedTemplateSource="bundled" />,
    );
    expect(screen.queryByLabelText('Version')).not.toBeInTheDocument();

    rerender(<CreateProjectDialog {...defaultProps} selectedTemplateSource="registry" />);
    expect(screen.getByLabelText('Version')).toBeInTheDocument();

    rerender(
      <CreateProjectDialog
        {...defaultProps}
        selectedTemplateSource="registry"
        sortedVersions={[]}
      />,
    );
    expect(screen.queryByLabelText('Version')).not.toBeInTheDocument();
  });

  it('shows workspace assignment only when multiple workspaces are enabled', () => {
    const { rerender } = render(<CreateProjectDialog {...defaultProps} />);
    expect(screen.queryByLabelText('Workspace')).not.toBeInTheDocument();

    rerender(
      <CreateProjectDialog
        {...defaultProps}
        showWorkspaceSelector
        workspaces={[
          {
            id: 'default',
            name: 'Default',
            isDefault: true,
            position: 0,
            projectCount: 1,
            deviceGrantCount: 0,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ]}
      />,
    );
    expect(screen.getByLabelText('Workspace')).toHaveTextContent('Default');
  });
});
