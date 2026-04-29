import { useState } from 'react';
import { Button } from '@/ui/components/ui/button';
import { Input } from '@/ui/components/ui/input';
import { Plus, X } from 'lucide-react';

export function EnvEditor({
  env,
  onChange,
}: {
  env: Record<string, string>;
  onChange: (env: Record<string, string>) => void;
}) {
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [keyError, setKeyError] = useState<string | null>(null);

  const entries = Object.entries(env);

  const validateKey = (key: string): boolean => {
    const pattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
    return pattern.test(key);
  };

  const handleAddEntry = () => {
    const trimmedKey = newKey.trim();
    if (!trimmedKey) {
      setKeyError('Key is required');
      return;
    }
    if (!validateKey(trimmedKey)) {
      setKeyError(
        'Key must be alphanumeric with underscores, starting with a letter or underscore',
      );
      return;
    }
    if (env[trimmedKey] !== undefined) {
      setKeyError('Key already exists');
      return;
    }
    setKeyError(null);
    onChange({ ...env, [trimmedKey]: newValue });
    setNewKey('');
    setNewValue('');
  };

  const handleRemoveEntry = (key: string) => {
    const newEnv = { ...env };
    delete newEnv[key];
    onChange(newEnv);
  };

  const handleUpdateValue = (key: string, value: string) => {
    onChange({ ...env, [key]: value });
  };

  return (
    <div className="space-y-3">
      {entries.length > 0 && (
        <div className="space-y-2">
          {entries.map(([key, value]) => (
            <div key={key} className="flex items-center gap-2">
              <Input value={key} readOnly className="w-1/3 font-mono text-sm bg-muted" />
              <Input
                value={value}
                onChange={(e) => handleUpdateValue(key, e.target.value)}
                className="flex-1 font-mono text-sm"
                placeholder="Value"
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => handleRemoveEntry(key)}
                aria-label="Remove"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>
      )}
      <div className="flex items-start gap-2">
        <div className="w-1/3">
          <Input
            value={newKey}
            onChange={(e) => {
              setNewKey(e.target.value);
              setKeyError(null);
            }}
            className="font-mono text-sm"
            placeholder="NEW_KEY"
          />
          {keyError && <p className="text-xs text-destructive mt-1">{keyError}</p>}
        </div>
        <Input
          value={newValue}
          onChange={(e) => setNewValue(e.target.value)}
          className="flex-1 font-mono text-sm"
          placeholder="value"
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              handleAddEntry();
            }
          }}
        />
        <Button type="button" variant="outline" size="sm" onClick={handleAddEntry}>
          <Plus className="h-4 w-4" />
        </Button>
      </div>
      {entries.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No environment variables. Add key-value pairs that will be set when launching sessions.
        </p>
      )}
    </div>
  );
}
