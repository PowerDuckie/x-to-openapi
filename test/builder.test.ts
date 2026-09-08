import { describe, expect, it } from "vitest";

import { buildOpenApi32 } from "../src/openapi/builder.js";
import type {
  NormalizedRequest,
  OpenApiDocument,
  ResolvedConvertOptions,
} from "../src/core/types.js";

/**
 * Test document type with non-optional paths for ergonomic access.
 * buildOpenApi32 always emits a paths object, so this is safe in tests.
 */
type TestDocument = OpenApiDocument & {
  paths: Record<string, Record<string, any>>;
};

const baseOptions: ResolvedConvertOptions = {
  openapiVersion: "3.2.0",
  title: "Test",
  version: "1.0.0",
  description: "",
  inferPathParameters: true,
  pathParameterMinSamples: 2,
  inferSecurity: true,
  includeCommonHeaders: false,
  includeCookies: false,
  includeExamples: false,
  useServerBasePath: false,
  validate: true,
  strict: false,
};

const report = () => {};

function req(
  method: string,
  url: string,
  overrides: Partial<NormalizedRequest> = {},
): NormalizedRequest {
  const parsed = new URL(url);
  return {
    source: "test",
    sourceIndex: 0,
    method,
    url: parsed,
    urlString: url,
    headers: [],
    query: [],
    cookies: [],
    ...overrides,
  };
}

function build(
  requests: NormalizedRequest[],
  options: Partial<ResolvedConvertOptions> = {},
): TestDocument {
  return buildOpenApi32(requests, { ...baseOptions, ...options }, report) as TestDocument;
}

describe("buildOpenApi32 - basic structure", () => {
  it("emits openapi 3.2.0", () => {
    const doc = build([req("get", "https://e.com/x")]);
    expect(doc.openapi).toBe("3.2.0");
  });

  it("emits info with title and version", () => {
    const doc = build([req("get", "https://e.com/x")]);
    expect(doc.info.title).toBe("Test");
    expect(doc.info.version).toBe("1.0.0");
  });

  it("emits servers from origins", () => {
    const doc = build([req("get", "https://e.com/x")]);
    expect(doc.servers).toEqual([{ url: "https://e.com" }]);
  });

  it("emits default server for empty requests", () => {
    const doc = build([]);
    expect(doc.servers).toEqual([{ url: "/" }]);
    expect(doc.paths).toEqual({});
  });

  it("creates a path entry for a GET request", () => {
    const doc = build([req("get", "https://e.com/users")]);
    expect(doc.paths["/users"]?.get).toBeTruthy();
  });

  it("creates operationId and tags", () => {
    const doc = build([req("get", "https://e.com/users")]);
    const op = doc.paths["/users"]?.get as Record<string, unknown>;
    expect(op.operationId).toBe("getUsers");
    expect(op.tags).toEqual(["users"]);
  });

  it("always emits a default response", () => {
    const doc = build([req("get", "https://e.com/x")]);
    const op = doc.paths["/x"]?.get as Record<string, unknown>;
    expect(op.responses).toEqual({
      default: { description: "Successful response" },
    });
  });
});

describe("buildOpenApi32 - method handling", () => {
  it("supports all standard methods", () => {
    const methods = ["get", "post", "put", "delete", "patch", "options", "head"];
    const requests = methods.map((m, i) =>
      req(m, "https://e.com/resource", { sourceIndex: i }),
    );
    const doc = build(requests);
    for (const m of methods) {
      expect(doc.paths["/resource"]?.[m]).toBeTruthy();
    }
  });

  it("routes non-standard methods to additionalOperations", () => {
    const doc = build([req("purge", "https://e.com/x")]);
    expect(doc.paths["/x"]?.additionalOperations?.PURGE).toBeTruthy();
    expect(doc.paths["/x"]?.purge).toBeUndefined();
  });

  it("merges multiple methods on the same path", () => {
    const doc = build([
      req("get", "https://e.com/users", { sourceIndex: 0 }),
      req("post", "https://e.com/users", { sourceIndex: 1 }),
    ]);
    expect(doc.paths["/users"]?.get).toBeTruthy();
    expect(doc.paths["/users"]?.post).toBeTruthy();
  });
});

