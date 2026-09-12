import { validate } from "@powerduck/openapi-parser";

import type { Diagnostic, OpenApiDocument } from "../core/types.js";

export type { Oas32Document as OpenApi32Document } from "@powerduck/openapi-parser";

export interface ValidationOutcome {
  valid: boolean;
  diagnostics: Diagnostic[];
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;

  if (error && typeof error === "object" && "message" in error) {
    const record = error as { message?: unknown; path?: unknown };
    const path = typeof record.path === "string" ? ` at ${record.path}` : "";
    return `${String(record.message)}${path}`;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export async function validateOpenApi32(
  document: OpenApiDocument,
): Promise<ValidationOutcome> {
  try {
    const result = await validate(document);
    const errors = Array.isArray(result.errors) ? result.errors : [];

    return {
      valid: Boolean(result.valid),
      diagnostics: errors.map((error) => ({
        code: "OAS_VALIDATION_ERROR" as const,
        severity: "error" as const,
        message: describe(error),
        cause: error,
      })),
    };
  } catch (cause) {
    return {
      valid: false,
      diagnostics: [
        {
          code: "OAS_VALIDATOR_FAILED",
          severity: "error",
          message: describe(cause),
          cause,
        },
      ],
    };
  }
}
