import { BoardPageView } from '@/ui/pages/board/BoardPageView';
import { ExternalBoardNav } from '@/ui/components/board/ExternalBoardNav';
import { useBoardPageController } from '@/ui/hooks/useBoardPageController';

export function BoardPage() {
  const presentation = useBoardPageController();
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <ExternalBoardNav className="shrink-0" />
      <div className="min-h-0 flex-1">
        <BoardPageView presentation={presentation} />
      </div>
    </div>
  );
}
