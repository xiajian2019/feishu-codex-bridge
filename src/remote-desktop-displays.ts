import { execFile } from "node:child_process";
import { promisify } from "node:util";

export interface RemoteDesktopDisplay {
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

// Read-only CoreGraphics queries through macOS's built-in JavaScript bridge.
// Screen names and dimensions are returned only to an authorized Bridge device.
const DISPLAY_QUERY = `
ObjC.import("AppKit");
ObjC.import("CoreGraphics");
var screens = $.NSScreen.screens;
var result = [];
for (var i = 0; i < screens.count && i < 16; i++) {
  var screen = screens.objectAtIndex(i);
  var id = Number(ObjC.unwrap(screen.deviceDescription.objectForKey("NSScreenNumber")));
  var bounds = $.CGDisplayBounds(id);
  var mode = $.CGDisplayCopyDisplayMode(id);
  var pixelWidth = mode ? Number($.CGDisplayModeGetPixelWidth(mode)) : 0;
  var pixelHeight = mode ? Number($.CGDisplayModeGetPixelHeight(mode)) : 0;
  if (mode) $.CGDisplayModeRelease(mode);
  var name = "Display " + (i + 1);
  try { name = ObjC.unwrap(screen.localizedName) || name; } catch (_) {}
  result.push({ id: id, name: name, builtIn: !!$.CGDisplayIsBuiltin(id), main: !!$.CGDisplayIsMain(id),
    x: bounds.origin.x, y: bounds.origin.y, width: bounds.size.width, height: bounds.size.height,
    pixelWidth: pixelWidth, pixelHeight: pixelHeight });
}
JSON.stringify(result);
`;
const run = promisify(execFile);

export async function listRemoteDesktopDisplays(): Promise<RemoteDesktopDisplay[]> {
  if (process.platform !== "darwin") return [];
  try {
    const { stdout } = await run("/usr/bin/osascript", ["-l", "JavaScript", "-e", DISPLAY_QUERY], {
      timeout: 3_000, maxBuffer: 64 * 1024,
    });
    const parsed: unknown = JSON.parse(stdout);
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, 16).filter((item): item is RemoteDesktopDisplay => {
      if (!item || typeof item !== "object") return false;
      const value = item as Record<string, unknown>;
      return Number.isSafeInteger(value.id)
        && typeof value.name === "string" && value.name.length <= 200
        && typeof value.builtIn === "boolean" && typeof value.main === "boolean"
        && ["x", "y", "width", "height", "pixelWidth", "pixelHeight"].every((key) =>
          typeof value[key] === "number" && Number.isFinite(value[key]) && Math.abs(value[key] as number) <= 65_535)
        && (value.width as number) > 0 && (value.height as number) > 0
        && (value.pixelWidth as number) >= 0 && (value.pixelHeight as number) >= 0;
    });
  } catch {
    // Headless, restricted, or non-graphical hosts still support the full view.
    return [];
  }
}
