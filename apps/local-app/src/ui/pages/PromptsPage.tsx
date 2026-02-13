import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/ui/components/ui/button';
import { Input } from '@/ui/components/ui/input';
import { Label } from '@/ui/components/ui/label';
import { Textarea } from '@/ui/components/ui/textarea';
import { Badge } from '@/ui/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/ui/components/ui/dialog';
import { useToast } from '@/ui/hooks/use-toast';
import { X, Plus, Tag as TagIcon } from 'lucide-react';
import { useSelectedProject } from '@/ui/hooks/useProjectSelection';

interface PromptSummary {
  id: string;
  projectId: string | null;
  title: string;
  contentPreview: string;
  version: number;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

interface PromptDetail extends PromptSummary {
  content: string;
}

interface PromptsQueryData {
  items: PromptSummary[];
  total?: number;
  limit?: number;
  offset?: number;
}

const PROMPT_VARIABLES = [
  { token: '{agent_name}', description: 'Current agent name' },
  { token: '{project_name}', description: 'Selected project name' },
  { token: '{epic_title}', description: 'Epic title (empty when no epic)' },
  { token: '{provider_name}', description: 'Provider name (e.g., claude, codex)' },
  { token: '{profile_name}', description: 'Agent profile name' },
  { token: '{session_id}', description: 'Session UUID at launch' },
  { token: '{session_id_short}', description: '8-char session ID prefix for MCP tools' },
];

async function fetchPrompts(projectId: string) {
  const res = await fetch(`/api/prompts?projectId=${encodeURIComponent(projectId)}`);
  if (!res.ok) throw new Error('Failed to fetch prompts');
  return res.json();
}

async function createPrompt(data: {
  projectId: string;
  title: string;
  content: string;
  tags?: string[];
}) {
  const res = await fetch('/api/prompts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error('Failed to create prompt');
  return res.json();
}

async function updatePrompt(id: string, data: Partial<PromptDetail>) {
  const res = await fetch(`/api/prompts/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error('Failed to update prompt');
  return res.json();
}

async function deletePrompt(id: string) {
  const res = await fetch(`/api/prompts/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error('Failed to delete prompt');
}

// Markdown Preview Component
function MarkdownPreview({ content }: { content: string }) {
  // Simple markdown-like rendering
  const renderContent = (text: string) => {
    const lines = text.split('\n');
    return lines.map((line, idx) => {
      if (line.startsWith('# ')) {
        return (
          <h1 key={idx} className="text-2xl font-bold mb-2">
            {line.substring(2)}
          </h1>
        );
      }
      if (line.startsWith('## ')) {
        return (
          <h2 key={idx} className="text-xl font-semibold mb-2">
            {line.substring(3)}
          </h2>
        );
      }
      if (line.startsWith('### ')) {
        return (
          <h3 key={idx} className="text-lg font-semibold mb-1">
            {line.substring(4)}
          </h3>
        );
      }
      if (line.startsWith('- ')) {
        return (
          <li key={idx} className="ml-4">
            {line.substring(2)}
          </li>
        );
      }
      if (line.trim() === '') {
        return <div key={idx} className="h-2" />;
      }
      return (
        <p key={idx} className="mb-2">
          {line}
        </p>
      );
    });
  };

  return (
    <div className="prose prose-sm max-w-none dark:prose-invert">{renderContent(content)}</div>
  );
}

// Tag Input Component with Autocomplete
function TagInput({
  tags,
  suggestions,
  onAddTag,
  onRemoveTag,
  onInputChange,
}: {
  tags: string[];
  suggestions: string[];
  onAddTag: (tag: string) => void;
  onRemoveTag: (tag: string) => void;
  onInputChange?: (value: string) => void;
}) {
  const [input, setInput] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);

  const filteredSuggestions = useMemo(() => {
    if (!input) return [];
    return suggestions
      .filter((s) => s.toLowerCase().includes(input.toLowerCase()) && !tags.includes(s))
      .slice(0, 5);
  }, [input, suggestions, tags]);

  const handleAddTag = (tag: string) => {
    const trimmed = tag.trim();
    if (trimmed && !tags.includes(trimmed)) {
      onAddTag(trimmed);
      setInput('');
      setShowSuggestions(false);
      onInputChange?.('');
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      handleAddTag(input);
    } else if (e.key === 'Backspace' && !input && tags.length > 0) {
      onRemoveTag(tags[tags.length - 1]);
    }
  };

  const handleInputChange = (value: string) => {
    setInput(value);
    onInputChange?.(value);
  };

  return (
    <div className="relative">
      <div className="flex flex-wrap gap-2 p-2 border rounded-md min-h-[42px] items-center bg-background">
        {tags.map((tag) => (
          <Badge key={tag} variant="secondary" className="gap-1">
            <TagIcon className="h-3 w-3" />
            {tag}
            <button
              type="button"
              onClick={() => onRemoveTag(tag)}
              className="ml-1 hover:bg-muted rounded-full"
            >
              <X className="h-3 w-3" />
            </button>
          </Badge>
        ))}
        <input
          type="text"
          value={input}
          onChange={(e) => {
            handleInputChange(e.target.value);
            setShowSuggestions(true);
          }}
          onKeyDown={handleKeyDown}
          onFocus={() => setShowSuggestions(true)}
          onBlur={() => setTimeout(() => setShowSuggestions(false), 200)}
          placeholder={tags.length === 0 ? 'Add tags (label or key:value)...' : ''}
          className="flex-1 min-w-[120px] outline-none bg-transparent"
        />
      </div>
      {showSuggestions && filteredSuggestions.length > 0 && (
        <div className="absolute z-10 w-full mt-1 bg-popover border rounded-md shadow-lg">
          {filteredSuggestions.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              onClick={() => handleAddTag(suggestion)}
              className="w-full px-3 py-2 text-left hover:bg-muted transition-colors"
            >
              {suggestion}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function PromptsPage() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { selectedProjectId } = useSelectedProject();
  const [showDialog, setShowDialog] = useState(false);
  const [editingPrompt, setEditingPrompt] = useState<PromptDetail | null>(null);
  const [formData, setFormData] = useState({ title: '', content: '', tags: [] as string[] });
  const [filterTag, setFilterTag] = useState('');
  const [showPreview, setShowPreview] = useState(false);
  const [pendingTagInput, setPendingTagInput] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['prompts', selectedProjectId],
    queryFn: () => fetchPrompts(selectedProjectId as string),
    enabled: !!selectedProjectId,
  });

  const createMutation = useMutation({
    mutationFn: createPrompt,
    onMutate: async (newPrompt) => {
      // Optimistic update
      await queryClient.cancelQueries({ queryKey: ['prompts', selectedProjectId] });
      const previousData = queryClient.getQueryData(['prompts', selectedProjectId]);

      queryClient.setQueryData(
        ['prompts', selectedProjectId],
        (old: PromptsQueryData | undefined) => ({
          ...old,
          items: [
            {
              id: 'temp-' + Date.now(),
              ...newPrompt,
              version: 1,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
            ...(old?.items || []),
          ],
        }),
      );

      return { previousData };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['prompts', selectedProjectId] });
      setShowDialog(false);
      resetForm();
      toast({
        title: 'Success',
        description: 'Prompt created successfully',
      });
    },
    onError: (error, variables, context) => {
      if (context?.previousData) {
        queryClient.setQueryData(['prompts', selectedProjectId], context.previousData);
      }
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to create prompt',
        variant: 'destructive',
      });
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<PromptDetail> }) =>
      updatePrompt(id, data),
    onMutate: async ({ id, data }) => {
      await queryClient.cancelQueries({ queryKey: ['prompts', selectedProjectId] });
      const previousData = queryClient.getQueryData(['prompts', selectedProjectId]);

      queryClient.setQueryData(
        ['prompts', selectedProjectId],
        (old: PromptsQueryData | undefined) => ({
          ...old,
          items: old?.items.map((p: PromptSummary) =>
            p.id === id ? { ...p, ...data, updatedAt: new Date().toISOString() } : p,
          ),
        }),
      );

      return { previousData };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['prompts', selectedProjectId] });
      setShowDialog(false);
      setEditingPrompt(null);
      resetForm();
      toast({
        title: 'Success',
        description: 'Prompt updated successfully',
      });
    },
    onError: (error, variables, context) => {
      if (context?.previousData) {
        queryClient.setQueryData(['prompts', selectedProjectId], context.previousData);
      }
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to update prompt',
        variant: 'destructive',
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: deletePrompt,
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: ['prompts', selectedProjectId] });
      const previousData = queryClient.getQueryData(['prompts', selectedProjectId]);

      queryClient.setQueryData(
        ['prompts', selectedProjectId],
        (old: PromptsQueryData | undefined) => ({
          ...old,
          items: old?.items.filter((p: PromptSummary) => p.id !== id),
        }),
      );

      return { previousData };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['prompts', selectedProjectId] });
      toast({
        title: 'Success',
        description: 'Prompt deleted successfully',
      });
    },
    onError: (error, variables, context) => {
      if (context?.previousData) {
        queryClient.setQueryData(['prompts', selectedProjectId], context.previousData);
      }
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to delete prompt',
        variant: 'destructive',
      });
    },
  });

  const resetForm = () => {
    setFormData({ title: '', content: '', tags: [] });
    setEditingPrompt(null);
    setShowPreview(false);
    setPendingTagInput('');
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedProjectId) {
      toast({
        title: 'Error',
        description: 'Please select a project first',
        variant: 'destructive',
      });
      return;
    }

    // Add any pending tag input before submitting
    let finalTags = formData.tags;
    if (pendingTagInput.trim()) {
      const trimmed = pendingTagInput.trim();
      if (!finalTags.includes(trimmed)) {
        finalTags = [...formData.tags, trimmed];
      }
    }

    if (editingPrompt) {
      updateMutation.mutate({
        id: editingPrompt.id,
        data: {
          title: formData.title,
          content: formData.content,
          tags: finalTags,
          version: editingPrompt.version,
        },
      });
    } else {
      createMutation.mutate({
        projectId: selectedProjectId,
        title: formData.title,
        content: formData.content,
        tags: finalTags,
      });
    }
  };

  const handleEdit = async (prompt: PromptSummary) => {
    try {
      const response = await fetch(`/api/prompts/${prompt.id}`);
      if (!response.ok) {
        throw new Error('Failed to fetch prompt');
      }
      const fullPrompt: PromptDetail = await response.json();
      setEditingPrompt(fullPrompt);
      setFormData({
        title: fullPrompt.title,
        content: fullPrompt.content,
        tags: [...fullPrompt.tags],
      });
      setPendingTagInput('');
      setShowDialog(true);
    } catch {
      toast({
        title: 'Error',
        description: 'Failed to load prompt for editing',
        variant: 'destructive',
      });
    }
  };

  const handleDelete = (id: string) => {
    if (confirm('Are you sure you want to delete this prompt?')) {
      deleteMutation.mutate(id);
    }
  };

  const filteredPrompts = useMemo(() => {
    return data?.items.filter((p: PromptSummary) => !filterTag || p.tags.includes(filterTag)) || [];
  }, [data, filterTag]);

  const allTags = useMemo(() => {
    return Array.from(new Set(data?.items.flatMap((p: PromptSummary) => p.tags) || [])) as string[];
  }, [data]);

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-3xl font-bold">Prompts</h1>
        <Button
          onClick={() => {
            resetForm();
            setShowDialog(true);
          }}
        >
          <Plus className="h-4 w-4 mr-2" />
          Create Prompt
        </Button>
      </div>

      <div className="mb-6 flex items-center gap-2">
        <Label htmlFor="filter-tag">Filter by tag:</Label>
        <select
          id="filter-tag"
          value={filterTag}
          onChange={(e) => setFilterTag(e.target.value)}
          className="flex h-10 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <option value="">All</option>
          {allTags.map((tag) => (
            <option key={tag} value={tag}>
              {tag}
            </option>
          ))}
        </select>
        {filterTag && (
          <Button variant="outline" size="sm" onClick={() => setFilterTag('')}>
            Clear
          </Button>
        )}
      </div>

      {isLoading && <p className="text-muted-foreground">Loading...</p>}

      {data && (
        <div className="grid gap-4">
          {filteredPrompts.map((prompt: PromptSummary) => (
            <div key={prompt.id} className="border rounded-lg p-4 bg-card">
              <div className="flex justify-between items-start mb-3">
                <div className="flex-1">
                  <h3 className="text-lg font-semibold">{prompt.title}</h3>
                  <p className="text-sm text-muted-foreground">
                    Version {prompt.version} • Updated{' '}
                    {new Date(prompt.updatedAt).toLocaleDateString()}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => handleEdit(prompt)}>
                    Edit
                  </Button>
                  <Button variant="destructive" size="sm" onClick={() => handleDelete(prompt.id)}>
                    Delete
                  </Button>
                </div>
              </div>
              <pre className="bg-muted p-3 rounded-md overflow-auto max-h-48 text-sm mb-3 font-mono whitespace-pre-wrap break-words">
                {prompt.contentPreview}
              </pre>
              {prompt.tags.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {prompt.tags.map((tag) => (
                    <Badge key={tag} variant="secondary">
                      <TagIcon className="h-3 w-3 mr-1" />
                      {tag}
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          ))}
          {filteredPrompts.length === 0 && (
            <p className="text-center text-muted-foreground py-8">
              No prompts found. Create your first prompt to get started.
            </p>
          )}
        </div>
      )}

      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingPrompt ? 'Edit Prompt' : 'Create Prompt'}</DialogTitle>
            <DialogDescription>
              {editingPrompt
                ? 'Update prompt details, content, and tags.'
                : 'Create a reusable prompt for this project.'}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_280px]">
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <Label htmlFor="title">Title *</Label>
                <Input
                  id="title"
                  type="text"
                  value={formData.title}
                  onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                  required
                  placeholder="Enter prompt title"
                />
              </div>

              <div>
                <div className="flex justify-between items-center mb-2">
                  <Label htmlFor="content">Content *</Label>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setShowPreview(!showPreview)}
                  >
                    {showPreview ? 'Edit' : 'Preview'}
                  </Button>
                </div>
                {showPreview ? (
                  <div className="border rounded-md p-4 min-h-[300px] bg-muted/50">
                    {formData.content ? (
                      <MarkdownPreview content={formData.content} />
                    ) : (
                      <p className="text-muted-foreground">No content to preview</p>
                    )}
                  </div>
                ) : (
                  <Textarea
                    id="content"
                    value={formData.content}
                    onChange={(e) => setFormData({ ...formData, content: e.target.value })}
                    required
                    placeholder="Enter prompt content (supports markdown)"
                    className="min-h-[300px] font-mono"
                  />
                )}
              </div>

              <div>
                <Label>Tags</Label>
                <TagInput
                  tags={formData.tags}
                  suggestions={allTags}
                  onAddTag={(tag) => setFormData({ ...formData, tags: [...formData.tags, tag] })}
                  onRemoveTag={(tag) =>
                    setFormData({ ...formData, tags: formData.tags.filter((t) => t !== tag) })
                  }
                  onInputChange={setPendingTagInput}
                />
                <p className="text-sm text-muted-foreground mt-1">
                  Supports both single labels (e.g., "bug") and key:value pairs (e.g.,
                  "category:feature"). Press Enter or comma to add.
                </p>
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
                <Button
                  type="submit"
                  disabled={createMutation.isPending || updateMutation.isPending}
                >
                  {editingPrompt ? 'Update' : 'Create'}
                </Button>
              </DialogFooter>
            </form>

            <aside className="rounded-md border bg-muted/50 p-4 space-y-3">
              <div>
                <h3 className="text-sm font-semibold text-foreground">Available Variables</h3>
                <p className="text-xs text-muted-foreground mt-1">
                  These placeholders are replaced when a session starts.
                </p>
              </div>
              <div className="space-y-3 text-sm">
                {PROMPT_VARIABLES.map((variable) => (
                  <div key={variable.token} className="space-y-1">
                    <code className="font-mono text-xs bg-background/60 px-2 py-1 rounded">
                      {variable.token}
                    </code>
                    <p className="text-xs text-muted-foreground">{variable.description}</p>
                  </div>
                ))}
              </div>
            </aside>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
