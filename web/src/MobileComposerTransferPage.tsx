import { flushSync } from "react-dom";
import { useEffect, useRef, useState, type ReactElement } from "react";
import { useNavigate } from "react-router";
import { PairingScanner } from "./PairingScanner.js";
import { decodePairingImage } from "./pairing-qr.js";
import { parseComposerTransferQr } from "./composer-transfer-link.js";
import { getBridgeOrigin, isMobileApp, scanMobilePairingQr } from "./mobile-runtime.js";
import { useSystemNavigation } from "./WebNavigation.js";
import { useMobileBack } from "./use-mobile-back.js";
import "./mobile-app.css";
import "./mobile-composer-transfer.css";

type ScanPhase = "idle" | "reading" | "native";

export function MobileComposerTransferPage(): ReactElement {
  const navigate = useNavigate();
  const { collapsed: navigationCollapsed, setCollapsed: setNavigationCollapsed } = useSystemNavigation();
  const [scannerOpen, setScannerOpen] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(true);
  const [phase, setPhase] = useState<ScanPhase>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const imageRef = useRef<HTMLInputElement>(null);
  const photoRef = useRef<HTMLInputElement>(null);
  const pending = useRef(false);
  const active = useRef(true);
  const navigationBeforeScanner = useRef(navigationCollapsed);

  useEffect(() => () => { active.current = false; }, []);
  useEffect(() => { navigationBeforeScanner.current = navigationCollapsed; }, [navigationCollapsed]);
  useEffect(() => {
    if (!scannerOpen) return;
    const previous = navigationBeforeScanner.current;
    setNavigationCollapsed(true);
    return () => setNavigationCollapsed(previous);
  }, [scannerOpen, setNavigationCollapsed]);
  useMobileBack(scannerOpen, () => { if (!pending.current) setScannerOpen(false); }, 1000);

  if (!isMobileApp()) return <main className="page-main mobile-composer-transfer-page">
    <section className="mobile-composer-transfer-hero" aria-labelledby="mobile-composer-transfer-title">
      <h1 id="mobile-composer-transfer-title">同步 Composer</h1>
      <p className="mobile-composer-transfer-lead">扫一扫需要在 Android/iOS Bridge App 中使用。请打开手机 App，再从“系统管理 → 扫一扫”进入。</p>
      <p className="mobile-composer-transfer-unavailable" role="status">当前是 Web 页面，摄像头扫码和系统文件选择不会在这里启动。</p>
    </section>
  </main>;

  const openScanner = (): void => {
    setMessage(null);
    setPhase("idle");
    setCameraOpen(true);
    setScannerOpen(true);
  };

  const applyScan = (value: string): void => {
    if (!active.current) return;
    try {
      const code = parseComposerTransferQr(value, getBridgeOrigin());
      setScannerOpen(false);
      navigate(`/composer-transfer?code=${encodeURIComponent(code)}`);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "二维码识别失败，请重试。");
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
      if (active.current) { setPhase("idle"); setCameraOpen(true); }
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
      if (active.current) { setPhase("idle"); setCameraOpen(true); }
    }
  };

  if (scannerOpen) return <main className="mobile-connect-page mobile-pairing-page">
    <section className="mobile-connect-card mobile-pairing-card" aria-labelledby="mobile-composer-scan-title">
      <header className="mobile-pairing-header">
        <button type="button" className="mobile-connect-secondary" aria-label="返回同步 Composer" disabled={pending.current} onClick={() => setScannerOpen(false)}>‹</button>
        <div><h1 id="mobile-composer-scan-title">扫一扫</h1><p>扫描 Mac 或另一台手机上的 Composer 同步二维码。</p></div>
      </header>
      {cameraOpen ? <PairingScanner
        onDecode={finishScan}
        onClose={() => setScannerOpen(false)}
        onPhoto={() => photoRef.current?.click()}
        onImage={() => imageRef.current?.click()}
      /> : <>
        <div className="mobile-pairing-placeholder" role="status"><span aria-hidden="true">▦</span><p>{phase === "reading" ? "正在识别二维码…" : phase === "native" ? "正在使用原生扫码…" : "选择二维码图片，或重新打开相机。"}</p></div>
        <div className="pairing-actions"><button className="secondary" type="button" disabled={phase !== "idle"} onClick={() => imageRef.current?.click()}>选择本地图片</button><button className="secondary" type="button" disabled={phase !== "idle"} onClick={() => setCameraOpen(true)}>重新扫码</button></div>
      </>}
      <button className="secondary" type="button" disabled={phase !== "idle" || pending.current} onClick={() => void readNative()}>使用原生扫码</button>
      <input ref={imageRef} type="file" accept="image/*" hidden aria-label="选择 Composer 同步二维码图片" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; void readImage(file); }} />
      <input ref={photoRef} type="file" accept="image/*" capture="environment" hidden aria-label="拍摄 Composer 同步二维码" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; void readImage(file); }} />
      {message ? <p className="mobile-connect-error" role="alert">{message}</p> : null}
    </section>
  </main>;

  return <main className="page-main mobile-composer-transfer-page">
    <section className="mobile-composer-transfer-hero" aria-labelledby="mobile-composer-transfer-title">
      <h1 id="mobile-composer-transfer-title">同步 Composer</h1>
      <p className="mobile-composer-transfer-lead">扫描 Mac 或另一台手机上的同步二维码，选择文字、图片和文件，先检查，再放入目标输入框。</p>
      {message ? <p className="workbench-page-error" role="alert">{message}</p> : null}
      <button className="mobile-composer-transfer-cta" type="button" onClick={openScanner}>
        <span><strong>开始扫一扫</strong><small>支持相机扫码和选择二维码图片</small></span>
      </button>
      <div className="mobile-composer-transfer-steps" aria-label="使用步骤">
        <div><span>01</span><strong>扫描</strong><small>获取目标 Composer</small></div>
        <div><span>02</span><strong>选择</strong><small>文字、图片或多个文件</small></div>
        <div><span>03</span><strong>确认</strong><small>在电脑端加入草稿</small></div>
      </div>
      <p className="mobile-composer-transfer-footnote">内容不会自动执行或发送，只有目标设备点击“加入 Composer”后才会进入草稿。</p>
    </section>
  </main>;
}
