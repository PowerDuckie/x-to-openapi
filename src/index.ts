import { CurlAdapter } from "./adapters/curl/index.js";
import { XToOpenApi } from "./convert.js";
import type { ConvertOptions, ConvertResult } from "./core/types.js";

export { XToOpenApi, DEFAULT_OPTIONS } from "./convert.js";
export { CurlAdapter, splitCurlCommands } from "./adapters/curl/index.js";
export { AdapterRegistry } from "./core/registry.js";
export { ConversionError, DiagnosticBag } from "./core/diagnostics.js";
export { buildOpenApi32 } from "./openapi/builder.js";
export { buildPathTemplates, looksLikeIdentifier } from "./openapi/paths.js";
export {
  scalar,
  jsonSchema,
  mergeSchemas,
  type Schema,
} from "./openapi/schema.js";
export {
  validateOpenApi32,
  type OpenApi32Document,
} from "./validation/openapi32.js";
export type * from "./core/types.js";

/** Zero-config helper: curl text (or an array of commands) → OpenAPI 3.2. */
export async function curlToOpenApi(
  input: string | readonly string[],
  options: ConvertOptions = {},
): Promise<ConvertResult> {
  return new XToOpenApi()
    .register(new CurlAdapter())
    .convert("curl", input, options);
}
