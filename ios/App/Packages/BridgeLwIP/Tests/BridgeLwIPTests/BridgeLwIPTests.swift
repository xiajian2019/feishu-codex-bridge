import BridgeLwIP
import BridgeLwIPTestSupport
import XCTest

private func ignorePacket(_ packet: UnsafePointer<UInt8>?, _ length: Int, _ context: UnsafeMutableRawPointer?) {}

final class BridgeLwIPTests: XCTestCase {
    func testStartStopAndRestart() {
        var invalid = bridge_lwip_config(local_address: nil, address_mask: nil, gateway_address: nil, mtu: 1400)
        XCTAssertEqual(bridge_lwip_start(&invalid, ignorePacket, nil), -1)
        "10.8.0.2".withCString { address in
            "255.255.255.0".withCString { mask in
                "10.8.0.1".withCString { gateway in
                    var config = bridge_lwip_config(local_address: address, address_mask: mask, gateway_address: gateway, mtu: 1400)
                    for attempt in 1...2 {
                        let result = bridge_lwip_start(&config, ignorePacket, nil)
                        XCTAssertEqual(result, 0, "attempt \(attempt): \(String(cString: bridge_lwip_last_error()))")
                        if result != 0 { return }
                        bridge_lwip_stop()
                    }
                }
            }
        }
    }
}
