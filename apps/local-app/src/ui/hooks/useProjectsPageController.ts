import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router-dom';
import { formatPromptTransferCounts } from '@/common/prompt-transfer';
import {
  optimisticMergeById,
  optimisticRemoveById,
  useCrudMutation,
} from '@/ui/hooks/useCrudMutations';
import { useCreateProjectWizard } from '@/ui/hooks/useCreateProjectWizard';
import { useConfirmDialog, useFormDialog } from '@/ui/hooks/useFormDialog';
import { useImportProjectWizard, useUpgradeProjectWizard } from '@/ui/hooks/useImportProjectWizard';
import { useSelectedProject } from '@/ui/hooks/useProjectSelection';
import { useRemotes } from '@/ui/hooks/useRemotes';
import { useTemplateForm } from '@/ui/hooks/useTemplateForm';
import { getErrorMessage, useToastHelpers } from '@/ui/lib/toast-helpers';
import { useProjectImportSource } from '@/ui/pages/projects/hooks/useProjectImportSource';
import {
  formatProjectPromptReferenceFailure,
  isProjectPromptReferenceFailure,
} from '@/ui/pages/projects/lib/project-failures';
import {
  createFileImportRequest,
  createTemplateImportRequest,
  importFileParseFailureToast,
} from '@/ui/pages/projects/lib/project-import-request';
import type {
  CreateFromTemplateInput,
  FamilyAlternative,
  ImportProjectSuccess,
  Project,
  ProjectRemoteOwner,
  ProjectsQueryData,
  ProjectWithStats,
  ProjectWorkspace,
  ProviderMismatchWarning,
  UpdateProjectResponse,
  UpgradeProjectResponse,
} from '@/ui/pages/projects/lib/project-contracts';
import { projectsHttpApi } from '@/ui/pages/projects/lib/projects-http-api';
import type { ProjectsPageApi } from '@/ui/pages/projects/lib/projects-page-api';
import { projectsQueryKeys } from '@/ui/pages/projects/lib/project-query-keys';
import { buildProjectsTableModel } from '@/ui/pages/projects/projects-page-model';
import type {
  EditProjectFormData,
  ProjectPathValidation,
  ProjectsPagePresentation,
  ProjectsSortField,
  ProjectsSortOrder,
} from '@/ui/pages/projects/projects-page-presentation';
import { projectActionsButtonId } from '@/ui/pages/projects/projects-page-presentation';

const emptyProjectForm = (): EditProjectFormData => ({
  name: '',
  description: '',
  rootPath: '',
  isTemplate: false,
});

const projectFormValues = (project: Project): EditProjectFormData => ({
  name: project.name,
  description: project.description ?? '',
  rootPath: project.rootPath,
  isTemplate: Boolean(project.isTemplate),
});

const emptyPathValidation = (): ProjectPathValidation => ({
  isAbsolute: true,
  exists: false,
  checked: false,
});

interface DeleteProjectMetadata {
  wasSelected: boolean;
  replacementProjectId?: string;
}

interface ProjectMoveTarget {
  project: ProjectWithStats;
  sourceWorkspace: ProjectWorkspace;
  destinationWorkspace: ProjectWorkspace;
}

interface ProjectMoveVariables {
  projectId: string;
  projectName: string;
  destinationWorkspaceId: string;
  destinationWorkspaceName: string;
}

interface ProjectMoveContext {
  previousProjects?: ProjectsQueryData;
}

interface ProjectDragState {
  projectId: string | null;
  sourceWorkspaceId: string | null;
  targetWorkspaceId: string | null;
}

const emptyProjectDrag = (): ProjectDragState => ({
  projectId: null,
  sourceWorkspaceId: null,
  targetWorkspaceId: null,
});

