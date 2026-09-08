import { describe, it, expect } from "vitest";
import { PostmanAdapter } from "../src/adapters/postman/index.js";
import { postmanToOpenApi, buildOpenApi32 } from "../src/index.js";
import type {
  PostmanCollection,
  PostmanRequestItem,
} from "../src/adapters/postman/types.js";

function collection(
  items: PostmanCollection["item"],
  overrides: Partial<PostmanCollection> = {},
): PostmanCollection {
  return {
    info: {
      name: "Test Collection",
      schema:
        "https://schema.postman.com/json/collection/v2.1.0/collection.json",
    },
    item: items,
    ...overrides,
  };
}

function reqItem(
  name: string,
  method: string,
  url: string,
  overrides: Record<string, unknown> = {},
): PostmanRequestItem {
  return {
    name,
    request: { method, url, header: [], ...overrides },
  } as PostmanRequestItem;
}

const adapter = new PostmanAdapter();
const report = () => {};
const ctx = { report, strict: false };

// ---------------------------------------------------------------------------
// canHandle
// ---------------------------------------------------------------------------
describe("PostmanAdapter - canHandle", () => {
  it("accepts a v2.1.0 collection object", () => {
    expect(adapter.canHandle(collection([]))).toBe(true);
  });

  it("accepts a v2.0.0 collection object", () => {
    expect(
      adapter.canHandle(
        collection([], {
          info: {
            name: "Old",
            schema:
              "https://schema.getpostman.com/json/collection/v2.0.0/collection.json",
          },
        }),
      ),
    ).toBe(true);
  });

  it("accepts a collection without schema URL", () => {
    expect(
      adapter.canHandle({ info: { name: "No Schema" }, item: [] }),
    ).toBe(true);
  });

  it("accepts a JSON string", () => {
    expect(adapter.canHandle(JSON.stringify(collection([])))).toBe(true);
  });

  it("rejects non-object input", () => {
    expect(adapter.canHandle(42)).toBe(false);
    expect(adapter.canHandle(null)).toBe(false);
    expect(adapter.canHandle(undefined)).toBe(false);
  });

  it("rejects objects without info", () => {
    expect(adapter.canHandle({ item: [] })).toBe(false);
  });

  it("rejects objects without item array", () => {
    expect(adapter.canHandle({ info: { name: "x" } })).toBe(false);
  });

  it("rejects invalid JSON strings", () => {
    expect(adapter.canHandle("not json")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Basic parsing
// ---------------------------------------------------------------------------
describe("PostmanAdapter - basic parsing", () => {
  it("parses a single GET request", async () => {
    const result = await adapter.parse(
      collection([reqItem("Get users", "GET", "https://api.example.com/users")]),
      ctx,
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.method).toBe("get");
    expect(result[0]!.url.href).toBe("https://api.example.com/users");
    expect(result[0]!.source).toBe("postman");
    expect(result[0]!.sourceIndex).toBe(0);
    expect(result[0]!.urlString).toBe("https://api.example.com/users");
  });

  it("parses multiple requests", async () => {
    const result = await adapter.parse(
      collection([
        reqItem("A", "GET", "https://api.example.com/a"),
        reqItem("B", "POST", "https://api.example.com/b"),
        reqItem("C", "DELETE", "https://api.example.com/c"),
      ]),
      ctx,
    );
    expect(result).toHaveLength(3);
    expect(result.map((r) => r.method)).toEqual(["get", "post", "delete"]);
    expect(result.map((r) => r.sourceIndex)).toEqual([0, 1, 2]);
  });

  it("lowercases the method", async () => {
    const result = await adapter.parse(
      collection([reqItem("X", "PaTcH", "https://api.example.com/x")]),
      ctx,
    );
    expect(result[0]!.method).toBe("patch");
  });

  it("parses a JSON string input", async () => {
    const result = await adapter.parse(
      JSON.stringify(
        collection([reqItem("Get", "GET", "https://api.example.com/get")]),
      ),
      ctx,
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.url.href).toBe("https://api.example.com/get");
  });
});

// ---------------------------------------------------------------------------
// Nested folders
// ---------------------------------------------------------------------------
describe("PostmanAdapter - nested folders", () => {
  it("flattens nested folders", async () => {
    const result = await adapter.parse(
      collection([
        {
          name: "Folder A",
          item: [
            reqItem("A1", "GET", "https://api.example.com/a1"),
            {
              name: "Subfolder",
              item: [reqItem("A2", "POST", "https://api.example.com/a2")],
            },
          ],
        },
        reqItem("Top", "GET", "https://api.example.com/top"),
      ]),
      ctx,
    );
    expect(result).toHaveLength(3);
    expect(result.map((r) => r.url.pathname)).toEqual([
      "/a1",
      "/a2",
      "/top",
    ]);
  });

  it("assigns sequential sourceIndex across folders", async () => {
    const result = await adapter.parse(
      collection([
        {
          name: "F",
          item: [
            reqItem("1", "GET", "https://api.example.com/1"),
            reqItem("2", "GET", "https://api.example.com/2"),
          ],
        },
        reqItem("3", "GET", "https://api.example.com/3"),
      ]),
      ctx,
    );
    expect(result.map((r) => r.sourceIndex)).toEqual([0, 1, 2]);
  });
});

// ---------------------------------------------------------------------------
// URL handling
// ---------------------------------------------------------------------------
describe("PostmanAdapter - URL handling", () => {
  it("uses raw URL string", async () => {
    const result = await adapter.parse(
      collection([
        reqItem("X", "GET", "https://api.example.com/path?q=1&r=2"),
      ]),
      ctx,
    );
    expect(result[0]!.url.pathname).toBe("/path");
    expect(result[0]!.url.searchParams.get("q")).toBe("1");
    expect(result[0]!.url.searchParams.get("r")).toBe("2");
  });

  it("reconstructs URL from structured object", async () => {
    const result = await adapter.parse(
      collection([
        {
          name: "Structured",
          request: {
            method: "GET",
            url: {
              protocol: "https",
              host: ["api", "example", "com"],
              path: ["v1", "users"],
              port: "8443",
              query: [{ key: "page", value: "2" }],
            },
          },
        },
      ]),
      ctx,
    );
    expect(result[0]!.url.href).toBe(
      "https://api.example.com:8443/v1/users?page=2",
    );
  });

  it("prefers raw over structured parts", async () => {
    const result = await adapter.parse(
      collection([
        {
          name: "Raw takes precedence",
          request: {
            method: "GET",
            url: {
              raw: "https://other.example.com/from-raw",
              protocol: "http",
              host: ["wrong"],
              path: ["wrong"],
            },
          },
        },
      ]),
      ctx,
    );
    expect(result[0]!.url.href).toBe("https://other.example.com/from-raw");
  });

  it("skips items with no URL", async () => {
    const diagnostics: unknown[] = [];
    const result = await adapter.parse(
      collection([
        { name: "No URL", request: { method: "GET", header: [] } },
        reqItem("OK", "GET", "https://api.example.com/ok"),
      ]),
      { report: (d: unknown) => diagnostics.push(d), strict: false },
    );
    expect(result).toHaveLength(1);
    expect(diagnostics.length).toBeGreaterThan(0);
  });

  it("skips items with invalid URL", async () => {
    const result = await adapter.parse(
      collection([
        reqItem("Bad", "GET", "not a url"),
        reqItem("OK", "GET", "https://api.example.com/ok"),
      ]),
      ctx,
    );
    expect(result).toHaveLength(1);
  });

  it("preserves Postman variables in URL", async () => {
    const result = await adapter.parse(
      collection([
        reqItem("Var", "GET", "https://{{host}}/api/{{version}}/users"),
      ]),
      ctx,
    );
    // URL constructor may normalize; the raw variable should survive in urlString
    expect(result[0]!.urlString).toContain("{{host}}");
  });
});

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------
describe("PostmanAdapter - headers", () => {
  it("parses headers", async () => {
    const result = await adapter.parse(
      collection([
        {
          name: "H",
          request: {
            method: "GET",
            url: "https://api.example.com/",
            header: [
              { key: "X-Custom", value: "hello" },
              { key: "Accept", value: "application/json" },
            ],
          },
        },
      ]),
      ctx,
    );
    expect(result[0]!.headers).toEqual([
      { name: "X-Custom", value: "hello" },
      { name: "Accept", value: "application/json" },
    ]);
  });

  it("skips disabled headers", async () => {
    const result = await adapter.parse(
      collection([
        {
          name: "H",
          request: {
            method: "GET",
            url: "https://api.example.com/",
            header: [
              { key: "X-On", value: "1" },
              { key: "X-Off", value: "2", disabled: true },
            ],
          },
        },
      ]),
      ctx,
    );
    expect(result[0]!.headers).toHaveLength(1);
    expect(result[0]!.headers[0]!.name).toBe("X-On");
  });

  it("skips headers with empty key", async () => {
    const result = await adapter.parse(
      collection([
        {
          name: "H",
          request: {
            method: "GET",
            url: "https://api.example.com/",
            header: [
              { key: "", value: "x" },
              { key: "X-Valid", value: "y" },
            ],
          },
        },
      ]),
      ctx,
    );
    expect(result[0]!.headers).toHaveLength(1);
  });

  it("extracts cookies from Cookie header", async () => {
    const result = await adapter.parse(
      collection([
        {
          name: "C",
          request: {
            method: "GET",
            url: "https://api.example.com/",
            header: [{ key: "Cookie", value: "session=abc; theme=dark" }],
          },
        },
      ]),
      ctx,
    );
    expect(result[0]!.cookies).toEqual([
      { name: "session", value: "abc" },
      { name: "theme", value: "dark" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Query parameters
// ---------------------------------------------------------------------------
describe("PostmanAdapter - query parameters", () => {
  it("extracts query from structured URL", async () => {
    const result = await adapter.parse(
      collection([
        {
          name: "Q",
          request: {
            method: "GET",
            url: {
              raw: "https://api.example.com/search",
              query: [
                { key: "q", value: "hello" },
                { key: "page", value: "1" },
              ],
            },
          },
        },
      ]),
      ctx,
    );
    expect(result[0]!.query).toEqual([
      { name: "q", value: "hello" },
      { name: "page", value: "1" },
    ]);
  });

  it("skips disabled query params", async () => {
    const result = await adapter.parse(
      collection([
        {
          name: "Q",
          request: {
            method: "GET",
            url: {
              raw: "https://api.example.com/search",
              query: [
                { key: "q", value: "hello" },
                { key: "old", value: "1", disabled: true },
              ],
            },
          },
        },
      ]),
      ctx,
    );
    expect(result[0]!.query).toHaveLength(1);
  });

  it("extracts query from raw URL string", async () => {
    const result = await adapter.parse(
      collection([reqItem("Q", "GET", "https://api.example.com/?a=1&b=2")]),
      ctx,
    );
    expect(result[0]!.query).toEqual([
      { name: "a", value: "1" },
      { name: "b", value: "2" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Body modes
// ---------------------------------------------------------------------------
describe("PostmanAdapter - body modes", () => {
  it("parses raw JSON body", async () => {
    const result = await adapter.parse(
      collection([
        {
          name: "JSON",
          request: {
            method: "POST",
            url: "https://api.example.com/users",
            header: [{ key: "Content-Type", value: "application/json" }],
            body: { mode: "raw", raw: '{"name":"Ada"}' },
          },
        },
      ]),
      ctx,
    );
    expect(result[0]!.body).toEqual({
      kind: "json",
      mediaType: "application/json",
      raw: '{"name":"Ada"}',
    });
  });

  it("detects JSON from language hint without content-type", async () => {
    const result = await adapter.parse(
      collection([
        {
          name: "JSON",
          request: {
            method: "POST",
            url: "https://api.example.com/users",
            header: [],
            body: {
              mode: "raw",
              raw: '{"name":"Ada"}',
              options: { raw: { language: "json" } },
            },
          },
        },
      ]),
      ctx,
    );
    expect(result[0]!.body!.kind).toBe("json");
    expect(result[0]!.body!.mediaType).toBe("application/json");
  });

  it("parses raw XML body", async () => {
    const result = await adapter.parse(
      collection([
        {
          name: "XML",
          request: {
            method: "POST",
            url: "https://api.example.com/xml",
            header: [{ key: "Content-Type", value: "application/xml" }],
            body: { mode: "raw", raw: "<root/>" },
          },
        },
      ]),
      ctx,
    );
    expect(result[0]!.body!.kind).toBe("xml");
  });

  it("parses raw text body", async () => {
    const result = await adapter.parse(
      collection([
        {
          name: "Text",
          request: {
            method: "POST",
            url: "https://api.example.com/text",
            header: [{ key: "Content-Type", value: "text/plain" }],
            body: { mode: "raw", raw: "hello world" },
          },
        },
      ]),
      ctx,
    );
    expect(result[0]!.body!.kind).toBe("text");
  });

  it("parses urlencoded body", async () => {
    const result = await adapter.parse(
      collection([
        {
          name: "Form",
          request: {
            method: "POST",
            url: "https://api.example.com/login",
            header: [],
            body: {
              mode: "urlencoded",
              urlencoded: [
                { key: "username", value: "ada" },
                { key: "password", value: "secret" },
              ],
            },
          },
        },
      ]),
      ctx,
    );
    expect(result[0]!.body).toEqual({
      kind: "form-urlencoded",
      mediaType: "application/x-www-form-urlencoded",
      fields: [
        { name: "username", value: "ada" },
        { name: "password", value: "secret" },
      ],
    });
  });

  it("skips disabled urlencoded params", async () => {
    const result = await adapter.parse(
      collection([
        {
          name: "Form",
          request: {
            method: "POST",
            url: "https://api.example.com/login",
            body: {
              mode: "urlencoded",
              urlencoded: [
                { key: "a", value: "1" },
                { key: "b", value: "2", disabled: true },
              ],
            },
          },
        },
      ]),
      ctx,
    );
    expect(result[0]!.body!.fields).toHaveLength(1);
  });

  it("parses formdata with text fields", async () => {
    const result = await adapter.parse(
      collection([
        {
          name: "Multipart",
          request: {
            method: "POST",
            url: "https://api.example.com/upload",
            body: {
              mode: "formdata",
              formdata: [
                { key: "title", value: "Hello", type: "text" },
                { key: "desc", value: "World", type: "text" },
              ],
            },
          },
        },
      ]),
      ctx,
    );
    expect(result[0]!.body).toEqual({
      kind: "multipart",
      mediaType: "multipart/form-data",
      fields: [
        { name: "title", value: "Hello" },
        { name: "desc", value: "World" },
      ],
    });
  });

  it("parses formdata with file fields", async () => {
    const result = await adapter.parse(
      collection([
        {
          name: "File",
          request: {
            method: "POST",
            url: "https://api.example.com/upload",
            body: {
              mode: "formdata",
              formdata: [
                { key: "avatar", type: "file", src: "/tmp/photo.png" },
                { key: "name", value: "Ada", type: "text" },
              ],
            },
          },
        },
      ]),
      ctx,
    );
    expect(result[0]!.body!.fields).toEqual([
      { name: "avatar", fileName: "/tmp/photo.png" },
      { name: "name", value: "Ada" },
    ]);
  });

  it("parses formdata with src array", async () => {
    const result = await adapter.parse(
      collection([
        {
          name: "FileArr",
          request: {
            method: "POST",
            url: "https://api.example.com/upload",
            body: {
              mode: "formdata",
              formdata: [
                { key: "files", type: "file", src: ["/tmp/a.png", "/tmp/b.png"] },
              ],
            },
          },
        },
      ]),
      ctx,
    );
    expect(result[0]!.body!.fields![0]!.fileName).toBe("/tmp/a.png");
  });

  it("parses file body mode as binary", async () => {
    const result = await adapter.parse(
      collection([
        {
          name: "Binary",
          request: {
            method: "POST",
            url: "https://api.example.com/upload",
            header: [{ key: "Content-Type", value: "application/pdf" }],
            body: { mode: "file", file: { src: "/tmp/doc.pdf" } },
          },
        },
      ]),
      ctx,
    );
    expect(result[0]!.body!.kind).toBe("binary");
    expect(result[0]!.body!.mediaType).toBe("application/pdf");
  });

  it("parses graphql body mode", async () => {
    const result = await adapter.parse(
      collection([
        {
          name: "GQL",
          request: {
            method: "POST",
            url: "https://api.example.com/graphql",
            body: {
              mode: "graphql",
              graphql: {
                query: "query { users { name } }",
                variables: JSON.stringify({ limit: 10 }),
              },
            },
          },
        },
      ]),
      ctx,
    );
    expect(result[0]!.body!.kind).toBe("json");
    const parsed = JSON.parse(result[0]!.body!.raw!);
    expect(parsed.query).toBe("query { users { name } }");
    expect(parsed.variables).toEqual({ limit: 10 });
  });

  it("handles graphql with object variables", async () => {
    const result = await adapter.parse(
      collection([
        {
          name: "GQL2",
          request: {
            method: "POST",
            url: "https://api.example.com/graphql",
            body: {
              mode: "graphql",
              graphql: { query: "{ x }", variables: { a: 1 } },
            },
          },
        },
      ]),
      ctx,
    );
    const parsed = JSON.parse(result[0]!.body!.raw!);
    expect(parsed.variables).toEqual({ a: 1 });
  });

  it("handles disabled body", async () => {
    const result = await adapter.parse(
      collection([
        {
          name: "NoBody",
          request: {
            method: "POST",
            url: "https://api.example.com/x",
            body: { mode: "raw", raw: "{}", disabled: true },
          },
        },
      ]),
      ctx,
    );
    expect(result[0]!.body).toBeUndefined();
  });

  it("handles unknown body mode with warning", async () => {
    const diagnostics: unknown[] = [];
    const result = await adapter.parse(
      collection([
        {
          name: "Unknown",
          request: {
            method: "POST",
            url: "https://api.example.com/x",
            body: { mode: "something-weird", raw: "data" },
          },
        },
      ]),
      { report: (d: unknown) => diagnostics.push(d), strict: false },
    );
    expect(result[0]!.body!.kind).toBe("text");
    expect(diagnostics.some((d: any) => d.code === "POSTMAN_UNSUPPORTED_BODY_MODE")).toBe(true);
  });

  it("handles empty body", async () => {
    const result = await adapter.parse(
      collection([
        {
          name: "Empty",
          request: { method: "POST", url: "https://api.example.com/x" },
        },
      ]),
      ctx,
    );
    expect(result[0]!.body).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
describe("PostmanAdapter - auth", () => {
  it("detects bearer auth from auth block", async () => {
    const result = await adapter.parse(
      collection([
        {
          name: "Bearer",
          request: {
            method: "GET",
            url: "https://api.example.com/secure",
            auth: { type: "bearer", bearer: [{ key: "token", value: "abc123" }] },
          },
        },
      ]),
      ctx,
    );
    expect(result[0]!.auth).toEqual({ type: "bearer" });
  });

  it("detects basic auth from auth block", async () => {
    const result = await adapter.parse(
      collection([
        {
          name: "Basic",
          request: {
            method: "GET",
            url: "https://api.example.com/secure",
            auth: {
              type: "basic",
              basic: [
                { key: "username", value: "user" },
                { key: "password", value: "pass" },
              ],
            },
          },
        },
      ]),
      ctx,
    );
    expect(result[0]!.auth).toEqual({ type: "basic" });
  });

  it("detects apikey auth in header", async () => {
    const result = await adapter.parse(
      collection([
        {
          name: "APIKey",
          request: {
            method: "GET",
            url: "https://api.example.com/secure",
            auth: {
              type: "apikey",
              apikey: [
                { key: "key", value: "X-API-Key" },
                { key: "value", value: "secret" },
                { key: "in", value: "header" },
              ],
            },
          },
        },
      ]),
      ctx,
    );
    expect(result[0]!.auth).toEqual({
      type: "apiKey",
      in: "header",
      name: "X-API-Key",
    });
  });

  it("detects apikey auth in query", async () => {
    const result = await adapter.parse(
      collection([
        {
          name: "APIKeyQ",
          request: {
            method: "GET",
            url: "https://api.example.com/secure",
            auth: {
              type: "apikey",
              apikey: [
                { key: "key", value: "api_key" },
                { key: "in", value: "query" },
              ],
            },
          },
        },
      ]),
      ctx,
    );
    expect(result[0]!.auth).toEqual({
      type: "apiKey",
      in: "query",
      name: "api_key",
    });
  });

  it("noauth block means no auth", async () => {
    const result = await adapter.parse(
      collection([
        {
          name: "NoAuth",
          request: {
            method: "GET",
            url: "https://api.example.com/public",
            auth: { type: "noauth" },
          },
        },
      ]),
      ctx,
    );
    expect(result[0]!.auth).toBeUndefined();
  });

  it("inherits auth from collection", async () => {
    const result = await adapter.parse(
      collection(
        [reqItem("Inherited", "GET", "https://api.example.com/secure")],
        {
          auth: {
            type: "bearer",
            bearer: [{ key: "token", value: "col-token" }],
          },
        },
      ),
      ctx,
    );
    expect(result[0]!.auth).toEqual({ type: "bearer" });
  });

  it("inherits auth from folder", async () => {
    const result = await adapter.parse(
      collection([
        {
          name: "Secure Folder",
          auth: {
            type: "basic",
            basic: [{ key: "username", value: "u" }],
          },
          item: [reqItem("InFolder", "GET", "https://api.example.com/secure")],
        },
      ]),
      ctx,
    );
    expect(result[0]!.auth).toEqual({ type: "basic" });
  });

  it("item auth overrides folder auth", async () => {
    const result = await adapter.parse(
      collection([
        {
          name: "Folder",
          auth: { type: "basic", basic: [{ key: "username", value: "u" }] },
          item: [
            {
              name: "Override",
              request: {
                method: "GET",
                url: "https://api.example.com/secure",
                auth: {
                  type: "bearer",
                  bearer: [{ key: "token", value: "t" }],
                },
              },
            },
          ],
        },
      ]),
      ctx,
    );
    expect(result[0]!.auth).toEqual({ type: "bearer" });
  });

  it("detects bearer from Authorization header", async () => {
    const result = await adapter.parse(
      collection([
        {
          name: "H",
          request: {
            method: "GET",
            url: "https://api.example.com/",
            header: [{ key: "Authorization", value: "Bearer token123" }],
          },
        },
      ]),
      ctx,
    );
    expect(result[0]!.auth).toEqual({ type: "bearer" });
  });

  it("detects basic from Authorization header", async () => {
    const result = await adapter.parse(
      collection([
        {
          name: "H",
          request: {
            method: "GET",
            url: "https://api.example.com/",
            header: [{ key: "Authorization", value: "Basic dXNlcjpwYXNz" }],
          },
        },
      ]),
      ctx,
    );
    expect(result[0]!.auth).toEqual({ type: "basic" });
  });

  it("detects apiKey from x-api-key header", async () => {
    const result = await adapter.parse(
      collection([
        {
          name: "H",
          request: {
            method: "GET",
            url: "https://api.example.com/",
            header: [{ key: "x-api-key", value: "secret" }],
          },
        },
      ]),
      ctx,
    );
    expect(result[0]!.auth).toEqual({
      type: "apiKey",
      in: "header",
      name: "x-api-key",
    });
  });

  it("detects apiKey from access_token query", async () => {
    const result = await adapter.parse(
      collection([
        reqItem("Q", "GET", "https://api.example.com/?access_token=abc"),
      ]),
      ctx,
    );
    expect(result[0]!.auth).toEqual({
      type: "apiKey",
      in: "query",
      name: "access_token",
    });
  });
});

// ---------------------------------------------------------------------------
// Test scripts / extensions
// ---------------------------------------------------------------------------
describe("PostmanAdapter - test scripts and extensions", () => {
  it("preserves test scripts as x-postman-scripts", async () => {
    const result = await adapter.parse(
      collection([
        {
          name: "WithTest",
          request: { method: "GET", url: "https://api.example.com/users" },
          event: [
            {
              listen: "test",
              script: {
                type: "text/javascript",
                exec: ["pm.test('status is 200', () => pm.response.to.have.status(200));"],
              },
            },
          ],
        },
      ]),
      ctx,
    );
    expect(result[0]!.extensions).toEqual({
      "x-postman-scripts": {
        test: "pm.test('status is 200', () => pm.response.to.have.status(200));",
      },
    });
  });

  it("joins multiple test script lines", async () => {
    const result = await adapter.parse(
      collection([
        {
          name: "MultiTest",
          request: { method: "GET", url: "https://api.example.com/" },
          event: [
            {
              listen: "test",
              script: { exec: ["line1();", "line2();"] },
            },
          ],
        },
      ]),
      ctx,
    );
    expect(
      (result[0]!.extensions!["x-postman-scripts"] as any).test,
    ).toBe("line1();\nline2();");
  });

  it("inherits test scripts from collection", async () => {
    const result = await adapter.parse(
      collection(
        [reqItem("NoOwnTest", "GET", "https://api.example.com/")],
        {
          event: [
            {
              listen: "test",
              script: { exec: ["pm.test('col test', () => {});"] },
            },
          ],
        },
      ),
      ctx,
    );
    expect(
      (result[0]!.extensions!["x-postman-scripts"] as any).test,
    ).toContain("col test");
  });

  it("combines collection and item test scripts", async () => {
    const result = await adapter.parse(
      collection(
        [
          {
            name: "OwnTest",
            request: { method: "GET", url: "https://api.example.com/" },
            event: [
              {
                listen: "test",
                script: { exec: ["pm.test('item test', () => {});"] },
              },
            ],
          },
        ],
        {
          event: [
            {
              listen: "test",
              script: { exec: ["pm.test('col test', () => {});"] },
            },
          ],
        },
      ),
      ctx,
    );
    const test = (result[0]!.extensions!["x-postman-scripts"] as any).test;
    expect(test).toContain("col test");
    expect(test).toContain("item test");
  });

  it("preserves pre-request scripts", async () => {
    const result = await adapter.parse(
      collection([
        {
          name: "PreReq",
          request: { method: "GET", url: "https://api.example.com/" },
          event: [
            {
              listen: "prerequest",
              script: { exec: ["pm.variables.set('x', '1');"] },
            },
          ],
        },
      ]),
      ctx,
    );
    expect(
      (result[0]!.extensions!["x-postman-scripts"] as any).prerequest,
    ).toBe("pm.variables.set('x', '1');");
  });

  it("skips disabled events", async () => {
    const result = await adapter.parse(
      collection([
        {
          name: "Disabled",
          request: { method: "GET", url: "https://api.example.com/" },
          event: [
            {
              listen: "test",
              disabled: true,
              script: { exec: ["should not appear"] },
            },
          ],
        },
      ]),
      ctx,
    );
    expect(result[0]!.extensions).toBeUndefined();
  });

  it("skips events with no script", async () => {
    const result = await adapter.parse(
      collection([
        {
          name: "NoScript",
          request: { method: "GET", url: "https://api.example.com/" },
          event: [{ listen: "test" }],
        },
      ]),
      ctx,
    );
    expect(result[0]!.extensions).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------
describe("PostmanAdapter - error handling", () => {
  it("reports invalid JSON string", async () => {
    const diagnostics: unknown[] = [];
    const result = await adapter.parse("{invalid json", {
      report: (d: unknown) => diagnostics.push(d),
      strict: false,
    });
    expect(result).toEqual([]);
    expect(diagnostics.some((d: any) => d.code === "POSTMAN_INVALID_COLLECTION")).toBe(true);
  });

  it("reports empty collection", async () => {
    const diagnostics: unknown[] = [];
    const result = await adapter.parse(collection([]), {
      report: (d: unknown) => diagnostics.push(d),
      strict: false,
    });
    expect(result).toEqual([]);
    expect(diagnostics.some((d: any) => d.code === "POSTMAN_EMPTY_COLLECTION")).toBe(true);
  });

  it("handles null input gracefully", async () => {
    const result = await adapter.parse(null as any, ctx);
    expect(result).toEqual([]);
  });

  it("handles items that are neither folder nor request", async () => {
    const result = await adapter.parse(
      collection([{ name: "Weird", random: true } as any]),
      ctx,
    );
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Integration: full conversion to OpenAPI
// ---------------------------------------------------------------------------
describe("PostmanAdapter - full OpenAPI conversion", () => {
  it("produces a valid OpenAPI document with x-postman-scripts", async () => {
    const result = await postmanToOpenApi(
      collection([
        {
          name: "Create user",
          request: {
            method: "POST",
            url: "https://api.example.com/users",
            header: [{ key: "Content-Type", value: "application/json" }],
            body: { mode: "raw", raw: '{"name":"Ada","age":36}' },
          },
          event: [
            {
              listen: "test",
              script: {
                exec: ["pm.test('status is 201', () => pm.response.to.have.status(201));"],
              },
            },
          ],
        },
      ]),
    );

    expect(result.ok).toBe(true);
    const op = (result.document.paths!["/users"] as any)?.post;
    expect(op).toBeDefined();
    expect(op.operationId).toBe("postUsers");
    expect(op.requestBody.content["application/json"].schema.properties.name.type).toBe(
      "string",
    );
    expect(op["x-postman-scripts"]).toEqual({
      test: "pm.test('status is 201', () => pm.response.to.have.status(201));",
    });
  });

  it("converts a full collection with folders and multiple protocols", async () => {
    const result = await postmanToOpenApi(
      collection([
        {
          name: "Users",
          item: [
            reqItem("List users", "GET", "https://api.example.com/users"),
            {
              name: "Create user",
              request: {
                method: "POST",
                url: "https://api.example.com/users",
                header: [{ key: "Content-Type", value: "application/json" }],
                body: { mode: "raw", raw: '{"name":"Ada"}' },
              },
            },
            reqItem("Get user 1", "GET", "https://api.example.com/users/123"),
            reqItem("Get user 2", "GET", "https://api.example.com/users/456"),
          ],
        },
        {
          name: "Auth",
          item: [
            {
              name: "Login",
              request: {
                method: "POST",
                url: "https://api.example.com/login",
                body: {
                  mode: "urlencoded",
                  urlencoded: [
                    { key: "username", value: "ada" },
                    { key: "password", value: "secret" },
                  ],
                },
              },
            },
          ],
        },
      ]),
      { inferPathParameters: true, pathParameterMinSamples: 1 },
    );

    expect(result.ok).toBe(true);
    expect(Object.keys(result.document.paths!).sort()).toEqual([
      "/login",
      "/users",
      "/users/{userId}",
    ]);
  });

  it("emits security schemes from Postman auth", async () => {
    const result = await postmanToOpenApi(
      collection([
        {
          name: "Secure",
          request: {
            method: "GET",
            url: "https://api.example.com/secure",
            auth: {
              type: "bearer",
              bearer: [{ key: "token", value: "t" }],
            },
          },
        },
      ]),
    );
    const components = result.document.components as any;
    expect(components?.securitySchemes?.bearerAuth).toEqual({
      type: "http",
      scheme: "bearer",
    });
    const op = (result.document.paths!["/secure"] as any)?.get;
    expect(op.security).toEqual([{ bearerAuth: [] }]);
  });

  it("handles multipart form upload in full conversion", async () => {
    const result = await postmanToOpenApi(
      collection([
        {
          name: "Upload",
          request: {
            method: "POST",
            url: "https://api.example.com/upload",
            body: {
              mode: "formdata",
              formdata: [
                { key: "title", value: "My File", type: "text" },
                { key: "file", type: "file", src: "/tmp/doc.pdf" },
              ],
            },
          },
        },
      ]),
    );
    const op = (result.document.paths!["/upload"] as any)?.post;
    const content = op.requestBody.content["multipart/form-data"];
    expect(content.schema.properties.title.type).toBe("string");
    expect(content.schema.properties.file.type).toBe("string");
    expect(content.schema.properties.file.format).toBe("binary");
  });
});

// ---------------------------------------------------------------------------
// Canonical exports
// ---------------------------------------------------------------------------
describe("canonical exports", () => {
  it("exports OpenApiDocument type", async () => {
    // Type-level check: this compiles only if the export exists.
    const doc = {} as import("../src/index.js").OpenApiDocument;
    expect(doc).toBeDefined();
  });

  it("exports validateOpenApiDocument function", async () => {
    const { validateOpenApiDocument } = await import("../src/index.js");
    expect(typeof validateOpenApiDocument).toBe("function");
  });

  it("validateOpenApiDocument is the same as validateOpenApi32", async () => {
    const { validateOpenApiDocument, validateOpenApi32 } = await import(
      "../src/index.js"
    );
    expect(validateOpenApiDocument).toBe(validateOpenApi32);
  });
});
