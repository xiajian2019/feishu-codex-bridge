import { expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateDatabase } from "../src/db.js";
import { TmuxDashboardApi } from "../src/tmux-dashboard-api.js";
import { DashboardServer } from "../src/web.js";
import { WebPairingAuth } from "../src/web-auth.js";

it("relays a phone Composer transfer through a one-time target and imports it into the scoped session", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-composer-transfer-"));
  const db = new StateDatabase(":memory:");
  const session = { id: "$41", name: "transfer", cwd: root, createdAt: 41, windows: 1, attachedClients: 0 };
  db.recordTmuxSession(session);
  const tmux = new TmuxDashboardApi({
    db,
    attachmentDirectory: join(root, "attachments"),
    operations: {
      listSessions: async () => [session],
      findSession: async () => session,
      createSession: async () => session,
      killSession: async () => {},
      inspectReviewPane: async () => ({ paneId: "%41", panePid: 41, paneTty: "/dev/ttys041", currentCommand: "zsh", cwd: root, foregroundCodex: null }),
      pasteTextToPane: async () => {},
      sendEnterToPane: async () => {},
    },
  });
  const auth = new WebPairingAuth({ db });
  const remote = { headers: {}, socket: { remoteAddress: "203.0.113.41" } } as IncomingMessage;
  const sessionToken = auth.claimPairing(remote, auth.startPairing().code);
  const server = new DashboardServer({
    db,
    auth,
    tmuxDashboard: tmux,
    host: "127.0.0.1",
    port: 0,
    modes: [],
    cleanupExpiredStagedAttachments: false,
  });
  try {
    const base = await server.start();
    const cookie = { Cookie: `bridge_session=${sessionToken}` };
    const sessionResponse = await fetch(base + "/api/session", { headers: cookie });
    const { actionToken } = await sessionResponse.json() as { actionToken: string };
    const targetHeaders = {
      ...cookie,
      Origin: base,
      "X-Bridge-Action-Token": actionToken,
      "X-Bridge-Session-Created-At": "41",
      "Content-Type": "application/json",
    };
    const targetResponse = await fetch(base + "/tmux-dashboard/api/sessions/%2441/composer-transfer", {
      method: "POST", headers: targetHeaders, body: "{}",
    });
    expect(targetResponse.status).toBe(201);
    const target = await targetResponse.json() as { targetId: string; code: string };
    expect(target.code).toMatch(/^[A-HJ-NP-Z2-9]{10}$/);

    const invalidClaimResponse = await fetch(base + "/api/composer-transfers/claim", {
      method: "POST", headers: { Origin: "capacitor://localhost", "Content-Type": "application/json" }, body: JSON.stringify({ code: "77JPC3SXGH" }),
    });
    expect(invalidClaimResponse.status).toBe(404);

    session.name = "renamed-transfer";
    db.recordTmuxSession(session);
    const claimResponse = await fetch(base + "/api/composer-transfers/claim", {
      method: "POST", headers: { Origin: "capacitor://localhost", "Content-Type": "application/json" }, body: JSON.stringify({ code: target.code, sessionName: "spoofed" }),
    });
    expect(claimResponse.status).toBe(200);
    const claim = await claimResponse.json() as { transferId: string; transferToken: string; target: { sessionId: string; sessionCreatedAt: number; sessionName: string | null } };
    expect(claim.target).toEqual({ sessionId: "$41", sessionCreatedAt: 41, sessionName: "renamed-transfer" });

    const transferHeaders = { Origin: "capacitor://localhost", "Content-Type": "application/json", "X-Bridge-Transfer-Token": claim.transferToken };
    const textResponse = await fetch(`${base}/api/composer-transfers/${claim.transferId}/text`, {
      method: "POST", headers: transferHeaders, body: JSON.stringify({ text: "来自手机的调试信息" }),
    });
    expect(textResponse.status).toBe(200);
    const itemResponse = await fetch(`${base}/api/composer-transfers/${claim.transferId}/items`, {
      method: "POST", headers: transferHeaders, body: JSON.stringify({ fileName: "icon.svg", contentType: "image/svg+xml", sizeBytes: 3 }),
    });
    expect(itemResponse.status).toBe(201);
    const item = await itemResponse.json() as { itemId: string };
    const uploadResponse = await fetch(`${base}/api/composer-transfers/${claim.transferId}/items/${item.itemId}?offset=0`, {
      method: "PUT", headers: { ...transferHeaders, "Content-Type": "application/octet-stream" }, body: "svg",
    });
    expect(uploadResponse.status).toBe(200);
    const completeItemResponse = await fetch(`${base}/api/composer-transfers/${claim.transferId}/items/${item.itemId}/complete`, {
      method: "POST", headers: transferHeaders, body: "{}",
    });
    expect(completeItemResponse.status).toBe(200);
    expect((await completeItemResponse.json() as { status: string }).status).toBe("ready");
    const finishResponse = await fetch(`${base}/api/composer-transfers/${claim.transferId}/complete`, {
      method: "POST", headers: transferHeaders, body: "{}",
    });
    expect(finishResponse.status).toBe(200);

    const inboxResponse = await fetch(`${base}/tmux-dashboard/api/sessions/%2441/composer-transfer/${target.targetId}`, {
      headers: { ...cookie, "X-Bridge-Session-Created-At": "41" },
    });
    expect(inboxResponse.status).toBe(200);
    const inbox = await inboxResponse.json() as { transfers: Array<{ text: string; items: Array<{ itemId: string }> }> };
    expect(inbox.transfers).toHaveLength(1);
    expect(inbox.transfers[0]).toMatchObject({ text: "来自手机的调试信息", items: [{ itemId: item.itemId }] });

    const fileResponse = await fetch(`${base}/tmux-dashboard/api/sessions/%2441/composer-transfer/${target.targetId}/${claim.transferId}/items/${item.itemId}`, {
      headers: { ...cookie, "X-Bridge-Session-Created-At": "41" },
    });
    expect(fileResponse.status).toBe(200);
    expect(await fileResponse.text()).toBe("svg");

    const consumeResponse = await fetch(`${base}/tmux-dashboard/api/sessions/%2441/composer-transfer/${target.targetId}/${claim.transferId}/consume`, {
      method: "POST", headers: targetHeaders, body: "{}",
    });
    expect(consumeResponse.status).toBe(200);
    expect((await consumeResponse.json() as { status: string }).status).toBe("imported");
    const after = await (await fetch(`${base}/tmux-dashboard/api/sessions/%2441/composer-transfer/${target.targetId}`, {
      headers: { ...cookie, "X-Bridge-Session-Created-At": "41" },
    })).json() as { transfers: unknown[] };
    expect(after.transfers).toHaveLength(0);

    const secondTargetResponse = await fetch(base + "/tmux-dashboard/api/sessions/%2441/composer-transfer", {
      method: "POST", headers: targetHeaders, body: "{}",
    });
    expect(secondTargetResponse.status).toBe(201);
    const secondTarget = await secondTargetResponse.json() as { targetId: string; code: string };
    const secondClaimResponse = await fetch(base + "/api/composer-transfers/claim", {
      method: "POST", headers: { Origin: "capacitor://localhost", "Content-Type": "application/json" }, body: JSON.stringify({ code: secondTarget.code }),
    });
    expect(secondClaimResponse.status).toBe(200);
    const secondClaim = await secondClaimResponse.json() as { transferId: string; transferToken: string };
    const secondTransferHeaders = { ...transferHeaders, "X-Bridge-Transfer-Token": secondClaim.transferToken };
    expect((await fetch(`${base}/api/composer-transfers/${secondClaim.transferId}/text`, {
      method: "POST", headers: secondTransferHeaders, body: JSON.stringify({ text: "准备接收" }),
    })).status).toBe(200);
    expect((await fetch(`${base}/api/composer-transfers/${secondClaim.transferId}/complete`, {
      method: "POST", headers: secondTransferHeaders, body: "{}",
    })).status).toBe(200);
    expect((await fetch(`${base}/tmux-dashboard/api/sessions/%2441/composer-transfer/${secondTarget.targetId}`, {
      method: "DELETE", headers: targetHeaders,
    })).status).toBe(200);
    expect((await fetch(`${base}/api/composer-transfers/${secondClaim.transferId}/text`, {
      method: "POST", headers: secondTransferHeaders, body: JSON.stringify({ text: "不应继续接收" }),
    })).status).toBe(410);
  } finally {
    await server.stop();
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
