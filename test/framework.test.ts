import { describe, expect, it } from "vitest";

import {
  ConversionError,
  CurlAdapter,
  curlToOpenApi,
  mergeSchemas,
  splitCurlCommands,
  XToOpenApi,
} from "../src/index.js";
import {
  availableExports,
  resolveBackend,
} from "../src/adapters/curl/index.js";
import { AdapterRegistry } from "../src/core/registry.js";
import { DiagnosticBag } from "../src/core/diagnostics.js";

const api = () => new XToOpenApi().register(new CurlAdapter());
const paths = (document: unknown) =>
  (document as { paths: Record<string, any> }).paths;

describe("x-to-openapi - framework", () => {
  it("has a usable curlconverter backend", () => {
    const backend = resolveBackend();
    expect(
      backend,
      `no curlconverter generator found; exports: ${availableExports().join(", ")}`,
    ).toBeTruthy();
  });

  it("reports a parse failure without throwing by default", async () => {
    const result = await api().convert("curl", "curl");
    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((d) => d.severity === "error")).toBe(true);
  });

  it("escalates errors to ConversionError in strict mode", async () => {
    await expect(
      api().convert("curl", "curl", { strict: true }),
    ).rejects.toThrow(ConversionError);
  });

  it("emits a valid 3.2 document", async () => {
    const result = await curlToOpenApi("curl https://e.com/x");
    expect(result.document.openapi).toBe("3.2.0");
    expect(result.ok).toBe(true);
    expect(result.documentValid).toBe(true);
  });

  it("merges methods on one path", async () => {
    const result = await api().convert("curl", [
      "curl https://e.com/users",
      "curl -X POST https://e.com/users",
    ]);
    expect(paths(result.document)["/users"].get).toBeTruthy();
    expect(paths(result.document)["/users"].post).toBeTruthy();
  });

  it("merges repeated samples instead of overwriting", async () => {
    const result = await api().convert("curl", [
      "curl 'https://e.com/s?q=a'",
      "curl 'https://e.com/s?page=2'",
    ]);
    const names = paths(result.document)["/s"].get.parameters.map(
      (p: any) => p.name,
    );
    expect(names).toEqual(expect.arrayContaining(["q", "page"]));
  });

  it("infers path parameters from uuids and names them semantically", async () => {
    const result = await api().convert("curl", [
      "curl https://e.com/users/3f1d9a2e-4b7c-4c1a-9d2e-8f6b1c0a7e51",
      "curl https://e.com/users/9a2e3f1d-7c4b-4a1c-8d2e-1c0a7e516f6b",
    ]);
    expect(paths(result.document)["/users/{userId}"]).toBeTruthy();
    expect(
      paths(result.document)["/users/{userId}"].get.parameters[0].schema.format,
    ).toBe("uuid");
  });

  it("treats repeated query keys as arrays", async () => {
    const result = await api().convert(
      "curl",
      "curl 'https://e.com/t?tag=a&tag=b'",
    );
    const tag = paths(result.document)["/t"].get.parameters.find(
      (p: any) => p.name === "tag",
    );
    expect(tag.schema.type).toBe("array");
    expect(tag.explode).toBe(true);
  });

  it("keeps media type honest for malformed JSON", async () => {
    const result = await api().convert(
      "curl",
      `curl -X POST https://e.com/x -H 'Content-Type: application/json' --data '{oops'`,
    );
    const content = paths(result.document)["/x"].post.requestBody.content;
    expect(content["application/json"]).toBeUndefined();
    expect(content["text/plain"].schema.type).toBe("string");
    expect(result.diagnostics.some((d) => d.code === "BODY_JSON_INVALID")).toBe(
      true,
    );
  });

  it("derives basic auth from -u", async () => {
    const result = await api().convert(
      "curl",
      "curl -u ada:lovelace https://e.com/x",
    );
    expect(
      (result.document as any).components.securitySchemes.basicAuth.scheme,
    ).toBe("basic");
  });

  it("drops HTTP/2 pseudo-headers", async () => {
    const result = await api().convert(
      "curl",
      `curl 'https://e.com/x' -H ':authority: e.com'`,
    );
    const parameters = paths(result.document)["/x"].get.parameters ?? [];
    expect(parameters.every((p: any) => !p.name.startsWith(":"))).toBe(true);
  });

  it("excludes cookies by default", async () => {
    const result = await api().convert(
      "curl",
      `curl https://e.com/x -H 'Cookie: sid=secret'`,
    );
    const parameters = paths(result.document)["/x"].get.parameters ?? [];
    expect(parameters.some((p: any) => p.in === "cookie")).toBe(false);
  });

  it("routes non-standard verbs to additionalOperations", async () => {
    const result = await api().convert("curl", "curl -X PURGE https://e.com/x");
    expect(
      paths(result.document)["/x"].additionalOperations.PURGE,
    ).toBeTruthy();
  });

  it("auto-detects the adapter", async () => {
    const result = await api().convert("auto", "curl https://e.com/x");
    expect(paths(result.document)["/x"].get).toBeTruthy();
  });

  it("throws when no adapter can handle auto input", async () => {
    await expect(api().convert("auto", 42)).rejects.toThrow(ConversionError);
  });

  it("splits multi-line and Windows-style batches", () => {
    expect(
      splitCurlCommands(
        "curl 'https://e.com/a' \\\n  -H 'X: 1'\ncurl.exe https://e.com/b",
      ),
    ).toHaveLength(2);
    expect(splitCurlCommands("$ curl https://e.com/a")[0]).toBe(
      "curl https://e.com/a",
    );
  });

  it("merges object samples with optional properties", () => {
    const merged = mergeSchemas([
      {
        type: "object",
        properties: { a: { type: "integer" } },
        required: ["a"],
      },
      {
        type: "object",
        properties: { a: { type: "integer" }, b: { type: "string" } },
        required: ["a", "b"],
      },
    ]);
    expect(merged.required).toEqual(["a"]);
    expect((merged.properties as any).b.type).toBe("string");
  });
});

