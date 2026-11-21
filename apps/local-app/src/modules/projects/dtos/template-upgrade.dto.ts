import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMinSize,
  IsArray,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
} from 'class-validator';
import type { PreserveTeamSetup } from '../../../common/project-preservation.contract';
import type { TemplatePresetAgentConfigDto } from '../../settings/dtos/settings.dto';

type UpgradeTeamOverride = {
  teamName: string;
  allowTeamLeadCreateAgents?: boolean;
  maxMembers?: number;
  maxConcurrentTasks?: number;
  profileNames?: string[];
  profileSelections?: Array<{ profileName: string; configNames: string[] }>;
};

export class UpgradeTemplateDto {
  @ApiProperty({
    description: 'Target template version',
    example: '2.0.0',
  })
  @IsString()
  @IsNotEmpty({ message: 'targetVersion is required' })
  @Matches(/^\d+\.\d+\.\d+/, { message: 'targetVersion must be a valid semver (e.g., 1.0.0)' })
  targetVersion!: string;

  @ApiPropertyOptional({
    type: [String],
    description: 'Provider names selected in the upgrade wizard',
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  selectedProviderNames?: string[];

  @ApiPropertyOptional({
    type: Object,
    description: 'Template provider family to installed provider mapping',
  })
  @IsOptional()
  @IsObject()
  familyProviderMappings?: Record<string, string>;

  @ApiPropertyOptional({ description: 'Target-template preset to apply' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  presetName?: string;

  @ApiPropertyOptional({
    type: [Object],
    description: 'Per-agent selections, mutually exclusive with presetName',
  })
  @IsOptional()
  @IsArray()
  agentOverrides?: TemplatePresetAgentConfigDto[];

  @ApiPropertyOptional({
    type: [Object],
    description: 'Per-team selections from the upgrade wizard',
  })
  @IsOptional()
  @IsArray()
  teamOverrides?: UpgradeTeamOverride[];

  @ApiPropertyOptional({
    type: Object,
    description: 'Template status name to existing status ID mapping',
  })
  @IsOptional()
  @IsObject()
  statusMappings?: Record<string, string>;

  @ApiPropertyOptional({
    type: Object,
    description:
      'Preserve current teams with optional additions, agent options and team permissions',
  })
  @IsOptional()
  @IsObject()
  preserveTeamSetup?: PreserveTeamSetup;
}

export class RestoreTemplateBackupDto {
  @ApiProperty({
    description: 'Backup ID from failed upgrade',
    example: 'backup-project-123-1710000000000',
  })
  @IsString()
  @IsNotEmpty({ message: 'backupId is required' })
  @Matches(/^backup-/, { message: 'Invalid backup ID format' })
  backupId!: string;
}

export class CreateProjectFromRegistryDto {
  @ApiProperty({
    description: 'Template slug',
    example: 'starter-project',
  })
  @IsString()
  @IsNotEmpty({ message: 'slug is required' })
  slug!: string;

  @ApiProperty({
    description: 'Template version',
    example: '1.0.0',
  })
  @IsString()
  @IsNotEmpty({ message: 'version is required' })
  @Matches(/^\d+\.\d+\.\d+/, { message: 'version must be a valid semver (e.g., 1.0.0)' })
  version!: string;

  @ApiProperty({
    description: 'New project name',
    example: 'My Project',
  })
  @IsString()
  @IsNotEmpty({ message: 'projectName is required' })
  projectName!: string;

  @ApiProperty({
    description: 'Project description',
    required: false,
  })
  @IsOptional()
  @IsString()
  projectDescription?: string;

  @ApiProperty({
    description: 'Project root path',
    example: '/workspace/my-project',
  })
  @IsString()
  @IsNotEmpty({ message: 'rootPath is required' })
  rootPath!: string;

  @ApiPropertyOptional({
    description: 'Destination workspace ID; omitted uses the Default workspace',
  })
  @IsOptional()
  @IsUUID()
  workspaceId?: string;
}

export interface TemplateBackupResponse {
  backupId: string;
  found: boolean;
  projectId?: string;
  createdAt?: string;
  fromVersion?: string;
}
