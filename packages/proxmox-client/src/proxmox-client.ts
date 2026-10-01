import * as https from "node:https";
import * as tls from "node:tls";
import { ProxmoxRemoteError } from "./proxmox-errors";

/**
 * Connection target for one Proxmox instance. The origin is the normalized
 * `https://host[:port]` form; TLS verification always stays on, optionally
 * supplying a per-instance CA bundle, server name, and leaf fingerprint.
 */
export interface ProxmoxTarget {
  origin: string;
  tokenId: string;
  tokenSecret: string;
  caPem?: string | null;
  tlsServerName?: string | null;
  /** SHA-256 fingerprint of the leaf certificate, with or without colons. */
  tlsFingerprint?: string | null;
}

export interface ProxmoxClientConfig {
  /** Bounded per-request timeout in milliseconds. */
  requestTimeoutMs: number;
  /** Response bodies above this size are rejected. */
  maxResponseBytes: number;
}

export interface ProxmoxNode {
  node: string;
  status: string;
}

export interface ProxmoxStorage {
  storage: string;
  type: string;
  active: number;
  shared: number;
  /** Comma-separated content types, e.g. "images,iso". */
  content?: string;
  enabled?: number;
}

export interface ProxmoxQemuEntry {
  vmid: number;
  name?: string;
  template?: number;
  status?: string;
  node?: string;
}

export interface ProxmoxVmConfig {
  cores?: number;
  sockets?: number;
  /** Memory in MiB. */
  memory?: number;
  /** Balloon floor in MiB; 0 or absent means disabled. */
  balloon?: number;
  /** Disk/volume config lines keyed by config slot (scsi0, ide2, ...). */
  [key: string]: unknown;
}

export interface ProxmoxTaskStatus {
  status: "running" | "stopped" | "unknown";
  exitstatus?: string | null;
}

export interface ProxmoxStorageContent {
  volid: string;
  content?: string;
  size?: number;
  [key: string]: unknown;
}

export interface ProxmoxDownloadOptions {
  content: "import";
  filename: string;
  url: string;
  checksum?: string;
  checksumAlgorithm?: "sha256" | "sha512" | "md5";
}

export interface ProxmoxCreateVmOptions {
  vmid: number;
  pool: string;
  tags: string;
  name: string;
  scsi0ImportFrom: string;
  cloudInitDrive: string;
  agent: string;
  ipconfig0: string;
  net0: string;
  cores: number;
  memory: number;
  description?: string;
}

export type ProxmoxCloneVmOptions = {
  name: string;
  description?: string;
  full?: boolean;
  pool?: string;
  storage?: string;
} & ({ newId: number; newid?: never } | { newid: number; newId?: never });

interface ResolvedOrigin {
  hostname: string;
  port: number;
  displayOrigin: string;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function taskReference(result: unknown, operation: string): string {
  if (typeof result !== "string" || result.length === 0) {
    throw new ProxmoxRemoteError(
      "proxmox_response",
      `${operation} did not return a task reference`,
    );
  }
  return result;
}

function normalizeFingerprint(value: string): string {
  const normalized = value.replace(/:/g, "").toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(normalized)) {
    throw new ProxmoxRemoteError(
      "proxmox_tls",
      "Invalid Proxmox TLS fingerprint",
    );
  }
  return normalized;
}

function resolveOrigin(origin: string): ResolvedOrigin {
  const url = new URL(origin);
  if (url.protocol !== "https:") {
    throw new ProxmoxRemoteError(
      "proxmox_transport",
      "Proxmox origin must use HTTPS",
    );
  }
  if (url.username || url.password) {
    throw new ProxmoxRemoteError(
      "proxmox_transport",
      "Proxmox origin must not embed credentials",
    );
  }
  if (url.search || url.hash) {
    throw new ProxmoxRemoteError(
      "proxmox_transport",
      "Proxmox origin must not include a query or fragment",
    );
  }
  if (url.pathname !== "" && url.pathname !== "/") {
    throw new ProxmoxRemoteError(
      "proxmox_transport",
      "Proxmox origin must not include a path",
    );
  }

  return {
    hostname: url.hostname,
    port: url.port ? Number(url.port) : 443,
    displayOrigin: origin,
  };
}

