import { Injectable } from '@nestjs/common';
import { createLogger } from '../../../common/logging/logger';

const logger = createLogger('ProbeProofService');

interface ProbeProof {
  binPath: string;
  timestamp: number;
}

/**
 * In-memory store for server-verified Claude 1M probe results.
 *
 * Proof is tied to provider ID + binPath. Changing binPath invalidates
 * prior proof and requires a fresh probe before oneMillionContextEnabled
 * can be set to true.
 */
@Injectable()
export class ProbeProofService {
  private readonly proofs = new Map<string, ProbeProof>();

  /** Record a successful probe for the given provider and binary path. */
  recordProof(providerId: string, binPath: string): void {
    this.proofs.set(providerId, { binPath, timestamp: Date.now() });
    logger.info({ providerId, binPath }, 'Recorded 1M probe proof');
  }

  /**
   * Check whether a valid proof exists for the given provider and binary path.
   * Returns false if no proof exists or if binPath has changed since the probe.
   */
  hasValidProof(providerId: string, binPath: string): boolean {
    const proof = this.proofs.get(providerId);
    if (!proof) return false;
    return proof.binPath === binPath;
  }

  /** Clear proof for a provider (e.g., on deletion). */
  clearProof(providerId: string): void {
    this.proofs.delete(providerId);
  }
}
