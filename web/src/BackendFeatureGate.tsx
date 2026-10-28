import type { ReactElement, ReactNode } from "react";
import { bridgeFeatureUnavailable, type BridgeFeature } from "./client-capabilities.js";

/** Keep unsupported routes from mounting effects and sending incompatible API calls. */
export function BackendFeatureGate({ feature, children }: { feature: BridgeFeature; children: ReactNode }): ReactElement {
  const message = bridgeFeatureUnavailable(feature);
  return message ? <section className="error-panel" role="alert"><h2>功能暂不可用</h2><p>{message}</p></section> : <>{children}</>;
}
