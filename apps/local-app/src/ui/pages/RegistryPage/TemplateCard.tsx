import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/ui/components/ui/card';
import { Badge } from '@/ui/components/ui/badge';
import { Download, CheckCircle2 } from 'lucide-react';

export interface TemplateCardData {
  slug: string;
  name: string;
  description: string | null;
  category: string | null;
  tags: string[];
  requiredProviders: string[];
  isOfficial: boolean;
  latestVersion: string | null;
  totalDownloads?: number; // Optional - may be hidden from public API
  authorName?: string | null;
  updatedAt: string;
}

interface TemplateCardProps {
  template: TemplateCardData;
  onSelect: (slug: string) => void;
}

export function TemplateCard({ template, onSelect }: TemplateCardProps) {
  return (
    <Card
      className="cursor-pointer transition-colors hover:border-primary"
      onClick={() => onSelect(template.slug)}
    >
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <CardTitle className="text-lg">{template.name}</CardTitle>
          {template.isOfficial && (
            <Badge variant="secondary" className="gap-1">
              <CheckCircle2 className="h-3 w-3" />
              Official
            </Badge>
          )}
        </div>
        <CardDescription className="line-clamp-2">
          {template.description || 'No description available'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="mb-3 flex flex-wrap gap-1">
          {template.tags.slice(0, 3).map((tag) => (
            <Badge key={tag} variant="outline" className="text-xs">
              {tag}
            </Badge>
          ))}
          {template.tags.length > 3 && (
            <Badge variant="outline" className="text-xs">
              +{template.tags.length - 3}
            </Badge>
          )}
        </div>
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>v{template.latestVersion || '0.0.0'}</span>
          {template.totalDownloads != null && (
            <span className="flex items-center gap-1">
              <Download className="h-3.5 w-3.5" />
              {template.totalDownloads.toLocaleString()}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
