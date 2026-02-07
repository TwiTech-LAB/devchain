import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useLocation } from 'react-router-dom';
import { Button } from '@/ui/components/ui/button';
import { Input } from '@/ui/components/ui/input';
import { Label } from '@/ui/components/ui/label';
import { Badge } from '@/ui/components/ui/badge';
import { Textarea } from '@/ui/components/ui/textarea';
import { Checkbox } from '@/ui/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/components/ui/select';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/ui/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/ui/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/ui/components/ui/tabs';
import { Alert, AlertDescription } from '@/ui/components/ui/alert';
import { Card } from '@/ui/components/ui/card';
import { useToast } from '@/ui/hooks/use-toast';
import { useSelectedProject } from '@/ui/hooks/useProjectSelection';
import { UpgradeDialog } from '@/ui/components/project/UpgradeDialog';
import { ExportDialog } from '@/ui/components/project/ExportDialog';
import { ProjectConfigurationModal } from '@/ui/components/project/ProjectConfigurationModal';
import {
  ProviderMappingModal,
  FamilyAlternative,
} from '@/ui/components/project/ProviderMappingModal';
import {
  Plus,
  Search,
  Edit,
  Trash2,
  ArrowUpDown,
  FolderOpen,
  Users,
  ClipboardList,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Loader2,
  Download,
  Upload,
  ArrowUp,
  Settings,
  MoreHorizontal,
} from 'lucide-react';
import { isLessThan, type ManifestData } from '@devchain/shared';

interface TemplateMetadata {
  slug: string;
  version: string | null;
  source: 'bundled' | 'registry' | 'file';
}

