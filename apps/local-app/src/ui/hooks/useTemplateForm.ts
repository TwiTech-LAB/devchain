import { useEffect, useMemo, useRef, useState } from 'react';

type ToastFn = (args: { title: string; description: string; variant?: 'destructive' }) => void;

export interface TemplateOption {
  slug: string;
  name: string;
  source: 'bundled' | 'registry' | 'file';
  versions: string[] | null;
  latestVersion: string | null;
}

export interface TemplateFormData {
  name: string;
  description: string;
  rootPath: string;
  templateId: string;
  version: string;
  templatePath: string;
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

export interface CreateFromTemplatePayload {
  name: string;
  description?: string;
  rootPath: string;
  templateId?: string;
  templatePath?: string;
  version?: string;
  presetName?: string;
}

interface UseTemplateFormArgs {
  templates?: TemplateOption[];
  setShowTemplateDialog: (open: boolean) => void;
  validatePath: (path: string) => Promise<{ exists: boolean; error?: string }>;
  toast: ToastFn;
}

interface UseTemplateFormResult {
  templateSourceTab: 'template' | 'file';
  setTemplateSourceTab: React.Dispatch<React.SetStateAction<'template' | 'file'>>;
  templateFormData: TemplateFormData;
  setTemplateFormData: React.Dispatch<React.SetStateAction<TemplateFormData>>;
  templatePathValidation: TemplatePathValidation;
  templateFilePathValidation: TemplateFilePathValidation;
  availablePresets: string[];
  selectedPreset: string;
  setSelectedPreset: React.Dispatch<React.SetStateAction<string>>;
  selectedTemplate: TemplateOption | undefined;
  sortedVersions: string[];
  resetTemplateForm: () => void;
  handleOpenTemplateDialog: () => void;
  handleTemplatePathChange: (path: string) => Promise<void>;
  handleTemplateFilePathChange: (path: string) => Promise<void>;
  handleTemplateSubmit: (
    event: React.FormEvent,
    submitTemplate: (payload: CreateFromTemplatePayload) => void,
  ) => void;
  handleTemplateChange: (slug: string) => Promise<void>;
}

export function useTemplateForm({
  templates,
  setShowTemplateDialog,
  validatePath,
  toast,
}: UseTemplateFormArgs): UseTemplateFormResult {
  const [templateSourceTab, setTemplateSourceTab] = useState<'template' | 'file'>('template');
  const [templateFormData, setTemplateFormData] = useState<TemplateFormData>({
    name: '',
    description: '',
    rootPath: '',
    templateId: '',
    version: '',
    templatePath: '',
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
  const [availablePresets, setAvailablePresets] = useState<string[]>([]);
  const [selectedPreset, setSelectedPreset] = useState<string>('');
  const latestTemplatePathRef = useRef('');

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

  const handleOpenTemplateDialog = () => {
    resetTemplateForm();
    setShowTemplateDialog(true);
  };

  const handleTemplatePathChange = async (path: string) => {
    setTemplateFormData((prev) => ({ ...prev, rootPath: path }));

    const isAbsolute = path.startsWith('/') || /^[A-Z]:\\/.test(path);
    setTemplatePathValidation({ isAbsolute, exists: false, checked: false });

    if (isAbsolute && path.length > 1) {
      const validation = await validatePath(path);
      setTemplatePathValidation({ isAbsolute, exists: validation.exists, checked: true });
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
        const res = await fetch('/api/fs/stat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path }),
        });
        if (latestTemplatePathRef.current !== path) return;

        if (res.ok) {
          const stat = await res.json();
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

  const handleTemplateSubmit = (
    event: React.FormEvent,
    submitTemplate: (payload: CreateFromTemplatePayload) => void,
  ) => {
    event.preventDefault();

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
      submitTemplate({
        name: templateFormData.name,
        description: templateFormData.description,
        rootPath: templateFormData.rootPath,
        templatePath: templateFormData.templatePath,
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
    submitTemplate({
      name: templateFormData.name,
      description: templateFormData.description,
      rootPath: templateFormData.rootPath,
      templateId: templateFormData.templateId,
      version: templateFormData.version,
      ...(selectedPreset && { presetName: selectedPreset }),
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

  const handleTemplateChange = async (slug: string) => {
    const template = templates?.find((t) => t.slug === slug);
    const latestVersion = template?.latestVersion || '';

    setTemplateFormData((prev) => ({
      ...prev,
      templateId: slug,
      version: latestVersion,
    }));
    setSelectedPreset('');
    setAvailablePresets([]);

    if (template) {
      try {
        const templateUrl =
          template.source === 'registry' && latestVersion
            ? `/api/templates/${slug}/versions/${latestVersion}`
            : `/api/templates/${slug}`;
        const res = await fetch(templateUrl);
        if (res.ok) {
          const data = await res.json();
          if (data.content?.presets && Array.isArray(data.content.presets)) {
            const presetNames = data.content.presets.map((p: { name: string }) => p.name).reverse();
            setAvailablePresets(presetNames);
          }
        }
      } catch (error) {
        console.error('Failed to fetch template presets:', error);
      }
    }
  };

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
            const presetNames = data.content.presets.map((p: { name: string }) => p.name).reverse();
            setAvailablePresets(presetNames);
          } else {
            setAvailablePresets([]);
          }
          if (
            selectedPreset &&
            !data.content?.presets?.some((p: { name: string }) => p.name === selectedPreset)
          ) {
            setSelectedPreset('');
          }
        }
      } catch (error) {
        console.error('Failed to fetch template presets:', error);
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

  return {
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
  };
}
