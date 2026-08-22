import { Link } from 'react-router-dom';
import { ExternalBoardNav } from '@/ui/components/board/ExternalBoardNav';

/** Shared fallback for `/board/:provider...` routes whose provider segment is unknown. */
export function UnknownExternalBoardProviderPage() {
  return (
    <div className="flex h-full flex-col">
      <ExternalBoardNav />
      <div className="flex-1 overflow-y-auto px-4 py-6">
        <h1 className="text-2xl font-semibold">Unknown board provider</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          No external board provider matches this address.{' '}
          <Link to="/board" className="underline underline-offset-2">
            Return to the DevChain board
          </Link>
          .
        </p>
      </div>
    </div>
  );
}