function validatePath(path: string): void {
  if (
    !path.startsWith("/") ||
    path.includes("#") ||
    /[\s\u0000-\u001f]/.test(path)
  ) {
    throw new ProxmoxRemoteError(
      "proxmox_transport",
      "Invalid Proxmox request path",
    );
  }
}

function proxmoxErrorFieldNames(body: unknown): string[] {
  if (typeof body !== "object" || body === null || Array.isArray(body))
    return [];
  const errors = (body as Record<string, unknown>).errors;
  if (typeof errors !== "object" || errors === null || Array.isArray(errors))
    return [];
  return Object.keys(errors)
    .filter((name) => /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(name))
    .slice(0, 5);
}

/**
 * Maps a remote rejection caused by a conditional-write digest mismatch to
 * the dedicated error code so callers can stop for reconfirmation instead
 * of treating it as a generic API failure. Proxmox rejects a stale digest
 * with a 400 whose errors map carries `digest: "checksum mismatch"` — the
 * API error preserves only that known-safe cause, and only it classifies
 * as a conflict; any other API failure keeps its original classification.
 */
function mapDigestConflict(error: unknown): unknown {
  if (
    error instanceof ProxmoxRemoteError &&
    error.code === "proxmox_api" &&
    /checksum mismatch/i.test(error.message)
  ) {
    return new ProxmoxRemoteError(
      "proxmox_digest_conflict",
      "The remote config changed since it was read; the conditional write was rejected",
      409,
    );
  }
  return error;
}

/**
 * Minimal Proxmox VE API client over node:https.request. TLS verification
 * stays enabled with optional CA, server-name, and leaf-fingerprint checks.
 * Redirects are rejected; requests and response bodies are bounded.
 */
export class ProxmoxClient {
  private readonly config: ProxmoxClientConfig;

  constructor(config: ProxmoxClientConfig) {
    this.config = config;
  }

  async getVersion(target: ProxmoxTarget): Promise<Record<string, unknown>> {
    return (await this.request(target, {
      method: "GET",
      path: "/api2/json/version",
    })) as Record<string, unknown>;
  }

  async getNodes(target: ProxmoxTarget): Promise<ProxmoxNode[]> {
    return (await this.request(target, {
      method: "GET",
      path: "/api2/json/nodes",
    })) as ProxmoxNode[];
  }

  async getNodeStorage(
    target: ProxmoxTarget,
    node: string,
  ): Promise<ProxmoxStorage[]> {
    return (await this.request(target, {
      method: "GET",
      path: `/api2/json/nodes/${encodeURIComponent(node)}/storage`,
    })) as ProxmoxStorage[];
  }

  async listStorageContent(
    target: ProxmoxTarget,
    node: string,
    storage: string,
    content: string,
  ): Promise<ProxmoxStorageContent[]> {
    return (await this.request(target, {
      method: "GET",
      path: `/api2/json/nodes/${encodeURIComponent(node)}/storage/${encodeURIComponent(storage)}/content?content=${encodeURIComponent(content)}`,
    })) as ProxmoxStorageContent[];
  }

  async downloadUrl(
    target: ProxmoxTarget,
    node: string,
    storage: string,
    options: ProxmoxDownloadOptions,
  ): Promise<string> {
    const result = await this.request(target, {
      method: "POST",
      path: `/api2/json/nodes/${encodeURIComponent(node)}/storage/${encodeURIComponent(storage)}/download-url`,
      body: {
        content: options.content,
        filename: options.filename,
        url: options.url,
        ...(options.checksum ? { checksum: options.checksum } : {}),
        ...(options.checksumAlgorithm
          ? { "checksum-algorithm": options.checksumAlgorithm }
          : {}),
      },
    });
    return taskReference(result, "Download");
  }

