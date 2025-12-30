import { useCallback, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/ui/components/ui/button';
import { Input } from '@/ui/components/ui/input';
import { Label } from '@/ui/components/ui/label';
import { Textarea } from '@/ui/components/ui/textarea';
import { Badge } from '@/ui/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/components/ui/dialog';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/ui/components/ui/card';
import { useToast } from '@/ui/hooks/use-toast';
import { useSelectedProject } from '@/ui/hooks/useProjectSelection';
import {
  Edit,
  Plus,
  Search,
  Tag as TagIcon,
  Trash2,
  Star,
  StarOff,
  X,
  Menu,
  Archive,
  ArchiveRestore,
} from 'lucide-react';
import { cn } from '@/ui/lib/utils';
import { ContextualSidebar, useContextualSidebar } from '@/ui/components/ContextualSidebar';
import { FacetedNav } from '@/ui/components/FacetedNav';
import { InlineTagInput } from '@/ui/components/InlineTagInput';
import { DocumentPreviewPane } from '@/ui/components/DocumentPreviewPane';
import { Checkbox } from '@/ui/components/ui/checkbox';
import {
  extractAllTags,
  groupDocumentsByFacet,
  facetsToTagsArray,
  getFacetDisplayName,
} from '@/ui/lib/tags';

interface Document {
  id: string;
  projectId: string | null;
  title: string;
  slug: string;
  contentMd: string;
  archived: boolean;
  version: number;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

interface DocumentsResponse {
  items: Document[];
  total: number;
  limit: number;
  offset: number;
}

interface DocumentsQueryData {
  items: Document[];
  total?: number;
  limit?: number;
  offset?: number;
}

const PAGE_SIZE = 10;
const NO_VIEW_SELECT_VALUE = '__no_view__';

type UpdateArgs = {
  id: string;
  data: Partial<Document>;
  optimistic?: Partial<Document>;
  silent?: boolean;
};

interface SavedView {
  id: string;
  name: string;
  tags: string[];
  q?: string;
}

interface DocumentPreferences {
  selectedFacets: Record<string, string[]>;
  groupByKey: string | null;
}

function loadDocumentPreferences(projectId?: string): DocumentPreferences {
  if (!projectId || typeof window === 'undefined') {
    return { selectedFacets: {}, groupByKey: null };
  }

  try {
    const key = `devchain:docs:prefs:${projectId}`;
    const stored = window.localStorage.getItem(key);
    if (stored) {
      return JSON.parse(stored);
    }
  } catch (error) {
    console.error('Failed to load document preferences', error);
  }

  return { selectedFacets: {}, groupByKey: null };
}

function saveDocumentPreferences(prefs: DocumentPreferences, projectId?: string): void {
  if (!projectId || typeof window === 'undefined') {
    return;
  }

  try {
    const key = `devchain:docs:prefs:${projectId}`;
    window.localStorage.setItem(key, JSON.stringify(prefs));
  } catch (error) {
    console.error('Failed to save document preferences', error);
  }
}

function slugify(value: string) {
  const base = value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
  return base || 'document';
}

async function fetchDocuments({
  projectId,
  q,
  tags,
  limit,
  offset,
}: {
  projectId?: string;
  q?: string;
  tags?: string[];
  limit: number;
  offset: number;
}): Promise<DocumentsResponse> {
  const params = new URLSearchParams();
  if (projectId) {
    params.set('projectId', projectId);
  }
  if (q) {
    params.set('q', q);
  }
  if (tags && tags.length > 0) {
    tags.forEach((tag) => params.append('tag', tag));
  }
  params.set('limit', limit.toString());
  params.set('offset', offset.toString());

  const queryString = params.toString();
  const res = await fetch(`/api/documents?${queryString}`);
  if (!res.ok) throw new Error('Failed to fetch documents');
  return res.json();
}

async function createDocument(data: {
  projectId: string;
  title: string;
  slug: string;
  contentMd: string;
  tags: string[];
}) {
  const res = await fetch('/api/documents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectId: data.projectId,
      title: data.title,
      slug: data.slug,
      contentMd: data.contentMd,
      tags: data.tags,
    }),
  });
  if (!res.ok) throw new Error('Failed to create document');
  return res.json();
}

