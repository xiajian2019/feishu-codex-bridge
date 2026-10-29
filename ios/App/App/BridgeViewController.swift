import Capacitor

class BridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(BridgeCredentialsPlugin())
        bridge?.registerPluginInstance(BridgeShareInboxPlugin())
    }
}
