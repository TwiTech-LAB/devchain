import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'path';
import { LocalStorageService } from './local-storage.service';

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
    // Create in-memory SQLite database
    sqlite = new Database(':memory:');
    const db = drizzle(sqlite);

    // Run migrations to create schema
    const migrationsFolder = join(__dirname, '../../../../drizzle');
    migrate(db, { migrationsFolder });

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

    it('should return sub-epics grouped by parent', async () => {
      const result = await service.listSubEpicsForParents(projectId, [parentAId, parentBId], {
        type: 'all',
      });

      expect(result.size).toBe(2);

      // Parent A should have 3 children
      const parentAChildren = result.get(parentAId) ?? [];
      expect(parentAChildren.length).toBe(3);
      const parentAChildIds = parentAChildren.map((e) => e.id);
      expect(parentAChildIds).toContain(childA1Id);
      expect(parentAChildIds).toContain(childA2Id);
      expect(parentAChildIds).toContain(childA3Id);

      // Parent B should have 2 children
      const parentBChildren = result.get(parentBId) ?? [];
      expect(parentBChildren.length).toBe(2);
      const parentBChildIds = parentBChildren.map((e) => e.id);
      expect(parentBChildIds).toContain(childB1Id);
      expect(parentBChildIds).toContain(childB2Id);
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

    it('should return empty arrays for parents with no children', async () => {
      const result = await service.listSubEpicsForParents(projectId, [orphanDId], {
        type: 'all',
      });

      expect(result.size).toBe(1);
      const orphanChildren = result.get(orphanDId) ?? [];
      expect(orphanChildren.length).toBe(0);
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

    it('should return epics with tags array (empty or populated)', async () => {
      // All returned epics should have tags property as array
      const result = await service.listSubEpicsForParents(projectId, [parentAId], {
        type: 'all',
      });

      const children = result.get(parentAId) ?? [];
      expect(children.length).toBeGreaterThan(0);

      // Each epic should have a tags array
      for (const epic of children) {
        expect(Array.isArray(epic.tags)).toBe(true);
      }
    });
  });
});