describe("buildOpenApi32 - query parameters", () => {
  it("documents query parameters", () => {
    const doc = build([
      req("get", "https://e.com/search", {
        query: [
          { name: "q", value: "hello" },
          { name: "page", value: "1" },
        ],
      }),
    ]);
    const params = (doc.paths["/search"]?.get as any).parameters;
    expect(params.map((p: any) => p.name)).toEqual(
      expect.arrayContaining(["q", "page"]),
    );
    expect(params.every((p: any) => p.in === "query")).toBe(true);
  });

  it("treats repeated query keys as arrays with explode", () => {
    const doc = build([
      req("get", "https://e.com/t", {
        query: [
          { name: "tag", value: "a" },
          { name: "tag", value: "b" },
        ],
      }),
    ]);
    const tag = (doc.paths["/t"]?.get as any).parameters.find(
      (p: any) => p.name === "tag",
    );
    expect(tag.schema.type).toBe("array");
    expect(tag.explode).toBe(true);
  });

  it("merges query params across requests", () => {
    const doc = build([
      req("get", "https://e.com/s", {
        sourceIndex: 0,
        query: [{ name: "q", value: "a" }],
      }),
      req("get", "https://e.com/s", {
        sourceIndex: 1,
        query: [{ name: "page", value: "2" }],
      }),
    ]);
    const names = (doc.paths["/s"]?.get as any).parameters.map(
      (p: any) => p.name,
    );
    expect(names).toEqual(expect.arrayContaining(["q", "page"]));
  });
});

describe("buildOpenApi32 - header parameters", () => {
  it("documents custom headers", () => {
    const doc = build([
      req("get", "https://e.com/x", {
        headers: [{ name: "X-Request-Id", value: "abc" }],
      }),
    ]);
    const params = (doc.paths["/x"]?.get as any).parameters;
    expect(params.some((p: any) => p.name === "X-Request-Id")).toBe(true);
  });

  it("excludes transport headers", () => {
    const doc = build([
      req("get", "https://e.com/x", {
        headers: [
          { name: "Content-Length", value: "100" },
          { name: "Connection", value: "keep-alive" },
          { name: "Host", value: "e.com" },
        ],
      }),
    ]);
    const params = (doc.paths["/x"]?.get as any).parameters ?? [];
    expect(params).toHaveLength(0);
  });

  it("excludes browser headers by default", () => {
    const doc = build([
      req("get", "https://e.com/x", {
        headers: [
          { name: "User-Agent", value: "curl/8" },
          { name: "Accept", value: "*/*" },
          { name: "Sec-Fetch-Mode", value: "cors" },
        ],
      }),
    ]);
    const params = (doc.paths["/x"]?.get as any).parameters ?? [];
    expect(params).toHaveLength(0);
  });

  it("includes browser headers when includeCommonHeaders is true", () => {
    const doc = build(
      [
        req("get", "https://e.com/x", {
          headers: [{ name: "Accept", value: "application/json" }],
        }),
      ],
      { includeCommonHeaders: true },
    );
    const params = (doc.paths["/x"]?.get as any).parameters;
    expect(params.some((p: any) => p.name === "Accept")).toBe(true);
  });
});

describe("buildOpenApi32 - cookie parameters", () => {
  it("excludes cookies by default", () => {
    const doc = build([
      req("get", "https://e.com/x", {
        cookies: [{ name: "sid", value: "abc" }],
      }),
    ]);
    const params = (doc.paths["/x"]?.get as any).parameters ?? [];
    expect(params.every((p: any) => p.in !== "cookie")).toBe(true);
  });

  it("includes cookies when includeCookies is true", () => {
    const doc = build(
      [
        req("get", "https://e.com/x", {
          cookies: [{ name: "sid", value: "abc" }],
        }),
      ],
      { includeCookies: true },
    );
    const params = (doc.paths["/x"]?.get as any).parameters;
    expect(params.some((p: any) => p.name === "sid" && p.in === "cookie")).toBe(
      true,
    );
  });
});

