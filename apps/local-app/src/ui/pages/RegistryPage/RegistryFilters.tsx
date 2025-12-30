import { Input } from '@/ui/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/components/ui/select';
import { Search, X } from 'lucide-react';
import { Button } from '@/ui/components/ui/button';

// Common template categories
const CATEGORIES = [
  { value: 'all', label: 'All Categories' },
  { value: 'agent', label: 'Agent Templates' },
  { value: 'workflow', label: 'Workflow Templates' },
  { value: 'starter', label: 'Starter Projects' },
  { value: 'integration', label: 'Integrations' },
];

interface RegistryFiltersProps {
  search: string;
  onSearchChange: (value: string) => void;
  category: string | undefined;
  onCategoryChange: (value: string | undefined) => void;
}

export function RegistryFilters({
  search,
  onSearchChange,
  category,
  onCategoryChange,
}: RegistryFiltersProps) {
  const handleCategoryChange = (value: string) => {
    onCategoryChange(value === 'all' ? undefined : value);
  };

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
      <div className="relative flex-1">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Search templates..."
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          className="pl-9 pr-9"
          data-shortcut="primary-search"
        />
        {search && (
          <Button
            variant="ghost"
            size="sm"
            className="absolute right-1 top-1/2 h-7 w-7 -translate-y-1/2 p-0"
            onClick={() => onSearchChange('')}
          >
            <X className="h-4 w-4" />
            <span className="sr-only">Clear search</span>
          </Button>
        )}
      </div>
      <Select value={category || 'all'} onValueChange={handleCategoryChange}>
        <SelectTrigger className="w-full sm:w-48">
          <SelectValue placeholder="Category" />
        </SelectTrigger>
        <SelectContent>
          {CATEGORIES.map((cat) => (
            <SelectItem key={cat.value} value={cat.value}>
              {cat.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
