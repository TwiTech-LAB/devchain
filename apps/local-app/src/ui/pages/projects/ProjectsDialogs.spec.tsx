import React, { createRef } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ProjectSetupWizardController } from '@/ui/hooks/useProjectSetupWizard';
import type { ProjectsDialogsModel, ProjectWizardModel } from './projects-page-presentation';
import { ProjectsDialogs } from './ProjectsDialogs';

const mockEditProps = jest.fn();
const mockDeleteProps = jest.fn();
const mockCreateProps = jest.fn();
const mockImportSourceProps = jest.fn();
const mockWizardProps = jest.fn();
const mockImportResultProps = jest.fn();
const mockUpgradeResultProps = jest.fn();
const mockExportProps = jest.fn();
const mockConfigurationProps = jest.fn();
const mockMappingProps = jest.fn();
const mockWarningProps = jest.fn();

jest.mock('@/ui/components/project/EditProjectDialog', () => ({
  EditProjectDialog: (props: Record<string, unknown>) => (mockEditProps(props), null),
}));
jest.mock('@/ui/components/project/DeleteProjectDialog', () => ({
  DeleteProjectDialog: (props: Record<string, unknown>) => (mockDeleteProps(props), null),
}));
jest.mock('@/ui/components/project/CreateProjectDialog', () => ({
  CreateProjectDialog: (props: Record<string, unknown>) => (mockCreateProps(props), null),
}));
jest.mock('@/ui/components/project/ImportSourceModal', () => ({
  ImportSourceModal: (props: Record<string, unknown>) => (mockImportSourceProps(props), null),
}));
jest.mock('@/ui/components/project/ProjectSetupWizard', () => ({
  ProjectSetupWizard: (props: Record<string, unknown>) => (mockWizardProps(props), null),
}));
jest.mock('@/ui/components/project/ImportResultDialog', () => ({
  ImportResultDialog: (props: Record<string, unknown>) => (mockImportResultProps(props), null),
}));
jest.mock('@/ui/components/project/UpgradeDialog', () => ({
  UpgradeDialog: (props: Record<string, unknown>) => (mockUpgradeResultProps(props), null),
}));
jest.mock('@/ui/components/project/ExportDialog', () => ({
  ExportDialog: (props: Record<string, unknown>) => (mockExportProps(props), null),
}));
jest.mock('@/ui/components/project/ProjectConfigurationModal', () => ({
  ProjectConfigurationModal: (props: Record<string, unknown>) => (
    mockConfigurationProps(props),
    null
  ),
}));
jest.mock('@/ui/components/project/ProviderMappingModal', () => ({
  ProviderMappingModal: (props: Record<string, unknown>) => (mockMappingProps(props), null),
}));
jest.mock('@/ui/components/project/ProviderMismatchWarningModal', () => ({
  ProviderMismatchWarningModal: (props: Record<string, unknown>) => (mockWarningProps(props), null),
}));

const wizardController: ProjectSetupWizardController = {
  visibleSteps: [],
  currentStep: undefined,
  currentIndex: 0,
  totalSteps: 0,
  isFirstStep: true,
  isLastStep: true,
  canProceed: true,
  goNext: jest.fn(),
  goBack: jest.fn(),
  submit: jest.fn(),
  cancel: jest.fn(),
  reset: jest.fn(),
};

function wizard(title: string): ProjectWizardModel {
  return {
    open: true,
    onOpenChange: jest.fn(),
    controller: wizardController,
    title,
    description: `${title} description`,
    submitLabel: `${title} submit`,
    isLoading: false,
    isSubmitting: false,
  };
}

