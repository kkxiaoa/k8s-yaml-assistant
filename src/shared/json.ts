import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

function canonicalizeJson(
  value: unknown,
  activeObjects: WeakSet<object>,
  path: string,
): JsonValue {
  if (value === null) return null;

  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError(`${path} must be a finite JSON number`);
      }
      return value;
    case 'object':
      break;
    default:
      throw new TypeError(`${path} is not JSON-serializable`);
  }

  if (activeObjects.has(value)) {
    throw new TypeError(`${path} contains a cycle`);
  }
  activeObjects.add(value);

  try {
    if (Array.isArray(value)) {
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== 'string') {
          throw new TypeError(`${path} cannot contain symbol keys`);
        }
        if (key === 'length') continue;
        const index = Number(key);
        if (
          !Number.isInteger(index) ||
          index < 0 ||
          index >= value.length ||
          String(index) !== key
        ) {
          throw new TypeError(`${path}.${key} is not a JSON array index`);
        }
      }

      const canonical: JsonValue[] = [];
      for (let index = 0; index < value.length; index++) {
        if (!Object.hasOwn(value, index)) {
          throw new TypeError(`${path}[${index}] cannot be an array hole`);
        }
        canonical.push(
          canonicalizeJson(value[index], activeObjects, `${path}[${index}]`),
        );
      }
      return canonical;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${path} must be a plain JSON object`);
    }

    const keys: string[] = [];
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') {
        throw new TypeError(`${path} cannot contain symbol keys`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !('value' in descriptor)) {
        throw new TypeError(
          `${path}.${key} must be an enumerable data property`,
        );
      }
      keys.push(key);
    }

    const canonical = Object.create(null) as { [key: string]: JsonValue };
    for (const key of keys.sort()) {
      canonical[key] = canonicalizeJson(
        (value as Record<string, unknown>)[key],
        activeObjects,
        `${path}.${key}`,
      );
    }
    return canonical;
  } finally {
    activeObjects.delete(value);
  }
}

export function canonicalJson(value: unknown, rootPath = 'value'): string {
  return JSON.stringify(canonicalizeJson(value, new WeakSet(), rootPath));
}

export function canonicalHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function readJsonFile(
  path: string,
  artifact: string,
  displayPath = path,
): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(
      `invalid ${artifact} JSON at ${displayPath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}
