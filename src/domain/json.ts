/** RFC 8785/JCS for I-JSON inputs: UTF-16 property sorting and ECMAScript primitives. */
export function canonicalJson(value: unknown): string {
  const seen = new Set<object>();
  const string = (text: string): string => {
    if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text))
      throw new Error('BAD_INPUT: lone surrogate');
    return JSON.stringify(text);
  };
  const visit = (item: unknown, depth: number): string => {
    if (depth > 32) throw new Error('BAD_INPUT: JSON depth');
    if (item === null) return 'null';
    if (typeof item === 'string') return string(item);
    if (typeof item === 'boolean') return item ? 'true' : 'false';
    if (typeof item === 'number' && Number.isFinite(item)) return JSON.stringify(item);
    if (typeof item !== 'object' || item === null || seen.has(item))
      throw new Error('BAD_INPUT: non-I-JSON value');
    seen.add(item);
    let result: string;
    if (Array.isArray(item)) {
      if (Object.keys(item).length !== item.length)
        throw new Error('BAD_INPUT: sparse or decorated array');
      result = `[${item.map((v) => visit(v, depth + 1)).join(',')}]`;
    } else {
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null)
        throw new Error('BAD_INPUT: JSON object');
      if (Object.getOwnPropertySymbols(item).length) throw new Error('BAD_INPUT: symbol key');
      result = `{${Object.keys(item)
        .sort()
        .map((k) => `${string(k)}:${visit((item as Record<string, unknown>)[k], depth + 1)}`)
        .join(',')}}`;
    }
    seen.delete(item);
    return result;
  };
  return visit(value, 0);
}
export async function sha256Json(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}
