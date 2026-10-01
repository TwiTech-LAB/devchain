import * as https from "node:https";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { ProxmoxClient } from "./proxmox-client";
import { ProxmoxRemoteError } from "./proxmox-errors";

const TOKEN_ID = "root@pam!compute";
const TOKEN_SECRET = "secret-token-value-123";

let server: https.Server | null = null;
let serverPort = 0;
let tmpDir = "";
let caPem = "";
let keyPem = "";
let certPem = "";

const seenAuthHeaders: string[] = [];
const pendingTimers: NodeJS.Timeout[] = [];

function startServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<void> {
  server = https.createServer({ key: keyPem, cert: certPem }, (req, res) => {
    if (req.headers.authorization) {
      seenAuthHeaders.push(req.headers.authorization);
    }
    handler(req, res);
  });
  return new Promise((resolve) => {
    server!.listen(0, "127.0.0.1", () => {
      const address = server!.address() as { port: number };
      serverPort = address.port;
      resolve();
    });
  });
}

function stopServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
  });
}

function client(timeoutMs = 5000) {
  return new ProxmoxClient({
    requestTimeoutMs: timeoutMs,
    maxResponseBytes: 64 * 1024,
  });
}

function target() {
  return {
    origin: `https://127.0.0.1:${serverPort}`,
    tokenId: TOKEN_ID,
    tokenSecret: TOKEN_SECRET,
    caPem,
    tlsServerName: "localhost",
  };
}

beforeAll(() => {
  // Controlled test PKI: a self-signed CA plus a server certificate with
  // SAN localhost/127.0.0.1, mirroring a private Proxmox endpoint.
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "proxmox-test-"));

  execFileSync(
    "openssl",
    "req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.crt -days 2 -subj /CN=proxmox-test-ca".split(
      " ",
    ),
    { cwd: tmpDir },
  );
  execFileSync(
    "openssl",
    "req -newkey rsa:2048 -nodes -keyout server.key -out server.csr -subj /CN=localhost".split(
      " ",
    ),
    { cwd: tmpDir },
  );
  fs.writeFileSync(
    path.join(tmpDir, "san.ext"),
    "subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n",
  );
  execFileSync(
    "openssl",
    "x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out server.crt -days 2 -extfile san.ext".split(
      " ",
    ),
    { cwd: tmpDir },
  );

  caPem = fs.readFileSync(path.join(tmpDir, "ca.crt"), "utf8");
  keyPem = fs.readFileSync(path.join(tmpDir, "server.key"), "utf8");
  certPem = fs.readFileSync(path.join(tmpDir, "server.crt"), "utf8");
});

