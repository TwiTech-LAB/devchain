import { LocalStorageService } from './local-storage.service';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import Database from 'better-sqlite3';
import { createTestDatabase } from '../../../common/test/test-database.helper';

/**
 * Integration tests for hierarchical epic list functionality:
 * - parentOnly filter in listProjectEpics
 * - listSubEpicsForParents batch helper
 *
 * Test hierarchy:
 *   Parent A (normal status) → Child A1, A2, A3 (normal status)
 *   Parent B (normal status) → Child B1 (normal), B2 (hidden status)
 *   Parent C (archived status) → Child C1 (normal status)
 *   Orphan D (no parent, normal status)
 */
describe('LocalStorageService - Hierarchical Epic List Integration', () => {
  let sqlite: Database.Database;
  let service: LocalStorageService;
  let projectId: string;
  let normalStatusId: string;
  let hiddenStatusId: string;
  let archivedStatusId: string;
  let parentAId: string;
  let parentBId: string;
  let parentCId: string;
  let orphanDId: string;
  let childA1Id: string;
  let childA2Id: string;
  let childA3Id: string;
  let childB1Id: string;
  let childB2Id: string;
  let childC1Id: string;

  beforeAll(async () => {
    sqlite = createTestDatabase().sqlite;
    const db = drizzle(sqlite);

    service = new LocalStorageService(db);

    // Create test project
    const project = await service.createProject({
      name: 'Hierarchical Test Project',
      description: 'Test project for hierarchical epic list',
      rootPath: '/test/hierarchical',
      isTemplate: false,
    });
    projectId = project.id;

    // Get default statuses created with project
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

    // Create an archived status
    const archivedStatus = await service.createStatus({
      projectId,
      label: 'Archived',
      color: '#6c757d',
      position: 20,
      mcpHidden: false,
    });
    archivedStatusId = archivedStatus.id;

    // Create parent epics
    const parentA = await service.createEpicForProject(projectId, {
      title: 'Parent A',
      description: 'First parent epic',
      statusId: normalStatusId,
    });
    parentAId = parentA.id;

    const parentB = await service.createEpicForProject(projectId, {
      title: 'Parent B',
      description: 'Second parent epic',
      statusId: normalStatusId,
    });
    parentBId = parentB.id;

    const parentC = await service.createEpicForProject(projectId, {
      title: 'Parent C',
      description: 'Archived parent epic',
      statusId: archivedStatusId,
    });
    parentCId = parentC.id;

    // Create orphan epic (no parent)
    const orphanD = await service.createEpicForProject(projectId, {
      title: 'Orphan D',
      description: 'Epic with no parent',
      statusId: normalStatusId,
    });
    orphanDId = orphanD.id;

    // Create children for Parent A
    const childA1 = await service.createEpicForProject(projectId, {
      title: 'Child A1',
      statusId: normalStatusId,
      parentId: parentAId,
      createdBy: 'Creator Agent',
    });
    childA1Id = childA1.id;

    const childA2 = await service.createEpicForProject(projectId, {
      title: 'Child A2',
      statusId: normalStatusId,
      parentId: parentAId,
    });
    childA2Id = childA2.id;

    const childA3 = await service.createEpicForProject(projectId, {
      title: 'Child A3',
      statusId: normalStatusId,
      parentId: parentAId,
    });
    childA3Id = childA3.id;

    // Create children for Parent B (one normal, one hidden)
    const childB1 = await service.createEpicForProject(projectId, {
      title: 'Child B1',
      statusId: normalStatusId,
      parentId: parentBId,
    });
    childB1Id = childB1.id;

    const childB2 = await service.createEpicForProject(projectId, {
      title: 'Child B2',
      statusId: hiddenStatusId,
      parentId: parentBId,
    });
    childB2Id = childB2.id;

    // Create child for Parent C (archived parent)
    const childC1 = await service.createEpicForProject(projectId, {
      title: 'Child C1',
      statusId: normalStatusId,
      parentId: parentCId,
    });
    childC1Id = childC1.id;
  });

  afterAll(() => {
    sqlite.close();
  });

  describe('listProjectEpics with parentOnly filter', () => {
    it('should return all epics when parentOnly is false/undefined', async () => {
      const result = await service.listProjectEpics(projectId, {
        type: 'all',
      });

      // Should include all 10 epics (4 parents + 6 children)
      expect(result.items.length).toBe(10);
      expect(result.total).toBe(10);
    });

    it('should return only parent epics when parentOnly is true', async () => {
      const result = await service.listProjectEpics(projectId, {
        parentOnly: true,
        type: 'all',
      });

      // Should only include the 4 parent epics (parentId IS NULL)
      expect(result.items.length).toBe(4);
      expect(result.total).toBe(4);

      const ids = result.items.map((e) => e.id);
      expect(ids).toContain(parentAId);
      expect(ids).toContain(parentBId);
      expect(ids).toContain(parentCId);
      expect(ids).toContain(orphanDId);

      // Should NOT include any child epics
      expect(ids).not.toContain(childA1Id);
      expect(ids).not.toContain(childB1Id);
      expect(ids).not.toContain(childC1Id);
    });

    it('should combine parentOnly with type filter (active only)', async () => {
      const result = await service.listProjectEpics(projectId, {
        parentOnly: true,
        type: 'active',
      });

      // Should return 3 parent epics (excluding Parent C which is archived)
      expect(result.items.length).toBe(3);
      const ids = result.items.map((e) => e.id);
      expect(ids).toContain(parentAId);
      expect(ids).toContain(parentBId);
      expect(ids).toContain(orphanDId);
      expect(ids).not.toContain(parentCId);
    });
  });

  describe('listSubEpicsForParents', () => {
    it('should return empty map when no parentIds provided', async () => {
      const result = await service.listSubEpicsForParents(projectId, []);
      expect(result.size).toBe(0);
    });

    it('should filter out hidden status sub-epics when excludeMcpHidden is true', async () => {
      const result = await service.listSubEpicsForParents(projectId, [parentBId], {
        excludeMcpHidden: true,
        type: 'all',
      });

      // Parent B should only have 1 child (B2 has hidden status)
      const parentBChildren = result.get(parentBId) ?? [];
      expect(parentBChildren.length).toBe(1);
      expect(parentBChildren[0].id).toBe(childB1Id);
    });

    it('should filter sub-epics by archived type', async () => {
      // With type: 'active', sub-epics in archived status should be excluded
      const resultActive = await service.listSubEpicsForParents(projectId, [parentCId], {
        type: 'active',
      });

      // Parent C's child (C1) is in normal status, so it should be included
      const parentCChildrenActive = resultActive.get(parentCId) ?? [];
      expect(parentCChildrenActive.length).toBe(1);
      expect(parentCChildrenActive[0].id).toBe(childC1Id);
    });

    it('should respect limitPerParent option', async () => {
      const result = await service.listSubEpicsForParents(projectId, [parentAId], {
        limitPerParent: 2,
        type: 'all',
      });

      // Parent A has 3 children but limit is 2
      const parentAChildren = result.get(parentAId) ?? [];
      expect(parentAChildren.length).toBe(2);
    });

    it('should handle mix of parents with and without children', async () => {
      const result = await service.listSubEpicsForParents(
        projectId,
        [parentAId, orphanDId, parentBId],
        { type: 'all' },
      );

      expect(result.size).toBe(3);

      // Parent A has children
      expect((result.get(parentAId) ?? []).length).toBe(3);

      // Orphan D has no children
      expect((result.get(orphanDId) ?? []).length).toBe(0);

      // Parent B has children
      expect((result.get(parentBId) ?? []).length).toBe(2);
      expect((result.get(parentAId) ?? []).map((epic) => epic.id).sort()).toEqual(
        [childA1Id, childA2Id, childA3Id].sort(),
      );
      expect((result.get(parentBId) ?? []).map((epic) => epic.id).sort()).toEqual(
        [childB1Id, childB2Id].sort(),
      );
      for (const children of result.values()) {
        for (const epic of children) expect(Array.isArray(epic.tags)).toBe(true);
      }
    });

    it('should not call getEpic per-ID (no N+1 queries)', async () => {
      // Spy on getEpic to verify it's not called
      const getEpicSpy = jest.spyOn(service, 'getEpic');

      await service.listSubEpicsForParents(projectId, [parentAId, parentBId], {
        type: 'all',
      });

      // getEpic should NOT be called - we use batch query with window function
      expect(getEpicSpy).not.toHaveBeenCalled();

      getEpicSpy.mockRestore();
    });

    it('should return deterministic ordering with tie-breaker (updated_at DESC, id DESC)', async () => {
      // Create a new parent with multiple children that have the same updatedAt
      const testParent = await service.createEpicForProject(projectId, {
        title: 'Test Parent for Ordering',
        statusId: normalStatusId,
      });

      // Create children - they will have very similar timestamps
      // The tie-breaker should order by id DESC
      const child1 = await service.createEpicForProject(projectId, {
        title: 'Ordering Child 1',
        statusId: normalStatusId,
        parentId: testParent.id,
      });
      const child2 = await service.createEpicForProject(projectId, {
        title: 'Ordering Child 2',
        statusId: normalStatusId,
        parentId: testParent.id,
      });
      const child3 = await service.createEpicForProject(projectId, {
        title: 'Ordering Child 3',
        statusId: normalStatusId,
        parentId: testParent.id,
      });

      const result = await service.listSubEpicsForParents(projectId, [testParent.id], {
        type: 'all',
      });

      const children = result.get(testParent.id) ?? [];
      expect(children.length).toBe(3);

      // Children should be ordered by updated_at DESC, then id DESC
      // Since they were created in order, child3 should come first (latest updated_at or highest id)
      // The exact order depends on timestamps, but we verify consistency
      const ids = children.map((c) => c.id);
      expect(ids).toContain(child1.id);
      expect(ids).toContain(child2.id);
      expect(ids).toContain(child3.id);

      // Verify ordering is deterministic - child3 should be first (created last, so latest timestamp)
      expect(children[0].id).toBe(child3.id);
      expect(children[1].id).toBe(child2.id);
      expect(children[2].id).toBe(child1.id);
    });

    it('should project nullable creator attribution from batched raw rows', async () => {
      const result = await service.listSubEpicsForParents(projectId, [parentAId], {
        type: 'all',
      });
      const children = result.get(parentAId) ?? [];

      expect(children.find((epic) => epic.id === childA1Id)?.createdBy).toBe('Creator Agent');
      expect(children.find((epic) => epic.id === childA2Id)?.createdBy).toBeNull();
    });
  });
});

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
    sqlite = createTestDatabase().sqlite;
    const db = drizzle(sqlite);

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
      systemPrompt: null,
      temperature: null,
      maxTokens: null,
    });

    // Create provider config for the agent
    const config = await service.createProfileProviderConfig({
      profileId: profile.id,
      providerId,
      name: 'test-provider',
      options: null,
      env: null,
    });

    const agent = await service.createAgent({
      projectId,
      profileId: profile.id,
      name: 'Test Agent',
      providerConfigId: config.id,
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

      expect(result.total).toBe(1);
      expect(result.items.map((e) => e.id)).toEqual([epicCId]);
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
