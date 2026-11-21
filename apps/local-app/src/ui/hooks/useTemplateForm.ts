import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  CreateFromTemplateInput,
  ProjectTemplate,
} from '@/ui/pages/projects/lib/project-contracts';
import type { ProjectsPageApi } from '@/ui/pages/projects/lib/projects-page-api';
import { projectsHttpApi } from '@/ui/pages/projects/lib/projects-http-api';

type ToastFn = (args: { title: string; description: string; variant?: 'destructive' }) => void;

export interface TemplateFormData {
  name: string;
  description: string;
  rootPath: string;
  templateId: string;
  version: string;
  templatePath: string;
  workspaceId: string;
}

/** Last segment of a folder path with `/` or `\` separators, ignoring trailing separators. */
export function projectNameFromPath(path: string): string {
  const segments = path.split(/[\\/]+/).filter(Boolean);
  return segments.at(-1) ?? '';
}

export interface TemplatePathValidation {
  isAbsolute: boolean;
  exists: boolean;
  checked: boolean;
}

export interface TemplateFilePathValidation extends TemplatePathValidation {
  isFile: boolean;
  error?: string;
}

interface UseTemplateFormArgs {
  templates?: ProjectTemplate[];
  setShowTemplateDialog: (open: boolean) => void;
  api?: ProjectsPageApi;
  toast: ToastFn;
}

interface UseTemplateFormResult {
  templateSourceTab: 'template' | 'file';
  setTemplateSourceTab: React.Dispatch<React.SetStateAction<'template' | 'file'>>;
  /** Form values; `name` comes from the folder until the user edits the Name field. */
  templateFormData: TemplateFormData;
  /** True while `templateFormData.name` comes from the folder. */
  isNameAutomatic: boolean;
  setTemplateFormData: React.Dispatch<React.SetStateAction<TemplateFormData>>;
  templatePathValidation: TemplatePathValidation;
  templateFilePathValidation: TemplateFilePathValidation;
  selectedTemplate: ProjectTemplate | undefined;
  sortedVersions: string[];
  resetTemplateForm: () => void;
  handleOpenTemplateDialog: () => void;
  handleNameChange: (name: string) => void;
  handleTemplatePathChange: (path: string) => Promise<void>;
  handleTemplateFilePathChange: (path: string) => Promise<void>;
  submitTemplate: (submit: (payload: CreateFromTemplateInput) => void) => void;
  handleTemplateChange: (slug: string) => Promise<void>;
}

