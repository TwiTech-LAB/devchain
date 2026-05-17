import { MessagePoolSettingsDelegate } from './message-pool-settings.delegate';
import type { SettingsDto } from '../../dtos/settings.dto';

describe('MessagePoolSettingsDelegate', () => {
  let delegate: MessagePoolSettingsDelegate;
  let mockGetSettings: jest.Mock<SettingsDto>;
  let mockUpdateSettings: jest.Mock;

  beforeEach(() => {
    mockGetSettings = jest.fn().mockReturnValue({});
    mockUpdateSettings = jest.fn().mockResolvedValue({});
    delegate = new MessagePoolSettingsDelegate({
      getSettings: mockGetSettings,
      updateSettings: mockUpdateSettings,
    });
  });

  describe('getMessagePoolConfig', () => {
    it('returns defaults when no settings configured', () => {
      const config = delegate.getMessagePoolConfig();
      expect(config).toEqual({
        enabled: true,
        delayMs: 10000,
        maxWaitMs: 30000,
        maxMessages: 10,
        separator: '\n---\n',
      });
    });

    it('returns stored values when configured', () => {
      mockGetSettings.mockReturnValue({
        messagePool: {
          enabled: false,
          delayMs: 5000,
          maxWaitMs: 15000,
          maxMessages: 5,
          separator: '---',
        },
      });
      const config = delegate.getMessagePoolConfig();
      expect(config).toEqual({
        enabled: false,
        delayMs: 5000,
        maxWaitMs: 15000,
        maxMessages: 5,
        separator: '---',
      });
    });

    it('fills in defaults for partially configured settings', () => {
      mockGetSettings.mockReturnValue({
        messagePool: { delayMs: 3000 },
      });
      const config = delegate.getMessagePoolConfig();
      expect(config.delayMs).toBe(3000);
      expect(config.enabled).toBe(true);
      expect(config.maxWaitMs).toBe(30000);
    });
  });

  describe('getMessagePoolConfigForProject', () => {
    it('returns global config when no project overrides', () => {
      mockGetSettings.mockReturnValue({
        messagePool: { delayMs: 5000 },
      });
      const config = delegate.getMessagePoolConfigForProject('project-1');
      expect(config.delayMs).toBe(5000);
      expect(config.enabled).toBe(true);
    });

    it('applies project overrides on top of global defaults', () => {
      mockGetSettings.mockReturnValue({
        messagePool: {
          delayMs: 5000,
          maxMessages: 10,
          projects: {
            'project-1': { delayMs: 2000, enabled: false },
          },
        },
      });
      const config = delegate.getMessagePoolConfigForProject('project-1');
      expect(config.delayMs).toBe(2000);
      expect(config.enabled).toBe(false);
      expect(config.maxMessages).toBe(10);
      expect(config.maxWaitMs).toBe(30000);
    });

    it('returns global config for unknown project', () => {
      mockGetSettings.mockReturnValue({
        messagePool: {
          delayMs: 5000,
          projects: {
            'project-1': { delayMs: 2000 },
          },
        },
      });
      const config = delegate.getMessagePoolConfigForProject('project-unknown');
      expect(config.delayMs).toBe(5000);
    });

    it('falls back to defaults when global is empty and project has partial overrides', () => {
      mockGetSettings.mockReturnValue({
        messagePool: {
          projects: {
            'project-1': { separator: '***' },
          },
        },
      });
      const config = delegate.getMessagePoolConfigForProject('project-1');
      expect(config.separator).toBe('***');
      expect(config.enabled).toBe(true);
      expect(config.delayMs).toBe(10000);
    });
  });

  describe('getProjectPoolSettings', () => {
    it('returns undefined when no project settings', () => {
      expect(delegate.getProjectPoolSettings('project-1')).toBeUndefined();
    });

    it('returns undefined when messagePool has no projects', () => {
      mockGetSettings.mockReturnValue({ messagePool: { delayMs: 5000 } });
      expect(delegate.getProjectPoolSettings('project-1')).toBeUndefined();
    });

    it('returns raw project settings without global fallback', () => {
      mockGetSettings.mockReturnValue({
        messagePool: {
          delayMs: 5000,
          projects: {
            'project-1': { delayMs: 2000 },
          },
        },
      });
      const settings = delegate.getProjectPoolSettings('project-1');
      expect(settings).toEqual({ delayMs: 2000 });
    });
  });

  describe('setProjectPoolSettings', () => {
    it('sets project-specific pool settings', async () => {
      mockGetSettings.mockReturnValue({
        messagePool: { projects: {} },
      });

      await delegate.setProjectPoolSettings('project-1', { delayMs: 3000 });

      expect(mockUpdateSettings).toHaveBeenCalledWith({
        messagePool: {
          projects: {
            'project-1': { delayMs: 3000 },
          },
        },
      });
    });

    it('preserves existing project settings when adding new project', async () => {
      mockGetSettings.mockReturnValue({
        messagePool: {
          projects: {
            'project-existing': { delayMs: 5000 },
          },
        },
      });

      await delegate.setProjectPoolSettings('project-new', { enabled: false });

      expect(mockUpdateSettings).toHaveBeenCalledWith({
        messagePool: {
          projects: {
            'project-existing': { delayMs: 5000 },
            'project-new': { enabled: false },
          },
        },
      });
    });

    it('removes project settings when null is passed', async () => {
      mockGetSettings.mockReturnValue({
        messagePool: {
          projects: {
            'project-1': { delayMs: 5000 },
            'project-2': { delayMs: 3000 },
          },
        },
      });

      await delegate.setProjectPoolSettings('project-1', null);

      expect(mockUpdateSettings).toHaveBeenCalledWith({
        messagePool: {
          projects: {
            'project-2': { delayMs: 3000 },
          },
        },
      });
    });

    it('handles remove when no projects exist', async () => {
      mockGetSettings.mockReturnValue({});

      await delegate.setProjectPoolSettings('project-1', null);

      expect(mockUpdateSettings).toHaveBeenCalledWith({
        messagePool: {
          projects: {},
        },
      });
    });
  });
});
