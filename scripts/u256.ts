export function canonicalU256(value: unknown, label: string): string {
  if (typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value)) {
    const parsed = BigInt(value);
    if (parsed < 1n << 256n) return value;
  }
  if (typeof value === "bigint" && value >= 0n && value < 1n << 256n) return value.toString();
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  throw new Error(`${label} must be a canonical lossless u256`);
}

export function parseLosslessJsonObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "string") throw new Error(`${label} shape is unavailable`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(quoteLargeJsonIntegers(value));
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${label} is not an object`);
  return parsed as Record<string, unknown>;
}

function quoteLargeJsonIntegers(value: string): string {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < value.length;) {
    const char = value[index]!;
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      index += 1;
      continue;
    }
    if (char === '"') { inString = true; output += char; index += 1; continue; }
    if (char === "-" || /[0-9]/.test(char)) {
      const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(value.slice(index));
      if (!match) { output += char; index += 1; continue; }
      const token = match[0];
      output += /^-?[0-9]{16,}$/.test(token) ? JSON.stringify(token) : token;
      index += token.length;
      continue;
    }
    output += char;
    index += 1;
  }
  return output;
}