describe("XToOpenApi - options validation", () => {
  it("rejects unsupported openapiVersion", async () => {
    await expect(
      api().convert("curl", "curl https://e.com/x", {
        openapiVersion: "3.1.0" as never,
      }),
    ).rejects.toThrow(/Unsupported openapiVersion/);
  });

  it("rejects non-positive pathParameterMinSamples", async () => {
    await expect(
      api().convert("curl", "curl https://e.com/x", {
        pathParameterMinSamples: 0,
      }),
    ).rejects.toThrow(/pathParameterMinSamples/);
  });

  it("rejects non-integer pathParameterMinSamples", async () => {
    await expect(
      api().convert("curl", "curl https://e.com/x", {
        pathParameterMinSamples: 1.5,
      }),
    ).rejects.toThrow(/pathParameterMinSamples/);
  });

  it("rejects empty title", async () => {
    await expect(
      api().convert("curl", "curl https://e.com/x", { title: "" }),
    ).rejects.toThrow(/title/);
  });

  it("rejects whitespace-only title", async () => {
    await expect(
      api().convert("curl", "curl https://e.com/x", { title: "   " }),
    ).rejects.toThrow(/title/);
  });

  it("accepts custom title and version", async () => {
    const result = await api().convert("curl", "curl https://e.com/x", {
      title: "My API",
      version: "2.0.0",
      description: "A test API",
    });
    expect(result.document.info.title).toBe("My API");
    expect(result.document.info.version).toBe("2.0.0");
    expect(result.document.info.description).toBe("A test API");
  });

  it("lists registered adapters", () => {
    expect(api().adapters()).toEqual(["curl"]);
  });

  it("throws for unknown adapter", async () => {
    await expect(api().convert("unknown", "curl https://e.com/x")).rejects.toThrow(
      /Unknown source adapter/,
    );
  });
});

describe("AdapterRegistry", () => {
  it("registers and retrieves an adapter", () => {
    const registry = new AdapterRegistry();
    const adapter = new CurlAdapter();
    registry.register(adapter);
    expect(registry.has("curl")).toBe(true);
    expect(registry.get("curl")).toBe(adapter);
  });

  it("rejects duplicate adapter ids", () => {
    const registry = new AdapterRegistry();
    registry.register(new CurlAdapter());
    expect(() => registry.register(new CurlAdapter())).toThrow(
      /Adapter already registered/,
    );
  });

  it("rejects invalid adapter id", () => {
    const registry = new AdapterRegistry();
    expect(() =>
      registry.register({ id: "Invalid-Id", parse: async () => [] }),
    ).toThrow(/Invalid adapter id/);
  });

  it("rejects adapter without parse function", () => {
    const registry = new AdapterRegistry();
    expect(() =>
      registry.register({ id: "bad" } as never),
    ).toThrow(/must implement parse/);
  });

  it("detects adapter via canHandle", () => {
    const registry = new AdapterRegistry();
    registry.register(new CurlAdapter());
    const detected = registry.detect("curl https://e.com/x");
    expect(detected?.id).toBe("curl");
  });

  it("returns undefined when no adapter matches", () => {
    const registry = new AdapterRegistry();
    registry.register(new CurlAdapter());
    expect(registry.detect(42)).toBeUndefined();
  });

  it("tolerates canHandle throwing", () => {
    const registry = new AdapterRegistry();
    registry.register({
      id: "thrower",
      canHandle: () => {
        throw new Error("boom");
      },
      parse: async () => [],
    });
    expect(registry.detect("anything")).toBeUndefined();
  });

  it("lists adapter ids", () => {
    const registry = new AdapterRegistry();
    registry.register(new CurlAdapter());
    expect(registry.ids()).toEqual(["curl"]);
  });
});

