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

const api = () => new XToOpenApi().register(new CurlAdapter());
const paths = (document: unknown) =>
  (document as { paths: Record<string, any> }).paths;

describe("x-to-openapi", () => {
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

  it("throws a ConversionError in strict mode", async () => {
    await expect(
      api().convert("curl", "curl ://broken", { strict: true }),
    ).rejects.toThrow(/CURL_PARSE_FAILED|Invalid/);
  });

  it("auto-detects the adapter", async () => {
    const result = await api().convert("auto", "curl https://e.com/x");
    expect(paths(result.document)["/x"].get).toBeTruthy();
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
