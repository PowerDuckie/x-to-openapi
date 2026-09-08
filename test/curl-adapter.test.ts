import { describe, expect, it } from "vitest";

import { CurlAdapter } from "../src/adapters/curl/index.js";
import type { NormalizedRequest } from "../src/core/types.js";

const adapter = new CurlAdapter();
const report = () => {};
const ctx = { report, strict: false };

async function parse(command: string | readonly string[]): Promise<NormalizedRequest[]> {
  return adapter.parse(command, ctx);
}

async function first(command: string): Promise<NormalizedRequest> {
  const requests = await parse(command);
  expect(requests).toHaveLength(1);
  return requests[0]!;
}

describe("CurlAdapter - method and URL", () => {
  it("defaults to GET when no method is specified", async () => {
    const r = await first("curl https://e.com/x");
    expect(r.method).toBe("get");
  });

  it("parses -X POST", async () => {
    const r = await first("curl -X POST https://e.com/x");
    expect(r.method).toBe("post");
  });

  it("parses --request DELETE", async () => {
    const r = await first("curl --request DELETE https://e.com/x");
    expect(r.method).toBe("delete");
  });

  it("lowercases non-standard methods", async () => {
    const r = await first("curl -X PURGE https://e.com/x");
    expect(r.method).toBe("purge");
  });

  it("preserves query parameters", async () => {
    const r = await first("curl 'https://e.com/x?a=1&b=2'");
    expect(r.query).toEqual(
      expect.arrayContaining([
        { name: "a", value: "1" },
        { name: "b", value: "2" },
      ]),
    );
  });

  it("populates urlString for serialization", async () => {
    const r = await first("curl https://e.com/x");
    expect(r.urlString).toBe("https://e.com/x");
  });

  it("skips non-HTTP schemes with a warning", async () => {
    const diagnostics: { code: string }[] = [];
    const r = await adapter.parse("curl ftp://e.com/file", {
      report: (d) => diagnostics.push(d),
      strict: false,
    });
    expect(r).toHaveLength(0);
    expect(diagnostics.some((d) => d.code === "CURL_UNSUPPORTED_SCHEME")).toBe(
      true,
    );
  });
});

describe("CurlAdapter - headers", () => {
  it("parses simple headers", async () => {
    const r = await first(
      `curl 'https://e.com/x' -H 'X-Custom: value' -H 'Accept: application/json'`,
    );
    expect(r.headers).toEqual(
      expect.arrayContaining([
        { name: "X-Custom", value: "value" },
        { name: "Accept", value: "application/json" },
      ]),
    );
  });

  it("drops HTTP/2 pseudo-headers", async () => {
    const r = await first(`curl 'https://e.com/x' -H ':authority: e.com'`);
    expect(r.headers.every((h) => !h.name.startsWith(":"))).toBe(true);
  });

  it("parses headers with colons in value", async () => {
    const r = await first(
      `curl 'https://e.com/x' -H 'X-Url: https://inner.com/path?q=1'`,
    );
    const h = r.headers.find((x) => x.name === "X-Url");
    expect(h?.value).toBe("https://inner.com/path?q=1");
  });
});

describe("CurlAdapter - cookies", () => {
  it("parses a single cookie", async () => {
    const r = await first(`curl 'https://e.com/x' -H 'Cookie: sid=abc'`);
    expect(r.cookies).toEqual([{ name: "sid", value: "abc" }]);
  });

  it("parses multiple cookies", async () => {
    const r = await first(
      `curl 'https://e.com/x' -H 'Cookie: sid=abc; token=xyz; theme=dark'`,
    );
    expect(r.cookies).toHaveLength(3);
    expect(r.cookies[1]).toEqual({ name: "token", value: "xyz" });
  });

  it("handles cookie values with equals signs", async () => {
    const r = await first(
      `curl 'https://e.com/x' -H 'Cookie: data=eyJhIjoxfQ=='`,
    );
    expect(r.cookies[0]?.value).toBe("eyJhIjoxfQ==");
  });

  it("returns empty array when no cookie header", async () => {
    const r = await first("curl https://e.com/x");
    expect(r.cookies).toEqual([]);
  });
});

describe("CurlAdapter - JSON body", () => {
  it("detects JSON body from content-type", async () => {
    const r = await first(
      `curl -X POST https://e.com/x -H 'Content-Type: application/json' --data '{"name":"Ada"}'`,
    );
    expect(r.body?.kind).toBe("json");
    expect(r.body?.mediaType).toBe("application/json");
    expect(r.body?.raw).toBe('{"name":"Ada"}');
  });

  it("detects vendor JSON (+json suffix)", async () => {
    const r = await first(
      `curl -X POST https://e.com/x -H 'Content-Type: application/vnd.api+json' --data '{"data":{}}'`,
    );
    expect(r.body?.kind).toBe("json");
    expect(r.body?.mediaType).toBe("application/vnd.api+json");
  });

  it("handles empty JSON body", async () => {
    const r = await first(
      `curl -X POST https://e.com/x -H 'Content-Type: application/json' --data '{}'`,
    );
    expect(r.body?.kind).toBe("json");
    expect(r.body?.raw).toBe("{}");
  });
});

