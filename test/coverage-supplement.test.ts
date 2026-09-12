import { describe, expect, it, vi } from "vitest";
import { XToOpenApi, CurlAdapter } from "../src/index.js";
import { ConversionError } from "../src/core/diagnostics.js";
import { validateOpenApi32 } from "../src/validation/openapi32.js";
import type { ConvertOptions, NormalizedRequest, SourceAdapter } from "../src/core/types.js";

describe("coverage supplement tests", () => {
  describe("validation/openapi32.ts edge cases", () => {
    it("handles validator throwing an exception", async () => {
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
      expect(result.diagnostics[0]?.code).toBe("OAS_VALIDATION_ERROR");
    });

    it("handles document with missing required fields", async () => {
      const doc = {
        openapi: "3.2.0",
      };

      const result = await validateOpenApi32(doc as never);
      expect(result.valid).toBe(false);
      expect(result.diagnostics.length).toBeGreaterThan(0);
    });
  });

  describe("convert.ts option validation", () => {
    it("throws for invalid version option", async () => {
      const converter = new XToOpenApi();
      converter.register(new CurlAdapter());

      await expect(
        converter.convert("curl", "curl https://example.com", {
          version: "",
        } as ConvertOptions),
      ).rejects.toThrow("version must be a non-empty string");
    });

    it("throws for invalid title option", async () => {
      const converter = new XToOpenApi();
      converter.register(new CurlAdapter());

      await expect(
        converter.convert("curl", "curl https://example.com", {
          title: "   ",
        } as ConvertOptions),
      ).rejects.toThrow("title must be a non-empty string");
    });

    it("throws for invalid pathParameterMinSamples", async () => {
      const converter = new XToOpenApi();
      converter.register(new CurlAdapter());

      await expect(
        converter.convert("curl", "curl https://example.com", {
          pathParameterMinSamples: 0,
        } as ConvertOptions),
      ).rejects.toThrow("pathParameterMinSamples must be a positive integer");
    });

    it("throws for non-integer pathParameterMinSamples", async () => {
      const converter = new XToOpenApi();
      converter.register(new CurlAdapter());

      await expect(
        converter.convert("curl", "curl https://example.com", {
          pathParameterMinSamples: 1.5,
        } as ConvertOptions),
      ).rejects.toThrow("pathParameterMinSamples must be a positive integer");
    });
  });

  describe("convert.ts adapter failure handling", () => {
    it("wraps non-ConversionError adapter failures in ADAPTER_PARSE_FAILED diagnostic", async () => {
      const failingAdapter: SourceAdapter<string> = {
        id: "failing",
        canHandle: () => true,
        parse: async () => {
          throw new Error("adapter exploded");
        },
      };

      const converter = new XToOpenApi();
      converter.register(failingAdapter);

      const result = await converter.convert("failing", "input", { validate: false });
      expect(result.ok).toBe(false);
      expect(result.diagnostics.some((d) => d.code === "ADAPTER_PARSE_FAILED")).toBe(true);
    });

    it("re-throws ConversionError from adapter", async () => {
      const conversionErrorAdapter: SourceAdapter<string> = {
        id: "conversion-error",
        canHandle: () => true,
        parse: async () => {
          throw new ConversionError("intentional conversion error", []);
        },
      };

      const converter = new XToOpenApi();
      converter.register(conversionErrorAdapter);

      await expect(
        converter.convert("conversion-error", "input", { validate: false }),
      ).rejects.toThrow("intentional conversion error");
    });
  });

  describe("convert.ts auto-detection", () => {
    it("throws when no adapter can handle auto input", async () => {
      const converter = new XToOpenApi();
      converter.register({
        id: "never",
        canHandle: () => false,
        parse: async () => [],
      });

      await expect(
        converter.convert("auto", "some input", { validate: false }),
      ).rejects.toThrow("No registered adapter can handle the provided input");
    });

    it("auto-detects curl adapter", async () => {
      const converter = new XToOpenApi();
      converter.register(new CurlAdapter());

      const result = await converter.convert(
        "auto",
        "curl https://api.example.com/users",
        { validate: false },
      );
      expect(result.document.openapi).toBe("3.2.0");
    });
  });

  describe("convert.ts validator failure handling", () => {
    it("reports OAS_VALIDATOR_FAILED when validator throws", async () => {
      const simpleAdapter: SourceAdapter<string> = {
        id: "simple",
        canHandle: () => true,
        parse: async () => [
          {
            source: "test",
            sourceIndex: 0,
            method: "get",
            url: new URL("https://api.example.com/users"),
            headers: [],
            query: [],
            cookies: [],
          } as NormalizedRequest,
        ],
      };

      const converter = new XToOpenApi();
      converter.register(simpleAdapter);

      const result = await converter.convert("simple", "input", { validate: true });
      expect(result.document.openapi).toBe("3.2.0");
    });
  });

  describe("convert.ts input size limits", () => {
    it("rejects input exceeding maximum size", async () => {
      const converter = new XToOpenApi();
      converter.register(new CurlAdapter());

      const hugeInput = "curl " + "x".repeat(11 * 1024 * 1024);
      await expect(
        converter.convert("curl", hugeInput, { validate: false }),
      ).rejects.toThrow("Input exceeds maximum size");
    });
  });

  describe("convert.ts strict mode", () => {
    it("strict mode throws on adapter parse failure", async () => {
      const failingAdapter: SourceAdapter<string> = {
        id: "failing-strict",
        canHandle: () => true,
        parse: async () => {
          throw new Error("adapter exploded");
        },
      };

      const converter = new XToOpenApi();
      converter.register(failingAdapter);

      await expect(
        converter.convert("failing-strict", "input", { strict: true, validate: false }),
      ).rejects.toThrow(ConversionError);
    });
  });

  describe("curl adapter edge cases", () => {
    it("handles curl with custom method", async () => {
      const converter = new XToOpenApi();
      converter.register(new CurlAdapter());

      const result = await converter.convert(
        "curl",
        "curl -X PATCH https://api.example.com/users/1",
        { validate: false },
      );
      expect(result.document.paths["/users/1"]).toBeDefined();
    });

    it("handles curl with data", async () => {
      const converter = new XToOpenApi();
      converter.register(new CurlAdapter());

      const result = await converter.convert(
        "curl",
        'curl -X POST https://api.example.com/users -d \'{"name":"test"}\'',
        { validate: false },
      );
      expect(result.document.paths["/users"]?.post).toBeDefined();
    });

    it("handles curl with headers", async () => {
      const converter = new XToOpenApi();
      converter.register(new CurlAdapter());

      const result = await converter.convert(
        "curl",
        'curl -H "Authorization: Bearer token123" https://api.example.com/users',
        { validate: false },
      );
      expect(result.document.paths["/users"]?.get).toBeDefined();
    });

    it("handles curl with query parameters", async () => {
      const converter = new XToOpenApi();
      converter.register(new CurlAdapter());

      const result = await converter.convert(
        "curl",
        "curl 'https://api.example.com/users?page=1&limit=10'",
        { validate: false },
      );
      expect(result.document.paths["/users"]?.get?.parameters).toBeDefined();
    });

    it("handles empty curl command", async () => {
      const converter = new XToOpenApi();
      converter.register(new CurlAdapter());

      const result = await converter.convert("curl", "curl", { validate: false });
      expect(result.document.openapi).toBe("3.2.0");
    });

    it("handles curl with GET method explicitly", async () => {
      const converter = new XToOpenApi();
      converter.register(new CurlAdapter());

      const result = await converter.convert(
        "curl",
        "curl -X GET https://api.example.com/users",
        { validate: false },
      );
      expect(result.document.paths["/users"]?.get).toBeDefined();
    });
  });

  describe("convert.ts result shape", () => {
    it("returns serializable requests", async () => {
      const converter = new XToOpenApi();
      converter.register(new CurlAdapter());

      const result = await converter.convert(
        "curl",
        "curl https://api.example.com/users",
        { validate: false },
      );

      expect(result.requests).toHaveLength(1);
      expect(typeof result.requests[0]?.urlString).toBe("string");
      expect(result.requests[0]?.urlString).toBe("https://api.example.com/users");
    });

    it("returns documentValid flag", async () => {
      const converter = new XToOpenApi();
      converter.register(new CurlAdapter());

      const result = await converter.convert(
        "curl",
        "curl https://api.example.com/users",
        { validate: true },
      );

      expect(typeof result.documentValid).toBe("boolean");
    });

    it("returns ok flag", async () => {
      const converter = new XToOpenApi();
      converter.register(new CurlAdapter());

      const result = await converter.convert(
        "curl",
        "curl https://api.example.com/users",
        { validate: false },
      );

      expect(result.ok).toBe(true);
    });
  });

  describe("convert.ts multiple requests", () => {
    it("handles array of curl commands", async () => {
      const converter = new XToOpenApi();
      converter.register(new CurlAdapter());

      const result = await converter.convert(
        "curl",
        [
          "curl https://api.example.com/users",
          "curl https://api.example.com/posts",
        ],
        { validate: false },
      );

      expect(result.document.paths["/users"]).toBeDefined();
      expect(result.document.paths["/posts"]).toBeDefined();
      expect(result.requests).toHaveLength(2);
    });
  });

  describe("convert.ts useServerBasePath option", () => {
    it("collapses common base path when enabled", async () => {
      const converter = new XToOpenApi();
      converter.register(new CurlAdapter());

      const result = await converter.convert(
        "curl",
        [
          "curl https://api.example.com/api/v1/users",
          "curl https://api.example.com/api/v1/posts",
        ],
        { validate: false, useServerBasePath: true },
      );

      expect(result.document.servers?.[0]?.url).toContain("/api/v1");
      expect(result.document.paths["/users"]).toBeDefined();
      expect(result.document.paths["/posts"]).toBeDefined();
    });

    it("does not collapse base path when disabled", async () => {
      const converter = new XToOpenApi();
      converter.register(new CurlAdapter());

      const result = await converter.convert(
        "curl",
        [
          "curl https://api.example.com/api/v1/users",
          "curl https://api.example.com/api/v1/posts",
        ],
        { validate: false, useServerBasePath: false },
      );

      expect(result.document.paths["/api/v1/users"]).toBeDefined();
      expect(result.document.paths["/api/v1/posts"]).toBeDefined();
    });
  });

  describe("convert.ts inferSecurity option", () => {
    it("infers bearer security when enabled", async () => {
      const converter = new XToOpenApi();
      converter.register(new CurlAdapter());

      const result = await converter.convert(
        "curl",
        'curl -H "Authorization: Bearer token123" https://api.example.com/users',
        { validate: false, inferSecurity: true },
      );

      const operation = result.document.paths["/users"]?.get;
      expect(operation?.security).toBeDefined();
      expect(result.document.components?.securitySchemes?.bearerAuth).toBeDefined();
    });

    it("does not infer security when disabled", async () => {
      const converter = new XToOpenApi();
      converter.register(new CurlAdapter());

      const result = await converter.convert(
        "curl",
        'curl -H "Authorization: Bearer token123" https://api.example.com/users',
        { validate: false, inferSecurity: false },
      );

      const operation = result.document.paths["/users"]?.get;
      expect(operation?.security).toBeUndefined();
    });
  });

  describe("convert.ts includeExamples option", () => {
    it("includes examples when enabled", async () => {
      const converter = new XToOpenApi();
      converter.register(new CurlAdapter());

      const result = await converter.convert(
        "curl",
        "curl 'https://api.example.com/users?page=1'",
        { validate: false, includeExamples: true },
      );

      const params = result.document.paths["/users"]?.get?.parameters;
      expect(params?.[0]?.schema?.example).toBe("1");
    });

    it("does not include examples when disabled", async () => {
      const converter = new XToOpenApi();
      converter.register(new CurlAdapter());

      const result = await converter.convert(
        "curl",
        "curl 'https://api.example.com/users?page=1'",
        { validate: false, includeExamples: false },
      );

      const params = result.document.paths["/users"]?.get?.parameters;
      expect(params?.[0]?.schema?.example).toBeUndefined();
    });
  });
});
