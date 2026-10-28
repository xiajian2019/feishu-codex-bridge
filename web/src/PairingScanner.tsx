import { useEffect, useRef, useState, type ReactElement } from "react";
import { loadPairingScanner, type PairingScannerInstance } from "./pairing-scanner.js";
import { recordPairingScan } from "./pairing-diagnostics.js";

export function PairingScanner({ onDecode, onClose, onPhoto, onImage }: {
  onDecode: (value: string) => void;
  onClose: () => void;
  onPhoto: () => void;
  onImage?: () => void;
}): ReactElement {
  const stopRef = useRef<(() => void) | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const decodeRef = useRef(onDecode);
  const closeRef = useRef(onClose);
  decodeRef.current = onDecode;
  closeRef.current = onClose;
  const [message, setMessage] = useState("正在请求摄像头权限…");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let decoded = false;
    let scanner: PairingScannerInstance | null = null;
    const video = videoRef.current;
    const stop = (): void => {
      cancelled = true;
      scanner?.destroy();
      if (video?.srcObject instanceof MediaStream) video.srcObject.getTracks().forEach((track) => track.stop());
      if (video) video.srcObject = null;
    };
    stopRef.current = stop;
    // System image pickers can hide the WebView after an explicit stop.
    const hide = (): void => { if (document.hidden && !cancelled) { stop(); closeRef.current(); } };
    document.addEventListener("visibilitychange", hide);
    window.addEventListener("pagehide", stop);
    void (async () => {
      try {
        const Scanner = await loadPairingScanner();
        if (cancelled || !video) return;
        scanner = new Scanner(video, (result) => {
          if (cancelled || decoded) return;
          decoded = true;
          recordPairingScan({ mode: "camera", outcome: "decoded", width: video.videoWidth, height: video.videoHeight, attempts: 0 });
          scanner?.stop();
          decodeRef.current(result.data);
        }, { preferredCamera: "environment", maxScansPerSecond: 5, highlightScanRegion: true,
          highlightCodeOutline: true, returnDetailedScanResult: true, onDecodeError: () => {} });
        scanner.setInversionMode("both");
        await scanner.start();
        if (cancelled) { scanner.destroy(); return; }
        setMessage("将完整二维码放入扫描框，识别后自动登录，无需拍照确认。");
      } catch (error) {
        if (cancelled) return;
        scanner?.destroy();
        const detail = error instanceof Error ? error.name + " " + error.message : String(error);
        const denied = /NotAllowed|Permission|permission|denied/.test(detail);
        recordPairingScan({ mode: "camera", outcome: denied ? "permission_denied" : "camera_error", width: null, height: null, attempts: 0 });
        setFailed(true);
        setMessage(onImage ? denied
          ? "相机权限未开启，请允许 Bridge 使用相机，或选择本地二维码图片。"
          : "暂时无法打开相机，可选择本地二维码图片或拍照识别。"
          : denied ? "摄像头权限被拒绝，请允许访问摄像头后重试。"
          : /NotFound|not found|No camera/.test(detail) ? "没有找到可用摄像头，请检查浏览器和系统权限。"
          : "摄像头或扫码组件启动失败，请关闭占用摄像头的应用后重试，也可以选择二维码图片。");
      }
    })();
    return () => { stop(); stopRef.current = null; document.removeEventListener("visibilitychange", hide); window.removeEventListener("pagehide", stop); };
  }, []);

  return <div className="pairing-camera" role="region" aria-label="实时扫码">
    <div className="pairing-camera-video"><video ref={videoRef} autoPlay muted playsInline aria-label="配对二维码扫描画面" /></div>
    <p className={failed ? "pairing-error" : "pairing-note"} role={failed ? "alert" : "status"}>{message}</p>
    <div className="pairing-actions">
      {onImage ? <button className="secondary" type="button" onClick={() => { stopRef.current?.(); onImage(); }}>选择本地图片</button> : null}
      <button className="secondary" type="button" onClick={() => { stopRef.current?.(); onPhoto(); }}>{onImage ? "拍照识别" : "改用拍照识别"}</button>
      <button className="secondary" type="button" onClick={onClose}>{failed ? "关闭扫描" : "取消扫描"}</button>
    </div>
  </div>;
}