afterAll(async () => {
  await stopServer();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("ProxmoxClient over a controlled HTTPS endpoint", () => {
  afterEach(async () => {
    for (const timer of pendingTimers.splice(0)) {
      clearTimeout(timer);
    }
    await stopServer();
    seenAuthHeaders.length = 0;
  });

  it("verifies TLS with the per-instance CA and pinned server name", async () => {
    await startServer((_req, res) => {
      res.end(JSON.stringify({ data: { version: "8.4.14" } }));
    });

    const version = await client().getVersion(target());
    expect(version).toEqual({ version: "8.4.14" });
    expect(seenAuthHeaders[0]).toBe(`PVEAPIToken=${TOKEN_ID}=${TOKEN_SECRET}`);
  });

  it("accepts the pinned leaf and rejects a mismatched fingerprint", async () => {
    await startServer((_req, res) =>
      res.end(JSON.stringify({ data: { version: "8" } })),
    );
    const pinned = new X509Certificate(certPem).fingerprint256;
    await expect(
      client().getVersion({ ...target(), tlsFingerprint: pinned }),
    ).resolves.toEqual({ version: "8" });
    await expect(
      client().getVersion({ ...target(), tlsFingerprint: "00".repeat(32) }),
    ).rejects.toMatchObject({ code: "proxmox_tls" });
    await expect(
      client().getVersion({
        ...target(),
        caPem: undefined,
        tlsFingerprint: pinned,
      }),
    ).rejects.toMatchObject({ code: "proxmox_tls" });
    expect(seenAuthHeaders).toHaveLength(1);
  });

  it("lists import storage content using the content query", async () => {
    await startServer((req, res) => {
      expect(req.method).toBe("GET");
      expect(req.url).toBe(
        "/api2/json/nodes/hw/storage/local/content?content=import",
      );
      res.end(
        JSON.stringify({ data: [{ volid: "local:import/image.qcow2" }] }),
      );
    });
    await expect(
      client().listStorageContent(target(), "hw", "local", "import"),
    ).resolves.toEqual([{ volid: "local:import/image.qcow2" }]);
  });

  it("downloads an image with checksum parameters", async () => {
    await startServer((req, res) => {
      expect(req.method).toBe("POST");
      expect(req.url).toBe("/api2/json/nodes/hw/storage/local/download-url");
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString()));
      req.on("end", () => {
        expect(Object.fromEntries(new URLSearchParams(body))).toEqual({
          content: "import",
          filename: "image.qcow2",
          url: "https://image.test/image.qcow2",
          checksum: "abc",
          "checksum-algorithm": "sha256",
        });
        res.end(JSON.stringify({ data: "UPID:download" }));
      });
    });
    await expect(
      client().downloadUrl(target(), "hw", "local", {
        content: "import",
        filename: "image.qcow2",
        url: "https://image.test/image.qcow2",
        checksum: "abc",
        checksumAlgorithm: "sha256",
      }),
    ).resolves.toBe("UPID:download");
  });

  it("creates an import-from VM with cloud-init and guest-agent config", async () => {
    await startServer((req, res) => {
      expect(req.method).toBe("POST");
      expect(req.url).toBe("/api2/json/nodes/hw/qemu");
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString()));
      req.on("end", () => {
        expect(Object.fromEntries(new URLSearchParams(body))).toEqual({
          vmid: "101",
          pool: "devchain",
          tags: "devchain",
          name: "dc-image",
          ostype: "l26",
          cpu: "host",
          scsihw: "virtio-scsi-single",
          scsi0: "local-lvm:0,import-from=local:import/image.qcow2",
          ide2: "local-lvm:cloudinit",
          boot: "order=scsi0",
          serial0: "socket",
          vga: "serial0",
          agent: "enabled=1",
          ipconfig0: "ip=dhcp",
          net0: "virtio,bridge=vmbr0",
          cores: "2",
          memory: "4096",
        });
        res.end(JSON.stringify({ data: "UPID:create" }));
      });
    });
    await expect(
      client().createVm(target(), "hw", {
        vmid: 101,
        pool: "devchain",
        tags: "devchain",
        name: "dc-image",
        scsi0ImportFrom: "local-lvm:0,import-from=local:import/image.qcow2",
        cloudInitDrive: "local-lvm:cloudinit",
        agent: "enabled=1",
        ipconfig0: "ip=dhcp",
        net0: "virtio,bridge=vmbr0",
        cores: 2,
        memory: 4096,
      }),
    ).resolves.toBe("UPID:create");
  });

  it("converts a VM to a template", async () => {
    await startServer((req, res) => {
      expect([req.method, req.url]).toEqual([
        "POST",
        "/api2/json/nodes/hw/qemu/101/template",
      ]);
      res.end(JSON.stringify({ data: "UPID:template" }));
    });
    await expect(client().convertToTemplate(target(), "hw", 101)).resolves.toBe(
      "UPID:template",
    );
  });

  it("clones to a pool and storage with full-copy options", async () => {
    await startServer((req, res) => {
      expect([req.method, req.url]).toEqual([
        "POST",
        "/api2/json/nodes/hw/qemu/101/clone",
      ]);
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString()));
      req.on("end", () => {
        expect(Object.fromEntries(new URLSearchParams(body))).toEqual({
          newid: "102",
          name: "dc-vm",
          full: "1",
          pool: "devchain",
          storage: "local-lvm",
        });
        res.end(JSON.stringify({ data: "UPID:clone" }));
      });
    });
    await expect(
      client().cloneVm(target(), "hw", 101, {
        newid: 102,
        full: true,
        pool: "devchain",
        storage: "local-lvm",
        name: "dc-vm",
      }),
    ).resolves.toBe("UPID:clone");
  });

  it("sets cores and memory synchronously", async () => {
    await startServer((req, res) => {
      expect([req.method, req.url]).toEqual([
        "PUT",
        "/api2/json/nodes/hw/qemu/102/config",
      ]);
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString()));
      req.on("end", () => {
        expect(Object.fromEntries(new URLSearchParams(body))).toEqual({
          cores: "4",
          memory: "4096",
        });
        res.end(JSON.stringify({ data: null }));
      });
    });
    await expect(
      client().setConfig(target(), "hw", 102, 4, 4096),
    ).resolves.toBeNull();
  });

  it("resizes a disk using the absolute Proxmox size string", async () => {
    await startServer((req, res) => {
      expect([req.method, req.url]).toEqual([
        "PUT",
        "/api2/json/nodes/hw/qemu/102/resize",
      ]);
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString()));
      req.on("end", () => {
        expect(Object.fromEntries(new URLSearchParams(body))).toEqual({
          disk: "scsi0",
          size: "30G",
        });
        res.end(JSON.stringify({ data: "UPID:resize" }));
      });
    });
    await expect(
      client().resizeDisk(target(), "hw", 102, "scsi0", "30G"),
    ).resolves.toBe("UPID:resize");
  });

  it("starts and stops a VM through the lifecycle endpoints", async () => {
    await startServer((req, res) => {
      expect(req.method).toBe("POST");
      expect(req.url).toMatch(
        /^\/api2\/json\/nodes\/hw\/qemu\/102\/status\/(start|stop)$/,
      );
      res.end(JSON.stringify({ data: `UPID:${req.url?.split("/").pop()}` }));
    });
    await expect(client().startVm(target(), "hw", 102)).resolves.toBe(
      "UPID:start",
    );
    await expect(client().stopVm(target(), "hw", 102)).resolves.toBe(
      "UPID:stop",
    );
  });

  it("returns the first non-loopback IPv4 reported by the guest agent", async () => {
    await startServer((req, res) => {
      expect([req.method, req.url]).toEqual([
        "GET",
        "/api2/json/nodes/hw/qemu/102/agent/network-get-interfaces",
      ]);
      res.end(
        JSON.stringify({
          data: {
            result: [
              {
                name: "lo",
                "ip-addresses": [
                  { "ip-address-type": "ipv4", "ip-address": "127.0.0.1" },
                ],
              },
              {
                name: "eth0",
                "ip-addresses": [
                  { "ip-address-type": "ipv6", "ip-address": "::1" },
                  { "ip-address-type": "ipv4", "ip-address": "10.0.0.7" },
                ],
              },
            ],
          },
        }),
      );
    });
    await expect(
      client().getAgentNetworkInterfaces(target(), "hw", 102),
    ).resolves.toBe("10.0.0.7");
  });

  it("reads a guest file through the agent with an encoded path", async () => {
    await startServer((req, res) => {
      expect([req.method, req.url]).toEqual([
        "GET",
        "/api2/json/nodes/hw/qemu/102/agent/file-read?file=%2Fetc%2Fdevchain-host%2Ftls%2Fcert.pem",
      ]);
      res.end(JSON.stringify({ data: { content: "PEM\n", "bytes-read": 4 } }));
    });
    await expect(
      client().readAgentFile(
        target(),
        "hw",
        102,
        "/etc/devchain-host/tls/cert.pem",
        1024,
      ),
    ).resolves.toBe("PEM\n");
  });

  it("refuses a guest file above the size bound or truncated by Proxmox", async () => {
    let answer: unknown = { content: "x".repeat(33), "bytes-read": 33 };
    await startServer((_req, res) => {
      res.end(JSON.stringify({ data: answer }));
    });
    const read = () => client().readAgentFile(target(), "hw", 102, "/f", 32);
    await expect(read()).rejects.toMatchObject({ code: "proxmox_response" });
    answer = { content: "x", truncated: 1 };
    await expect(read()).rejects.toMatchObject({ code: "proxmox_response" });
    answer = { "bytes-read": 0 };
    await expect(read()).rejects.toMatchObject({ code: "proxmox_response" });
    answer = { blob: "y".repeat(8 * 1024) };
    await expect(read()).rejects.toThrow(/exceeded 1216 bytes/);
  });

  it("sends no token for a guest file read when the Proxmox pin does not match", async () => {
    await startServer((_req, res) => {
      res.end(JSON.stringify({ data: { content: "PEM" } }));
    });
    seenAuthHeaders.length = 0;
    await expect(
      client().readAgentFile(
        { ...target(), tlsFingerprint: "00".repeat(32) },
        "hw",
        102,
        "/f",
        1024,
      ),
    ).rejects.toBeInstanceOf(ProxmoxRemoteError);
    expect(seenAuthHeaders).toEqual([]);
  });

  it("deletes a VM with purge and disk cleanup query flags", async () => {
    await startServer((req, res) => {
      expect([req.method, req.url]).toEqual([
        "DELETE",
        "/api2/json/nodes/hw/qemu/102?purge=1&destroy-unreferenced-disks=1",
      ]);
      res.end(JSON.stringify({ data: "UPID:delete" }));
    });
    await expect(
      client().deleteVm(target(), "hw", 102, {
        purge: true,
        destroyUnreferencedDisks: true,
      }),
    ).resolves.toBe("UPID:delete");
  });

  it("waits for a task to report OK", async () => {
    await startServer((req, res) => {
      expect([req.method, req.url]).toEqual([
        "GET",
        "/api2/json/nodes/hw/tasks/UPID%3Aok/status",
      ]);
      res.end(
        JSON.stringify({ data: { status: "stopped", exitstatus: "OK" } }),
      );
    });
    await expect(
      client().waitForTask(target(), "hw", "UPID:ok", 100),
    ).resolves.toBeUndefined();
  });

  it("rejects failed and timed-out tasks without exposing remote text", async () => {
    await startServer((req, res) => {
      expect(req.url).toMatch(/\/tasks\/UPID%3A(fail|running)\/status$/);
      res.end(
        JSON.stringify({
          data: req.url?.includes("fail")
            ? { status: "stopped", exitstatus: TOKEN_SECRET }
            : { status: "running" },
        }),
      );
    });
    const failed = await client()
      .waitForTask(target(), "hw", "UPID:fail", 100)
      .catch((error: unknown) => error);
    expect(failed).toMatchObject({ code: "proxmox_task" });
    expect((failed as Error).message).not.toContain(TOKEN_SECRET);
    await expect(
      client().waitForTask(target(), "hw", "UPID:running", 20),
    ).rejects.toMatchObject({ code: "proxmox_timeout" });
  });

  it("queries own permissions with the exact encoded /vms/{vmid} ACL path", async () => {
    const seenUrls: string[] = [];
    await startServer((req, res) => {
      seenUrls.push(req.url ?? "");
      res.end(
        JSON.stringify({
          data: { "/vms/101": { "VM.Audit": 0, "VM.Console": 1 } },
        }),
      );
    });

    const permissions = await client().getOwnVmAclPermissions(target(), 101);

    // The URL must carry the exact, URL-encoded VM ACL path — never an
    // unfiltered dump the caller would have to interpret.
    expect(seenUrls).toEqual([
      "/api2/json/access/permissions?path=%2Fvms%2F101",
    ]);
    expect(permissions).toEqual({
      "/vms/101": { "VM.Audit": 0, "VM.Console": 1 },
    });

    await expect(
      client().getOwnVmAclPermissions(target(), Number.NaN),
    ).rejects.toThrow(/Invalid VMID/);
    expect(seenUrls).toHaveLength(1);
  });

  it("maps the real checksum-mismatch rejection to the reconfirmable conflict for config and resize", async () => {
    // A real PVE rejects a stale conditional write with 400 and
    // errors.digest = "checksum mismatch" — the exact text, nothing invented.
    await startServer((req, res) => {
      res.statusCode = 400;
      res.end(
        JSON.stringify({ data: null, errors: { digest: "checksum mismatch" } }),
      );
    });

    const configError = await client()
      .updateVmConfig(
        target(),
        "hw",
        101,
        { cores: "4" },
        "0123456789abcdef0123456789abcdef01234567",
      )
      .catch((error: unknown) => error);
    expect(configError).toBeInstanceOf(ProxmoxRemoteError);
    expect((configError as ProxmoxRemoteError).code).toBe(
      "proxmox_digest_conflict",
    );

    const resizeError = await client()
      .resizeVmDisk(
        target(),
        "hw",
        101,
        "scsi0",
        21 * 1024 ** 3,
        "0123456789abcdef0123456789abcdef01234567",
      )
      .catch((error: unknown) => error);
    expect(resizeError).toBeInstanceOf(ProxmoxRemoteError);
    expect((resizeError as ProxmoxRemoteError).code).toBe(
      "proxmox_digest_conflict",
    );
  });

  it("keeps unrelated API failures classified as proxmox_api", async () => {
    await startServer((req, res) => {
      res.statusCode = 400;
      // A validation error unrelated to digests — even one mentioning the
      // word digest in another context must not classify as a conflict
      // unless it is the actual checksum mismatch.
      res.end(
        JSON.stringify({
          data: null,
          errors: { size: "invalid", note: "digest field absent" },
        }),
      );
    });

    const error = await client()
      .updateVmConfig(
        target(),
        "hw",
        101,
        { cores: "4" },
        "0123456789abcdef0123456789abcdef01234567",
      )
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ProxmoxRemoteError);
    expect((error as ProxmoxRemoteError).code).toBe("proxmox_api");
  });

  it("includes at most five safe 400 field names without echoing their values", async () => {
    await startServer((_req, res) => {
      res.statusCode = 400;
      res.end(
        JSON.stringify({
          data: null,
          errors: {
            name: "secret-vm-name",
            cores: "must be positive",
            memory: "invalid size",
            disk: "private disk value",
            pool: "private pool value",
            node: "sixth field",
            "private field": "must not be included",
          },
        }),
      );
    });

    const error = await client()
      .getVersion(target())
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ProxmoxRemoteError);
    const message = (error as Error).message;
    expect(message).toContain("fields: name, cores, memory, disk, pool");
    expect(message).not.toContain("node");
    expect(message).not.toContain("private field");
    expect(message).not.toContain("secret-vm-name");
    expect(message).not.toContain("must be positive");
    expect(message).not.toContain("private disk value");
  });

  it("preserves checksum-mismatch text while including the safe field name", async () => {
    await startServer((_req, res) => {
      res.statusCode = 400;
      res.end(
        JSON.stringify({ data: null, errors: { digest: "checksum mismatch" } }),
      );
    });

    const error = await client()
      .getVersion(target())
      .catch((thrown: unknown) => thrown);
    expect((error as Error).message).toContain(
      ": checksum mismatch (fields: digest)",
    );
  });

  it("rejects an endpoint whose certificate is not signed by the instance CA", async () => {
    await startServer((_req, res) => {
      res.end(JSON.stringify({ data: {} }));
    });

    const unknownCaTarget = { ...target(), caPem: undefined };
    await expect(client().getVersion(unknownCaTarget)).rejects.toMatchObject({
      code: "proxmox_tls",
    });
  });

  it("accepts an address outside the certificate's names when the fingerprint is pinned", async () => {
    await startServer((_req, res) => {
      res.end(JSON.stringify({ data: { version: "8" } }));
    });

    // The test certificate names only localhost/127.0.0.1; a Proxmox node
    // certificate likewise omits the LAN address an operator connects with.
    const pinned = new X509Certificate(certPem).fingerprint256;
    const unlistedName = {
      ...target(),
      tlsServerName: "elsewhere.example.com",
    };
    await expect(
      client().getVersion({ ...unlistedName, tlsFingerprint: pinned }),
    ).resolves.toEqual({ version: "8" });
    await expect(
      client().getVersion({
        ...unlistedName,
        tlsFingerprint: "00".repeat(32),
      }),
    ).rejects.toMatchObject({ code: "proxmox_tls" });
    expect(seenAuthHeaders).toHaveLength(1);
  });

  it("rejects a server-name mismatch even with the right CA", async () => {
    await startServer((_req, res) => {
      res.end(JSON.stringify({ data: {} }));
    });

    const wrongName = { ...target(), tlsServerName: "elsewhere.example.com" };
    await expect(client().getVersion(wrongName)).rejects.toMatchObject({
      code: "proxmox_tls",
    });
  });

  it("maps upstream 401 to a safe denial without leaking the token", async () => {
    await startServer((_req, res) => {
      res.statusCode = 401;
      res.end(JSON.stringify({ errors: { token: "invalid" } }));
    });

    try {
      await client().getVersion(target());
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(ProxmoxRemoteError);
      expect((error as ProxmoxRemoteError).code).toBe("proxmox_denied");
      const serialized = JSON.stringify({
        message: (error as Error).message,
        details: (error as ProxmoxRemoteError).details,
      });
      expect(serialized).not.toContain(TOKEN_SECRET);
    }
  });

  it("does not echo a token reflected in an upstream error body", async () => {
    await startServer((_req, res) => {
      res.statusCode = 500;
      res.end(
        JSON.stringify({
          errors: { authorization: `PVEAPIToken ${TOKEN_ID}=${TOKEN_SECRET}` },
        }),
      );
    });

    const error = await client()
      .getVersion(target())
      .catch((thrown: unknown) => thrown);
    expect(error).toMatchObject({ code: "proxmox_api" });
    expect((error as Error).message).not.toContain(TOKEN_SECRET);
    expect((error as Error).message).not.toContain("PVEAPIToken");
  });

  it("does not follow redirects", async () => {
    await startServer((_req, res) => {
      res.statusCode = 302;
      res.setHeader("location", "/api2/json/elsewhere");
      res.end();
    });

    await expect(client().getVersion(target())).rejects.toMatchObject({
      code: "proxmox_redirect",
    });
  });

  it("bounds request time with a timeout", async () => {
    await startServer((_req, res) => {
      // Never responds within the test's lifetime.
      pendingTimers.push(setTimeout(() => res.end(), 60_000));
    });

    await expect(client(150).getVersion(target())).rejects.toMatchObject({
      code: "proxmox_timeout",
    });
  });

  it("maps connection failures of an unreachable private endpoint", async () => {
    // Port with no listener on loopback.
    const unreachable = {
      ...target(),
      origin: "https://127.0.0.1:9",
    };
    await expect(client(2000).getVersion(unreachable)).rejects.toMatchObject({
      code: "proxmox_transport",
    });
  });

  it("rejects non-JSON bodies safely", async () => {
    await startServer((_req, res) => {
      res.end("<html>maintenance</html>");
    });

    await expect(client().getVersion(target())).rejects.toMatchObject({
      code: "proxmox_response",
    });
  });

  it("bounds response bodies", async () => {
    await startServer((_req, res) => {
      res.end(JSON.stringify({ data: { blob: "x".repeat(256 * 1024) } }));
    });

    const bounded = new ProxmoxClient({
      requestTimeoutMs: 5000,
      maxResponseBytes: 1024,
    });
    await expect(bounded.getVersion(target())).rejects.toMatchObject({
      code: "proxmox_response",
    });
  });

  it("rejects malformed targets before any network I/O", async () => {
    await expect(
      client().getVersion({ ...target(), origin: "http://127.0.0.1:8006" }),
    ).rejects.toMatchObject({ code: "proxmox_transport" });
    await expect(
      client().getVersion({
        ...target(),
        origin: "https://user:pass@127.0.0.1",
      }),
    ).rejects.toMatchObject({ code: "proxmox_transport" });
    await expect(
      client().getVersion({ ...target(), origin: "https://127.0.0.1/?x=1" }),
    ).rejects.toMatchObject({ code: "proxmox_transport" });
    await expect(
      client().getVersion({ ...target(), origin: "https://127.0.0.1/#frag" }),
    ).rejects.toMatchObject({ code: "proxmox_transport" });
  });
});
