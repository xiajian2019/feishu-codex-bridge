export type BackSource = "back" | "escape";
/** A single press is consumed by exactly one layer, including a busy layer that cannot close yet. */
export function createBackStack() {
  const layers: Array<{ close: () => void; priority: number; escape: boolean }> = [];
  const top = (source: BackSource) => layers.filter((layer) => source !== "escape" || layer.escape)
    .reduce<typeof layers[number] | undefined>((best, layer) => !best || layer.priority >= best.priority ? layer : best, undefined);
  return {
    register(close: () => void, priority = 100, escape = true): () => boolean {
      const layer = { close, priority, escape };
      layers.push(layer);
      return () => {
        const wasTop = top("back") === layer;
        const index = layers.indexOf(layer);
        if (index >= 0) layers.splice(index, 1);
        return wasTop && index >= 0;
      };
    },
    dispatch(source: BackSource): boolean {
      const layer = top(source);
      if (!layer) return false;
      layer.close();
      return true;
    },
  };
}
