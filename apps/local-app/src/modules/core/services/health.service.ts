import { Inject, Injectable, Optional } from '@nestjs/common';

export interface HealthReadiness {
  ready: boolean;
  checks: Record<string, 'ok' | 'fail'>;
}

export interface HealthReadinessChecker {
  getChecks(): Promise<Record<string, 'ok' | 'fail'>>;
}

export const HEALTH_READINESS_CHECKER = 'HEALTH_READINESS_CHECKER';

@Injectable()
export class HealthService {
  constructor(
    @Optional()
    @Inject(HEALTH_READINESS_CHECKER)
    private readonly readinessChecker?: HealthReadinessChecker,
  ) {}

  async getReadiness(): Promise<HealthReadiness> {
    const checks = (await this.readinessChecker?.getChecks()) ?? {};
    const statuses = Object.values(checks);
    const ready = statuses.length > 0 && statuses.every((status) => status === 'ok');

    return {
      ready,
      checks,
    };
  }
}