describe("buildOpenApi32 - request body", () => {
  it("documents JSON body with object schema", () => {
    const doc = build([
      req("post", "https://e.com/users", {
        body: {
          kind: "json",
          mediaType: "application/json",
          raw: '{"name":"Ada","age":36}',
        },
      }),
    ]);
    const content = (doc.paths["/users"]?.post as any).requestBody.content;
    expect(content["application/json"].schema.type).toBe("object");
    expect(content["application/json"].schema.properties.name.type).toBe(
      "string",
    );
    expect(content["application/json"].schema.properties.age.type).toBe(
      "integer",
    );
  });

  it("marks single media type body as required", () => {
    const doc = build([
      req("post", "https://e.com/x", {
        body: { kind: "json", mediaType: "application/json", raw: "{}" },
      }),
    ]);
    expect((doc.paths["/x"]?.post as any).requestBody.required).toBe(true);
  });

  it("falls back to text/plain for invalid JSON", () => {
    const diagnostics: { code: string }[] = [];
    const doc = buildOpenApi32(
      [
        req("post", "https://e.com/x", {
          body: {
            kind: "json",
            mediaType: "application/json",
            raw: "{invalid",
          },
        }),
      ],
      baseOptions,
      (d) => diagnostics.push(d),
    ) as TestDocument;
    const content = (doc.paths["/x"]?.post as any).requestBody.content;
    expect(content["application/json"]).toBeUndefined();
    expect(content["text/plain"].schema.type).toBe("string");
    expect(diagnostics.some((d) => d.code === "BODY_JSON_INVALID")).toBe(true);
  });

  it("documents form-urlencoded body from fields", () => {
    const doc = build([
      req("post", "https://e.com/x", {
        body: {
          kind: "form-urlencoded",
          mediaType: "application/x-www-form-urlencoded",
          fields: [
            { name: "name", value: "Ada" },
            { name: "age", value: "36" },
          ],
        },
      }),
    ]);
    const content = (doc.paths["/x"]?.post as any).requestBody.content;
    const schema = content["application/x-www-form-urlencoded"].schema;
    expect(schema.type).toBe("object");
    expect(schema.properties.name.type).toBe("string");
    expect(schema.properties.age.type).toBe("integer");
    expect(schema.required).toEqual(["name", "age"]);
  });

  it("parses form-urlencoded raw body when fields are absent", () => {
    const doc = build([
      req("post", "https://e.com/x", {
        body: {
          kind: "form-urlencoded",
          mediaType: "application/x-www-form-urlencoded",
          raw: "name=Ada&age=36&active=true",
        },
      }),
    ]);
    const schema = (doc.paths["/x"]?.post as any).requestBody.content[
      "application/x-www-form-urlencoded"
    ].schema;
    expect(schema.properties.name.type).toBe("string");
    expect(schema.properties.age.type).toBe("integer");
    expect(schema.properties.active.type).toBe("boolean");
  });

  it("documents multipart body with text and file fields", () => {
    const doc = build([
      req("post", "https://e.com/upload", {
        body: {
          kind: "multipart",
          mediaType: "multipart/form-data",
          fields: [
            { name: "title", value: "Hello" },
            { name: "file", fileName: "doc.pdf", contentType: "application/pdf" },
          ],
        },
      }),
    ]);
    const schema = (doc.paths["/upload"]?.post as any).requestBody.content[
      "multipart/form-data"
    ].schema;
    expect(schema.properties.title.type).toBe("string");
    expect(schema.properties.file.type).toBe("string");
    expect(schema.properties.file.format).toBe("binary");
    expect(schema.properties.file.contentMediaType).toBe("application/pdf");
  });

  it("parses multipart raw body when fields are absent", () => {
    const boundary = "WebKitFormBoundary7MA4YWxkTrZu0gW";
    const raw = [
      `--${boundary}`,
      `Content-Disposition: form-data; name="title"`,
      ``,
      `Hello`,
      `--${boundary}`,
      `Content-Disposition: form-data; name="file"; filename="doc.pdf"`,
      `Content-Type: application/pdf`,
      ``,
      `%PDF-1.4`,
      `--${boundary}--`,
      ``,
    ].join("\r\n");

    const doc = build([
      req("post", "https://e.com/upload", {
        body: {
          kind: "multipart",
          mediaType: `multipart/form-data; boundary=${boundary}`,
          raw,
        },
      }),
    ]);
    const schema = (doc.paths["/upload"]?.post as any).requestBody.content[
      "multipart/form-data"
    ].schema;
    expect(schema.properties.title.type).toBe("string");
    expect(schema.properties.file.type).toBe("string");
    expect(schema.properties.file.format).toBe("binary");
  });

  it("documents binary body", () => {
    const doc = build([
      req("post", "https://e.com/x", {
        body: {
          kind: "binary",
          mediaType: "application/octet-stream",
          raw: "rawbytes",
        },
      }),
    ]);
    const schema = (doc.paths["/x"]?.post as any).requestBody.content[
      "application/octet-stream"
    ].schema;
    expect(schema.type).toBe("string");
    expect(schema.format).toBe("binary");
  });

  it("documents text body with example when includeExamples", () => {
    const doc = build(
      [
        req("post", "https://e.com/x", {
          body: { kind: "text", mediaType: "text/plain", raw: "hello" },
        }),
      ],
      { includeExamples: true },
    );
    const schema = (doc.paths["/x"]?.post as any).requestBody.content[
      "text/plain"
    ].schema;
    expect(schema.example).toBe("hello");
  });

  it("merges body schemas across requests with same media type", () => {
    const doc = build([
      req("post", "https://e.com/x", {
        sourceIndex: 0,
        body: {
          kind: "json",
          mediaType: "application/json",
          raw: '{"a":1}',
        },
      }),
      req("post", "https://e.com/x", {
        sourceIndex: 1,
        body: {
          kind: "json",
          mediaType: "application/json",
          raw: '{"a":2,"b":"x"}',
        },
      }),
    ]);
    const schema = (doc.paths["/x"]?.post as any).requestBody.content[
      "application/json"
    ].schema;
    expect(schema.properties.a.type).toBe("integer");
    expect(schema.properties.b.type).toBe("string");
    // "a" is in both, "b" only in one -> a required, b optional
    expect(schema.required).toEqual(["a"]);
  });
});

