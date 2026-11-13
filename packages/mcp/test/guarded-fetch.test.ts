import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FetchRefused, guardedFetch, isBlockedAddress } from "../src/guarded-fetch.ts";

describe("isBlockedAddress", () => {
  it("blocks internal, reserved, and unparsable addresses", () => {
    for (const a of [
      "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255",
      "::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:7f00:1", "64:ff9b::a00:1", "2001:db8::1", "not-an-ip",
    ]) {
      expect(isBlockedAddress(a), a).toBe(true);
    }
  });

  it("allows ordinary public addresses", () => {
    for (const a of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.32.0.1", "100.63.255.255", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) {
      expect(isBlockedAddress(a), a).toBe(false);
    }
  });
});

describe("guardedFetch", () => {
  let server: http.Server;
  let base: string;
  const requests: string[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      requests.push(req.url ?? "");
      switch (req.url) {
        case "/text":
          res.setHeader("content-type", "text/plain; charset=utf-8");
          res.end("hello from the page");
          break;
        case "/json":
          res.setHeader("content-type", "application/json");
          res.end('{"ok":true}');
          break;
        case "/binary":
          res.setHeader("content-type", "image/png");
          res.end(Buffer.from([1, 2, 3, 4]));
          break;
        case "/big":
          res.setHeader("content-type", "text/plain");
          res.end("x".repeat(5000));
          break;
        case "/redirect":
          res.statusCode = 302;
          res.setHeader("location", "/text");
          res.end();
          break;
        case "/to-blocked":
          res.statusCode = 302;
          res.setHeader("location", "http://blocked.example/secret");
          res.end();
          break;
        case "/loop":
          res.statusCode = 302;
          res.setHeader("location", "/loop");
          res.end();
          break;
        case "/slow":
          setTimeout(() => res.end("late"), 2000);
          break;
        default:
          res.statusCode = 404;
          res.end("nope");
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server.closeAllConnections();
    server.close();
  });

  const open = { allowPrivate: true };

  it("returns text pages and follows ordinary redirects", async () => {
    const page = await guardedFetch(`${base}/redirect`, open);
    expect(page).toMatchObject({ status: 200, text: "hello from the page", truncated: false });
    expect(page.url).toBe(`${base}/text`);
    expect((await guardedFetch(`${base}/json`, open)).text).toBe('{"ok":true}');
  });

  it("does not return binary content", async () => {
    const page = await guardedFetch(`${base}/binary`, open);
    expect(page.text).toBe("");
    expect(page.note).toContain("image/png");
  });

  it("truncates large responses", async () => {
    const page = await guardedFetch(`${base}/big`, { ...open, maxBytes: 1000 });
    expect(page.text.length).toBe(1000);
    expect(page.truncated).toBe(true);
  });

  it("applies the rules before the first request", async () => {
    requests.length = 0;
    await expect(guardedFetch(`${base}/text`, { ...open, check: () => ({ allowed: false, reason: "not allowed" }) })).rejects.toThrow("not allowed");
    expect(requests).toEqual([]);
  });

  it("applies the rules to a redirect target before requesting it", async () => {
    // blocked.example does not exist: if the redirect were followed, this would fail on DNS instead.
    const check = (url: URL) => (url.hostname === "blocked.example" ? { allowed: false as const, reason: "blocked.example is blocked" } : { allowed: true as const });
    await expect(guardedFetch(`${base}/to-blocked`, { ...open, check })).rejects.toThrow("blocked.example is blocked");
  });

  it("stops redirect loops", async () => {
    await expect(guardedFetch(`${base}/loop`, { ...open, maxRedirects: 3 })).rejects.toThrow(/Too many redirects/);
  });

  it("times out slow servers", async () => {
    await expect(guardedFetch(`${base}/slow`, { ...open, timeoutMs: 300 })).rejects.toThrow(/timed out/);
  });

  it("refuses non-http links", async () => {
    await expect(guardedFetch("file:///etc/passwd", open)).rejects.toBeInstanceOf(FetchRefused);
  });

  it("refuses loopback and private addresses by default, as literals and as names", async () => {
    requests.length = 0;
    await expect(guardedFetch(`${base}/text`)).rejects.toThrow(/internal address/);
    await expect(guardedFetch(base.replace("127.0.0.1", "localhost") + "/text")).rejects.toThrow(/internal address/);
    await expect(guardedFetch("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(/internal address/);
    await expect(guardedFetch("http://[::1]/")).rejects.toThrow(/internal address/);
    await expect(guardedFetch("http://10.0.0.5/")).rejects.toThrow(/internal address/);
    // Nothing reached the local server.
    expect(requests).toEqual([]);
  });
});
