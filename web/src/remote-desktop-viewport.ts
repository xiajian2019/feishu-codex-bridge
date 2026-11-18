export interface DesktopDisplay {
  id: number;
  name: string;
  builtIn: boolean;
  main: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  pixelWidth: number;
  pixelHeight: number;
}
export interface Size { width: number; height: number }
export interface Point { x: number; y: number }
export interface Rect extends Size, Point {}
export interface DisplayRegion extends DesktopDisplay { rect: Rect }

/** Accept a layout only if it explains the framebuffer size reported by RFB. */
export function matchDisplayRegions(displays: DesktopDisplay[], framebuffer: Size): DisplayRegion[] | null {
  if (!displays.length || framebuffer.width <= 0 || framebuffer.height <= 0) return null;
  const minX = Math.min(...displays.map((item) => item.x));
  const minY = Math.min(...displays.map((item) => item.y));
  const candidates = [
    displays.map((item) => ({ ...item, rect: { x: item.x - minX, y: item.y - minY,
      width: item.pixelWidth || item.width, height: item.pixelHeight || item.height } })),
    displays.map((item) => ({ ...item, rect: { x: item.x - minX, y: item.y - minY,
      width: item.width, height: item.height } })),
  ];
  for (const regions of candidates) {
    const width = Math.max(...regions.map(({ rect }) => rect.x + rect.width));
    const height = Math.max(...regions.map(({ rect }) => rect.y + rect.height));
    if (Math.abs(width - framebuffer.width) <= 2 && Math.abs(height - framebuffer.height) <= 2) return regions;
  }
  // Some servers apply one uniform scale to all displays.
  const logical = candidates[1]!;
  const width = Math.max(...logical.map(({ rect }) => rect.x + rect.width));
  const height = Math.max(...logical.map(({ rect }) => rect.y + rect.height));
  const scaleX = framebuffer.width / width;
  const scaleY = framebuffer.height / height;
  if (Math.abs(scaleX - scaleY) > 0.005) return null;
  return logical.map((item) => ({ ...item, rect: { x: item.rect.x * scaleX, y: item.rect.y * scaleY,
    width: item.rect.width * scaleX, height: item.rect.height * scaleY } }));
}

export function viewportScale(stage: Size, region: Size, actualSize: boolean, zoom: number): number {
  if (stage.width <= 0 || stage.height <= 0 || region.width <= 0 || region.height <= 0) return 1;
  return (actualSize ? 1 : Math.min(stage.width / region.width, stage.height / region.height)) * zoom;
}

export function clampViewportOffset(offset: Point, stage: Size, region: Size, scale: number): Point {
  const maxX = Math.max(0, (region.width * scale - stage.width) / 2);
  const maxY = Math.max(0, (region.height * scale - stage.height) / 2);
  return { x: Math.max(-maxX, Math.min(maxX, offset.x)), y: Math.max(-maxY, Math.min(maxY, offset.y)) };
}

export function viewportPlacement(stage: Size, framebuffer: Size, region: Rect, scale: number, offset: Point): Rect {
  const pan = clampViewportOffset(offset, stage, region, scale);
  return { x: (stage.width - region.width * scale) / 2 - region.x * scale + pan.x,
    y: (stage.height - region.height * scale) / 2 - region.y * scale + pan.y,
    width: framebuffer.width * scale, height: framebuffer.height * scale };
}

export function anchoredZoomOffset(stage: Size, original: Point, anchor: Point, ratio: number): Point {
  return { x: anchor.x - stage.width / 2 - (anchor.x - stage.width / 2 - original.x) * ratio,
    y: anchor.y - stage.height / 2 - (anchor.y - stage.height / 2 - original.y) * ratio };
}
