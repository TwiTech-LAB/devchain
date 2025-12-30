import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/components/ui/dialog';
import { Button } from '@/ui/components/ui/button';
import { Input } from '@/ui/components/ui/input';
import { Label } from '@/ui/components/ui/label';
import { Checkbox } from '@/ui/components/ui/checkbox';
import { ScrollArea } from '@/ui/components/ui/scroll-area';

interface Agent {
  id: string;
  name: string;
}

interface GroupCreationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agents: Agent[];
  onCreateGroup: (selectedAgentIds: string[], title?: string) => Promise<void>;
}

export function GroupCreationDialog({
  open,
  onOpenChange,
  agents,
  onCreateGroup,
}: GroupCreationDialogProps) {
  const [selectedAgentIds, setSelectedAgentIds] = useState<string[]>([]);
  const [groupTitle, setGroupTitle] = useState('');
  const [isCreating, setIsCreating] = useState(false);

  const handleToggleAgent = (agentId: string) => {
    setSelectedAgentIds((prev) => {
      if (prev.includes(agentId)) {
        return prev.filter((id) => id !== agentId);
      }
      return [...prev, agentId];
    });
  };

  const handleCreate = async () => {
    if (selectedAgentIds.length < 2) {
      return;
    }

    setIsCreating(true);
    try {
      await onCreateGroup(selectedAgentIds, groupTitle || undefined);
      // Reset state
      setSelectedAgentIds([]);
      setGroupTitle('');
      onOpenChange(false);
    } finally {
      setIsCreating(false);
    }
  };

  const handleCancel = () => {
    setSelectedAgentIds([]);
    setGroupTitle('');
    onOpenChange(false);
  };

  const defaultTitle = selectedAgentIds
    .map((id) => agents.find((a) => a.id === id)?.name)
    .filter(Boolean)
    .join(', ');

  const displayTitle = groupTitle || defaultTitle;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Create New Group</DialogTitle>
          <DialogDescription>
            Select at least two agents to create a group chat. You can optionally provide a custom
            title.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="group-title">Group Title (optional)</Label>
            <Input
              id="group-title"
              placeholder={defaultTitle || 'Enter group title...'}
              value={groupTitle}
              onChange={(e) => setGroupTitle(e.target.value)}
              disabled={isCreating}
            />
            {displayTitle && (
              <p className="text-xs text-muted-foreground">Preview: {displayTitle}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label>Select Agents ({selectedAgentIds.length} selected)</Label>
            <ScrollArea className="h-[200px] rounded-md border p-3">
              <div className="space-y-3">
                {agents.map((agent) => (
                  <div key={agent.id} className="flex items-center space-x-2">
                    <Checkbox
                      id={`agent-${agent.id}`}
                      checked={selectedAgentIds.includes(agent.id)}
                      onCheckedChange={() => handleToggleAgent(agent.id)}
                      disabled={isCreating}
                    />
                    <label
                      htmlFor={`agent-${agent.id}`}
                      className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 cursor-pointer"
                    >
                      {agent.name}
                    </label>
                  </div>
                ))}
                {agents.length === 0 && (
                  <p className="text-sm text-muted-foreground">No agents available</p>
                )}
              </div>
            </ScrollArea>
            {selectedAgentIds.length < 2 && selectedAgentIds.length > 0 && (
              <p className="text-xs text-destructive">Select at least 2 agents</p>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleCancel} disabled={isCreating}>
            Cancel
          </Button>
          <Button onClick={handleCreate} disabled={selectedAgentIds.length < 2 || isCreating}>
            {isCreating ? 'Creating...' : 'Create Group'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
