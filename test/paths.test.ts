import { describe, expect, it } from "vitest";

import { buildPathTemplates, looksLikeIdentifier } from "../src/openapi/paths.js";
import type { NormalizedRequest } from "../src/core/types.js";

function req(pathname: string, method = "get", origin = "https://e.com"): NormalizedRequest {
  return {
    source: "test",
    sourceIndex: 0,
    method,
    url: new URL(origin + pathname),
    headers: [],
    query: [],
    cookies: [],
  };
}

describe("looksLikeIdentifier", () => {
  it("matches numeric segments", () => {
    expect(looksLikeIdentifier("123")).toBe(true);
    expect(looksLikeIdentifier("0")).toBe(true);
    expect(looksLikeIdentifier("999999")).toBe(true);
  });

  it("matches UUIDs", () => {
    expect(
      looksLikeIdentifier("3f1d9a2e-4b7c-4c1a-9d2e-8f6b1c0a7e51"),
    ).toBe(true);
  });

  it("matches ULIDs", () => {
    expect(looksLikeIdentifier("01ARZ3NDEKTSV4RRFFQ69G5FAV")).toBe(true);
  });

  it("matches long hex strings", () => {
    expect(looksLikeIdentifier("deadbeef")).toBe(true);
    expect(looksLikeIdentifier("a1b2c3d4e5f6")).toBe(true);
  });

  it("rejects plain words", () => {
    expect(looksLikeIdentifier("users")).toBe(false);
    expect(looksLikeIdentifier("admin")).toBe(false);
  });

  it("rejects short hex (< 8 chars)", () => {
    expect(looksLikeIdentifier("dead")).toBe(false);
    expect(looksLikeIdentifier("abc")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(looksLikeIdentifier("")).toBe(false);
  });

  it("rejects mixed alphanumeric that is not hex", () => {
    expect(looksLikeIdentifier("user123")).toBe(false);
    expect(looksLikeIdentifier("abc123xyz")).toBe(false);
  });
});

describe("buildPathTemplates", () => {
  it("returns static paths when inference is disabled", () => {
    const requests = [
      { ...req("/users/123"), sourceIndex: 0 },
      { ...req("/users/456"), sourceIndex: 1 },
    ];
    const result = buildPathTemplates(requests, 2, false);
    expect(result.get(0)?.path).toBe("/users/123");
    expect(result.get(1)?.path).toBe("/users/456");
    expect(result.get(0)?.parameters.size).toBe(0);
  });

  it("templates numeric IDs across multiple requests", () => {
    const requests = [
      { ...req("/users/123"), sourceIndex: 0 },
      { ...req("/users/456"), sourceIndex: 1 },
    ];
    const result = buildPathTemplates(requests, 2, true);
    expect(result.get(0)?.path).toBe("/users/{userId}");
    expect(result.get(1)?.path).toBe("/users/{userId}");
    expect(result.get(0)?.parameters.get(2)).toBe("userId");
  });

  it("templates UUIDs", () => {
    const requests = [
      {
        ...req("/users/3f1d9a2e-4b7c-4c1a-9d2e-8f6b1c0a7e51"),
        sourceIndex: 0,
      },
      {
        ...req("/users/9a2e3f1d-7c4b-4a1c-8d2e-1c0a7e516f6b"),
        sourceIndex: 1,
      },
    ];
    const result = buildPathTemplates(requests, 2, true);
    expect(result.get(0)?.path).toBe("/users/{userId}");
  });

  it("does not template when fewer than minSamples requests", () => {
    const requests = [{ ...req("/users/123"), sourceIndex: 0 }];
    const result = buildPathTemplates(requests, 2, true);
    expect(result.get(0)?.path).toBe("/users/123");
  });

  it("templates with minSamples=1", () => {
    const requests = [{ ...req("/users/123"), sourceIndex: 0 }];
    const result = buildPathTemplates(requests, 1, true);
    // With 1 sample, the segment doesn't "vary" (only one value),
    // so it stays static. This is correct behavior.
    expect(result.get(0)?.path).toBe("/users/123");
  });

  it("does not template static segments", () => {
    const requests = [
      { ...req("/users/list"), sourceIndex: 0 },
      { ...req("/users/list"), sourceIndex: 1 },
    ];
    const result = buildPathTemplates(requests, 2, true);
    expect(result.get(0)?.path).toBe("/users/list");
  });

  it("does not template when one sample is not an identifier", () => {
    const requests = [
      { ...req("/users/123"), sourceIndex: 0 },
      { ...req("/users/abc"), sourceIndex: 1 },
    ];
    const result = buildPathTemplates(requests, 2, true);
    // "abc" is not an identifier, so the segment stays static
    // But they have different signatures (123 -> \u0000, abc -> abc),
    // so they're in different groups
    expect(result.get(0)?.path).toBe("/users/123");
    expect(result.get(1)?.path).toBe("/users/abc");
  });

  it("templates multiple parameter segments", () => {
    const requests = [
      { ...req("/users/123/posts/456"), sourceIndex: 0 },
      { ...req("/users/789/posts/012"), sourceIndex: 1 },
    ];
    const result = buildPathTemplates(requests, 2, true);
    expect(result.get(0)?.path).toBe("/users/{userId}/posts/{postId}");
    expect(result.get(0)?.parameters.get(2)).toBe("userId");
    expect(result.get(0)?.parameters.get(4)).toBe("postId");
  });

  it("handles root path", () => {
    const requests = [{ ...req("/"), sourceIndex: 0 }];
    const result = buildPathTemplates(requests, 2, true);
    expect(result.get(0)?.path).toBe("/");
  });

  it("handles different path lengths in same group gracefully", () => {
    const requests = [
      { ...req("/users/123"), sourceIndex: 0 },
      { ...req("/users/123/posts"), sourceIndex: 1 },
    ];
    const result = buildPathTemplates(requests, 2, true);
    // Different signatures (different segment counts), so different groups
    expect(result.get(0)?.path).toBe("/users/123");
    expect(result.get(1)?.path).toBe("/users/123/posts");
  });

  it("groups by method and origin", () => {
    const requests = [
      { ...req("/users/123", "get"), sourceIndex: 0 },
      { ...req("/users/456", "post"), sourceIndex: 1 },
    ];
    const result = buildPathTemplates(requests, 2, true);
    // Different methods -> different groups -> no templating (only 1 per group)
    expect(result.get(0)?.path).toBe("/users/123");
    expect(result.get(1)?.path).toBe("/users/456");
  });

  it("deduplicates parameter names within a path", () => {
    // /users/123/users/456 -> both segments derive "userId", second gets suffix
    const requests = [
      { ...req("/users/123/users/456"), sourceIndex: 0 },
      { ...req("/users/789/users/012"), sourceIndex: 1 },
    ];
    const result = buildPathTemplates(requests, 2, true);
    const params = [...result.get(0)!.parameters.values()];
    expect(params).toHaveLength(2);
    expect(params[0]).toBe("userId");
    expect(params[1]).toBe("userId2");
  });
});
