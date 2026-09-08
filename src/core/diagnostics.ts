import type { Diagnostic } from "./types.js";

export class ConversionError extends Error {
  readonly diagnostics: readonly Diagnostic[];

  constructor(
    message: string,
    diagnostics: readonly Diagnostic[],
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ConversionError";
    this.diagnostics = diagnostics;
  }
}

export class DiagnosticBag {
  readonly #items: Diagnostic[] = [];
  readonly #seen = new Set<string>();

  constructor(private readonly strict = false) {}

  /** Deduplicates identical diagnostics so one systemic fault reports once. */
  report = (diagnostic: Diagnostic): void => {
    const key = [
      diagnostic.code,
      diagnostic.severity,
      diagnostic.message,
      diagnostic.index ?? "",
      diagnostic.path ?? "",
    ].join("\u0000");

    if (this.#seen.has(key)) return;

    this.#seen.add(key);
    this.#items.push(diagnostic);

    if (this.strict && diagnostic.severity === "error") {
      throw new ConversionError(
        `[${diagnostic.code}] ${diagnostic.message}`,
        [diagnostic],
        {
          cause: diagnostic.cause,
        },
      );
    }
  };

  get items(): Diagnostic[] {
    return [...this.#items];
  }

  hasErrors(): boolean {
    return this.#items.some((item) => item.severity === "error");
  }
}
