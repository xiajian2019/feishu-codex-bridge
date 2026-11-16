// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "BridgeLwIP",
    platforms: [
        .iOS(.v15),
        .macOS(.v12)
    ],
    products: [
        .library(name: "BridgeLwIP", targets: ["BridgeLwIP"])
    ],
    targets: [
        .target(
            name: "BridgeLwIP",
            path: "Sources/BridgeLwIP",
            exclude: ["conf", "ThirdParty/lwip/src/apps"],
            publicHeadersPath: "include",
            cSettings: [
                .headerSearchPath("conf"),
                .headerSearchPath("ThirdParty/lwip/src/include"),
                .headerSearchPath("ThirdParty/lwip/port/include"),
                .define("LWIP_ERRNO_STDINCLUDE"),
                .unsafeFlags(["-fno-modules"])
            ]
        ),
        .target(name: "BridgeLwIPTestSupport", path: "Tests/BridgeLwIPTestSupport", publicHeadersPath: "include"),
        .testTarget(name: "BridgeLwIPTests", dependencies: ["BridgeLwIP", "BridgeLwIPTestSupport"])
    ]
)
