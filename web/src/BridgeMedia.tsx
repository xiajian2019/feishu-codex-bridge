import { useEffect, useState, type ImgHTMLAttributes, type ReactElement } from "react";
import { isBridgeApiPath } from "./mobile-connection.js";
import { getBridgeOrigin, isMobileApp } from "./mobile-runtime.js";

/** Only Bridge API resources need a Bearer fetch; foreign URLs never gain credentials. */
function needsAuthenticatedMedia(src: string | undefined): boolean {
  if (!src || !isMobileApp()) return false;
  try {
    const url = new URL(src, window.location.href);
    const page = new URL(window.location.href);
    return isBridgeApiPath(url.pathname) && (url.origin === getBridgeOrigin()
      || (url.protocol === page.protocol && url.host === page.host));
  } catch { return false; }
}

export function useBridgeMediaUrl(src: string | undefined): { url: string | undefined; error: string | null; loading: boolean } {
  const authenticated = needsAuthenticatedMedia(src);
  const [resource, setResource] = useState<{ src: string; url?: string; error?: string } | null>(null);
  useEffect(() => {
    if (!authenticated || !src) return;
    const controller = new AbortController();
    let blobUrl: string | undefined;
    setResource(null);
    void fetch(src, { signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error("资源读取失败（" + response.status + "）。");
      const blob = await response.blob();
      if (controller.signal.aborted) return;
      blobUrl = URL.createObjectURL(blob);
      setResource({ src, url: blobUrl });
    }).catch((failure: unknown) => {
      if (!controller.signal.aborted) setResource({ src, error: failure instanceof Error ? failure.message : "资源读取失败。" });
    });
    return () => {
      controller.abort();
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [authenticated, src]);
  if (!authenticated) return { url: src, error: null, loading: false };
  const current = resource?.src === src ? resource : null;
  return { url: current?.url, error: current?.error ?? null, loading: !current };
}

export function BridgeImage({ src, alt, ...props }: ImgHTMLAttributes<HTMLImageElement>): ReactElement {
  const media = useBridgeMediaUrl(src);
  if (media.error) return <span role="img" aria-label={alt || "图片"} title={media.error}>图片无法加载</span>;
  return <img {...props} src={media.url} alt={alt} aria-busy={media.loading || undefined} />;
}
