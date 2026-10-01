import Database from 'better-sqlite3';
import { EventEmitter2 } from 'eventemitter2';
import { SettingsService } from '../../settings/services/settings.service';
import { InstanceLabelService } from './instance-label.service';

function createService(): {
  service: InstanceLabelService;
  settings: SettingsService;
  db: Database.Database;
} {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE settings (
      id TEXT PRIMARY KEY,
      key TEXT NOT NULL UNIQUE,
      value TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  const settings = new SettingsService(db as never, new EventEmitter2());
  return { service: new InstanceLabelService(settings), settings, db };
}

describe('InstanceLabelService', () => {
  it('returns null when no label is stored', () => {
    const { service, db } = createService();
    expect(service.getLabel()).toBeNull();
    db.close();
  });

  it('stores a label and reads it back through SettingsService', async () => {
    const { service, db } = createService();

    await expect(service.setLabel('lab-vm')).resolves.toBe('lab-vm');
    expect(service.getLabel()).toBe('lab-vm');

    db.close();
  });

  it('clearing with an empty string returns the reader to the hostname fallback', async () => {
    const { service, db } = createService();

    await service.setLabel('lab-vm');
    await expect(service.setLabel('')).resolves.toBeNull();
    expect(service.getLabel()).toBeNull();

    db.close();
  });

  it('treats a whitespace-only stored value as no label', () => {
    const { service, settings, db } = createService();

    settings.updateSettings({ cloud: { instanceLabel: '   ' } });
    expect(service.getLabel()).toBeNull();

    db.close();
  });
});
