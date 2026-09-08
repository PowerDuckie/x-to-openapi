const IRREGULAR: Record<string, string> = {
  children: "child",
  people: "person",
  men: "man",
  women: "woman",
  data: "datum",
};

export function singularize(word: string): string {
  const lower = word.toLowerCase();

  if (IRREGULAR[lower]) return IRREGULAR[lower]!;
  if (/(?:s|sh|ch|x|z)es$/.test(lower)) return lower.slice(0, -2);
  if (/[^aeiou]ies$/.test(lower)) return `${lower.slice(0, -3)}y`;
  if (/ss$/.test(lower) || !/s$/.test(lower)) return lower;

  return lower.slice(0, -1);
}

function camelCase(value: string): string {
  const parts = value.split(/[^A-Za-z0-9]+/).filter(Boolean);
  return parts
    .map((part, index) =>
      index === 0
        ? part.toLowerCase()
        : part[0]!.toUpperCase() + part.slice(1).toLowerCase(),
    )
    .join("");
}

/** `/users/{}/posts/{}` → `userId`, `postId`, deduplicated. */
export function pathParameterName(
  segments: readonly string[],
  index: number,
  used: ReadonlySet<string>,
): string {
  const previous = segments
    .slice(0, index)
    .reverse()
    .find((segment) => segment.length > 0 && !segment.startsWith("{"));

  const base = previous
    ? `${camelCase(singularize(previous))}Id`
    : `param${index}`;

  if (!used.has(base)) return base;

  let suffix = 2;
  while (used.has(`${base}${suffix}`)) suffix += 1;
  return `${base}${suffix}`;
}

export function operationId(
  method: string,
  path: string,
  used: ReadonlySet<string>,
): string {
  const tail = path
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      const parameter = /^\{(.+)\}$/.exec(segment);
      return parameter ? `by_${parameter[1]}` : segment;
    })
    .join("_");

  const base = camelCase(`${method}_${tail || "root"}`);

  if (!used.has(base)) return base;

  let suffix = 2;
  while (used.has(`${base}${suffix}`)) suffix += 1;
  return `${base}${suffix}`;
}

export function tagFor(path: string): string {
  return (
    path
      .split("/")
      .find((segment) => segment.length > 0 && !segment.startsWith("{")) ??
    "default"
  );
}
