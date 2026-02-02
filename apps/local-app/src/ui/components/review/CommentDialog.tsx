import { useState, useMemo, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import DOMPurify from 'dompurify';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/components/ui/dialog';
import { Button } from '@/ui/components/ui/button';
import { Textarea } from '@/ui/components/ui/textarea';
import { Label } from '@/ui/components/ui/label';
import { Input } from '@/ui/components/ui/input';
import { ToggleGroup, ToggleGroupItem } from '@/ui/components/ui/toggle-group';
import { Tabs, TabsList, TabsTrigger } from '@/ui/components/ui/tabs';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/components/ui/select';
import {
  FileCode,
  MessageSquare,
  Lightbulb,
  AlertCircle,
  CheckCircle2,
  Eye,
  Edit3,
  Search,
  Bot,
} from 'lucide-react';
import { cn } from '@/ui/lib/utils';
import { useMentionAutocomplete } from '@/ui/hooks/useMentionAutocomplete';
import { parseMentions } from '@/ui/lib/chat';
import type { CommentType } from '@/ui/lib/reviews';

/**
 * Simple markdown to HTML converter for preview.
 * SECURITY: Output is sanitized with DOMPurify to prevent XSS attacks.
 */
function renderMarkdown(text: string): string {
  // First, escape HTML entities to prevent raw HTML injection
  const escapeHtml = (str: string) =>
    str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

  // Escape the text first, then apply markdown transformations
  let html = escapeHtml(text);

  html = html
    // Code blocks (unescape inside code blocks for proper display)
    .replace(
      /```(\w+)?\n([\s\S]*?)```/g,
      '<pre class="bg-muted p-2 rounded text-sm overflow-x-auto"><code>$2</code></pre>',
    )
    // Inline code
    .replace(/`([^`]+)`/g, '<code class="bg-muted px-1 rounded text-sm">$1</code>')
    // Bold
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    // Italic
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    // Links - only allow safe URL schemes (http, https, mailto)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, linkText, url) => {
      // Validate URL scheme to prevent javascript: and other dangerous protocols
      const safeUrl = /^(https?:|mailto:|#|\/)/i.test(url) ? url : '#';
      return `<a href="${safeUrl}" class="text-blue-600 underline" target="_blank" rel="noopener noreferrer">${linkText}</a>`;
    })
    // Line breaks
    .replace(/\n/g, '<br />');

  // SECURITY: Sanitize the final HTML with DOMPurify
  // Configure to allow only safe tags and attributes
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ['pre', 'code', 'strong', 'em', 'a', 'br'],
    ALLOWED_ATTR: ['href', 'class', 'target', 'rel'],
    ALLOW_DATA_ATTR: false,
  });
}

export interface Agent {
  id: string;
  name: string;
}

export interface CommentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  filePath: string | null;
  lineStart: number | null;
  lineEnd: number | null;
  side: 'old' | 'new' | null;
  projectId: string;
  reviewId: string;
  onSubmit: (data: {
    content: string;
    commentType: CommentType;
    assignedAgentIds: string[];
    filePath: string | null;
    lineStart: number | null;
    lineEnd: number | null;
    side: 'old' | 'new' | null;
  }) => Promise<void>;
  isSubmitting?: boolean;
}

// Comment type options with icons
const COMMENT_TYPES: { value: CommentType; label: string; icon: React.ElementType }[] = [
  { value: 'comment', label: 'Comment', icon: MessageSquare },
  { value: 'suggestion', label: 'Suggestion', icon: Lightbulb },
  { value: 'issue', label: 'Issue', icon: AlertCircle },
  { value: 'approval', label: 'Approval', icon: CheckCircle2 },
];

async function fetchAgents(projectId: string): Promise<{ items: Agent[] }> {
  const res = await fetch(`/api/agents?projectId=${encodeURIComponent(projectId)}`);
  if (!res.ok) throw new Error('Failed to fetch agents');
  return res.json();
}

export function CommentDialog({
  open,
  onOpenChange,
  filePath,
  lineStart,
  lineEnd,
  side,
  projectId,
  reviewId: _reviewId,
  onSubmit,
  isSubmitting = false,
}: CommentDialogProps) {
  const [content, setContent] = useState('');
  const [commentType, setCommentType] = useState<CommentType>('comment');
  const [selectedAgentIds, setSelectedAgentIds] = useState<Set<string>>(new Set());
  const [agentSearch, setAgentSearch] = useState('');
  const [activeTab, setActiveTab] = useState<'write' | 'preview'>('write');
  const [showAllAgents, setShowAllAgents] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Fetch agents for the project
  const { data: agentsData } = useQuery({
    queryKey: ['agents', projectId],
    queryFn: () => fetchAgents(projectId),
    enabled: open && !!projectId,
  });

  const agents = agentsData?.items ?? [];

  // @ mention autocomplete
  const {
    showAutocomplete,
    mentionQuery,
    selectedIndex,
    handleInputChange,
    handleKeyDown: mentionHandleKeyDown,
    insertMention,
  } = useMentionAutocomplete(textareaRef, agents, (agent) => {
    // Auto-select agent chip when selected via Enter key
    setSelectedAgentIds((prev) => new Set([...prev, agent.id]));
  });

  // Filter agents for autocomplete dropdown
  const autocompleteAgents = useMemo(() => {
    return agents.filter((agent) => agent.name.toLowerCase().includes(mentionQuery.toLowerCase()));
  }, [agents, mentionQuery]);

  // Handle selecting an agent from autocomplete
  const handleMentionSelect = (agent: Agent) => {
    const newContent = insertMention(agent, content);
    setContent(newContent);
    // Also add to selected agents (pills)
    setSelectedAgentIds((prev) => new Set([...prev, agent.id]));
  };

  // Filter agents by search
  const filteredAgents = useMemo(() => {
    if (!agentSearch.trim()) return agents;
    const search = agentSearch.toLowerCase();
    return agents.filter((agent) => agent.name.toLowerCase().includes(search));
  }, [agents, agentSearch]);

  // Visible agents (show more in dialog since it has more space, but always include selected agents)
  const MAX_VISIBLE_AGENTS = 8;
  const visibleAgents = useMemo(() => {
    if (showAllAgents) return filteredAgents;

    const firstN = filteredAgents.slice(0, MAX_VISIBLE_AGENTS);
    // Add any selected agents that aren't already in the first N
    const selectedNotInFirstN = filteredAgents.filter(
      (agent) => selectedAgentIds.has(agent.id) && !firstN.some((a) => a.id === agent.id),
    );
    return [...firstN, ...selectedNotInFirstN];
  }, [filteredAgents, showAllAgents, selectedAgentIds]);
  const hasMoreAgents = filteredAgents.length > MAX_VISIBLE_AGENTS;

  // Build line reference display
  const lineReference = useMemo(() => {
    if (!filePath) return 'Review-level comment';
    if (lineStart === null) return filePath;
    if (lineEnd === null || lineEnd === lineStart) {
      return `${filePath}:${lineStart} (${side === 'old' ? 'old' : 'new'})`;
    }
    return `${filePath}:${lineStart}-${lineEnd} (${side === 'old' ? 'old' : 'new'})`;
  }, [filePath, lineStart, lineEnd, side]);

  // Handle submit
  const handleSubmit = async () => {
    if (!content.trim()) return;

    // Compute target agents as union of pills + parsed mentions
    const mentionedIds = parseMentions(content, agents);
    const assignedAgentIds = [...new Set([...selectedAgentIds, ...mentionedIds])];

    await onSubmit({
      content: content.trim(),
      commentType,
      assignedAgentIds,
      filePath,
      lineStart,
      lineEnd,
      side,
    });

    // Reset form
    setContent('');
    setCommentType('comment');
    setSelectedAgentIds(new Set());
    setAgentSearch('');
    setActiveTab('write');
  };

  // Handle cancel
  const handleCancel = () => {
    setContent('');
    setCommentType('comment');
    setSelectedAgentIds(new Set());
    setAgentSearch('');
    setActiveTab('write');
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MessageSquare className="h-5 w-5" />
            New Comment
          </DialogTitle>
          <DialogDescription className="flex items-center gap-2 font-mono text-xs">
            <FileCode className="h-3 w-3" />
            {lineReference}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 space-y-4 overflow-hidden">
          {/* Comment Type Selector */}
          <div className="space-y-2">
            <Label>Comment Type</Label>
            <Select value={commentType} onValueChange={(v) => setCommentType(v as CommentType)}>
              <SelectTrigger className="w-[200px]" aria-label="Select comment type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {COMMENT_TYPES.map((type) => {
                  const Icon = type.icon;
                  return (
                    <SelectItem key={type.value} value={type.value}>
                      <div className="flex items-center gap-2">
                        <Icon className="h-4 w-4" />
                        {type.label}
                      </div>
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </div>

          {/* Markdown Editor with Preview */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Content</Label>
              <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as 'write' | 'preview')}>
                <TabsList className="h-8">
                  <TabsTrigger value="write" className="text-xs px-2 h-6">
                    <Edit3 className="h-3 w-3 mr-1" />
                    Write
                  </TabsTrigger>
                  <TabsTrigger value="preview" className="text-xs px-2 h-6">
                    <Eye className="h-3 w-3 mr-1" />
                    Preview
                  </TabsTrigger>
                </TabsList>
              </Tabs>
            </div>

            {activeTab === 'write' ? (
              <div className="relative">
                <Textarea
                  ref={textareaRef}
                  value={content}
                  onChange={(e) => {
                    setContent(e.target.value);
                    handleInputChange(e.target.value, e.target.selectionStart);
                  }}
                  onKeyDown={(e) => {
                    mentionHandleKeyDown(e, content, setContent);
                  }}
                  placeholder="Write your comment... (Markdown supported, type @ to mention agents)"
                  className="min-h-[150px] font-mono text-sm"
                  disabled={isSubmitting}
                />
                {/* Autocomplete dropdown */}
                {showAutocomplete && autocompleteAgents.length > 0 && (
                  <div className="absolute bottom-full left-0 mb-1 w-48 max-h-40 overflow-auto bg-popover border rounded-md shadow-lg z-50">
                    {autocompleteAgents.map((agent, index) => (
                      <button
                        key={agent.id}
                        type="button"
                        className={cn(
                          'w-full px-3 py-1.5 text-sm text-left flex items-center gap-2 hover:bg-accent',
                          index === selectedIndex && 'bg-accent',
                        )}
                        onClick={() => handleMentionSelect(agent)}
                      >
                        <Bot className="h-3 w-3 text-muted-foreground" />
                        {agent.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div
                className="min-h-[150px] p-3 border rounded-md bg-muted/30 prose prose-sm max-w-none"
                dangerouslySetInnerHTML={{
                  __html: content.trim()
                    ? renderMarkdown(content)
                    : '<span class="text-muted-foreground">Nothing to preview</span>',
                }}
              />
            )}

            <p className="text-xs text-muted-foreground">
              Supports basic Markdown: **bold**, *italic*, `code`, ```code blocks```, [links](url)
            </p>
          </div>

          {/* Agent Assignment - Pill buttons */}
          <div className="space-y-2">
            <Label className="flex items-center gap-2">
              <Bot className="h-4 w-4" />
              Assign to Agents (optional)
            </Label>

            {agents.length > 0 ? (
              <div className="space-y-2">
                {/* Agent pills */}
                <div className="flex items-center gap-1 flex-wrap">
                  <ToggleGroup
                    type="multiple"
                    value={Array.from(selectedAgentIds)}
                    onValueChange={(values) => setSelectedAgentIds(new Set(values))}
                    className="flex-wrap !justify-start gap-1"
                  >
                    {visibleAgents.map((agent) => (
                      <ToggleGroupItem
                        key={agent.id}
                        value={agent.id}
                        size="sm"
                        variant="outline"
                        className="h-7 text-sm gap-1 px-2 data-[state=on]:!bg-primary data-[state=on]:!text-primary-foreground"
                        aria-label={`Assign to ${agent.name}`}
                      >
                        <Bot className="h-3 w-3" />
                        {agent.name}
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                  {visibleAgents.length === 0 && agentSearch.trim() && (
                    <p className="text-sm text-muted-foreground py-2">No agents found</p>
                  )}
                  {hasMoreAgents && !showAllAgents && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-sm px-2"
                      onClick={() => setShowAllAgents(true)}
                    >
                      +{filteredAgents.length - MAX_VISIBLE_AGENTS} more
                    </Button>
                  )}
                </div>

                {/* Search and expanded scroll when showing all agents */}
                {showAllAgents && (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <div className="relative flex-1">
                        <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                        <Input
                          value={agentSearch}
                          onChange={(e) => setAgentSearch(e.target.value)}
                          placeholder="Search agents..."
                          className="pl-8"
                        />
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setShowAllAgents(false);
                          setAgentSearch('');
                        }}
                      >
                        Collapse
                      </Button>
                    </div>
                  </div>
                )}

                {/* Selected count indicator */}
                {selectedAgentIds.size > 0 ? (
                  <p className="text-xs text-muted-foreground">
                    {selectedAgentIds.size} agent{selectedAgentIds.size > 1 ? 's' : ''} selected
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    No agents selected — no notifications will be sent
                  </p>
                )}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground py-2">No agents available</p>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleCancel} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!content.trim() || isSubmitting}>
            {isSubmitting ? 'Posting...' : 'Post Comment'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
