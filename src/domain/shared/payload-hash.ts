import { createHash } from 'node:crypto';

export type CanonicalValue = string | number | boolean | null | CanonicalValue[] | { [key: string]: CanonicalValue | undefined };

// JSON canônico: chaves ordenadas recursivamente e campos undefined omitidos
export function canonicalJson(value: CanonicalValue | undefined): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const entries = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
  return `{${entries.join(',')}}`;
}

export function hashPayload(value: CanonicalValue): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}
