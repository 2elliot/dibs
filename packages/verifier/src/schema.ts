// A small JSON Schema checker for the subset REVIEW_SCHEMA uses (type, properties, required,
// additionalProperties: false, items, enum, anyOf). Model output is validated before it's
// saved, whichever path produced it.

type Schema = {
  type?: string;
  properties?: Record<string, Schema>;
  required?: readonly string[];
  additionalProperties?: boolean;
  items?: Schema;
  enum?: readonly unknown[];
  anyOf?: readonly Schema[];
};

function typeOk(type: string, value: unknown): boolean {
  switch (type) {
    case "object":
      return (
        typeof value === "object" && value !== null && !Array.isArray(value)
      );
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "integer":
      return Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return false;
  }
}

/** Returns a list of problems; empty means valid. */
export function validate(
  schema: unknown,
  value: unknown,
  path = "$",
): string[] {
  const s = schema as Schema;
  if (s.anyOf) {
    const options = s.anyOf.map((option) => validate(option, value, path));
    return options.some((errors) => errors.length === 0)
      ? []
      : [
          `${path}: matches none of the allowed shapes (${options.map((e) => e[0]).join("; ")})`,
        ];
  }
  if (s.type && !typeOk(s.type, value)) return [`${path}: expected ${s.type}`];
  if (s.enum && !s.enum.includes(value)) {
    return [
      `${path}: ${JSON.stringify(value)} isn't one of ${s.enum.join(", ")}`,
    ];
  }
  const errors: string[] = [];
  if (s.type === "object") {
    const object = value as Record<string, unknown>;
    for (const key of s.required ?? []) {
      if (!(key in object)) errors.push(`${path}.${key}: required`);
    }
    for (const [key, child] of Object.entries(object)) {
      const childSchema = s.properties?.[key];
      if (childSchema)
        errors.push(...validate(childSchema, child, `${path}.${key}`));
      else if (s.additionalProperties === false)
        errors.push(`${path}.${key}: not allowed`);
    }
  }
  if (s.type === "array" && s.items) {
    (value as unknown[]).forEach((item, i) =>
      errors.push(...validate(s.items, item, `${path}[${i}]`)),
    );
  }
  return errors;
}
