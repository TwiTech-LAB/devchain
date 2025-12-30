import { useState, useCallback } from 'react';
import { useSelectedProject } from '@/ui/hooks/useProjectSelection';
import { PageHeader, EmptyState } from '@/ui/components/shared';
import {
  CurrentPoolsPanel,
  MessageActivityList,
  MessageDetailDrawer,
  MessageFiltersPanel,
  type MessageLogPreview,
  type MessageFilters,
} from '@/ui/components/messages';
import { FolderOpen } from 'lucide-react';

export function MessagesPage() {
  const { selectedProject } = useSelectedProject();
  const [filters, setFilters] = useState<MessageFilters>({});
  const [selectedMessage, setSelectedMessage] = useState<MessageLogPreview | null>(null);

  const handleFiltersChange = useCallback((newFilters: MessageFilters) => {
    setFilters(newFilters);
  }, []);

  const handleMessageClick = useCallback((message: MessageLogPreview) => {
    setSelectedMessage(message);
  }, []);

  const handleDrawerClose = useCallback(() => {
    setSelectedMessage(null);
  }, []);

  if (!selectedProject) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <EmptyState
          icon={FolderOpen}
          title="No project selected"
          description="Select a project to view message activity"
        />
      </div>
    );
  }

  const handleAgentClick = (agentId: string) => {
    // Toggle selection: if same agent clicked, clear agent filter; otherwise set it
    setFilters((prev) => ({
      ...prev,
      agentId: prev.agentId === agentId ? undefined : agentId,
    }));
  };

  return (
    <div className="flex flex-col gap-6 h-full">
      <PageHeader title="Messages" description="Monitor message pools and delivery activity" />

      <CurrentPoolsPanel
        projectId={selectedProject.id}
        onAgentClick={handleAgentClick}
        selectedAgentId={filters.agentId}
      />

      <MessageFiltersPanel
        projectId={selectedProject.id}
        filters={filters}
        onChange={handleFiltersChange}
      />

      <MessageActivityList
        projectId={selectedProject.id}
        filters={Object.keys(filters).length > 0 ? filters : undefined}
        onMessageClick={handleMessageClick}
      />

      <MessageDetailDrawer message={selectedMessage} onClose={handleDrawerClose} />
    </div>
  );
}
