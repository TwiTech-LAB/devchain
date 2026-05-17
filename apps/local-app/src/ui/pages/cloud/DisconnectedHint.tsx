import { Bell } from 'lucide-react';
import { Button } from '@/ui/components/ui/button';
import { Card, CardContent } from '@/ui/components/ui/card';

interface DisconnectedHintProps {
  onNavigateToAccount: () => void;
}

export function DisconnectedHint({ onNavigateToAccount }: DisconnectedHintProps) {
  return (
    <Card className="max-w-sm border-dashed">
      <CardContent className="flex flex-col items-center gap-3 py-8 text-center">
        <Bell className="h-8 w-8 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          Sign in to DevChain Cloud to manage notifications.
        </p>
        <Button variant="outline" size="sm" onClick={onNavigateToAccount}>
          Go to Account →
        </Button>
      </CardContent>
    </Card>
  );
}
