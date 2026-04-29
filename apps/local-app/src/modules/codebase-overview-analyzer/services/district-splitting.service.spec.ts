import { Test, TestingModule } from '@nestjs/testing';
import type { DistrictNode } from '@devchain/codebase-overview';
import { DistrictSplittingService, classifyFileRole } from './district-splitting.service';

function makeDistrict(
  overrides: Partial<DistrictNode> & { id: string; name: string },
): DistrictNode {
  return {
    regionId: 'region-1',
    path: overrides.name,
    totalFiles: 0,
    totalLOC: 0,
    churn7d: 0,
    churn30d: 0,
    inboundWeight: 0,
    outboundWeight: 0,
    couplingScore: 0,
    testFileCount: 0,
    testFileRatio: null,
    role: 'mixed',
    ...overrides,
  };
}

describe('classifyFileRole', () => {
  it.each([
    // Test files
    ['src/app.test.ts', 'test'],
    ['src/app.spec.ts', 'test'],
    ['src/app_test.py', 'test'],
    ['src/app-spec.rb', 'test'],
    ['src/__tests__/app.ts', 'test'],
    ['tests/unit/app.ts', 'test'],
    ['test/app.ts', 'test'],

    // Style files
    ['src/styles/main.css', 'style'],
    ['src/theme.scss', 'style'],
    ['src/button.styled.ts', 'style'],
    ['src/layout.less', 'style'],

    // Documentation
    ['README.md', 'docs'],
    ['docs/guide.txt', 'docs'],
    ['docs/api.rst', 'docs'],

    // Type definitions
    ['src/types/index.d.ts', 'type'],
    ['src/types/api.ts', 'type'],
    ['src/interfaces/user.ts', 'type'],

    // Config files
    ['jest.config.ts', 'config'],
    ['.env.local', 'config'],
    ['config/database.ts', 'config'],

    // Shell scripts
    ['scripts/build.sh', 'script'],
    ['bin/deploy.bash', 'script'],
    ['setup.ps1', 'script'],

    // Controllers
    ['src/user.controller.ts', 'controller'],
    ['src/controllers/auth.ts', 'controller'],

    // Services
    ['src/user.service.ts', 'service'],
    ['src/services/auth.ts', 'service'],

    // Models
    ['src/user.model.ts', 'model'],
    ['src/user.entity.ts', 'model'],
    ['src/entities/user.ts', 'model'],

    // Utilities
    ['src/string.utils.ts', 'utility'],
    ['src/helpers/format.ts', 'utility'],
    ['lib/crypto.ts', 'utility'],

    // Views (extension-based)
    ['src/App.tsx', 'view'],
    ['src/Button.jsx', 'view'],
    ['src/Page.vue', 'view'],

    // Unknown
    ['src/main.ts', 'unknown'],
    ['src/index.js', 'unknown'],
  ] as const)('should classify %s as %s', (path, expected) => {
    expect(classifyFileRole(path)).toBe(expected);
  });

  it('should prioritize test over view for test.tsx', () => {
    expect(classifyFileRole('src/App.test.tsx')).toBe('test');
  });

  it('should prioritize test over service for test files in services dir', () => {
    expect(classifyFileRole('src/services/user.test.ts')).toBe('test');
  });
});

