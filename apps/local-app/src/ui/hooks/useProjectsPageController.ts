import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useLocation } from 'react-router-dom';
import { useToast } from '@/ui/hooks/use-toast';
import { useSelectedProject } from '@/ui/hooks/useProjectSelection';
import { useProjectImport } from '@/ui/hooks/useProjectImport';
import { useTemplateForm } from '@/ui/hooks/useTemplateForm';
import type { FamilyAlternative } from '@/ui/components/project/ProviderMappingModal';
import {
  type CreateFromTemplateResponse,
  fetchProjects,
  validatePath,
  fetchTemplates,
  fetchTemplateManifest,
  createProjectFromTemplate,
  updateProject,
  deleteProject,
} from '@/ui/pages/projects/lib/project-api';
import { isLessThan } from '@devchain/shared';

export interface TemplateMetadata {
  slug: string;
  version: string | null;
  source: 'bundled' | 'registry' | 'file';
}

export interface Project {
  id: string;
  name: string;
  description: string | null;
  rootPath: string;
  isTemplate?: boolean;
  isConfigurable?: boolean;
  createdAt: string;
  updatedAt: string;
  templateMetadata?: TemplateMetadata | null;
  /** Available bundled upgrade version from server-side detection */
  bundledUpgradeAvailable?: string | null;
}

export interface ProjectStats {
  epicsCount: number;
  agentsCount: number;
}

export interface ProjectWithStats extends Project {
  stats?: ProjectStats;
}

export interface ProjectsQueryData {
  items: ProjectWithStats[];
  total?: number;
  limit?: number;
  offset?: number;
}