function dialogsModel(): ProjectsDialogsModel {
  return {
    edit: {
      open: true,
      onOpenChange: jest.fn(),
      values: {
        name: 'Project',
        description: '',
        rootPath: '/work/project',
        isTemplate: false,
      },
      pathValidation: { isAbsolute: true, exists: true, checked: true },
      changeName: jest.fn(),
      changeDescription: jest.fn(),
      changeRootPath: jest.fn(),
      changeIsTemplate: jest.fn(),
      submit: jest.fn(),
      cancel: jest.fn(),
      isSubmitting: false,
    },
    move: {
      open: false,
      pairedDeviceImpact: { devices: [], isLoading: false, unavailable: false },
      onOpenChange: jest.fn(),
      confirm: jest.fn(),
      isMoving: false,
    },
    delete: {
      open: true,
      projectName: 'Project',
      onOpenChange: jest.fn(),
      confirm: jest.fn(),
      isDeleting: false,
    },
    create: {
      source: {
        open: true,
        onOpenChange: jest.fn(),
        submit: jest.fn(),
        sourceTab: 'template',
        changeSourceTab: jest.fn(),
        values: {
          name: 'New',
          description: '',
          rootPath: '/work/new',
          templateId: 'starter',
          version: '',
          templatePath: '',
          workspaceId: 'default',
        },
        changeName: jest.fn(),
        changeDescription: jest.fn(),
        changeVersion: jest.fn(),
        workspaces: [],
        showWorkspaceSelector: false,
        changeWorkspace: jest.fn(),
        templates: [],
        selectedTemplateSource: 'bundled',
        sortedVersions: [],
        selectTemplate: jest.fn(),
        changeRootPath: jest.fn(),
        changeTemplateFilePath: jest.fn(),
        pathValidation: { isAbsolute: true, exists: false, checked: false },
        filePathValidation: {
          isAbsolute: true,
          exists: false,
          checked: false,
          isFile: false,
        },
        cancel: jest.fn(),
        isSubmitting: false,
      },
      wizard: wizard('Create'),
      providerMapping: {
        open: true,
        missingProviders: ['claude'],
        familyAlternatives: [],
        canImport: true,
        confirm: jest.fn(),
        cancel: jest.fn(),
        isSubmitting: false,
      },
      warning: { open: true, warnings: [], navigate: jest.fn() },
    },
    import: {
      fileInputRef: createRef<HTMLInputElement>(),
      selectFile: jest.fn(),
      source: {
        open: true,
        onOpenChange: jest.fn(),
        targetName: 'Project',
        selectedTemplateId: 'starter',
        selectTemplate: jest.fn(),
        templates: [],
        selectedTemplateSource: 'bundled',
        sortedVersions: [],
        selectedVersion: '',
        selectVersion: jest.fn(),
        importTemplate: jest.fn(),
        openFilePicker: jest.fn(),
        isImporting: false,
      },
      wizard: wizard('Import'),
      result: {
        success: true,
        counts: { imported: {}, deleted: {} },
        mappings: {},
      },
      closeResult: jest.fn(),
    },
    upgrade: {
      wizard: wizard('Upgrade'),
      result: {
        projectId: 'project-1',
        projectName: 'Project',
        targetVersion: '2.0.0',
        source: 'registry',
        result: { success: true, newVersion: '2.0.0' },
        backend: 'home',
        restored: jest.fn(),
        close: jest.fn(),
      },
    },
    export: {
      projectId: 'project-1',
      projectName: 'Project',
      close: jest.fn(),
    },
    configuration: { projectId: 'project-1', close: jest.fn() },
    workspaces: {
      create: {
        open: false,
        name: '',
        changeName: jest.fn(),
        onOpenChange: jest.fn(),
        submit: jest.fn(),
        isSubmitting: false,
        secondWorkspaceImpact: {
          required: false,
          devices: [],
          isLoading: false,
          error: null,
        },
      },
      rename: {
        open: false,
        name: '',
        changeName: jest.fn(),
        onOpenChange: jest.fn(),
        submit: jest.fn(),
        isSubmitting: false,
      },
      delete: {
        open: false,
        projectCount: 0,
        deviceGrantCount: 0,
        replacementWorkspaceId: '',
        replacementOptions: [],
        changeReplacement: jest.fn(),
        onOpenChange: jest.fn(),
        confirm: jest.fn(),
        isDeleting: false,
      },
    },
  };
}

