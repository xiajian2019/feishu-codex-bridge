import type { Plugin } from "vite";

/**
 * noVNC 1.7 probes H.264 with top-level await. Vite's existing browser target
 * cannot emit that syntax, and some mobile codecs never finish probing. Keep
 * the normal target and wait for the optional probe before opening a session.
 * Recheck the exact upstream source whenever the pinned dependency changes.
 */
export function noVncCompatibility(): Plugin {
  return {
    name: "bridge-novnc-compatibility",
    enforce: "pre",
    transform(code, id) {
      const path = id.split("?", 1)[0]!.replaceAll("\\", "/");
      if (path.endsWith("/@novnc/novnc/core/util/browser.js")) {
        const original = "supportsWebCodecsH264Decode = await _checkWebCodecsH264DecodeSupport();";
        if (!code.includes(original)) throw new Error("Review the noVNC H.264 compatibility transform for this version.");
        const replacement = `export const bridgeNoVNCCodecReady = Promise.race([
          _checkWebCodecsH264DecodeSupport().then((supported) => { supportsWebCodecsH264Decode = supported; }).catch(() => {}),
          new Promise((resolve) => setTimeout(resolve, 2000))
        ]);`;
        return { code: code.replace(original, replacement), map: null };
      }
      if (path.endsWith("/@novnc/novnc/core/rfb.js")) {
        return { code: `${code}\nexport { bridgeNoVNCCodecReady } from './util/browser.js';\n`, map: null };
      }
      return null;
    },
  };
}
