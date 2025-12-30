import { Link, useNavigate } from 'react-router-dom';
import { ShieldOff, ArrowLeft, LayoutGrid } from 'lucide-react';
import { Button } from '@/ui/components/ui/button';

export function RecordsDisabledPage() {
  const navigate = useNavigate();

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center px-4 text-center">
      <div className="max-w-xl space-y-6 rounded-lg border bg-card p-8 shadow-sm">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-muted">
          <ShieldOff className="h-6 w-6 text-muted-foreground" />
        </div>

        <div className="space-y-2">
          <h1 className="text-2xl font-semibold">Records is currently disabled</h1>
          <p className="text-sm text-muted-foreground">
            The Records feature is hidden for this release. Existing records remain intact and will
            return when the feature is re-enabled.
          </p>
        </div>

        <div className="flex flex-col items-center gap-3 sm:flex-row sm:justify-center">
          <Button asChild>
            <Link to="/projects">
              <LayoutGrid className="mr-2 h-4 w-4" />
              Go to Projects
            </Link>
          </Button>
          <Button variant="outline" onClick={() => navigate(-1)}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            Go Back
          </Button>
        </div>
      </div>
    </div>
  );
}
