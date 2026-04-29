import { ToggleGroup, ToggleGroupItem } from '../../ui/toggle-group';
import type { Density } from './useTableDensity';

interface DensityToggleProps {
  value: Density;
  onChange: (v: Density) => void;
}

export function DensityToggle({ value, onChange }: DensityToggleProps) {
  return (
    <ToggleGroup
      type="single"
      value={value}
      onValueChange={(v) => {
        if (v === 'compact' || v === 'comfortable') onChange(v);
      }}
      variant="outline"
      size="sm"
      aria-label="Table density"
    >
      <ToggleGroupItem value="comfortable" aria-label="Comfortable density">
        Comfortable
      </ToggleGroupItem>
      <ToggleGroupItem value="compact" aria-label="Compact density">
        Compact
      </ToggleGroupItem>
    </ToggleGroup>
  );
}
