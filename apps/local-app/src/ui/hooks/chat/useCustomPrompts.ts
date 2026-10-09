import { useCallback, useEffect, useState } from 'react';
import {
  fetchPrompts,
  type Prompt,
  type PromptSummary,
  type PromptsResponse,
} from '@/ui/lib/prompts';
import { getPromptType, PROMPT_TYPE } from '@/common/prompt-type';

export type PromptFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface CustomPromptApiTarget {
  projectId: string;
  fetchFn: PromptFetch;
}

interface UseCustomPromptsResult {
  prompts: PromptSummary[];
  isLoading: boolean;
  error: string | null;
  removePrompt: (promptId: string) => void;
}

const PROMPT_PAGE_LIMIT = 10_000;

function promptDetailUrl(_target: CustomPromptApiTarget, promptId: string): string {
  return `/api/prompts/${encodeURIComponent(promptId)}`;
}

async function readJson<T>(response: Response, fallbackMessage: string): Promise<T> {
  if (!response.ok) {
    throw new Error(fallbackMessage);
  }
  return response.json() as Promise<T>;
}

async function fetchPromptPage(
  target: CustomPromptApiTarget,
  offset: number,
  signal?: AbortSignal,
): Promise<PromptsResponse> {
  const page = await fetchPrompts(
    target.fetchFn,
    target.projectId,
    { limit: PROMPT_PAGE_LIMIT, offset },
    signal,
  );
  if (!Array.isArray(page.items)) {
    throw new Error('The custom prompt list response is invalid.');
  }
  return page;
}

export async function fetchCustomPrompts(
  target: CustomPromptApiTarget,
  signal?: AbortSignal,
): Promise<PromptSummary[]> {
  const firstPage = await fetchPromptPage(target, 0, signal);
  let allPrompts = firstPage.items;

  if (typeof firstPage.total === 'number' && firstPage.total > firstPage.items.length) {
    const secondPage = await fetchPromptPage(target, firstPage.items.length, signal);
    const promptsById = new Map(allPrompts.map((prompt) => [prompt.id, prompt]));
    secondPage.items.forEach((prompt) => promptsById.set(prompt.id, prompt));
    allPrompts = Array.from(promptsById.values());

    if (allPrompts.length < firstPage.total) {
      throw new Error(
        `Only ${allPrompts.length} of ${firstPage.total} prompts could be loaded. Refine the project prompt list and try again.`,
      );
    }
  }

  return allPrompts.filter(
    (prompt) =>
      prompt.projectId === target.projectId &&
      getPromptType(prompt.tags ?? [], PROMPT_TYPE.System) === PROMPT_TYPE.Custom,
  );
}

export async function fetchValidatedCustomPrompt(
  target: CustomPromptApiTarget,
  promptId: string,
  signal?: AbortSignal,
): Promise<Prompt> {
  const response = await target.fetchFn(promptDetailUrl(target, promptId), { signal });
  const prompt = await readJson<Prompt>(response, 'Failed to load the selected custom prompt.');

  if (prompt.id !== promptId) {
    throw new Error('The selected prompt response does not match the requested prompt.');
  }
  if (prompt.projectId !== target.projectId) {
    throw new Error('The selected prompt no longer belongs to this project.');
  }
  if (getPromptType(prompt.tags ?? [], PROMPT_TYPE.System) !== PROMPT_TYPE.Custom) {
    throw new Error('The selected prompt is no longer a custom prompt.');
  }
  if (typeof prompt.content !== 'string') {
    throw new Error('The selected custom prompt has invalid content.');
  }

  return prompt;
}

export async function deleteCustomPrompt(
  target: CustomPromptApiTarget,
  promptId: string,
): Promise<void> {
  const response = await target.fetchFn(promptDetailUrl(target, promptId), { method: 'DELETE' });
  if (!response.ok) {
    throw new Error('Failed to delete the custom prompt.');
  }
}

export function useCustomPrompts(
  open: boolean,
  target: CustomPromptApiTarget,
): UseCustomPromptsResult {
  const [prompts, setPrompts] = useState<PromptSummary[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    const controller = new AbortController();
    setPrompts([]);
    setError(null);
    setIsLoading(true);

    void fetchCustomPrompts(target, controller.signal)
      .then((nextPrompts) => {
        setPrompts(nextPrompts);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) {
          return;
        }
        setError(cause instanceof Error ? cause.message : 'Failed to load custom prompts.');
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setIsLoading(false);
        }
      });

    return () => controller.abort();
  }, [open, target]);

  const removePrompt = useCallback((promptId: string) => {
    setPrompts((current) => current.filter((prompt) => prompt.id !== promptId));
  }, []);

  return { prompts, isLoading, error, removePrompt };
}
