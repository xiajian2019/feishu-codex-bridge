import { flushSync } from "react-dom";
import { useEffect, useRef, useState, type ReactElement } from "react";
import { useLocation, useNavigate } from "react-router";
import { PairingScanner } from "./PairingScanner.js";
import { decodePairingImage } from "./pairing-qr.js";
import { parseComposerTransferQrPayload } from "./composer-transfer-link.js";
import { getBridgeOrigin, isMobileApp, scanMobilePairingQr } from "./mobile-runtime.js";
import { useSystemNavigation } from "./WebNavigation.js";
import { useMobileBack } from "./use-mobile-back.js";
import "./mobile-app.css";
import "./mobile-composer-transfer.css";

type ScanPhase = "idle" | "reading" | "native";

export function MobileComposerTransferPage(): ReactElement {
  const navigate = useNavigate();
  const location = useLocation();
  const mobileApp = isMobileApp();
  const { collapsed: navigationCollapsed, setCollapsed: setNavigationCollapsed } = useSystemNavigation();
  const [cameraOpen, setCameraOpen] = useState(false);
  const [phase, setPhase] = useState<ScanPhase>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const imageRef = useRef<HTMLInputElement>(null);
  const photoRef = useRef<HTMLInputElement>(null);
  const pending = useRef(false);
  const active = useRef(true);
  const navigationBeforeScanner = useRef(navigationCollapsed);

  const closeScanner = (): void => {
    if (pending.current) return;
    if (typeof window.history.state?.idx === "number" && window.history.state.idx > 0) navigate(-1);
    else navigate("/tmux-dashboard", { replace: true });
  };

  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);
  useEffect(() => {
    if (!mobileApp) return;
    const previous = navigationBeforeScanner.current;
    setNavigationCollapsed(true);
    return () => setNavigationCollapsed(previous);
  }, [mobileApp, setNavigationCollapsed]);
  useMobileBack(mobileApp, closeScanner, 1000);
  useEffect(() => {
    const scanError = (location.state as { composerScanError?: unknown } | null)?.composerScanError;
    if (typeof scanError === "string") { setCameraOpen(false); setMessage(scanError); }
  }, [location.key, location.state]);
  useEffect(() => {
    const releaseCamera = (): void => setCameraOpen(false);
    window.addEventListener("bridge:prepare-native-composer-scan", releaseCamera);
    return () => window.removeEventListener("bridge:prepare-native-composer-scan", releaseCamera);
  }, []);

  if (!mobileApp) return <main className="page-main mobile-composer-transfer-page">
    <section className="mobile-composer-transfer-hero" aria-labelledby="mobile-composer-transfer-title">
      <h1 id="mobile-composer-transfer-title">同步 Composer</h1>
      <p className="mobile-composer-transfer-lead">扫一扫需要在 Android/iOS Bridge App 中使用。请打开手机 App，再从“系统管理 → 扫一扫”进入。</p>
      <p className="mobile-composer-transfer-unavailable" role="status">当前是 Web 页面，摄像头扫码和系统文件选择不会在这里启动。</p>
    </section>
  </main>;

  const applyScan = (value: string): void => {
    if (!active.current) return;
    try {
      const payload = parseComposerTransferQrPayload(value, getBridgeOrigin());
      if (payload.mode === "peerjs") {
        navigate(`/composer-transfer?mode=peerjs&peer=${encodeURIComponent(payload.peerId)}&token=${encodeURIComponent(payload.token)}`);
      } else {
        navigate(`/composer-transfer?code=${encodeURIComponent(payload.code)}`);
      }
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "二维码识别失败，请重试。");
      setCameraOpen(false);
    }
  };

  const finishScan = (value: string): void => {
    if (pending.current || !active.current) return;
    pending.current = true;
    applyScan(value);
    pending.current = false;
  };

  const readImage = async (file: File | undefined): Promise<void> => {
    if (!file || pending.current) return;
    pending.current = true;
    setCameraOpen(false);
    setPhase("reading");
    setMessage(null);
    try {
      applyScan(await decodePairingImage(file));
    } catch (cause) {
      if (active.current) setMessage(cause instanceof Error ? cause.message : "图片识别失败，请选择清晰的二维码图片。");
    } finally {
      pending.current = false;
      if (active.current) { setPhase("idle"); setCameraOpen(false); }
    }
  };

  const readNative = async (): Promise<void> => {
    if (pending.current) return;
    pending.current = true;
    flushSync(() => { setCameraOpen(false); setPhase("native"); setMessage(null); });
    try {
      const value = await scanMobilePairingQr("扫描 Composer 手机同步二维码");
      if (value) applyScan(value);
    } catch (cause) {
      if (active.current) setMessage(cause instanceof Error ? cause.message : "原生扫码失败，可重试或选择二维码图片。");
    } finally {
      pending.current = false;
      if (active.current) { setPhase("idle"); setCameraOpen(false); }
    }
  };

  return <main className="mobile-connect-page mobile-pairing-page">
    <section className="mobile-connect-card mobile-pairing-card" aria-labelledby="mobile-composer-scan-title">
      <header className="mobile-pairing-header">
        <button type="button" className="mobile-connect-secondary" aria-label="返回上一页" disabled={phase !== "idle"} onClick={closeScanner}>‹</button>
        <div><h1 id="mobile-composer-scan-title">扫码备用方式</h1><p>识别 Mac 或另一台手机上的 Composer 同步二维码。</p></div>
      </header>
      {cameraOpen ? <PairingScanner
        onDecode={finishScan}
        onClose={() => setCameraOpen(false)}
        onPhoto={() => { setCameraOpen(false); photoRef.current?.click(); }}
        onImage={() => { setCameraOpen(false); imageRef.current?.click(); }}
        readyMessage="将完整二维码放入扫描框，识别后进入发送页面。"
      /> : <>
        <p className="mobile-composer-transfer-options-note" role={phase === "idle" ? undefined : "status"}>
          {phase === "reading" ? "正在识别二维码…" : phase === "native" ? "正在使用原生扫码…" : "可以选择二维码图片、拍照识别，或使用网页相机。"}
        </p>
        <div className="pairing-actions">
          <button className="secondary" type="button" disabled={phase !== "idle"} onClick={() => imageRef.current?.click()}>选择本地图片</button>
          <button className="secondary" type="button" disabled={phase !== "idle"} onClick={() => photoRef.current?.click()}>拍照识别</button>
          <button className="secondary" type="button" disabled={phase !== "idle"} onClick={() => { setMessage(null); setCameraOpen(true); }}>使用网页相机</button>
        </div>
      </>}
      <button className="secondary mobile-composer-transfer-native" type="button" disabled={phase !== "idle" || pending.current} onClick={() => void readNative()}>使用原生扫码</button>
      <input ref={imageRef} type="file" accept="image/*" hidden aria-label="选择 Composer 同步二维码图片" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; void readImage(file); }} />
      <input ref={photoRef} type="file" accept="image/*" capture="environment" hidden aria-label="拍摄 Composer 同步二维码" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; void readImage(file); }} />
      {message ? <p className="mobile-connect-error" role="alert">{message}</p> : null}
    </section>
  </main>;
}
