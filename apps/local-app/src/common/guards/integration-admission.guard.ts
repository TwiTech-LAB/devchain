import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { assertIntegrationAdmission } from '../config/integration-admission';

@Injectable()
export class IntegrationAdmissionGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    assertIntegrationAdmission();
    return true;
  }
}
