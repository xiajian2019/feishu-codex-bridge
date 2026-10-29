/** Keeps the live connection unchanged during probing and seals the old UI on commit. */
export function createMobileConnectionSwitch() {
  let phase: "idle" | "probing" | "committed" = "idle";
  let writes = 0;
  return {
    beforeRequest(method: string): () => void {
      const write = !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
      if (phase === "committed" || (phase === "probing" && write)) {
        throw new DOMException("正在切换 Bridge 环境，请等待页面重新载入后重试。", "AbortError");
      }
      if (write) writes += 1;
      let released = false;
      return () => { if (!released && write) writes -= 1; released = true; };
    },
    async run<T>(probe: () => Promise<T>, commit: (value: T) => boolean): Promise<T> {
      if (phase !== "idle") throw new Error("环境正在切换，请等待当前操作完成。");
      if (writes > 0) throw new Error("仍有请求正在提交，请等待发送或上传完成后再切换环境。");
      phase = "probing";
      try {
        const value = await probe();
        // A successful commit must reload the page. Until then, old effects must
        // not send even a late upload chunk or render a response from the new API.
        phase = commit(value) ? "committed" : "idle";
        return value;
      } catch (error) {
        phase = "idle";
        throw error;
      }
    },
  };
}