describe('ProjectsDialogs', () => {
  beforeEach(() => jest.clearAllMocks());

  it('adapts each cohesive submodel to its focused child', () => {
    const model = dialogsModel();
    render(<ProjectsDialogs model={model} />);

    expect(mockEditProps).toHaveBeenCalledWith(
      expect.objectContaining({
        formData: model.edit.values,
        onNameChange: model.edit.changeName,
        onCancel: model.edit.cancel,
      }),
    );
    expect(mockDeleteProps).toHaveBeenCalledWith(
      expect.objectContaining({ projectName: 'Project', onConfirm: model.delete.confirm }),
    );
    expect(mockCreateProps).toHaveBeenCalledWith(
      expect.objectContaining({
        templateFormData: model.create.source.values,
        onNameChange: model.create.source.changeName,
        onTemplateChange: model.create.source.selectTemplate,
      }),
    );
    expect(mockImportSourceProps).toHaveBeenCalledWith(
      expect.objectContaining({
        importTargetName: 'Project',
        onImportFromTemplate: model.import.source.importTemplate,
        onImportFromFile: model.import.source.openFilePicker,
      }),
    );
    expect(mockWizardProps.mock.calls.map(([props]) => props.title)).toEqual([
      'Import',
      'Upgrade',
      'Create',
    ]);
    expect(mockMappingProps).toHaveBeenCalledWith(
      expect.objectContaining({ onConfirm: model.create.providerMapping?.confirm }),
    );
    expect(mockWarningProps).toHaveBeenCalledWith(
      expect.objectContaining({ onNavigate: model.create.warning.navigate }),
    );
    expect(mockUpgradeResultProps).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'project-1', targetVersion: '2.0.0' }),
    );
    expect(mockExportProps).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'project-1' }),
    );
    expect(mockConfigurationProps).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'project-1' }),
    );
  });

  it('wires file selection and result close to semantic actions', () => {
    const model = dialogsModel();
    const { container } = render(<ProjectsDialogs model={model} />);
    const file = new File(['{}'], 'project.json', { type: 'application/json' });

    fireEvent.change(container.querySelector('input[type="file"]')!, {
      target: { files: [file] },
    });
    (mockImportResultProps.mock.calls[0][0].onOpenChange as (open: boolean) => void)(false);

    expect(model.import.selectFile).toHaveBeenCalledWith(file);
    expect(model.import.closeResult).toHaveBeenCalled();
  });

  it('renders workspace creation and replacement-delete counts from semantic models', () => {
    const base = dialogsModel();
    const create = { ...base.workspaces.create, open: true, name: 'Labs' };
    const { rerender } = render(
      <ProjectsDialogs model={{ ...base, workspaces: { ...base.workspaces, create } }} />,
    );
    expect(screen.getByRole('heading', { name: 'Create Workspace' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(create.submit).toHaveBeenCalled();

    const confirm = jest.fn();
    const replacement = {
      id: 'default',
      name: 'Default',
      isDefault: true,
      position: 0,
      projectCount: 1,
      deviceGrantCount: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    rerender(
      <ProjectsDialogs
        model={{
          ...base,
          workspaces: {
            ...base.workspaces,
            delete: {
              ...base.workspaces.delete,
              open: true,
              workspaceName: 'Labs',
              projectCount: 2,
              deviceGrantCount: 3,
              replacementWorkspaceId: 'default',
              replacementOptions: [replacement],
              confirm,
            },
          },
        }}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Delete Labs?' })).toBeInTheDocument();
    expect(
      screen.getByText(/move 2 project\(s\).*remap 3 paired-device grant\(s\)/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete and move' }));
    expect(confirm).toHaveBeenCalled();
  });

  it('lists devices and distinct E2EE recovery actions before second-workspace confirmation', () => {
    const base = dialogsModel();
    const create = {
      ...base.workspaces.create,
      open: true,
      name: 'Labs',
      secondWorkspaceImpact: {
        required: true,
        devices: [
          { kid: 'kid-1', label: 'Pixel', localAlias: 'Personal phone' },
          { kid: 'kid-2', label: 'iPhone' },
          { kid: 'abcdefgh12345678' },
        ],
        isLoading: false,
        error: null,
      },
    };

    const { rerender } = render(
      <ProjectsDialogs model={{ ...base, workspaces: { ...base.workspaces, create } }} />,
    );

    expect(screen.getByText('Personal phone')).toBeInTheDocument();
    expect(screen.getByText('Reported name: Pixel')).toHaveClass('text-muted-foreground');
    expect(screen.getByText('iPhone')).toBeInTheDocument();
    expect(screen.getByText('Device abcdefgh')).toBeInTheDocument();
    expect(
      screen.getByText(/workspace features require the latest mobile app/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/update or restart the Local App/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled();

    rerender(
      <ProjectsDialogs
        model={{
          ...base,
          workspaces: {
            ...base.workspaces,
            create: {
              ...create,
              secondWorkspaceImpact: { ...create.secondWorkspaceImpact, devices: [] },
            },
          },
        }}
      />,
    );
    expect(screen.getByText('No paired devices are currently affected.')).toBeInTheDocument();
    expect(
      screen.queryByText(/workspace features require the latest mobile app/i),
    ).not.toBeInTheDocument();
  });

  it('renders device-aware and conservative project move confirmations', () => {
    const base = dialogsModel();
    const confirm = jest.fn();
    const move = {
      ...base.move,
      open: true,
      projectName: 'Project',
      sourceWorkspaceName: 'Default',
      destinationWorkspaceName: 'Labs',
      pairedDeviceImpact: {
        devices: [{ kid: 'kid-1', label: 'Pixel' }],
        isLoading: false,
        unavailable: false,
      },
      confirm,
    };
    const { rerender } = render(<ProjectsDialogs model={{ ...base, move }} />);

    expect(screen.getByRole('heading', { name: 'Move Project?' })).toBeInTheDocument();
    expect(screen.getByText(/change access for 1 paired device/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Move Project' }));
    expect(confirm).toHaveBeenCalled();

    rerender(<ProjectsDialogs model={{ ...base, move: { ...move, isMoving: true } }} />);
    expect(screen.getByRole('button', { name: 'Processing...' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();

    rerender(
      <ProjectsDialogs
        model={{
          ...base,
          move: {
            ...move,
            pairedDeviceImpact: { devices: [], isLoading: false, unavailable: true },
          },
        }}
      />,
    );
    expect(screen.getByText(/paired-device impact is unavailable/i)).toBeInTheDocument();
  });
});