describe("DiagnosticBag", () => {
  it("collects diagnostics", () => {
    const bag = new DiagnosticBag();
    bag.report({
      code: "NO_REQUESTS",
      severity: "warning",
      message: "test",
    });
    expect(bag.items).toHaveLength(1);
    expect(bag.hasErrors()).toBe(false);
  });

  it("deduplicates identical diagnostics", () => {
    const bag = new DiagnosticBag();
    const d = { code: "NO_REQUESTS" as const, severity: "warning" as const, message: "test" };
    bag.report(d);
    bag.report(d);
    expect(bag.items).toHaveLength(1);
  });

  it("does not deduplicate different messages", () => {
    const bag = new DiagnosticBag();
    bag.report({ code: "NO_REQUESTS" as const, severity: "warning" as const, message: "a" });
    bag.report({ code: "NO_REQUESTS" as const, severity: "warning" as const, message: "b" });
    expect(bag.items).toHaveLength(2);
  });

  it("reports hasErrors when error severity present", () => {
    const bag = new DiagnosticBag();
    bag.report({ code: "CURL_PARSE_FAILED", severity: "error", message: "x" });
    expect(bag.hasErrors()).toBe(true);
  });

  it("throws ConversionError in strict mode on error", () => {
    const bag = new DiagnosticBag(true);
    expect(() =>
      bag.report({ code: "CURL_PARSE_FAILED", severity: "error", message: "x" }),
    ).toThrow(ConversionError);
  });

  it("does not throw in strict mode on warning", () => {
    const bag = new DiagnosticBag(true);
    expect(() =>
      bag.report({ code: "NO_REQUESTS", severity: "warning", message: "x" }),
    ).not.toThrow();
  });

  it("returns a copy of items", () => {
    const bag = new DiagnosticBag();
    bag.report({ code: "NO_REQUESTS", severity: "warning", message: "x" });
    const items = bag.items;
    items.push({ code: "NO_REQUESTS", severity: "warning", message: "y" });
    expect(bag.items).toHaveLength(1);
  });
});

describe("curlToOpenApi helper", () => {
  it("converts a single curl string", async () => {
    const result = await curlToOpenApi("curl https://e.com/x");
    expect(result.ok).toBe(true);
    expect(paths(result.document)["/x"]).toBeTruthy();
  });

  it("converts an array of curl strings", async () => {
    const result = await curlToOpenApi([
      "curl https://e.com/a",
      "curl https://e.com/b",
    ]);
    expect(paths(result.document)["/a"]).toBeTruthy();
    expect(paths(result.document)["/b"]).toBeTruthy();
  });

  it("passes options through", async () => {
    const result = await curlToOpenApi("curl https://e.com/x", {
      title: "Custom",
    });
    expect(result.document.info.title).toBe("Custom");
  });
});

describe("ConvertResult - serialization", () => {
  it("includes urlString for JSON serialization", async () => {
    const result = await curlToOpenApi("curl https://e.com/x");
    expect(result.requests[0]?.urlString).toBe("https://e.com/x");
  });

  it("result is JSON-serializable", async () => {
    const result = await curlToOpenApi("curl https://e.com/x");
    const json = JSON.stringify(result);
    expect(json).toContain("https://e.com/x");
    expect(json).toContain('"urlString"');
  });
});

describe("useServerBasePath integration", () => {
  it("collapses base path in full pipeline", async () => {
    const result = await api().convert(
      "curl",
      [
        "curl https://api.example.com/v1/users",
        "curl https://api.example.com/v1/posts",
      ],
      { useServerBasePath: true },
    );
    expect(result.document.servers).toEqual([
      { url: "https://api.example.com/v1" },
    ]);
    expect(paths(result.document)["/users"]).toBeTruthy();
    expect(paths(result.document)["/posts"]).toBeTruthy();
  });
});

describe("form-urlencoded integration", () => {
  it("produces object schema from form data", async () => {
    const result = await api().convert(
      "curl",
      `curl -X POST https://e.com/login -H 'Content-Type: application/x-www-form-urlencoded' --data 'username=ada&password=secret'`,
    );
    const schema = paths(result.document)["/login"].post.requestBody.content[
      "application/x-www-form-urlencoded"
    ].schema;
    expect(schema.type).toBe("object");
    expect(schema.properties.username.type).toBe("string");
    expect(schema.properties.password.type).toBe("string");
  });
});

describe("multipart integration", () => {
  it("produces binary schema for file fields", async () => {
    const result = await api().convert(
      "curl",
      `curl -X POST https://e.com/upload -F 'title=Hello' -F 'file=@photo.png'`,
    );
    const schema = paths(result.document)["/upload"].post.requestBody.content[
      "multipart/form-data"
    ].schema;
    expect(schema.properties.title.type).toBe("string");
    expect(schema.properties.file.type).toBe("string");
    expect(schema.properties.file.format).toBe("binary");
  });
});
