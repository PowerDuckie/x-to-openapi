import type { NormalizedRequest } from "../core/types.js";
import { pathParameterName } from "./naming.js";

const NUMERIC = /^\d+$/;
const HEX = /^[0-9a-f]{8,}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** Single source of truth — the grouping key and the substitution test must agree. */
export function looksLikeIdentifier(segment: string): boolean {
  return (
    NUMERIC.test(segment) ||
    UUID.test(segment) ||
    ULID.test(segment) ||
    HEX.test(segment)
  );
}

export interface PathTemplate {
  /** Templated path, e.g. `/users/{userId}`. */
  readonly path: string;
  /** Parameter name keyed by segment index. */
  readonly parameters: ReadonlyMap<number, string>;
}

function staticTemplate(request: NormalizedRequest): PathTemplate {
  return { path: request.url.pathname || "/", parameters: new Map() };
}

/**
 * Groups same-shaped requests and templates segments that vary across
 * at least `minSamples` requests and look like identifiers in every sample.
 */
export function buildPathTemplates(
  requests: readonly NormalizedRequest[],
  minSamples: number,
  enabled: boolean,
): Map<number, PathTemplate> {
  const result = new Map<number, PathTemplate>();

  if (!enabled) {
    for (const request of requests)
      result.set(request.sourceIndex, staticTemplate(request));
    return result;
  }

  const groups = new Map<string, NormalizedRequest[]>();

  for (const request of requests) {
    const segments = request.url.pathname.split("/");
    const signature = segments
      .map((segment) => (looksLikeIdentifier(segment) ? "\u0000" : segment))
      .join("/");
    const key = `${request.method}\u0001${request.url.origin}\u0001${signature}`;

    const group = groups.get(key);
    if (group) group.push(request);
    else groups.set(key, [request]);
  }

  for (const group of groups.values()) {
    const rows = group.map((request) => request.url.pathname.split("/"));
    const width = rows[0]!.length;

    if (!rows.every((row) => row.length === width)) {
      for (const request of group)
        result.set(request.sourceIndex, staticTemplate(request));
      continue;
    }

    const parameters = new Map<number, string>();
    const used = new Set<string>();
    const segments = [...rows[0]!];

    for (let index = 1; index < width; index += 1) {
      const column = rows.map((row) => row[index] ?? "");
      const varies = new Set(column).size > 1;

      if (
        !varies ||
        group.length < minSamples ||
        !column.every(looksLikeIdentifier)
      )
        continue;

      const name = pathParameterName(segments, index, used);
      used.add(name);
      parameters.set(index, name);
      segments[index] = `{${name}}`;
    }

    const joined = segments.join("/") || "/";
    const path = joined.startsWith("/") ? joined : `/${joined}`;

    for (const request of group)
      result.set(request.sourceIndex, { path, parameters });
  }

  return result;
}
