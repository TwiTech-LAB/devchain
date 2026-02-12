import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useToast } from '../hooks/use-toast';
import { useSelectedProject } from '@/ui/hooks/useProjectSelection';
import { resolveSkillSlugs, type SkillSummary } from '@/ui/lib/skills';
import { useTerminalWindowManager } from '@/ui/terminal-windows';
import { Button } from '@/ui/components/ui/button';
import { Badge } from '@/ui/components/ui/badge';
import { Input } from '@/ui/components/ui/input';
import { Label } from '@/ui/components/ui/label';
import { Textarea } from '@/ui/components/ui/textarea';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  CardFooter,
} from '@/ui/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/components/ui/select';
import { Alert, AlertDescription, AlertTitle } from '@/ui/components/ui/alert';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/components/ui/popover';
import { SubEpicsBoard } from '@/ui/components/shared/SubEpicsBoard';
import { Breadcrumbs } from '@/ui/components/shared/Breadcrumbs';
import { CategoryBadge } from '@/ui/components/skills/CategoryBadge';
import { SkillDetailDrawer } from '@/ui/components/skills/SkillDetailDrawer';
import {
  Play,
  Square,
  Monitor,
  AlertCircle,
  XCircle,
  Bot,
  Loader2,
  MessageSquare,
  Trash2,
  FileText,
  Layers,
  Plus,
  Sparkles,
  User,
} from 'lucide-react';

// SessionFreeze: flip to true to re-enable the Launch Session UI on epic detail.
const EPIC_LAUNCH_ENABLED = false;

interface Status {
  id: string;
  projectId: string;
  label: string;
  color: string;
  position: number;
  createdAt: string;
  updatedAt: string;
}

interface Epic {
  id: string;
  projectId: string;
  title: string;
  description: string | null;
  statusId: string;
  version: number;
  parentId: string | null;
  agentId: string | null;
  tags: string[];
  skillsRequired: string[] | null;
  createdAt: string;
  updatedAt: string;
}

interface EpicComment {
  id: string;
  epicId: string;
  authorName: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

interface Agent {
  id: string;
  projectId: string;
  profileId: string;
  name: string;
  profile?: {
    name: string;
    providerId: string;
    provider?: {
      name: string;
    };
  };
  createdAt: string;
  updatedAt: string;
}

interface Session {
  id: string;
  epicId: string | null;
  agentId: string | null;
  tmuxSessionId: string | null;
  status: 'running' | 'stopped' | 'failed';
  startedAt: string;
  endedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface PreflightResult {
  success: boolean;
  errors?: Array<{
    code: string;
    message: string;
    remediation?: string;
  }>;
}

async function fetchEpic(id: string): Promise<Epic> {
  const res = await fetch(`/api/epics/${id}`);
  if (!res.ok) throw new Error('Failed to fetch epic');
  return res.json();
}

async function fetchStatuses(projectId: string): Promise<{ items: Status[] }> {
  const res = await fetch(`/api/statuses?projectId=${projectId}`);
  if (!res.ok) throw new Error('Failed to fetch statuses');
  return res.json();
}

async function fetchSubEpics(parentId: string): Promise<{ items: Epic[] }> {
  const res = await fetch(`/api/epics?parentId=${parentId}`);
  if (!res.ok) throw new Error('Failed to fetch sub-epics');
  return res.json();
}

async function fetchEpicComments(epicId: string): Promise<{ items: EpicComment[] }> {
  const res = await fetch(`/api/epics/${epicId}/comments`);
  if (!res.ok) throw new Error('Failed to fetch comments');
  return res.json();
}

async function fetchAgents(projectId: string): Promise<{ items: Agent[] }> {
  const res = await fetch(`/api/agents?projectId=${projectId}`);
  if (!res.ok) throw new Error('Failed to fetch agents');
  return res.json();
}

async function fetchActiveSessionsForProject(projectId?: string): Promise<Session[]> {
  const params = new URLSearchParams();
  if (projectId) {
    params.set('projectId', projectId);
  }
  const res = await fetch(`/api/sessions${params.size ? `?${params.toString()}` : ''}`);
  if (!res.ok) throw new Error('Failed to fetch sessions');
  return res.json();
}

async function checkPreflight(
  projectId: string,
  projectRootPath?: string,
): Promise<PreflightResult> {
  try {
    let rootPath = projectRootPath;
    if (!rootPath) {
      const projectRes = await fetch(`/api/projects/${projectId}`);
      if (!projectRes.ok) {
        return {
          success: false,
          errors: [
            {
              code: 'project_lookup_failed',
              message: 'Unable to resolve project information for preflight.',
            },
          ],
        };
      }
      const project = await projectRes.json();
      rootPath = project.rootPath;
    }

    if (typeof rootPath !== 'string' || rootPath.trim().length === 0) {
      return {
        success: false,
        errors: [
          {
            code: 'missing_project_path',
            message: 'Project root path is not configured. Please set it before running preflight.',
          },
        ],
      };
    }

    const res = await fetch(`/api/preflight?projectPath=${encodeURIComponent(rootPath)}`);
    if (!res.ok) {
      throw new Error('Preflight endpoint returned an error');
    }

    const data = await res.json();
    const errors: Array<{ code: string; message: string; remediation?: string }> = [];

    if (Array.isArray(data.checks)) {
      for (const check of data.checks) {
        if (check.status === 'fail') {
          errors.push({ code: check.name, message: check.message, remediation: check.details });
        }
      }
    }

    if (Array.isArray(data.providers)) {
      for (const provider of data.providers) {
        if (provider.status === 'fail') {
          errors.push({
            code: `provider:${provider.name}`,
            message: provider.message,
            remediation: provider.details,
          });
        }
        if (provider.binaryStatus === 'fail') {
          errors.push({
            code: `provider:${provider.name}:binary`,
            message: provider.binaryMessage,
            remediation: provider.binaryDetails,
          });
        }
        if (provider.mcpStatus === 'fail') {
          errors.push({
            code: `provider:${provider.name}:mcp`,
            message: provider.mcpMessage ?? 'MCP configuration failed',
            remediation: provider.mcpDetails,
          });
        }
      }
    }

    return {
      success: data.overall !== 'fail',
      errors: errors.length ? errors : undefined,
    };
  } catch (error) {
    return {
      success: false,
      errors: [
        {
          code: 'preflight_failed',
          message:
            error instanceof Error
              ? error.message
              : 'Preflight check failed. Please review provider configuration.',
        },
      ],
    };
  }
}

async function launchSession(epicId: string, agentId: string, projectId: string) {
  const res = await fetch('/api/sessions/launch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ epicId, agentId, projectId }),
  });
  if (!res.ok) {
    const error = await res.json();
    throw new Error(error.message || 'Failed to launch session');
  }
  return res.json();
}

async function terminateSession(sessionId: string) {
  const res = await fetch(`/api/sessions/${sessionId}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error('Failed to terminate session');
  return res.json();
}

async function updateEpicRequest(id: string, data: Partial<Epic>) {
  const res = await fetch(`/api/epics/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: 'Failed to update epic' }));
    throw new Error(error.message || 'Failed to update epic');
  }
  return res.json();
}

