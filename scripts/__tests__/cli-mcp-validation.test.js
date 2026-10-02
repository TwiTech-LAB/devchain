const { __test__ } = require("../cli");

describe("validateMcpForProviders", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  const BASE = "http://127.0.0.1:41818";

  function makeCli() {
    return {
      spinner: jest.fn(() => ({ start: jest.fn(), stop: jest.fn() })),
      success: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      info: jest.fn(),
      blank: jest.fn(),
    };
  }

  function routeFetch(routes) {
    return jest.spyOn(global, "fetch").mockImplementation(async (url) => {
      const u = String(url);
      for (const [fragment, response] of routes) {
        if (u.includes(fragment)) {
          return typeof response === "function" ? response(u) : response;
        }
      }
      throw new Error(`unexpected fetch: ${u}`);
    });
  }

  it("makes no mcp/ensure calls and logs one info line when the startup folder is not a registered project", async () => {
    const fetchMock = routeFetch([
      ["/api/projects/by-path", { ok: false, status: 404 }],
    ]);
    const cli = makeCli();
    const log = jest.fn();

    await __test__.validateMcpForProviders(BASE, cli, { foreground: true }, log, "/home/user");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("/mcp/ensure"))).toHaveLength(0);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toBe("info");
    expect(log.mock.calls[0][1]).toMatch(/registered when a session launches/);
    expect(log.mock.calls[0][2]).toMatchObject({ startupPath: "/home/user" });
  });

  it("sends one mcp/ensure per provider with the stored rootPath when the folder is a registered project", async () => {
    const fetchMock = routeFetch([
      ["/api/projects/by-path", {
        ok: true,
        status: 200,
        json: async () => ({ id: "p1", name: "Proj", rootPath: "/registered/root" }),
      }],
      ["/mcp/ensure", {
        ok: true,
        status: 200,
        json: async () => ({ action: "already_configured", endpoint: `${BASE}/mcp` }),
      }],
      ["/api/providers", {
        ok: true,
        status: 200,
        json: async () => ({ items: [{ id: "prov-1", name: "claude" }] }),
      }],
    ]);
    const cli = makeCli();
    const log = jest.fn();

    await __test__.validateMcpForProviders(BASE, cli, { foreground: true }, log, "/registered/root/");

    const ensureCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes("/mcp/ensure"));
    expect(ensureCalls).toHaveLength(1);
    expect(ensureCalls[0][1].body).toBe(JSON.stringify({ projectPath: "/registered/root" }));
  });

  it("keeps the legacy behavior of trying the ensure calls with the raw path when the by-path lookup fails", async () => {
    const fetchMock = routeFetch([
      ["/api/projects/by-path", () => Promise.reject(new Error("ECONNREFUSED"))],
      ["/mcp/ensure", {
        ok: true,
        status: 200,
        json: async () => ({ action: "already_configured", endpoint: `${BASE}/mcp` }),
      }],
      ["/api/providers", {
        ok: true,
        status: 200,
        json: async () => ({ items: [{ id: "prov-1", name: "claude" }] }),
      }],
    ]);
    const cli = makeCli();
    const log = jest.fn();

    await __test__.validateMcpForProviders(BASE, cli, { foreground: true }, log, "/raw/folder");

    const ensureCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes("/mcp/ensure"));
    expect(ensureCalls).toHaveLength(1);
    expect(ensureCalls[0][1].body).toBe(JSON.stringify({ projectPath: "/raw/folder" }));
  });
});
