import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
import { ScrollArea } from '@/ui/components/ui/scroll-area';
import { Alert, AlertDescription, AlertTitle } from '@/ui/components/ui/alert';
import {
  DEFAULT_INVITE_TEMPLATE,
  INVITE_TEMPLATE_SNIPPETS,
  INVITE_TEMPLATE_VARIABLES,
  TEMPLATE_SIZE_LIMIT,
  findUnknownTokens,
  renderInviteTemplate,
} from '@/ui/lib/invite-template';
import { fetchChatSettings, updateChatSettings, type ChatSettingsResponse } from '@/ui/lib/chat';
import { useToast } from '@/ui/hooks/use-toast';

interface ThreadPreviewContext {
  threadId: string | null;
  threadTitle: string;
  participantNames: string[];
}

interface ChatSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string | null;
  threadContext: ThreadPreviewContext;
  sampleInviteeName: string;
}

export function ChatSettingsDialog({
  open,
  onOpenChange,
  projectId,
  threadContext,
  sampleInviteeName,
}: ChatSettingsDialogProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [template, setTemplate] = useState(DEFAULT_INVITE_TEMPLATE);
  const [initialTemplate, setInitialTemplate] = useState(DEFAULT_INVITE_TEMPLATE);
  const [createdAtPreview, setCreatedAtPreview] = useState(() => new Date().toISOString());
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const validProjectId = projectId && projectId !== 'placeholder-project-id' ? projectId : null;

  const settingsQuery = useQuery<ChatSettingsResponse>({
    queryKey: ['chat-settings', validProjectId],
    queryFn: () => fetchChatSettings(validProjectId!),
    enabled: open && Boolean(validProjectId),
    staleTime: 1000 * 30,
  });

  useEffect(() => {
    if (open) {
      setCreatedAtPreview(new Date().toISOString());
    }
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }

    if (settingsQuery.data) {
      setTemplate(settingsQuery.data.invite_template);
      setInitialTemplate(settingsQuery.data.invite_template);
    } else if (!validProjectId) {
      setTemplate(DEFAULT_INVITE_TEMPLATE);
      setInitialTemplate(DEFAULT_INVITE_TEMPLATE);
    }
  }, [open, settingsQuery.data, validProjectId]);

  useEffect(() => {
    if (!open) {
      return;
    }

    if (settingsQuery.error) {
      const message =
        settingsQuery.error instanceof Error ? settingsQuery.error.message : 'Unknown error';
      toast({
        title: 'Unable to load chat settings',
        description: message,
        variant: 'destructive',
      });
    }
  }, [open, settingsQuery.error, toast]);

  const unknownTokens = useMemo(() => findUnknownTokens(template), [template]);
  const isTooLong = template.length > TEMPLATE_SIZE_LIMIT;
  const isDirty = template !== initialTemplate;
  const participantNames = threadContext.participantNames.join(', ');

  const preview = useMemo(
    () =>
      renderInviteTemplate(template, {
        threadId: threadContext.threadId ?? 'thread-id-preview',
        threadTitle: threadContext.threadTitle || 'Chat Thread',
        inviterName: 'You',
        participantNames: participantNames || 'No other agents yet',
        invitedAgentName: sampleInviteeName,
        createdAt: createdAtPreview,
      }),
    [template, threadContext, participantNames, sampleInviteeName, createdAtPreview],
  );

  const mutation = useMutation({
    mutationFn: () => {
      if (!validProjectId) {
        throw new Error('Project selection required');
      }

      const trimmed = template.trim();
      // Persist empty string when reverting to default template.
      const payload =
        trimmed.length === 0 || trimmed === DEFAULT_INVITE_TEMPLATE.trim() ? '' : template;

      return updateChatSettings({ projectId: validProjectId, invite_template: payload });
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['chat-settings', validProjectId] });
      setTemplate(data.invite_template);
      setInitialTemplate(data.invite_template);
      toast({ title: 'Chat settings updated', description: 'Invite template saved successfully.' });
      onOpenChange(false);
    },
    onError: (error: unknown) => {
      const message = error instanceof Error ? error.message : 'Failed to save invite template';
      toast({ title: 'Unable to save template', description: message, variant: 'destructive' });
    },
  });

  const handleInsertToken = (token: string) => {
    const textarea = textareaRef.current;
    const snippet = `{{ ${token} }}`;

    if (!textarea) {
      setTemplate((current) => `${current}${snippet}`);
      return;
    }

    const { selectionStart, selectionEnd } = textarea;
    const next =
      template.slice(0, selectionStart) + snippet + template.slice(selectionEnd, template.length);
    setTemplate(next);

    requestAnimationFrame(() => {
      const cursor = selectionStart + snippet.length;
      textarea.selectionStart = cursor;
      textarea.selectionEnd = cursor;
      textarea.focus();
    });
  };

  const handleSave = () => {
    mutation.mutate();
  };

  const handleResetToDefault = () => {
    setTemplate(DEFAULT_INVITE_TEMPLATE);
  };

  const disableSave =
    !validProjectId ||
    settingsQuery.isLoading ||
    mutation.isPending ||
    !isDirty ||
    isTooLong ||
    unknownTokens.length > 0;

  const helperButtonClass = 'w-full justify-start text-left font-normal hover:bg-muted';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>Chat Invite Settings</DialogTitle>
          <DialogDescription>
            Configure the invite message sent to agents when they join this thread.
            <br />
            Use the preview to confirm variable output before saving.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_280px]">
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="chat-invite-template">Invite Template</Label>
              <Textarea
                id="chat-invite-template"
                ref={textareaRef}
                value={template}
                onChange={(event) => setTemplate(event.target.value)}
                disabled={!validProjectId || settingsQuery.isLoading || mutation.isPending}
                className="min-h-[220px]"
              />
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>
                  {template.length} / {TEMPLATE_SIZE_LIMIT} characters
                </span>
                <div className="flex gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleResetToDefault}
                    disabled={mutation.isPending}
                  >
                    Reset to default
                  </Button>
                </div>
              </div>
            </div>

            {unknownTokens.length > 0 && (
              <Alert variant="destructive">
                <AlertTitle>Unknown template variables</AlertTitle>
                <AlertDescription>
                  {unknownTokens.map((token) => `{{ ${token} }}`).join(', ')}
                </AlertDescription>
              </Alert>
            )}

            {isTooLong && (
              <Alert variant="destructive">
                <AlertTitle>Template too long</AlertTitle>
                <AlertDescription>
                  Reduce the template to {TEMPLATE_SIZE_LIMIT} characters or fewer.
                </AlertDescription>
              </Alert>
            )}

            {!validProjectId && (
              <Alert>
                <AlertTitle>Select a project</AlertTitle>
                <AlertDescription>
                  Choose a project to enable chat settings and save invite templates.
                </AlertDescription>
              </Alert>
            )}

            <div className="space-y-2">
              <Label>Preview</Label>
              <ScrollArea className="h-[160px] rounded-md border bg-muted/30 p-3 text-sm">
                <pre className="whitespace-pre-wrap text-left text-muted-foreground">{preview}</pre>
              </ScrollArea>
            </div>
          </div>

          <div className="space-y-4">
            <div>
              <h3 className="text-sm font-semibold">Variables</h3>
              <p className="text-xs text-muted-foreground">Click to insert at the cursor.</p>
              <div className="mt-2 space-y-1">
                {INVITE_TEMPLATE_VARIABLES.map((variable) => (
                  <Button
                    key={variable.token}
                    variant="ghost"
                    size="sm"
                    className={helperButtonClass}
                    onClick={() => handleInsertToken(variable.token)}
                    disabled={!validProjectId}
                  >
                    <span className="font-mono text-xs">{`{{ ${variable.token} }}`}</span>
                    <span className="ml-2 text-xs text-muted-foreground">
                      {variable.description}
                    </span>
                  </Button>
                ))}
              </div>
            </div>

            <div>
              <h3 className="text-sm font-semibold">Convenience Snippets</h3>
              <p className="text-xs text-muted-foreground">Automation-friendly MCP commands.</p>
              <div className="mt-2 space-y-1">
                {INVITE_TEMPLATE_SNIPPETS.map((snippet) => (
                  <Button
                    key={snippet.token}
                    variant="ghost"
                    size="sm"
                    className={helperButtonClass}
                    onClick={() => handleInsertToken(snippet.token)}
                    disabled={!validProjectId}
                  >
                    <span className="font-mono text-xs">{`{{ ${snippet.token} }}`}</span>
                    <span className="ml-2 text-xs text-muted-foreground">
                      {snippet.description}
                    </span>
                  </Button>
                ))}
              </div>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={mutation.isPending}
          >
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={disableSave}>
            {mutation.isPending ? 'Saving…' : 'Save changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