  async createVm(
    target: ProxmoxTarget,
    node: string,
    options: ProxmoxCreateVmOptions,
  ): Promise<string> {
    const result = await this.request(target, {
      method: "POST",
      path: `/api2/json/nodes/${encodeURIComponent(node)}/qemu`,
      body: {
        vmid: String(options.vmid),
        pool: options.pool,
        tags: options.tags,
        name: options.name,
        ostype: "l26",
        // Proxmox's kvm64 default hides instructions required by the provider CLIs.
        cpu: "host",
        scsihw: "virtio-scsi-single",
        scsi0: options.scsi0ImportFrom,
        ide2: options.cloudInitDrive,
        boot: "order=scsi0",
        serial0: "socket",
        vga: "serial0",
        agent: options.agent,
        ipconfig0: options.ipconfig0,
        net0: options.net0,
        cores: String(options.cores),
        memory: String(options.memory),
        ...(options.description ? { description: options.description } : {}),
      },
    });
    return taskReference(result, "Create");
  }

  async getQemuList(
    target: ProxmoxTarget,
    node: string,
  ): Promise<ProxmoxQemuEntry[]> {
    return (await this.request(target, {
      method: "GET",
      path: `/api2/json/nodes/${encodeURIComponent(node)}/qemu`,
    })) as ProxmoxQemuEntry[];
  }

  /**
   * Cluster-wide resource listing; type 'vm' includes templates across nodes.
   * The listing is permission-filtered: a token without VM.Audit on a VM's
   * path receives HTTP 200 with that VM omitted. Never treat omission from
   * this listing as absence without established visibility.
   */
  async getClusterVmResources(
    target: ProxmoxTarget,
  ): Promise<ProxmoxQemuEntry[]> {
    return (await this.request(target, {
      method: "GET",
      path: "/api2/json/cluster/resources?type=vm",
    })) as ProxmoxQemuEntry[];
  }

  /**
   * The caller's own EFFECTIVE privileges for one exact VM ACL path. PVE's
   * permissions endpoint accepts an explicit path filter and answers with the
   * effective map keyed by that path; a non-propagating grant reports value 0
   * at its own path while still applying there, so privilege PRESENCE — not
   * the numeric flag — is what visibility means (propagation only governs
   * inheritance to child paths).
   */
  async getOwnVmAclPermissions(
    target: ProxmoxTarget,
    vmid: number,
  ): Promise<Record<string, Record<string, number>>> {
    if (!Number.isInteger(vmid) || vmid <= 0) {
      throw new ProxmoxRemoteError(
        "proxmox_api",
        "Invalid VMID for an ACL path query",
      );
    }
    const aclPath = `/vms/${vmid}`;
    return (await this.request(target, {
      method: "GET",
      path: `/api2/json/access/permissions?path=${encodeURIComponent(aclPath)}`,
    })) as Record<string, Record<string, number>>;
  }

  /** Raw QEMU config of one VM or template (disk lines, cpu, memory, balloon). */
  async getVmConfig(
    target: ProxmoxTarget,
    node: string,
    vmid: number,
  ): Promise<ProxmoxVmConfig> {
    return (await this.request(target, {
      method: "GET",
      path: `/api2/json/nodes/${encodeURIComponent(node)}/qemu/${vmid}/config`,
    })) as ProxmoxVmConfig;
  }