async function updateDocument(id: string, data: Partial<Document>) {
  const res = await fetch(`/api/documents/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error('Failed to update document');
  return res.json();
}

async function deleteDocument(id: string) {
  const res = await fetch(`/api/documents/${id}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error('Failed to delete document');
}

function slugifyHeading(value: string) {
  const base = value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
  return base || 'heading';
}

function extractHeadings(content: string): { id: string; level: number; text: string }[] {
  const lines = content.split('\n');
  const seen = new Map<string, number>();
  const result: { id: string; level: number; text: string }[] = [];

  lines.forEach((line) => {
    const match = line.match(/^(#{1,3})\s+(.*)$/);
    if (!match) {
      return;
    }
    const level = match[1].length;
    const text = match[2].trim();
    let slug = slugifyHeading(text);
    const count = seen.get(slug) ?? 0;
    if (count > 0) {
      slug = `${slug}-${count + 1}`;
    }
    seen.set(slug, count + 1);
    result.push({ id: `heading-${slug}`, level, text });
  });

  return result;
}

function MarkdownPreview({
  content,
  resolveSlug,
  onNavigate,
  headingAnchors = [],
}: {
  content: string;
  resolveSlug: (slug: string) => Document | undefined;
  onNavigate: (document: Document) => void;
  headingAnchors?: { id: string; level: number; text: string }[];
}) {
  let headingIndex = 0;
  const renderInline = (text: string) => {
    if (!text) {
      return null;
    }

    const tokens = text.split(/(\[\[[^\]]+\]\])/g);
    return tokens.map((token, idx) => {
      if (!token) {
        return null;
      }

      const isReference = token.startsWith('[[') && token.endsWith(']]');
      if (!isReference) {
        return <span key={idx}>{token}</span>;
      }

      const slug = token.slice(2, -2).trim();
      if (!slug) {
        return <span key={idx} />;
      }

      const resolved = resolveSlug(slug);
      if (resolved) {
        return (
          <button
            key={`${slug}-${idx}`}
            type="button"
            className="text-primary underline decoration-dotted underline-offset-4 hover:text-primary/80"
            onClick={() => onNavigate(resolved)}
          >
            {resolved.title || slug}
          </button>
        );
      }

      return (
        <span
          key={`${slug}-${idx}`}
          className="border-b border-dashed border-amber-500 text-amber-600"
          title="Document not found"
        >
          {slug}
        </span>
      );
    });
  };

  const renderContent = (text: string) => {
    const lines = text.split('\n');
    return lines.map((line, idx) => {
      if (line.startsWith('# ')) {
        const anchor = headingAnchors?.[headingIndex++];
        const headingId = anchor?.id ?? `heading-${idx}`;
        return (
          <h1 key={idx} id={headingId} className="text-2xl font-bold mb-2">
            {renderInline(line.substring(2))}
          </h1>
        );
      }
      if (line.startsWith('## ')) {
        const anchor = headingAnchors?.[headingIndex++];
        const headingId = anchor?.id ?? `heading-${idx}`;
        return (
          <h2 key={idx} id={headingId} className="text-xl font-semibold mb-2">
            {renderInline(line.substring(3))}
          </h2>
        );
      }
      if (line.startsWith('### ')) {
        const anchor = headingAnchors?.[headingIndex++];
        const headingId = anchor?.id ?? `heading-${idx}`;
        return (
          <h3 key={idx} id={headingId} className="text-lg font-semibold mb-1">
            {renderInline(line.substring(4))}
          </h3>
        );
      }
      if (line.startsWith('- ')) {
        return (
          <li key={idx} className="ml-4 list-disc">
            {renderInline(line.substring(2))}
          </li>
        );
      }
      if (line.trim() === '') {
        return <div key={idx} className="h-2" />;
      }
      return (
        <p key={idx} className="mb-2">
          {renderInline(line)}
        </p>
      );
    });
  };

  return (
    <div className="prose prose-sm max-w-none dark:prose-invert">{renderContent(content)}</div>
  );
}

function TagInput({
  tags,
  suggestions,
  onAddTag,
  onRemoveTag,
}: {
  tags: string[];
  suggestions: string[];
  onAddTag: (tag: string) => void;
  onRemoveTag: (tag: string) => void;
}) {
  const [input, setInput] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);

  const filteredSuggestions = useMemo(() => {
    if (!input) return [];
    return suggestions
      .filter((s) => s.toLowerCase().includes(input.toLowerCase()) && !tags.includes(s))
      .slice(0, 6);
  }, [input, suggestions, tags]);

  const handleAddTag = (value: string) => {
    const trimmed = value.trim();
    if (trimmed && !tags.includes(trimmed)) {
      onAddTag(trimmed);
      setInput('');
      setShowSuggestions(false);
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      handleAddTag(input);
    } else if (event.key === 'Backspace' && !input && tags.length > 0) {
      onRemoveTag(tags[tags.length - 1]);
    }
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
              className="ml-1 rounded-full hover:bg-muted"
            >
              <X className="h-3 w-3" />
            </button>
          </Badge>
        ))}
        <input
          type="text"
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            setShowSuggestions(true);
          }}
          onKeyDown={handleKeyDown}
          onFocus={() => setShowSuggestions(true)}
          onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
          placeholder={tags.length === 0 ? 'Add tags (label or key:value)…' : ''}
          className="flex-1 min-w-[120px] bg-transparent outline-none"
        />
      </div>
      {showSuggestions && filteredSuggestions.length > 0 && (
        <div className="absolute z-10 mt-1 w-full rounded-md border bg-popover shadow-lg">
          {filteredSuggestions.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              onClick={() => handleAddTag(suggestion)}
              className="w-full px-3 py-2 text-left transition-colors hover:bg-muted"
            >
              {suggestion}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function DocumentsPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { selectedProjectId, projects, projectsLoading, projectsError, setSelectedProjectId } =
    useSelectedProject();
  const { mobileOpen, setMobileOpen } = useContextualSidebar();

  const [searchTerm, setSearchTerm] = useState('');
  const [selectedFacets, setSelectedFacets] = useState<Map<string, Set<string>>>(new Map());
  const [groupByKey, setGroupByKey] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [showDialog, setShowDialog] = useState(false);
  const [editingDocument, setEditingDocument] = useState<Document | null>(null);
  const [slugTouched, setSlugTouched] = useState(false);
  const [showPreview, setShowPreview] = useState(true);
  const [formData, setFormData] = useState({
    title: '',
    slug: '',
    contentMd: '',
    tags: [] as string[],
  });
  const [savedViews, setSavedViews] = useState<SavedView[]>([]);
  const [activeViewId, setActiveViewId] = useState<string | null>(null);
  const [outlineOpen, setOutlineOpen] = useState(true);
  const [selectedDocuments, setSelectedDocuments] = useState<Set<string>>(new Set());
  const [previewDocument, setPreviewDocument] = useState<Document | null>(null);
  const [focusedDocumentIndex, setFocusedDocumentIndex] = useState<number>(0);

  // Compute selected tags from facets for API queries
  const selectedTags = useMemo(() => facetsToTagsArray(selectedFacets), [selectedFacets]);

  useEffect(() => {
    setPage(0);
  }, [selectedProjectId, searchTerm, selectedTags]);

  useEffect(() => {
    if (!selectedProjectId) {
      setSavedViews([]);
      setActiveViewId(null);
      return;
    }

    const key = `devchain:docViews:${selectedProjectId}`;
    try {
      const stored = window.localStorage.getItem(key);
      if (stored) {
        const parsed = JSON.parse(stored) as SavedView[];
        setSavedViews(parsed);
      } else {
        setSavedViews([]);
      }
    } catch (error) {
      console.error('Failed to load saved document views', error);
      setSavedViews([]);
    }
    setActiveViewId(null);
  }, [selectedProjectId]);

  useEffect(() => {
    if (!selectedProjectId) {
      return;
    }
    const key = `devchain:docViews:${selectedProjectId}`;
    window.localStorage.setItem(key, JSON.stringify(savedViews));
  }, [savedViews, selectedProjectId]);

  useEffect(() => {
    if (!activeViewId) {
      return;
    }
    const activeView = savedViews.find((view) => view.id === activeViewId);
    if (!activeView) {
      setActiveViewId(null);
      return;
    }

    if (
      activeView.q !== searchTerm ||
      activeView.tags.length !== selectedTags.length ||
      !activeView.tags.every((tag) => selectedTags.includes(tag))
    ) {
      setActiveViewId(null);
    }
  }, [searchTerm, selectedTags, activeViewId, savedViews]);

  // Load document preferences when project changes
  useEffect(() => {
    if (!selectedProjectId) {
      setSelectedFacets(new Map());
      setGroupByKey(null);
      return;
    }

    const prefs = loadDocumentPreferences(selectedProjectId);

    // Convert selectedFacets from Record to Map
    const facetsMap = new Map<string, Set<string>>();
    Object.entries(prefs.selectedFacets).forEach(([key, values]) => {
      facetsMap.set(key, new Set(values));
    });

    setSelectedFacets(facetsMap);
    setGroupByKey(prefs.groupByKey);
  }, [selectedProjectId]);

  // Save document preferences when they change
  useEffect(() => {
    if (!selectedProjectId) {
      return;
    }

    // Convert selectedFacets from Map to Record for storage
    const facetsRecord: Record<string, string[]> = {};
    selectedFacets.forEach((values, key) => {
      facetsRecord[key] = Array.from(values);
    });

    const prefs: DocumentPreferences = {
      selectedFacets: facetsRecord,
      groupByKey,
    };

    saveDocumentPreferences(prefs, selectedProjectId);
  }, [selectedFacets, groupByKey, selectedProjectId]);

  const tagsKey = selectedTags.slice().sort().join(',');

  const { data, isLoading, isError } = useQuery({
    queryKey: ['documents', selectedProjectId, searchTerm, tagsKey, page],
    queryFn: () =>
      fetchDocuments({
        projectId: selectedProjectId,
        q: searchTerm || undefined,
        tags: selectedTags,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      }),
    enabled: !!selectedProjectId,
  });

  const { data: allDocsData } = useQuery({
    queryKey: ['documents-index', selectedProjectId],
    queryFn: () =>
      fetchDocuments({
        projectId: selectedProjectId,
        limit: 1000,
        offset: 0,
      }),
    enabled: !!selectedProjectId,
  });

  const documents = data?.items ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const allDocuments = allDocsData?.items ?? documents;

  const findDocumentBySlug = useCallback(
    (slug: string) =>
      allDocuments.find(
        (doc) => doc.slug === slug && (doc.projectId ?? null) === (selectedProjectId ?? null),
      ),
    [allDocuments, selectedProjectId],
  );

  const backlinks = useMemo(() => {
    if (!editingDocument) {
      return [] as Document[];
    }
    const token = `[[${editingDocument.slug}]]`;
    return allDocuments.filter(
      (doc) => doc.id !== editingDocument.id && doc.contentMd.includes(token),
    );
  }, [editingDocument, allDocuments]);

  const outlineHeadings = useMemo(
    () => (formData.contentMd ? extractHeadings(formData.contentMd) : []),
    [formData.contentMd],
  );

  const allTags = useMemo(() => {
    return extractAllTags(allDocuments);
  }, [allDocuments]);

  const visibleTags = useMemo(() => {
    return extractAllTags(documents);
  }, [documents]);

  const groupedDocuments = useMemo(() => {
    if (!groupByKey) {
      return null;
    }
    return groupDocumentsByFacet(documents, groupByKey);
  }, [documents, groupByKey]);

  const resetForm = () => {
    setFormData({ title: '', slug: '', contentMd: '', tags: [] });
    setEditingDocument(null);
    setSlugTouched(false);
    setShowPreview(true);
  };

  const handleCreate = () => {
    resetForm();
    setShowDialog(true);
  };

  const handleEdit = (document: Document) => {
    setEditingDocument(document);
    setFormData({
      title: document.title,
      slug: document.slug,
      contentMd: document.contentMd,
      tags: [...document.tags],
    });
    setSlugTouched(true);
    setShowDialog(true);
    setShowPreview(true);
  };

  const handleDelete = (id: string) => {
    if (!confirm('Delete this document permanently?')) return;
    deleteMutation.mutate(id);
  };

  const handlePinnedToggle = (document: Document) => {
    const hasPinned = document.tags.includes('pinned');
    const nextTags = hasPinned
      ? document.tags.filter((tag) => tag !== 'pinned')
      : [...document.tags, 'pinned'];
    updateMutation.mutate({
      id: document.id,
      data: { tags: nextTags, version: document.version },
      optimistic: { tags: nextTags },
      silent: true,
    });
  };

  const handleNavigateToDocument = (document: Document) => {
    handleEdit(document);
    setShowPreview(true);
  };

  const handleOutlineClick = (anchorId: string) => {
    const target = document.getElementById(anchorId);
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  const handleSaveView = () => {
    if (!selectedProjectId) {
      toast({
        title: 'Select a project',
        description: 'Choose a project before saving document views.',
        variant: 'destructive',
      });
      return;
    }

    const defaultName = searchTerm ? `${searchTerm} view` : 'New view';
    const name = window.prompt('Name for this view:', defaultName);
    if (!name) {
      return;
    }

    const existing = savedViews.find((view) => view.name === name);
    if (existing) {
      const updated = savedViews.map((view) =>
        view.id === existing.id
          ? { ...view, tags: selectedTags, q: searchTerm || undefined }
          : view,
      );
      setSavedViews(updated);
      setActiveViewId(existing.id);
      toast({ title: 'View updated', description: `"${name}" updated with current filters.` });
      return;
    }

    const newView: SavedView = {
      id: `view-${Date.now()}`,
      name,
      tags: [...selectedTags],
      q: searchTerm || undefined,
    };

    setSavedViews((prev) => [...prev, newView]);
    setActiveViewId(newView.id);
    toast({ title: 'View saved', description: `"${name}" saved.` });
  };

  const handleApplyView = (viewId: string) => {
    if (!viewId || viewId === NO_VIEW_SELECT_VALUE) {
      setActiveViewId(null);
      return;
    }
    const view = savedViews.find((item) => item.id === viewId);
    if (!view) {
      setActiveViewId(null);
      return;
    }
    setActiveViewId(viewId);
    setSearchTerm(view.q ?? '');

    // Convert view tags to facets
    const facetsMap = new Map<string, Set<string>>();
    (view.tags ?? []).forEach((tag) => {
      const colonIndex = tag.indexOf(':');
      if (colonIndex > 0 && colonIndex < tag.length - 1) {
        // Key:value tag
        const key = tag.substring(0, colonIndex);
        const value = tag.substring(colonIndex + 1);
        if (!facetsMap.has(key)) {
          facetsMap.set(key, new Set());
        }
        facetsMap.get(key)!.add(value);
      } else {
        // Simple label
        if (!facetsMap.has('__labels__')) {
          facetsMap.set('__labels__', new Set());
        }
        facetsMap.get('__labels__')!.add(tag);
      }
    });

    setSelectedFacets(facetsMap);
    setPage(0);
  };

  const handleRenameView = () => {
    if (!activeViewId) {
      toast({
        title: 'No view selected',
        description: 'Select a saved view to rename.',
        variant: 'destructive',
      });
      return;
    }

    const current = savedViews.find((view) => view.id === activeViewId);
    if (!current) {
      return;
    }

    const name = window.prompt('Rename view:', current.name);
    if (!name || name === current.name) {
      return;
    }

    const updated = savedViews.map((view) => (view.id === current.id ? { ...view, name } : view));
    setSavedViews(updated);
    toast({ title: 'View renamed', description: `"${current.name}" renamed to "${name}".` });
  };

  const handleDeleteView = () => {
    if (!activeViewId) {
      toast({
        title: 'No view selected',
        description: 'Select a saved view to delete.',
        variant: 'destructive',
      });
      return;
    }

    const current = savedViews.find((view) => view.id === activeViewId);
    if (!current) {
      return;
    }

    if (!window.confirm(`Delete view "${current.name}"?`)) {
      return;
    }

    setSavedViews((prev) => prev.filter((view) => view.id !== current.id));
    setActiveViewId(null);
    toast({ title: 'View deleted', description: `"${current.name}" removed.` });
  };

  const createMutation = useMutation({
    mutationFn: createDocument,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['documents'] });
      toast({ title: 'Document created', description: 'Document saved successfully.' });
      setShowDialog(false);
      resetForm();
    },
    onError: (error: unknown) => {
      toast({
        title: 'Failed to create document',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive',
      });
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: UpdateArgs) => updateDocument(id, data),
    onMutate: async ({ id, optimistic, silent }: UpdateArgs) => {
      await queryClient.cancelQueries({ queryKey: ['documents'] });
      const previous = queryClient.getQueryData([
        'documents',
        selectedProjectId,
        searchTerm,
        tagsKey,
        page,
      ]);

      if (optimistic) {
        queryClient.setQueryData(
          ['documents', selectedProjectId, searchTerm, tagsKey, page],
          (old: DocumentsQueryData | undefined) => {
            if (!old?.items) return old;
            return {
              ...old,
              items: old.items.map((doc: Document) =>
                doc.id === id
                  ? { ...doc, ...optimistic, updatedAt: new Date().toISOString() }
                  : doc,
              ),
            };
          },
        );
      }

      return { previous, silent };
    },
    onError: (error, _variables, context) => {
      if (context?.previous) {
        queryClient.setQueryData(
          ['documents', selectedProjectId, searchTerm, tagsKey, page],
          context.previous,
        );
      }
      toast({
        title: 'Failed to update document',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive',
      });
    },
    onSuccess: (_result, _variables, context) => {
      queryClient.invalidateQueries({ queryKey: ['documents'] });
      if (!context?.silent) {
        toast({ title: 'Document updated', description: 'Changes saved successfully.' });
        setShowDialog(false);
        resetForm();
      }
    },
  });

  const deleteMutation = useMutation({
    mutationFn: deleteDocument,
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: ['documents'] });
      const previous = queryClient.getQueryData([
        'documents',
        selectedProjectId,
        searchTerm,
        tagsKey,
        page,
      ]);
      queryClient.setQueryData(
        ['documents', selectedProjectId, searchTerm, tagsKey, page],
        (old: DocumentsQueryData | undefined) => {
          if (!old?.items) return old;
          return { ...old, items: old.items.filter((doc: Document) => doc.id !== id) };
        },
      );
      return { previous };
    },
    onError: (error, _variables, context) => {
      if (context?.previous) {
        queryClient.setQueryData(
          ['documents', selectedProjectId, searchTerm, tagsKey, page],
          context.previous,
        );
      }
      toast({
        title: 'Failed to delete document',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive',
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['documents'] });
      toast({ title: 'Document deleted', description: 'Document removed successfully.' });
    },
  });

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!selectedProjectId) {
      toast({
        title: 'Select a project',
        description: 'Choose a project before creating documents.',
        variant: 'destructive',
      });
      return;
    }

    if (editingDocument) {
      updateMutation.mutate({
        id: editingDocument.id,
        data: {
          title: formData.title,
          slug: formData.slug,
          contentMd: formData.contentMd,
          tags: formData.tags,
          version: editingDocument.version,
        },
      });
    } else {
      createMutation.mutate({
        projectId: selectedProjectId,
        title: formData.title,
        slug: formData.slug || slugify(formData.title),
        contentMd: formData.contentMd,
        tags: formData.tags,
      });
    }
  };

  const handleToggleDocumentSelection = useCallback((documentId: string) => {
    setSelectedDocuments((prev) => {
      const next = new Set(prev);
      if (next.has(documentId)) {
        next.delete(documentId);
      } else {
        next.add(documentId);
      }
      return next;
    });
  }, []);

  const handleClearSelection = useCallback(() => {
    setSelectedDocuments(new Set());
  }, []);

  const handleBulkAddTags = useCallback(
    async (tagsToAdd: string[]) => {
      const selectedDocs = documents.filter((doc) => selectedDocuments.has(doc.id));
      if (selectedDocs.length === 0 || tagsToAdd.length === 0) {
        return;
      }

      const updates = selectedDocs.map((doc) => {
        const newTags = Array.from(new Set([...doc.tags, ...tagsToAdd]));
        return {
          id: doc.id,
          tags: newTags,
          version: doc.version,
        };
      });

      try {
        await Promise.all(
          updates.map((update) =>
            updateMutation.mutateAsync({
              id: update.id,
              data: { tags: update.tags, version: update.version },
              silent: true,
            }),
          ),
        );
        queryClient.invalidateQueries({ queryKey: ['documents'] });
        toast({
          title: 'Tags added',
          description: `Added tags to ${selectedDocs.length} document(s).`,
        });
        handleClearSelection();
      } catch (error) {
        toast({
          title: 'Failed to add tags',
          description: error instanceof Error ? error.message : 'Unknown error',
          variant: 'destructive',
        });
      }
    },
    [documents, selectedDocuments, updateMutation, queryClient, toast, handleClearSelection],
  );

  const handleBulkRemoveTags = useCallback(
    async (tagsToRemove: string[]) => {
      const selectedDocs = documents.filter((doc) => selectedDocuments.has(doc.id));
      if (selectedDocs.length === 0 || tagsToRemove.length === 0) {
        return;
      }

      const updates = selectedDocs.map((doc) => {
        const newTags = doc.tags.filter((tag) => !tagsToRemove.includes(tag));
        return {
          id: doc.id,
          tags: newTags,
          version: doc.version,
        };
      });

      try {
        await Promise.all(
          updates.map((update) =>
            updateMutation.mutateAsync({
              id: update.id,
              data: { tags: update.tags, version: update.version },
              silent: true,
            }),
          ),
        );
        queryClient.invalidateQueries({ queryKey: ['documents'] });
        toast({
          title: 'Tags removed',
          description: `Removed tags from ${selectedDocs.length} document(s).`,
        });
        handleClearSelection();
      } catch (error) {
        toast({
          title: 'Failed to remove tags',
          description: error instanceof Error ? error.message : 'Unknown error',
          variant: 'destructive',
        });
      }
    },
    [documents, selectedDocuments, updateMutation, queryClient, toast, handleClearSelection],
  );

  const handleBulkArchive = useCallback(async () => {
    const selectedDocs = documents.filter((doc) => selectedDocuments.has(doc.id));
    if (selectedDocs.length === 0) {
      return;
    }

    try {
      await Promise.all(
        selectedDocs.map((doc) =>
          updateMutation.mutateAsync({
            id: doc.id,
            data: { archived: true, version: doc.version },
            silent: true,
          }),
        ),
      );
      queryClient.invalidateQueries({ queryKey: ['documents'] });
      toast({
        title: 'Documents archived',
        description: `Archived ${selectedDocs.length} document(s).`,
      });
      handleClearSelection();
    } catch (error) {
      toast({
        title: 'Failed to archive documents',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  }, [documents, selectedDocuments, updateMutation, queryClient, toast, handleClearSelection]);

  const handleBulkUnarchive = useCallback(async () => {
    const selectedDocs = documents.filter((doc) => selectedDocuments.has(doc.id));
    if (selectedDocs.length === 0) {
      return;
    }

    try {
      await Promise.all(
        selectedDocs.map((doc) =>
          updateMutation.mutateAsync({
            id: doc.id,
            data: { archived: false, version: doc.version },
            silent: true,
          }),
        ),
      );
      queryClient.invalidateQueries({ queryKey: ['documents'] });
      toast({
        title: 'Documents unarchived',
        description: `Unarchived ${selectedDocs.length} document(s).`,
      });
      handleClearSelection();
    } catch (error) {
      toast({
        title: 'Failed to unarchive documents',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  }, [documents, selectedDocuments, updateMutation, queryClient, toast, handleClearSelection]);

  const handleUpdateDocumentTags = useCallback(
    (documentId: string, newTags: string[]) => {
      const doc = documents.find((d) => d.id === documentId);
      if (!doc) return;

      updateMutation.mutate({
        id: documentId,
        data: { tags: newTags, version: doc.version },
        optimistic: { tags: newTags },
        silent: true,
      });
    },
    [documents, updateMutation],
  );

  // Preview and keyboard shortcuts
  const handlePreviewDocument = useCallback((document: Document) => {
    setPreviewDocument(document);
  }, []);

  const handleClosePreview = useCallback(() => {
    setPreviewDocument(null);
  }, []);

  const handlePreviewNavigate = useCallback((document: Document) => {
    setPreviewDocument(document);
  }, []);

  const handleKeyboardShortcuts = useCallback(
    (event: KeyboardEvent) => {
      // Only handle shortcuts when not in input/textarea/dialog
      if (
        showDialog ||
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement
      ) {
        return;
      }

      if (documents.length === 0) {
        return;
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setFocusedDocumentIndex((prev) => Math.min(documents.length - 1, prev + 1));
        const nextDoc = documents[Math.min(documents.length - 1, focusedDocumentIndex + 1)];
        if (nextDoc) {
          setPreviewDocument(nextDoc);
        }
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        setFocusedDocumentIndex((prev) => Math.max(0, prev - 1));
        const prevDoc = documents[Math.max(0, focusedDocumentIndex - 1)];
        if (prevDoc) {
          setPreviewDocument(prevDoc);
        }
      } else if (event.key === 'Enter') {
        event.preventDefault();
        const doc = documents[focusedDocumentIndex];
        if (doc) {
          handleEdit(doc);
        }
      } else if (event.key === 'p' || event.key === 'P') {
        event.preventDefault();
        const doc = documents[focusedDocumentIndex];
        if (doc) {
          handlePinnedToggle(doc);
        }
      } else if (event.key === 't' || event.key === 'T') {
        event.preventDefault();
        const doc = documents[focusedDocumentIndex];
        if (doc) {
          const tag = window.prompt('Enter tag to add:');
          if (tag) {
            handleUpdateDocumentTags(doc.id, [...doc.tags, tag.trim()]);
          }
        }
      } else if (event.key === 'Escape') {
        if (previewDocument) {
          event.preventDefault();
          handleClosePreview();
        }
      }
    },
    [
      documents,
      focusedDocumentIndex,
      showDialog,
      previewDocument,
      handleEdit,
      handlePinnedToggle,
      handleUpdateDocumentTags,
      handleClosePreview,
    ],
  );

  // Keyboard shortcuts effect
  useEffect(() => {
    window.addEventListener('keydown', handleKeyboardShortcuts);
    return () => window.removeEventListener('keydown', handleKeyboardShortcuts);
  }, [handleKeyboardShortcuts]);

  // Auto-preview first document when list changes
  useEffect(() => {
    if (documents.length > 0 && !previewDocument) {
      setPreviewDocument(documents[0]);
      setFocusedDocumentIndex(0);
    }
  }, [documents, previewDocument]);

  const disableCreate = !selectedProjectId;

  // Render helper for document row
  const renderDocumentRow = (document: Document, index: number) => {
    const pinned = document.tags.includes('pinned');
    const isSelected = selectedDocuments.has(document.id);
    const isFocused = focusedDocumentIndex === index;
    const isPreviewing = previewDocument?.id === document.id;

    return (
      <div
        key={document.id}
        className={cn(
          'group relative flex items-start gap-3 p-4 transition-colors cursor-pointer',
          isSelected && 'bg-muted/50',
          isFocused && 'ring-2 ring-primary ring-inset',
          isPreviewing && 'bg-primary/5',
        )}
        onClick={() => {
          setFocusedDocumentIndex(index);
          handlePreviewDocument(document);
        }}
      >
        <Checkbox
          checked={isSelected}
          onCheckedChange={() => handleToggleDocumentSelection(document.id)}
          aria-label={`Select ${document.title}`}
          className="mt-1"
          onClick={(e) => e.stopPropagation()}
        />
        <div className="space-y-2 flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold truncate">{document.title}</h2>
            <Button
              variant="ghost"
              size="icon"
              onClick={(e) => {
                e.stopPropagation();
                handlePinnedToggle(document);
              }}
              aria-label={pinned ? 'Unpin document' : 'Pin document'}
              className="h-6 w-6 shrink-0"
            >
              {pinned ? (
                <Star className="h-3.5 w-3.5 text-amber-500 fill-amber-500" />
              ) : (
                <StarOff className="h-3.5 w-3.5" />
              )}
            </Button>
            {document.archived && (
              <Badge variant="secondary" className="text-xs shrink-0">
                Archived
              </Badge>
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            slug: <code>{document.slug}</code>
          </p>
          <p className="text-sm text-muted-foreground">
            Updated {new Date(document.updatedAt).toLocaleString()}
          </p>
          <InlineTagInput
            tags={document.tags}
            suggestions={allTags}
            onAddTag={(tag) => handleUpdateDocumentTags(document.id, [...document.tags, tag])}
            onRemoveTag={(tag) =>
              handleUpdateDocumentTags(
                document.id,
                document.tags.filter((t) => t !== tag),
              )
            }
            compact
          />
        </div>

        {/* Floating Action Buttons - Shown on hover/focus */}
        <div
          className={cn(
            'absolute right-4 top-1/2 -translate-y-1/2 flex flex-col gap-1',
            'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100',
            'transition-opacity duration-200',
            'bg-background/95 backdrop-blur-sm rounded-md shadow-lg border p-1',
          )}
        >
          {document.archived ? (
            <Button
              variant="ghost"
              size="icon"
              onClick={(e) => {
                e.stopPropagation();
                updateMutation.mutate({
                  id: document.id,
                  data: { archived: false, version: document.version },
                  silent: true,
                });
              }}
              className="h-8 w-8"
              title="Unarchive"
            >
              <ArchiveRestore className="h-4 w-4" />
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="icon"
              onClick={(e) => {
                e.stopPropagation();
                updateMutation.mutate({
                  id: document.id,
                  data: { archived: true, version: document.version },
                  silent: true,
                });
              }}
              className="h-8 w-8"
              title="Archive"
            >
              <Archive className="h-4 w-4" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            onClick={(e) => {
              e.stopPropagation();
              handleEdit(document);
            }}
            className="h-8 w-8"
            title="Edit"
          >
            <Edit className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={(e) => {
              e.stopPropagation();
              handleDelete(document.id);
            }}
            className="h-8 w-8 text-destructive hover:text-destructive hover:bg-destructive/10"
            title="Delete"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>
    );
  };

  return (
    <div className="flex h-full min-h-0 -m-6">
      {/* Contextual Sidebar with Facets and Saved Views */}
      {selectedProjectId && (
        <ContextualSidebar
          mobileOpen={mobileOpen}
          onMobileOpenChange={setMobileOpen}
          projectId={selectedProjectId}
          backRoute="/board"
          ariaLabel="Documents filters and views"
          savedViews={
            <div className="space-y-3">
              <Select
                value={activeViewId ?? NO_VIEW_SELECT_VALUE}
                onValueChange={(value) => handleApplyView(value)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select saved view" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_VIEW_SELECT_VALUE}>No view</SelectItem>
                  {savedViews.map((view) => (
                    <SelectItem key={view.id} value={view.id}>
                      {view.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="flex flex-col gap-2">
                <Button variant="secondary" size="sm" onClick={handleSaveView} className="w-full">
                  Save Current
                </Button>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleRenameView}
                    disabled={!activeViewId}
                    className="flex-1"
                  >
                    Rename
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleDeleteView}
                    disabled={!activeViewId}
                    className="flex-1"
                  >
                    Delete
                  </Button>
                </div>
              </div>
            </div>
          }
          facets={
            <FacetedNav
              allTags={allTags}
              visibleTags={visibleTags}
              selectedFacets={selectedFacets}
              onFacetsChange={setSelectedFacets}
              groupByKey={groupByKey}
              onGroupByKeyChange={setGroupByKey}
            />
          }
        />
      )}

      {/* Main Content Area - Split View when Preview Active */}
      <div className="flex-1 flex flex-col lg:flex-row min-h-0 overflow-hidden relative">
        {/* Document List */}
        <div
          className={cn(
            'flex flex-1 flex-col gap-6 p-6 min-h-0 overflow-hidden',
            previewDocument && 'lg:basis-[45%] lg:max-w-[45%] lg:min-w-[360px]',
          )}
        >
          <div className="flex items-center gap-2 shrink-0">
            {selectedProjectId && (
              <Button
                variant="ghost"
                size="icon"
                className="lg:hidden"
                onClick={() => setMobileOpen(true)}
                aria-label="Open filters sidebar"
              >
                <Menu className="h-5 w-5" />
              </Button>
            )}
            <div className="relative flex-1">
              <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="Search by title…"
                className="pl-9"
                data-shortcut="primary-search"
              />
            </div>
            <Button onClick={handleCreate} disabled={disableCreate}>
              <Plus className="mr-2 h-4 w-4" />
              New Document
            </Button>
          </div>

          {projectsError && (
            <Card>
              <CardHeader>
                <CardTitle>Projects unavailable</CardTitle>
                <CardDescription>Unable to load projects. Please try again.</CardDescription>
              </CardHeader>
            </Card>
          )}

          {!projectsLoading && projects.length > 0 && !selectedProjectId && (
            <Card>
              <CardHeader>
                <CardTitle>Select a project</CardTitle>
                <CardDescription className="flex flex-wrap gap-2">
                  {projects.map((project) => (
                    <Button
                      key={project.id}
                      variant="secondary"
                      onClick={() => setSelectedProjectId(project.id)}
                    >
                      {project.name}
                    </Button>
                  ))}
                </CardDescription>
              </CardHeader>
            </Card>
          )}

          {/* Bulk Actions Toolbar */}
          {selectedDocuments.size > 0 && (
            <Card className="border-primary/50 bg-primary/5">
              <CardContent className="flex items-center justify-between p-4">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">
                    {selectedDocuments.size} document(s) selected
                  </span>
                  <Button variant="ghost" size="sm" onClick={handleClearSelection}>
                    Clear
                  </Button>
                </div>
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" onClick={handleBulkArchive}>
                    <Archive className="mr-2 h-4 w-4" />
                    Archive
                  </Button>
                  <Button variant="outline" size="sm" onClick={handleBulkUnarchive}>
                    <ArchiveRestore className="mr-2 h-4 w-4" />
                    Unarchive
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      const tag = window.prompt('Enter tag to add:');
                      if (tag) {
                        handleBulkAddTags([tag.trim()]);
                      }
                    }}
                  >
                    <Plus className="mr-2 h-4 w-4" />
                    Add Tag
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      const tag = window.prompt('Enter tag to remove:');
                      if (tag) {
                        handleBulkRemoveTags([tag.trim()]);
                      }
                    }}
                  >
                    <X className="mr-2 h-4 w-4" />
                    Remove Tag
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          <Card className="flex-1 overflow-hidden">
            <CardContent className="p-0 h-full overflow-y-auto">
              {isLoading ? (
                <div className="p-6 text-center text-muted-foreground">Loading documents…</div>
              ) : isError ? (
                <div className="p-6 text-center text-destructive">
                  Failed to load documents. Please try again.
                </div>
              ) : documents.length === 0 ? (
                <div className="p-6 text-center text-muted-foreground">
                  {selectedProjectId
                    ? 'No documents found. Create your first document to get started.'
                    : 'Select a project to view documents.'}
                </div>
              ) : groupedDocuments ? (
                // Render grouped documents
                <div>
                  {Array.from(groupedDocuments.entries())
                    .sort(([keyA], [keyB]) => {
                      // Sort: put __ungrouped__ last, then alphabetically
                      if (keyA === '__ungrouped__') return 1;
                      if (keyB === '__ungrouped__') return -1;
                      return keyA.localeCompare(keyB);
                    })
                    .map(([groupValue, groupDocs]) => {
                      const displayName = groupValue === '__ungrouped__' ? 'Ungrouped' : groupValue;
                      return (
                        <div key={groupValue} className="border-b border-border last:border-b-0">
                          <div className="sticky top-0 z-10 bg-muted/80 backdrop-blur px-4 py-2 border-b border-border">
                            <div className="flex items-center justify-between">
                              <h3 className="text-sm font-semibold uppercase tracking-wide">
                                {getFacetDisplayName(displayName)} ({groupDocs.length})
                              </h3>
                            </div>
                          </div>
                          <div className="divide-y">
                            {groupDocs.map((document) => {
                              const globalIndex = documents.findIndex((d) => d.id === document.id);
                              return renderDocumentRow(document, globalIndex);
                            })}
                          </div>
                        </div>
                      );
                    })}
                </div>
              ) : (
                // Render flat list
                <div className="divide-y">
                  {documents.map((document, idx) => renderDocumentRow(document, idx))}
                </div>
              )}
            </CardContent>
          </Card>

          {documents.length > 0 && (
            <div className="flex items-center justify-between shrink-0">
              <p className="text-sm text-muted-foreground">
                Showing {page * PAGE_SIZE + 1}-{Math.min((page + 1) * PAGE_SIZE, total)} of {total}{' '}
                documents
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((prev) => Math.max(0, prev - 1))}
                  disabled={page === 0}
                >
                  Previous
                </Button>
                <span className="text-sm text-muted-foreground">
                  Page {page + 1} of {totalPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((prev) => Math.min(totalPages - 1, prev + 1))}
                  disabled={page >= totalPages - 1}
                >
                  Next
                </Button>
              </div>
            </div>
          )}

          <Dialog
            open={showDialog}
            onOpenChange={(open) => {
              if (!open) {
                setShowDialog(false);
                resetForm();
              } else {
                setShowDialog(true);
              }
            }}
          >
            <DialogContent className="sm:max-w-3xl lg:max-w-5xl xl:max-w-6xl">
              <DialogHeader>
                <DialogTitle>{editingDocument ? 'Edit Document' : 'New Document'}</DialogTitle>
              </DialogHeader>
              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="document-title">Title</Label>
                    <Input
                      id="document-title"
                      value={formData.title}
                      onChange={(e) => {
                        const title = e.target.value;
                        setFormData((prev) => ({ ...prev, title }));
                        if (!slugTouched) {
                          setFormData((prev) => ({ ...prev, slug: slugify(title) }));
                        }
                      }}
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="document-slug">Slug</Label>
                    <Input
                      id="document-slug"
                      value={formData.slug}
                      onChange={(e) => {
                        setSlugTouched(true);
                        setFormData((prev) => ({ ...prev, slug: slugify(e.target.value) }));
                      }}
                      required
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label>Tags</Label>
                  <TagInput
                    tags={formData.tags}
                    suggestions={allTags}
                    onAddTag={(tag) =>
                      setFormData((prev) => ({ ...prev, tags: [...prev.tags, tag] }))
                    }
                    onRemoveTag={(tag) =>
                      setFormData((prev) => ({
                        ...prev,
                        tags: prev.tags.filter((t) => t !== tag),
                      }))
                    }
                  />
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="document-content">Content</Label>
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setShowPreview((prev) => !prev)}
                      >
                        {showPreview ? 'Hide Preview' : 'Show Preview'}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setOutlineOpen((prev) => !prev)}
                        disabled={!showPreview}
                      >
                        {outlineOpen ? 'Hide Outline' : 'Show Outline'}
                      </Button>
                    </div>
                  </div>
                  <div
                    className={cn(
                      'flex flex-col gap-4',
                      showPreview && 'lg:flex-row lg:items-start',
                    )}
                  >
                    <div className={cn('flex-1', showPreview && 'lg:w-1/2')}>
                      <Textarea
                        id="document-content"
                        rows={10}
                        value={formData.contentMd}
                        onChange={(e) =>
                          setFormData((prev) => ({ ...prev, contentMd: e.target.value }))
                        }
                        required
                        className="min-h-[320px]"
                      />
                    </div>
                    {showPreview && (
                      <div className="flex-1 space-y-4 rounded-md border p-4 lg:w-1/2 lg:max-h-[520px] lg:overflow-auto">
                        <MarkdownPreview
                          content={formData.contentMd}
                          resolveSlug={findDocumentBySlug}
                          onNavigate={handleNavigateToDocument}
                          headingAnchors={outlineHeadings}
                        />
                        <div>
                          <h3 className="text-sm font-semibold uppercase text-muted-foreground">
                            Backlinks
                          </h3>
                          {backlinks.length > 0 ? (
                            <ul className="mt-2 space-y-1">
                              {backlinks.map((doc) => (
                                <li key={doc.id}>
                                  <button
                                    type="button"
                                    className="text-primary underline underline-offset-4 decoration-dotted hover:text-primary/80"
                                    onClick={() => handleNavigateToDocument(doc)}
                                  >
                                    {doc.title || doc.slug}
                                  </button>
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <p className="mt-2 text-sm text-muted-foreground">No backlinks yet.</p>
                          )}
                        </div>
                        {outlineOpen && outlineHeadings.length > 0 && (
                          <div className="border-t pt-3">
                            <h3 className="text-sm font-semibold uppercase text-muted-foreground">
                              Outline
                            </h3>
                            <ul className="mt-2 space-y-1 text-sm">
                              {outlineHeadings.map((heading) => (
                                <li key={heading.id}>
                                  <button
                                    type="button"
                                    className={cn(
                                      'w-full truncate text-left text-muted-foreground hover:text-primary',
                                      heading.level === 1 && 'pl-0 font-medium text-foreground',
                                      heading.level === 2 && 'pl-3',
                                      heading.level === 3 && 'pl-6 text-xs',
                                    )}
                                    onClick={() => handleOutlineClick(heading.id)}
                                  >
                                    {heading.text}
                                  </button>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>

                <DialogFooter className="gap-2">
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
                    {editingDocument ? 'Save Changes' : 'Create Document'}
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        </div>

        {/* Preview Pane - Hidden on mobile, shown on desktop when document selected */}
        {previewDocument && (
          <div className="hidden min-h-0 border-l lg:flex lg:basis-[55%] lg:flex-col lg:min-w-[420px]">
            <div className="sticky top-0 h-screen overflow-y-auto p-6 bg-background">
              <DocumentPreviewPane
                document={previewDocument}
                allDocuments={allDocuments}
                onNavigate={handlePreviewNavigate}
                onEdit={handleEdit}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
