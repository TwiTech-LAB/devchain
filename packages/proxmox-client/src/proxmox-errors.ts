import { DomainError } from "./domain-error";

export type ProxmoxErrorCode =
  | "proxmox_transport"
  | "proxmox_timeout"
  | "proxmox_tls"
  | "proxmox_redirect"
  | "proxmox_denied"
  | "proxmox_api"
  | "proxmox_digest_conflict"
  | "proxmox_task"
  | "proxmox_response";

/**
 * A Proxmox interaction failed. Messages are constructed to be operator-safe:
 * they never contain the API token, the Authorization header, or raw remote
 * bodies — only the method, path, and a safe status/cause summary.
 */
export class ProxmoxRemoteError extends DomainError {
  static readonly TLS_ERROR_CODES = new Set([
    "ERR_TLS_CERT_ALTNAME_INVALID",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "SELF_SIGNED_CERT_IN_CHAIN",
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "CERT_HAS_EXPIRED",
    "ERR_SSL_CA_CERT_REQUIRED",
    "EPROTO",
    "ERR_TLS_CERT_FINGERPRINT_MISMATCH",
  ]);

  constructor(
    code: ProxmoxErrorCode,
    message: string,
    statusCode: number = 502,
    details?: Record<string, unknown>,
  ) {
    super(message, code, statusCode, details);
    this.name = "ProxmoxRemoteError";
  }

  /**
   * Maps a node transport error to a safe Proxmox error. Node error messages
   * can carry hostnames and TLS reasons but never our Authorization header;
   * only the stable error code is surfaced.
   */
  static fromTransportError(
    err: Error & { code?: string },
    method: string,
    path: string,
  ): ProxmoxRemoteError {
    if (
      err.code === "ECONNREFUSED" ||
      err.code === "ENOTFOUND" ||
      err.code === "EAI_AGAIN"
    ) {
      return new ProxmoxRemoteError(
        "proxmox_transport",
        `Proxmox host could not be reached for ${method} ${path} (${err.code})`,
        502,
      );
    }

    if (err.code && ProxmoxRemoteError.TLS_ERROR_CODES.has(err.code)) {
      return new ProxmoxRemoteError(
        "proxmox_tls",
        `Proxmox TLS verification failed for ${method} ${path} (${err.code})`,
        502,
      );
    }

    return new ProxmoxRemoteError(
      "proxmox_transport",
      `Proxmox request failed for ${method} ${path}`,
      502,
    );
  }
}