export function useTemplateForm({
  templates,
  setShowTemplateDialog,
  api = projectsHttpApi,
  toast,
}: UseTemplateFormArgs): UseTemplateFormResult {
  const [templateSourceTab, setTemplateSourceTab] = useState<'template' | 'file'>('template');
  const [formState, setTemplateFormData] = useState<TemplateFormData>({
    name: '',
    description: '',
    rootPath: '',
    templateId: '',
    version: '',
    templatePath: '',
    workspaceId: '',
  });
  const [templatePathValidation, setTemplatePathValidation] = useState<TemplatePathValidation>({
    isAbsolute: true,
    exists: false,
    checked: false,
  });
  const [templateFilePathValidation, setTemplateFilePathValidation] =
    useState<TemplateFilePathValidation>({
      isAbsolute: true,
      exists: false,
      checked: false,
      isFile: false,
    });
  const latestTemplatePathRef = useRef('');
  const [isNameEdited, setIsNameEdited] = useState(false);
  const templateFormData = useMemo(
    () =>
      isNameEdited ? formState : { ...formState, name: projectNameFromPath(formState.rootPath) },
    [formState, isNameEdited],
  );

  const resetTemplateForm = () => {
    setTemplateFormData({
      name: '',
      description: '',
      rootPath: '',
      templateId: '',
      version: '',
      templatePath: '',
      workspaceId: '',
    });
    setTemplatePathValidation({ isAbsolute: true, exists: false, checked: false });
    setTemplateFilePathValidation({
      isAbsolute: true,
      exists: false,
      checked: false,
      isFile: false,
    });
    setTemplateSourceTab('template');
    setIsNameEdited(false);
    latestTemplatePathRef.current = '';
  };

  const handleNameChange = (name: string) => {
    setIsNameEdited(true);
    setTemplateFormData((prev) => ({ ...prev, name }));
  };

  const handleOpenTemplateDialog = () => {
    resetTemplateForm();
    setShowTemplateDialog(true);
  };

  const handleTemplatePathChange = async (path: string) => {
    setTemplateFormData((prev) => ({ ...prev, rootPath: path }));

    const isAbsolute = path.startsWith('/') || /^[A-Z]:\\/.test(path);
    setTemplatePathValidation({ isAbsolute, exists: false, checked: false });

    if (isAbsolute && path.length > 1) {
      try {
        const validation = await api.statPath(path);
        setTemplatePathValidation({ isAbsolute, exists: validation.exists, checked: true });
      } catch {
        setTemplatePathValidation({ isAbsolute, exists: false, checked: true });
      }
    }
  };

  const handleTemplateFilePathChange = async (path: string) => {
    setTemplateFormData((prev) => ({ ...prev, templatePath: path }));
    latestTemplatePathRef.current = path;

    const isAbsolute = path.startsWith('/') || /^[A-Za-z]:\\/.test(path);
    setTemplateFilePathValidation({
      isAbsolute,
      exists: false,
      checked: true,
      isFile: false,
      error: isAbsolute ? undefined : 'Path must be absolute (start with / or drive letter)',
    });

    if (isAbsolute && path.length > 1) {
      try {
        const stat = await api.statPath(path);
        if (latestTemplatePathRef.current !== path) return;

        if (!stat.exists) {
          setTemplateFilePathValidation((prev) => ({
            ...prev,
            exists: false,
            checked: true,
            isFile: false,
            error: 'File does not exist',
          }));
        } else {
          const isFile = stat.isFile === true;
          setTemplateFilePathValidation((prev) => ({
            ...prev,
            exists: true,
            checked: true,
            isFile,
            error: isFile ? undefined : 'Path must be a file, not a directory',
          }));
        }
      } catch {
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

  const submitTemplate = (submit: (payload: CreateFromTemplateInput) => void) => {
    if (templateSourceTab === 'file') {
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
      submit({
        name: templateFormData.name,
        description: templateFormData.description,
        rootPath: templateFormData.rootPath,
        templatePath: templateFormData.templatePath,
        workspaceId: templateFormData.workspaceId || undefined,
      });
      return;
    }

    if (!templateFormData.templateId) {
      toast({
        title: 'Validation Error',
        description: 'Template selection is required',
        variant: 'destructive',
      });
      return;
    }
    submit({
      name: templateFormData.name,
      description: templateFormData.description,
      rootPath: templateFormData.rootPath,
      templateId: templateFormData.templateId,
      version: templateFormData.version,
      workspaceId: templateFormData.workspaceId || undefined,
    });
  };

  const selectedTemplate = useMemo(() => {
    return templates?.find((t) => t.slug === templateFormData.templateId);
  }, [templates, templateFormData.templateId]);

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

  // Preset selection was removed from the create modal (it now lives in wizard Step 2, sourced from
  // the setup-preview endpoint). This handler only sets the selected template + its latest version.
  const handleTemplateChange = async (slug: string) => {
    const template = templates?.find((t) => t.slug === slug);
    const latestVersion = template?.latestVersion || '';

    setTemplateFormData((prev) => ({
      ...prev,
      templateId: slug,
      version: latestVersion,
    }));
  };

  return {
    templateSourceTab,
    setTemplateSourceTab,
    templateFormData,
    isNameAutomatic: !isNameEdited,
    setTemplateFormData,
    templatePathValidation,
    templateFilePathValidation,
    selectedTemplate,
    sortedVersions,
    resetTemplateForm,
    handleOpenTemplateDialog,
    handleNameChange,
    handleTemplatePathChange,
    handleTemplateFilePathChange,
    submitTemplate,
    handleTemplateChange,
  };
}
