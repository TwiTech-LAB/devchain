import { useQuery } from '@tanstack/react-query';
import { useSelectedProject } from '@/ui/hooks/useProjectSelection';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/ui/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/ui/components/ui/alert';
import { Label } from '@/ui/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/components/ui/select';
import { AlertCircle, Loader2 } from 'lucide-react';
import { useSettingsData } from './useSettingsData';

interface PromptSummary {
  id: string;
  title: string;
}

interface PromptsResponse {
  items: PromptSummary[];
}

async function fetchPrompts(projectId: string): Promise<PromptsResponse> {
  const res = await fetch(`/api/prompts?projectId=${encodeURIComponent(projectId)}`);
  if (!res.ok) throw new Error('Failed to fetch prompts');
  return res.json();
}

export function GeneralSection() {
  const { selectedProject } = useSelectedProject();
  const { settings, updateInitialPromptMutation } = useSettingsData();

  const { data: promptsData, isLoading: promptsLoading } = useQuery({
    queryKey: ['prompts', selectedProject?.id ?? null],
    queryFn: () => fetchPrompts(selectedProject?.id as string),
    enabled: !!selectedProject?.id,
  });

  const selectedPromptId =
    (selectedProject?.id && settings?.initialSessionPromptIds?.[selectedProject.id]) ?? null;
  const selectValue = selectedPromptId ?? '__none__';
  const currentPrompt = selectedPromptId
    ? promptsData?.items?.find((prompt) => prompt.id === selectedPromptId)
    : undefined;
  const promptCount = promptsData?.items?.length ?? 0;
  const disablePromptSelect =
    !settings || promptsLoading || updateInitialPromptMutation.isPending || !selectedProject?.id;

  const handleInitialPromptChange = (value: string) => {
    const normalized = value === '__none__' ? null : value;
    if (normalized === selectedPromptId) return;
    updateInitialPromptMutation.mutate({
      initialSessionPromptId: normalized,
      projectId: selectedProject?.id,
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Initial Session Prompt</CardTitle>
        <CardDescription>
          Choose which prompt is pasted into new sessions before the agent begins.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="initial-session-prompt">Initial prompt</Label>
            <Select
              value={selectValue}
              onValueChange={handleInitialPromptChange}
              disabled={disablePromptSelect}
            >
              <SelectTrigger id="initial-session-prompt">
                <SelectValue placeholder={promptsLoading ? 'Loading prompts…' : 'Select prompt'} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">None (use default message)</SelectItem>
                {promptsData?.items?.map((prompt) => (
                  <SelectItem key={prompt.id} value={prompt.id}>
                    {prompt.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {promptsLoading && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading prompts…
            </div>
          )}

          {updateInitialPromptMutation.isPending && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Saving selection…
            </div>
          )}

          {!promptsLoading && promptCount === 0 && (
            <p className="text-sm text-muted-foreground">
              No prompts available yet. Create one on the{' '}
              <a href="/prompts" className="font-semibold underline hover:text-primary">
                Prompts
              </a>{' '}
              page.
            </p>
          )}

          {!promptsLoading && selectedPromptId && currentPrompt && (
            <p className="text-sm text-muted-foreground">
              Selected prompt:{' '}
              <span className="font-semibold text-foreground">{currentPrompt.title}</span>
            </p>
          )}

          {!promptsLoading && selectedPromptId && !currentPrompt && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>Prompt missing</AlertTitle>
              <AlertDescription>
                The previously selected prompt could not be found. Pick another prompt to ensure
                sessions start with the right instructions.
              </AlertDescription>
            </Alert>
          )}

          {!promptsLoading && !selectedPromptId && (
            <p className="text-sm text-muted-foreground">
              Using the default built-in message until a prompt is selected.
            </p>
          )}

          <p className="text-xs text-muted-foreground">
            Supported variables: <code className="font-mono text-xs">{`{agent_name}`}</code>,{' '}
            <code className="font-mono text-xs">{`{project_name}`}</code>,{' '}
            <code className="font-mono text-xs">{`{epic_title}`}</code>,{' '}
            <code className="font-mono text-xs">{`{provider_name}`}</code>,{' '}
            <code className="font-mono text-xs">{`{profile_name}`}</code>,{' '}
            <code className="font-mono text-xs">{`{session_id}`}</code>,{' '}
            <code className="font-mono text-xs">{`{session_id_short}`}</code>
          </p>

          <p className="text-xs text-muted-foreground">
            Need to edit the prompt content? Visit the{' '}
            <a href="/prompts" className="font-semibold underline hover:text-primary">
              Prompts
            </a>{' '}
            page.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
