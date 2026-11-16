package dev.feishu.codex.bridge

/** Route SSH transport failures to the currently attached top-level VPN controller. */
internal object BridgeAutoVpnRecoverySignal {
    private var listener: Runnable? = null

    @Synchronized
    fun attach(next: Runnable) { listener = next }

    @Synchronized
    fun detach(previous: Runnable) {
        if (listener === previous) listener = null
    }

    fun request() {
        val current = synchronized(this) { listener }
        current?.run()
    }
}
