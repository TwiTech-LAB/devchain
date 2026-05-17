import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, Matches } from 'class-validator';

export class UpgradeTemplateDto {
  @ApiProperty({
    description: 'Target template version',
    example: '2.0.0',
  })
  @IsString()
  @IsNotEmpty({ message: 'targetVersion is required' })
  @Matches(/^\d+\.\d+\.\d+/, { message: 'targetVersion must be a valid semver (e.g., 1.0.0)' })
  targetVersion!: string;
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
}

export interface TemplateBackupResponse {
  backupId: string;
  found: boolean;
  projectId?: string;
  createdAt?: string;
  fromVersion?: string;
}
