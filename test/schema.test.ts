import { describe, expect, it } from "vitest";

import { jsonSchema, mergeSchemas, scalar } from "../src/openapi/schema.js";

describe("scalar - type inference", () => {
  it("infers boolean from true/false", () => {
    expect(scalar("true").type).toBe("boolean");
    expect(scalar("false").type).toBe("boolean");
    expect(scalar("TRUE").type).toBe("boolean");
  });

  it("infers uuid format", () => {
    const s = scalar("3f1d9a2e-4b7c-4c1a-9d2e-8f6b1c0a7e51");
    expect(s.type).toBe("string");
    expect(s.format).toBe("uuid");
  });

  it("infers date-time format", () => {
    const s = scalar("2024-01-15T10:30:00Z");
    expect(s.type).toBe("string");
    expect(s.format).toBe("date-time");
  });

  it("infers date format", () => {
    const s = scalar("2024-01-15");
    expect(s.type).toBe("string");
    expect(s.format).toBe("date");
  });

  it("infers integer from numeric string", () => {
    expect(scalar("42").type).toBe("integer");
    expect(scalar("-5").type).toBe("integer");
    expect(scalar("0").type).toBe("integer");
  });

  it("keeps leading-zero numbers as strings", () => {
    expect(scalar("007").type).toBe("string");
    expect(scalar("012345").type).toBe("string");
  });

  it("keeps long digit runs as strings (snowflake/phone)", () => {
    expect(scalar("1234567890123456789").type).toBe("string");
  });

  it("infers number from decimal string", () => {
    expect(scalar("3.14").type).toBe("number");
    expect(scalar("-0.5").type).toBe("number");
    expect(scalar("1e10").type).toBe("number");
  });

  it("defaults to string", () => {
    expect(scalar("hello").type).toBe("string");
    expect(scalar("").type).toBe("string");
  });

  it("includes example when includeExample is true", () => {
    const s = scalar("hello", true);
    expect(s.example).toBe("hello");
  });

  it("does not include example by default", () => {
    const s = scalar("hello");
    expect(s.example).toBeUndefined();
  });
});

describe("jsonSchema - from parsed JSON", () => {
  it("infers null", () => {
    expect(jsonSchema(null).type).toBe("null");
  });

  it("infers string", () => {
    expect(jsonSchema("hello").type).toBe("string");
  });

  it("infers integer", () => {
    expect(jsonSchema(42).type).toBe("integer");
  });

  it("infers number", () => {
    expect(jsonSchema(3.14).type).toBe("number");
  });

  it("infers boolean", () => {
    expect(jsonSchema(true).type).toBe("boolean");
  });

  it("infers empty array", () => {
    const s = jsonSchema([]);
    expect(s.type).toBe("array");
    expect(s.items).toEqual({});
  });

  it("infers array of strings", () => {
    const s = jsonSchema(["a", "b", "c"]);
    expect(s.type).toBe("array");
    expect(s.items!.type).toBe("string");
  });

  it("infers array of mixed types", () => {
    const s = jsonSchema([1, "two", true]);
    expect(s.type).toBe("array");
    expect(s.items!.type).toEqual(["integer", "string", "boolean"]);
  });

  it("infers object with properties", () => {
    const s = jsonSchema({ name: "Ada", age: 36 });
    expect(s.type).toBe("object");
    expect(s.properties!.name.type).toBe("string");
    expect(s.properties!.age.type).toBe("integer");
    expect(s.required).toEqual(["name", "age"]);
  });

  it("infers empty object", () => {
    const s = jsonSchema({});
    expect(s.type).toBe("object");
    expect(s.properties).toEqual({});
    expect(s.required).toBeUndefined();
  });

  it("infers nested objects", () => {
    const s = jsonSchema({ user: { name: "Ada", roles: ["admin"] } });
    expect(s.properties!.user.type).toBe("object");
    expect(s.properties!.user.properties!.name.type).toBe("string");
    expect(s.properties!.user.properties!.roles.type).toBe("array");
  });

  it("includes examples when includeExample is true", () => {
    const s = jsonSchema({ name: "Ada" }, true);
    expect(s.properties!.name.example).toBe("Ada");
  });
});

describe("mergeSchemas - object merging", () => {
  it("returns empty schema for empty input", () => {
    expect(mergeSchemas([])).toEqual({});
  });

  it("returns a copy for single schema", () => {
    const original = { type: "string" };
    const merged = mergeSchemas([original]);
    expect(merged).toEqual(original);
    expect(merged).not.toBe(original);
  });

  it("unions object properties", () => {
    const merged = mergeSchemas([
      { type: "object", properties: { a: { type: "integer" } }, required: ["a"] },
      {
        type: "object",
        properties: { a: { type: "integer" }, b: { type: "string" } },
        required: ["a", "b"],
      },
    ]);
    expect(merged.properties!.a.type).toBe("integer");
    expect(merged.properties!.b.type).toBe("string");
  });

  it("marks property required only when present in all samples", () => {
    const merged = mergeSchemas([
      { type: "object", properties: { a: { type: "integer" } }, required: ["a"] },
      {
        type: "object",
        properties: { a: { type: "integer" }, b: { type: "string" } },
        required: ["a", "b"],
      },
    ]);
    expect(merged.required).toEqual(["a"]);
  });

  it("recursively merges nested objects", () => {
    const merged = mergeSchemas([
      {
        type: "object",
        properties: { user: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
        required: ["user"],
      },
      {
        type: "object",
        properties: {
          user: {
            type: "object",
            properties: { name: { type: "string" }, age: { type: "integer" } },
            required: ["name", "age"],
          },
        },
        required: ["user"],
      },
    ]);
    expect(merged.properties!.user.properties!.name.type).toBe("string");
    expect(merged.properties!.user.properties!.age.type).toBe("integer");
    expect(merged.properties!.user.required).toEqual(["name"]);
  });
});

describe("mergeSchemas - array merging", () => {
  it("merges array item schemas", () => {
    const merged = mergeSchemas([
      { type: "array", items: { type: "string" } },
      { type: "array", items: { type: "integer" } },
    ]);
    expect(merged.type).toBe("array");
    expect(merged.items!.type).toEqual(["string", "integer"]);
  });
});

describe("mergeSchemas - scalar merging", () => {
  it("widens integer to number when mixed", () => {
    const merged = mergeSchemas([
      { type: "integer" },
      { type: "number" },
    ]);
    expect(merged.type).toBe("number");
  });

  it("produces type array for mixed string/integer", () => {
    const merged = mergeSchemas([
      { type: "string" },
      { type: "integer" },
    ]);
    expect(merged.type).toEqual(["string", "integer"]);
  });

  it("keeps format only when all samples agree", () => {
    const merged = mergeSchemas([
      { type: "string", format: "uuid" },
      { type: "string", format: "uuid" },
    ]);
    expect(merged.format).toBe("uuid");
  });

  it("drops format when samples disagree", () => {
    const merged = mergeSchemas([
      { type: "string", format: "uuid" },
      { type: "string" },
    ]);
    expect(merged.format).toBeUndefined();
  });

  it("handles schemas with type as array", () => {
    const merged = mergeSchemas([
      { type: ["string", "null"] },
      { type: "string" },
    ]);
    expect(merged.type).toEqual(["string", "null"]);
  });
});
