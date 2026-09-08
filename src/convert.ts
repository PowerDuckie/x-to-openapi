import { ConversionError, DiagnosticBag } from "./core/diagnostics.js";
import { AdapterRegistry } from "./core/registry.js";
import type {
  ConvertOptions,
  ConvertResult,
  ResolvedConvertOptions,
  SourceAdapter,
} from "./core/types.js";
import { buildOpenApi32 } from "./openapi/builder.js";
import { validateOpenApi32 } from "./validation/openapi32.js";

export const DEFAULT_OPTIONS: ResolvedConvertOptions = {
  openapiVersion: "3.2.0",
  title: "Generated API",
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

function resolve(options: ConvertOptions): ResolvedConvertOptions {
  const resolved = { ...DEFAULT_OPTIONS, ...options };

  if (resolved.openapiVersion !== "3.2.0") {
    throw new TypeError(
      `Unsupported openapiVersion: ${String(resolved.openapiVersion)}`,
    );
  }
  if (
    !Number.isInteger(resolved.pathParameterMinSamples) ||
    resolved.pathParameterMinSamples < 1
  ) {
    throw new TypeError("pathParameterMinSamples must be a positive integer");
  }
  if (typeof resolved.title !== "string" || resolved.title.trim() === "") {
    throw new TypeError("title must be a non-empty string");
  }

  return resolved;
}

export class XToOpenApi {
  readonly #registry = new AdapterRegistry();

  register<I>(adapter: SourceAdapter<I>): this {
    this.#registry.register(adapter);
    return this;
  }

  adapters(): string[] {
    return this.#registry.ids();
  }

  /** Single entry point. Pass `"auto"` to select an adapter via canHandle(). */
  async convert(
    source: string,
    input: unknown,
    options: ConvertOptions = {},
  ): Promise<ConvertResult> {
    const resolved = resolve(options);
    const bag = new DiagnosticBag(resolved.strict);

    const adapter =
      source === "auto"
        ? (this.#registry.detect(input) ??
          (() => {
            throw new ConversionError(
              "No registered adapter can handle the provided input",
              [],
            );
          })())
        : this.#registry.get(source);

    let requests: ConvertResult["requests"] = [];

    try {
      requests = [
        ...(await adapter.parse(input, {
          report: bag.report,
          strict: resolved.strict,
        })),
      ];
    } catch (cause) {
      if (cause instanceof ConversionError) throw cause;

      bag.report({
        code: "CURL_PARSE_FAILED",
        severity: "error",
        source: adapter.id,
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      });
    }

    const document = buildOpenApi32(requests, resolved, bag.report);

    let documentValid = true;

    if (resolved.validate) {
      const outcome = await validateOpenApi32(document);
      documentValid = outcome.valid;
      for (const diagnostic of outcome.diagnostics) bag.report(diagnostic);
    }

    return {
      document,
      requests,
      diagnostics: bag.items,
      ok: !bag.hasErrors(),
      documentValid,
    };
  }
}
