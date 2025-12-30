import { useState } from 'react';
import { useInstanceMode, InstanceMode } from '../hooks/useInstanceMode';

export function FirstRunSetup() {
  const [mode, setMode] = useState<InstanceMode>('local');
  const [apiKey, setApiKey] = useState('');
  const { setInstanceMode } = useInstanceMode();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setInstanceMode(mode, mode === 'cloud' ? apiKey : undefined);
  };

  return (
    <div className="first-run-setup">
      <h1>Welcome to Devchain</h1>
      <p>Choose your instance mode:</p>
      <form onSubmit={handleSubmit}>
        <div className="mode-selection">
          <label>
            <input
              type="radio"
              value="local"
              checked={mode === 'local'}
              onChange={(e) => setMode(e.target.value as InstanceMode)}
            />
            Local Mode (All data stored locally)
          </label>
          <label>
            <input
              type="radio"
              value="cloud"
              checked={mode === 'cloud'}
              onChange={(e) => setMode(e.target.value as InstanceMode)}
              disabled={true}
            />
            Cloud Mode (Phase 2 - Coming soon)
          </label>
        </div>
        {mode === 'cloud' && (
          <div className="api-key-input">
            <label>
              API Key:
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="Enter your API key"
                required
              />
            </label>
          </div>
        )}
        <button type="submit">Continue</button>
      </form>
    </div>
  );
}
