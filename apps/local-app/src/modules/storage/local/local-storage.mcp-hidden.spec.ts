import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'path';
import { LocalStorageService } from './local-storage.service';

/**
 * Integration tests for mcpHidden filtering in listProjectEpics and listAssignedEpics.
 *
 * Test hierarchy (note: system has one-level hierarchy constraint):
 *   Epic A (hidden status) → Child B1, B2 (normal status)
 *   Epic C (normal status) - unrelated, should always be visible
 *
 * When excludeMcpHidden=true:
 *   - Epic A is excluded (own status is hidden)
 *   - Epic B1, B2 are excluded (parent A has hidden status)
 *   - Epic C is returned (not related to hidden hierarchy)
 */
describe('LocalStorageService - mcpHidden Filtering Integration', () => {
  let sqlite: Database.Database;
  let service: LocalStorageService;
  let projectId: string;
  let hiddenStatusId: string;
  let normalStatusId: string;
  let epicAId: string;
  let epicB1Id: string;
  let epicB2Id: string;
  let epicCId: string;
  let agentId: string;

  beforeAll(async () => {
    // Create in-memory SQLite database
    sqlite = new Database(':memory:');
    const db = drizzle(sqlite);

    // Run migrations to create schema
    const migrationsFolder = join(__dirname, '../../../../drizzle');
    migrate(db, { migrationsFolder });

    service = new LocalStorageService(db);

    // Create test project
    const project = await service.createProject({
      name: 'MCP Hidden Test Project',
      description: 'Test project for mcpHidden filtering',
      rootPath: '/test/mcp-hidden',
      isTemplate: false,
    });
    projectId = project.id;

    // Get default statuses created with project and modify one to be hidden
    const statusesResult = await service.listStatuses(projectId);
    normalStatusId = statusesResult.items[0].id;

    // Create a hidden status
    const hiddenStatus = await service.createStatus({
      projectId,
      label: 'Hidden Status',
      color: '#dc3545',
      position: 10,
      mcpHidden: true,
    });
    hiddenStatusId = hiddenStatus.id;

    // Create provider and profile for agent tests
    const providerId = 'provider-test-mcp';
    sqlite.exec(`
      INSERT INTO providers (id, name, bin_path, mcp_configured, created_at, updated_at)
      VALUES ('${providerId}', 'test-provider', '/bin/test', 0, '2024-01-01', '2024-01-01')
    `);

    const profile = await service.createAgentProfile({
      projectId,
      name: 'Test Profile',
      providerId,
      options: null,
      systemPrompt: null,
      temperature: null,
      maxTokens: null,
    });

    const agent = await service.createAgent({
      projectId,
      profileId: profile.id,
      name: 'Test Agent',
    });
    agentId = agent.id;

    // Create Epic A with hidden status (parent)
    const epicA = await service.createEpicForProject(projectId, {
      title: 'Epic A - Hidden Status',
      description: 'This epic has a hidden status',
      statusId: hiddenStatusId,
      agentId: agentId,
      tags: [],
    });
    epicAId = epicA.id;

    // Create Epic B1 as child of A with normal status
    const epicB1 = await service.createEpicForProject(projectId, {
      title: 'Epic B1 - Child of A',
      description: 'First child of hidden parent',
      statusId: normalStatusId,
      parentId: epicAId,
      agentId: agentId,
      tags: [],
    });
    epicB1Id = epicB1.id;

    // Create Epic B2 as another child of A with normal status
    const epicB2 = await service.createEpicForProject(projectId, {
      title: 'Epic B2 - Child of A',
      description: 'Second child of hidden parent',
      statusId: normalStatusId,
      parentId: epicAId,
      agentId: agentId,
      tags: [],
    });
    epicB2Id = epicB2.id;

    // Create Epic C - completely separate, normal status
    const epicC = await service.createEpicForProject(projectId, {
      title: 'Epic C - Unrelated',
      description: 'Not related to hidden hierarchy',
      statusId: normalStatusId,
      agentId: agentId,
      tags: [],
    });
    epicCId = epicC.id;
  });

  afterAll(() => {
    sqlite.close();
  });

  describe('listProjectEpics', () => {
    it('should return all epics when excludeMcpHidden is false (default)', async () => {
      const result = await service.listProjectEpics(projectId, {
        excludeMcpHidden: false,
        type: 'all',
      });

      expect(result.total).toBe(4);
      const epicIds = result.items.map((e) => e.id);
      expect(epicIds).toContain(epicAId);
      expect(epicIds).toContain(epicB1Id);
      expect(epicIds).toContain(epicB2Id);
      expect(epicIds).toContain(epicCId);
    });

    it('should exclude epic with mcpHidden status when excludeMcpHidden is true', async () => {
      const result = await service.listProjectEpics(projectId, {
        excludeMcpHidden: true,
        type: 'all',
      });

      const epicIds = result.items.map((e) => e.id);
      expect(epicIds).not.toContain(epicAId);
    });

    it('should exclude children of hidden parent even if own status is not hidden', async () => {
      const result = await service.listProjectEpics(projectId, {
        excludeMcpHidden: true,
        type: 'all',
      });

      const epicIds = result.items.map((e) => e.id);
      expect(epicIds).not.toContain(epicB1Id);
      expect(epicIds).not.toContain(epicB2Id);
    });

    it('should return unrelated epics with normal status', async () => {
      const result = await service.listProjectEpics(projectId, {
        excludeMcpHidden: true,
        type: 'all',
      });

      const epicIds = result.items.map((e) => e.id);
      expect(epicIds).toContain(epicCId);
    });

    it('should reflect filtered count in pagination total', async () => {
      const result = await service.listProjectEpics(projectId, {
        excludeMcpHidden: true,
        type: 'all',
      });

      // Only Epic C should be returned (A, B1, B2 are all excluded)
      expect(result.total).toBe(1);
      expect(result.items.length).toBe(1);
    });

    it('should work correctly with pagination', async () => {
      const result = await service.listProjectEpics(projectId, {
        excludeMcpHidden: true,
        type: 'all',
        limit: 10,
        offset: 0,
      });

      expect(result.total).toBe(1);
      expect(result.limit).toBe(10);
      expect(result.offset).toBe(0);
    });
  });

  describe('listAssignedEpics', () => {
    it('should return all assigned epics when excludeMcpHidden is false', async () => {
      const result = await service.listAssignedEpics(projectId, {
        agentName: 'Test Agent',
        excludeMcpHidden: false,
      });

      expect(result.total).toBe(4);
      const epicIds = result.items.map((e) => e.id);
      expect(epicIds).toContain(epicAId);
      expect(epicIds).toContain(epicB1Id);
      expect(epicIds).toContain(epicB2Id);
      expect(epicIds).toContain(epicCId);
    });

    it('should exclude hidden hierarchy when excludeMcpHidden is true', async () => {
      const result = await service.listAssignedEpics(projectId, {
        agentName: 'Test Agent',
        excludeMcpHidden: true,
      });

      // Only Epic C should be returned
      expect(result.total).toBe(1);
      const epicIds = result.items.map((e) => e.id);
      expect(epicIds).not.toContain(epicAId);
      expect(epicIds).not.toContain(epicB1Id);
      expect(epicIds).not.toContain(epicB2Id);
      expect(epicIds).toContain(epicCId);
    });

    it('should reflect filtered count in pagination total', async () => {
      const result = await service.listAssignedEpics(projectId, {
        agentName: 'Test Agent',
        excludeMcpHidden: true,
      });

      expect(result.total).toBe(1);
      expect(result.items.length).toBe(1);
    });
  });

  describe('mcpHidden status management', () => {
    it('should update mcpHidden flag on status', async () => {
      // Create a new status
      const newStatus = await service.createStatus({
        projectId,
        label: 'Toggle Test Status',
        color: '#007bff',
        position: 20,
        mcpHidden: false,
      });

      expect(newStatus.mcpHidden).toBe(false);

      // Update to hidden
      const updated = await service.updateStatus(newStatus.id, { mcpHidden: true });
      expect(updated.mcpHidden).toBe(true);

      // Update back to visible
      const reverted = await service.updateStatus(newStatus.id, { mcpHidden: false });
      expect(reverted.mcpHidden).toBe(false);
    });

    it('should default mcpHidden to false when not specified', async () => {
      const status = await service.createStatus({
        projectId,
        label: 'Default Test Status',
        color: '#28a745',
        position: 21,
      });

      expect(status.mcpHidden).toBe(false);
    });
  });
});