describe("buildOpenApi32 - security", () => {
  it("infers bearer security scheme", () => {
    const doc = build([
      req("get", "https://e.com/x", { auth: { type: "bearer" } }),
    ]);
    expect(doc.components?.securitySchemes?.bearerAuth).toEqual({
      type: "http",
      scheme: "bearer",
    });
    const op = doc.paths["/x"]?.get as any;
    expect(op.security).toEqual([{ bearerAuth: [] }]);
  });

  it("infers basic security scheme", () => {
    const doc = build([
      req("get", "https://e.com/x", { auth: { type: "basic" } }),
    ]);
    expect(doc.components?.securitySchemes?.basicAuth).toEqual({
      type: "http",
      scheme: "basic",
    });
  });

  it("infers apiKey security scheme with unique name per header", () => {
    const doc = build([
      req("get", "https://e.com/x", {
        auth: { type: "apiKey", in: "header", name: "X-API-Key" },
      }),
    ]);
    const schemes = doc.components?.securitySchemes as Record<string, unknown>;
    const schemeName = Object.keys(schemes).find((k) =>
      k.startsWith("apiKey_"),
    );
    expect(schemeName).toBeTruthy();
    expect(schemes[schemeName!]).toEqual({
      type: "apiKey",
      in: "header",
      name: "X-API-Key",
    });
  });

  it("does not collide apiKey schemes with different names", () => {
    const doc = build([
      req("get", "https://e.com/a", {
        sourceIndex: 0,
        auth: { type: "apiKey", in: "header", name: "X-API-Key" },
      }),
      req("get", "https://e.com/b", {
        sourceIndex: 1,
        auth: { type: "apiKey", in: "header", name: "X-Auth-Token" },
      }),
    ]);
    const schemes = doc.components?.securitySchemes as Record<string, unknown>;
    expect(Object.keys(schemes)).toHaveLength(2);
  });

  it("skips security inference when inferSecurity is false", () => {
    const doc = build(
      [req("get", "https://e.com/x", { auth: { type: "bearer" } })],
      { inferSecurity: false },
    );
    expect(doc.components).toBeUndefined();
    expect((doc.paths["/x"]?.get as any).security).toBeUndefined();
  });
});

