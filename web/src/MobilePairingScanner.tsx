import { useEffect, useRef, useState, type ReactElement } from "react";
import { flushSync } from "react-dom";
import { PairingScanner } from "./PairingScanner.js";
import { decodePairingImage } from "./pairing-qr.js";
import { useMobileBack } from "./use-mobile-back.js";
import { scanMobilePairingQr } from "./mobile-runtime.js";

type ScanPhase = "idle" | "reading" | "pairing" | "native";

export default function MobilePairingScanner({ onPair, onClose }: {
  onPair: (value: string) => Promise<void>;
  onClose: () => void;
}): ReactElement {
  const [camera, setCamera] = useState(true);
  const [phase, setPhase] = useState<ScanPhase>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const imageRef = useRef<HTMLInputElement>(null);
  const photoRef = useRef<HTMLInputElement>(null);
  const pending = useRef(false);
  const active = useRef(true);

  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);

  useMobileBack(true, () => { if (phase !== "pairing" && phase !== "native") onClose(); }, 1000);

  useEffect(() => {
    const inputs = [imageRef.current, photoRef.current];
    const cancel = (): void => { if (!pending.current) setCamera(true); };
    inputs.forEach((input) => input?.addEventListener("cancel", cancel));
    return () => inputs.forEach((input) => input?.removeEventListener("cancel", cancel));
  }, []);

  const pair = async (value: string): Promise<void> => {
    if (!active.current) return;
    setCamera(false);
    setPhase("pairing");
    setMessage(null);
    try { await onPair(value); }
    catch (cause) {
      if (active.current) setMessage(cause instanceof Error ? cause.message : "配对失败，请重新扫描或选择图片。");
    } finally {
      pending.current = false;
      if (active.current) setPhase("idle");
    }
  };

  const readCamera = (value: string): void => {
    if (pending.current) return;
    pending.current = true;
    void pair(value);
  };

  const selectImage = (photo = false): void => {
    if (pending.current) return;
    setCamera(false);
    setMessage(null);
    (photo ? photoRef : imageRef).current?.click();
  };

  const readImage = async (file: File | undefined): Promise<void> => {
    if (!file || pending.current) return;
    pending.current = true;
    setCamera(false);
    setPhase("reading");
    setMessage(null);
    try {
      const value = await decodePairingImage(file);
      if (active.current) await pair(value);
    } catch (cause) {
      if (active.current) setMessage(cause instanceof Error ? cause.message : "图片识别失败，请选择清晰的二维码图片。");
    } finally {
      pending.current = false;
      if (active.current) setPhase("idle");
    }
  };

  const readNative = async (): Promise<void> => {
    if (pending.current) return;
    pending.current = true;
    // Release the WebView camera before the native scanner acquires it.
    flushSync(() => { setCamera(false); setPhase("native"); setMessage(null); });
    try {
      const value = await scanMobilePairingQr();
      if (value && active.current) await pair(value);
    } catch (cause) {
      if (active.current) setMessage(cause instanceof Error ? cause.message : "原生扫码失败，可重试或使用相机、拍照和本地图片。");
    } finally {
      pending.current = false;
      if (active.current) { setPhase("idle"); setCamera(true); }
    }
  };

  return <main className="mobile-connect-page mobile-pairing-page">
    <section className="mobile-connect-card mobile-pairing-card" aria-labelledby="mobile-pairing-title">
      <header className="mobile-pairing-header">
        <button type="button" className="mobile-connect-secondary" aria-label="返回连接设置" disabled={phase === "pairing" || phase === "native"} onClick={onClose}>‹</button>
        <div><h1 id="mobile-pairing-title">扫码配对</h1><p>扫描二维码，或从本地图片中识别。</p></div>
      </header>
      {camera ? <PairingScanner onDecode={readCamera} onClose={onClose}
        onPhoto={() => selectImage(true)} onImage={() => selectImage()} /> : <>
        <div className="mobile-pairing-placeholder" role="status">
          <span aria-hidden="true">▦</span>
          <p>{phase === "reading" ? "正在识别二维码…" : phase === "pairing" ? "正在连接并配对…" : phase === "native" ? "正在使用原生扫码…" : "选择二维码图片，或重新打开相机。"}</p>
        </div>
        <div className="pairing-actions">
          <button className="secondary" type="button" disabled={phase !== "idle"} onClick={() => selectImage()}>选择本地图片</button>
          <button className="secondary" type="button" disabled={phase !== "idle"} onClick={() => { setMessage(null); setCamera(true); }}>重新扫码</button>
        </div>
      </>}
      <button className="secondary" type="button" disabled={phase !== "idle"} onClick={() => void readNative()}>使用原生扫码</button>
      <input ref={imageRef} type="file" accept="image/*" hidden aria-label="选择本地配对二维码图片"
        onChange={(event) => {
          const file = event.target.files?.[0]; event.target.value = ""; void readImage(file);
        }} />
      <input ref={photoRef} type="file" accept="image/*" capture="environment" hidden aria-label="拍摄 App 配对二维码"
        onChange={(event) => {
          const file = event.target.files?.[0]; event.target.value = ""; void readImage(file);
        }} />
      {message ? <p className="mobile-connect-error" role="alert">{message}</p> : null}
    </section>
  </main>;
}