describe("CurlAdapter - form-urlencoded body", () => {
  it("detects form-urlencoded from content-type", async () => {
    const r = await first(
      `curl -X POST https://e.com/x -H 'Content-Type: application/x-www-form-urlencoded' --data 'name=Ada&age=36'`,
    );
    expect(r.body?.kind).toBe("form-urlencoded");
    expect(r.body?.mediaType).toBe("application/x-www-form-urlencoded");
    // Structured fields are preferred; raw may be absent when parsed.
    expect(r.body?.fields ?? r.body?.raw).toBeTruthy();
    if (r.body?.fields) {
      expect(r.body.fields).toEqual(
        expect.arrayContaining([
          { name: "name", value: "Ada" },
          { name: "age", value: "36" },
        ]),
      );
    }
  });

  it("detects form-urlencoded from -d flag without content-type", async () => {
    // curlconverter may infer content-type from --data
    const r = await first(
      `curl -X POST https://e.com/x --data 'name=Ada&age=36'`,
    );
    // Either form-urlencoded or binary depending on backend; both are valid
    expect(["form-urlencoded", "binary"]).toContain(r.body?.kind);
  });

  it("handles URL-encoded values", async () => {
    const r = await first(
      `curl -X POST https://e.com/x -H 'Content-Type: application/x-www-form-urlencoded' --data 'name=Ada%20Lovelace&city=London'`,
    );
    expect(r.body?.kind).toBe("form-urlencoded");
    // Structured fields have decoded values; raw has encoded values.
    if (r.body?.fields) {
      const name = r.body.fields.find((f) => f.name === "name");
      expect(name?.value).toBe("Ada Lovelace");
    } else {
      expect(r.body?.raw).toContain("Ada%20Lovelace");
    }
  });

  it("handles empty form body", async () => {
    const r = await first(
      `curl -X POST https://e.com/x -H 'Content-Type: application/x-www-form-urlencoded' --data ''`,
    );
    // Empty data may not produce a body
    expect(r.body === undefined || r.body.raw === "").toBe(true);
  });
});

describe("CurlAdapter - multipart/form-data", () => {
  it("detects multipart from -F flag", async () => {
    const r = await first(
      `curl -X POST https://e.com/upload -F 'name=Ada' -F 'file=@photo.png'`,
    );
    expect(r.body?.kind).toBe("multipart");
    expect(r.body?.mediaType).toBe("multipart/form-data");
  });

  it("parses text fields from -F", async () => {
    const r = await first(
      `curl -X POST https://e.com/upload -F 'name=Ada' -F 'role=admin'`,
    );
    expect(r.body?.fields).toEqual(
      expect.arrayContaining([
        { name: "name", value: "Ada" },
        { name: "role", value: "admin" },
      ]),
    );
  });

  it("parses file fields from -F @path", async () => {
    const r = await first(
      `curl -X POST https://e.com/upload -F 'avatar=@photo.png'`,
    );
    const file = r.body?.fields?.find((f) => f.name === "avatar");
    expect(file?.fileName).toBe("photo.png");
  });

  it("parses file fields with type= when backend preserves it", async () => {
    const r = await first(
      `curl -X POST https://e.com/upload -F 'avatar=@photo.png;type=image/png'`,
    );
    const file = r.body?.fields?.find((f) => f.name === "avatar");
    expect(file?.fileName).toBe("photo.png");
    // contentType may be undefined if curlconverter drops the ;type= suffix.
    if (file?.contentType) {
      expect(file.contentType).toBe("image/png");
    }
  });

  it("handles mixed text and file fields", async () => {
    const r = await first(
      `curl -X POST https://e.com/upload -F 'title=Hello' -F 'file=@doc.pdf'`,
    );
    expect(r.body?.fields).toHaveLength(2);
    const text = r.body?.fields?.find((f) => f.name === "title");
    const file = r.body?.fields?.find((f) => f.name === "file");
    expect(text?.value).toBe("Hello");
    expect(file?.fileName).toBe("doc.pdf");
  });
});