export function useProjectsPageController(
  api: ProjectsPageApi = projectsHttpApi,
): ProjectsPagePresentation {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const { toast, showSuccess, showError } = useToastHelpers();
  const { selectedProjectId, setSelectedProjectId, activateProject } = useSelectedProject();

  const [search, setSearch] = useState('');
  const [sortField, setSortField] = useState<ProjectsSortField>('name');
  const [sortOrder, setSortOrder] = useState<ProjectsSortOrder>('asc');
  const [pathValidation, setPathValidation] = useState<ProjectPathValidation>(emptyPathValidation);
  const editDialog = useFormDialog<Project, EditProjectFormData>({
    createValues: emptyProjectForm,
    editValues: projectFormValues,
  });
  const deleteDialog = useConfirmDialog<Project>();
  const [showCreateSource, setShowCreateSource] = useState(false);
  const [createWorkspaceOpen, setCreateWorkspaceOpen] = useState(false);
  const [createWorkspaceName, setCreateWorkspaceName] = useState('');
  const [renameWorkspaceTarget, setRenameWorkspaceTarget] = useState<ProjectWorkspace | null>(null);
  const [renameWorkspaceName, setRenameWorkspaceName] = useState('');
  const [deleteWorkspaceTarget, setDeleteWorkspaceTarget] = useState<ProjectWorkspace | null>(null);
  const [replacementWorkspaceId, setReplacementWorkspaceId] = useState('');
  const [projectMoveTarget, setProjectMoveTarget] = useState<ProjectMoveTarget | null>(null);
  const [collapsedWorkspaceIds, setCollapsedWorkspaceIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [moveStatus, setMoveStatus] = useState('');
  const [projectDrag, setProjectDrag] = useState<ProjectDragState>(emptyProjectDrag);
  const moveRequestBusyRef = useRef(false);

  const projectsQuery = useQuery({
    queryKey: projectsQueryKeys.list(),
    queryFn: () => api.listProjects(),
  });

  const workspacesQuery = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => api.listWorkspaces(),
  });
  const workspaces = workspacesQuery.data ?? [];
  const defaultWorkspace = workspaces.find((workspace) => workspace.isDefault) ?? workspaces[0];

  const { bindingByProjectId, remotes } = useRemotes();
  const remoteOwners = useMemo(
    () =>
      new Map<string, ProjectRemoteOwner>(
        Array.from(bindingByProjectId.values()).map((binding) => [
          binding.projectId,
          {
            projectId: binding.projectId,
            remoteId: binding.remoteId,
            remoteName: remotes.find((remote) => remote.id === binding.remoteId)?.name ?? null,
            state: binding.state as ProjectRemoteOwner['state'],
          },
        ]),
      ),
    [bindingByProjectId, remotes],
  );

  const pairedDevicesQuery = useQuery({
    queryKey: ['paired-devices'],
    queryFn: () => api.listPairedDevices(),
    enabled: (createWorkspaceOpen && workspaces.length === 1) || projectMoveTarget !== null,
    staleTime: 0,
  });

  const [upgradeTarget, setUpgradeTarget] = useState<{
    project: ProjectWithStats;
    targetVersion: string;
  } | null>(null);
  const [upgradeResult, setUpgradeResult] = useState<UpgradeProjectResponse | null>(null);
  const [exportTarget, setExportTarget] = useState<ProjectWithStats | null>(null);
  const [configureTarget, setConfigureTarget] = useState<ProjectWithStats | null>(null);

  const { data: exportManifest, isFetching: isLoadingExportManifest } = useQuery({
    queryKey: projectsQueryKeys.manifest(exportTarget?.id),
    queryFn: () => api.readTemplateManifest(exportTarget!.id),
    enabled: exportTarget !== null,
    staleTime: 0,
  });

  const [providerMappingData, setProviderMappingData] = useState<{
    missingProviders: string[];
    familyAlternatives: FamilyAlternative[];
    canImport: boolean;
  } | null>(null);
  const [pendingTemplateData, setPendingTemplateData] = useState<CreateFromTemplateInput | null>(
    null,
  );
  const [providerWarnings, setProviderWarnings] = useState<ProviderMismatchWarning[]>([]);

  const { data: allTemplates } = useQuery({
    queryKey: projectsQueryKeys.templatesForUpgrade(),
    queryFn: () => api.listTemplates(),
    staleTime: 60000,
  });

  const importSource = useProjectImportSource(allTemplates);

  const { data: templates } = useQuery({
    queryKey: projectsQueryKeys.templatesForCreate(),
    queryFn: () => api.listTemplates(),
    enabled: showCreateSource || importSource.isOpen,
  });

  const templateForm = useTemplateForm({
    templates,
    setShowTemplateDialog: setShowCreateSource,
    api,
    toast,
  });

  useEffect(() => {
    if (!showCreateSource || !defaultWorkspace || templateForm.templateFormData.workspaceId) return;
    templateForm.setTemplateFormData((current) => ({
      ...current,
      workspaceId: current.workspaceId || defaultWorkspace.id,
    }));
  }, [
    defaultWorkspace,
    showCreateSource,
    templateForm.setTemplateFormData,
    templateForm.templateFormData.workspaceId,
  ]);

  const createWorkspaceMutation = useMutation({
    mutationFn: (name: string) => api.createWorkspace(name),
    onSuccess: (created) => {
      queryClient.setQueryData<ProjectWorkspace[]>(['workspaces'], (current = []) => [
        ...current,
        created,
      ]);
      setCreateWorkspaceOpen(false);
      setCreateWorkspaceName('');
      showSuccess({ title: 'Success', description: 'Workspace created successfully' });
    },
    onError: (error) =>
      showError({
        title: 'Error',
        description: getErrorMessage(error, 'Failed to create workspace'),
      }),
  });

  const renameWorkspaceMutation = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => api.renameWorkspace(id, name),
    onSuccess: (renamed) => {
      queryClient.setQueryData<ProjectWorkspace[]>(['workspaces'], (current = []) =>
        current.map((workspace) => (workspace.id === renamed.id ? renamed : workspace)),
      );
      setRenameWorkspaceTarget(null);
      setRenameWorkspaceName('');
      showSuccess({ title: 'Success', description: 'Workspace renamed successfully' });
    },
    onError: (error) =>
      showError({
        title: 'Error',
        description: getErrorMessage(error, 'Failed to rename workspace'),
      }),
  });

  const deleteWorkspaceMutation = useMutation({
    mutationFn: ({ id, replacementId }: { id: string; replacementId: string }) =>
      api.deleteWorkspace(id, replacementId),
    onSuccess: (result, variables) => {
      queryClient.setQueryData<ProjectWorkspace[]>(['workspaces'], (current = []) => {
        const target = current.find((workspace) => workspace.id === variables.id);
        return current
          .filter((workspace) => workspace.id !== variables.id)
          .map((workspace) =>
            workspace.id === variables.replacementId && target
              ? {
                  ...workspace,
                  projectCount: workspace.projectCount + result.movedProjectCount,
                }
              : workspace,
          )
          .map((workspace, position) => ({ ...workspace, position }));
      });
      queryClient.setQueryData<ProjectsQueryData>(projectsQueryKeys.list(), (current) =>
        current
          ? {
              ...current,
              items: current.items.map((project) =>
                project.workspaceId === variables.id
                  ? { ...project, workspaceId: variables.replacementId }
                  : project,
              ),
            }
          : current,
      );
      setCollapsedWorkspaceIds((current) => {
        const next = new Set(current);
        next.delete(variables.id);
        return next;
      });
      setDeleteWorkspaceTarget(null);
      setReplacementWorkspaceId('');
      showSuccess({
        title: 'Workspace deleted',
        description: `${result.movedProjectCount} project(s) moved; ${result.remappedDeviceGrantCount} paired-device grant(s) remapped.`,
      });
      void queryClient.invalidateQueries({ queryKey: ['workspaces'] });
      void queryClient.invalidateQueries({ queryKey: projectsQueryKeys.all() });
    },
    onError: (error) =>
      showError({
        title: 'Error',
        description: getErrorMessage(error, 'Failed to delete workspace'),
      }),
  });

  const openCreateInWorkspace = useCallback(
    (workspaceId: string) => {
      if (!workspaces.some((workspace) => workspace.id === workspaceId)) return;
      templateForm.resetTemplateForm();
      templateForm.setTemplateFormData((current) => ({ ...current, workspaceId }));
      setShowCreateSource(true);
    },
    [templateForm.resetTemplateForm, templateForm.setTemplateFormData, workspaces],
  );

  const openCreateProject = useCallback(() => {
    if (defaultWorkspace) {
      openCreateInWorkspace(defaultWorkspace.id);
      return;
    }
    templateForm.resetTemplateForm();
    setShowCreateSource(true);
  }, [defaultWorkspace, openCreateInWorkspace, templateForm.resetTemplateForm]);

  const openRenameWorkspace = useCallback((workspace: ProjectWorkspace) => {
    setRenameWorkspaceTarget(workspace);
    setRenameWorkspaceName(workspace.name);
  }, []);

  const openDeleteWorkspace = useCallback(
    (workspace: ProjectWorkspace) => {
      if (workspace.isDefault) return;
      const replacements = workspaces.filter((candidate) => candidate.id !== workspace.id);
      setDeleteWorkspaceTarget(workspace);
      setReplacementWorkspaceId(
        replacements.find((candidate) => candidate.isDefault)?.id ?? replacements[0]?.id ?? '',
      );
    },
    [workspaces],
  );

  const moveWorkspace = useCallback(
    (workspaceId: string, direction: -1 | 1) => {
      const ordered = [...workspaces].sort((left, right) => left.position - right.position);
      const index = ordered.findIndex((workspace) => workspace.id === workspaceId);
      const destination = index + direction;
      if (index < 0 || destination < 0 || destination >= ordered.length) return;
      [ordered[index], ordered[destination]] = [ordered[destination], ordered[index]];
      const optimistic = ordered.map((workspace, position) => ({ ...workspace, position }));
      queryClient.setQueryData(['workspaces'], optimistic);
      void api
        .reorderWorkspaces(optimistic.map((workspace) => workspace.id))
        .then((persisted) => queryClient.setQueryData(['workspaces'], persisted))
        .catch((error) => {
          queryClient.setQueryData(['workspaces'], workspaces);
          showError({
            title: 'Error',
            description: getErrorMessage(error, 'Failed to reorder workspaces'),
          });
        });
    },
    [api, queryClient, showError, workspaces],
  );

  const updateMutation = useCrudMutation<
    UpdateProjectResponse,
    { id: string; data: EditProjectFormData },
    void
  >({
    mutationFn: ({ id, data }) => api.updateProject(id, data),
    optimistic: {
      queryKey: projectsQueryKeys.list(),
      project: (previous, { id, data }) => {
        const list = (previous as ProjectsQueryData | undefined) ?? { items: [] };
        return optimisticMergeById(list, id, (project) => ({
          ...project,
          ...data,
          updatedAt: new Date().toISOString(),
        }));
      },
    },
    toast: {
      error: (error) => ({
        title: 'Error',
        description: getErrorMessage(error, 'Failed to update project'),
      }),
    },
    onSuccessSideEffects: async () => {
      await queryClient.invalidateQueries({ queryKey: projectsQueryKeys.all() });
      await queryClient.invalidateQueries({ queryKey: ['workspaces'] });
      editDialog.close();
      setPathValidation(emptyPathValidation());
      showSuccess({ title: 'Success', description: 'Project updated successfully' });
    },
  });

  const restoreProjectActionsFocus = useCallback((projectId: string) => {
    const focusActions = () => document.getElementById(projectActionsButtonId(projectId))?.focus();
    if (typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(focusActions);
    } else {
      window.setTimeout(focusActions, 0);
    }
  }, []);

  const moveMutation = useMutation<
    UpdateProjectResponse,
    unknown,
    ProjectMoveVariables,
    ProjectMoveContext
  >({
    scope: { id: 'project-workspace-move' },
    mutationFn: ({ projectId, destinationWorkspaceId }) =>
      api.updateProject(projectId, { workspaceId: destinationWorkspaceId }),
    onMutate: async (variables) => {
      await queryClient.cancelQueries({ queryKey: projectsQueryKeys.list() });
      const previousProjects = queryClient.getQueryData<ProjectsQueryData>(
        projectsQueryKeys.list(),
      );
      queryClient.setQueryData<ProjectsQueryData>(projectsQueryKeys.list(), (current) =>
        current
          ? optimisticMergeById(current, variables.projectId, (project) => ({
              ...project,
              workspaceId: variables.destinationWorkspaceId,
              updatedAt: new Date().toISOString(),
            }))
          : current,
      );
      return { previousProjects };
    },
    onSuccess: (result, variables) => {
      queryClient.setQueryData<ProjectsQueryData>(projectsQueryKeys.list(), (current) =>
        current
          ? optimisticMergeById(current, variables.projectId, (project) => ({
              ...project,
              ...result.project,
            }))
          : current,
      );
      setCollapsedWorkspaceIds((current) => {
        const next = new Set(current);
        next.delete(variables.destinationWorkspaceId);
        return next;
      });
      const message = `${variables.projectName} moved to ${variables.destinationWorkspaceName}.`;
      setMoveStatus(message);
      showSuccess({ title: 'Project moved', description: message });
    },
    onError: (error, variables, context) => {
      if (context?.previousProjects) {
        queryClient.setQueryData(projectsQueryKeys.list(), context.previousProjects);
      }
      const message = `Couldn’t move ${variables.projectName}. ${getErrorMessage(
        error,
        'Try again.',
      )}`;
      setMoveStatus(message);
      showError({ title: 'Project move failed', description: message });
    },
    onSettled: async (_data, _error, variables) => {
      setProjectMoveTarget(null);
      moveRequestBusyRef.current = false;
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: projectsQueryKeys.all() }),
        queryClient.invalidateQueries({ queryKey: ['workspaces'] }),
      ]);
      restoreProjectActionsFocus(variables.projectId);
    },
  });

  const requestProjectMove = useCallback(
    (project: ProjectWithStats, destinationWorkspaceId: string) => {
      if (project.workspaceId === destinationWorkspaceId || moveRequestBusyRef.current) return;
      const sourceWorkspace = workspaces.find((workspace) => workspace.id === project.workspaceId);
      const destinationWorkspace = workspaces.find(
        (workspace) => workspace.id === destinationWorkspaceId,
      );
      if (!sourceWorkspace || !destinationWorkspace) return;
      setMoveStatus('');
      setProjectMoveTarget({ project, sourceWorkspace, destinationWorkspace });
    },
    [workspaces],
  );

  const startProjectDrag = useCallback(
    (projectId: string, sourceWorkspaceId: string) => {
      const project = projectsQuery.data?.items.find((candidate) => candidate.id === projectId);
      const hasDestination = workspaces.some((workspace) => workspace.id !== sourceWorkspaceId);
      if (!project || project.workspaceId !== sourceWorkspaceId || !hasDestination) return;
      setProjectDrag({ projectId, sourceWorkspaceId, targetWorkspaceId: sourceWorkspaceId });
    },
    [projectsQuery.data, workspaces],
  );

  const enterDragWorkspace = useCallback((workspaceId: string) => {
    setProjectDrag((current) =>
      current.projectId && current.targetWorkspaceId !== workspaceId
        ? { ...current, targetWorkspaceId: workspaceId }
        : current,
    );
  }, []);

  const leaveDragWorkspace = useCallback((workspaceId: string) => {
    setProjectDrag((current) =>
      current.targetWorkspaceId === workspaceId ? { ...current, targetWorkspaceId: null } : current,
    );
  }, []);

  const endProjectDrag = useCallback(() => setProjectDrag(emptyProjectDrag()), []);

  const dropProjectOnWorkspace = useCallback(
    (destinationWorkspaceId: string) => {
      const current = projectDrag;
      setProjectDrag(emptyProjectDrag());
      if (!current.projectId || current.sourceWorkspaceId === destinationWorkspaceId) return;
      const project = projectsQuery.data?.items.find(
        (candidate) => candidate.id === current.projectId,
      );
      if (project) requestProjectMove(project, destinationWorkspaceId);
    },
    [projectDrag, projectsQuery.data, requestProjectMove],
  );

  const confirmProjectMove = useCallback(() => {
    if (!projectMoveTarget || moveRequestBusyRef.current) return;
    moveRequestBusyRef.current = true;
    moveMutation.mutate({
      projectId: projectMoveTarget.project.id,
      projectName: projectMoveTarget.project.name,
      destinationWorkspaceId: projectMoveTarget.destinationWorkspace.id,
      destinationWorkspaceName: projectMoveTarget.destinationWorkspace.name,
    });
  }, [moveMutation, projectMoveTarget]);

  const deleteMutation = useCrudMutation<void, string, DeleteProjectMetadata>({
    mutationFn: (projectId) => api.deleteProject(projectId),
    optimistic: {
      queryKey: projectsQueryKeys.list(),
      project: (previous, projectId) => {
        const list = (previous as ProjectsQueryData | undefined) ?? { items: [] };
        return optimisticRemoveById(list, projectId, { trackTotal: false });
      },
    },
    contextMetadata: (projectId, previous) => {
      const list = (previous as ProjectsQueryData | undefined) ?? { items: [] };
      const wasSelected = selectedProjectId === projectId;
      const replacementProjectId = wasSelected
        ? list.items.find((project) => project.id !== projectId)?.id
        : undefined;
      return replacementProjectId ? { wasSelected, replacementProjectId } : { wasSelected };
    },
    onSuccessSideEffects: async (_data, _projectId, metadata) => {
      if (metadata.wasSelected) setSelectedProjectId(metadata.replacementProjectId);
      await queryClient.invalidateQueries({ queryKey: projectsQueryKeys.all() });
      await queryClient.invalidateQueries({ queryKey: ['workspaces'] });
      deleteDialog.close();
      showSuccess({ title: 'Success', description: 'Project deleted successfully' });
    },
    onErrorSideEffects: (error) => {
      deleteDialog.close();
      showError({
        title: 'Error',
        description: getErrorMessage(error, 'Failed to delete project'),
      });
    },
  });

  const createMutation = useCrudMutation<
    Awaited<ReturnType<ProjectsPageApi['createFromTemplate']>>,
    CreateFromTemplateInput,
    void
  >({
    mutationFn: (input) => api.createFromTemplate(input),
    onSuccessSideEffects: async (data, variables) => {
      if (isProjectPromptReferenceFailure(data)) {
        toast({
          title: 'Project creation blocked',
          description: formatProjectPromptReferenceFailure(data),
          variant: 'destructive',
        });
        return;
      }

      if ('providerMappingRequired' in data) {
        setPendingTemplateData(variables);
        setProviderMappingData(data.providerMappingRequired);
        setShowCreateSource(false);
        return;
      }

      if (data.success !== true) {
        toast({
          title: 'Project creation failed',
          description: 'The server returned an invalid failure result',
          variant: 'destructive',
        });
        return;
      }

      setShowCreateSource(false);
      templateForm.resetTemplateForm();
      await queryClient.invalidateQueries({ queryKey: projectsQueryKeys.all() });
      await queryClient.invalidateQueries({ queryKey: ['workspaces'] });
      if (data.project?.id) activateProject(data.project);

      const promptSummary = data.promptTransfer
        ? ` Prompts: ${formatPromptTransferCounts(data.promptTransfer)}.`
        : '';
      toast({
        title: 'Success',
        description: `${data.message || 'Project created from template successfully'}${promptSummary}`,
      });

      if (data.warnings?.length) {
        setProviderWarnings(data.warnings);
      } else if (data.project?.id) {
        navigate('/board');
      }
    },
    onErrorSideEffects: (error) => {
      toast({
        title: 'Error',
        description: getErrorMessage(error, 'Failed to create project from template'),
        variant: 'destructive',
      });
    },
  });

  const createWizard = useCreateProjectWizard(createMutation, api);
  const [importResult, setImportResult] = useState<ImportProjectSuccess | null>(null);
  const importWizard = useImportProjectWizard({ onImported: setImportResult, toast, api });

  const closeUpgradeTarget = useCallback(() => {
    setUpgradeTarget(null);
    void queryClient.invalidateQueries({ queryKey: projectsQueryKeys.list() });
    void queryClient.invalidateQueries({ queryKey: projectsQueryKeys.templatesForUpgrade() });
  }, [queryClient]);

  const upgradeActionName =
    upgradeTarget?.project.templateMetadata?.source === 'bundled' ? 'Update' : 'Upgrade';
  const upgradeWizard = useUpgradeProjectWizard({
    actionName: upgradeActionName,
    onFinished: setUpgradeResult,
    onClosed: closeUpgradeTarget,
    toast,
    api,
  });

  useEffect(() => {
    if (!upgradeTarget || !upgradeTarget.project.templateMetadata || upgradeResult) return;
    upgradeWizard.openUpgradeWizard({
      id: upgradeTarget.project.id,
      name: upgradeTarget.project.name,
      targetVersion: upgradeTarget.targetVersion,
    });
  }, [upgradeResult, upgradeTarget, upgradeWizard.openUpgradeWizard]);

  const openProject = useCallback(
    (project: ProjectWithStats) => {
      activateProject(project);
      navigate('/board');
    },
    [activateProject, navigate],
  );

  const editProject = useCallback(
    (project: ProjectWithStats) => {
      setPathValidation(emptyPathValidation());
      editDialog.openEdit(project);
    },
    [editDialog.openEdit],
  );

  const changeEditRootPath = useCallback(
    async (path: string) => {
      editDialog.patchValues({ rootPath: path });
      const isAbsolute = path.startsWith('/') || /^[A-Z]:\\/.test(path);
      setPathValidation({ isAbsolute, exists: false, checked: false });
      if (isAbsolute && path.length > 1) {
        try {
          const validation = await api.statPath(path);
          setPathValidation({ isAbsolute, exists: validation.exists, checked: true });
        } catch {
          setPathValidation({ isAbsolute, exists: false, checked: true });
        }
      }
    },
    [api, editDialog.patchValues],
  );

  const toggleSort = useCallback(
    (field: ProjectsSortField) => {
      if (sortField === field) {
        setSortOrder((current) => (current === 'asc' ? 'desc' : 'asc'));
      } else {
        setSortField(field);
        setSortOrder('asc');
      }
    },
    [sortField],
  );

  const toggleWorkspace = useCallback((workspaceId: string) => {
    setCollapsedWorkspaceIds((current) => {
      const next = new Set(current);
      if (next.has(workspaceId)) next.delete(workspaceId);
      else next.add(workspaceId);
      return next;
    });
  }, []);

  const retryProjectsData = useCallback(() => {
    void Promise.all([projectsQuery.refetch(), workspacesQuery.refetch()]);
  }, [projectsQuery, workspacesQuery]);

  const openUpgrade = useCallback((project: ProjectWithStats, targetVersion: string) => {
    setUpgradeResult(null);
    setUpgradeTarget({ project, targetVersion });
  }, []);

  const closeUpgradeResult = useCallback(() => {
    setUpgradeResult(null);
    closeUpgradeTarget();
  }, [closeUpgradeTarget]);

  const openedFromQueryRef = useRef(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !projectsQuery.isSuccess) return;
    const params = new URLSearchParams(location.search || '');
    const newProjectPath = params.get('newProjectPath') || params.get('projectPath');
    if (!newProjectPath || openedFromQueryRef.current) return;

    const normalize = (path: string) => path.replace(/\/+$/, '');
    const exists = projectsQuery.data.items.some(
      (project) => normalize(project.rootPath) === normalize(newProjectPath),
    );
    openedFromQueryRef.current = true;
    if (!exists) {
      templateForm.setTemplateFormData((current) => ({
        ...current,
        rootPath: newProjectPath,
        workspaceId: current.workspaceId || defaultWorkspace?.id || '',
      }));
      setShowCreateSource(true);
    }
  }, [
    location.search,
    projectsQuery.data,
    projectsQuery.isSuccess,
    templateForm.setTemplateFormData,
    defaultWorkspace?.id,
  ]);

  const confirmProviderMapping = useCallback(
    (mappings: Record<string, string>) => {
      if (!pendingTemplateData) return;
      createMutation.mutate({ ...pendingTemplateData, familyProviderMappings: mappings });
      setProviderMappingData(null);
      setPendingTemplateData(null);
    },
    [createMutation, pendingTemplateData],
  );

  const cancelProviderMapping = useCallback(() => {
    setProviderMappingData(null);
    setPendingTemplateData(null);
    setShowCreateSource(true);
  }, []);

  const navigateFromWarning = useCallback(
    (destination: '/chat' | '/board') => {
      setProviderWarnings([]);
      navigate(destination);
    },
    [navigate],
  );

  const importTemplate = useCallback(() => {
    if (!importSource.target || !importSource.selectedTemplateId) return;
    const request = createTemplateImportRequest(
      importSource.selectedTemplateId,
      importSource.selectedTemplateSource,
      importSource.selectedVersion,
    );
    importSource.close();
    importWizard.openImportWizard(importSource.target, request);
  }, [importSource, importWizard.openImportWizard]);

  const selectImportFile = useCallback(
    async (file: File | undefined) => {
      if (!file || !importSource.target) return;
      importSource.close();
      try {
        importWizard.openImportWizard(importSource.target, await createFileImportRequest(file));
      } catch {
        toast(importFileParseFailureToast);
      }
    },
    [importSource, importWizard.openImportWizard, toast],
  );

  const submitCreateSource = useCallback(() => {
    templateForm.submitTemplate((payload) => {
      setShowCreateSource(false);
      createWizard.openWizard(payload);
    });
  }, [createWizard.openWizard, templateForm.submitTemplate]);

  const cancelCreateSource = useCallback(() => {
    setShowCreateSource(false);
    templateForm.resetTemplateForm();
  }, [templateForm.resetTemplateForm]);

  const table = buildProjectsTableModel({
    data: projectsQuery.data,
    isLoading: projectsQuery.isLoading || workspacesQuery.isLoading,
    search,
    sortField,
    sortOrder,
    templates: allTemplates,
    workspaces: workspacesQuery.data,
    unavailableData: [
      ...(projectsQuery.isError ? (['projects'] as const) : []),
      ...(workspacesQuery.isError ? (['workspaces'] as const) : []),
    ],
    collapsedWorkspaceIds,
    projectDrag,
    statusMessage: moveStatus,
    remoteOwners,
    actions: {
      changeSearch: setSearch,
      toggleSort,
      openCreate: openCreateProject,
      openCreateInWorkspace,
      openCreateWorkspace: () => setCreateWorkspaceOpen(true),
      startProjectDrag,
      enterDragWorkspace,
      leaveDragWorkspace,
      dropProjectOnWorkspace,
      endProjectDrag,
      toggleWorkspace,
      retry: retryProjectsData,
      renameWorkspace: openRenameWorkspace,
      requestDeleteWorkspace: openDeleteWorkspace,
      moveWorkspace,
      openProject,
      editProject,
      requestDelete: deleteDialog.open,
      startImport: importSource.open,
      exportProject: setExportTarget,
      configureProject: setConfigureTarget,
      upgradeProject: openUpgrade,
      requestProjectMove,
    },
  });

  const upgradeResultModel =
    upgradeTarget?.project.templateMetadata && upgradeResult
      ? {
          projectId: upgradeTarget.project.id,
          projectName: upgradeTarget.project.name,
          targetVersion: upgradeTarget.targetVersion,
          source: upgradeTarget.project.templateMetadata.source,
          result: upgradeResult,
          close: closeUpgradeResult,
        }
      : null;

  return {
    table,
    dialogs: {
      edit: {
        open: editDialog.isOpen,
        onOpenChange: editDialog.onOpenChange,
        values: editDialog.values,
        pathValidation,
        changeName: (name) => editDialog.patchValues({ name }),
        changeDescription: (description) => editDialog.patchValues({ description }),
        changeRootPath: changeEditRootPath,
        changeIsTemplate: (isTemplate) => editDialog.patchValues({ isTemplate }),
        submit: () => {
          if (editDialog.entity) {
            updateMutation.mutate({ id: editDialog.entity.id, data: editDialog.values });
          }
        },
        cancel: () => {
          editDialog.close();
          setPathValidation(emptyPathValidation());
        },
        isSubmitting: updateMutation.isPending,
      },
      move: {
        open: projectMoveTarget !== null,
        projectName: projectMoveTarget?.project.name,
        sourceWorkspaceName: projectMoveTarget?.sourceWorkspace.name,
        destinationWorkspaceName: projectMoveTarget?.destinationWorkspace.name,
        pairedDeviceImpact: {
          devices: pairedDevicesQuery.data ?? [],
          isLoading: pairedDevicesQuery.isFetching,
          unavailable: pairedDevicesQuery.isError,
        },
        onOpenChange: (open) => {
          if (!open && !moveMutation.isPending && !moveRequestBusyRef.current) {
            setProjectMoveTarget(null);
          }
        },
        confirm: confirmProjectMove,
        isMoving: moveMutation.isPending,
      },
      delete: {
        open: deleteDialog.isOpen,
        projectName: deleteDialog.target?.name,
        onOpenChange: deleteDialog.onOpenChange,
        confirm: () => {
          if (deleteDialog.target) deleteMutation.mutate(deleteDialog.target.id);
        },
        isDeleting: deleteMutation.isPending,
      },
      create: {
        source: {
          open: showCreateSource,
          onOpenChange: (open) => {
            if (!open) setShowCreateSource(false);
          },
          submit: submitCreateSource,
          sourceTab: templateForm.templateSourceTab,
          changeSourceTab: templateForm.setTemplateSourceTab,
          values: templateForm.templateFormData,
          changeName: (name) =>
            templateForm.setTemplateFormData((current) => ({ ...current, name })),
          changeDescription: (description) =>
            templateForm.setTemplateFormData((current) => ({ ...current, description })),
          changeVersion: (version) =>
            templateForm.setTemplateFormData((current) => ({ ...current, version })),
          workspaces,
          showWorkspaceSelector: workspaces.length >= 2,
          changeWorkspace: (workspaceId) =>
            templateForm.setTemplateFormData((current) => ({ ...current, workspaceId })),
          templates,
          selectedTemplateSource: templateForm.selectedTemplate?.source,
          sortedVersions: templateForm.sortedVersions,
          selectTemplate: templateForm.handleTemplateChange,
          changeRootPath: templateForm.handleTemplatePathChange,
          changeTemplateFilePath: templateForm.handleTemplateFilePathChange,
          pathValidation: templateForm.templatePathValidation,
          filePathValidation: templateForm.templateFilePathValidation,
          cancel: cancelCreateSource,
          isSubmitting: createMutation.isPending,
        },
        wizard: {
          open: createWizard.isOpen,
          onOpenChange: createWizard.onOpenChange,
          controller: createWizard.controller,
          title: 'Set up project',
          description: 'Configure providers, agents, and teams before creating the project.',
          submitLabel: 'Create',
          isLoading: createWizard.isLoading,
          isSubmitting: createWizard.isSubmitting,
          errorMessage: createWizard.isError
            ? 'Failed to load the template preview. Close and try again.'
            : undefined,
        },
        providerMapping: providerMappingData
          ? {
              open: true,
              missingProviders: providerMappingData.missingProviders,
              familyAlternatives: providerMappingData.familyAlternatives,
              canImport: providerMappingData.canImport,
              confirm: confirmProviderMapping,
              cancel: cancelProviderMapping,
              isSubmitting: createMutation.isPending,
            }
          : null,
        warning: {
          open: providerWarnings.length > 0,
          warnings: providerWarnings,
          navigate: navigateFromWarning,
        },
      },
      import: {
        fileInputRef: importSource.fileInputRef,
        selectFile: selectImportFile,
        source: {
          open: importSource.isOpen,
          onOpenChange: importSource.onOpenChange,
          targetName: importSource.target?.name,
          selectedTemplateId: importSource.selectedTemplateId,
          selectTemplate: importSource.selectTemplate,
          templates: allTemplates,
          selectedTemplateSource: importSource.selectedTemplateSource,
          sortedVersions: importSource.sortedVersions,
          selectedVersion: importSource.selectedVersion,
          selectVersion: importSource.selectVersion,
          importTemplate,
          openFilePicker: importSource.openFilePicker,
          isImporting: importWizard.isOpen,
        },
        wizard: {
          open: importWizard.isOpen,
          onOpenChange: importWizard.onOpenChange,
          controller: importWizard.controller,
          title: importWizard.importTarget
            ? `Import into ${importWizard.importTarget.name}`
            : 'Import into project',
          description:
            'Configure providers, agents, and teams, then review the changes before replacing the project.',
          submitLabel: 'Replace Project',
          isLoading: importWizard.isLoading,
          isSubmitting: importWizard.isSubmitting,
          errorMessage: importWizard.isError
            ? 'Failed to load the template preview. Close and try again.'
            : undefined,
        },
        result: importResult,
        closeResult: () => setImportResult(null),
      },
      upgrade: {
        wizard: {
          open: upgradeWizard.isOpen,
          onOpenChange: upgradeWizard.onOpenChange,
          controller: upgradeWizard.controller,
          title: upgradeWizard.upgradeTarget
            ? `${upgradeActionName} ${upgradeWizard.upgradeTarget.name}`
            : `${upgradeActionName} project`,
          description:
            'Configure providers, agents, and teams from the target template, then review the replacement before applying it.',
          submitLabel: `Apply ${upgradeActionName}`,
          isLoading: upgradeWizard.isLoading,
          isSubmitting: upgradeWizard.isSubmitting,
          errorMessage: upgradeWizard.isError
            ? 'Failed to load the target template preview. Close and try again.'
            : undefined,
        },
        result: upgradeResultModel,
      },
      export:
        exportTarget && !isLoadingExportManifest
          ? {
              projectId: exportTarget.id,
              projectName: exportTarget.name,
              existingManifest: exportManifest ?? undefined,
              close: () => setExportTarget(null),
            }
          : null,
      configuration: configureTarget
        ? { projectId: configureTarget.id, close: () => setConfigureTarget(null) }
        : null,
      workspaces: {
        create: {
          open: createWorkspaceOpen,
          name: createWorkspaceName,
          changeName: setCreateWorkspaceName,
          onOpenChange: (open) => {
            setCreateWorkspaceOpen(open);
            if (!open) setCreateWorkspaceName('');
          },
          submit: () => {
            const name = createWorkspaceName.trim();
            const impactUnavailable =
              workspaces.length < 2 &&
              (!workspacesQuery.isSuccess ||
                workspaces.length === 0 ||
                pairedDevicesQuery.isFetching ||
                pairedDevicesQuery.isError);
            if (name && !impactUnavailable) createWorkspaceMutation.mutate(name);
          },
          isSubmitting: createWorkspaceMutation.isPending,
          secondWorkspaceImpact: {
            required: workspaces.length < 2,
            devices: pairedDevicesQuery.data ?? [],
            isLoading:
              workspacesQuery.isLoading ||
              (workspaces.length === 1 && pairedDevicesQuery.isFetching),
            error:
              workspacesQuery.isError ||
              (workspacesQuery.isSuccess && workspaces.length === 0) ||
              pairedDevicesQuery.isError
                ? 'Couldn’t load the paired devices affected by this change. Close and try again.'
                : null,
          },
        },
        rename: {
          open: renameWorkspaceTarget !== null,
          name: renameWorkspaceName,
          changeName: setRenameWorkspaceName,
          onOpenChange: (open) => {
            if (!open) {
              setRenameWorkspaceTarget(null);
              setRenameWorkspaceName('');
            }
          },
          submit: () => {
            const name = renameWorkspaceName.trim();
            if (renameWorkspaceTarget && name) {
              renameWorkspaceMutation.mutate({ id: renameWorkspaceTarget.id, name });
            }
          },
          isSubmitting: renameWorkspaceMutation.isPending,
        },
        delete: {
          open: deleteWorkspaceTarget !== null,
          workspaceName: deleteWorkspaceTarget?.name,
          projectCount: deleteWorkspaceTarget?.projectCount ?? 0,
          deviceGrantCount: deleteWorkspaceTarget?.deviceGrantCount ?? 0,
          replacementWorkspaceId,
          replacementOptions: workspaces.filter(
            (workspace) => workspace.id !== deleteWorkspaceTarget?.id,
          ),
          changeReplacement: setReplacementWorkspaceId,
          onOpenChange: (open) => {
            if (!open) {
              setDeleteWorkspaceTarget(null);
              setReplacementWorkspaceId('');
            }
          },
          confirm: () => {
            if (
              deleteWorkspaceTarget &&
              !deleteWorkspaceTarget.isDefault &&
              replacementWorkspaceId &&
              replacementWorkspaceId !== deleteWorkspaceTarget.id
            ) {
              deleteWorkspaceMutation.mutate({
                id: deleteWorkspaceTarget.id,
                replacementId: replacementWorkspaceId,
              });
            }
          },
          isDeleting: deleteWorkspaceMutation.isPending,
        },
      },
    },
  };
}