async function createEpicComment(epicId: string, data: { authorName: string; content: string }) {
  const res = await fetch(`/api/epics/${epicId}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: 'Failed to create comment' }));
    throw new Error(error.message || 'Failed to create comment');
  }
  return res.json();
}

async function deleteEpicComment(commentId: string) {
  const res = await fetch(`/api/comments/${commentId}`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: 'Failed to delete comment' }));
    throw new Error(error.message || 'Failed to delete comment');
  }
}

async function createSubEpic(data: {
  projectId: string;
  statusId: string;
  title: string;
  parentId: string;
}) {
  const res = await fetch('/api/epics', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: 'Failed to create sub-epic' }));
    throw new Error(error.message || 'Failed to create sub-epic');
  }
  return res.json();
}

async function deleteEpic(epicId: string) {
  const res = await fetch(`/api/epics/${epicId}`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: 'Failed to delete epic' }));
    throw new Error(error.message || 'Failed to delete epic');
  }
}

export function EpicDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { selectedProject } = useSelectedProject();
  const openTerminalWindow = useTerminalWindowManager();
  const queryClient = useQueryClient();

  const [selectedAgentId, setSelectedAgentId] = useState('');
  const [preflightResult, setPreflightResult] = useState<PreflightResult | null>(null);
  const [showPreflight, setShowPreflight] = useState(false);
  const [commentForm, setCommentForm] = useState({ authorName: 'User', content: '' });
  const [titleDraft, setTitleDraft] = useState('');
  const [titleEditing, setTitleEditing] = useState(false);
  const [descriptionDraft, setDescriptionDraft] = useState('');
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [addSubEpicOpen, setAddSubEpicOpen] = useState(false);
  const [addSubEpicForm, setAddSubEpicForm] = useState({ title: '', statusId: '' });
  const [searchParams] = useSearchParams();
  const editMode = searchParams.get('edit') === '1';
  const titleInputRef = useRef<HTMLInputElement>(null);
  const descriptionTextareaRef = useRef<HTMLTextAreaElement>(null);

  const { data: epic, isLoading: epicLoading } = useQuery({
    queryKey: ['epic', id],
    queryFn: () => fetchEpic(id!),
    enabled: !!id,
  });

  // Fetch parent epic for breadcrumb navigation (only when epic has a parent)
  const { data: parentEpic, isLoading: parentEpicLoading } = useQuery({
    queryKey: ['epic', epic?.parentId],
    queryFn: () => fetchEpic(epic!.parentId!),
    enabled: !!epic?.parentId,
  });

  // Build breadcrumb items for sub-epics (Board > Parent > Current)
  const breadcrumbItems = useMemo(() => {
    if (!epic?.parentId) return null;

    const parentLabel = parentEpicLoading
      ? 'Loading…'
      : (parentEpic?.title ?? epic.parentId.slice(0, 8));

    return [
      { label: 'Board', href: '/board' },
      { label: parentLabel, href: `/epics/${epic.parentId}` },
      { label: epic.title },
    ];
  }, [epic?.parentId, epic?.title, parentEpic?.title, parentEpicLoading]);

  const { data: agentsData } = useQuery({
    queryKey: ['agents', epic?.projectId],
    queryFn: () => fetchAgents(epic!.projectId),
    enabled: !!epic?.projectId,
  });

  const { data: sessions, refetch: refetchSessions } = useQuery({
    queryKey: ['sessions', selectedProject?.id ?? 'all'],
    queryFn: () => fetchActiveSessionsForProject(selectedProject?.id),
    refetchInterval: 5000,
  });

  const { data: statusesData } = useQuery({
    queryKey: ['statuses', epic?.projectId],
    queryFn: () => fetchStatuses(epic!.projectId),
    enabled: !!epic?.projectId,
  });

  // SubEpics data for SubEpicsBoard
  const { data: subEpicsData, isLoading: subEpicsLoading } = useQuery({
    queryKey: ['sub-epics', epic?.id],
    queryFn: () => fetchSubEpics(epic!.id),
    enabled: !!epic?.id,
  });
  const subEpicsRaw = subEpicsData?.items || [];

  const requiredSkillSlugs = useMemo(() => {
    const input = epic?.skillsRequired ?? [];
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const slug of input) {
      const normalized = slug.trim().toLowerCase();
      if (!normalized || seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);
      ordered.push(normalized);
    }
    return ordered;
  }, [epic?.skillsRequired]);

  const skillResolveKeySlugs = useMemo(
    () => [...requiredSkillSlugs].sort((left, right) => left.localeCompare(right)),
    [requiredSkillSlugs],
  );

  const {
    data: resolvedSkillsData,
    isLoading: skillsResolveLoading,
    isError: skillsResolveError,
  } = useQuery({
    queryKey: ['skills-resolve', skillResolveKeySlugs],
    queryFn: () => resolveSkillSlugs(skillResolveKeySlugs),
    enabled: skillResolveKeySlugs.length > 0,
  });
  const resolvedSkills: Record<string, SkillSummary> = resolvedSkillsData ?? {};

  const requiredSkills = useMemo(
    () =>
      requiredSkillSlugs.map((slug) => ({
        slug,
        skill: resolvedSkills[slug] ?? null,
      })),
    [requiredSkillSlugs, resolvedSkills],
  );

  const { data: commentsData, isLoading: commentsLoading } = useQuery({
    queryKey: ['epic-comments', epic?.id],
    queryFn: () => fetchEpicComments(epic!.id),
    enabled: !!epic?.id,
    refetchInterval: 30000,
  });

  useEffect(() => {
    if (epic?.projectId) {
      const rootPath =
        selectedProject?.id === epic.projectId ? selectedProject.rootPath : undefined;
      checkPreflight(epic.projectId, rootPath).then(setPreflightResult);
    }
  }, [epic?.projectId, selectedProject?.id, selectedProject?.rootPath]);

  useEffect(() => {
    if (epic) {
      setSelectedAgentId(epic.agentId ?? '');
    }
  }, [epic?.agentId]);

  useEffect(() => {
    if (epic) {
      setTitleDraft(epic.title);
      setDescriptionDraft(epic.description ?? '');
    }
  }, [epic?.title, epic?.description]);

  useEffect(() => {
    if (editMode) {
      setTitleEditing(true);
    }
  }, [editMode]);

  useEffect(() => {
    if (titleEditing && titleInputRef.current) {
      titleInputRef.current.focus();
      titleInputRef.current.select();
    }
  }, [titleEditing]);

  // Auto-resize description textarea to fit content
  useEffect(() => {
    const textarea = descriptionTextareaRef.current;
    if (textarea) {
      // Reset height to auto to get the correct scrollHeight
      textarea.style.height = 'auto';
      // Set the height to match the content
      textarea.style.height = `${textarea.scrollHeight}px`;
    }
  }, [descriptionDraft]);

  const launchMutation = useMutation({
    mutationFn: ({
      epicId,
      agentId,
      projectId,
    }: {
      epicId: string;
      agentId: string;
      projectId: string;
    }) => launchSession(epicId, agentId, projectId),
    onSuccess: (data) => {
      toast({
        title: 'Session launched',
        description: 'Session started successfully.',
      });
      const launchedSession: Session = {
        id: data.id,
        epicId: data.epicId ?? null,
        agentId: data.agentId,
        tmuxSessionId: data.tmuxSessionId,
        status: data.status,
        startedAt: data.startedAt,
        endedAt: data.endedAt ?? null,
        createdAt: data.createdAt,
        updatedAt: data.updatedAt,
      };
      openTerminalWindow(launchedSession);
      refetchSessions();
      setShowPreflight(false);
    },
    onError: (error: Error) => {
      toast({
        title: 'Launch failed',
        description: error.message,
        variant: 'destructive',
      });
    },
  });

  const terminateMutation = useMutation({
    mutationFn: terminateSession,
    onSuccess: () => {
      toast({
        title: 'Session terminated',
        description: 'Session stopped successfully.',
      });
      refetchSessions();
    },
    onError: (error: Error) => {
      toast({
        title: 'Termination failed',
        description: error.message,
        variant: 'destructive',
      });
    },
  });

  const updateEpicMutation = useMutation({
    mutationFn: (data: Partial<Epic>) => updateEpicRequest(id!, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['epic', id] });
      queryClient.invalidateQueries({ queryKey: ['epics'] });
      toast({
        title: 'Epic updated',
        description: 'Changes saved successfully.',
      });
    },
    onError: (error: Error) => {
      toast({
        title: 'Update failed',
        description: error.message,
        variant: 'destructive',
      });
    },
  });

  const commentMutation = useMutation({
    mutationFn: (data: { authorName: string; content: string }) => createEpicComment(id!, data),
    onSuccess: () => {
      setCommentForm({ authorName: 'User', content: '' });
      queryClient.invalidateQueries({ queryKey: ['epic-comments', id] });
    },
    onError: (error: Error) => {
      toast({
        title: 'Comment failed',
        description: error.message,
        variant: 'destructive',
      });
    },
  });

  const deleteCommentMutation = useMutation({
    mutationFn: (commentId: string) => deleteEpicComment(commentId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['epic-comments', id] });
    },
    onError: (error: Error) => {
      toast({
        title: 'Delete failed',
        description: error.message,
        variant: 'destructive',
      });
    },
  });

  const createSubEpicMutation = useMutation({
    mutationFn: (data: { title: string; statusId: string }) =>
      createSubEpic({
        projectId: epic!.projectId,
        parentId: epic!.id,
        ...data,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sub-epics', epic?.id] });
      queryClient.invalidateQueries({ queryKey: ['epics'] });
      toast({
        title: 'Sub-epic created',
        description: 'The sub-epic was added successfully.',
      });
    },
    onError: (error: Error) => {
      toast({
        title: 'Creation failed',
        description: error.message,
        variant: 'destructive',
      });
    },
  });

  const deleteSubEpicMutation = useMutation({
    mutationFn: (subEpicId: string) => deleteEpic(subEpicId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sub-epics', epic?.id] });
      queryClient.invalidateQueries({ queryKey: ['epics'] });
      toast({
        title: 'Sub-epic deleted',
        description: 'The sub-epic was removed.',
      });
    },
    onError: (error: Error) => {
      toast({
        title: 'Delete failed',
        description: error.message,
        variant: 'destructive',
      });
    },
  });

  const updateSubEpicMutation = useMutation({
    mutationFn: ({ subEpicId, agentId }: { subEpicId: string; agentId: string | null }) => {
      const subEpic = subEpicsRaw.find((s) => s.id === subEpicId);
      if (!subEpic) throw new Error('Sub-epic not found');
      return updateEpicRequest(subEpicId, { agentId, version: subEpic.version });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sub-epics', epic?.id] });
      queryClient.invalidateQueries({ queryKey: ['epics'] });
    },
    onError: (error: Error) => {
      toast({
        title: 'Assignment failed',
        description: error.message,
        variant: 'destructive',
      });
    },
  });

  const deleteThisEpicMutation = useMutation({
    mutationFn: () => deleteEpic(id!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['epics'] });
      toast({
        title: 'Epic deleted',
        description: 'The epic has been removed.',
      });
      navigate('/board');
    },
    onError: (error: Error) => {
      toast({
        title: 'Delete failed',
        description: error.message,
        variant: 'destructive',
      });
    },
  });

  const agents = agentsData?.items || [];
  const statuses = statusesData?.items || [];

  // Map subEpics to include agentId and agentName for display and assignment
  const subEpics = useMemo(
    () =>
      subEpicsRaw.map((subEpic) => ({
        id: subEpic.id,
        title: subEpic.title,
        statusId: subEpic.statusId,
        description: subEpic.description,
        agentId: subEpic.agentId,
        agentName: subEpic.agentId
          ? (agents.find((a) => a.id === subEpic.agentId)?.name ?? null)
          : null,
      })),
    [subEpicsRaw, agents],
  );

  const sortedStatuses = useMemo(
    () => [...statuses].sort((a, b) => a.position - b.position),
    [statuses],
  );
  const currentStatus = epic
    ? (sortedStatuses.find((status) => status.id === epic.statusId) ?? null)
    : null;
  const epicSessions =
    id && sessions
      ? sessions.filter((session) => session.epicId === id && session.status === 'running')
      : [];
  const comments = useMemo(() => {
    const items = commentsData?.items || [];
    return items
      .slice()
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  }, [commentsData?.items]);
  const isCommentFormValid = commentForm.content.trim().length > 0;

  if (!id) {
    return (
      <div className="flex items-center justify-center py-16">
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>Epic ID not provided</AlertDescription>
        </Alert>
      </div>
    );
  }

  if (epicLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        <span className="ml-2 text-muted-foreground">Loading epic...</span>
      </div>
    );
  }

  if (!epic) {
    return (
      <div className="flex items-center justify-center py-16">
        <Alert variant="destructive">
          <XCircle className="h-4 w-4" />
          <AlertTitle>Not Found</AlertTitle>
          <AlertDescription>Epic not found</AlertDescription>
        </Alert>
      </div>
    );
  }

  const runPreflightCheck = async (): Promise<boolean> => {
    setShowPreflight(false);
    const rootPath = selectedProject?.id === epic.projectId ? selectedProject.rootPath : undefined;
    const result = await checkPreflight(epic.projectId, rootPath);
    setPreflightResult(result);
    if (!result.success) {
      setShowPreflight(true);
      return false;
    }
    return true;
  };

  const handleLaunchSession = async () => {
    if (!selectedAgentId) {
      toast({
        title: 'No agent selected',
        description: 'Please select an agent before launching',
        variant: 'destructive',
      });
      return;
    }

    if (!preflightResult || !preflightResult.success) {
      const ok = await runPreflightCheck();
      if (!ok) {
        return;
      }
    }

    launchMutation.mutate({ epicId: id, agentId: selectedAgentId, projectId: epic.projectId });
  };

  const handleStatusChange = (value: string) => {
    if (!epic || value === epic.statusId) {
      return;
    }
    updateEpicMutation.mutate({ statusId: value, version: epic.version });
  };

  const handleAgentChange = (value: string) => {
    if (!epic) {
      return;
    }
    const normalized = value === 'none' ? null : value;
    setSelectedAgentId(normalized ?? '');
    if (normalized === (epic.agentId ?? null)) {
      return;
    }
    updateEpicMutation.mutate({ agentId: normalized, version: epic.version });
  };

  const handleCommentChange = (field: 'authorName' | 'content', value: string) => {
    setCommentForm((form) => ({ ...form, [field]: value }));
  };

  const handleCommentSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const authorName = commentForm.authorName.trim() || 'User';
    const content = commentForm.content.trim();
    if (!content) {
      return;
    }
    commentMutation.mutate({ authorName, content });
  };

  const commitTitle = () => {
    const trimmed = titleDraft.trim();
    if (!trimmed) {
      toast({
        title: 'Title required',
        description: 'Epic title cannot be empty.',
        variant: 'destructive',
      });
      setTitleDraft(epic.title);
      setTitleEditing(false);
      return;
    }
    setTitleEditing(false);
    if (trimmed === epic.title) {
      return;
    }
    updateEpicMutation.mutate({ title: trimmed, version: epic.version });
  };

  const cancelTitleEdit = () => {
    setTitleDraft(epic.title);
    setTitleEditing(false);
  };

  const handleSaveDescription = () => {
    const trimmed = descriptionDraft.trim();
    if (trimmed === (epic.description ?? '')) {
      return;
    }
    updateEpicMutation.mutate({ description: trimmed || null, version: epic.version });
  };

  const handleAddSubEpicSubmit = () => {
    const title = addSubEpicForm.title.trim();
    const statusId = addSubEpicForm.statusId;
    if (!title || !statusId) return;
    createSubEpicMutation.mutate(
      { title, statusId },
      {
        onSuccess: () => {
          setAddSubEpicOpen(false);
          setAddSubEpicForm({ title: '', statusId: '' });
        },
      },
    );
  };

  const formatDate = (value: string) => new Date(value).toLocaleString();

  return (
    <div className="space-y-8">
      {/* Unified Header: Title above Controls */}
      <div className="space-y-2">
        {/* Breadcrumb navigation for sub-epics */}
        {breadcrumbItems && <Breadcrumbs items={breadcrumbItems} />}
        {/* Title Row - prominent, editable */}
        <div className="flex items-center gap-3">
          {titleEditing ? (
            <Input
              ref={titleInputRef}
              value={titleDraft}
              onChange={(event) => setTitleDraft(event.target.value)}
              onBlur={commitTitle}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  commitTitle();
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  cancelTitleEdit();
                }
              }}
              className="text-3xl font-bold flex-1 min-w-0 border-2 border-primary bg-muted/50"
            />
          ) : (
            <button
              type="button"
              onClick={() => setTitleEditing(true)}
              className="text-left text-3xl font-bold focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 hover:text-muted-foreground transition-colors"
            >
              {epic.title}
            </button>
          )}
          {updateEpicMutation.isPending && !titleEditing && (
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          )}
        </div>

        {/* Controls Row - Status, Agent, Tags */}
        <div className="flex flex-wrap items-end gap-3">
          {/* Status Badge - clickable to open status dropdown */}
          {currentStatus && sortedStatuses.length > 0 ? (
            <Select value={epic.statusId} onValueChange={handleStatusChange}>
              <SelectTrigger className="h-auto w-auto border-0 p-0 shadow-none focus:ring-0 focus:ring-offset-0 [&>svg]:hidden">
                <Badge
                  style={{ backgroundColor: currentStatus.color }}
                  className="text-sm font-medium text-white cursor-pointer hover:opacity-80 transition-opacity"
                >
                  {currentStatus.label}
                </Badge>
              </SelectTrigger>
              <SelectContent>
                {sortedStatuses.map((status) => (
                  <SelectItem key={status.id} value={status.id}>
                    {status.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : currentStatus ? (
            <Badge
              style={{ backgroundColor: currentStatus.color }}
              className="text-sm font-medium text-white"
            >
              {currentStatus.label}
            </Badge>
          ) : null}

          {/* Agent Assignment - inline dropdown */}
          {agents.length > 0 && (
            <Select value={epic.agentId ?? 'none'} onValueChange={handleAgentChange}>
              <SelectTrigger className="h-auto w-auto border-0 p-0 shadow-none focus:ring-0 focus:ring-offset-0 [&>svg:last-child]:hidden">
                <span className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors cursor-pointer">
                  <User className="h-4 w-4" />
                  <span>
                    {epic.agentId ? agents.find((a) => a.id === epic.agentId)?.name : 'Unassigned'}
                  </span>
                </span>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Unassigned</SelectItem>
                {agents.map((agent) => (
                  <SelectItem key={agent.id} value={agent.id}>
                    {agent.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          {/* Tags */}
          {epic.tags.length > 0 &&
            epic.tags.map((tag) => (
              <Badge key={tag} variant="outline" className="text-xs">
                {tag}
              </Badge>
            ))}
        </div>
      </div>

      {EPIC_LAUNCH_ENABLED && showPreflight && preflightResult && !preflightResult.success && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Preflight Check Failed</AlertTitle>
          <AlertDescription>
            <div className="mt-2 space-y-2">
              {preflightResult.errors?.map((error, idx) => (
                <div key={idx} className="text-sm">
                  <strong>{error.code}:</strong> {error.message}
                  {error.remediation && (
                    <div className="mt-1 text-xs text-muted-foreground">→ {error.remediation}</div>
                  )}
                </div>
              ))}
              {!preflightResult.errors?.length && (
                <div className="text-sm text-muted-foreground">
                  All checks passed recently, but the session could not be launched. Try rerunning
                  preflight or review agent/provider settings.
                </div>
              )}
            </div>
            <Button
              variant="outline"
              size="sm"
              className="mt-4"
              onClick={() => navigate('/settings')}
            >
              Go to Settings
            </Button>
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-8 lg:grid-cols-[minmax(0,2fr)_minmax(260px,1fr)]">
        <div className="space-y-8">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <FileText className="h-5 w-5" />
                Description
              </CardTitle>
              <CardDescription>Describe what this epic is about.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Textarea
                  ref={descriptionTextareaRef}
                  id="epic-description"
                  value={descriptionDraft}
                  onChange={(event) => setDescriptionDraft(event.target.value)}
                  placeholder="Add a description"
                  className="min-h-[200px] resize-none overflow-hidden"
                />
                <div className="flex justify-end">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleSaveDescription}
                    disabled={
                      descriptionDraft.trim() === (epic.description ?? '') ||
                      updateEpicMutation.isPending
                    }
                  >
                    {updateEpicMutation.isPending && (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    )}
                    Save Description
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <MessageSquare className="h-5 w-5" />
                Comments
              </CardTitle>
              <CardDescription>Share updates and decisions about this epic.</CardDescription>
            </CardHeader>
            <CardContent>
              {commentsLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : comments.length === 0 ? (
                <div className="text-center py-6">
                  <MessageSquare className="h-8 w-8 mx-auto text-muted-foreground/50 mb-2" />
                  <p className="text-sm text-muted-foreground">No comments yet.</p>
                  <p className="text-xs text-muted-foreground/70 mt-1">
                    Add a comment below to share progress or decisions.
                  </p>
                </div>
              ) : (
                <div className="space-y-4">
                  {comments.map((comment) => (
                    <div key={comment.id} className="rounded-lg border bg-muted/30 p-4">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <div className="flex items-center gap-2">
                            <Badge variant="outline">{comment.authorName}</Badge>
                            <span className="text-xs text-muted-foreground">
                              {new Date(comment.createdAt).toLocaleString()}
                            </span>
                          </div>
                          <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed">
                            {comment.content}
                          </p>
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => deleteCommentMutation.mutate(comment.id)}
                          disabled={deleteCommentMutation.isPending}
                          aria-label="Delete comment"
                        >
                          <Trash2 className="h-4 w-4 text-muted-foreground" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
            <CardFooter>
              <form className="w-full space-y-4" onSubmit={handleCommentSubmit}>
                <Textarea
                  id="comment-content"
                  value={commentForm.content}
                  onChange={(event) => handleCommentChange('content', event.target.value)}
                  placeholder="Share progress, blockers, or decisions"
                  rows={3}
                />
                <div className="flex justify-end">
                  <Button type="submit" disabled={!isCommentFormValid || commentMutation.isPending}>
                    {commentMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                    Post Comment
                  </Button>
                </div>
              </form>
            </CardFooter>
          </Card>
        </div>

        <aside className="space-y-8">
          {epicSessions.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Monitor className="h-5 w-5" />
                  Active Sessions ({epicSessions.length})
                </CardTitle>
                <CardDescription>Currently running sessions for this epic.</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {epicSessions.map((session) => {
                    const agent = agents.find((a) => a.id === session.agentId);
                    return (
                      <div key={session.id} className="rounded-lg border bg-muted/30 p-3 text-sm">
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <Badge variant="default" className="font-mono">
                              {session.id.substring(0, 8)}
                            </Badge>
                            <Badge variant="outline">{session.status}</Badge>
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {new Date(session.startedAt).toLocaleString()}
                          </div>
                        </div>
                        <div className="mt-2 flex items-center justify-between gap-2">
                          <span className="text-xs text-muted-foreground">
                            Agent: {agent?.name ?? 'Unknown'}
                          </span>
                          <div className="flex gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => openTerminalWindow(session)}
                            >
                              <Monitor className="h-4 w-4 mr-2" />
                              Open
                            </Button>
                            <Button
                              variant="destructive"
                              size="sm"
                              onClick={() => terminateMutation.mutate(session.id)}
                              disabled={terminateMutation.isPending}
                            >
                              {terminateMutation.isPending ? (
                                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                              ) : (
                                <Square className="h-4 w-4 mr-2" />
                              )}
                              Stop
                            </Button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          )}

          {EPIC_LAUNCH_ENABLED && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Play className="h-5 w-5" />
                  Launch Agent Session
                </CardTitle>
                <CardDescription>Select an agent to start a new terminal session.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {agents.length === 0 ? (
                  <Alert>
                    <AlertCircle className="h-4 w-4" />
                    <AlertTitle>No Agents</AlertTitle>
                    <AlertDescription>
                      No agents configured for this project{' '}
                      <Button
                        variant="link"
                        className="p-0 h-auto"
                        onClick={() => navigate('/agents')}
                      >
                        Create an agent
                      </Button>
                    </AlertDescription>
                  </Alert>
                ) : (
                  <>
                    <div className="space-y-2">
                      <Label htmlFor="session-agent">Select Agent</Label>
                      <Select
                        value={selectedAgentId || 'none'}
                        onValueChange={(value) => setSelectedAgentId(value === 'none' ? '' : value)}
                      >
                        <SelectTrigger id="session-agent">
                          <SelectValue placeholder="Choose an agent" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">Select an agent</SelectItem>
                          {agents.map((agent) => (
                            <SelectItem key={agent.id} value={agent.id}>
                              <div className="flex items-center gap-2">
                                <Bot className="h-4 w-4" />
                                {agent.name}
                                {agent.profile?.provider && (
                                  <Badge variant="outline" className="ml-2">
                                    {agent.profile.provider.name}
                                  </Badge>
                                )}
                              </div>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <Button
                      className="w-full"
                      onClick={handleLaunchSession}
                      disabled={!selectedAgentId || launchMutation.isPending}
                    >
                      {launchMutation.isPending && (
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      )}
                      <Play className="h-4 w-4 mr-2" />
                      Launch Session
                    </Button>
                  </>
                )}
              </CardContent>
              <CardFooter className="flex flex-col gap-2">
                <Button
                  className="w-full"
                  variant="outline"
                  onClick={() => setShowPreflight((current) => !current)}
                  disabled={preflightResult?.success}
                >
                  {showPreflight ? 'Hide Preflight' : 'Run Preflight'}
                </Button>
              </CardFooter>
            </Card>
          )}

          {/* Sub-Epics Board - only show for parent epics */}
          {!epic.parentId && (
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="flex items-center gap-2">
                    <Layers className="h-5 w-5" />
                    Sub-epics ({subEpics.length})
                  </CardTitle>
                  {sortedStatuses.length > 0 && (
                    <Popover open={addSubEpicOpen} onOpenChange={setAddSubEpicOpen}>
                      <PopoverTrigger asChild>
                        <Button variant="outline" size="sm" className="h-8">
                          <Plus className="h-4 w-4 mr-1" />
                          Add
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent align="end" className="w-80">
                        <div className="space-y-4">
                          <div className="space-y-2">
                            <h4 className="font-medium text-sm">Add Sub-epic</h4>
                            <p className="text-xs text-muted-foreground">
                              Create a new child work item for this epic.
                            </p>
                          </div>
                          <div className="space-y-3">
                            <div className="space-y-2">
                              <Label htmlFor="sub-epic-title">Title</Label>
                              <Input
                                id="sub-epic-title"
                                placeholder="Enter title..."
                                value={addSubEpicForm.title}
                                onChange={(e) =>
                                  setAddSubEpicForm((f) => ({ ...f, title: e.target.value }))
                                }
                                onKeyDown={(e) => {
                                  if (
                                    e.key === 'Enter' &&
                                    addSubEpicForm.title &&
                                    addSubEpicForm.statusId
                                  ) {
                                    e.preventDefault();
                                    handleAddSubEpicSubmit();
                                  }
                                }}
                              />
                            </div>
                            <div className="space-y-2">
                              <Label htmlFor="sub-epic-status">Status</Label>
                              <Select
                                value={addSubEpicForm.statusId}
                                onValueChange={(value) =>
                                  setAddSubEpicForm((f) => ({ ...f, statusId: value }))
                                }
                              >
                                <SelectTrigger id="sub-epic-status">
                                  <SelectValue placeholder="Select status..." />
                                </SelectTrigger>
                                <SelectContent>
                                  {sortedStatuses.map((status) => (
                                    <SelectItem key={status.id} value={status.id}>
                                      <span className="flex items-center gap-2">
                                        <span
                                          className="h-2 w-2 rounded-full"
                                          style={{ backgroundColor: status.color }}
                                        />
                                        {status.label}
                                      </span>
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </div>
                          </div>
                          <div className="flex justify-end gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => {
                                setAddSubEpicOpen(false);
                                setAddSubEpicForm({ title: '', statusId: '' });
                              }}
                            >
                              Cancel
                            </Button>
                            <Button
                              size="sm"
                              onClick={handleAddSubEpicSubmit}
                              disabled={
                                !addSubEpicForm.title.trim() ||
                                !addSubEpicForm.statusId ||
                                createSubEpicMutation.isPending
                              }
                            >
                              {createSubEpicMutation.isPending && (
                                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                              )}
                              Add
                            </Button>
                          </div>
                        </div>
                      </PopoverContent>
                    </Popover>
                  )}
                </div>
                <CardDescription>Child work items for this epic.</CardDescription>
              </CardHeader>
              <CardContent>
                {subEpicsLoading ? (
                  <div className="flex items-center justify-center py-4">
                    <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                  </div>
                ) : sortedStatuses.length === 0 ? (
                  <div className="text-center py-6">
                    <Layers className="h-8 w-8 mx-auto text-muted-foreground/50 mb-2" />
                    <p className="text-sm text-muted-foreground">No statuses configured.</p>
                    <p className="text-xs text-muted-foreground/70 mt-1">
                      Add statuses in Settings to create and track sub-epics.
                    </p>
                  </div>
                ) : (
                  <SubEpicsBoard
                    subEpics={subEpics}
                    statuses={sortedStatuses}
                    agents={agents}
                    onSubEpicClick={(subEpicId) => navigate(`/epics/${subEpicId}`)}
                    onDeleteSubEpic={(subEpicId) => {
                      if (window.confirm('Are you sure you want to delete this sub-epic?')) {
                        deleteSubEpicMutation.mutate(subEpicId);
                      }
                    }}
                    onAssignAgent={(subEpicId, agentId) => {
                      updateSubEpicMutation.mutate({ subEpicId, agentId });
                    }}
                  />
                )}
              </CardContent>
            </Card>
          )}

          {requiredSkillSlugs.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Sparkles className="h-5 w-5" />
                  Required Skills ({requiredSkillSlugs.length})
                </CardTitle>
                <CardDescription>Skills attached to this epic.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                {skillsResolveLoading ? (
                  <div className="flex items-center justify-center py-4">
                    <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                  </div>
                ) : skillsResolveError ? (
                  <p className="text-sm text-destructive">
                    Failed to resolve skills. Showing slug references only.
                  </p>
                ) : null}

                <div className="space-y-2">
                  {requiredSkills.map(({ slug, skill }) => {
                    const resolvedSkill = skill;
                    const skillFound = Boolean(resolvedSkill && resolvedSkill.id);
                    const displayName =
                      resolvedSkill?.displayName?.trim() || resolvedSkill?.name?.trim() || slug;

                    return (
                      <button
                        key={slug}
                        type="button"
                        disabled={!skillFound}
                        onClick={() => {
                          if (resolvedSkill?.id) {
                            setSelectedSkillId(resolvedSkill.id);
                          }
                        }}
                        className={`w-full rounded-lg border p-3 text-left transition-colors ${
                          skillFound
                            ? 'hover:bg-muted/40 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2'
                            : 'cursor-not-allowed opacity-80'
                        }`}
                      >
                        <div className="space-y-2">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <p className="truncate text-sm font-medium">{displayName}</p>
                              <p className="truncate text-xs text-muted-foreground">{slug}</p>
                            </div>
                            <Badge variant="outline">
                              {resolvedSkill?.source ?? 'Unknown source'}
                            </Badge>
                          </div>

                          <div className="flex flex-wrap items-center gap-2">
                            {skillFound ? (
                              <CategoryBadge category={resolvedSkill?.category ?? null} />
                            ) : (
                              <Badge variant="outline" className="text-muted-foreground">
                                Skill not found
                              </Badge>
                            )}
                            {skillFound ? null : (
                              <span className="text-xs text-muted-foreground">Skill not found</span>
                            )}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Metadata</CardTitle>
              <CardDescription>Key timeline events.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-sm text-muted-foreground">
              <div className="flex items-center justify-between gap-2">
                <span>Created</span>
                <span className="font-medium text-foreground">{formatDate(epic.createdAt)}</span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span>Last Updated</span>
                <span className="font-medium text-foreground">{formatDate(epic.updatedAt)}</span>
              </div>
            </CardContent>
            <CardFooter>
              <Button
                variant="ghost"
                size="sm"
                className="w-full text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                onClick={() => {
                  if (
                    window.confirm(
                      'Are you sure you want to delete this epic? This cannot be undone.',
                    )
                  ) {
                    deleteThisEpicMutation.mutate();
                  }
                }}
                disabled={deleteThisEpicMutation.isPending}
              >
                {deleteThisEpicMutation.isPending ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Trash2 className="h-4 w-4 mr-2" />
                )}
                Delete Epic
              </Button>
            </CardFooter>
          </Card>
        </aside>
      </div>
      <SkillDetailDrawer skillId={selectedSkillId} onClose={() => setSelectedSkillId(null)} />
    </div>
  );
}
