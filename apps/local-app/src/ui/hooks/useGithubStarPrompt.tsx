import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  GITHUB_STAR_CHANGED_EVENT,
  type GithubStarAction,
  type GithubStarActionResponse,
  type GithubStarPendingView,
} from '@/modules/github-star/github-star.dto';
import {
  exactTopic,
  type RealtimeInvalidationRegistry,
} from '@/ui/lib/realtime-invalidation-registry';
import { useToast } from './use-toast';
import { useHomeFetch } from './useFetchFactory';
import { useHomeSocket } from './useHomeSocket';
import { useRealtimeDispatch } from './useRealtimeDispatch';

type GithubStarPrompt = GithubStarPendingView;

function toPrompt(value: unknown): GithubStarPrompt | null {
  if (!value || typeof value !== 'object') return null;
  const { id, reason, mode, url } = value as Record<string, unknown>;
  if (typeof id !== 'string' || !id || typeof url !== 'string' || !url) return null;
  if (mode !== 'gh' && mode !== 'web') return null;
  return { id, reason: reason === 'phase-done' ? 'phase-done' : 'launches', mode, url };
}

export interface GithubStarPromptState {
  prompt: GithubStarPrompt | null;
  starring: boolean;
  /**
   * Sends one action for the shown prompt. A prompt gets at most one closing
   * action and one star request; closing wins over a star still in flight.
   */
  act: (action: GithubStarAction) => void;
}

/**
 * Instance-level prompt state, always read from and written to the home backend
 * whichever project (local or remote) is selected. Not cached across mounts: each
 * mount reads home again.
 *
 * Every GET and POST takes a sequence number when it starts, and a response is
 * applied only if no request started after it has already been applied. So an
 * older GET cannot overwrite an action's result, and an action response cannot
 * overwrite a view read after the action was sent. One exception: a GET that
 * overlaps a star request can read the prompt in `gh` mode before the star
 * commits. The star result therefore applies over such a view, and once a star has
 * settled, that prompt in `gh` mode is never shown again (the server always
 * clears it or switches it to `web`).
 *
 * A confirmed star (`starred`) is final for its prompt: it replaces any view of
 * that prompt, in either mode, whatever the order (another tab's failed star can
 * make a newer GET show the prompt in `web` mode first), and that prompt is never
 * shown again. A view of another prompt is left alone.
 */
export function useGithubStarPrompt(): GithubStarPromptState {
  const homeFetch = useHomeFetch();
  const { toast } = useToast();
  const [view, setView] = useState<GithubStarPrompt | null>(null);
  const [closedIds, setClosedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [starringId, setStarringId] = useState<string | null>(null);

  const nextSeq = useRef(0);
  const appliedSeq = useRef(0);
  const mounted = useRef(true);
  // Synchronous mirrors of the state above, so two events in the same tick
  // (double click, × then Escape) see each other.
  const closedRef = useRef(new Set<string>());
  const starringRef = useRef<string | null>(null);

  const viewRef = useRef<GithubStarPrompt | null>(null);
  // Prompt id → whether its settled star request starred the repo.
  const settledStars = useRef(new Map<string, boolean>());

  const applyView = useCallback(
    (
      seq: number,
      next: GithubStarPrompt | null,
      settledStar?: { promptId: string; starred: boolean },
    ): void => {
      const isPreStarView = (view: GithubStarPrompt | null): boolean =>
        view !== null && view.mode === 'gh' && settledStars.current.has(view.id);
      const isStarredView = (view: GithubStarPrompt | null): boolean =>
        view !== null && settledStars.current.get(view.id) === true;
      if (!mounted.current || isPreStarView(next) || isStarredView(next)) return;
      if (settledStar !== undefined && !settledStars.current.get(settledStar.promptId)) {
        settledStars.current.set(settledStar.promptId, settledStar.starred);
      }
      const supersedes =
        settledStar?.starred === true && viewRef.current?.id === settledStar.promptId;
      if (seq <= appliedSeq.current && !isPreStarView(viewRef.current) && !supersedes) return;
      appliedSeq.current = Math.max(appliedSeq.current, seq);
      viewRef.current = next;
      setView(next);
    },
    [],
  );

  const reload = useCallback(() => {
    const seq = ++nextSeq.current;
    void (async () => {
      try {
        const response = await homeFetch('/api/github-star');
        if (!response.ok) return;
        const body = (await response.json()) as { pending?: unknown } | null;
        applyView(seq, toPrompt(body?.pending));
      } catch {
        // The next reconnect or github_star_changed event reads again.
      }
    })();
  }, [applyView, homeFetch]);

  useEffect(() => {
    mounted.current = true;
    reload();
    return () => {
      mounted.current = false;
    };
  }, [reload]);

  const registry = useMemo<RealtimeInvalidationRegistry>(
    () => [
      {
        match: exactTopic('system'),
        type: GITHUB_STAR_CHANGED_EVENT,
        entries: [{ kind: 'custom-handler', handler: reload }],
      },
    ],
    [reload],
  );
  useRealtimeDispatch(registry, { socket: 'home' });
  const socketHandlers = useMemo(() => ({ connect: reload }), [reload]);
  useHomeSocket(socketHandlers, [reload]);

  const setClosed = useCallback((promptId: string, closed: boolean) => {
    if (closed) closedRef.current.add(promptId);
    else closedRef.current.delete(promptId);
    setClosedIds(new Set(closedRef.current));
  }, []);

  const prompt = view && !closedIds.has(view.id) ? view : null;

  const act = useCallback(
    (action: GithubStarAction) => {
      if (!prompt || closedRef.current.has(prompt.id)) return;
      const promptId = prompt.id;
      const closes = action !== 'star';
      if (closes) {
        setClosed(promptId, true);
      } else {
        if (starringRef.current === promptId) return;
        starringRef.current = promptId;
        setStarringId(promptId);
      }

      const seq = ++nextSeq.current;
      void (async () => {
        try {
          const response = await homeFetch('/api/github-star/action', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ promptId, action }),
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const body = (await response.json()) as Partial<GithubStarActionResponse> | null;
          const outcome = action === 'star' ? body?.result : undefined;

          let next = toPrompt(body?.pending);
          if (outcome === 'fallback') {
            // The card must stay on the repo link even if the response omits the pending view.
            next = { ...(next ?? prompt), mode: 'web' };
            if (typeof body?.url === 'string' && body.url) next = { ...next, url: body.url };
          }
          applyView(
            seq,
            next,
            outcome !== undefined ? { promptId, starred: outcome === 'starred' } : undefined,
          );
          if (mounted.current && outcome === 'starred') {
            toast({ title: 'Thanks for the star!' });
          }
        } catch {
          if (!mounted.current) return;
          if (closes) setClosed(promptId, false);
          else if (closedRef.current.has(promptId)) return;
          toast({
            title: 'Could not save your choice',
            description: 'Try again in a moment.',
            variant: 'destructive',
          });
        } finally {
          if (!closes && starringRef.current === promptId) {
            starringRef.current = null;
            if (mounted.current) setStarringId(null);
          }
        }
      })();
    },
    [applyView, homeFetch, prompt, setClosed, toast],
  );

  return { prompt, starring: prompt !== null && starringId === prompt.id, act };
}
