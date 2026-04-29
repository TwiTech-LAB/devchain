import {
  Controller,
  Get,
  Put,
  Body,
  Inject,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  NotFoundException,
  UnprocessableEntityException,
  BadRequestException,
} from '@nestjs/common';
import { STORAGE_SERVICE, type StorageService } from '../../storage/interfaces/storage.interface';
import { CodebaseOverviewAnalyzerService } from '../services/codebase-overview-analyzer.service';
import { ScopeResolverService } from '../services/scope-resolver.service';
import { ScopeAutoDetectorService } from '../services/scope-auto-detector.service';
import { OverviewScopeRepository } from '../repositories/overview-scope.repository';
import type {
  CodebaseOverviewSnapshot,
  TargetDetail,
  DependencyPairDetail,
  DistrictFilePage,
} from '@devchain/codebase-overview';
import type { FolderScopeEntry } from '../types/scope.types';
import { FolderScopeEntrySchema } from '../types/scope.schema';
import { z } from 'zod';
import type { Dirent } from 'fs';
import * as fsPromises from 'fs/promises';
import { BUILT_IN_SCOPE_DEFAULTS } from '../types/scope-defaults';
import { MAX_FOLDER_DEPTH } from '../utils/constants';

interface ScopeResponse {
  entries: FolderScopeEntry[];
  storageMode: 'repo-file' | 'local-only';
}

@Controller('api/projects')
export class CodebaseOverviewController {
  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    private readonly analyzer: CodebaseOverviewAnalyzerService,
    private readonly scopeResolver: ScopeResolverService,
    private readonly scopeAutoDetector: ScopeAutoDetectorService,
    private readonly scopeRepository: OverviewScopeRepository,
  ) {}

  @Get(':id/codebase-overview')
  async getSnapshot(@Param('id') id: string): Promise<CodebaseOverviewSnapshot> {
    const project = await this.storage.getProject(id);
    return this.analyzer.getSnapshot(project.rootPath, project.id);
  }

  @Get(':id/codebase-overview/targets/:targetId')
  async getTargetDetails(
    @Param('id') id: string,
    @Param('targetId') targetId: string,
  ): Promise<TargetDetail> {
    const project = await this.storage.getProject(id);
    const result = await this.analyzer.getTargetDetails(project.rootPath, targetId);
    if (!result) throw new NotFoundException('Target not found');
    return result;
  }

  @Get(':id/codebase-overview/pairs/:fromId/:toId')
  async getDependencyPairDetails(
    @Param('id') id: string,
    @Param('fromId') fromId: string,
    @Param('toId') toId: string,
  ): Promise<DependencyPairDetail> {
    const project = await this.storage.getProject(id);
    const result = this.analyzer.getDependencyPairDetails(project.rootPath, fromId, toId);
    if (!result) throw new NotFoundException('District pair not found');
    return result;
  }

  @Get(':id/codebase-overview/districts/:districtId/files')
  async listDistrictFiles(
    @Param('id') id: string,
    @Param('districtId') districtId: string,
    @Query('cursor') cursor?: string,
  ): Promise<DistrictFilePage> {
    const project = await this.storage.getProject(id);
    const result = this.analyzer.listDistrictFiles(project.rootPath, districtId, cursor);
    if (!result) throw new NotFoundException('District not found');
    return result;
  }

  @Get(':id/codebase-overview/scope')
  async getScope(@Param('id') id: string): Promise<ScopeResponse> {
    const project = await this.storage.getProject(id);
    const userEntries = this.scopeRepository.readUserEntries(project.rootPath, project.id);
    const autoDetected = await this.detectFolders(project.rootPath);
    const resolved = this.scopeResolver.resolve(userEntries, autoDetected);
    const storageMode = this.scopeRepository.getStorageMode(project.rootPath);
    return { entries: resolved, storageMode };
  }

  @Put(':id/codebase-overview/scope')
  @HttpCode(HttpStatus.OK)
  async putScope(
    @Param('id') id: string,
    @Body() body: { entries: FolderScopeEntry[] },
  ): Promise<ScopeResponse> {
    const project = await this.storage.getProject(id);

    this.validateScopeEntries(body.entries);
    // Persist only explicit user overrides; defaults/auto-detected entries are re-derived on GET
    const userOnlyEntries = body.entries.filter((e) => e.origin === 'user');

    try {
      await this.scopeRepository.writeUserEntries(project.rootPath, project.id, userOnlyEntries);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error) {
        const writeError = error as { code: string; message: string; manualEditPath?: string };
        if (
          writeError.code === 'PERMISSION_DENIED' ||
          writeError.code === 'READ_ONLY_FILESYSTEM' ||
          writeError.code === 'DISK_FULL' ||
          writeError.code === 'INVALID_PATH'
        ) {
          throw new UnprocessableEntityException({
            code: writeError.code,
            message: writeError.message,
            manualEditPath: writeError.manualEditPath,
          });
        }
      }
      throw error;
    }

    const userEntries = this.scopeRepository.readUserEntries(project.rootPath, project.id);
    const autoDetected = await this.detectFolders(project.rootPath);
    const resolved = this.scopeResolver.resolve(userEntries, autoDetected);
    const storageMode = this.scopeRepository.getStorageMode(project.rootPath);
    return { entries: resolved, storageMode };
  }

  private async detectFolders(projectRoot: string): Promise<FolderScopeEntry[]> {
    const LITERAL_EXCLUDED_PATHS = new Set(
      BUILT_IN_SCOPE_DEFAULTS.filter((e) => e.purpose === 'excluded').map((e) => e.folder),
    );
    const observed = new Set<string>();

    const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
      if (depth > MAX_FOLDER_DEPTH) return;
      let entries: Dirent<string>[];
      try {
        entries = await fsPromises.readdir(dir, { withFileTypes: true, encoding: 'utf8' });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const name = entry.name;
        if (name === '.git') continue;
        const relPath = rel ? `${rel}/${name}` : name;
        if (LITERAL_EXCLUDED_PATHS.has(relPath)) continue;
        observed.add(relPath);
        await walk(`${dir}/${name}`, relPath, depth + 1);
      }
    };

    await walk(projectRoot, '', 1);
    return this.scopeAutoDetector.detect([...observed]);
  }

  private validateScopeEntries(entries: unknown): asserts entries is FolderScopeEntry[] {
    const result = z.array(FolderScopeEntrySchema).safeParse(entries);
    if (!result.success) {
      const first = result.error.errors[0];
      throw new BadRequestException(first?.message ?? 'Invalid scope entries');
    }
  }
}
