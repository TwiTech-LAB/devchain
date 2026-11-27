import { useEffect } from 'react';
import { Star, X } from 'lucide-react';
import { Button } from './ui/button';
import { useGithubStarPrompt } from '../hooks/useGithubStarPrompt';

const MESSAGE =
  'DevChain is open source. If it helped today, a GitHub star helps other developers find it.';

/**
 * A dedicated card, not a toast: the shared toaster evicts old toasts, replaces
 * `onOpenChange` and dismisses on any click, and this prompt must stay until the
 * user picks an action.
 */
export function GithubStarPrompt() {
  const { prompt, starring, act } = useGithubStarPrompt();
  const visible = prompt !== null;

  useEffect(() => {
    if (!visible) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      // Escape that closes an open dialog belongs to that dialog.
      if (
        document.querySelector(
          '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]',
        )
      ) {
        return;
      }
      act('later');
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [visible, act]);

  if (!prompt) return null;

  return (
    <section
      role="status"
      aria-live="polite"
      aria-label="Star DevChain on GitHub"
      className="fixed bottom-4 right-4 z-[90] w-[calc(100vw-2rem)] max-w-[380px] rounded-md border bg-background p-4 pr-10 text-foreground shadow-lg"
    >
      <button
        type="button"
        aria-label="Close"
        className="absolute right-2 top-2 rounded-md p-1 text-muted-foreground hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
        onClick={() => act('later')}
      >
        <X className="h-4 w-4" />
      </button>
      <p className="text-sm">{MESSAGE}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {prompt.mode === 'gh' ? (
          <Button size="sm" pending={starring} onClick={() => act('star')}>
            {!starring && <Star className="mr-2 h-4 w-4" />}
            Star on GitHub
          </Button>
        ) : (
          <Button size="sm" asChild>
            <a
              href={prompt.url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => act('opened')}
              // A middle-click opens the link in a new tab too; record it the same way.
              onAuxClick={(event) => {
                if (event.button === 1) act('opened');
              }}
            >
              <Star className="mr-2 h-4 w-4" />
              Star on GitHub
            </a>
          </Button>
        )}
        <Button size="sm" variant="outline" onClick={() => act('later')}>
          Later
        </Button>
        <Button size="sm" variant="ghost" onClick={() => act('never')}>
          Don&apos;t ask again
        </Button>
      </div>
    </section>
  );
}