export function useProjectsPageController() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const { toast } = useToast();
  const { selectedProjectId, setSelectedProjectId } = useSelectedProject();
  const [showDialog, setShowDialog] = useState(false); // used only for Edit
  const [deleteConfirm, setDeleteConfirm] = useState<Project | null>(null);
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [formData, setFormData] = useState({
    name: '',
    description: '',
    rootPath: '',
    isTemplate: false,
  });
  const [searchQuery, setSearchQuery] = useState('');
  const [sortField, setSortField] = useState<'name' | 'rootPath' | 'createdAt'>('name');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');
  const [pathValidation, setPathValidation] = useState<{
    isAbsolute: boolean;
    exists: boolean;
    checked: boolean;
  }>({ isAbsolute: true, exists: false, checked: false });

  // Dialog visibility state shared across hooks and queries
  const [showTemplateDialog, setShowTemplateDialog] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);

  const { data, isLoading } = useQuery({ queryKey: ['projects'], queryFn: fetchProjects });

  // Upgrade dialog state
  const [upgradeTarget, setUpgradeTarget] = useState<{
    project: ProjectWithStats;
    targetVersion: string;
  } | null>(null);

  // Export dialog state
  const [exportTarget, setExportTarget] = useState<ProjectWithStats | null>(null);

  // Fetch template manifest for export dialog (must complete before dialog renders)
  const { data: exportManifest, isFetching: isLoadingExportManifest } = useQuery({
    queryKey: ['template-manifest', exportTarget?.id],
    queryFn: () => fetchTemplateManifest(exportTarget!.id),
    enabled: !!exportTarget,
    staleTime: 0, // Always refetch when export target changes
  });

  // Configuration modal state
  const [configureTarget, setConfigureTarget] = useState<ProjectWithStats | null>(null);

  // Provider mapping modal state for create-from-template flow
  const [showProviderMappingModal, setShowProviderMappingModal] = useState(false);
  const [providerMappingData, setProviderMappingData] = useState<{
    missingProviders: string[];
    familyAlternatives: FamilyAlternative[];
    canImport: boolean;
  } | null>(null);
  const [pendingTemplateData, setPendingTemplateData] = useState<{
    name: string;
    description: string;
    rootPath: string;
    templateId: string;
    version: string;
  } | null>(null);
  const [showProviderWarningModal, setShowProviderWarningModal] = useState(false);
  const [providerWarnings, setProviderWarnings] = useState<CreateFromTemplateResponse['warnings']>(
    [],
  );

  // Templates query for upgrade checking (always enabled)
  const { data: allTemplates } = useQuery({
    queryKey: ['templates-for-upgrade'],
    queryFn: fetchTemplates,
    staleTime: 60000, // Cache for 1 minute
  });

  // Templates query (used by both create dialog and import modal)
  const { data: templates } = useQuery({
    queryKey: ['project-templates'],
    queryFn: fetchTemplates,
    enabled: showTemplateDialog || showImportModal,
  });

  const {
    templateSourceTab,
    setTemplateSourceTab,
    templateFormData,
    setTemplateFormData,
    templatePathValidation,
    templateFilePathValidation,
    availablePresets,
    selectedPreset,
    setSelectedPreset,
    selectedTemplate,
    sortedVersions,
    resetTemplateForm,
    handleOpenTemplateDialog,
    handleTemplatePathChange,
    handleTemplateFilePathChange,
    handleTemplateSubmit,
    handleTemplateChange,
  } = useTemplateForm({
    templates,
    setShowTemplateDialog,
    validatePath,
    toast,
  });

  const {
    importingProjectId,
    importTarget,
    dryRunResult,
    showMissingProviders,
    setShowMissingProviders,
    showImportConfirm,
    setShowImportConfirm,
    showImportResult,
    setShowImportResult,
    importResult,
    statusMappings,
    setStatusMappings,
    selectedTemplateId,
    selectedImportVersion,
    setSelectedImportVersion,
    selectedImportTemplateSource,
    sortedImportVersions,
    fileInputRef,
    showImportProviderMappingModal,
    importProviderMappingData,
    startImport,
    handleImportFromFile,
    handleImportFromTemplate,
    onFileSelected,
    confirmImport,
    handleImportTemplateChange,
    handleImportProviderMappingConfirm,
    handleImportProviderMappingCancel,
    preconfigOpen: importPreconfigOpen,
    preconfigTeams: importPreconfigTeams,
    preconfigProfiles: importPreconfigProfiles,
    handlePreconfigConfirm: handleImportPreconfigConfirm,
    handlePreconfigCancel: handleImportPreconfigCancel,
  } = useProjectImport({
    templates,
    setShowImportModal,
    toast,
  });

  /**
   * Check if a project has an upgrade available
   * Returns the latest version if upgrade is available, null otherwise
   */
  const getUpgradeAvailable = useCallback(
    (project: ProjectWithStats): string | null => {
      const metadata = project.templateMetadata;
      if (!metadata) return null;

      // Bundled templates: use server-side detection (bundledUpgradeAvailable)
      if (metadata.source === 'bundled') {
        return project.bundledUpgradeAvailable ?? null;
      }

      // Registry templates: client-side detection using cached templates
      if (!metadata.version) return null;

      // Find the template in downloaded templates
      const template = allTemplates?.find(
        (t) => t.slug === metadata.slug && t.source === 'registry',
      );
      if (!template || !template.latestVersion) {
        return null;
      }

      // Compare versions - if project version is older, upgrade is available
      if (isLessThan(metadata.version, template.latestVersion)) {
        return template.latestVersion;
      }

      return null;
    },
    [allTemplates],
  );
  // Handler for opening upgrade dialog
  const handleOpenUpgradeDialog = useCallback(
    (project: ProjectWithStats, targetVersion: string) => {
      setUpgradeTarget({ project, targetVersion });
    },
    [],
  );

  // Handler for closing upgrade dialog
  const handleCloseUpgradeDialog = useCallback(() => {
    setUpgradeTarget(null);
    // Refresh projects to reflect version change and remove upgrade badge
    queryClient.invalidateQueries({ queryKey: ['projects'] });
    queryClient.invalidateQueries({ queryKey: ['templates-for-upgrade'] });
  }, [queryClient]);

  const openedFromQueryRef = useRef(false);

  // Removed legacy create mutation; dialog is now Edit-only.

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<Project> }) => updateProject(id, data),
    onMutate: async ({ id, data }) => {
      await queryClient.cancelQueries({ queryKey: ['projects'] });
      const previousData = queryClient.getQueryData(['projects']);

      queryClient.setQueryData(['projects'], (old: ProjectsQueryData | undefined) => ({
        ...old,
        items: old?.items.map((p: Project) =>
          p.id === id ? { ...p, ...data, updatedAt: new Date().toISOString() } : p,
        ),
      }));

      return { previousData };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      setShowDialog(false);
      setEditingProject(null);
      resetForm();
      toast({
        title: 'Success',
        description: 'Project updated successfully',
      });
    },
    onError: (error, variables, context) => {
      if (context?.previousData) {
        queryClient.setQueryData(['projects'], context.previousData);
      }
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to update project',
        variant: 'destructive',
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: deleteProject,
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: ['projects'] });
      const previousData = queryClient.getQueryData<ProjectsQueryData>(['projects']);

      // Determine which project to select after deletion
      let projectToSelect: string | undefined = undefined;
      if (selectedProjectId === id && previousData?.items) {
        const remainingProjects = previousData.items.filter((p) => p.id !== id);
        if (remainingProjects.length > 0) {
          projectToSelect = remainingProjects[0].id;
        }
      }

      queryClient.setQueryData(['projects'], (old: ProjectsQueryData | undefined) => ({
        ...old,
        items: old?.items.filter((p: Project) => p.id !== id),
      }));

      return { previousData, projectToSelect };
    },
    onSuccess: async (_, deletedProjectId, context) => {
      // If the deleted project was selected, update selection immediately BEFORE refetch
      // This prevents the useEffect in useProjectSelection from clearing it
      if (context && 'projectToSelect' in context) {
        setSelectedProjectId(context.projectToSelect);
      }

      // Refetch projects to get the updated list from server
      await queryClient.refetchQueries({ queryKey: ['projects'] });

      setDeleteConfirm(null);
      toast({
        title: 'Success',
        description: 'Project deleted successfully',
      });
    },
    onError: (error, variables, context) => {
      if (context?.previousData) {
        queryClient.setQueryData(['projects'], context.previousData);
      }
      setDeleteConfirm(null);
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to delete project',
        variant: 'destructive',
      });
    },
  });

  const createFromTemplateMutation = useMutation({
    mutationFn: createProjectFromTemplate,
    onSuccess: async (data) => {
      // Check if provider mapping is required
      if (data.providerMappingRequired) {
        // Store the pending form data and show the provider mapping modal
        setPendingTemplateData({ ...templateFormData });
        setProviderMappingData(data.providerMappingRequired);
        setShowTemplateDialog(false);
        setShowProviderMappingModal(true);
        return;
      }

      // Project created successfully
      setShowTemplateDialog(false);
      resetTemplateForm();
      await queryClient.invalidateQueries({ queryKey: ['projects'] });
      if (data.project?.id) {
        setSelectedProjectId(data.project.id);
      }

      if (data.warnings?.length) {
        setProviderWarnings(data.warnings);
        setShowProviderWarningModal(true);
        return;
      }

      toast({
        title: 'Success',
        description: data.message || 'Project created from template successfully',
      });
      // Navigate to the new project
      if (data.project?.id) {
        navigate('/board');
      }
    },
    onError: (error) => {
      toast({
        title: 'Error',
        description:
          error instanceof Error ? error.message : 'Failed to create project from template',
        variant: 'destructive',
      });
    },
  });

  const resetForm = () => {
    setFormData({ name: '', description: '', rootPath: '', isTemplate: false });
    setEditingProject(null);
    setPathValidation({ isAbsolute: true, exists: false, checked: false });
  };

  // Handler for provider mapping modal confirm
  const handleProviderMappingConfirm = async (mappings: Record<string, string>) => {
    if (!pendingTemplateData) return;

    // Re-submit with provider mappings
    createFromTemplateMutation.mutate({
      ...pendingTemplateData,
      familyProviderMappings: mappings,
    });

    // Close the modal and clear pending data
    setShowProviderMappingModal(false);
    setProviderMappingData(null);
    setPendingTemplateData(null);
  };

  // Handler for provider mapping modal cancel
  const handleProviderMappingCancel = () => {
    setShowProviderMappingModal(false);
    setProviderMappingData(null);
    setPendingTemplateData(null);
    // Reopen the template dialog so user can try again or cancel
    setShowTemplateDialog(true);
  };

  const handleWarningModalNavigate = useCallback(
    (destination: '/chat' | '/board') => {
      setShowProviderWarningModal(false);
      setProviderWarnings([]);
      navigate(destination);
    },
    [navigate],
  );

  // Filter and sort projects
  const filteredAndSortedProjects = useMemo(() => {
    if (!data?.items) return [];

    const filtered = data.items.filter((project: ProjectWithStats) => {
      const query = searchQuery.toLowerCase();
      return (
        project.name.toLowerCase().includes(query) ||
        project.rootPath.toLowerCase().includes(query) ||
        project.description?.toLowerCase().includes(query)
      );
    });

    filtered.sort((a: ProjectWithStats, b: ProjectWithStats) => {
      let aVal: string | number = '';
      let bVal: string | number = '';

      if (sortField === 'name') {
        aVal = a.name.toLowerCase();
        bVal = b.name.toLowerCase();
      } else if (sortField === 'rootPath') {
        aVal = a.rootPath.toLowerCase();
        bVal = b.rootPath.toLowerCase();
      } else if (sortField === 'createdAt') {
        aVal = new Date(a.createdAt).getTime();
        bVal = new Date(b.createdAt).getTime();
      }

      if (sortOrder === 'asc') {
        return aVal > bVal ? 1 : -1;
      } else {
        return aVal < bVal ? 1 : -1;
      }
    });

    return filtered;
  }, [data, searchQuery, sortField, sortOrder]);

  // Validate path on change
  const handlePathChange = async (path: string) => {
    setFormData({ ...formData, rootPath: path });

    // Check if absolute path
    const isAbsolute = path.startsWith('/') || /^[A-Z]:\\/.test(path);
    setPathValidation({ isAbsolute, exists: false, checked: false });

    if (isAbsolute && path.length > 1) {
      const validation = await validatePath(path);
      setPathValidation({ isAbsolute, exists: validation.exists, checked: true });
    }
  };

  const toggleSort = (field: 'name' | 'rootPath' | 'createdAt') => {
    if (sortField === field) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortOrder('asc');
    }
  };

  const handleOpenProject = useCallback(
    (project: ProjectWithStats) => {
      setSelectedProjectId(project.id);
      navigate('/board');
    },
    [navigate, setSelectedProjectId],
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (editingProject) {
      updateMutation.mutate({ id: editingProject.id, data: formData });
    }
  };

  const handleEdit = (project: Project) => {
    setEditingProject(project);
    setFormData({
      name: project.name,
      description: project.description || '',
      rootPath: project.rootPath,
      isTemplate: Boolean(project.isTemplate),
    });
    setShowDialog(true);
  };

  const handleDelete = (project: Project) => {
    setDeleteConfirm(project);
  };

  // Auto-open "Create from template" dialog based on URL params when no matching project
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(location.search || '');
    const newProjectPath = params.get('newProjectPath') || params.get('projectPath');
    if (!newProjectPath || openedFromQueryRef.current) return;

    const items = data?.items ?? [];
    const normalize = (p: string) => p.replace(/\/+$/, '');
    const exists = items.some(
      (p: ProjectWithStats) => normalize(p.rootPath) === normalize(newProjectPath),
    );

    if (!exists) {
      // Prefill and open create-from-template dialog once
      setTemplateFormData((prev) => ({ ...prev, rootPath: newProjectPath }));
      setShowTemplateDialog(true);
      openedFromQueryRef.current = true;
    }
  }, [location.search, data?.items, setTemplateFormData]);

  // Export handler - opens dialog for manifest editing
  const handleExport = (project: ProjectWithStats) => {
    setExportTarget(project);
  };

  // Close export dialog
  const handleCloseExportDialog = () => {
    setExportTarget(null);
  };

  const confirmDelete = () => {
    if (deleteConfirm) {
      deleteMutation.mutate(deleteConfirm.id);
    }
  };

  return {
    searchQuery,
    setSearchQuery,
    isLoading,
    data,
    filteredAndSortedProjects,
    sortField,
    sortOrder,
    toggleSort,
    handleOpenProject,
    handleOpenTemplateDialog,
    getUpgradeAvailable,
    handleOpenUpgradeDialog,
    handleEdit,
    handleDelete,
    startImport,
    importingProjectId,
    handleExport,
    showDialog,
    setShowDialog,
    formData,
    setFormData,
    pathValidation,
    handlePathChange,
    handleSubmit,
    resetForm,
    updateMutation,
    deleteConfirm,
    setDeleteConfirm,
    confirmDelete,
    deleteMutation,
    fileInputRef,
    onFileSelected,
    showImportModal,
    setShowImportModal,
    importTarget,
    selectedTemplateId,
    handleImportTemplateChange,
    templates,
    selectedImportTemplateSource,
    sortedImportVersions,
    selectedImportVersion,
    setSelectedImportVersion,
    handleImportFromTemplate,
    handleImportFromFile,
    showMissingProviders,
    setShowMissingProviders,
    dryRunResult,
    showImportConfirm,
    setShowImportConfirm,
    statusMappings,
    setStatusMappings,
    confirmImport,
    showImportResult,
    setShowImportResult,
    importResult,
    showTemplateDialog,
    setShowTemplateDialog,
    handleTemplateSubmit,
    templateSourceTab,
    setTemplateSourceTab,
    templateFormData,
    setTemplateFormData,
    selectedTemplate,
    sortedVersions,
    availablePresets,
    selectedPreset,
    setSelectedPreset,
    handleTemplateChange,
    handleTemplatePathChange,
    handleTemplateFilePathChange,
    templatePathValidation,
    templateFilePathValidation,
    resetTemplateForm,
    createFromTemplateMutation,
    upgradeTarget,
    handleCloseUpgradeDialog,
    exportTarget,
    isLoadingExportManifest,
    exportManifest,
    handleCloseExportDialog,
    configureTarget,
    setConfigureTarget,
    providerMappingData,
    showProviderMappingModal,
    handleProviderMappingCancel,
    handleProviderMappingConfirm,
    showProviderWarningModal,
    providerWarnings,
    handleWarningModalNavigate,
    importProviderMappingData,
    showImportProviderMappingModal,
    handleImportProviderMappingCancel,
    handleImportProviderMappingConfirm,
    importPreconfigOpen,
    importPreconfigTeams,
    importPreconfigProfiles,
    handleImportPreconfigConfirm,
    handleImportPreconfigCancel,
  };
}

export type ProjectsPageController = ReturnType<typeof useProjectsPageController>;
