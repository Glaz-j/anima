export type BlockProperties = Record<string, boolean | number | string>;

export const BLOCK_PROPERTY_BUDGET = Object.freeze({ entries: 8, stringLength: 32, bytes: 256 });
// Interaction state first, then a few useful visual/orientation states. Never
// enumerate arbitrary properties, block-entity NBT, inventories or neighbours.
const PROPERTY_KEYS = ['eye', 'level', 'lit', 'open', 'age', 'waterlogged', 'occupied',
  'moisture', 'powered', 'facing', 'half', 'stage'] as const;

/** Call only after the actual loaded block passed the caller's visibility gate. */
export function blockProperties(block: any): BlockProperties | undefined {
  if (typeof block?.getProperties !== 'function') return undefined;
  try {
    const native = block.getProperties();
    if (!native || typeof native !== 'object' || Array.isArray(native)) return undefined;
    const result: BlockProperties = {};
    for (const key of PROPERTY_KEYS) {
      if (!Object.hasOwn(native, key)) continue;
      const value = native[key];
      if (!(typeof value === 'boolean' || typeof value === 'number' && Number.isSafeInteger(value)
        || typeof value === 'string' && value.length > 0 && value.length <= BLOCK_PROPERTY_BUDGET.stringLength)) continue;
      if (Buffer.byteLength(JSON.stringify({ ...result, [key]: value }), 'utf8') > BLOCK_PROPERTY_BUDGET.bytes) continue;
      result[key] = value;
      if (Object.keys(result).length >= BLOCK_PROPERTY_BUDGET.entries) break;
    }
    return Object.keys(result).length ? result : undefined;
  } catch {
    // Missing/unsupported state stays unknown; never infer false, zero or NBT.
    return undefined;
  }
}
