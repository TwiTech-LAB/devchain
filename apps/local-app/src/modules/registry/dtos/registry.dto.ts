import { IsString, IsNotEmpty, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * DTO for restore-backup request body
 * Validates that backupId is present and follows expected format
 */
export class RestoreBackupDto {
  @ApiProperty({
    description: 'Backup ID from failed upgrade',
    example: 'backup-uuid-1234567890',
  })
  @IsString()
  @IsNotEmpty({ message: 'backupId is required' })
  @Matches(/^backup-/, { message: 'Invalid backup ID format' })
  backupId!: string;
}

/**
 * DTO for upgrade-project request body
 */
export class UpgradeProjectDto {
  @ApiProperty({
    description: 'Project UUID',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @IsString()
  @IsNotEmpty({ message: 'projectId is required' })
  projectId!: string;

  @ApiProperty({
    description: 'Target template version',
    example: '2.0.0',
  })
  @IsString()
  @IsNotEmpty({ message: 'targetVersion is required' })
  @Matches(/^\d+\.\d+\.\d+/, { message: 'targetVersion must be a valid semver (e.g., 1.0.0)' })
  targetVersion!: string;
}
