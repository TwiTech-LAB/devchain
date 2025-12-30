import {
  fetchRemoteTemplateInfo,
  checkTemplateUpdateStatus,
  checkAllTemplateUpdates,
  CachedTemplateInfo,
} from './registry-updates';

describe('registry-updates', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    // Reset fetch mock before each test
    global.fetch = jest.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('fetchRemoteTemplateInfo', () => {
    it('returns template info when API returns valid data', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            slug: 'test-template',
            versions: [
              { version: '1.0.0', isLatest: false },
              { version: '2.0.0', isLatest: true },
            ],
          }),
      });

      const result = await fetchRemoteTemplateInfo('test-template');

      expect(result).toEqual({ slug: 'test-template', latestVersion: '2.0.0' });
    });

    it('returns null when API returns null (template not found)', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(null),
      });

      const result = await fetchRemoteTemplateInfo('unknown-template');

      expect(result).toBeNull();
    });

    it('throws error when API returns non-OK status', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: false,
        status: 404,
      });

      await expect(fetchRemoteTemplateInfo('test-template')).rejects.toThrow(
        'Registry request failed: 404',
      );
    });

    it('throws error on network failure', async () => {
      (global.fetch as jest.Mock).mockRejectedValue(new Error('Network error'));

      await expect(fetchRemoteTemplateInfo('test-template')).rejects.toThrow('Network error');
    });

    it('returns template with null latestVersion when no versions have isLatest', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            slug: 'test-template',
            versions: [{ version: '1.0.0', isLatest: false }],
          }),
      });

      const result = await fetchRemoteTemplateInfo('test-template');

      expect(result).toEqual({ slug: 'test-template', latestVersion: null });
    });
  });

  describe('checkTemplateUpdateStatus', () => {
    describe('registry templates', () => {
      it('returns idle for registry templates without version', async () => {
        const template: CachedTemplateInfo = {
          slug: 'no-version-template',
          source: 'registry',
          latestVersion: null,
        };

        const result = await checkTemplateUpdateStatus(template);

        expect(result).toEqual({ status: 'idle' });
      });

      it('returns offline on network error', async () => {
        (global.fetch as jest.Mock).mockRejectedValue(new Error('Network error'));

        const template: CachedTemplateInfo = {
          slug: 'test-template',
          source: 'registry',
          latestVersion: '1.0.0',
        };

        const result = await checkTemplateUpdateStatus(template);

        expect(result).toEqual({ status: 'offline' });
      });

      it('returns offline on API error (non-OK response)', async () => {
        (global.fetch as jest.Mock).mockResolvedValue({
          ok: false,
          status: 500,
        });

        const template: CachedTemplateInfo = {
          slug: 'test-template',
          source: 'registry',
          latestVersion: '1.0.0',
        };

        const result = await checkTemplateUpdateStatus(template);

        expect(result).toEqual({ status: 'offline' });
      });

      it('returns not-in-registry when API returns null', async () => {
        (global.fetch as jest.Mock).mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(null),
        });

        const template: CachedTemplateInfo = {
          slug: 'unknown-template',
          source: 'registry',
          latestVersion: '1.0.0',
        };

        const result = await checkTemplateUpdateStatus(template);

        expect(result).toEqual({ status: 'not-in-registry' });
      });

      it('returns not-in-registry when remote has no latestVersion', async () => {
        (global.fetch as jest.Mock).mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              slug: 'test-template',
              versions: [],
            }),
        });

        const template: CachedTemplateInfo = {
          slug: 'test-template',
          source: 'registry',
          latestVersion: '1.0.0',
        };

        const result = await checkTemplateUpdateStatus(template);

        expect(result).toEqual({ status: 'not-in-registry' });
      });

      it('returns update-available when remote version is newer', async () => {
        (global.fetch as jest.Mock).mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              slug: 'test-template',
              versions: [{ version: '2.0.0', isLatest: true }],
            }),
        });

        const template: CachedTemplateInfo = {
          slug: 'test-template',
          source: 'registry',
          latestVersion: '1.0.0',
        };

        const result = await checkTemplateUpdateStatus(template);

        expect(result).toEqual({ status: 'update-available', remoteVersion: '2.0.0' });
      });

      it('returns up-to-date when versions match', async () => {
        (global.fetch as jest.Mock).mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              slug: 'test-template',
              versions: [{ version: '1.0.0', isLatest: true }],
            }),
        });

        const template: CachedTemplateInfo = {
          slug: 'test-template',
          source: 'registry',
          latestVersion: '1.0.0',
        };

        const result = await checkTemplateUpdateStatus(template);

        expect(result).toEqual({ status: 'up-to-date' });
      });

      it('returns up-to-date when local version is newer', async () => {
        (global.fetch as jest.Mock).mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              slug: 'test-template',
              versions: [{ version: '1.0.0', isLatest: true }],
            }),
        });

        const template: CachedTemplateInfo = {
          slug: 'test-template',
          source: 'registry',
          latestVersion: '2.0.0',
        };

        const result = await checkTemplateUpdateStatus(template);

        expect(result).toEqual({ status: 'up-to-date' });
      });
    });

    describe('bundled templates', () => {
      it('returns update-available when bundled template exists in registry', async () => {
        (global.fetch as jest.Mock).mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              slug: 'bundled-template',
              versions: [{ version: '1.0.0', isLatest: true }],
            }),
        });

        const template: CachedTemplateInfo = {
          slug: 'bundled-template',
          source: 'bundled',
          latestVersion: null, // Bundled templates don't have local version
        };

        const result = await checkTemplateUpdateStatus(template);

        expect(result).toEqual({ status: 'update-available', remoteVersion: '1.0.0' });
      });

      it('returns not-in-registry when bundled template not in registry', async () => {
        (global.fetch as jest.Mock).mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(null),
        });

        const template: CachedTemplateInfo = {
          slug: 'bundled-only-template',
          source: 'bundled',
          latestVersion: null,
        };

        const result = await checkTemplateUpdateStatus(template);

        expect(result).toEqual({ status: 'not-in-registry' });
      });

      it('returns offline when network error checking bundled template', async () => {
        (global.fetch as jest.Mock).mockRejectedValue(new Error('Network error'));

        const template: CachedTemplateInfo = {
          slug: 'bundled-template',
          source: 'bundled',
          latestVersion: null,
        };

        const result = await checkTemplateUpdateStatus(template);

        expect(result).toEqual({ status: 'offline' });
      });

      it('returns not-in-registry when registry has no version for bundled', async () => {
        (global.fetch as jest.Mock).mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              slug: 'bundled-template',
              versions: [], // No versions
            }),
        });

        const template: CachedTemplateInfo = {
          slug: 'bundled-template',
          source: 'bundled',
          latestVersion: null,
        };

        const result = await checkTemplateUpdateStatus(template);

        expect(result).toEqual({ status: 'not-in-registry' });
      });

      it('returns up-to-date when bundled template version matches registry', async () => {
        (global.fetch as jest.Mock).mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              slug: 'versioned-bundled',
              versions: [{ version: '1.0.0', isLatest: true }],
            }),
        });

        const template: CachedTemplateInfo = {
          slug: 'versioned-bundled',
          source: 'bundled',
          latestVersion: '1.0.0', // Same as registry
        };

        const result = await checkTemplateUpdateStatus(template);

        expect(result).toEqual({ status: 'up-to-date' });
      });

      it('returns update-available when bundled template version is older than registry', async () => {
        (global.fetch as jest.Mock).mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              slug: 'versioned-bundled',
              versions: [{ version: '2.0.0', isLatest: true }],
            }),
        });

        const template: CachedTemplateInfo = {
          slug: 'versioned-bundled',
          source: 'bundled',
          latestVersion: '1.0.0', // Older than registry
        };

        const result = await checkTemplateUpdateStatus(template);

        expect(result).toEqual({ status: 'update-available', remoteVersion: '2.0.0' });
      });

      it('returns up-to-date when bundled template version is newer than registry', async () => {
        (global.fetch as jest.Mock).mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              slug: 'versioned-bundled',
              versions: [{ version: '1.0.0', isLatest: true }],
            }),
        });

        const template: CachedTemplateInfo = {
          slug: 'versioned-bundled',
          source: 'bundled',
          latestVersion: '2.0.0', // Newer than registry
        };

        const result = await checkTemplateUpdateStatus(template);

        expect(result).toEqual({ status: 'up-to-date' });
      });
    });
  });

  describe('checkAllTemplateUpdates', () => {
    it('returns empty object for empty templates array', async () => {
      const result = await checkAllTemplateUpdates([]);

      expect(result).toEqual({});
    });

    it('processes both registry and bundled templates', async () => {
      (global.fetch as jest.Mock).mockImplementation((url: string) => {
        if (url.includes('registry-template')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                slug: 'registry-template',
                versions: [{ version: '2.0.0', isLatest: true }],
              }),
          });
        }
        if (url.includes('bundled-template')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                slug: 'bundled-template',
                versions: [{ version: '1.0.0', isLatest: true }],
              }),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve(null) });
      });

      const templates: CachedTemplateInfo[] = [
        { slug: 'registry-template', source: 'registry', latestVersion: '1.0.0' },
        { slug: 'bundled-template', source: 'bundled', latestVersion: null },
      ];

      const result = await checkAllTemplateUpdates(templates);

      expect(result['registry-template']).toEqual({
        status: 'update-available',
        remoteVersion: '2.0.0',
      });
      expect(result['bundled-template']).toEqual({
        status: 'update-available',
        remoteVersion: '1.0.0',
      });
    });

    it('handles mixed results (some offline, some available)', async () => {
      (global.fetch as jest.Mock).mockImplementation((url: string) => {
        if (url.includes('available-template')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                slug: 'available-template',
                versions: [{ version: '1.0.0', isLatest: true }],
              }),
          });
        }
        // Simulate network error for other templates
        return Promise.reject(new Error('Network error'));
      });

      const templates: CachedTemplateInfo[] = [
        { slug: 'available-template', source: 'bundled', latestVersion: null },
        { slug: 'offline-template', source: 'bundled', latestVersion: null },
      ];

      const result = await checkAllTemplateUpdates(templates);

      expect(result['available-template']).toEqual({
        status: 'update-available',
        remoteVersion: '1.0.0',
      });
      expect(result['offline-template']).toEqual({ status: 'offline' });
    });
  });
});
