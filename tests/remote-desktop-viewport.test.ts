import { describe, expect, it } from "bun:test";
import { anchoredZoomOffset, clampViewportOffset, matchDisplayRegions, viewportPlacement, viewportScale,
  type DesktopDisplay } from "../web/src/remote-desktop-viewport.js";

const displays: DesktopDisplay[] = [
  { id: 5, name: "external", builtIn: false, main: true, x: 0, y: 0,
    width: 1152, height: 2048, pixelWidth: 1152, pixelHeight: 2048 },
  { id: 1, name: "internal", builtIn: true, main: false, x: 1152, y: 836,
    width: 1728, height: 1117, pixelWidth: 3456, pixelHeight: 2234 },
];

describe("remote desktop viewport", () => {
  it("matches mixed Retina displays to the actual RFB framebuffer", () => {
    const result = matchDisplayRegions(displays, { width: 4608, height: 3070 });
    expect(result?.find((item) => item.builtIn)?.rect).toEqual({ x: 1152, y: 836, width: 3456, height: 2234 });
    expect(result?.find((item) => item.main)?.rect).toEqual({ x: 0, y: 0, width: 1152, height: 2048 });
    expect(matchDisplayRegions(displays, { width: 4608, height: 4096 })).toBeNull();
  });

  it("handles negative display origins and uniform framebuffer scaling", () => {
    const left = { ...displays[0]!, x: -1152, y: -100, width: 1152, height: 1000, pixelWidth: 1152, pixelHeight: 1000 };
    const right = { ...displays[1]!, x: 0, y: 0, width: 800, height: 900, pixelWidth: 800, pixelHeight: 900 };
    const result = matchDisplayRegions([left, right], { width: 3904, height: 2000 });
    expect(result?.[0]?.rect).toEqual({ x: 0, y: 0, width: 2304, height: 2000 });
    expect(result?.[1]?.rect).toEqual({ x: 2304, y: 200, width: 1600, height: 1800 });
  });

  it("centers the selected display and constrains pan after zooming", () => {
    const stage = { width: 400, height: 300 };
    const rect = { x: 400, y: 0, width: 400, height: 400 };
    const framebuffer = { width: 800, height: 400 };
    const scale = viewportScale(stage, rect, false, 1);
    expect(scale).toBe(0.75);
    expect(viewportPlacement(stage, framebuffer, rect, scale, { x: 0, y: 0 }))
      .toEqual({ x: -250, y: 0, width: 600, height: 300 });
    expect(clampViewportOffset({ x: 999, y: -999 }, stage, rect, 1.5)).toEqual({ x: 100, y: -150 });
    expect(anchoredZoomOffset(stage, { x: 0, y: 0 }, { x: 300, y: 150 }, 2)).toEqual({ x: -100, y: 0 });
  });
});