describe('DistrictSplittingService', () => {
  let service: DistrictSplittingService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [DistrictSplittingService],
    }).compile();

    service = module.get(DistrictSplittingService);
  });

  describe('splitOversizedDistricts', () => {
    it('should not split districts under the size threshold', () => {
      const district = makeDistrict({
        id: 'district:src/controllers',
        name: 'controllers',
        totalFiles: 5,
        totalLOC: 500,
      });
      const districtFileMap = new Map([
        ['src/controllers', ['src/controllers/a.ts', 'src/controllers/b.ts']],
      ]);
      const locMap = new Map([
        ['src/controllers/a.ts', 100],
        ['src/controllers/b.ts', 200],
      ]);

      const result = service.splitOversizedDistricts([district], districtFileMap, locMap, 100);

      expect(result.districts).toHaveLength(1);
      expect(result.districts[0].id).toBe('district:src/controllers');
    });

    it('should split districts exceeding MAX_DISTRICT_FILES (40)', () => {
      const files: string[] = [];
      const locMap = new Map<string, number>();
      for (let i = 0; i < 50; i++) {
        const ext = i % 2 === 0 ? '.ts' : '.css';
        const path = `src/components/file${i}${ext}`;
        files.push(path);
        locMap.set(path, 10);
      }

      const district = makeDistrict({
        id: 'district:src/components',
        name: 'components',
        totalFiles: 50,
        totalLOC: 500,
      });

      const districtFileMap = new Map([['src/components', files]]);

      const result = service.splitOversizedDistricts([district], districtFileMap, locMap, 200);

      expect(result.districts.length).toBeGreaterThan(1);
      // All sub-district names should include the parent name
      for (const d of result.districts) {
        expect(d.name).toContain('components');
      }
      // Total files across sub-districts should equal original
      const totalFiles = result.districts.reduce((sum, d) => sum + d.totalFiles, 0);
      expect(totalFiles).toBe(50);
    });

    it('should split districts exceeding MAX_DISTRICT_PERCENTAGE (15%)', () => {
      const files: string[] = [];
      const locMap = new Map<string, number>();
      for (let i = 0; i < 20; i++) {
        const subdir = i < 10 ? 'auth' : 'users';
        const path = `src/app/${subdir}/file${i}.ts`;
        files.push(path);
        locMap.set(path, 10);
      }

      const district = makeDistrict({
        id: 'district:src/app',
        name: 'app',
        totalFiles: 20,
        totalLOC: 200,
      });

      const districtFileMap = new Map([['src/app', files]]);

      // 20 files / 100 total = 20% > 15%
      const result = service.splitOversizedDistricts([district], districtFileMap, locMap, 100);

      expect(result.districts.length).toBeGreaterThan(1);
    });

    it('should not split when file count is below MIN_GROUP_SIZE * 2', () => {
      const district = makeDistrict({
        id: 'district:src/tiny',
        name: 'tiny',
        totalFiles: 3,
        totalLOC: 30,
      });
      const files = ['src/tiny/a.ts', 'src/tiny/b.ts', 'src/tiny/c.ts'];
      const districtFileMap = new Map([['src/tiny', files]]);
      const locMap = new Map(files.map((f) => [f, 10] as [string, number]));

      // Even if % threshold triggers (3/5 = 60%), min group size protects
      const result = service.splitOversizedDistricts([district], districtFileMap, locMap, 5);

      expect(result.districts).toHaveLength(1);
    });

    it('should split by next path segment when district is oversized', () => {
      const files: string[] = [];
      const locMap = new Map<string, number>();

      for (let i = 0; i < 25; i++) {
        const ctrlPath = `src/big/controllers/file${i}.ts`;
        const svcPath = `src/big/services/file${i}.ts`;
        files.push(ctrlPath, svcPath);
        locMap.set(ctrlPath, 10);
        locMap.set(svcPath, 20);
      }

      const district = makeDistrict({
        id: 'district:src/big',
        name: 'big',
        totalFiles: 50,
        totalLOC: 750,
      });

      const districtFileMap = new Map([['src/big', files]]);
      const result = service.splitOversizedDistricts([district], districtFileMap, locMap, 200);

      expect(result.districts.length).toBeGreaterThanOrEqual(2);
      const names = result.districts.map((d) => d.name);
      expect(names.some((n) => n.includes('controllers'))).toBe(true);
      expect(names.some((n) => n.includes('services'))).toBe(true);
    });

    it('should recurse into oversized subdirectories', () => {
      const files: string[] = [];
      const locMap = new Map<string, number>();

      // 50 files in modules/ (oversized), split across inner auth/ and users/
      for (let i = 0; i < 50; i++) {
        const innerDir = i < 25 ? 'auth' : 'users';
        const path = `src/deep/modules/${innerDir}/file${i}.ts`;
        files.push(path);
        locMap.set(path, 10);
      }
      // 10 files in config/ (not oversized)
      for (let i = 0; i < 10; i++) {
        const path = `src/deep/config/cfg${i}.ts`;
        files.push(path);
        locMap.set(path, 10);
      }

      const district = makeDistrict({
        id: 'district:src/deep',
        name: 'deep',
        totalFiles: 60,
        totalLOC: 600,
      });

      const districtFileMap = new Map([['src/deep', files]]);
      const result = service.splitOversizedDistricts([district], districtFileMap, locMap, 200);

      expect(result.districts.length).toBe(3);
      const names = result.districts.map((d) => d.name);
      expect(names.some((n) => n.includes('modules/auth'))).toBe(true);
      expect(names.some((n) => n.includes('modules/users'))).toBe(true);
      expect(names.some((n) => n.includes('config'))).toBe(true);
    });

    it('should recurse through single subdirectory to find split point', () => {
      const files: string[] = [];
      const locMap = new Map<string, number>();

      for (let i = 0; i < 25; i++) {
        const ctrlPath = `src/mono/src/controllers/file${i}.ts`;
        const svcPath = `src/mono/src/services/file${i}.ts`;
        files.push(ctrlPath, svcPath);
        locMap.set(ctrlPath, 10);
        locMap.set(svcPath, 10);
      }

      const district = makeDistrict({
        id: 'district:src/mono',
        name: 'mono',
        totalFiles: 50,
        totalLOC: 500,
      });

      const districtFileMap = new Map([['src/mono', files]]);
      const result = service.splitOversizedDistricts([district], districtFileMap, locMap, 200);

      expect(result.districts.length).toBeGreaterThanOrEqual(2);
      const names = result.districts.map((d) => d.name);
      expect(names.some((n) => n.includes('src/controllers'))).toBe(true);
      expect(names.some((n) => n.includes('src/services'))).toBe(true);
    });

    it('should handle mix of direct files and subdirectories', () => {
      const files: string[] = [];
      const locMap = new Map<string, number>();

      for (let i = 0; i < 5; i++) {
        const path = `src/mixed/file${i}.ts`;
        files.push(path);
        locMap.set(path, 10);
      }
      for (let i = 0; i < 45; i++) {
        const subdir = i < 25 ? 'core' : 'utils';
        const path = `src/mixed/${subdir}/item${i}.ts`;
        files.push(path);
        locMap.set(path, 10);
      }

      const district = makeDistrict({
        id: 'district:src/mixed',
        name: 'mixed',
        totalFiles: 50,
        totalLOC: 500,
      });

      const districtFileMap = new Map([['src/mixed', files]]);
      const result = service.splitOversizedDistricts([district], districtFileMap, locMap, 200);

      expect(result.districts.length).toBe(3);
      const names = result.districts.map((d) => d.name);
      expect(names.some((n) => n.includes('(files)'))).toBe(true);
      expect(names.some((n) => n.includes('core'))).toBe(true);
      expect(names.some((n) => n.includes('utils'))).toBe(true);
    });

    it('should assign distinct path values to split sub-districts', () => {
      const files: string[] = [];
      const locMap = new Map<string, number>();

      for (let i = 0; i < 25; i++) {
        const ctrlPath = `src/big/controllers/file${i}.ts`;
        const svcPath = `src/big/services/file${i}.ts`;
        files.push(ctrlPath, svcPath);
        locMap.set(ctrlPath, 10);
        locMap.set(svcPath, 20);
      }

      const district = makeDistrict({
        id: 'district:src/big',
        name: 'big',
        path: 'src',
        totalFiles: 50,
        totalLOC: 750,
      });

      const districtFileMap = new Map([['src/big', files]]);
      const result = service.splitOversizedDistricts([district], districtFileMap, locMap, 200);

      expect(result.districts.length).toBeGreaterThanOrEqual(2);

      // Each sub-district should have a distinct path
      const paths = result.districts.map((d) => d.path);
      expect(new Set(paths).size).toBe(paths.length);

      // Each path should be a prefix-extension of the parent's districtKey
      for (const d of result.districts) {
        expect(d.path).toContain('src/big');
      }

      // Specific paths should match the longest common prefix of their files
      const ctrlDistrict = result.districts.find((d) => d.name.includes('controllers'))!;
      expect(ctrlDistrict.path).toBe('src/big/controllers');

      const svcDistrict = result.districts.find((d) => d.name.includes('services'))!;
      expect(svcDistrict.path).toBe('src/big/services');
    });

    it('should fall back to alphabetical splitting as last resort', () => {
      const files: string[] = [];
      const locMap = new Map<string, number>();

      // All same extension, same role → alphabetical is the only option
      const letters = 'abcdefghijklmnopqrstuvwxyz';
      for (let i = 0; i < 50; i++) {
        const prefix = letters[i % 26];
        const path = `src/uniform/${prefix}item${String(i).padStart(2, '0')}.ts`;
        files.push(path);
        locMap.set(path, 10);
      }

      const district = makeDistrict({
        id: 'district:src/uniform',
        name: 'uniform',
        totalFiles: 50,
        totalLOC: 500,
      });

      const districtFileMap = new Map([['src/uniform', files]]);
      const result = service.splitOversizedDistricts([district], districtFileMap, locMap, 200);

      // Alphabetical always produces exactly 2 groups
      expect(result.districts).toHaveLength(2);
    });

    it('should compute correct totalLOC for sub-districts', () => {
      const files: string[] = [];
      const locMap = new Map<string, number>();
      let totalLOC = 0;

      for (let i = 0; i < 50; i++) {
        const ext = i % 2 === 0 ? '.test.ts' : '.service.ts';
        const path = `src/big/file${i}${ext}`;
        const loc = (i + 1) * 10;
        files.push(path);
        locMap.set(path, loc);
        totalLOC += loc;
      }

      const district = makeDistrict({
        id: 'district:src/big',
        name: 'big',
        totalFiles: 50,
        totalLOC,
      });

      const districtFileMap = new Map([['src/big', files]]);
      const result = service.splitOversizedDistricts([district], districtFileMap, locMap, 200);

      const subTotalLOC = result.districts.reduce((sum, d) => sum + d.totalLOC, 0);
      expect(subTotalLOC).toBe(totalLOC);
    });

    it('should preserve non-oversized districts unchanged', () => {
      const small = makeDistrict({
        id: 'district:src/small',
        name: 'small',
        totalFiles: 5,
        totalLOC: 100,
      });
      const big = makeDistrict({
        id: 'district:src/big',
        name: 'big',
        totalFiles: 50,
        totalLOC: 5000,
      });

      const smallFiles = Array.from({ length: 5 }, (_, i) => `src/small/f${i}.ts`);
      const letters = 'abcdefghijklmnopqrstuvwxyz';
      const bigFiles = Array.from({ length: 50 }, (_, i) => `src/big/${letters[i % 26]}${i}.ts`);
      const locMap = new Map([...smallFiles, ...bigFiles].map((f) => [f, 100] as [string, number]));

      const districtFileMap = new Map([
        ['src/small', smallFiles],
        ['src/big', bigFiles],
      ]);

      const result = service.splitOversizedDistricts([small, big], districtFileMap, locMap, 200);

      // Small district preserved
      expect(result.districts.some((d) => d.id === 'district:src/small')).toBe(true);
      // Big district split
      expect(result.districts.filter((d) => d.name.includes('big')).length).toBeGreaterThan(1);
    });

    it('should sort result districts by totalLOC descending', () => {
      const files: string[] = [];
      const locMap = new Map<string, number>();

      for (let i = 0; i < 50; i++) {
        const path = `src/sorted/file${i}.${i < 25 ? 'test.ts' : 'service.ts'}`;
        files.push(path);
        // Give services more LOC than tests
        locMap.set(path, i < 25 ? 5 : 50);
      }

      const district = makeDistrict({
        id: 'district:src/sorted',
        name: 'sorted',
        totalFiles: 50,
        totalLOC: 1375,
      });

      const districtFileMap = new Map([['src/sorted', files]]);
      const result = service.splitOversizedDistricts([district], districtFileMap, locMap, 200);

      for (let i = 1; i < result.districts.length; i++) {
        expect(result.districts[i - 1].totalLOC).toBeGreaterThanOrEqual(
          result.districts[i].totalLOC,
        );
      }
    });

    it('should update districtFileMap with sub-district keys', () => {
      const files: string[] = [];
      const locMap = new Map<string, number>();

      for (let i = 0; i < 50; i++) {
        const ext = i % 2 === 0 ? '.test.ts' : '.service.ts';
        const path = `src/big/file${i}${ext}`;
        files.push(path);
        locMap.set(path, 10);
      }

      const district = makeDistrict({
        id: 'district:src/big',
        name: 'big',
        totalFiles: 50,
        totalLOC: 500,
      });

      const districtFileMap = new Map([['src/big', files]]);
      const result = service.splitOversizedDistricts([district], districtFileMap, locMap, 200);

      // Original key should not be in the result map
      expect(result.districtFileMap.has('src/big')).toBe(false);
      // Sub-district keys should use colon separator
      for (const key of result.districtFileMap.keys()) {
        expect(key).toContain('src/big:');
      }
      // Total files across all sub-district entries
      let totalMapped = 0;
      for (const paths of result.districtFileMap.values()) {
        totalMapped += paths.length;
      }
      expect(totalMapped).toBe(50);
    });
  });
});
