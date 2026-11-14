// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "BridgeCrashDiagnostics",
    platforms: [.iOS(.v15), .macOS(.v12)],
    products: [.library(name: "BridgeCrashDiagnostics", targets: ["BridgeCrashDiagnostics"])],
    dependencies: [
        .package(url: "https://github.com/microsoft/plcrashreporter.git", exact: "1.12.2")
    ],
    targets: [
        .target(name: "BridgeCrashDiagnostics", dependencies: [
            .product(name: "CrashReporter", package: "plcrashreporter")
        ]),
        .testTarget(name: "BridgeCrashDiagnosticsTests", dependencies: ["BridgeCrashDiagnostics"])
    ]
)
