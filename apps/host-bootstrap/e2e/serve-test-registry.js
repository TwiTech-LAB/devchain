"use strict";
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const directory = path.resolve(process.argv[2]);
const port = Number(process.argv[3] || 4873);
const catalog = JSON.parse(
  fs.readFileSync(path.join(directory, "catalog.json")),
);
const files = new Set(
  Object.values(catalog.versions).map((entry) => entry.dist.filename),
);
const server = http.createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url, "http://registry");
    if (req.method !== "GET") {
      res.writeHead(405);
      res.end();
      return;
    }
    if (url.pathname === "/devchain-cli") {
      const metadata = structuredClone(catalog);
      for (const entry of Object.values(metadata.versions))
        entry.dist.tarball =
          "http://" +
          req.headers.host +
          "/devchain-cli/-/" +
          entry.dist.filename;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(metadata));
      return;
    }
    const filename = url.pathname.split("/").at(-1);
    if (url.pathname.startsWith("/devchain-cli/-/") && files.has(filename)) {
      await pipeline(fs.createReadStream(path.join(directory, filename)), res);
      return;
    }
    // Native/package dependencies stay the pinned public inputs from shrinkwrap.
    const upstream = await fetch(
      "https://registry.npmjs.org" + url.pathname + url.search,
    );
    res.writeHead(upstream.status, {
      "content-type":
        upstream.headers.get("content-type") || "application/octet-stream",
    });
    if (upstream.body) await pipeline(Readable.fromWeb(upstream.body), res);
    else res.end();
  })().catch(() => {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
});
server.listen(port, "127.0.0.1", () =>
  process.stdout.write(
    "Scratch registry listening on 127.0.0.1:" + port + "\n",
  ),
);
process.on("SIGTERM", () => server.close());
