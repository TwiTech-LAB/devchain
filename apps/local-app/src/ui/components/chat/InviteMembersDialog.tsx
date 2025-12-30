import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/components/ui/dialog';
import { Button } from '@/ui/components/ui/button';
import { Checkbox } from '@/ui/components/ui/checkbox';
import { ScrollArea } from '@/ui/components/ui/scroll-area';
import { Label } from '@/ui/components/ui/label';
import { Input } from '@/ui/components/ui/input';

interface AgentOption {
  id: string;
  name: string;
}

interface InviteMembersDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agents: AgentOption[];
  existingMemberIds: string[];
  onInvite: (agentIds: string[], inviterName?: string) => Promise<void>;
  isSubmitting?: boolean;
}

export function InviteMembersDialog({
  open,
  onOpenChange,
  agents,
  existingMemberIds,
  onInvite,
  isSubmitting = false,
}: InviteMembersDialogProps) {
  const [selectedAgents, setSelectedAgents] = useState<string[]>([]);
  const [inviterName, setInviterName] = useState('');

  useEffect(() => {
    if (!open) {
      setSelectedAgents([]);
      setInviterName('');
    }
  }, [open]);

  const toggleAgent = (agentId: string) => {
    setSelectedAgents((prev) =>
      prev.includes(agentId) ? prev.filter((id) => id !== agentId) : [...prev, agentId],
    );
  };

  const availableAgents = agents.filter((agent) => !existingMemberIds.includes(agent.id));

  const handleInvite = async () => {
    if (selectedAgents.length === 0) {
      return;
    }

    try {
      await onInvite(selectedAgents, inviterName.trim() || undefined);
      setSelectedAgents([]);
      setInviterName('');
      onOpenChange(false);
    } catch {
      // Parent mutation handles toast feedback; keep dialog open for correction.
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Invite Agents</DialogTitle>
          <DialogDescription>
            Select one or more agents to add to this thread. Each invite posts a system message with
            the configured template.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="invite-display-name">Display Name (optional)</Label>
            <Input
              id="invite-display-name"
              placeholder="Defaults to You"
              value={inviterName}
              onChange={(event) => setInviterName(event.target.value)}
              disabled={isSubmitting}
            />
          </div>

          <div className="space-y-2">
            <Label>Agents ({selectedAgents.length} selected)</Label>
            <ScrollArea className="h-[220px] rounded-md border p-3">
              <div className="space-y-3">
                {availableAgents.map((agent) => (
                  <div key={agent.id} className="flex items-center space-x-2">
                    <Checkbox
                      id={`invite-agent-${agent.id}`}
                      checked={selectedAgents.includes(agent.id)}
                      onCheckedChange={() => toggleAgent(agent.id)}
                      disabled={isSubmitting}
                    />
                    <label
                      htmlFor={`invite-agent-${agent.id}`}
                      className="cursor-pointer text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
                    >
                      {agent.name}
                    </label>
                  </div>
                ))}
                {availableAgents.length === 0 && (
                  <p className="text-sm text-muted-foreground">All agents are already members.</p>
                )}
              </div>
            </ScrollArea>
            {selectedAgents.length === 0 && availableAgents.length > 0 && (
              <p className="text-xs text-muted-foreground">Select at least one agent to invite.</p>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button
            onClick={handleInvite}
            disabled={selectedAgents.length === 0 || isSubmitting || availableAgents.length === 0}
          >
            {isSubmitting ? 'Inviting…' : 'Send Invites'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
