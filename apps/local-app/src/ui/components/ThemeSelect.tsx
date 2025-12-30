import { useEffect } from 'react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/components/ui/select';
import { Waves, Moon } from 'lucide-react';

export type ThemeValue = 'dark' | 'ocean';

const THEME_STORAGE_KEY = 'devchain:theme';

export function getStoredTheme(): ThemeValue | null {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    if (raw === 'light') {
      // Migrate deprecated 'light' to 'ocean'
      localStorage.setItem(THEME_STORAGE_KEY, 'ocean');
      return 'ocean';
    }
    if (raw === 'dark' || raw === 'ocean') return raw;
    return null;
  } catch {
    return null;
  }
}

export function applyTheme(next: ThemeValue) {
  const root = document.documentElement;
  // Reset
  root.classList.remove('dark');
  root.classList.remove('theme-ocean');

  if (next === 'dark') {
    root.classList.add('dark');
  } else if (next === 'ocean') {
    root.classList.add('theme-ocean');
  }

  try {
    localStorage.setItem(THEME_STORAGE_KEY, next);
  } catch {
    // ignore storage failures
  }
}

export interface ThemeSelectProps {
  value: ThemeValue;
  onChange: (value: ThemeValue) => void;
}

export function ThemeSelect({ value, onChange }: ThemeSelectProps) {
  // Keep DOM classes and storage in sync when value prop changes
  useEffect(() => {
    applyTheme(value);
  }, [value]);

  return (
    <Select value={value} onValueChange={(v) => onChange(v as ThemeValue)}>
      <SelectTrigger className="w-[140px]" aria-label="Select theme" data-testid="theme-toggle">
        <div className="flex items-center gap-2">
          {value === 'dark' ? <Moon className="h-4 w-4" /> : <Waves className="h-4 w-4" />}
          <SelectValue placeholder="Theme" />
        </div>
      </SelectTrigger>
      <SelectContent>
        {/* Text-only to avoid double icon with check indicator */}
        <SelectItem value="ocean">Ocean</SelectItem>
        <SelectItem value="dark">Dark</SelectItem>
      </SelectContent>
    </Select>
  );
}