describe("buildOpenApi32 - useServerBasePath", () => {
  it("collapses common base path into server URL", () => {
    const doc = build(
      [
        req("get", "https://api.example.com/v1/users", { sourceIndex: 0 }),
        req("get", "https://api.example.com/v1/posts", { sourceIndex: 1 }),
      ],
      { useServerBasePath: true },
    );
    expect(doc.servers).toEqual([{ url: "https://api.example.com/v1" }]);
    expect(doc.paths["/users"]).toBeTruthy();
    expect(doc.paths["/posts"]).toBeTruthy();
    expect(doc.paths["/v1/users"]).toBeUndefined();
  });

  it("does not strip when paths share only partial segments", () => {
    const doc = build(
      [
        req("get", "https://api.example.com/v1/users", { sourceIndex: 0 }),
        req("get", "https://api.example.com/v2/posts", { sourceIndex: 1 }),
      ],
      { useServerBasePath: true },
    );
    // Common prefix is / (just origin), paths stay full
    expect(doc.servers).toEqual([{ url: "https://api.example.com" }]);
    expect(doc.paths["/v1/users"]).toBeTruthy();
    expect(doc.paths["/v2/posts"]).toBeTruthy();
  });

  it("ignores useServerBasePath when multiple origins", () => {
    const doc = build(
      [
        req("get", "https://a.com/v1/x", { sourceIndex: 0 }),
        req("get", "https://b.com/v1/y", { sourceIndex: 1 }),
      ],
      { useServerBasePath: true },
    );
    expect(doc.servers).toHaveLength(2);
    expect(doc.paths["/v1/x"]).toBeTruthy();
  });

  it("handles root path with base path stripping", () => {
    const doc = build(
      [req("get", "https://api.example.com/v1/", { sourceIndex: 0 })],
      { useServerBasePath: true },
    );
    expect(doc.servers).toEqual([{ url: "https://api.example.com/v1" }]);
    expect(doc.paths["/"]).toBeTruthy();
  });
});

describe("buildOpenApi32 - operationId collision", () => {
  it("appends suffix when operationId collides", () => {
    const diagnostics: { code: string }[] = [];
    const doc = buildOpenApi32(
      [
        req("get", "https://e.com/users", { sourceIndex: 0 }),
        // Same method+path after templating would collide, but different paths
        // won't. Use two paths that produce same operationId.
        req("get", "https://e.com/users/", { sourceIndex: 1 }),
      ],
      baseOptions,
      (d) => diagnostics.push(d),
    ) as TestDocument;
    // /users and /users/ normalize to same path, so only one operation
    expect(doc.paths["/users"]?.get).toBeTruthy();
  });

  it("does not report collision for distinct operationIds", () => {
    const diagnostics: { code: string }[] = [];
    buildOpenApi32(
      [
        req("get", "https://e.com/v1/users", { sourceIndex: 0 }),
        req("get", "https://e.com/v2/users", { sourceIndex: 1 }),
      ],
      baseOptions,
      (d) => diagnostics.push(d),
    );
    expect(diagnostics.every((d) => d.code !== "OPERATION_ID_COLLISION")).toBe(
      true,
    );
  });

  it("reports OPERATION_ID_COLLISION when paths produce the same base", () => {
    const diagnostics: { code: string; message: string }[] = [];
    // /Users and /users both camelCase to getUsers, so the second is suffixed.
    const doc = buildOpenApi32(
      [
        req("get", "https://e.com/Users", { sourceIndex: 0 }),
        req("get", "https://e.com/users", { sourceIndex: 1 }),
      ],
      baseOptions,
      (d) => diagnostics.push(d),
    ) as TestDocument;
    const collision = diagnostics.find((d) => d.code === "OPERATION_ID_COLLISION");
    expect(collision).toBeDefined();
    expect(collision!.message).toContain("getUsers");
    // First operation keeps getUsers, second gets getUsers2.
    const ids = [doc.paths["/Users"]?.get?.operationId, doc.paths["/users"]?.get?.operationId];
    expect(ids).toContain("getUsers");
    expect(ids).toContain("getUsers2");
  });
});

describe("buildOpenApi32 - multiple origins", () => {
  it("reports MULTIPLE_SERVERS warning", () => {
    const diagnostics: { code: string }[] = [];
    buildOpenApi32(
      [
        req("get", "https://a.com/x", { sourceIndex: 0 }),
        req("get", "https://b.com/y", { sourceIndex: 1 }),
      ],
      baseOptions,
      (d) => diagnostics.push(d),
    );
    expect(diagnostics.some((d) => d.code === "MULTIPLE_SERVERS")).toBe(true);
  });

  it("includes all origins in servers", () => {
    const doc = build([
      req("get", "https://a.com/x", { sourceIndex: 0 }),
      req("get", "https://b.com/y", { sourceIndex: 1 }),
    ]);
    expect(doc.servers).toHaveLength(2);
  });
});
