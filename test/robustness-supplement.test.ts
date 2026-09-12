import { describe, expect, it } from "vitest";
import { XToOpenApi, CurlAdapter, PostmanAdapter } from "../src/index.js";
import { AdapterRegistry } from "../src/core/registry.js";
import { ConversionError, DiagnosticBag } from "../src/core/diagnostics.js";
import { buildOpenApi32 } from "../src/openapi/builder.js";
import { scalar, jsonSchema, mergeSchemas } from "../src/openapi/schema.js";
import { validateOpenApi32 } from "../src/validation/openapi32.js";
import type { NormalizedRequest, ResolvedConvertOptions } from "../src/core/types.js";

describe("dual-module and robustness supplement tests", () => {
  describe("module exports", () => {
    it("exports XToOpenApi class", () => {
      expect(typeof XToOpenApi).toBe("function");
    });

    it("exports CurlAdapter class", () => {
      expect(typeof CurlAdapter).toBe("function");
    });

    it("exports PostmanAdapter class", () => {
      expect(typeof PostmanAdapter).toBe("function");
    });

    it("exports AdapterRegistry class", () => {
      expect(typeof AdapterRegistry).toBe("function");
    });

    it("exports ConversionError class", () => {
      expect(typeof ConversionError).toBe("function");
    });

    it("exports DiagnosticBag class", () => {
      expect(typeof DiagnosticBag).toBe("function");
    });

    it("exports buildOpenApi32 function", () => {
      expect(typeof buildOpenApi32).toBe("function");
    });

    it("exports scalar function", () => {
      expect(typeof scalar).toBe("function");
    });

    it("exports jsonSchema function", () => {
      expect(typeof jsonSchema).toBe("function");
    });

    it("exports mergeSchemas function", () => {
      expect(typeof mergeSchemas).toBe("function");
    });

    it("exports validateOpenApi32 function", () => {
      expect(typeof validateOpenApi32).toBe("function");
    });
  });

  describe("AdapterRegistry robustness", () => {
    it("throws for null adapter", () => {
      const registry = new AdapterRegistry();
      expect(() => registry.register(null as never)).toThrow(TypeError);
    });

    it("throws for non-object adapter", () => {
      const registry = new AdapterRegistry();
      expect(() => registry.register("string" as never)).toThrow(TypeError);
    });

    it("throws for invalid adapter id", () => {
      const registry = new AdapterRegistry();
      expect(() =>
        registry.register({ id: "Invalid ID", parse: async () => [] } as never),
      ).toThrow(TypeError);
    });

    it("throws for adapter without parse function", () => {
      const registry = new AdapterRegistry();
      expect(() =>
        registry.register({ id: "test" } as never),
      ).toThrow(TypeError);
    });

    it("throws for duplicate adapter registration", () => {
      const registry = new AdapterRegistry();
      const adapter = { id: "test", parse: async () => [] };
      registry.register(adapter);
      expect(() => registry.register(adapter)).toThrow("already registered");
    });

    it("throws for unknown adapter", () => {
      const registry = new AdapterRegistry();
      expect(() => registry.get("unknown")).toThrow("Unknown source adapter");
    });

    it("has() returns correct values", () => {
      const registry = new AdapterRegistry();
      expect(registry.has("test")).toBe(false);
      registry.register({ id: "test", parse: async () => [] });
      expect(registry.has("test")).toBe(true);
    });

    it("ids() returns registered adapter ids", () => {
      const registry = new AdapterRegistry();
      registry.register({ id: "a", parse: async () => [] });
      registry.register({ id: "b", parse: async () => [] });
      expect(registry.ids()).toEqual(["a", "b"]);
    });

    it("detect() returns undefined when no adapter can handle", () => {
      const registry = new AdapterRegistry();
      registry.register({
        id: "test",
        canHandle: () => false,
        parse: async () => [],
      });
      expect(registry.detect("input")).toBeUndefined();
    });

    it("detect() ignores adapters whose canHandle throws", () => {
      const registry = new AdapterRegistry();
      registry.register({
        id: "throwing",
        canHandle: () => {
          throw new Error("boom");
        },
        parse: async () => [],
      });
      registry.register({
        id: "working",
        canHandle: () => true,
        parse: async () => [],
      });
      const detected = registry.detect("input");
      expect(detected?.id).toBe("working");
    });
  });

  describe("DiagnosticBag robustness", () => {
    it("deduplicates identical diagnostics", () => {
      const bag = new DiagnosticBag();
      const diagnostic = {
        code: "TEST_ERROR" as const,
        severity: "error" as const,
        message: "test message",
      };
      bag.report(diagnostic);
      bag.report(diagnostic);
      expect(bag.items).toHaveLength(1);
    });

    it("does not deduplicate different diagnostics", () => {
      const bag = new DiagnosticBag();
      bag.report({
        code: "ERROR_1" as const,
        severity: "error" as const,
        message: "first",
      });
      bag.report({
        code: "ERROR_2" as const,
        severity: "error" as const,
        message: "second",
      });
      expect(bag.items).toHaveLength(2);
    });

    it("hasErrors() returns true when error present", () => {
      const bag = new DiagnosticBag();
      expect(bag.hasErrors()).toBe(false);
      bag.report({
        code: "TEST" as const,
        severity: "error" as const,
        message: "error",
      });
      expect(bag.hasErrors()).toBe(true);
    });

    it("hasErrors() returns false for warnings only", () => {
      const bag = new DiagnosticBag();
      bag.report({
        code: "TEST" as const,
        severity: "warning" as const,
        message: "warning",
      });
      expect(bag.hasErrors()).toBe(false);
    });

    it("strict mode throws on error", () => {
      const bag = new DiagnosticBag(true);
      expect(() =>
        bag.report({
          code: "TEST" as const,
          severity: "error" as const,
          message: "error",
        }),
      ).toThrow(ConversionError);
    });

    it("strict mode does not throw on warning", () => {
      const bag = new DiagnosticBag(true);
      expect(() =>
        bag.report({
          code: "TEST" as const,
          severity: "warning" as const,
          message: "warning",
        }),
      ).not.toThrow();
    });

    it("items returns a copy", () => {
      const bag = new DiagnosticBag();
      bag.report({
        code: "TEST" as const,
        severity: "info" as const,
        message: "info",
      });
      const items = bag.items;
      items.push({ code: "FAKE" as const, severity: "error" as const, message: "fake" });
      expect(bag.items).toHaveLength(1);
    });
  });

  describe("ConversionError", () => {
    it("has correct name", () => {
      const error = new ConversionError("test", []);
      expect(error.name).toBe("ConversionError");
    });

    it("stores diagnostics", () => {
      const diagnostics = [
        { code: "TEST" as const, severity: "error" as const, message: "test" },
      ];
      const error = new ConversionError("test", diagnostics);
      expect(error.diagnostics).toEqual(diagnostics);
    });

    it("supports cause option", () => {
      const cause = new Error("root cause");
      const error = new ConversionError("test", [], { cause });
      expect(error.cause).toBe(cause);
    });
  });

  describe("scalar() edge cases", () => {
    it("detects boolean true", () => {
      expect(scalar("true").type).toBe("boolean");
    });

    it("detects boolean false", () => {
      expect(scalar("false").type).toBe("boolean");
    });

    it("detects UUID", () => {
      expect(scalar("550e8400-e29b-41d4-a716-446655440000").format).toBe("uuid");
    });

    it("detects date-time", () => {
      expect(scalar("2024-01-15T10:30:00Z").format).toBe("date-time");
    });

    it("detects date", () => {
      expect(scalar("2024-01-15").format).toBe("date");
    });

    it("detects integer", () => {
      expect(scalar("12345").type).toBe("integer");
    });

    it("keeps long integers as string (snowflake IDs)", () => {
      expect(scalar("12345678901234567890").type).toBe("string");
    });

    it("keeps leading zero numbers as string", () => {
      expect(scalar("007").type).toBe("string");
    });

    it("detects number", () => {
      expect(scalar("3.14").type).toBe("number");
    });

    it("defaults to string", () => {
      expect(scalar("hello world").type).toBe("string");
    });

    it("includes example when requested", () => {
      const result = scalar("hello", true);
      expect(result.example).toBe("hello");
    });

    it("does not include example by default", () => {
      const result = scalar("hello");
      expect(result.example).toBeUndefined();
    });
  });

  describe("jsonSchema() edge cases", () => {
    it("handles null", () => {
      expect(jsonSchema(null).type).toBe("null");
    });

    it("handles empty array", () => {
      const result = jsonSchema([]);
      expect(result.type).toBe("array");
      expect(result.items).toEqual({});
    });

    it("handles array with items", () => {
      const result = jsonSchema([1, 2, 3]);
      expect(result.type).toBe("array");
      expect(result.items?.type).toBe("integer");
    });

    it("handles empty object", () => {
      const result = jsonSchema({});
      expect(result.type).toBe("object");
      expect(result.required).toBeUndefined();
    });

    it("handles object with properties", () => {
      const result = jsonSchema({ name: "test", age: 25 });
      expect(result.type).toBe("object");
      expect(result.properties?.name.type).toBe("string");
      expect(result.properties?.age.type).toBe("integer");
      expect(result.required).toEqual(["name", "age"]);
    });

    it("handles integer", () => {
      expect(jsonSchema(42).type).toBe("integer");
    });

    it("handles number", () => {
      expect(jsonSchema(3.14).type).toBe("number");
    });

    it("handles boolean", () => {
      expect(jsonSchema(true).type).toBe("boolean");
    });

    it("handles string", () => {
      expect(jsonSchema("hello").type).toBe("string");
    });

    it("includes example for string when requested", () => {
      const result = jsonSchema("hello", true);
      expect(result.example).toBe("hello");
    });

    it("includes example for number when requested", () => {
      const result = jsonSchema(42, true);
      expect(result.example).toBe(42);
    });
  });

  describe("mergeSchemas() edge cases", () => {
    it("returns empty object for empty input", () => {
      expect(mergeSchemas([])).toEqual({});
    });

    it("returns copy for single schema", () => {
      const schema = { type: "string" };
      const result = mergeSchemas([schema]);
      expect(result).toEqual(schema);
      expect(result).not.toBe(schema);
    });

    it("merges object properties", () => {
      const result = mergeSchemas([
        { type: "object", properties: { a: { type: "string" } } },
        { type: "object", properties: { b: { type: "integer" } } },
      ]);
      expect(result.type).toBe("object");
      expect(result.properties?.a.type).toBe("string");
      expect(result.properties?.b.type).toBe("integer");
    });

    it("makes missing properties optional", () => {
      const result = mergeSchemas([
        { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
        { type: "object", properties: { a: { type: "string" }, b: { type: "integer" } }, required: ["a", "b"] },
      ]);
      expect(result.required).toEqual(["a"]);
    });

    it("merges array items", () => {
      const result = mergeSchemas([
        { type: "array", items: { type: "string" } },
        { type: "array", items: { type: "integer" } },
      ]);
      expect(result.type).toBe("array");
      expect(result.items?.type).toEqual(["string", "integer"]);
    });

    it("widens integer to number", () => {
      const result = mergeSchemas([
        { type: "integer" },
        { type: "number" },
      ]);
      expect(result.type).toBe("number");
    });

    it("keeps format when all same", () => {
      const result = mergeSchemas([
        { type: "string", format: "uuid" },
        { type: "string", format: "uuid" },
      ]);
      expect(result.format).toBe("uuid");
    });

    it("drops format when different", () => {
      const result = mergeSchemas([
        { type: "string", format: "uuid" },
        { type: "string", format: "email" },
      ]);
      expect(result.format).toBeUndefined();
    });
  });

  describe("buildOpenApi32() edge cases", () => {
    const baseOptions: ResolvedConvertOptions = {
      openapiVersion: "3.2.0",
      title: "Test API",
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

    it("handles empty requests", () => {
      const report = () => {};
      const result = buildOpenApi32([], baseOptions, report);
      expect(result.openapi).toBe("3.2.0");
      expect(result.paths).toEqual({});
    });

    it("generates correct openapi version", () => {
      const report = () => {};
      const request = {
        source: "test",
        sourceIndex: 0,
        method: "get",
        url: new URL("https://api.example.com/users"),
        headers: [],
        query: [],
        cookies: [],
      } as NormalizedRequest;
      const result = buildOpenApi32([request], baseOptions, report);
      expect(result.openapi).toBe("3.2.0");
    });

    it("includes servers from origins", () => {
      const report = () => {};
      const request = {
        source: "test",
        sourceIndex: 0,
        method: "get",
        url: new URL("https://api.example.com/users"),
        headers: [],
        query: [],
        cookies: [],
      } as NormalizedRequest;
      const result = buildOpenApi32([request], baseOptions, report);
      expect(result.servers).toEqual([{ url: "https://api.example.com" }]);
    });

    it("handles non-standard HTTP methods", () => {
      const report = () => {};
      const request = {
        source: "test",
        sourceIndex: 0,
        method: "purge",
        url: new URL("https://api.example.com/cache"),
        headers: [],
        query: [],
        cookies: [],
      } as NormalizedRequest;
      const result = buildOpenApi32([request], baseOptions, report);
      const pathItem = result.paths["/cache"] as Record<string, unknown>;
      expect(pathItem.additionalOperations).toBeDefined();
    });
  });

  describe("validateOpenApi32()", () => {
    it("validates a minimal valid document", async () => {
      const doc = {
        openapi: "3.2.0",
        info: { title: "Test", version: "1.0.0" },
        paths: {},
      };
      const result = await validateOpenApi32(doc as never);
      expect(typeof result.valid).toBe("boolean");
      expect(Array.isArray(result.diagnostics)).toBe(true);
    });

    it("returns diagnostics for invalid document", async () => {
      const doc = {
        openapi: "3.2.0",
        info: {},
        paths: {},
      };
      const result = await validateOpenApi32(doc as never);
      expect(result.diagnostics.length).toBeGreaterThan(0);
    });
  });

  describe("XToOpenApi integration", () => {
    it("registers and lists adapters", () => {
      const converter = new XToOpenApi();
      converter.register(new CurlAdapter());
      expect(converter.adapters()).toContain("curl");
    });

    it("throws for unknown adapter", async () => {
      const converter = new XToOpenApi();
      await expect(
        converter.convert("unknown", "input", {}),
      ).rejects.toThrow("Unknown source adapter");
    });

    it("rejects input exceeding max size", async () => {
      const converter = new XToOpenApi();
      converter.register(new CurlAdapter());
      const hugeInput = "x".repeat(11 * 1024 * 1024);
      await expect(
        converter.convert("curl", hugeInput, {}),
      ).rejects.toThrow("exceeds maximum size");
    });
  });

  describe("zero-config helpers", () => {
    it("curlToOpenApi converts a simple curl command", async () => {
      const { curlToOpenApi } = await import("../src/index.js");
      const result = await curlToOpenApi("curl https://api.example.com/users");
      expect(result.document.openapi).toBe("3.2.0");
      expect(result.ok).toBe(true);
    });

    it("postmanToOpenApi converts a simple collection", async () => {
      const { postmanToOpenApi } = await import("../src/index.js");
      const collection = {
        info: { name: "Test API", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
        item: [
          {
            name: "Get Users",
            request: {
              method: "GET",
              url: { raw: "https://api.example.com/users" },
            },
          },
        ],
      };
      const result = await postmanToOpenApi(collection);
      expect(result.document.openapi).toBe("3.2.0");
      expect(result.ok).toBe(true);
    });
  });
});
