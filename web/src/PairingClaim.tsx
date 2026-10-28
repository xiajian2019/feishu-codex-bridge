import { useEffect, useRef, useState, type ReactElement } from "react";
import { diagnosticStorage, diagnosePairing, readAuthEvidence, readPairingScan, type AuthStatus } from "./pairing-diagnostics.js";
import { decodePairingImage, parsePairingInput } from "./pairing-qr.js";
import { PairingScanner } from "./PairingScanner.js";
import { pairingScanMode } from "./pairing-scanner.js";

function formatDate(value: string | number | null | undefined): string {
  return value && Number.isFinite(new Date(value).getTime()) ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "暂无记录";
}

export function PairingClaim({ status, error, onClaim, onRefresh }: {
  status: AuthStatus | null;
  error: string | null;
  onClaim: (code: string) => Promise<void>;
  onRefresh: () => Promise<void>;
}): ReactElement {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [camera, setCamera] = useState(false);
  const [copyState, setCopyState] = useState<string | null>(null);
  const [report, setReport] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [lastScan, setLastScan] = useState(readPairingScan);
  const imageRef = useRef<HTMLInputElement>(null);
  const photoRef = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);
  const scanMode = pairingScanMode(window.location.protocol, window.isSecureContext, Boolean(navigator.mediaDevices?.getUserMedia));
  const evidence = readAuthEvidence();
  const diagnosis = diagnosePairing(status, evidence);
  const available = Boolean(status?.pairingAvailable && status.pairingExpiresAt && status.pairingExpiresAt > now);

  const submit = async (value: string): Promise<void> => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setMessage(null);
    setCamera(false);
    try { await onClaim(parsePairingInput(value, window.location.origin)); }
    catch (failure) { setMessage(failure instanceof Error ? failure.message : "配对失败，请重试。"); }
    finally { busyRef.current = false; setBusy(false); }
  };
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const readImage = async (file: File | undefined): Promise<void> => {
    if (!file || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setMessage(null);
    setCamera(false);
    try {
      const value = await decodePairingImage(file, setLastScan);
      busyRef.current = false;
      await submit(value);
    } catch (failure) {
      setMessage(failure instanceof Error ? failure.message : "二维码识别失败，请重试。");
    } finally { busyRef.current = false; setBusy(false); }
  };

  const exportReport = (): void => {
    const payload = JSON.stringify({
      version: 1, capturedAt: new Date().toISOString(),
      browser: { origin: window.location.origin, userAgent: navigator.userAgent, cookieEnabled: navigator.cookieEnabled,
        secureContext: window.isSecureContext, online: navigator.onLine, storageAvailable: diagnosticStorage() !== null },
      server: status?.diagnostics ?? null, diagnosis, evidence: readAuthEvidence(), scan: readPairingScan(),
    }, null, 2);
    setReport(payload);
    const copy = async (): Promise<void> => {
      try {
        if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(payload);
        else {
          const field = document.createElement("textarea");
          field.value = payload;
          field.style.cssText = "position:fixed;top:0;left:-9999px;font-size:16px";
          document.body.appendChild(field);
          try { field.select(); if (!document.execCommand("copy")) throw new Error("copy unavailable"); }
          finally { field.remove(); }
        }
        setCopyState("诊断信息已复制");
      } catch { setCopyState("自动复制不可用，请复制下方诊断文本。"); }
    };
    void copy();
  };

  return <section className="pairing-card pairing-claim-card">
    <h1>设备配对</h1>
    <p className="pairing-description">在 Mac 上执行 <code>web:pair</code> 生成二维码，或在已登录设备的“设备配对”中生成。</p>
    <div className="pairing-actions">
      <button className="primary" type="button" disabled={busy || camera} onClick={() => {
        setMessage(null);
        if (scanMode === "live") setCamera(true);
        else photoRef.current?.click();
      }}>{busy ? "正在配对…" : "扫码配对"}</button>
      <button className="secondary" type="button" disabled={busy} onClick={() => imageRef.current?.click()}>选择二维码图片</button>
    </div>
    <input ref={imageRef} type="file" accept="image/*" hidden aria-label="选择配对二维码图片" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; void readImage(file); }} />
    <input ref={photoRef} type="file" accept="image/*" capture="environment" hidden aria-label="拍摄配对二维码" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; void readImage(file); }} />
    <p className="pairing-note">{scanMode === "live" ? "对准二维码即可自动配对，无需拍照确认。" : window.location.protocol === "http:" ? "当前为 HTTP 访问，扫码将打开相机拍摄二维码后识别；也可选择二维码图片。" : "当前浏览器不支持实时扫码，将使用拍照识别。"}</p>
    {camera ? <PairingScanner onDecode={(value) => { setLastScan(readPairingScan()); void submit(value); }} onClose={() => { setCamera(false); setLastScan(readPairingScan()); }} onPhoto={() => { setCamera(false); setLastScan(readPairingScan()); photoRef.current?.click(); }} /> : null}
    <details className="pairing-manual">
      <summary>输入配对链接或配对码</summary>
      <form className="pairing-form" onSubmit={(event) => { event.preventDefault(); void submit(input); }}>
        <label htmlFor="pairing-input">配对链接 / 配对码<input id="pairing-input" value={input} onChange={(event) => setInput(event.target.value)} autoComplete="off" autoCapitalize="off" spellCheck={false} placeholder="粘贴配对链接或 12 位配对码" /></label>
        <button type="submit" disabled={busy || !input.trim()}>登录配对</button>
      </form>
    </details>
    {message || error ? <p className="pairing-error" role="alert">{message || error}</p> : null}
    <p className="pairing-note" role="status">{available ? "二维码已生成，5 分钟内有效，只能使用一次。" : "请使用新生成的配对二维码（5 分钟内有效）。"}</p>
    <div className="pairing-diagnosis"><strong>{diagnosis.title}</strong><p>{diagnosis.detail}</p></div>
    <details className="pairing-diagnostics">
      <summary>配对诊断</summary>
      <dl>
        <dt>当前地址</dt><dd>{window.location.origin}</dd>
        <dt>服务端收到 Cookie</dt><dd>{status?.diagnostics ? status.diagnostics.cookiePresent ? `是（${status.diagnostics.cookieCount} 份）` : "否" : "未知"}</dd>
        <dt>上次成功访问</dt><dd>{formatDate(evidence.lastSuccess?.at)}</dd>
        <dt>上次授权到期</dt><dd>{formatDate(evidence.lastSuccess?.expiresAt)}</dd>
        <dt>当前会话到期</dt><dd>{formatDate(status?.diagnostics?.sessionExpiresAt)}</dd>
        <dt>服务标识</dt><dd>{status?.diagnostics?.installationId ?? "未知"}</dd>
        <dt>服务器时间</dt><dd>{formatDate(status?.diagnostics?.serverTime)}</dd>
        {lastScan ? <><dt>最近扫码</dt><dd>{lastScan.mode === "image" ? "图片" : "摄像头"} · {lastScan.outcome === "decoded" ? "已识别" : lastScan.outcome === "not_detected" ? "未识别" : lastScan.outcome === "camera_blocked" ? "浏览器限制" : lastScan.outcome === "permission_denied" ? "权限被拒绝" : "读取失败"}{lastScan.width && lastScan.height ? ` · ${lastScan.width}×${lastScan.height}` : ""}{lastScan.attempts ? ` · ${lastScan.attempts} 次识别` : ""}</dd></> : null}
      </dl>
      {!evidence.lastSuccess ? <p className="pairing-note">本浏览器暂无成功记录；启用诊断前的记录无法回溯，换地址或清理存储也会使记录不可见。</p> : null}
      {status?.diagnostics && Math.abs(Date.parse(status.diagnostics.serverTime) - Date.now()) > 5 * 60_000 ? <p className="pairing-note">设备与服务器时间相差超过 5 分钟，请检查系统时间。</p> : null}
      <div className="pairing-actions">
        <button className="secondary" type="button" disabled={busy} onClick={() => {
          setMessage(null); setBusy(true);
          void onRefresh().catch((failure: unknown) => setMessage(failure instanceof Error ? failure.message : "检查失败，请重试。")).finally(() => setBusy(false));
        }}>重新检查</button>
        <button className="secondary" type="button" onClick={exportReport}>复制诊断信息</button>
      </div>
      {copyState ? <p className="pairing-note" role="status">{copyState}</p> : null}
      {report ? <textarea className="pairing-report" aria-label="配对诊断信息" readOnly value={report} rows={8} /> : null}
    </details>
  </section>;
}
