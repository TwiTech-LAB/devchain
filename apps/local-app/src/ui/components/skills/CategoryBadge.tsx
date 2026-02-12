import { Badge } from '@/ui/components/ui/badge';
import { cn } from '@/ui/lib/utils';
import {
  getSkillCategoryBadgeClassName,
  getSkillCategoryLabel,
  type Skill,
  type SkillSummary,
} from '@/ui/lib/skills';

interface CategoryBadgeProps {
  category: Skill['category'] | SkillSummary['category'];
  className?: string;
}

export function CategoryBadge({ category, className }: CategoryBadgeProps) {
  return (
    <Badge variant="outline" className={cn(getSkillCategoryBadgeClassName(category), className)}>
      {getSkillCategoryLabel(category)}
    </Badge>
  );
}