interface Project {
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

interface ProjectStats {
  epicsCount: number;
  agentsCount: number;
}

interface ProjectWithStats extends Project {
  stats?: ProjectStats;
}

interface ProjectsQueryData {
  items: ProjectWithStats[];
  total?: number;
  limit?: number;
  offset?: number;
}

interface ProjectTemplate {
  slug: string;
  name: string;
  source: 'bundled' | 'registry' | 'file';
  versions: string[] | null;
  latestVersion: string | null;
}

async function fetchProjects() {
  const res = await fetch('/api/projects');
  if (!res.ok) throw new Error('Failed to fetch projects');
  const data = await res.json();

  // Fetch stats for each project
  const projectsWithStats = await Promise.all(
    data.items.map(async (project: Project) => {
      try {
        const statsRes = await fetch(`/api/projects/${project.id}/stats`);
        if (statsRes.ok) {
          const stats = await statsRes.json();
          return { ...project, stats };
        }
      } catch (err) {
        // Ignore stats fetch errors
      }
      return project;
    }),
  );

  return { ...data, items: projectsWithStats };
}

async function validatePath(path: string): Promise<{ exists: boolean; error?: string }> {
  try {
    const res = await fetch('/api/fs/stat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    });
    if (res.ok) {
      return { exists: true };
    }
    return { exists: false };
  } catch {
    return { exists: false };
  }
}

async function fetchTemplates(): Promise<ProjectTemplate[]> {
  const res = await fetch('/api/templates');
  if (!res.ok) throw new Error('Failed to fetch templates');
  const data = await res.json();
  // Transform from UnifiedTemplateInfo to ProjectTemplate
  return data.templates.map(
    (t: {
      slug: string;
      name: string;
      source: 'bundled' | 'registry' | 'file';
      versions: string[] | null;
      latestVersion: string | null;
    }) => ({
      slug: t.slug,
      name: t.name,
      source: t.source,
      versions: t.versions,
      latestVersion: t.latestVersion,
    }),
  );
}

async function fetchTemplateManifest(projectId: string): Promise<Partial<ManifestData> | null> {
  try {
    const res = await fetch(`/api/projects/${projectId}/template-manifest`);
    if (!res.ok) return null;
    return (await res.json()) as Partial<ManifestData> | null;
  } catch {
    // Graceful fallback: return null on any failure (network, parse, etc.)
    return null;
  }
}

interface CreateFromTemplateResponse {
  success: boolean;
  project?: { id: string; name: string };
  message?: string;
  providerMappingRequired?: {
    missingProviders: string[];
    familyAlternatives: FamilyAlternative[];
    canImport: boolean;
  };
}

async function createProjectFromTemplate(data: {
  name: string;
  description?: string;
  rootPath: string;
  templateId?: string;
  templatePath?: string;
  version?: string;
  familyProviderMappings?: Record<string, string>;
  presetName?: string;
}): Promise<CreateFromTemplateResponse> {
  // Convert empty version string to null for bundled templates
  // The controller rejects empty strings but accepts null/undefined
  const payload = {
    ...data,
    version: data.version || null,
  };
  const res = await fetch('/api/projects/from-template', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const error = await res
      .json()
      .catch(() => ({ message: 'Failed to create project from template' }));
    throw new Error(error.message || 'Failed to create project from template');
  }
  return res.json();
}

// Legacy createProject API removed – creation must be from template.

async function updateProject(id: string, data: Partial<Project>) {
  const res = await fetch(`/api/projects/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: 'Failed to update project' }));
    throw new Error(error.message || 'Failed to update project');
  }
  return res.json();
}

async function deleteProject(id: string) {
  const res = await fetch(`/api/projects/${id}`, { method: 'DELETE' });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: 'Failed to delete project' }));
    throw new Error(error.message || 'Failed to delete project');
  }
}

export function ProjectsPage() {
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

  // Template creation state
  const [showTemplateDialog, setShowTemplateDialog] = useState(false);
  const [templateSourceTab, setTemplateSourceTab] = useState<'template' | 'file'>('template');
  const [templateFormData, setTemplateFormData] = useState({
    name: '',
    description: '',
    rootPath: '',
    templateId: '',
    version: '', // Only used for registry templates
    templatePath: '', // File-based template path
  });
  const [templatePathValidation, setTemplatePathValidation] = useState<{
    isAbsolute: boolean;
    exists: boolean;
    checked: boolean;
  }>({ isAbsolute: true, exists: false, checked: false });
  const [templateFilePathValidation, setTemplateFilePathValidation] = useState<{
    isAbsolute: boolean;
    exists: boolean;
    checked: boolean;
    isFile: boolean;
    error?: string;
  }>({ isAbsolute: true, exists: false, checked: false, isFile: false });

  // Presets state for template-based creation
  const [availablePresets, setAvailablePresets] = useState<string[]>([]);
  const [selectedPreset, setSelectedPreset] = useState<string>('');

  const { data, isLoading } = useQuery({ queryKey: ['projects'], queryFn: fetchProjects });

  // Import UI state
  const [importingProjectId, setImportingProjectId] = useState<string | null>(null);
  const [importTarget, setImportTarget] = useState<ProjectWithStats | null>(null);
  const [importPayload, setImportPayload] = useState<unknown | null>(null);
  const [dryRunResult, setDryRunResult] = useState<null | {
    dryRun: true;
    missingProviders: string[];
    unmatchedStatuses?: Array<{ id: string; label: string; color: string; epicCount: number }>;
    templateStatuses?: Array<{ label: string; color: string }>;
    counts: { toImport: Record<string, number>; toDelete: Record<string, number> };
    providerMappingRequired?: {
      missingProviders: string[];
      familyAlternatives: FamilyAlternative[];
      canImport: boolean;
    };
  }>(null);
  const [statusMappings, setStatusMappings] = useState<Record<string, string>>({});
  const [showImportModal, setShowImportModal] = useState(false);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>('');
  const [selectedImportVersion, setSelectedImportVersion] = useState<string>('');

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

  // Provider mapping modal state for import flow
  const [showImportProviderMappingModal, setShowImportProviderMappingModal] = useState(false);
  const [importProviderMappingData, setImportProviderMappingData] = useState<{
    missingProviders: string[];
    familyAlternatives: FamilyAlternative[];
    canImport: boolean;
  } | null>(null);
  const [importFamilyProviderMappings, setImportFamilyProviderMappings] = useState<Record<
    string,
    string
  > | null>(null);

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

  const [showMissingProviders, setShowMissingProviders] = useState(false);
  const [showImportConfirm, setShowImportConfirm] = useState(false);
  const [showImportResult, setShowImportResult] = useState(false);
  const [importResult, setImportResult] = useState<null | {
    success: boolean;
    counts: { imported: Record<string, number>; deleted: Record<string, number> };
    mappings: Record<string, Record<string, string>>;
    initialPromptSet?: boolean;
    message?: string;
  }>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const openedFromQueryRef = useRef(false);
  // Track latest template file path to ignore stale validation responses
  const latestTemplatePathRef = useRef('');

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
      await queryClient.invalidateQueries({ queryKey: ['projects'] });
      setShowTemplateDialog(false);
      resetTemplateForm();
      toast({
        title: 'Success',
        description: data.message || 'Project created from template successfully',
      });
      // Navigate to the new project
      if (data.project?.id) {
        setSelectedProjectId(data.project.id);
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

  const resetTemplateForm = () => {
    setTemplateFormData({
      name: '',
      description: '',
      rootPath: '',
      templateId: '',
      version: '',
      templatePath: '',
    });
    setTemplatePathValidation({ isAbsolute: true, exists: false, checked: false });
    setTemplateFilePathValidation({
      isAbsolute: true,
      exists: false,
      checked: false,
      isFile: false,
    });
    setTemplateSourceTab('template');
    latestTemplatePathRef.current = '';
    setSelectedPreset('');
    setAvailablePresets([]);
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

  // Handler for import provider mapping modal confirm
  const handleImportProviderMappingConfirm = (mappings: Record<string, string>) => {
    // Store the mappings and proceed to import confirm dialog
    setImportFamilyProviderMappings(mappings);
    setShowImportProviderMappingModal(false);
    setImportProviderMappingData(null);
    setShowImportConfirm(true);
  };

  // Handler for import provider mapping modal cancel
  const handleImportProviderMappingCancel = () => {
    setShowImportProviderMappingModal(false);
    setImportProviderMappingData(null);
    setImportFamilyProviderMappings(null);
    // Reopen the import modal so user can try again or cancel
    setShowImportModal(true);
  };

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

  // Template path validation
  const handleTemplatePathChange = async (path: string) => {
    setTemplateFormData({ ...templateFormData, rootPath: path });

    const isAbsolute = path.startsWith('/') || /^[A-Z]:\\/.test(path);
    setTemplatePathValidation({ isAbsolute, exists: false, checked: false });

    if (isAbsolute && path.length > 1) {
      const validation = await validatePath(path);
      setTemplatePathValidation({ isAbsolute, exists: validation.exists, checked: true });
    }
  };

  // Template file path validation (for file-based template)
  const handleTemplateFilePathChange = async (path: string) => {
    // Update form data with functional update to avoid stale state
    setTemplateFormData((prev) => ({ ...prev, templatePath: path }));

    // Always update ref first to invalidate any in-flight requests
    latestTemplatePathRef.current = path;

    // Expanded regex to support lowercase Windows drive letters
    const isAbsolute = path.startsWith('/') || /^[A-Za-z]:\\/.test(path);

    // Always set checked: true so UI shows validation feedback immediately
    setTemplateFilePathValidation({
      isAbsolute,
      exists: false,
      checked: true,
      isFile: false,
      error: isAbsolute ? undefined : 'Path must be absolute (start with / or drive letter)',
    });

    if (isAbsolute && path.length > 1) {
      try {
        const res = await fetch('/api/fs/stat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path }),
        });
        // Ignore stale responses if the path has changed
        if (latestTemplatePathRef.current !== path) return;

        if (res.ok) {
          const stat = await res.json();
          // Check if it's a file (not a directory)
          const isFile = stat.type === 'file';
          setTemplateFilePathValidation((prev) => ({
            ...prev,
            exists: true,
            checked: true,
            isFile,
            error: isFile ? undefined : 'Path must be a file, not a directory',
          }));
        } else {
          setTemplateFilePathValidation((prev) => ({
            ...prev,
            exists: false,
            checked: true,
            isFile: false,
            error: 'File does not exist',
          }));
        }
      } catch {
        // Ignore stale responses on error as well
        if (latestTemplatePathRef.current !== path) return;
        setTemplateFilePathValidation((prev) => ({
          ...prev,
          exists: false,
          checked: true,
          isFile: false,
          error: 'Failed to validate path',
        }));
      }
    }
  };

  // Handle template dialog open with preselection
  const handleOpenTemplateDialog = () => {
    resetTemplateForm();
    setShowTemplateDialog(true);
  };

  // Preselect first template when templates load
  const handleTemplateSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    // Validate based on selected tab
    if (templateSourceTab === 'file') {
      // File-based template
      if (!templateFormData.templatePath) {
        toast({
          title: 'Validation Error',
          description: 'Template file path is required',
          variant: 'destructive',
        });
        return;
      }
      if (
        !templateFilePathValidation.checked ||
        !templateFilePathValidation.exists ||
        !templateFilePathValidation.isFile
      ) {
        toast({
          title: 'Validation Error',
          description: templateFilePathValidation.error || 'Invalid template file path',
          variant: 'destructive',
        });
        return;
      }
      // Use templatePath instead of templateId
      createFromTemplateMutation.mutate({
        name: templateFormData.name,
        description: templateFormData.description,
        rootPath: templateFormData.rootPath,
        templatePath: templateFormData.templatePath,
      });
    } else {
      // Template-based
      if (!templateFormData.templateId) {
        toast({
          title: 'Validation Error',
          description: 'Template selection is required',
          variant: 'destructive',
        });
        return;
      }
      createFromTemplateMutation.mutate({
        name: templateFormData.name,
        description: templateFormData.description,
        rootPath: templateFormData.rootPath,
        templateId: templateFormData.templateId,
        version: templateFormData.version,
        ...(selectedPreset && { presetName: selectedPreset }),
      });
    }
  };

  // Helper: Get selected template object
  const selectedTemplate = useMemo(() => {
    return templates?.find((t) => t.slug === templateFormData.templateId);
  }, [templates, templateFormData.templateId]);

  // Helper: Sort versions by semver (latest first)
  const sortedVersions = useMemo(() => {
    if (!selectedTemplate?.versions) return [];
    return [...selectedTemplate.versions].sort((a, b) => {
      const parseVersion = (v: string) => v.split('.').map(Number);
      const [aMajor, aMinor, aPatch] = parseVersion(a);
      const [bMajor, bMinor, bPatch] = parseVersion(b);
      if (bMajor !== aMajor) return bMajor - aMajor;
      if (bMinor !== aMinor) return bMinor - aMinor;
      return bPatch - aPatch;
    });
  }, [selectedTemplate?.versions]);

  // Effect: Preselect first template when templates are loaded
  useEffect(() => {
    if (templates && templates.length > 0 && !templateFormData.templateId) {
      const firstTemplate = templates[0];
      setTemplateFormData((prev) => ({
        ...prev,
        templateId: firstTemplate.slug,
        version: firstTemplate.latestVersion || '',
      }));
    }
  }, [templates, templateFormData.templateId]);

  // Handler: Update version when template changes
  const handleTemplateChange = async (slug: string) => {
    const template = templates?.find((t) => t.slug === slug);
    const latestVersion = template?.latestVersion || '';

    setTemplateFormData((prev) => ({
      ...prev,
      templateId: slug,
      version: latestVersion,
    }));

    // Reset preset selection when template changes
    setSelectedPreset('');
    setAvailablePresets([]);

    // Fetch template content to get presets
    if (template) {
      try {
        // Use latestVersion directly to avoid race condition with state updates
        const templateUrl =
          template.source === 'registry' && latestVersion
            ? `/api/templates/${slug}/versions/${latestVersion}`
            : `/api/templates/${slug}`;
        const res = await fetch(templateUrl);
        if (res.ok) {
          const data = await res.json();
          if (data.content?.presets && Array.isArray(data.content.presets)) {
            // Reverse to show most recently updated first (template stores oldest first)
            const presetNames = data.content.presets.map((p: { name: string }) => p.name).reverse();
            setAvailablePresets(presetNames);
          }
        }
      } catch (err) {
        console.error('Failed to fetch template presets:', err);
      }
    }
  };

  // Effect: Fetch presets when template or version changes (covers both bundled and registry)
  useEffect(() => {
    const fetchPresetsForTemplate = async () => {
      if (!templateFormData.templateId || templateSourceTab === 'file') {
        return;
      }

      const template = templates?.find((t) => t.slug === templateFormData.templateId);
      if (!template) return;

      const templateUrl =
        template.source === 'registry' && templateFormData.version
          ? `/api/templates/${templateFormData.templateId}/versions/${templateFormData.version}`
          : `/api/templates/${templateFormData.templateId}`;

      try {
        const res = await fetch(templateUrl);
        if (res.ok) {
          const data = await res.json();
          if (data.content?.presets && Array.isArray(data.content.presets)) {
            // Reverse to show most recently updated first (template stores oldest first)
            const presetNames = data.content.presets.map((p: { name: string }) => p.name).reverse();
            setAvailablePresets(presetNames);
          } else {
            setAvailablePresets([]);
          }
          // Clear selected preset if it's no longer available
          if (
            selectedPreset &&
            !data.content?.presets?.some((p: { name: string }) => p.name === selectedPreset)
          ) {
            setSelectedPreset('');
          }
        }
      } catch (err) {
        console.error('Failed to fetch template presets:', err);
      }
    };

    fetchPresetsForTemplate();
  }, [
    templateFormData.version,
    templateFormData.templateId,
    templates,
    selectedPreset,
    templateSourceTab,
  ]);

  // Helper: Get selected import template object
  const selectedImportTemplate = useMemo(() => {
    return templates?.find((t) => t.slug === selectedTemplateId);
  }, [templates, selectedTemplateId]);

  // Helper: Sort versions for import modal (latest first)
  const sortedImportVersions = useMemo(() => {
    if (!selectedImportTemplate?.versions) return [];
    return [...selectedImportTemplate.versions].sort((a, b) => {
      const parseVersion = (v: string) => v.split('.').map(Number);
      const [aMajor, aMinor, aPatch] = parseVersion(a);
      const [bMajor, bMinor, bPatch] = parseVersion(b);
      if (bMajor !== aMajor) return bMajor - aMajor;
      if (bMinor !== aMinor) return bMinor - aMinor;
      return bPatch - aPatch;
    });
  }, [selectedImportTemplate?.versions]);

  // Handler: Update version when import template changes
  const handleImportTemplateChange = (slug: string) => {
    const template = templates?.find((t) => t.slug === slug);
    setSelectedTemplateId(slug);
    setSelectedImportVersion(template?.latestVersion || '');
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
  }, [location.search, data?.items]);

  // Export handler - opens dialog for manifest editing
  const handleExport = (project: ProjectWithStats) => {
    setExportTarget(project);
  };

  // Close export dialog
  const handleCloseExportDialog = () => {
    setExportTarget(null);
  };

  // Import flow
  const startImport = (project: ProjectWithStats) => {
    setImportTarget(project);
    setDryRunResult(null);
    setImportResult(null);
    setImportPayload(null);
    setStatusMappings({});
    setSelectedTemplateId('');
    setSelectedImportVersion('');
    setShowImportModal(true);
  };

  const handleImportFromFile = () => {
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
      fileInputRef.current.click();
    }
  };

  const handleImportFromTemplate = async () => {
    if (!selectedTemplateId || !importTarget) return;
    try {
      setImportingProjectId(importTarget.id);
      setShowImportModal(false);
      // Fetch template content from unified API
      // Use version-specific endpoint for registry templates with a selected version
      const templateUrl =
        selectedImportTemplate?.source === 'registry' && selectedImportVersion
          ? `/api/templates/${selectedTemplateId}/versions/${selectedImportVersion}`
          : `/api/templates/${selectedTemplateId}`;
      const res = await fetch(templateUrl);
      if (!res.ok) {
        throw new Error('Failed to fetch template');
      }
      const json = await res.json();
      // Extract the content from the unified API response
      const content = json.content;
      setImportPayload(content);
      // Dry run precheck - send content only, not the full wrapper
      const dryRes = await fetch(`/api/projects/${importTarget.id}/import?dryRun=true`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(content),
      });
      if (!dryRes.ok) {
        const error = await dryRes.json().catch(() => ({}));
        throw new Error(error.message || 'Precheck failed');
      }
      const body = await dryRes.json();
      setDryRunResult(body);
      // Check if provider mapping is required (new flow)
      if (body.providerMappingRequired) {
        setImportProviderMappingData(body.providerMappingRequired);
        setShowImportProviderMappingModal(true);
      } else if (Array.isArray(body.missingProviders) && body.missingProviders.length > 0) {
        // Fallback to old missing providers dialog if providerMappingRequired not present
        setShowMissingProviders(true);
      } else {
        setShowImportConfirm(true);
      }
    } catch (err) {
      toast({
        title: 'Import precheck failed',
        description: err instanceof Error ? err.message : 'Unable to load template',
        variant: 'destructive',
      });
      setImportTarget(null);
      setImportPayload(null);
    } finally {
      setImportingProjectId(null);
    }
  };

  const onFileSelected: React.ChangeEventHandler<HTMLInputElement> = async (e) => {
    const file = e.target.files?.[0];
    if (!file || !importTarget) return;
    try {
      setShowImportModal(false);
      setImportingProjectId(importTarget.id);
      const text = await file.text();
      const json = JSON.parse(text);
      setImportPayload(json);
      // Dry run precheck
      const res = await fetch(`/api/projects/${importTarget.id}/import?dryRun=true`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(json),
      });
      if (!res.ok) {
        const error = await res.json().catch(() => ({}));
        throw new Error(error.message || 'Precheck failed');
      }
      const body = await res.json();
      setDryRunResult(body);
      // Check if provider mapping is required (new flow)
      if (body.providerMappingRequired) {
        setImportProviderMappingData(body.providerMappingRequired);
        setShowImportProviderMappingModal(true);
      } else if (Array.isArray(body.missingProviders) && body.missingProviders.length > 0) {
        // Fallback to old missing providers dialog if providerMappingRequired not present
        setShowMissingProviders(true);
      } else {
        setShowImportConfirm(true);
      }
    } catch (err) {
      toast({
        title: 'Import precheck failed',
        description: err instanceof Error ? err.message : 'Unable to read/validate JSON',
        variant: 'destructive',
      });
      setImportTarget(null);
      setImportPayload(null);
    } finally {
      setImportingProjectId(null);
    }
  };

  const confirmImport = async () => {
    if (!importTarget || !importPayload) return;
    try {
      setImportingProjectId(importTarget.id);
      // Build request body with optional statusMappings and familyProviderMappings
      let requestBody = importPayload;
      if (Object.keys(statusMappings).length > 0 || importFamilyProviderMappings) {
        requestBody = {
          ...(importPayload as object),
          ...(Object.keys(statusMappings).length > 0 && { statusMappings }),
          ...(importFamilyProviderMappings && {
            familyProviderMappings: importFamilyProviderMappings,
          }),
        };
      }
      const res = await fetch(`/api/projects/${importTarget.id}/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });

      if (!res.ok) {
        // Handle non-JSON error responses (e.g., HTML error pages)
        let errorMessage = 'Import failed';
        try {
          const errorBody = await res.json();
          errorMessage = errorBody.message || errorMessage;
        } catch {
          errorMessage = `Import failed with status ${res.status}`;
        }
        throw new Error(errorMessage);
      }

      const body = await res.json();
      setImportResult(body);
      setShowImportConfirm(false);
      setShowImportResult(true);
      // Clear mapping state after successful import
      setStatusMappings({});
      setImportFamilyProviderMappings(null);
      toast({ title: 'Import complete', description: body.message || 'Project replaced.' });
      // Refresh projects to update stats if needed
      queryClient.invalidateQueries({ queryKey: ['projects'] });
    } catch (err) {
      // Close dialog and clear state on error
      setShowImportConfirm(false);
      setStatusMappings({});
      setImportFamilyProviderMappings(null);
      toast({
        title: 'Import failed',
        description: err instanceof Error ? err.message : 'Unable to import project',
        variant: 'destructive',
      });
    } finally {
      setImportingProjectId(null);
    }
  };

  const confirmDelete = () => {
    if (deleteConfirm) {
      deleteMutation.mutate(deleteConfirm.id);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-3xl font-bold">Projects</h1>
        <Button onClick={handleOpenTemplateDialog}>
          <Plus className="h-4 w-4 mr-2" />
          Create Project
        </Button>
      </div>

      {/* Search */}
      <Card className="mb-4 p-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            type="text"
            placeholder="Search projects by name, path, or description..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            data-shortcut="primary-search"
            className="pl-10"
          />
        </div>
      </Card>

      {isLoading && (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      )}

      {data && filteredAndSortedProjects.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <FolderOpen className="h-16 w-16 text-muted-foreground mb-4" />
          <h2 className="text-xl font-semibold mb-2">No Projects Found</h2>
          <p className="text-muted-foreground mb-4">
            {searchQuery
              ? 'Try a different search term or create a new project.'
              : 'Get started by creating your first project.'}
          </p>
          {!searchQuery && (
            <Button onClick={handleOpenTemplateDialog}>
              <Plus className="h-4 w-4 mr-2" />
              Create Project
            </Button>
          )}
        </div>
      )}

      {data && filteredAndSortedProjects.length > 0 && (
        <Card>
          <div className="px-4 py-3 border-b flex items-center justify-between">
            <span className="font-medium">All Projects</span>
            <span className="text-sm text-muted-foreground">
              {filteredAndSortedProjects.length} found
            </span>
          </div>
          <table className="w-full">
            <thead className="bg-muted">
              <tr>
                <th
                  className="px-4 py-3 text-left text-sm font-medium cursor-pointer hover:bg-muted/80"
                  onClick={() => toggleSort('name')}
                >
                  <div className="flex items-center gap-2">
                    Name
                    <ArrowUpDown className="h-4 w-4" />
                    {sortField === 'name' && <span>{sortOrder === 'asc' ? '↑' : '↓'}</span>}
                  </div>
                </th>
                <th
                  className="px-4 py-3 text-left text-sm font-medium cursor-pointer hover:bg-muted/80"
                  onClick={() => toggleSort('rootPath')}
                >
                  <div className="flex items-center gap-2">
                    Path
                    <ArrowUpDown className="h-4 w-4" />
                    {sortField === 'rootPath' && <span>{sortOrder === 'asc' ? '↑' : '↓'}</span>}
                  </div>
                </th>
                <th className="px-4 py-3 text-left text-sm font-medium">Description</th>
                <th className="px-4 py-3 text-left text-sm font-medium">Template</th>
                <th className="px-4 py-3 text-center text-sm font-medium">
                  <div className="flex items-center justify-center gap-1">
                    <ClipboardList className="h-4 w-4" />
                    Epics
                  </div>
                </th>
                <th className="px-4 py-3 text-center text-sm font-medium">
                  <div className="flex items-center justify-center gap-1">
                    <Users className="h-4 w-4" />
                    Agents
                  </div>
                </th>
                <th className="px-4 py-3 text-right text-sm font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredAndSortedProjects.map((project: ProjectWithStats) => (
                <tr key={project.id} className="border-t hover:bg-muted/50">
                  <td className="px-4 py-3">
                    <Button
                      variant="link"
                      className="p-0 h-auto font-medium"
                      onClick={() => handleOpenProject(project)}
                    >
                      {project.name}
                    </Button>
                    {project.isTemplate ? (
                      <Badge variant="outline" className="ml-2" aria-label="Template project">
                        Template
                      </Badge>
                    ) : null}
                  </td>
                  <td className="px-4 py-3">
                    <code className="text-xs text-muted-foreground bg-muted px-2 py-1 rounded">
                      {project.rootPath}
                    </code>
                  </td>
                  <td className="px-4 py-3 text-sm text-muted-foreground">
                    {project.description || '—'}
                  </td>
                  <td className="px-4 py-3 text-sm">
                    {project.templateMetadata ? (
                      <span className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-muted-foreground">
                          {project.templateMetadata.slug}
                        </span>
                        {project.templateMetadata.source === 'bundled' ? (
                          <>
                            <Badge variant="outline" className="text-xs text-muted-foreground">
                              Built-in
                            </Badge>
                            {project.templateMetadata.version && (
                              <Badge
                                variant="outline"
                                className="text-xs text-blue-600 border-blue-600/50"
                              >
                                v{project.templateMetadata.version}
                              </Badge>
                            )}
                          </>
                        ) : project.templateMetadata.version ? (
                          <Badge
                            variant="outline"
                            className="text-xs text-blue-600 border-blue-600/50"
                          >
                            v{project.templateMetadata.version}
                          </Badge>
                        ) : null}
                        {(() => {
                          const upgradeVersion = getUpgradeAvailable(project);
                          if (upgradeVersion) {
                            return (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-5 px-1.5 text-xs text-green-600 hover:text-green-700 hover:bg-green-50"
                                onClick={() => handleOpenUpgradeDialog(project, upgradeVersion)}
                                title={`Upgrade to v${upgradeVersion}`}
                              >
                                <ArrowUp className="h-3 w-3 mr-0.5" />v{upgradeVersion}
                              </Button>
                            );
                          }
                          return null;
                        })()}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <Badge variant="secondary">{project.stats?.epicsCount ?? 0}</Badge>
                  </td>
                  <td className="px-4 py-3 text-center">
                    <Badge variant="secondary">{project.stats?.agentsCount ?? 0}</Badge>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex gap-2 justify-end">
                      {project.isConfigurable && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setConfigureTarget(project)}
                          title="Configure project"
                        >
                          <Settings className="h-4 w-4" />
                        </Button>
                      )}
                      <Button variant="ghost" size="sm" onClick={() => handleEdit(project)}>
                        <Edit className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleDelete(project)}
                        className="text-destructive hover:text-destructive"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="sm">
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onClick={() => startImport(project)}
                            disabled={importingProjectId === project.id}
                          >
                            {importingProjectId === project.id ? (
                              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                            ) : (
                              <Download className="h-4 w-4 mr-2" />
                            )}
                            Import
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => handleExport(project)}>
                            <Upload className="h-4 w-4 mr-2" />
                            Export
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {/* Edit Project Dialog */}
      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Project</DialogTitle>
            <DialogDescription>Update the project details</DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <Label htmlFor="name">Name *</Label>
              <Input
                id="name"
                type="text"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                required
                placeholder="My Project"
              />
            </div>

            <div>
              <Label htmlFor="rootPath">Root Path *</Label>
              <Input
                id="rootPath"
                type="text"
                value={formData.rootPath}
                onChange={(e) => handlePathChange(e.target.value)}
                required
                placeholder="/absolute/path/to/project"
                className={`font-mono text-sm ${
                  !pathValidation.isAbsolute && formData.rootPath
                    ? 'border-destructive'
                    : pathValidation.checked && !pathValidation.exists
                      ? 'border-yellow-600'
                      : ''
                }`}
              />
              {!pathValidation.isAbsolute && formData.rootPath && (
                <Alert variant="destructive" className="mt-2">
                  <XCircle className="h-4 w-4" />
                  <AlertDescription>
                    Path must be absolute (start with / or drive letter)
                  </AlertDescription>
                </Alert>
              )}
              {pathValidation.isAbsolute && pathValidation.checked && !pathValidation.exists && (
                <Alert className="mt-2 border-yellow-600">
                  <AlertTriangle className="h-4 w-4 text-yellow-600" />
                  <AlertDescription className="text-yellow-600">
                    Warning: Path does not exist on filesystem
                  </AlertDescription>
                </Alert>
              )}
              {pathValidation.isAbsolute && pathValidation.checked && pathValidation.exists && (
                <Alert className="mt-2 border-green-600">
                  <CheckCircle2 className="h-4 w-4 text-green-600" />
                  <AlertDescription className="text-green-600">
                    Path exists and is accessible
                  </AlertDescription>
                </Alert>
              )}
            </div>

            <div>
              <Label htmlFor="description">Description</Label>
              <Textarea
                id="description"
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                placeholder="Optional project description"
                rows={3}
              />
            </div>

            <div className="flex items-center gap-2">
              <Checkbox
                id="isTemplate"
                checked={!!formData.isTemplate}
                onCheckedChange={(checked) =>
                  setFormData({ ...formData, isTemplate: Boolean(checked) })
                }
              />
              <Label htmlFor="isTemplate">Mark as template</Label>
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setShowDialog(false);
                  resetForm();
                }}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={updateMutation.isPending}>
                {updateMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                Update
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={!!deleteConfirm} onOpenChange={(open) => !open && setDeleteConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Project</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete <strong>{deleteConfirm?.name}</strong>? This action
              cannot be undone and will also delete all associated epics, agents, and records.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={confirmDelete}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Hidden file picker for Import */}
      <input
        ref={fileInputRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={onFileSelected}
      />

      {/* Import Source Modal */}
      <Dialog open={showImportModal} onOpenChange={setShowImportModal}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Import Configuration</DialogTitle>
            <DialogDescription>
              Import configuration for &quot;{importTarget?.name}&quot; from a template or JSON
              file.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>From Template</Label>
              <div className="flex flex-col gap-2">
                <Select value={selectedTemplateId} onValueChange={handleImportTemplateChange}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select a template..." />
                  </SelectTrigger>
                  <SelectContent>
                    {templates?.map((t) => (
                      <SelectItem key={t.slug} value={t.slug}>
                        <span className="flex items-center gap-2">
                          {t.name}
                          <Badge
                            variant="outline"
                            className={`text-xs ${
                              t.source === 'bundled'
                                ? 'text-muted-foreground'
                                : 'text-blue-600 border-blue-600/50'
                            }`}
                          >
                            {t.source === 'bundled' ? 'Built-in' : 'Downloaded'}
                          </Badge>
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {/* Version picker - only shown for registry (downloaded) templates */}
                {selectedImportTemplate?.source === 'registry' &&
                  sortedImportVersions.length > 0 && (
                    <Select value={selectedImportVersion} onValueChange={setSelectedImportVersion}>
                      <SelectTrigger>
                        <SelectValue placeholder="Select a version..." />
                      </SelectTrigger>
                      <SelectContent>
                        {sortedImportVersions.map((version, index) => (
                          <SelectItem key={version} value={version}>
                            {version}
                            {index === 0 && ' (latest)'}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                <Button
                  onClick={handleImportFromTemplate}
                  disabled={!selectedTemplateId || importingProjectId === importTarget?.id}
                >
                  {importingProjectId === importTarget?.id ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    'Import'
                  )}
                </Button>
              </div>
            </div>
            <div className="relative">
              <div className="absolute inset-0 flex items-center">
                <span className="w-full border-t" />
              </div>
              <div className="relative flex justify-center text-xs uppercase">
                <span className="bg-background px-2 text-muted-foreground">Or</span>
              </div>
            </div>
            <div className="space-y-2">
              <Label>From File</Label>
              <Button variant="outline" className="w-full" onClick={handleImportFromFile}>
                <Upload className="h-4 w-4 mr-2" />
                Select JSON File...
              </Button>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowImportModal(false)}>
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Missing Providers Dialog */}
      <Dialog open={showMissingProviders} onOpenChange={setShowMissingProviders}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Providers Required</DialogTitle>
            <DialogDescription>
              The selected file requires the following providers to be installed/configured before
              importing:
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            {dryRunResult?.missingProviders?.length ? (
              <ul className="list-disc pl-6 text-sm">
                {dryRunResult.missingProviders.map((name) => (
                  <li key={name}>{name}</li>
                ))}
              </ul>
            ) : null}
          </div>
          <DialogFooter>
            <Button onClick={() => setShowMissingProviders(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Confirm Import Dialog */}
      <Dialog open={showImportConfirm} onOpenChange={setShowImportConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Replace Project Configuration?</DialogTitle>
            <DialogDescription>
              This will REPLACE prompts, profiles, agents, statuses, and the initial session prompt
              for this project. This action is destructive.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <div>
              <strong>To import</strong>
              <div className="grid grid-cols-2 gap-2 mt-1">
                {dryRunResult &&
                  Object.entries(dryRunResult.counts.toImport).map(([k, v]) => (
                    <div key={k} className="flex justify-between">
                      <span className="capitalize">{k}</span>
                      <span>{v}</span>
                    </div>
                  ))}
              </div>
            </div>
            <div>
              <strong>Will delete</strong>
              <div className="grid grid-cols-2 gap-2 mt-1">
                {dryRunResult &&
                  Object.entries(dryRunResult.counts.toDelete).map(([k, v]) => (
                    <div key={k} className="flex justify-between">
                      <span className="capitalize">{k}</span>
                      <span>{v}</span>
                    </div>
                  ))}
              </div>
            </div>
            {dryRunResult?.unmatchedStatuses && dryRunResult.unmatchedStatuses.length > 0 && (
              <div className="border-t pt-3 mt-3">
                <strong>Status Mapping Required</strong>
                <p className="text-xs text-muted-foreground mt-1 mb-2">
                  The following statuses have epics but no matching status in the template. Map each
                  to a template status:
                </p>
                <div className="space-y-2">
                  {dryRunResult.unmatchedStatuses.map((status) => (
                    <div key={status.id} className="flex items-center gap-2">
                      <div className="flex items-center gap-1.5 min-w-[140px]">
                        <span
                          style={{ backgroundColor: status.color }}
                          className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                        />
                        <span className="truncate">{status.label}</span>
                        <span className="text-xs text-muted-foreground">({status.epicCount})</span>
                      </div>
                      <span className="text-muted-foreground">→</span>
                      <Select
                        value={statusMappings[status.id] || ''}
                        onValueChange={(val) =>
                          setStatusMappings((prev) => ({ ...prev, [status.id]: val }))
                        }
                      >
                        <SelectTrigger className="w-[140px]">
                          <SelectValue placeholder="Select status" />
                        </SelectTrigger>
                        <SelectContent>
                          {dryRunResult.templateStatuses?.map((ts) => (
                            <SelectItem key={ts.label} value={ts.label}>
                              <div className="flex items-center gap-1.5">
                                <span
                                  style={{ backgroundColor: ts.color }}
                                  className="w-2 h-2 rounded-full"
                                />
                                {ts.label}
                              </div>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowImportConfirm(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={confirmImport}
              disabled={
                !!importingProjectId ||
                (dryRunResult?.unmatchedStatuses?.length ?? 0) > Object.keys(statusMappings).length
              }
            >
              {importingProjectId ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
              Replace Project
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Import Result Dialog */}
      <Dialog open={showImportResult} onOpenChange={setShowImportResult}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Import Completed</DialogTitle>
            <DialogDescription>Project configuration was replaced successfully.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            {importResult?.counts ? (
              <>
                <div>
                  <strong>Imported</strong>
                  <div className="grid grid-cols-2 gap-2 mt-1">
                    {Object.entries(importResult.counts.imported).map(([k, v]) => (
                      <div key={k} className="flex justify-between">
                        <span className="capitalize">{k}</span>
                        <span>{v}</span>
                      </div>
                    ))}
                  </div>
                </div>
                <div>
                  <strong>Deleted</strong>
                  <div className="grid grid-cols-2 gap-2 mt-1">
                    {Object.entries(importResult.counts.deleted).map(([k, v]) => (
                      <div key={k} className="flex justify-between">
                        <span className="capitalize">{k}</span>
                        <span>{v}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            ) : null}
            {importResult?.initialPromptSet !== undefined && (
              <p>Initial prompt mapping: {importResult.initialPromptSet ? 'Set' : 'Not set'}</p>
            )}
          </div>
          <DialogFooter>
            <Button onClick={() => setShowImportResult(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Create Project Dialog (template-based or file-based) */}
      <Dialog open={showTemplateDialog} onOpenChange={setShowTemplateDialog}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Create Project</DialogTitle>
            <DialogDescription>
              Create a new project from a predefined template with prompts, profiles, agents, and
              statuses
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleTemplateSubmit} className="space-y-4">
            <Tabs
              value={templateSourceTab}
              onValueChange={(v) => setTemplateSourceTab(v as 'template' | 'file')}
            >
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="template">From Template</TabsTrigger>
                <TabsTrigger value="file">From File</TabsTrigger>
              </TabsList>

              {/* Template-based creation */}
              <TabsContent value="template" className="space-y-4 mt-4">
                <div>
                  <Label htmlFor="template">Template *</Label>
                  <Select
                    value={templateFormData.templateId}
                    onValueChange={handleTemplateChange}
                    required
                  >
                    <SelectTrigger id="template">
                      <SelectValue placeholder="Select a template" />
                    </SelectTrigger>
                    <SelectContent>
                      {templates?.map((template) => (
                        <SelectItem key={template.slug} value={template.slug}>
                          <span className="flex items-center gap-2">
                            {template.name}
                            <Badge
                              variant="outline"
                              className={`text-xs ${
                                template.source === 'bundled'
                                  ? 'text-muted-foreground'
                                  : 'text-blue-600 border-blue-600/50'
                              }`}
                            >
                              {template.source === 'bundled' ? 'Built-in' : 'Downloaded'}
                            </Badge>
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Version picker - only shown for registry (downloaded) templates */}
                {selectedTemplate?.source === 'registry' && sortedVersions.length > 0 && (
                  <div>
                    <Label htmlFor="template-version">Version</Label>
                    <Select
                      value={templateFormData.version}
                      onValueChange={(value) =>
                        setTemplateFormData({ ...templateFormData, version: value })
                      }
                    >
                      <SelectTrigger id="template-version">
                        <SelectValue placeholder="Select a version" />
                      </SelectTrigger>
                      <SelectContent>
                        {sortedVersions.map((version, index) => (
                          <SelectItem key={version} value={version}>
                            {version}
                            {index === 0 && ' (latest)'}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}

                {/* Preset dropdown - shown when template has presets */}
                {availablePresets.length > 0 && (
                  <div>
                    <Label htmlFor="template-preset">Preset (Optional)</Label>
                    <Select
                      value={selectedPreset || '__none__'}
                      onValueChange={(v) => setSelectedPreset(v === '__none__' ? '' : v)}
                    >
                      <SelectTrigger id="template-preset">
                        <SelectValue placeholder="Use default configuration" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">Default configuration</SelectItem>
                        {availablePresets.map((presetName) => (
                          <SelectItem key={presetName} value={presetName}>
                            {presetName}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground mt-1">
                      Optionally select a preset to pre-configure agent providers
                    </p>
                  </div>
                )}
              </TabsContent>

              {/* File-based creation */}
              <TabsContent value="file" className="space-y-4 mt-4">
                <div>
                  <Label htmlFor="templateFilePath">Template File Path *</Label>
                  <Input
                    id="templateFilePath"
                    type="text"
                    value={templateFormData.templatePath}
                    onChange={(e) => handleTemplateFilePathChange(e.target.value)}
                    required={templateSourceTab === 'file'}
                    placeholder="/absolute/path/to/template.json"
                    className="font-mono text-sm"
                  />
                  {templateFilePathValidation.checked && (
                    <div className="mt-2 space-y-2">
                      {!templateFilePathValidation.isAbsolute && (
                        <Alert variant="destructive">
                          <XCircle className="h-4 w-4" />
                          <AlertDescription>
                            Path must be absolute (start with / or drive letter)
                          </AlertDescription>
                        </Alert>
                      )}
                      {templateFilePathValidation.isAbsolute &&
                        !templateFilePathValidation.exists && (
                          <Alert className="border-yellow-600">
                            <AlertTriangle className="h-4 w-4 text-yellow-600" />
                            <AlertDescription className="text-yellow-600">
                              File does not exist
                            </AlertDescription>
                          </Alert>
                        )}
                      {templateFilePathValidation.exists && !templateFilePathValidation.isFile && (
                        <Alert variant="destructive">
                          <XCircle className="h-4 w-4" />
                          <AlertDescription>Path must be a file, not a directory</AlertDescription>
                        </Alert>
                      )}
                      {templateFilePathValidation.exists && templateFilePathValidation.isFile && (
                        <Alert className="border-green-600">
                          <CheckCircle2 className="h-4 w-4 text-green-600" />
                          <AlertDescription className="text-green-600">
                            Valid template file
                          </AlertDescription>
                        </Alert>
                      )}
                    </div>
                  )}
                  <p className="text-xs text-muted-foreground mt-2">
                    Enter the absolute path to a JSON template file
                  </p>
                </div>
              </TabsContent>
            </Tabs>

            <div>
              <Label htmlFor="template-name">Name *</Label>
              <Input
                id="template-name"
                type="text"
                value={templateFormData.name}
                onChange={(e) => setTemplateFormData({ ...templateFormData, name: e.target.value })}
                required
                placeholder="My Project"
              />
            </div>

            <div>
              <Label htmlFor="template-rootPath">Root Path *</Label>
              <Input
                id="template-rootPath"
                type="text"
                value={templateFormData.rootPath}
                onChange={(e) => handleTemplatePathChange(e.target.value)}
                required
                placeholder="/absolute/path/to/project"
                className={`font-mono text-sm ${
                  !templatePathValidation.isAbsolute && templateFormData.rootPath
                    ? 'border-destructive'
                    : templatePathValidation.checked && !templatePathValidation.exists
                      ? 'border-yellow-600'
                      : ''
                }`}
              />
              {!templatePathValidation.isAbsolute && templateFormData.rootPath && (
                <Alert variant="destructive" className="mt-2">
                  <XCircle className="h-4 w-4" />
                  <AlertDescription>
                    Path must be absolute (start with / or drive letter)
                  </AlertDescription>
                </Alert>
              )}
              {templatePathValidation.isAbsolute &&
                templatePathValidation.checked &&
                !templatePathValidation.exists && (
                  <Alert className="mt-2 border-yellow-600">
                    <AlertTriangle className="h-4 w-4 text-yellow-600" />
                    <AlertDescription className="text-yellow-600">
                      Warning: Path does not exist on filesystem
                    </AlertDescription>
                  </Alert>
                )}
              {templatePathValidation.isAbsolute &&
                templatePathValidation.checked &&
                templatePathValidation.exists && (
                  <Alert className="mt-2 border-green-600">
                    <CheckCircle2 className="h-4 w-4 text-green-600" />
                    <AlertDescription className="text-green-600">
                      Path exists and is accessible
                    </AlertDescription>
                  </Alert>
                )}
            </div>

            <div>
              <Label htmlFor="template-description">Description</Label>
              <Textarea
                id="template-description"
                value={templateFormData.description}
                onChange={(e) =>
                  setTemplateFormData({ ...templateFormData, description: e.target.value })
                }
                placeholder="Optional project description"
                rows={3}
              />
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setShowTemplateDialog(false);
                  resetTemplateForm();
                }}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={createFromTemplateMutation.isPending}>
                {createFromTemplateMutation.isPending && (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                )}
                Create
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Upgrade Dialog */}
      {upgradeTarget && upgradeTarget.project.templateMetadata && (
        <UpgradeDialog
          projectId={upgradeTarget.project.id}
          projectName={upgradeTarget.project.name}
          templateSlug={upgradeTarget.project.templateMetadata.slug}
          currentVersion={upgradeTarget.project.templateMetadata.version || ''}
          targetVersion={upgradeTarget.targetVersion}
          source={upgradeTarget.project.templateMetadata.source}
          open={true}
          onClose={handleCloseUpgradeDialog}
        />
      )}

      {/* Export Dialog - waits for manifest fetch before rendering */}
      {exportTarget && !isLoadingExportManifest && (
        <ExportDialog
          projectId={exportTarget.id}
          projectName={exportTarget.name}
          existingManifest={exportManifest ?? undefined}
          open={true}
          onClose={handleCloseExportDialog}
        />
      )}

      {/* Configuration Modal */}
      {configureTarget && (
        <ProjectConfigurationModal
          projectId={configureTarget.id}
          open={true}
          onOpenChange={(open) => !open && setConfigureTarget(null)}
        />
      )}

      {/* Provider Mapping Modal for create-from-template */}
      {providerMappingData && (
        <ProviderMappingModal
          open={showProviderMappingModal}
          onOpenChange={(open) => {
            if (!open) {
              handleProviderMappingCancel();
            }
          }}
          missingProviders={providerMappingData.missingProviders}
          familyAlternatives={providerMappingData.familyAlternatives}
          canImport={providerMappingData.canImport}
          onConfirm={handleProviderMappingConfirm}
          loading={createFromTemplateMutation.isPending}
        />
      )}

      {/* Provider Mapping Modal for import flow */}
      {importProviderMappingData && (
        <ProviderMappingModal
          open={showImportProviderMappingModal}
          onOpenChange={(open) => {
            if (!open) {
              handleImportProviderMappingCancel();
            }
          }}
          missingProviders={importProviderMappingData.missingProviders}
          familyAlternatives={importProviderMappingData.familyAlternatives}
          canImport={importProviderMappingData.canImport}
          onConfirm={handleImportProviderMappingConfirm}
          loading={!!importingProjectId}
        />
      )}
    </div>
  );
}
