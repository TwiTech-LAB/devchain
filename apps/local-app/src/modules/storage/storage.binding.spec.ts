import { Test, TestingModule } from '@nestjs/testing';
import { StorageModule } from './storage.module';
import { STORAGE_SERVICE } from './interfaces/storage.interface';
import { LocalStorageService } from './local/local-storage.service';

describe('StorageModule binding', () => {
  let module: TestingModule;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [StorageModule],
    }).compile();
  });

  afterAll(async () => {
    await module.close();
  });

  it('should bind STORAGE_SERVICE token to LocalStorageService instance', () => {
    const storageService = module.get(STORAGE_SERVICE);

    expect(storageService).toBeDefined();
    expect(storageService).toBeInstanceOf(LocalStorageService);
  });

  it('should provide a singleton LocalStorageService instance', () => {
    const instance1 = module.get(STORAGE_SERVICE);
    const instance2 = module.get(STORAGE_SERVICE);

    expect(instance1).toBe(instance2);
  });
});