  /**
   * Cluster nextid suggestion. A candidate lookup only: callers must still
   * advance past local reservations and live remote occupancy, and a
   * conflicting remote VM is never adopted.
   */
  async getNextId(target: ProxmoxTarget): Promise<number> {
    const result = (await this.request(target, {
      method: "GET",
      path: "/api2/json/cluster/nextid",
    })) as unknown;
    const parsed = typeof result === "string" ? Number(result) : Number(result);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new ProxmoxRemoteError(
        "proxmox_response",
        "Proxmox nextid returned a non-integer",
      );
    }
    return parsed;
  }

  async convertToTemplate(
    target: ProxmoxTarget,
    node: string,
    vmid: number,
  ): Promise<string> {
    return taskReference(
      await this.request(target, {
        method: "POST",
        path: `/api2/json/nodes/${encodeURIComponent(node)}/qemu/${vmid}/template`,
      }),
      "Template conversion",
    );
  }

  /**
   * Submits a full clone of a template and returns the task UPID. The
   * description marker correlates the cloned VM with our local resource.
   */
  async cloneVm(
    target: ProxmoxTarget,
    node: string,
    templateVmid: number,
    options: ProxmoxCloneVmOptions,
  ): Promise<string> {
    const result = (await this.request(target, {
      method: "POST",
      path: `/api2/json/nodes/${encodeURIComponent(node)}/qemu/${templateVmid}/clone`,
      body: {
        newid: String(options.newId ?? options.newid),
        name: options.name,
        full: options.full === false ? "0" : "1",
        ...(options.description !== undefined
          ? { description: options.description }
          : {}),
        ...(options.pool ? { pool: options.pool } : {}),
        ...(options.storage ? { storage: options.storage } : {}),
      },
    })) as unknown;

    if (typeof result !== "string" || result.length === 0) {
      throw new ProxmoxRemoteError(
        "proxmox_response",
        "Clone did not return a task reference",
      );
    }
    return result;
  }

  async setConfig(
    target: ProxmoxTarget,
    node: string,
    vmid: number,
    cores: number,
    memory: number,
  ): Promise<string | null> {
    const result = await this.request(target, {
      method: "PUT",
      path: `/api2/json/nodes/${encodeURIComponent(node)}/qemu/${vmid}/config`,
      body: { cores: String(cores), memory: String(memory) },
    });
    return typeof result === "string" && result.length > 0 ? result : null;
  }

  async resizeDisk(
    target: ProxmoxTarget,
    node: string,
    vmid: number,
    disk: string,
    size: string,
  ): Promise<string | null> {
    const result = await this.request(target, {
      method: "PUT",
      path: `/api2/json/nodes/${encodeURIComponent(node)}/qemu/${vmid}/resize`,
      body: { disk, size },
    });
    return typeof result === "string" && result.length > 0 ? result : null;
  }

  /**
   * Synchronous conditional config update (CPU/RAM). The freshly-read remote
   * digest travels as the conditional-write parameter: a config that moved
   * since the read is rejected by the remote instead of overwritten. A null
   * data response is the normal synchronous success — no task reference is
   * required.
   */
  async updateVmConfig(
    target: ProxmoxTarget,
    node: string,
    vmid: number,
    params: Record<string, string>,
    digest?: string,
  ): Promise<void> {
    await this.request(target, {
      method: "PUT",
      path: `/api2/json/nodes/${encodeURIComponent(node)}/qemu/${vmid}/config`,
      body: digest ? { ...params, digest } : params,
    }).catch((error) => {
      throw mapDigestConflict(error);
    });
  }

  /**
   * Grows one disk to an ABSOLUTE capacity in bytes over PUT, carrying the
   * freshly-read remote digest as the conditional-write parameter. The size
   * is never expressed as a relative increment — replays cannot compound
   * growth. Returns the task UPID when the remote answers asynchronously.
   */
  async resizeVmDisk(
    target: ProxmoxTarget,
    node: string,
    vmid: number,
    diskId: string,
    sizeBytes: number,
    digest?: string,
  ): Promise<string | null> {
    const result = (await this.request(target, {
      method: "PUT",
      path: `/api2/json/nodes/${encodeURIComponent(node)}/qemu/${vmid}/resize`,
      body: {
        disk: diskId,
        size: String(sizeBytes),
        ...(digest ? { digest } : {}),
      },
    }).catch((error) => {
      throw mapDigestConflict(error);
    })) as unknown;

    // Synchronous completion without a task reference is valid.
    return typeof result === "string" && result.length > 0 ? result : null;
  }

  /** Explicit power-on; returns the start task UPID. */
  async startVm(
    target: ProxmoxTarget,
    node: string,
    vmid: number,
  ): Promise<string> {
    const result = (await this.request(target, {
      method: "POST",
      path: `/api2/json/nodes/${encodeURIComponent(node)}/qemu/${vmid}/status/start`,
    })) as unknown;
    if (typeof result !== "string" || result.length === 0) {
      throw new ProxmoxRemoteError(
        "proxmox_response",
        "Start did not return a task reference",
      );
    }
    return result;
  }

  async stopVm(
    target: ProxmoxTarget,
    node: string,
    vmid: number,
  ): Promise<string> {
    return taskReference(
      await this.request(target, {
        method: "POST",
        path: `/api2/json/nodes/${encodeURIComponent(node)}/qemu/${vmid}/status/stop`,
      }),
      "Stop",
    );
  }

  async getAgentNetworkInterfaces(
    target: ProxmoxTarget,
    node: string,
    vmid: number,
  ): Promise<string | null> {
    const data = (await this.request(target, {
      method: "GET",
      path: `/api2/json/nodes/${encodeURIComponent(node)}/qemu/${vmid}/agent/network-get-interfaces`,
    })) as {
      result?: Array<{
        name?: string;
        "ip-addresses"?: Array<{
          "ip-address-type"?: string;
          "ip-address"?: string;
        }>;
      }>;
    };
    for (const networkInterface of data?.result ?? []) {
      if (networkInterface.name === "lo") continue;
      const address = networkInterface["ip-addresses"]?.find(
        (entry) => entry["ip-address-type"] === "ipv4" && entry["ip-address"],
      )?.["ip-address"];
      if (address) return address;
    }
    return null;
  }

  /**
   * Reads one guest file through the QEMU guest agent. Content above
   * `maxBytes` is refused and never buffered past a small multiple of it.
   */
  async readAgentFile(
    target: ProxmoxTarget,
    node: string,
    vmid: number,
    file: string,
    maxBytes: number,
  ): Promise<string> {
    const path = `/api2/json/nodes/${encodeURIComponent(node)}/qemu/${vmid}/agent/file-read`;
    const data = (await this.request(target, {
      method: "GET",
      path: `${path}?file=${encodeURIComponent(file)}`,
      // JSON escaping can grow each content byte to six characters.
      maxResponseBytes: maxBytes * 6 + 1024,
    })) as { content?: unknown; truncated?: unknown };
    if (typeof data?.content !== "string") {
      throw new ProxmoxRemoteError(
        "proxmox_response",
        `Proxmox returned no file content for GET ${path}`,
      );
    }
    if (data.truncated || Buffer.byteLength(data.content, "utf8") > maxBytes) {
      throw new ProxmoxRemoteError(
        "proxmox_response",
        `The guest file is larger than ${maxBytes} bytes for GET ${path}`,
      );
    }
    return data.content;
  }

  /** Graceful ACPI shutdown only — there is no force-stop path in this API. */
  async shutdownVm(
    target: ProxmoxTarget,
    node: string,
    vmid: number,
    timeoutSeconds?: number,
  ): Promise<string> {
    const result = (await this.request(target, {
      method: "POST",
      path: `/api2/json/nodes/${encodeURIComponent(node)}/qemu/${vmid}/status/shutdown`,
      ...(timeoutSeconds ? { body: { timeout: String(timeoutSeconds) } } : {}),
    })) as unknown;
    if (typeof result !== "string" || result.length === 0) {
      throw new ProxmoxRemoteError(
        "proxmox_response",
        "Shutdown did not return a task reference",
      );
    }
    return result;
  }

  /**
   * Destroys the VM. Callers must have verified it is stopped and positively
   * identified; a synchronous null response is still treated as submitted
   * (the executor verifies absence afterwards).
   */
  async deleteVm(
    target: ProxmoxTarget,
    node: string,
    vmid: number,
    options?: { purge?: boolean; destroyUnreferencedDisks?: boolean },
  ): Promise<string | null> {
    const query = new URLSearchParams();
    if (options?.purge !== undefined)
      query.set("purge", options.purge ? "1" : "0");
    if (options?.destroyUnreferencedDisks !== undefined) {
      query.set(
        "destroy-unreferenced-disks",
        options.destroyUnreferencedDisks ? "1" : "0",
      );
    }
    const queryString = query.toString();
    const result = (await this.request(target, {
      method: "DELETE",
      path: `/api2/json/nodes/${encodeURIComponent(node)}/qemu/${vmid}${queryString ? `?${queryString}` : ""}`,
    })) as unknown;
    return typeof result === "string" && result.length > 0 ? result : null;
  }

  async getTaskStatus(
    target: ProxmoxTarget,
    node: string,
    upid: string,
    timeoutMs?: number,
  ): Promise<ProxmoxTaskStatus> {
    return (await this.request(target, {
      method: "GET",
      path: `/api2/json/nodes/${encodeURIComponent(node)}/tasks/${encodeURIComponent(upid)}/status`,
      timeoutMs,
    })) as ProxmoxTaskStatus;
  }

  async waitForTask(
    target: ProxmoxTarget,
    node: string,
    upid: string,
    timeoutMs: number,
  ): Promise<void> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new ProxmoxRemoteError(
        "proxmox_timeout",
        "Invalid Proxmox task timeout",
        504,
      );
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const status = await this.getTaskStatus(
        target,
        node,
        upid,
        Math.min(this.config.requestTimeoutMs, deadline - Date.now()),
      );
      if (status.status === "stopped") {
        if (status.exitstatus === "OK") return;
        throw new ProxmoxRemoteError("proxmox_task", "Proxmox task failed");
      }
      const remaining = deadline - Date.now();
      if (remaining > 0) {
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(2000, remaining)),
        );
      }
    }
    throw new ProxmoxRemoteError(
      "proxmox_timeout",
      "Proxmox task did not finish before the timeout",
      504,
    );
  }

  async request(
    target: ProxmoxTarget,
    options: {
      method: "GET" | "POST" | "PUT" | "DELETE";
      path: string;
      /** Form-encoded request body (Proxmox mutation parameters). */
      body?: Record<string, string>;
      timeoutMs?: number;
      /** Lowers the configured response size limit for this request. */
      maxResponseBytes?: number;
    },
  ): Promise<unknown> {
    validatePath(options.path);
    const maxResponseBytes = Math.min(
      options.maxResponseBytes ?? this.config.maxResponseBytes,
      this.config.maxResponseBytes,
    );
    const resolved = resolveOrigin(target.origin);
    const fingerprint = target.tlsFingerprint
      ? normalizeFingerprint(target.tlsFingerprint)
      : null;

    // Form-encoded body for mutations; values are our own bounded parameters.
    const body = options.body
      ? new URLSearchParams(
          Object.entries(options.body).map(([key, value]) => [
            key,
            String(value),
          ]),
        ).toString()
      : undefined;

    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: resolved.hostname,
          port: resolved.port,
          path: options.path,
          method: options.method,
          rejectUnauthorized: true,
          ...(fingerprint ? { agent: false } : {}),
          ...(target.caPem ? { ca: target.caPem } : {}),
          ...(target.tlsServerName ? { servername: target.tlsServerName } : {}),
          ...(fingerprint
            ? {
                // A pinned SHA-256 fingerprint identifies one exact certificate,
                // which is stronger than a name match. Proxmox node certificates
                // list only the names and addresses from the node's own hosts
                // file, so the name check would reject a valid address such as
                // the LAN IP the operator connects with. Chain validation stays on.
                checkServerIdentity: (
                  _hostname: string,
                  cert: tls.PeerCertificate,
                ): Error | undefined => {
                  if (
                    cert.fingerprint256?.replace(/:/g, "").toUpperCase() !==
                    fingerprint
                  ) {
                    return Object.assign(
                      new Error("Proxmox TLS fingerprint mismatch"),
                      {
                        code: "ERR_TLS_CERT_FINGERPRINT_MISMATCH",
                      },
                    );
                  }
                  return undefined;
                },
              }
            : {}),
          timeout: options.timeoutMs ?? this.config.requestTimeoutMs,
          headers: {
            // Proxmox API-token authentication; the secret only ever appears
            // in this header and never in errors or logs.
            Authorization: `PVEAPIToken=${target.tokenId}=${target.tokenSecret}`,
            Accept: "application/json",
            ...(body !== undefined
              ? {
                  "Content-Type": "application/x-www-form-urlencoded",
                  "Content-Length": Buffer.byteLength(body),
                }
              : {}),
          },
        },
        (res) => {
          const { statusCode } = res;

          if (statusCode && REDIRECT_STATUSES.has(statusCode)) {
            res.resume();
            req.destroy();
            reject(
              new ProxmoxRemoteError(
                "proxmox_redirect",
                `Proxmox returned a redirect for ${options.method} ${options.path}; redirects are not followed`,
              ),
            );
            return;
          }

          const chunks: Buffer[] = [];
          let received = 0;
          let tooLarge = false;

          res.on("data", (chunk: Buffer) => {
            received += chunk.length;
            if (received > maxResponseBytes) {
              tooLarge = true;
              res.destroy();
              return;
            }
            chunks.push(chunk);
          });

          res.on("error", (err) => {
            reject(
              ProxmoxRemoteError.fromTransportError(
                err,
                options.method,
                options.path,
              ),
            );
          });
          res.on("close", () => {
            if (tooLarge) {
              reject(
                new ProxmoxRemoteError(
                  "proxmox_response",
                  `Proxmox response exceeded ${maxResponseBytes} bytes for ${options.method} ${options.path}`,
                ),
              );
              return;
            }

            if (statusCode === undefined) {
              reject(
                new ProxmoxRemoteError(
                  "proxmox_response",
                  `Proxmox returned no status for ${options.method} ${options.path}`,
                ),
              );
              return;
            }

            let body: unknown;
            const rawBodyText = Buffer.concat(chunks).toString("utf8");
            try {
              body = JSON.parse(rawBodyText);
            } catch {
              reject(
                new ProxmoxRemoteError(
                  "proxmox_response",
                  `Proxmox returned a non-JSON body for ${options.method} ${options.path}`,
                ),
              );
              return;
            }

            if (statusCode === 401 || statusCode === 403) {
              reject(
                new ProxmoxRemoteError(
                  "proxmox_denied",
                  `Proxmox returned ${statusCode} for ${options.method} ${options.path}; the token was not accepted`,
                  502,
                ),
              );
              return;
            }

            if (statusCode < 200 || statusCode >= 300) {
              const cause = /checksum mismatch/i.test(rawBodyText)
                ? ": checksum mismatch"
                : "";
              const errorFields =
                statusCode === 400 ? proxmoxErrorFieldNames(body) : [];
              const fieldSuffix =
                errorFields.length > 0
                  ? ` (fields: ${errorFields.join(", ")})`
                  : "";
              reject(
                new ProxmoxRemoteError(
                  "proxmox_api",
                  `Proxmox returned ${statusCode} for ${options.method} ${options.path}${cause}${fieldSuffix}`,
                  502,
                  { httpStatus: statusCode },
                ),
              );
              return;
            }

            resolve((body as { data?: unknown })?.data ?? body);
          });
        },
      );

      req.on("timeout", () => {
        req.destroy();
        reject(
          new ProxmoxRemoteError(
            "proxmox_timeout",
            `Proxmox request timed out after ${options.timeoutMs ?? this.config.requestTimeoutMs}ms for ${options.method} ${options.path}`,
            504,
          ),
        );
      });

      req.on("error", (err) => {
        reject(
          ProxmoxRemoteError.fromTransportError(
            err,
            options.method,
            options.path,
          ),
        );
      });

      if (body !== undefined) {
        req.write(body);
      }
      req.end();
    });
  }
}