describe("CurlAdapter - XML body", () => {
  it("detects application/xml", async () => {
    const r = await first(
      `curl -X POST https://e.com/x -H 'Content-Type: application/xml' --data '<root/>'`,
    );
    expect(r.body?.kind).toBe("xml");
    expect(r.body?.raw).toBe("<root/>");
  });

  it("detects text/xml", async () => {
    const r = await first(
      `curl -X POST https://e.com/x -H 'Content-Type: text/xml' --data '<root/>'`,
    );
    expect(r.body?.kind).toBe("xml");
  });

  it("detects vendor XML (+xml suffix)", async () => {
    const r = await first(
      `curl -X POST https://e.com/x -H 'Content-Type: application/soap+xml' --data '<env/>'`,
    );
    expect(r.body?.kind).toBe("xml");
  });
});

describe("CurlAdapter - text and binary body", () => {
  it("detects text/plain", async () => {
    const r = await first(
      `curl -X POST https://e.com/x -H 'Content-Type: text/plain' --data 'hello'`,
    );
    expect(r.body?.kind).toBe("text");
  });

  it("detects text/html", async () => {
    const r = await first(
      `curl -X POST https://e.com/x -H 'Content-Type: text/html' --data '<h1>hi</h1>'`,
    );
    expect(r.body?.kind).toBe("text");
    expect(r.body?.mediaType).toBe("text/html");
  });

  it("defaults unknown content-type to binary", async () => {
    const r = await first(
      `curl -X POST https://e.com/x -H 'Content-Type: application/octet-stream' --data-binary 'rawbytes'`,
    );
    expect(r.body?.kind).toBe("binary");
  });
});

describe("CurlAdapter - auth detection", () => {
  it("detects bearer from Authorization header", async () => {
    const r = await first(
      `curl 'https://e.com/x' -H 'Authorization: Bearer token123'`,
    );
    expect(r.auth?.type).toBe("bearer");
  });

  it("detects basic from Authorization header", async () => {
    const r = await first(
      `curl 'https://e.com/x' -H 'Authorization: Basic dXNlcjpwYXNz'`,
    );
    expect(r.auth?.type).toBe("basic");
  });

  it("detects basic from -u flag", async () => {
    const r = await first(`curl -u user:pass https://e.com/x`);
    expect(r.auth?.type).toBe("basic");
  });

  it("detects bearer from --oauth2-bearer flag", async () => {
    const r = await first(`curl --oauth2-bearer tok https://e.com/x`);
    expect(r.auth?.type).toBe("bearer");
  });

  it("detects apiKey from x-api-key header", async () => {
    const r = await first(
      `curl 'https://e.com/x' -H 'x-api-key: secret123'`,
    );
    expect(r.auth?.type).toBe("apiKey");
    expect(r.auth?.type === "apiKey" && r.auth.in).toBe("header");
    expect(r.auth?.type === "apiKey" && r.auth.name).toBe("x-api-key");
  });

  it("detects apiKey from query parameter", async () => {
    const r = await first(`curl 'https://e.com/x?api_key=secret123'`);
    expect(r.auth?.type).toBe("apiKey");
    expect(r.auth?.type === "apiKey" && r.auth.in).toBe("query");
    expect(r.auth?.type === "apiKey" && r.auth.name).toBe("api_key");
  });

  it("detects apiKey from access_token query", async () => {
    const r = await first(`curl 'https://e.com/x?access_token=abc'`);
    expect(r.auth?.type).toBe("apiKey");
    expect(r.auth?.type === "apiKey" && r.auth.name).toBe("access_token");
  });

  it("returns undefined auth when no credentials", async () => {
    const r = await first("curl https://e.com/x");
    expect(r.auth).toBeUndefined();
  });
});

describe("CurlAdapter - error handling", () => {
  it("reports parse failure without throwing", async () => {
    const diagnostics: { code: string }[] = [];
    const r = await adapter.parse("curl ://broken", {
      report: (d) => diagnostics.push(d),
      strict: false,
    });
    expect(r).toHaveLength(0);
    expect(diagnostics.some((d) => d.code === "CURL_PARSE_FAILED")).toBe(true);
  });

  it("returns empty array for empty input", async () => {
    const diagnostics: { code: string }[] = [];
    const r = await adapter.parse("", {
      report: (d) => diagnostics.push(d),
      strict: false,
    });
    expect(r).toHaveLength(0);
    expect(diagnostics.some((d) => d.code === "CURL_EMPTY_INPUT")).toBe(true);
  });

  it("handles array of commands", async () => {
    const r = await parse([
      "curl https://e.com/a",
      "curl https://e.com/b",
    ]);
    expect(r).toHaveLength(2);
  });

  it("filters non-string items from array", async () => {
    const r = await adapter.parse(
      ["curl https://e.com/a", 42, null, "curl https://e.com/b"] as never,
      ctx,
    );
    expect(r).toHaveLength(2);
  });
});
