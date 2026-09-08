import { CurlAdapter } from "./adapters/curl/index.js";
import { PostmanAdapter } from "./adapters/postman/index.js";
import { XToOpenApi } from "./convert.js";
import type { ConvertOptions, ConvertResult } from "./core/types.js";

// ---------------------------------------------------------------------------
// Core framework
// ---------------------------------------------------------------------------
export { XToOpenApi, DEFAULT_OPTIONS } from "./convert.js";
export { AdapterRegistry } from "./core/registry.js";
export { ConversionError, DiagnosticBag } from "./core/diagnostics.js";

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------
export { CurlAdapter, splitCurlCommands } from "./adapters/curl/index.js";
export { PostmanAdapter } from "./adapters/postman/index.js";
export * as PostmanTypes from "./adapters/postman/types.js";

// ---------------------------------------------------------------------------
// OpenAPI builder & schema utilities
// ---------------------------------------------------------------------------
export { buildOpenApi32 } from "./openapi/builder.js";
export { buildPathTemplates, looksLikeIdentifier } from "./openapi/paths.js";
export {
  scalar,
  jsonSchema,
  mergeSchemas,
  type Schema,
} from "./openapi/schema.js";

// ---------------------------------------------------------------------------
// Canonical OpenAPI type & validation (the single source of truth for
// downstream libraries: @powerduck/request, @powerduck/cli, etc.)
// ---------------------------------------------------------------------------
export {
  validateOpenApi32,
  type OpenApi32Document,
} from "./validation/openapi32.js";

/**
 * Canonical OpenAPI document type. All @powerduck libraries should import
 * this type rather than reaching into @scalar/openapi-types directly.
 */
export type { OpenApiDocument } from "./core/types.js";

/**
 * Canonical validation entry point. Alias of {@link validateOpenApi32}.
 * Downstream libraries should use this name for stability.
 */
export { validateOpenApi32 as validateOpenApiDocument } from "./validation/openapi32.js";

// ---------------------------------------------------------------------------
// All core types (ConvertOptions, ConvertResult, NormalizedRequest, etc.)
// ---------------------------------------------------------------------------
export type * from "./core/types.js";

// ---------------------------------------------------------------------------
// Zero-config helpers
// ---------------------------------------------------------------------------

/** Zero-config helper: curl text (or an array of commands) → OpenAPI 3.2. */
export async function curlToOpenApi(
  input: string | readonly string[],
  options: ConvertOptions = {},
): Promise<ConvertResult> {
  return new XToOpenApi()
    .register(new CurlAdapter())
    .convert("curl", input, options);
}

/**
 * Zero-config helper: a Postman Collection v2.0/v2.1.0 (parsed object or
 * JSON string) → OpenAPI 3.2.
 *
 * Test scripts are preserved as `x-postman-scripts` on each operation,
 * compatible with `@powerduck/request`'s Postman script runner.
 */
export async function postmanToOpenApi(
  input: unknown,
  options: ConvertOptions = {},
): Promise<ConvertResult> {
  return new XToOpenApi()
    .register(new PostmanAdapter())
    .convert("postman", input, options);
}
