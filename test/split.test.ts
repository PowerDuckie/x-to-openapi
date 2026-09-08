import { describe, expect, it } from "vitest";

import { splitCurlCommands } from "../src/adapters/curl/split.js";

describe("splitCurlCommands - basic splitting", () => {
  it("returns a single command as-is", () => {
    expect(splitCurlCommands("curl https://e.com/x")).toEqual([
      "curl https://e.com/x",
    ]);
  });

  it("splits two commands on separate lines", () => {
    const result = splitCurlCommands(
      "curl https://e.com/a\ncurl https://e.com/b",
    );
    expect(result).toHaveLength(2);
    expect(result[0]).toBe("curl https://e.com/a");
    expect(result[1]).toBe("curl https://e.com/b");
  });

  it("splits commands separated by semicolons", () => {
    const result = splitCurlCommands(
      "curl https://e.com/a; curl https://e.com/b",
    );
    expect(result).toHaveLength(2);
  });

  it("splits commands separated by &&", () => {
    const result = splitCurlCommands(
      "curl https://e.com/a && curl https://e.com/b",
    );
    expect(result).toHaveLength(2);
  });

  it("handles curl.exe", () => {
    const result = splitCurlCommands("curl.exe https://e.com/x");
    expect(result).toEqual(["curl https://e.com/x"]);
  });
});

describe("splitCurlCommands - continuations", () => {
  it("joins backslash-continued lines", () => {
    const result = splitCurlCommands(
      "curl 'https://e.com/x' \\\n  -H 'X: 1'",
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("https://e.com/x");
    expect(result[0]).toContain("X: 1");
  });

  it("joins Windows caret continuations", () => {
    const result = splitCurlCommands(
      "curl https://e.com/x ^\n  -H 'X: 1'",
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("X: 1");
  });

  it("handles CRLF line endings", () => {
    const result = splitCurlCommands(
      "curl https://e.com/a\r\ncurl https://e.com/b",
    );
    expect(result).toHaveLength(2);
  });
});

describe("splitCurlCommands - shell prompts", () => {
  it("strips $ prompt", () => {
    expect(splitCurlCommands("$ curl https://e.com/x")[0]).toBe(
      "curl https://e.com/x",
    );
  });

  it("strips # prompt", () => {
    expect(splitCurlCommands("# curl https://e.com/x")[0]).toBe(
      "curl https://e.com/x",
    );
  });

  it("strips > prompt", () => {
    expect(splitCurlCommands("> curl https://e.com/x")[0]).toBe(
      "curl https://e.com/x",
    );
  });

  it("strips PowerShell prompt", () => {
    expect(splitCurlCommands("PS C:\\> curl https://e.com/x")[0]).toBe(
      "curl https://e.com/x",
    );
  });
});

describe("splitCurlCommands - quote handling", () => {
  it("does not split inside single quotes", () => {
    const result = splitCurlCommands(
      `curl 'https://e.com/x?curl=inside'`,
    );
    expect(result).toHaveLength(1);
  });

  it("does not split inside double quotes", () => {
    const result = splitCurlCommands(
      `curl "https://e.com/x?curl=inside"`,
    );
    expect(result).toHaveLength(1);
  });

  it("does not split on curl mentioned in --data", () => {
    const result = splitCurlCommands(
      `curl -X POST https://e.com/x --data '{"tool":"curl"}'`,
    );
    expect(result).toHaveLength(1);
  });

  it("handles escaped quotes inside double quotes", () => {
    const result = splitCurlCommands(
      `curl "https://e.com/x?name=\\"curl\\""`,
    );
    expect(result).toHaveLength(1);
  });
});

describe("splitCurlCommands - edge cases", () => {
  it("returns empty array for empty input", () => {
    expect(splitCurlCommands("")).toEqual([]);
  });

  it("returns empty array for whitespace-only input", () => {
    expect(splitCurlCommands("   \n  \n  ")).toEqual([]);
  });

  it("falls back to original text if no curl found", () => {
    expect(splitCurlCommands("https://e.com/x")).toEqual([
      "https://e.com/x",
    ]);
  });

  it("does not match curl in URL path", () => {
    const result = splitCurlCommands("curl https://e.com/curl/test");
    expect(result).toHaveLength(1);
  });

  it("does not match curlify or curl_version", () => {
    const result = splitCurlCommands("curlify https://e.com/x");
    // "curlify" doesn't start with curl at a boundary, so fallback
    expect(result).toEqual(["curlify https://e.com/x"]);
  });

  it("handles multiple commands with mixed prompts", () => {
    const result = splitCurlCommands(
      "$ curl https://e.com/a\n# curl https://e.com/b",
    );
    expect(result).toHaveLength(2);
    expect(result[0]).toBe("curl https://e.com/a");
    expect(result[1]).toBe("curl https://e.com/b");
  });

  it("trims whitespace from each command", () => {
    const result = splitCurlCommands("  curl https://e.com/a  \n  curl https://e.com/b  ");
    expect(result[0]).toBe("curl https://e.com/a");
    expect(result[1]).toBe("curl https://e.com/b");
  });
});
