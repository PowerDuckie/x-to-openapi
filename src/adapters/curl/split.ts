const PROMPT = /^(?:[$#>]|PS\s*[^>]*>)\s+/;

function isBoundary(char: string | undefined): boolean {
  return char === undefined || /[\s;&|]/.test(char);
}

/**
 * Splits browser "Copy all as cURL" output into individual commands.
 * Handles quotes, backslash and caret continuations, CRLF, shell prompts and `curl.exe`.
 */
export function splitCurlCommands(input: string): string[] {
  const text = input.replace(/\r\n?/g, "\n");
  const commands: string[] = [];

  let current = "";
  let quote: "'" | '"' | "" = "";

  const flush = (): void => {
    const value = current
      .split("\n")
      .map((line) => line.replace(PROMPT, ""))
      .join("\n")
      .trim();

    if (value.length > 0) commands.push(value);
    current = "";
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    const next = text[index + 1];

    // Backslash continuation / escape (inert inside single quotes).
    if (char === "\\" && quote !== "'") {
      if (next === "\n") {
        current += " ";
        index += 1;
        continue;
      }
      current += char;
      if (next !== undefined) {
        current += next;
        index += 1;
      }
      continue;
    }

    // Windows caret continuation.
    if (char === "^" && !quote && next === "\n") {
      current += " ";
      index += 1;
      continue;
    }

    if (quote) {
      current += char;
      if (char === quote) quote = "";
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }

    const match = /^curl(?:\.exe)?/.exec(text.slice(index));

    if (
      match &&
      isBoundary(text[index - 1]) &&
      isBoundary(text[index + match[0].length])
    ) {
      flush();
      current = "curl";
      index += match[0].length - 1;
      continue;
    }

    current += char;
  }

  flush();

  if (commands.length > 0) return commands;

  const fallback = text.trim();
  return fallback ? [fallback] : [];
}
