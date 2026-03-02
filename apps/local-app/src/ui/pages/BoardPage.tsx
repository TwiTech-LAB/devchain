import { BoardPageView } from '@/ui/components/board/BoardPageView';
import { useBoardPageController } from '@/ui/hooks/useBoardPageController';

export function BoardPage() {
  const controller = useBoardPageController();
  return <BoardPageView controller={controller} />;
}
