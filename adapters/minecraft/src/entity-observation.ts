/** Public dropped-item metadata only; never infer a stack from a name or equipment. */
export function droppedItemSummary(entity: any): { name: string; count: number } | null {
  if (!entity || !['item', 'Item', 'item_stack'].includes(entity.name) || typeof entity.getDroppedItem !== 'function') return null;
  try {
    const item = entity.getDroppedItem();
    if (!item || typeof item.name !== 'string' || !item.name || item.name === 'unknown' || !Number.isInteger(item.count) || item.count <= 0) return null;
    return { name: item.name, count: item.count };
  } catch {
    // Spawn and metadata packets can arrive separately; absence is still unknown.
    return null;
  }
}
