import Capacitor
import CommonCrypto
import CryptoKit
import Foundation
import Security
import UIKit

// The native remote desktop is deliberately an iOS-only surface. The WebView
// supplies a short-lived, single-use stream ticket; this file never receives a
// device bearer token and never persists VNC credentials.
@objc(BridgeRemoteDesktopPlugin)
public final class BridgeRemoteDesktopPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "BridgeRemoteDesktopPlugin"
    public let jsName = "BridgeRemoteDesktop"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "close", returnType: CAPPluginReturnPromise),
    ]

    private weak var activeWorkspace: BridgeRemoteDesktopViewController?

    @objc func open(_ call: CAPPluginCall) {
        let queryItems = URLComponents(string: call.getString("url") ?? "")?.queryItems ?? []
        guard let rawURL = call.getString("url"),
              let url = URL(string: rawURL),
              let scheme = url.scheme?.lowercased(),
              (scheme == "ws" || scheme == "wss"),
              url.user == nil,
              url.password == nil,
              url.fragment == nil,
              url.path == "/remote-desktop/stream",
              queryItems.count == 1,
              url.queryItems(named: "bridgeTicket").count == 1,
              url.queryItems(named: "bridgeTicket").first?.value?.range(of: #"^[A-Za-z0-9_-]{43}$"#, options: .regularExpression) != nil else {
            call.reject("原生远程桌面地址无效，请返回页面后重试。", "INVALID_STREAM_URL")
            return
        }
        let title = String((call.getString("title") ?? "远程桌面").prefix(120))
        DispatchQueue.main.async { [weak self] in
            guard let self else {
                call.reject("原生远程桌面不可用。", "NATIVE_DESKTOP_UNAVAILABLE")
                return
            }
            guard let presenter = self.bridge?.viewController,
                  presenter.viewIfLoaded?.window != nil else {
                call.reject("Bridge 页面尚未准备好，请稍后重试。", "PRESENTER_UNAVAILABLE")
                return
            }
            if let workspace = self.activeWorkspace {
                workspace.connect(url: url)
                call.resolve()
                return
            }
            let workspace = BridgeRemoteDesktopViewController(url: url, title: title)
            workspace.onClosed = { [weak self, weak workspace] in
                guard let self, self.activeWorkspace === workspace else { return }
                self.activeWorkspace = nil
                self.notifyListeners("workspaceClosed", data: [:])
            }
            workspace.onReconnectRequested = { [weak self, weak workspace] reason in
                guard let self, self.activeWorkspace === workspace else { return }
                self.notifyListeners("reconnectRequested", data: ["reason": reason], retainUntilConsumed: true)
            }
            self.activeWorkspace = workspace
            workspace.modalPresentationStyle = .fullScreen
            presenter.present(workspace, animated: true) {
                call.resolve()
            }
        }
    }

    @objc func close(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            self?.activeWorkspace?.closeWorkspace()
            call.resolve()
        }
    }
}

private extension URL {
    func queryItems(named name: String) -> [URLQueryItem] {
        URLComponents(url: self, resolvingAgainstBaseURL: false)?.queryItems?.filter { $0.name == name } ?? []
    }
}

private struct BridgeRemoteDesktopFrame {
    let width: Int
    let height: Int
    let pixels: Data
}

private final class BridgeRemoteDesktopViewController: UIViewController, UITextViewDelegate {
    private let initialURL: URL
    private let desktopTitle: String
    private var client: BridgeRemoteDesktopClient?
    private var didNotifyClosed = false
    private var isViewOnly = false
    private var remoteClipboard = ""
    private var frameCount = 0
    private var fpsTimer: Timer?
    private let frameQueue = DispatchQueue(label: "dev.feishu.codex.bridge.remote-desktop.frames", qos: .userInitiated)
    private var pendingFrame: BridgeRemoteDesktopFrame?
    private var renderingFrame = false
    private var connected = false
    private var controlsExpanded = false
    private var clipboardOpen = false
    private var panMode = false
    private var immersiveMode = false
    private var currentLayoutIsLandscape = false
    private var currentLayoutReservesControls = false
    private var hasAppliedLayout = false

    var onClosed: (() -> Void)?
    var onReconnectRequested: ((String) -> Void)?

    private let canvas = BridgeRemoteDesktopCanvasView()
    private let topBar = UIView()
    private let statusLabel = UILabel()
    private let fpsLabel = UILabel()
    private let titleLabel = UILabel()
    private let placeholderLabel = UILabel()
    private let retryButton = UIButton(type: .system)
    private let controlsPanel = UIView()
    private let controlsScroll = UIScrollView()
    private let controlsStack = UIStackView()
    private let collapsedControlsPanel = UIView()
    private let collapsedControlsStack = UIStackView()
    private let keyboardPanel = UIView()
    private let keyboardInput = UITextView()
    private let keyboardSendButton = UIButton(type: .system)
    private let clipboardPanel = UIView()
    private let clipboardInput = UITextView()
    private let clipboardSendButton = UIButton(type: .system)
    private let clipboardCopyButton = UIButton(type: .system)
    private let keyboardButton = UIButton(type: .system)
    private let moreButton = UIButton(type: .system)
    private var keyboardPanelVisible = false
    private var topBarHeightConstraint: NSLayoutConstraint!
    private var controlsPanelPortraitConstraints: [NSLayoutConstraint] = []
    private var controlsPanelLandscapeConstraints: [NSLayoutConstraint] = []
    private var canvasFullWidthConstraint: NSLayoutConstraint!
    private var canvasLandscapeWidthConstraint: NSLayoutConstraint!

    init(url: URL, title: String) {
        initialURL = url
        desktopTitle = title.isEmpty ? "远程桌面" : title
        super.init(nibName: nil, bundle: nil)
        modalPresentationCapturesStatusBarAppearance = true
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override var prefersStatusBarHidden: Bool { true }
    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 0.035, green: 0.045, blue: 0.07, alpha: 1)
        buildView()
        connect(url: initialURL)
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        guard isBeingDismissed || navigationController?.isBeingDismissed == true else { return }
        client?.disconnect()
        fpsTimer?.invalidate()
        fpsTimer = nil
        notifyClosedIfNeeded()
    }

    func connect(url: URL) {
        guard isViewLoaded else { return }
        client?.disconnect()
        let next = BridgeRemoteDesktopClient(url: url)
        client = next
        setConnectingState()
        next.onCredentialsRequired = { [weak self] types in
            DispatchQueue.main.async { self?.showCredentials(types: types) }
        }
        next.onConnected = { [weak self] name, width, height in
            DispatchQueue.main.async {
                guard let self else { return }
                self.connected = true
                self.statusLabel.text = "已连接"
                self.statusLabel.textColor = UIColor(red: 0.35, green: 0.95, blue: 0.62, alpha: 1)
                self.titleLabel.text = name.isEmpty ? self.desktopTitle : name
                self.placeholderLabel.isHidden = true
                self.retryButton.isHidden = true
                self.setControlsExpanded(false)
                self.canvas.setFramebufferSize(width: width, height: height)
                self.startFPSCounter()
            }
        }
        next.onFrame = { [weak self] frame in
            self?.enqueueFrame(frame)
        }
        next.onClipboard = { [weak self] text in
            DispatchQueue.main.async {
                self?.remoteClipboard = text
                self?.clipboardInput.text = text
                self?.statusLabel.text = "收到远程剪贴板"
            }
        }
        next.onError = { [weak self] message in
            DispatchQueue.main.async { self?.setErrorState(message) }
        }
        next.start()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        updateLayoutForOrientation(isLandscape: view.bounds.width > view.bounds.height)
    }

    override func viewWillTransition(to size: CGSize, with coordinator: UIViewControllerTransitionCoordinator) {
        super.viewWillTransition(to: size, with: coordinator)
        coordinator.animate(alongsideTransition: { [weak self] _ in
            self?.updateLayoutForOrientation(isLandscape: size.width > size.height)
        })
    }

    override var supportedInterfaceOrientations: UIInterfaceOrientationMask {
        immersiveMode ? .landscape : .allButUpsideDown
    }

    func closeWorkspace() {
        client?.disconnect()
        fpsTimer?.invalidate()
        fpsTimer = nil
        if presentingViewController != nil {
            dismiss(animated: true) { [weak self] in self?.notifyClosedIfNeeded() }
        } else {
            notifyClosedIfNeeded()
        }
    }

    private func notifyClosedIfNeeded() {
        guard !didNotifyClosed else { return }
        didNotifyClosed = true
        onClosed?()
        onClosed = nil
    }

    private func buildView() {
        topBar.translatesAutoresizingMaskIntoConstraints = false
        topBar.backgroundColor = UIColor(red: 0.07, green: 0.08, blue: 0.12, alpha: 0.96)
        view.addSubview(topBar)

        let closeButton = makeButton(title: "×", fontSize: 32) { [weak self] in self?.closeWorkspace() }
        closeButton.accessibilityLabel = "关闭远程桌面"
        closeButton.backgroundColor = UIColor.white.withAlphaComponent(0.10)
        closeButton.layer.cornerRadius = 22
        topBar.addSubview(closeButton)

        titleLabel.text = desktopTitle
        titleLabel.textColor = .white
        titleLabel.font = .systemFont(ofSize: 16, weight: .semibold)
        titleLabel.lineBreakMode = .byTruncatingTail
        titleLabel.translatesAutoresizingMaskIntoConstraints = false
        topBar.addSubview(titleLabel)

        statusLabel.text = "连接中"
        statusLabel.textColor = UIColor.white.withAlphaComponent(0.70)
        statusLabel.font = .systemFont(ofSize: 12, weight: .medium)
        statusLabel.translatesAutoresizingMaskIntoConstraints = false
        topBar.addSubview(statusLabel)

        fpsLabel.text = "0 fps"
        fpsLabel.textColor = UIColor.white.withAlphaComponent(0.55)
        fpsLabel.font = .monospacedDigitSystemFont(ofSize: 12, weight: .regular)
        fpsLabel.translatesAutoresizingMaskIntoConstraints = false
        topBar.addSubview(fpsLabel)

        keyboardButton.setTitle("⌨", for: .normal)
        keyboardButton.accessibilityLabel = "打开键盘"
        styleTopButton(keyboardButton)
        keyboardButton.addAction(UIAction { [weak self] _ in self?.toggleKeyboard() }, for: .touchUpInside)
        keyboardButton.translatesAutoresizingMaskIntoConstraints = false
        topBar.addSubview(keyboardButton)

        moreButton.setTitle("•••", for: .normal)
        moreButton.accessibilityLabel = "更多远程桌面操作"
        styleTopButton(moreButton)
        moreButton.addAction(UIAction { [weak self] _ in self?.toggleControls() }, for: .touchUpInside)
        moreButton.translatesAutoresizingMaskIntoConstraints = false
        topBar.addSubview(moreButton)

        canvas.translatesAutoresizingMaskIntoConstraints = false
        canvas.backgroundColor = .black
        canvas.pointerHandler = { [weak self] x, y, mask in
            guard let self, !self.isViewOnly else { return }
            self.client?.sendPointer(x: x, y: y, mask: mask)
        }
        view.addSubview(canvas)

        placeholderLabel.text = "正在连接 Mac 屏幕…"
        placeholderLabel.textColor = UIColor.white.withAlphaComponent(0.82)
        placeholderLabel.font = .systemFont(ofSize: 20, weight: .semibold)
        placeholderLabel.textAlignment = .center
        placeholderLabel.numberOfLines = 0
        placeholderLabel.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(placeholderLabel)

        retryButton.setTitle("重新连接", for: .normal)
        retryButton.setTitleColor(.white, for: .normal)
        retryButton.titleLabel?.font = .systemFont(ofSize: 16, weight: .semibold)
        var retryConfiguration = UIButton.Configuration.filled()
        retryConfiguration.baseBackgroundColor = UIColor(red: 0.12, green: 0.48, blue: 0.95, alpha: 1)
        retryConfiguration.baseForegroundColor = .white
        retryConfiguration.contentInsets = NSDirectionalEdgeInsets(top: 12, leading: 22, bottom: 12, trailing: 22)
        retryButton.configuration = retryConfiguration
        retryButton.layer.cornerRadius = 12
        retryButton.isHidden = true
        retryButton.translatesAutoresizingMaskIntoConstraints = false
        retryButton.addAction(UIAction { [weak self] _ in
            guard let self else { return }
            self.statusLabel.text = "等待授权"
            self.placeholderLabel.text = "正在申请新的连接…"
            self.retryButton.isHidden = true
            self.onReconnectRequested?("user")
        }, for: .touchUpInside)
        view.addSubview(retryButton)

        buildControls()
        buildCollapsedControls()

        keyboardPanel.translatesAutoresizingMaskIntoConstraints = false
        keyboardPanel.backgroundColor = .clear

        keyboardInput.delegate = self
        keyboardInput.backgroundColor = UIColor.white.withAlphaComponent(0.08)
        keyboardInput.layer.cornerRadius = 10
        keyboardInput.textColor = .white
        keyboardInput.tintColor = .white
        keyboardInput.font = .systemFont(ofSize: 16)
        keyboardInput.textContainerInset = UIEdgeInsets(top: 10, left: 10, bottom: 10, right: 10)
        keyboardInput.returnKeyType = .send
        keyboardInput.autocorrectionType = .no
        keyboardInput.autocapitalizationType = .none
        keyboardInput.spellCheckingType = .no
        keyboardInput.translatesAutoresizingMaskIntoConstraints = false
        keyboardPanel.addSubview(keyboardInput)

        keyboardSendButton.setTitle("发送", for: .normal)
        keyboardSendButton.setTitleColor(.white, for: .normal)
        keyboardSendButton.titleLabel?.font = .systemFont(ofSize: 15, weight: .semibold)
        keyboardSendButton.backgroundColor = UIColor.white.withAlphaComponent(0.10)
        keyboardSendButton.layer.cornerRadius = 10
        keyboardSendButton.accessibilityLabel = "发送远程键盘文字"
        keyboardSendButton.addAction(UIAction { [weak self] _ in self?.sendKeyboardInput() }, for: .touchUpInside)
        keyboardSendButton.translatesAutoresizingMaskIntoConstraints = false
        keyboardPanel.addSubview(keyboardSendButton)

        controlsStack.addArrangedSubview(keyboardPanel)

        clipboardPanel.translatesAutoresizingMaskIntoConstraints = false
        clipboardPanel.backgroundColor = .clear
        clipboardInput.backgroundColor = UIColor.white.withAlphaComponent(0.08)
        clipboardInput.layer.cornerRadius = 10
        clipboardInput.textColor = .white
        clipboardInput.tintColor = .white
        clipboardInput.font = .systemFont(ofSize: 15)
        clipboardInput.textContainerInset = UIEdgeInsets(top: 8, left: 9, bottom: 8, right: 9)
        clipboardInput.autocorrectionType = .no
        clipboardInput.translatesAutoresizingMaskIntoConstraints = false
        clipboardPanel.addSubview(clipboardInput)

        clipboardSendButton.setTitle("发送", for: .normal)
        clipboardSendButton.setTitleColor(.white, for: .normal)
        clipboardSendButton.titleLabel?.font = .systemFont(ofSize: 14, weight: .semibold)
        clipboardSendButton.backgroundColor = UIColor.white.withAlphaComponent(0.10)
        clipboardSendButton.layer.cornerRadius = 10
        clipboardSendButton.addAction(UIAction { [weak self] _ in self?.sendClipboardInput() }, for: .touchUpInside)
        clipboardSendButton.translatesAutoresizingMaskIntoConstraints = false
        clipboardPanel.addSubview(clipboardSendButton)

        clipboardCopyButton.setTitle("复制", for: .normal)
        clipboardCopyButton.setTitleColor(.white, for: .normal)
        clipboardCopyButton.titleLabel?.font = .systemFont(ofSize: 14, weight: .semibold)
        clipboardCopyButton.backgroundColor = UIColor.white.withAlphaComponent(0.10)
        clipboardCopyButton.layer.cornerRadius = 10
        clipboardCopyButton.addAction(UIAction { [weak self] _ in self?.copyRemoteClipboard() }, for: .touchUpInside)
        clipboardCopyButton.translatesAutoresizingMaskIntoConstraints = false
        clipboardPanel.addSubview(clipboardCopyButton)
        controlsStack.addArrangedSubview(clipboardPanel)

        topBarHeightConstraint = topBar.heightAnchor.constraint(equalToConstant: 78)
        canvasFullWidthConstraint = canvas.trailingAnchor.constraint(equalTo: view.trailingAnchor)
        canvasLandscapeWidthConstraint = canvas.trailingAnchor.constraint(equalTo: controlsPanel.leadingAnchor, constant: -8)
        controlsPanelPortraitConstraints = [
            controlsPanel.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 8),
            controlsPanel.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -8),
            controlsPanel.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -8),
            controlsPanel.heightAnchor.constraint(equalToConstant: 300),
        ]
        controlsPanelLandscapeConstraints = [
            controlsPanel.topAnchor.constraint(equalTo: topBar.bottomAnchor, constant: 8),
            controlsPanel.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -8),
            controlsPanel.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -8),
            controlsPanel.widthAnchor.constraint(equalToConstant: 360),
        ]

        NSLayoutConstraint.activate([
            topBar.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            topBar.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            topBar.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            topBarHeightConstraint,

            closeButton.leadingAnchor.constraint(equalTo: topBar.leadingAnchor, constant: 14),
            closeButton.bottomAnchor.constraint(equalTo: topBar.bottomAnchor, constant: -12),
            closeButton.widthAnchor.constraint(equalToConstant: 44),
            closeButton.heightAnchor.constraint(equalToConstant: 44),

            titleLabel.leadingAnchor.constraint(equalTo: closeButton.trailingAnchor, constant: 12),
            titleLabel.centerYAnchor.constraint(equalTo: closeButton.centerYAnchor, constant: -7),
            titleLabel.trailingAnchor.constraint(lessThanOrEqualTo: keyboardButton.leadingAnchor, constant: -12),

            statusLabel.leadingAnchor.constraint(equalTo: titleLabel.leadingAnchor),
            statusLabel.topAnchor.constraint(equalTo: titleLabel.bottomAnchor, constant: 2),
            fpsLabel.leadingAnchor.constraint(equalTo: statusLabel.trailingAnchor, constant: 8),
            fpsLabel.centerYAnchor.constraint(equalTo: statusLabel.centerYAnchor),

            moreButton.trailingAnchor.constraint(equalTo: topBar.trailingAnchor, constant: -14),
            moreButton.centerYAnchor.constraint(equalTo: closeButton.centerYAnchor),
            moreButton.widthAnchor.constraint(equalToConstant: 48),
            moreButton.heightAnchor.constraint(equalToConstant: 44),
            keyboardButton.trailingAnchor.constraint(equalTo: moreButton.leadingAnchor, constant: -8),
            keyboardButton.centerYAnchor.constraint(equalTo: closeButton.centerYAnchor),
            keyboardButton.widthAnchor.constraint(equalToConstant: 48),
            keyboardButton.heightAnchor.constraint(equalToConstant: 44),

            canvas.topAnchor.constraint(equalTo: view.topAnchor),
            canvas.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            canvasFullWidthConstraint,
            canvas.bottomAnchor.constraint(equalTo: view.bottomAnchor),

            placeholderLabel.centerXAnchor.constraint(equalTo: canvas.centerXAnchor),
            placeholderLabel.centerYAnchor.constraint(equalTo: canvas.centerYAnchor),
            placeholderLabel.leadingAnchor.constraint(greaterThanOrEqualTo: canvas.leadingAnchor, constant: 24),
            placeholderLabel.trailingAnchor.constraint(lessThanOrEqualTo: canvas.trailingAnchor, constant: -24),

            retryButton.topAnchor.constraint(equalTo: placeholderLabel.bottomAnchor, constant: 18),
            retryButton.centerXAnchor.constraint(equalTo: canvas.centerXAnchor),

            keyboardPanel.heightAnchor.constraint(equalToConstant: 58),
            keyboardInput.topAnchor.constraint(equalTo: keyboardPanel.topAnchor, constant: 7),
            keyboardInput.bottomAnchor.constraint(equalTo: keyboardPanel.bottomAnchor, constant: -7),
            keyboardInput.leadingAnchor.constraint(equalTo: keyboardPanel.leadingAnchor),
            keyboardSendButton.centerYAnchor.constraint(equalTo: keyboardInput.centerYAnchor),
            keyboardSendButton.heightAnchor.constraint(equalToConstant: 44),
            keyboardSendButton.leadingAnchor.constraint(equalTo: keyboardInput.trailingAnchor, constant: 8),
            keyboardSendButton.trailingAnchor.constraint(equalTo: keyboardPanel.trailingAnchor),
            keyboardSendButton.widthAnchor.constraint(equalToConstant: 58),

            clipboardPanel.heightAnchor.constraint(equalToConstant: 70),
            clipboardInput.topAnchor.constraint(equalTo: clipboardPanel.topAnchor),
            clipboardInput.bottomAnchor.constraint(equalTo: clipboardPanel.bottomAnchor),
            clipboardInput.leadingAnchor.constraint(equalTo: clipboardPanel.leadingAnchor),
            clipboardSendButton.centerYAnchor.constraint(equalTo: clipboardInput.centerYAnchor),
            clipboardSendButton.heightAnchor.constraint(equalToConstant: 44),
            clipboardSendButton.leadingAnchor.constraint(equalTo: clipboardInput.trailingAnchor, constant: 6),
            clipboardSendButton.widthAnchor.constraint(equalToConstant: 58),
            clipboardCopyButton.centerYAnchor.constraint(equalTo: clipboardSendButton.centerYAnchor),
            clipboardCopyButton.heightAnchor.constraint(equalToConstant: 44),
            clipboardCopyButton.leadingAnchor.constraint(equalTo: clipboardSendButton.trailingAnchor, constant: 6),
            clipboardCopyButton.trailingAnchor.constraint(equalTo: clipboardPanel.trailingAnchor),
            clipboardCopyButton.widthAnchor.constraint(equalToConstant: 58),

            controlsScroll.leadingAnchor.constraint(equalTo: controlsPanel.leadingAnchor, constant: 7),
            controlsScroll.trailingAnchor.constraint(equalTo: controlsPanel.trailingAnchor, constant: -7),
            controlsScroll.topAnchor.constraint(equalTo: controlsPanel.topAnchor, constant: 7),
            controlsScroll.bottomAnchor.constraint(equalTo: controlsPanel.bottomAnchor, constant: -7),
            controlsStack.leadingAnchor.constraint(equalTo: controlsScroll.contentLayoutGuide.leadingAnchor),
            controlsStack.trailingAnchor.constraint(equalTo: controlsScroll.contentLayoutGuide.trailingAnchor),
            controlsStack.topAnchor.constraint(equalTo: controlsScroll.contentLayoutGuide.topAnchor),
            controlsStack.bottomAnchor.constraint(equalTo: controlsScroll.contentLayoutGuide.bottomAnchor),
            controlsStack.widthAnchor.constraint(equalTo: controlsScroll.frameLayoutGuide.widthAnchor),

            collapsedControlsPanel.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -12),
            collapsedControlsPanel.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -12),
            collapsedControlsStack.leadingAnchor.constraint(equalTo: collapsedControlsPanel.leadingAnchor, constant: 5),
            collapsedControlsStack.trailingAnchor.constraint(equalTo: collapsedControlsPanel.trailingAnchor, constant: -5),
            collapsedControlsStack.topAnchor.constraint(equalTo: collapsedControlsPanel.topAnchor, constant: 5),
            collapsedControlsStack.bottomAnchor.constraint(equalTo: collapsedControlsPanel.bottomAnchor, constant: -5),
        ])

        setKeyboardVisible(false)
        setClipboardOpen(false)
        setControlsExpanded(false)
        updateLayoutForOrientation(isLandscape: view.bounds.width > view.bounds.height)
    }

    private func buildControls() {
        controlsPanel.translatesAutoresizingMaskIntoConstraints = false
        controlsPanel.backgroundColor = UIColor(red: 0.07, green: 0.08, blue: 0.12, alpha: 0.98)
        controlsPanel.layer.cornerRadius = 16
        controlsPanel.clipsToBounds = true
        controlsPanel.isHidden = true
        view.addSubview(controlsPanel)

        controlsScroll.translatesAutoresizingMaskIntoConstraints = false
        controlsScroll.showsVerticalScrollIndicator = true
        controlsScroll.alwaysBounceVertical = true
        controlsPanel.addSubview(controlsScroll)
        controlsStack.axis = .vertical
        controlsStack.spacing = 8
        controlsStack.alignment = .fill
        controlsStack.translatesAutoresizingMaskIntoConstraints = false
        controlsScroll.addSubview(controlsStack)

        controlsStack.addArrangedSubview(makeControlRow([
            ("⛶", "全屏横屏", { [weak self] in self?.toggleImmersive() }),
            ("⤢", "适应屏幕", { [weak self] in self?.canvas.fit() }),
            ("−", "缩小画面", { [weak self] in self?.canvas.adjustZoom(0.8) }),
            ("＋", "放大画面", { [weak self] in self?.canvas.adjustZoom(1.25) }),
            ("↺", "重置画面", { [weak self] in self?.canvas.fit() }),
            ("✥", "移动画面", { [weak self] in self?.togglePanMode() }),
            ("◉", "切换只读", { [weak self] in self?.toggleViewOnly() }),
            ("⟳", "刷新屏幕", { [weak self] in self?.client?.refresh() }),
            ("▣", "剪贴板", { [weak self] in self?.setClipboardOpen(!(self?.clipboardOpen ?? false)) }),
        ]))
        controlsStack.addArrangedSubview(makeControlRow([
            ("↵", "回车", { [weak self] in self?.sendKey(0xff0d) }),
            ("⌫", "删除", { [weak self] in self?.sendKey(0xff08) }),
            ("←", "向左", { [weak self] in self?.sendKey(0xff51) }),
            ("↑", "向上", { [weak self] in self?.sendKey(0xff52) }),
            ("↓", "向下", { [weak self] in self?.sendKey(0xff54) }),
            ("→", "向右", { [weak self] in self?.sendKey(0xff53) }),
            ("⇥", "Tab", { [weak self] in self?.sendKey(0xff09) }),
            ("⎋", "Escape", { [weak self] in self?.sendKey(0xff1b) }),
        ]))
        controlsStack.addArrangedSubview(makeControlRow([
            ("⌘Tab", "切换 App", { [weak self] in self?.sendShortcut(keysym: 0xff09, modifier: 0xffeb) }),
            ("⌘Space", "打开 Spotlight", { [weak self] in self?.sendShortcut(keysym: 0x20, modifier: 0xffeb) }),
            ("⌘`", "切换窗口", { [weak self] in self?.sendShortcut(keysym: 0x60, modifier: 0xffeb) }),
            ("⌃↑", "调度中心", { [weak self] in self?.sendShortcut(keysym: 0xff52, modifier: 0xffe3) }),
            ("⌘", "Command", { [weak self] in self?.sendKey(0xffeb) }),
            ("⌃", "Control", { [weak self] in self?.sendKey(0xffe3) }),
            ("⌥", "Option", { [weak self] in self?.sendKey(0xffe9) }),
        ]))
    }

    private func buildCollapsedControls() {
        collapsedControlsPanel.translatesAutoresizingMaskIntoConstraints = false
        collapsedControlsPanel.backgroundColor = UIColor(red: 0.07, green: 0.08, blue: 0.12, alpha: 0.92)
        collapsedControlsPanel.layer.cornerRadius = 16
        collapsedControlsPanel.isHidden = true
        view.addSubview(collapsedControlsPanel)

        collapsedControlsStack.axis = .horizontal
        collapsedControlsStack.spacing = 4
        collapsedControlsStack.alignment = .center
        collapsedControlsStack.translatesAutoresizingMaskIntoConstraints = false
        collapsedControlsPanel.addSubview(collapsedControlsStack)

        collapsedControlsStack.addArrangedSubview(makeControlButton(title: "⌨", accessibility: "打开键盘") { [weak self] in
            self?.setControlsExpanded(true)
            self?.setKeyboardVisible(true)
        })
        collapsedControlsStack.addArrangedSubview(makeControlButton(title: "⛶", accessibility: "全屏横屏") { [weak self] in
            self?.toggleImmersive()
        })
        collapsedControlsStack.addArrangedSubview(makeControlButton(title: "•••", accessibility: "展开操作") { [weak self] in
            self?.setControlsExpanded(true)
        })
    }

    private func makeControlRow(_ actions: [(String, String, () -> Void)]) -> UIView {
        let scroll = UIScrollView()
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.showsHorizontalScrollIndicator = false
        scroll.alwaysBounceHorizontal = true

        let stack = UIStackView()
        stack.axis = .horizontal
        stack.spacing = 5
        stack.alignment = .center
        stack.translatesAutoresizingMaskIntoConstraints = false
        scroll.addSubview(stack)
        for (title, accessibility, action) in actions {
            stack.addArrangedSubview(makeControlButton(title: title, accessibility: accessibility, action: action))
        }
        NSLayoutConstraint.activate([
            scroll.heightAnchor.constraint(equalToConstant: 48),
            stack.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor),
            stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor),
            stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor),
            stack.heightAnchor.constraint(equalTo: scroll.frameLayoutGuide.heightAnchor),
        ])
        return scroll
    }

    private func setConnectingState() {
        connected = false
        statusLabel.text = "连接中"
        statusLabel.textColor = UIColor.white.withAlphaComponent(0.70)
        titleLabel.text = desktopTitle
        placeholderLabel.text = "正在连接 Mac 屏幕…"
        placeholderLabel.isHidden = false
        retryButton.isHidden = true
        setControlsExpanded(false)
        setKeyboardVisible(false)
        setClipboardOpen(false)
    }

    private func setErrorState(_ message: String) {
        connected = false
        statusLabel.text = "连接失败"
        statusLabel.textColor = UIColor(red: 1, green: 0.38, blue: 0.38, alpha: 1)
        placeholderLabel.text = message
        placeholderLabel.isHidden = false
        retryButton.isHidden = false
        setControlsExpanded(false)
        setKeyboardVisible(false)
        setClipboardOpen(false)
        fpsTimer?.invalidate()
        fpsTimer = nil
    }

    private func showCredentials(types: [String]) {
        guard presentedViewController == nil else { return }
        let needsUser = types.contains("username")
        let needsPassword = types.contains("password")
        let alert = UIAlertController(title: "登录屏幕共享", message: "凭据仅用于本次连接，不会保存到 Bridge。", preferredStyle: .alert)
        if needsUser {
            alert.addTextField { field in
                field.placeholder = "Mac 用户名"
                field.autocapitalizationType = .none
                field.autocorrectionType = .no
                field.textContentType = .username
            }
        }
        if needsPassword {
            alert.addTextField { field in
                field.placeholder = "密码"
                field.isSecureTextEntry = true
                field.textContentType = .password
            }
        }
        alert.addAction(UIAlertAction(title: "取消", style: .cancel) { [weak self] _ in
            self?.client?.disconnect()
            self?.setErrorState("已取消屏幕共享登录。")
        })
        alert.addAction(UIAlertAction(title: "连接", style: .default) { [weak self, weak alert] _ in
            guard let self else { return }
            let values = alert?.textFields ?? []
            let username = needsUser ? values.first?.text : nil
            let password = needsPassword ? values.last?.text : nil
            self.statusLabel.text = "验证中"
            self.client?.provideCredentials(username: username, password: password)
        })
        present(alert, animated: true)
    }

    private func toggleKeyboard() {
        if !controlsExpanded { setControlsExpanded(true) }
        setKeyboardVisible(!keyboardPanelVisible)
    }

    private func setKeyboardVisible(_ visible: Bool) {
        keyboardPanelVisible = visible
        keyboardPanel.isHidden = !visible
        keyboardSendButton.isEnabled = visible && !isViewOnly
        if visible {
            keyboardInput.becomeFirstResponder()
        } else {
            keyboardInput.resignFirstResponder()
        }
        UIView.performWithoutAnimation { self.view.layoutIfNeeded() }
    }

    private func toggleControls() {
        setControlsExpanded(!controlsExpanded)
    }

    private func setControlsExpanded(_ expanded: Bool) {
        controlsExpanded = connected && expanded
        controlsPanel.isHidden = !(connected && controlsExpanded)
        collapsedControlsPanel.isHidden = !(connected && !controlsExpanded)
        moreButton.setTitle(controlsExpanded ? "⌄" : "•••", for: .normal)
        moreButton.accessibilityLabel = controlsExpanded ? "收起远程桌面操作" : "更多远程桌面操作"
        if !controlsExpanded { setKeyboardVisible(false) }
        updateLayoutForOrientation(isLandscape: currentLayoutIsLandscape)
    }

    private func toggleViewOnly() {
        isViewOnly.toggle()
        client?.viewOnly = isViewOnly
        canvas.viewOnly = isViewOnly
        keyboardInput.isEditable = !isViewOnly
        keyboardSendButton.isEnabled = keyboardPanelVisible && !isViewOnly
        statusLabel.text = isViewOnly ? "只读" : "已连接"
    }

    private func togglePanMode() {
        panMode.toggle()
        canvas.panMode = panMode
        statusLabel.text = panMode ? "移动画面" : (isViewOnly ? "只读" : "已连接")
    }

    private func sendKey(_ keysym: UInt32) {
        guard !isViewOnly else { return }
        client?.sendKey(keysym: keysym)
    }

    private func sendShortcut(keysym: UInt32, modifier: UInt32) {
        guard !isViewOnly else { return }
        client?.sendKey(keysym: modifier, down: true)
        client?.sendKey(keysym: keysym, down: true)
        client?.sendKey(keysym: keysym, down: false)
        client?.sendKey(keysym: modifier, down: false)
    }

    private func setClipboardOpen(_ open: Bool) {
        clipboardOpen = open
        clipboardInput.text = open ? remoteClipboard : clipboardInput.text
        clipboardPanel.isHidden = !open
        UIView.performWithoutAnimation { self.view.layoutIfNeeded() }
    }

    private func sendClipboardInput() {
        guard !isViewOnly else { return }
        client?.sendClipboard(clipboardInput.text ?? "")
        statusLabel.text = "已发送剪贴板"
    }

    private func copyRemoteClipboard() {
        UIPasteboard.general.string = remoteClipboard
        statusLabel.text = "已复制远程剪贴板"
    }

    private func toggleImmersive() {
        immersiveMode.toggle()
        if #available(iOS 16.0, *), let windowScene = view.window?.windowScene {
            let orientations: UIInterfaceOrientationMask = immersiveMode ? .landscape : .allButUpsideDown
            windowScene.requestGeometryUpdate(.iOS(interfaceOrientations: orientations)) { _ in }
            setNeedsUpdateOfSupportedInterfaceOrientations()
        } else {
            let orientation = immersiveMode ? UIInterfaceOrientation.landscapeRight : .portrait
            UIDevice.current.setValue(orientation.rawValue, forKey: "orientation")
            UIViewController.attemptRotationToDeviceOrientation()
        }
        updateLayoutForOrientation(isLandscape: view.bounds.width > view.bounds.height)
    }

    private func updateLayoutForOrientation(isLandscape: Bool) {
        guard topBarHeightConstraint != nil else { return }
        let reservesControls = isLandscape && connected && controlsExpanded
        guard !hasAppliedLayout || currentLayoutIsLandscape != isLandscape || currentLayoutReservesControls != reservesControls else { return }
        currentLayoutIsLandscape = isLandscape
        currentLayoutReservesControls = reservesControls
        hasAppliedLayout = true
        topBarHeightConstraint.constant = isLandscape ? 52 : 78
        topBar.backgroundColor = isLandscape ? .clear : UIColor(red: 0.07, green: 0.08, blue: 0.12, alpha: 0.96)
        titleLabel.isHidden = isLandscape
        statusLabel.isHidden = isLandscape
        fpsLabel.isHidden = isLandscape
        collapsedControlsStack.axis = isLandscape ? .vertical : .horizontal

        NSLayoutConstraint.deactivate(controlsPanelPortraitConstraints + controlsPanelLandscapeConstraints)
        NSLayoutConstraint.activate(isLandscape ? controlsPanelLandscapeConstraints : controlsPanelPortraitConstraints)
        NSLayoutConstraint.deactivate([canvasFullWidthConstraint, canvasLandscapeWidthConstraint])
        if reservesControls {
            NSLayoutConstraint.activate([canvasLandscapeWidthConstraint])
        } else {
            NSLayoutConstraint.activate([canvasFullWidthConstraint])
        }
        UIView.performWithoutAnimation { self.view.layoutIfNeeded() }
    }

    private func sendKeyboardInput(includeEnter: Bool = false) {
        guard !isViewOnly else { return }
        let text = keyboardInput.text ?? ""
        if !text.isEmpty { client?.sendText(text) }
        if includeEnter { client?.sendKey(keysym: 0xff0d) }
        keyboardInput.text = ""
    }

    private func startFPSCounter() {
        fpsTimer?.invalidate()
        fpsTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            guard let self else { return }
            self.fpsLabel.text = "\(self.frameCount) fps"
            self.frameCount = 0
        }
    }

    private func enqueueFrame(_ frame: BridgeRemoteDesktopFrame) {
        frameQueue.async { [weak self] in
            guard let self else { return }
            self.pendingFrame = frame
            self.renderNextFrameIfNeeded()
        }
    }

    private func renderNextFrameIfNeeded() {
        guard !renderingFrame, let frame = pendingFrame else { return }
        pendingFrame = nil
        renderingFrame = true
        let image = Self.image(from: frame)
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            if let image {
                self.canvas.setImage(image, width: frame.width, height: frame.height)
                self.frameCount += 1
            }
            self.frameQueue.async {
                self.renderingFrame = false
                self.renderNextFrameIfNeeded()
            }
        }
    }

    private func styleTopButton(_ button: UIButton) {
        button.setTitleColor(.white, for: .normal)
        button.titleLabel?.font = .systemFont(ofSize: 22, weight: .medium)
        button.backgroundColor = UIColor.white.withAlphaComponent(0.10)
        button.layer.cornerRadius = 12
    }

    private func makeButton(title: String, fontSize: CGFloat, action: @escaping () -> Void) -> UIButton {
        let button = UIButton(type: .system)
        button.setTitle(title, for: .normal)
        button.setTitleColor(.white, for: .normal)
        button.titleLabel?.font = .systemFont(ofSize: fontSize, weight: .medium)
        button.addAction(UIAction { _ in action() }, for: .touchUpInside)
        button.translatesAutoresizingMaskIntoConstraints = false
        return button
    }

    private func makeControlButton(title: String, accessibility: String, action: @escaping () -> Void) -> UIButton {
        let button = UIButton(type: .system)
        button.setTitle(title, for: .normal)
        button.setTitleColor(UIColor.white.withAlphaComponent(0.86), for: .normal)
        button.titleLabel?.font = .systemFont(ofSize: title.count > 2 ? 13 : 20, weight: .semibold)
        button.backgroundColor = UIColor.white.withAlphaComponent(0.08)
        button.layer.cornerRadius = 12
        button.accessibilityLabel = accessibility
        button.addAction(UIAction { _ in action() }, for: .touchUpInside)
        button.translatesAutoresizingMaskIntoConstraints = false
        button.widthAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true
        button.heightAnchor.constraint(equalToConstant: 44).isActive = true
        return button
    }

    func textViewDidChange(_ textView: UITextView) {
        // Keep IME composition and corrections local. Text is sent only by the
        // explicit button or the keyboard's return/send action.
    }

    func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool {
        if text.contains("\n") {
            sendKeyboardInput(includeEnter: true)
            return false
        }
        return true
    }

    private static func image(from frame: BridgeRemoteDesktopFrame) -> UIImage? {
        guard frame.width > 0, frame.height > 0,
              frame.pixels.count == frame.width * frame.height * 4,
              let provider = CGDataProvider(data: frame.pixels as CFData) else { return nil }
        let info = CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue)
        guard let cgImage = CGImage(width: frame.width, height: frame.height,
                                    bitsPerComponent: 8, bitsPerPixel: 32,
                                    bytesPerRow: frame.width * 4,
                                    space: CGColorSpaceCreateDeviceRGB(),
                                    bitmapInfo: info, provider: provider,
                                    decode: nil, shouldInterpolate: false,
                                    intent: .defaultIntent) else { return nil }
        return UIImage(cgImage: cgImage)
    }
}

private final class BridgeRemoteDesktopCanvasView: UIView {
    var pointerHandler: ((UInt16, UInt16, UInt8) -> Void)?
    var viewOnly = false
    var panMode = false

    private var image: UIImage?
    private var framebufferWidth = 0
    private var framebufferHeight = 0
    private var zoom: CGFloat = 1
    private var pan = CGPoint.zero
    private var activeTouchIDs = Set<ObjectIdentifier>()
    private var pointerIsDown = false
    private var singlePanActive = false
    private var lastSinglePoint = CGPoint.zero
    private var previousTwoFingerCenter: CGPoint?
    private var twoFingerTapCandidate = false
    private var twoFingerMoved = false
    private var twoFingerStartedAt: TimeInterval = 0
    private var pinchStartZoom: CGFloat = 1
    private var pinching = false

    override init(frame: CGRect) {
        super.init(frame: frame)
        isMultipleTouchEnabled = true
        let pinch = UIPinchGestureRecognizer(target: self, action: #selector(handlePinch(_:)))
        pinch.cancelsTouchesInView = false
        pinch.delegate = self
        addGestureRecognizer(pinch)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func layoutSubviews() {
        super.layoutSubviews()
        clampPan()
        setNeedsDisplay()
    }

    override func draw(_ rect: CGRect) {
        UIColor.black.setFill()
        UIRectFill(bounds)
        guard let image, framebufferWidth > 0, framebufferHeight > 0 else { return }
        let imageRect = displayedImageRect()
        image.draw(in: imageRect, blendMode: .copy, alpha: 1)
    }

    func setFramebufferSize(width: Int, height: Int) {
        framebufferWidth = width
        framebufferHeight = height
        fit()
    }

    func setImage(_ image: UIImage, width: Int, height: Int) {
        if framebufferWidth != width || framebufferHeight != height {
            framebufferWidth = width
            framebufferHeight = height
            fit()
        }
        self.image = image
        setNeedsDisplay()
    }

    func fit() {
        zoom = 1
        pan = .zero
        setNeedsDisplay()
    }

    func adjustZoom(_ factor: CGFloat) {
        zoom = min(max(zoom * factor, 1), 5)
        clampPan()
        setNeedsDisplay()
    }

    @objc private func handlePinch(_ gesture: UIPinchGestureRecognizer) {
        switch gesture.state {
        case .began:
            pinching = true
            pinchStartZoom = zoom
        case .changed:
            zoom = min(max(pinchStartZoom * gesture.scale, 1), 5)
            clampPan()
            setNeedsDisplay()
        case .ended, .cancelled, .failed:
            pinching = false
        default:
            break
        }
    }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
        for touch in touches { activeTouchIDs.insert(ObjectIdentifier(touch)) }
        if activeTouchIDs.count == 1, let touch = touches.first, !pinching {
            lastSinglePoint = touch.location(in: self)
            pointerIsDown = !viewOnly && !panMode
            singlePanActive = panMode || (viewOnly && zoom > 1)
            if pointerIsDown { sendPointer(at: lastSinglePoint, mask: 1) }
        } else if activeTouchIDs.count >= 2 {
            if pointerIsDown {
                pointerIsDown = false
                sendPointer(at: touches.first?.location(in: self) ?? .zero, mask: 0)
            }
            singlePanActive = false
            twoFingerTapCandidate = true
            twoFingerMoved = false
            twoFingerStartedAt = touches.first?.timestamp ?? 0
            previousTwoFingerCenter = center(of: activeTouchIDs, in: event)
        }
        super.touchesBegan(touches, with: event)
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent?) {
        if activeTouchIDs.count == 1, !pinching, let touch = touches.first {
            let point = touch.location(in: self)
            let delta = CGPoint(x: point.x - lastSinglePoint.x, y: point.y - lastSinglePoint.y)
            if pointerIsDown && zoom > 1 && hypot(delta.x, delta.y) > 8 {
                pointerIsDown = false
                singlePanActive = true
                sendPointer(at: point, mask: 0)
            }
            if pointerIsDown {
                sendPointer(at: point, mask: 1)
            } else if singlePanActive || panMode || (viewOnly && zoom > 1) {
                pan.x += delta.x
                pan.y += delta.y
                clampPan()
                setNeedsDisplay()
            }
            lastSinglePoint = point
        } else if activeTouchIDs.count >= 2 {
            let current = center(of: activeTouchIDs, in: event)
            if let previous = previousTwoFingerCenter {
                let deltaX = current.x - previous.x
                let deltaY = current.y - previous.y
                if hypot(deltaX, deltaY) > 8 { twoFingerMoved = true }
                pan.x += deltaX
                pan.y += deltaY
                clampPan()
                setNeedsDisplay()
            }
            previousTwoFingerCenter = current
        }
        super.touchesMoved(touches, with: event)
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
        if activeTouchIDs.count >= 2, twoFingerTapCandidate, !twoFingerMoved,
           let touch = touches.first, touch.timestamp - twoFingerStartedAt <= 0.35 {
            let center = center(of: activeTouchIDs, in: event)
            sendPointer(at: center, mask: 2)
            sendPointer(at: center, mask: 0)
        }
        for touch in touches { activeTouchIDs.remove(ObjectIdentifier(touch)) }
        if pointerIsDown && activeTouchIDs.isEmpty {
            pointerIsDown = false
            sendPointer(at: touches.first?.location(in: self) ?? .zero, mask: 0)
        }
        if activeTouchIDs.count < 2 {
            previousTwoFingerCenter = nil
            twoFingerTapCandidate = false
        }
        super.touchesEnded(touches, with: event)
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) {
        for touch in touches { activeTouchIDs.remove(ObjectIdentifier(touch)) }
        if pointerIsDown {
            pointerIsDown = false
            sendPointer(at: touches.first?.location(in: self) ?? .zero, mask: 0)
        }
        singlePanActive = false
        twoFingerTapCandidate = false
        previousTwoFingerCenter = nil
        super.touchesCancelled(touches, with: event)
    }

    private func sendPointer(at point: CGPoint, mask: UInt8) {
        let rect = displayedImageRect()
        guard rect.width > 0, rect.height > 0 else { return }
        let x = min(max((point.x - rect.minX) / rect.width * CGFloat(framebufferWidth), 0), CGFloat(max(framebufferWidth - 1, 0)))
        let y = min(max((point.y - rect.minY) / rect.height * CGFloat(framebufferHeight), 0), CGFloat(max(framebufferHeight - 1, 0)))
        pointerHandler?(UInt16(x.rounded()), UInt16(y.rounded()), mask)
    }

    private func displayedImageRect() -> CGRect {
        guard framebufferWidth > 0, framebufferHeight > 0 else { return .zero }
        let fitScale = min(bounds.width / CGFloat(framebufferWidth), bounds.height / CGFloat(framebufferHeight))
        let scale = max(fitScale, 0.01) * zoom
        let size = CGSize(width: CGFloat(framebufferWidth) * scale, height: CGFloat(framebufferHeight) * scale)
        return CGRect(x: (bounds.width - size.width) / 2 + pan.x,
                      y: (bounds.height - size.height) / 2 + pan.y,
                      width: size.width, height: size.height)
    }

    private func clampPan() {
        let rectWithoutPan = displayedImageRect().offsetBy(dx: -pan.x, dy: -pan.y)
        let maxX = max(0, (rectWithoutPan.width - bounds.width) / 2)
        let maxY = max(0, (rectWithoutPan.height - bounds.height) / 2)
        pan.x = min(max(pan.x, -maxX), maxX)
        pan.y = min(max(pan.y, -maxY), maxY)
    }

    private func center(of ids: Set<ObjectIdentifier>, in event: UIEvent?) -> CGPoint {
        let touches = event?.allTouches?.filter { ids.contains(ObjectIdentifier($0)) } ?? []
        guard !touches.isEmpty else { return .zero }
        let points = touches.map { $0.location(in: self) }
        return CGPoint(x: points.map(\.x).reduce(0, +) / CGFloat(points.count),
                      y: points.map(\.y).reduce(0, +) / CGFloat(points.count))
    }
}

extension BridgeRemoteDesktopCanvasView: UIGestureRecognizerDelegate {
    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer) -> Bool { true }
}

private final class BridgeRemoteDesktopClient {
    enum State { case connecting, waitingForCredentials, connected }

    var viewOnly = false
    var onCredentialsRequired: (([String]) -> Void)?
    var onConnected: ((String, Int, Int) -> Void)?
    var onFrame: ((BridgeRemoteDesktopFrame) -> Void)?
    var onClipboard: ((String) -> Void)?
    var onError: ((String) -> Void)?

    private let url: URL
    private let queue = DispatchQueue(label: "dev.feishu.codex.bridge.remote-desktop", qos: .userInitiated)
    private var session: URLSession?
    private var socket: URLSessionWebSocketTask?
    private var buffer = Data()
    private var readOffset = 0
    private var phase: Phase = .protocolVersion
    private var pendingCredentials: PendingCredentials?
    private var closed = false
    private var failed = false
    private var framebuffer = Data()
    private var framebufferWidth = 0
    private var framebufferHeight = 0
    private var pixelFormat = BridgeVncPixelFormat.rgb565
    private var frameDirty = false

    private enum Phase {
        case protocolVersion
        case securityTypes
        case securityFailureReasonLength
        case securityFailureReason(Int)
        case vncChallenge
        case ardParameters
        case credentials
        case securityResult
        case serverInit
        case messages
        case framebufferRects(Int)
        case closed
    }

    private enum PendingCredentials {
        case vnc(Data)
        case ard(generator: BridgeBigUInt, prime: BridgeBigUInt, serverPublic: BridgeBigUInt, keyLength: Int)
    }

    init(url: URL) { self.url = url }

    func start() {
        queue.async { [weak self] in
            guard let self, !self.closed else { return }
            let session = URLSession(configuration: .default)
            let socket = session.webSocketTask(with: self.url)
            self.session = session
            self.socket = socket
            socket.resume()
            self.receiveNext()
        }
    }

    func disconnect() {
        queue.async { [weak self] in
            guard let self, !self.closed else { return }
            self.closed = true
            self.phase = .closed
            self.socket?.cancel(with: .goingAway, reason: nil)
            self.session?.invalidateAndCancel()
            self.socket = nil
            self.session = nil
        }
    }

    func provideCredentials(username: String?, password: String?) {
        queue.async { [weak self] in
            guard let self, !self.closed, let pending = self.pendingCredentials else { return }
            do {
                switch pending {
                case .vnc(let challenge):
                    guard let password else { throw BridgeRemoteDesktopError.authentication("请输入屏幕共享密码。") }
                    self.send(Self.vncResponse(challenge: challenge, password: password))
                case .ard(let generator, let prime, let serverPublic, let keyLength):
                    guard let username, !username.isEmpty, let password else {
                        throw BridgeRemoteDesktopError.authentication("请输入 Mac 用户名和密码。")
                    }
                    let response = try Self.ardResponse(generator: generator, prime: prime, serverPublic: serverPublic,
                                                        keyLength: keyLength, username: username, password: password)
                    self.send(response)
                }
                self.pendingCredentials = nil
                self.phase = .securityResult
            } catch {
                self.fail(error.localizedDescription)
            }
        }
    }

    func sendPointer(x: UInt16, y: UInt16, mask: UInt8) {
        guard !viewOnly else { return }
        queue.async { [weak self] in
            guard let self, !self.closed else { return }
            var data = Data([5, mask])
            data.append(contentsOf: Self.u16(x))
            data.append(contentsOf: Self.u16(y))
            self.send(data)
        }
    }

    func sendKey(keysym: UInt32) {
        guard !viewOnly else { return }
        sendKey(keysym: keysym, down: true)
        sendKey(keysym: keysym, down: false)
    }

    func sendKey(keysym: UInt32, down: Bool) {
        guard !viewOnly else { return }
        queue.async { [weak self] in
            guard let self, !self.closed else { return }
            var data = Data([4, down ? 1 : 0, 0, 0])
            data.append(contentsOf: Self.u32(keysym))
            self.send(data)
        }
    }

    func sendText(_ text: String) {
        guard !viewOnly else { return }
        for scalar in text.unicodeScalars {
            if scalar.value == 10 || scalar.value == 13 {
                sendKey(keysym: 0xff0d)
            } else if scalar.value == 9 {
                sendKey(keysym: 0xff09)
            } else if scalar.value >= 0x20 {
                sendKey(keysym: scalar.value)
            }
        }
    }

    func sendClipboard(_ text: String) {
        guard !viewOnly else { return }
        queue.async { [weak self] in
            guard let self, !self.closed else { return }
            let bytes = Array(text.utf8)
            guard bytes.count <= 16 * 1024 * 1024 else { return }
            var data = Data([6, 0, 0, 0])
            data.append(contentsOf: Self.u32(UInt32(bytes.count)))
            data.append(contentsOf: bytes)
            self.send(data)
        }
    }

    private func receiveNext() {
        guard !closed, let socket else { return }
        socket.receive { [weak self] result in
            guard let self else { return }
            self.queue.async {
                guard !self.closed else { return }
                switch result {
                case .success(.data(let data)):
                    self.buffer.append(data)
                    self.processBuffer()
                    self.receiveNext()
                case .success(.string):
                    self.fail("远程桌面返回了无效的文字数据。")
                case .failure(let error):
                    self.fail("远程桌面连接已断开：\(error.localizedDescription)")
                @unknown default:
                    self.fail("远程桌面连接已断开。")
                }
            }
        }
    }

    private func processBuffer() {
        while !closed {
            let oldOffset = readOffset
            switch phase {
            case .protocolVersion:
                guard available >= 12, let version = readString(count: 12) else { return }
                let serverVersion = String(version.dropFirst(4).prefix(7))
                guard serverVersion == "003.003" || serverVersion == "003.007" || serverVersion == "003.008" || serverVersion == "003.889" else {
                    fail("屏幕共享协议版本不受支持：\(serverVersion)")
                    return
                }
                send(Data("RFB 003.008\n".utf8))
                phase = .securityTypes

            case .securityTypes:
                guard available >= 1, let count = readUInt8() else { return }
                if count == 0 {
                    phase = .securityFailureReasonLength
                    continue
                }
                guard available >= Int(count), let types = readBytes(count: Int(count)) else {
                    readOffset = oldOffset
                    return
                }
                let supported: [UInt8] = [30, 2, 1]
                guard let selected = supported.first(where: { types.contains($0) }) else {
                    fail("屏幕共享要求未支持的认证方式。")
                    return
                }
                send(Data([selected]))
                switch selected {
                case 1:
                    phase = .securityResult
                case 2:
                    phase = .vncChallenge
                case 30:
                    phase = .ardParameters
                default:
                    fail("屏幕共享认证方式不受支持。")
                    return
                }

            case .securityFailureReasonLength:
                guard available >= 4, let length = readUInt32() else { return }
                guard length <= 16 * 1024 else { fail("屏幕共享返回了过长的失败原因。"); return }
                phase = .securityFailureReason(Int(length))

            case .securityFailureReason(let length):
                guard available >= length, let reason = readString(count: length) else { return }
                fail(reason.isEmpty ? "屏幕共享认证失败。" : reason)
                return

            case .vncChallenge:
                guard available >= 16, let challenge = readBytes(count: 16) else { return }
                pendingCredentials = .vnc(challenge)
                phase = .credentials
                requestCredentials(["password"])
                return

            case .ardParameters:
                var reader = RFBDataReader(data: buffer, offset: readOffset)
                guard let generator = reader.readUInt16(), let keyLength = reader.readUInt16(),
                      (1...1024).contains(Int(keyLength)),
                      let primeData = reader.readData(count: Int(keyLength)),
                      let serverPublicData = reader.readData(count: Int(keyLength)) else { return }
                readOffset = reader.offset
                guard generator > 0 else { fail("屏幕共享 DH 参数无效。"); return }
                pendingCredentials = .ard(generator: BridgeBigUInt(UInt32(generator)),
                                          prime: BridgeBigUInt(bigEndian: primeData),
                                          serverPublic: BridgeBigUInt(bigEndian: serverPublicData),
                                          keyLength: Int(keyLength))
                phase = .credentials
                requestCredentials(["username", "password"])
                return

            case .credentials:
                return

            case .securityResult:
                guard available >= 4, let result = readUInt32() else { return }
                if result != 0 {
                    phase = .securityFailureReasonLength
                    continue
                }
                send(Data([1]))
                phase = .serverInit

            case .serverInit:
                var reader = RFBDataReader(data: buffer, offset: readOffset)
                guard let width = reader.readUInt16(), let height = reader.readUInt16(),
                      let format = readPixelFormat(&reader), let nameLength = reader.readUInt32(),
                      nameLength <= 4 * 1024,
                      let name = reader.readData(count: Int(nameLength)) else { return }
                readOffset = reader.offset
                let framebufferWidth = Int(width)
                let framebufferHeight = Int(height)
                guard validFramebufferSize(width: framebufferWidth, height: framebufferHeight) else {
                    fail("远程屏幕尺寸过大，已停止连接。")
                    return
                }
                self.framebufferWidth = framebufferWidth
                self.framebufferHeight = framebufferHeight
                framebuffer = Data(repeating: 0, count: framebufferWidth * framebufferHeight * 4)
                pixelFormat = .rgb565
                sendSetPixelFormat()
                sendSetEncodings()
                sendFramebufferUpdateRequest(incremental: false)
                phase = .messages
                let desktopName = String(data: name, encoding: .utf8) ?? String(data: name, encoding: .ascii) ?? ""
                deliverConnected(name: desktopName, width: framebufferWidth, height: framebufferHeight)
                _ = format

            case .messages:
                guard let type = peekUInt8() else { return }
                switch type {
                case 0:
                    var reader = RFBDataReader(data: buffer, offset: readOffset)
                    // FramebufferUpdate is: type (1), padding (1), count (2).
                    // Skipping two bytes after the type shifts the rectangle
                    // header by one byte and turns the real encoding into a
                    // misleading value such as 214.
                    guard reader.readUInt8() != nil, reader.skip(1), let count = reader.readUInt16() else { return }
                    readOffset = reader.offset
                    phase = .framebufferRects(Int(count))
                    frameDirty = false
                case 2:
                    readOffset += 1
                case 3:
                    var reader = RFBDataReader(data: buffer, offset: readOffset)
                    guard reader.readUInt8() != nil, reader.skip(3), let length = reader.readUInt32(), length <= 16 * 1024 * 1024,
                          let text = reader.readData(count: Int(length)) else { return }
                    readOffset = reader.offset
                    deliverClipboard(String(data: text, encoding: .utf8) ?? "")
                default:
                    fail("远程桌面返回了未支持的消息类型：\(type)")
                    return
                }

            case .framebufferRects(let left):
                if left == 0 {
                    phase = .messages
                    if frameDirty {
                        deliverFrame()
                        frameDirty = false
                    }
                    sendFramebufferUpdateRequest(incremental: true)
                    continue
                }
                guard let nextOffset = parseFramebufferRect() else { return }
                readOffset = nextOffset
                phase = .framebufferRects(left - 1)
                if left == 1 {
                    phase = .messages
                    if frameDirty {
                        deliverFrame()
                        frameDirty = false
                    }
                    sendFramebufferUpdateRequest(incremental: true)
                }

            case .closed:
                return
            }
            compactBufferIfNeeded()
        }
    }

    private func parseFramebufferRect() -> Int? {
        var probe = RFBDataReader(data: buffer, offset: readOffset)
        guard let x = probe.readUInt16(), let y = probe.readUInt16(),
              let width = probe.readUInt16(), let height = probe.readUInt16(),
              let encoding = probe.readInt32() else { return nil }
        let xInt = Int(x), yInt = Int(y), widthInt = Int(width), heightInt = Int(height)
        guard widthInt > 0, heightInt > 0 else { return probe.offset }
        switch encoding {
        case 0:
            guard probe.skip(widthInt * heightInt * pixelFormat.bytesPerPixel) else { return nil }
        case 1:
            guard probe.skip(4) else { return nil }
        case 5:
            guard probeHextile(&probe, width: widthInt, height: heightInt) else { return nil }
        case -223:
            break
        default:
            fail("远程桌面返回了未支持的画面编码：\(encoding)")
            return nil
        }
        var reader = RFBDataReader(data: buffer, offset: readOffset)
        _ = reader.readUInt16(); _ = reader.readUInt16(); _ = reader.readUInt16(); _ = reader.readUInt16(); _ = reader.readInt32()
        switch encoding {
        case 0:
            applyRaw(&reader, x: xInt, y: yInt, width: widthInt, height: heightInt)
        case 1:
            guard let sourceX = reader.readUInt16(), let sourceY = reader.readUInt16() else { return nil }
            applyCopyRect(sourceX: Int(sourceX), sourceY: Int(sourceY), x: xInt, y: yInt, width: widthInt, height: heightInt)
        case 5:
            applyHextile(&reader, x: xInt, y: yInt, width: widthInt, height: heightInt)
        case -223:
            resizeFramebuffer(width: widthInt, height: heightInt)
        default:
            break
        }
        return probe.offset
    }

    private func probeHextile(_ reader: inout RFBDataReader, width: Int, height: Int) -> Bool {
        var background: UInt32 = 0
        var foreground: UInt32 = 0
        var tileY = 0
        while tileY < height {
            let tileHeight = min(16, height - tileY)
            var tileX = 0
            while tileX < width {
                let tileWidth = min(16, width - tileX)
                guard let subencoding = reader.readUInt8() else { return false }
                if subencoding & 1 != 0 {
                    guard reader.skip(tileWidth * tileHeight * pixelFormat.bytesPerPixel) else { return false }
                } else {
                    if subencoding & 2 != 0 {
                        guard let pixel = readPixel(&reader) else { return false }
                        background = pixel
                    }
                    if subencoding & 4 != 0 {
                        guard let pixel = readPixel(&reader) else { return false }
                        foreground = pixel
                    }
                    if subencoding & 8 != 0 {
                        guard let count = reader.readUInt8() else { return false }
                        for _ in 0..<Int(count) {
                            if subencoding & 16 != 0 { guard readPixel(&reader) != nil else { return false } }
                            guard reader.skip(2) else { return false }
                        }
                    }
                    _ = background
                    _ = foreground
                }
                tileX += tileWidth
            }
            tileY += tileHeight
        }
        return true
    }

    private func applyHextile(_ reader: inout RFBDataReader, x: Int, y: Int, width: Int, height: Int) {
        var background: UInt32 = 0
        var foreground: UInt32 = 0
        var tileY = 0
        while tileY < height {
            let tileHeight = min(16, height - tileY)
            var tileX = 0
            while tileX < width {
                let tileWidth = min(16, width - tileX)
                guard let subencoding = reader.readUInt8() else { return }
                if subencoding & 1 != 0 {
                    for row in 0..<tileHeight {
                        for column in 0..<tileWidth {
                            guard let pixel = readPixel(&reader) else { return }
                            writePixel(pixel, x: x + tileX + column, y: y + tileY + row)
                        }
                    }
                } else {
                    if subencoding & 2 != 0, let pixel = readPixel(&reader) { background = pixel }
                    fillRect(x: x + tileX, y: y + tileY, width: tileWidth, height: tileHeight, pixel: background)
                    if subencoding & 4 != 0, let pixel = readPixel(&reader) { foreground = pixel }
                    if subencoding & 8 != 0, let count = reader.readUInt8() {
                        for _ in 0..<Int(count) {
                            let color = subencoding & 16 != 0 ? (readPixel(&reader) ?? foreground) : foreground
                            guard let xy = reader.readUInt8(), let wh = reader.readUInt8() else { return }
                            fillRect(x: x + tileX + Int(xy >> 4), y: y + tileY + Int(xy & 0x0f),
                                     width: Int(wh >> 4) + 1, height: Int(wh & 0x0f) + 1, pixel: color)
                        }
                    }
                }
                tileX += tileWidth
            }
            tileY += tileHeight
        }
    }

    private func applyRaw(_ reader: inout RFBDataReader, x: Int, y: Int, width: Int, height: Int) {
        for row in 0..<height {
            for column in 0..<width {
                guard let pixel = readPixel(&reader) else { return }
                writePixel(pixel, x: x + column, y: y + row)
            }
        }
    }

    private func applyCopyRect(sourceX: Int, sourceY: Int, x: Int, y: Int, width: Int, height: Int) {
        guard framebufferWidth > 0, framebufferHeight > 0 else { return }
        let rowBytes = framebufferWidth * 4
        var copy = Data(count: width * height * 4)
        for row in 0..<height {
            let sourceStart = (sourceY + row) * rowBytes + sourceX * 4
            let targetStart = row * width * 4
            guard sourceStart >= 0, sourceStart + width * 4 <= framebuffer.count else { continue }
            copy.replaceSubrange(targetStart..<(targetStart + width * 4), with: framebuffer[sourceStart..<(sourceStart + width * 4)])
        }
        for row in 0..<height {
            let targetStart = (y + row) * rowBytes + x * 4
            let sourceStart = row * width * 4
            guard targetStart >= 0, targetStart + width * 4 <= framebuffer.count else { continue }
            framebuffer.replaceSubrange(targetStart..<(targetStart + width * 4), with: copy[sourceStart..<(sourceStart + width * 4)])
        }
        frameDirty = true
    }

    private func resizeFramebuffer(width: Int, height: Int) {
        guard validFramebufferSize(width: width, height: height) else { fail("远程屏幕尺寸无效。"); return }
        framebufferWidth = width
        framebufferHeight = height
        framebuffer = Data(repeating: 0, count: width * height * 4)
        frameDirty = true
        deliverConnected(name: "", width: width, height: height)
    }

    private func readPixel(_ reader: inout RFBDataReader) -> UInt32? {
        guard reader.remaining >= pixelFormat.bytesPerPixel else { return nil }
        var value: UInt32 = 0
        if pixelFormat.bigEndian {
            for _ in 0..<pixelFormat.bytesPerPixel { value = (value << 8) | UInt32(reader.readUInt8()!) }
        } else {
            for index in 0..<pixelFormat.bytesPerPixel { value |= UInt32(reader.readUInt8()!) << UInt32(index * 8) }
        }
        return value
    }

    private func writePixel(_ value: UInt32, x: Int, y: Int) {
        guard x >= 0, y >= 0, x < framebufferWidth, y < framebufferHeight else { return }
        let red = colorComponent((value >> pixelFormat.redShift) & pixelFormat.redMax, max: pixelFormat.redMax)
        let green = colorComponent((value >> pixelFormat.greenShift) & pixelFormat.greenMax, max: pixelFormat.greenMax)
        let blue = colorComponent((value >> pixelFormat.blueShift) & pixelFormat.blueMax, max: pixelFormat.blueMax)
        let offset = (y * framebufferWidth + x) * 4
        framebuffer[offset] = red
        framebuffer[offset + 1] = green
        framebuffer[offset + 2] = blue
        framebuffer[offset + 3] = 255
        frameDirty = true
    }

    private func colorComponent(_ value: UInt32, max: UInt32) -> UInt8 {
        guard max > 0 else { return 0 }
        return UInt8(min(UInt32(255), (value * 255 + max / 2) / max))
    }

    private func fillRect(x: Int, y: Int, width: Int, height: Int, pixel: UInt32) {
        guard width > 0, height > 0 else { return }
        for row in 0..<height {
            for column in 0..<width { writePixel(pixel, x: x + column, y: y + row) }
        }
    }

    private func readPixelFormat(_ reader: inout RFBDataReader) -> BridgeVncPixelFormat? {
        guard let bits = reader.readUInt8(), let depth = reader.readUInt8(), let endian = reader.readUInt8(),
              let trueColor = reader.readUInt8(), let redMax = reader.readUInt16(), let greenMax = reader.readUInt16(),
              let blueMax = reader.readUInt16(), let redShift = reader.readUInt8(), let greenShift = reader.readUInt8(),
              let blueShift = reader.readUInt8(), reader.skip(3) else { return nil }
        return BridgeVncPixelFormat(bitsPerPixel: Int(bits), depth: Int(depth), bigEndian: endian != 0,
                                    trueColor: trueColor != 0, redMax: UInt32(redMax), greenMax: UInt32(greenMax),
                                    blueMax: UInt32(blueMax), redShift: UInt32(redShift), greenShift: UInt32(greenShift),
                                    blueShift: UInt32(blueShift))
    }

    private func sendSetPixelFormat() {
        var data = Data([0, 0, 0, 0, 16, 16, 0, 1])
        data.append(contentsOf: Self.u16(31)); data.append(contentsOf: Self.u16(63)); data.append(contentsOf: Self.u16(31))
        data.append(contentsOf: [11, 5, 0, 0, 0, 0])
        send(data)
    }

    private func sendSetEncodings() {
        let encodings: [Int32] = [5, 1, 0, -223]
        var data = Data([2, 0])
        data.append(contentsOf: Self.u16(UInt16(encodings.count)))
        for encoding in encodings { data.append(contentsOf: Self.u32(UInt32(bitPattern: encoding))) }
        send(data)
    }

    private func sendFramebufferUpdateRequest(incremental: Bool) {
        guard framebufferWidth > 0, framebufferHeight > 0,
              framebufferWidth <= 65_535, framebufferHeight <= 65_535 else { return }
        var data = Data([3, incremental ? 1 : 0])
        data.append(contentsOf: Self.u16(0)); data.append(contentsOf: Self.u16(0))
        data.append(contentsOf: Self.u16(UInt16(framebufferWidth))); data.append(contentsOf: Self.u16(UInt16(framebufferHeight)))
        send(data)
    }

    func refresh() {
        queue.async { [weak self] in
            guard let self, !self.closed else { return }
            self.sendFramebufferUpdateRequest(incremental: false)
        }
    }

    private func send(_ data: Data) {
        guard !closed else { return }
        socket?.send(.data(data)) { [weak self] error in
            guard let error else { return }
            self?.queue.async { self?.fail("远程桌面发送失败：\(error.localizedDescription)") }
        }
    }

    private func requestCredentials(_ types: [String]) {
        deliverOnMain { [weak self] in self?.onCredentialsRequired?(types) }
    }

    private func deliverConnected(name: String, width: Int, height: Int) {
        deliverOnMain { [weak self] in self?.onConnected?(name, width, height) }
    }

    private func deliverClipboard(_ text: String) {
        deliverOnMain { [weak self] in self?.onClipboard?(text) }
    }

    private func deliverFrame() {
        let frame = BridgeRemoteDesktopFrame(width: framebufferWidth, height: framebufferHeight, pixels: framebuffer)
        deliverOnMain { [weak self] in self?.onFrame?(frame) }
    }

    private func deliverOnMain(_ action: @escaping () -> Void) {
        DispatchQueue.main.async(execute: action)
    }

    private func fail(_ message: String) {
        guard !closed, !failed else { return }
        failed = true
        closed = true
        phase = .closed
        socket?.cancel(with: .goingAway, reason: nil)
        session?.invalidateAndCancel()
        deliverOnMain { [weak self] in self?.onError?(message) }
    }

    private var available: Int { buffer.count - readOffset }

    private func peekUInt8() -> UInt8? { guard available > 0 else { return nil }; return buffer[readOffset] }

    private func readUInt8() -> UInt8? {
        guard available >= 1 else { return nil }
        defer { readOffset += 1 }
        return buffer[readOffset]
    }

    private func readUInt32() -> UInt32? {
        guard available >= 4 else { return nil }
        let result = (UInt32(buffer[readOffset]) << 24) | (UInt32(buffer[readOffset + 1]) << 16)
            | (UInt32(buffer[readOffset + 2]) << 8) | UInt32(buffer[readOffset + 3])
        readOffset += 4
        return result
    }

    private func readBytes(count: Int) -> Data? {
        guard count >= 0, available >= count else { return nil }
        let result = Data(buffer[readOffset..<(readOffset + count)])
        readOffset += count
        return result
    }

    private func readString(count: Int) -> String? {
        guard let data = readBytes(count: count) else { return nil }
        return String(data: data, encoding: .utf8) ?? String(data: data, encoding: .ascii) ?? ""
    }

    private func compactBufferIfNeeded() {
        guard readOffset > 1_048_576, readOffset > buffer.count / 2 else { return }
        buffer.removeSubrange(0..<readOffset)
        readOffset = 0
    }

    private func validFramebufferSize(width: Int, height: Int) -> Bool {
        width > 0 && height > 0 && width <= 16_384 && height <= 16_384
            && width <= Int.max / max(height, 1) / 4 && width * height * 4 <= 256 * 1024 * 1024
    }

    private static func vncResponse(challenge: Data, password: String) -> Data {
        var key = Array(password.utf8.prefix(8))
        key += Array(repeating: 0, count: 8 - key.count)
        key = key.map(reverseBits)
        return desEncrypt(data: challenge, key: Data(key))
    }

    private static func ardResponse(generator: BridgeBigUInt, prime: BridgeBigUInt,
                                   serverPublic: BridgeBigUInt, keyLength: Int,
                                   username: String, password: String) throws -> Data {
        let exponentData = try secureRandom(count: 32)
        let exponent = BridgeBigUInt(bigEndian: exponentData)
        let clientPublic = BridgeBigUInt.modularPower(base: generator, exponent: exponent, modulus: prime)
        let shared = BridgeBigUInt.modularPower(base: serverPublic, exponent: exponent, modulus: prime)
        let sharedData = shared.paddedData(length: keyLength)
        let md5 = Data(Insecure.MD5.hash(data: sharedData))
        var credentials = try secureRandom(count: 128)
        let userBytes = Array(username.utf8.prefix(63))
        let passwordBytes = Array(password.utf8.prefix(63))
        for index in 0..<userBytes.count { credentials[index] = userBytes[index] }
        credentials[userBytes.count] = 0
        for index in 0..<passwordBytes.count { credentials[64 + index] = passwordBytes[index] }
        credentials[64 + passwordBytes.count] = 0
        let encrypted = try aesECBEncrypt(data: credentials, key: md5)
        var response = encrypted
        response.append(clientPublic.paddedData(length: keyLength))
        return response
    }

    private static func secureRandom(count: Int) throws -> Data {
        var data = Data(repeating: 0, count: count)
        let status = data.withUnsafeMutableBytes { buffer in
            SecRandomCopyBytes(kSecRandomDefault, count, buffer.baseAddress!)
        }
        guard status == errSecSuccess else { throw BridgeRemoteDesktopError.authentication("无法生成安全的屏幕共享认证数据。") }
        return data
    }

    private static func desEncrypt(data: Data, key: Data) -> Data {
        var output = Data(repeating: 0, count: data.count + kCCBlockSizeDES)
        let outputCapacity = output.count
        var outputLength = 0
        output.withUnsafeMutableBytes { outputBuffer in
            data.withUnsafeBytes { inputBuffer in
                key.withUnsafeBytes { keyBuffer in
                    _ = CCCrypt(CCOperation(kCCEncrypt), CCAlgorithm(kCCAlgorithmDES), CCOptions(kCCOptionECBMode),
                                keyBuffer.baseAddress, kCCKeySizeDES, nil, inputBuffer.baseAddress, data.count,
                                outputBuffer.baseAddress, outputCapacity, &outputLength)
                }
            }
        }
        output.removeSubrange(outputLength..<output.count)
        return output
    }

    private static func aesECBEncrypt(data: Data, key: Data) throws -> Data {
        var output = Data(repeating: 0, count: data.count + kCCBlockSizeAES128)
        let outputCapacity = output.count
        var outputLength = 0
        let status = output.withUnsafeMutableBytes { outputBuffer in
            data.withUnsafeBytes { inputBuffer in
                key.withUnsafeBytes { keyBuffer in
                    CCCrypt(CCOperation(kCCEncrypt), CCAlgorithm(kCCAlgorithmAES), CCOptions(kCCOptionECBMode),
                            keyBuffer.baseAddress, kCCKeySizeAES128, nil, inputBuffer.baseAddress, data.count,
                            outputBuffer.baseAddress, outputCapacity, &outputLength)
                }
            }
        }
        guard status == kCCSuccess else { throw BridgeRemoteDesktopError.authentication("屏幕共享认证加密失败。") }
        output.removeSubrange(outputLength..<output.count)
        return output
    }

    private static func reverseBits(_ value: UInt8) -> UInt8 {
        var input = value
        var output: UInt8 = 0
        for _ in 0..<8 { output = (output << 1) | (input & 1); input >>= 1 }
        return output
    }

    private static func u16(_ value: UInt16) -> [UInt8] { [UInt8(value >> 8), UInt8(value & 0xff)] }
    private static func u32(_ value: UInt32) -> [UInt8] { [UInt8(value >> 24), UInt8((value >> 16) & 0xff), UInt8((value >> 8) & 0xff), UInt8(value & 0xff)] }
}

private struct BridgeVncPixelFormat {
    let bitsPerPixel: Int
    let depth: Int
    let bigEndian: Bool
    let trueColor: Bool
    let redMax: UInt32
    let greenMax: UInt32
    let blueMax: UInt32
    let redShift: UInt32
    let greenShift: UInt32
    let blueShift: UInt32

    var bytesPerPixel: Int { max(1, bitsPerPixel / 8) }

    static let rgb565 = BridgeVncPixelFormat(bitsPerPixel: 16, depth: 16, bigEndian: false, trueColor: true,
                                             redMax: 31, greenMax: 63, blueMax: 31,
                                             redShift: 11, greenShift: 5, blueShift: 0)
}

private struct RFBDataReader {
    let data: Data
    var offset: Int
    var remaining: Int { data.count - offset }

    mutating func readUInt8() -> UInt8? {
        guard remaining >= 1 else { return nil }
        defer { offset += 1 }
        return data[offset]
    }

    mutating func readUInt16() -> UInt16? {
        guard remaining >= 2 else { return nil }
        let value = UInt16(data[offset]) << 8 | UInt16(data[offset + 1])
        offset += 2
        return value
    }

    mutating func readInt32() -> Int32? {
        guard let value = readUInt32() else { return nil }
        return Int32(bitPattern: value)
    }

    mutating func readUInt32() -> UInt32? {
        guard remaining >= 4 else { return nil }
        let value = UInt32(data[offset]) << 24 | UInt32(data[offset + 1]) << 16
            | UInt32(data[offset + 2]) << 8 | UInt32(data[offset + 3])
        offset += 4
        return value
    }

    mutating func readData(count: Int) -> Data? {
        guard count >= 0, remaining >= count else { return nil }
        let value = Data(data[offset..<(offset + count)])
        offset += count
        return value
    }

    mutating func skip(_ count: Int) -> Bool {
        guard count >= 0, remaining >= count else { return false }
        offset += count
        return true
    }
}

private struct BridgeBigUInt {
    private var limbs: [UInt32]

    init(_ value: UInt32) { limbs = value == 0 ? [] : [value] }

    init(bigEndian data: Data) {
        limbs = []
        for byte in data {
            var carry = UInt64(byte)
            for index in limbs.indices {
                let value = UInt64(limbs[index]) * 256 + carry
                limbs[index] = UInt32(value & 0xffff_ffff)
                carry = value >> 32
            }
            if carry > 0 { limbs.append(UInt32(carry)) }
        }
        normalize()
    }

    private init(limbs: [UInt32]) {
        self.limbs = limbs
        normalize()
    }

    private var isZero: Bool { limbs.isEmpty }

    private mutating func normalize() {
        while limbs.last.map({ $0 == 0 }) == true { limbs.removeLast() }
    }

    private func isLess(than other: BridgeBigUInt) -> Bool {
        if limbs.count != other.limbs.count { return limbs.count < other.limbs.count }
        if limbs.isEmpty { return false }
        for index in stride(from: limbs.count - 1, through: 0, by: -1) {
            if limbs[index] != other.limbs[index] { return limbs[index] < other.limbs[index] }
        }
        return false
    }

    private func add(_ other: BridgeBigUInt) -> BridgeBigUInt {
        let count = max(limbs.count, other.limbs.count)
        var result = [UInt32](repeating: 0, count: count)
        var carry: UInt64 = 0
        for index in 0..<count {
            let value = UInt64(index < limbs.count ? limbs[index] : 0)
                + UInt64(index < other.limbs.count ? other.limbs[index] : 0) + carry
            result[index] = UInt32(value & 0xffff_ffff)
            carry = value >> 32
        }
        if carry > 0 { result.append(UInt32(carry)) }
        return BridgeBigUInt(limbs: result)
    }

    private func subtract(_ other: BridgeBigUInt) -> BridgeBigUInt {
        var result = [UInt32](repeating: 0, count: limbs.count)
        var borrow: Int64 = 0
        for index in limbs.indices {
            let value = Int64(limbs[index]) - Int64(index < other.limbs.count ? other.limbs[index] : 0) - borrow
            if value < 0 {
                result[index] = UInt32(value + (1 << 32))
                borrow = 1
            } else {
                result[index] = UInt32(value)
                borrow = 0
            }
        }
        return BridgeBigUInt(limbs: result)
    }

    private static func addMod(_ lhs: BridgeBigUInt, _ rhs: BridgeBigUInt, modulus: BridgeBigUInt) -> BridgeBigUInt {
        let modulusMinusRhs = modulus.subtract(rhs)
        return lhs.isLess(than: modulusMinusRhs) ? lhs.add(rhs) : lhs.subtract(modulusMinusRhs)
    }

    private static func multiplyMod(_ lhs: BridgeBigUInt, _ rhs: BridgeBigUInt, modulus: BridgeBigUInt) -> BridgeBigUInt {
        var result = BridgeBigUInt(0)
        var factor = lhs
        for limb in rhs.limbs {
            var bits = limb
            for _ in 0..<32 {
                if bits & 1 == 1 { result = addMod(result, factor, modulus: modulus) }
                factor = addMod(factor, factor, modulus: modulus)
                bits >>= 1
            }
        }
        return result
    }

    static func modularPower(base: BridgeBigUInt, exponent: BridgeBigUInt, modulus: BridgeBigUInt) -> BridgeBigUInt {
        guard !modulus.isZero else { return BridgeBigUInt(0) }
        var result = BridgeBigUInt(1)
        var factor = base.isLess(than: modulus) ? base : BridgeBigUInt(0)
        for limb in exponent.limbs {
            var bits = limb
            for _ in 0..<32 {
                if bits & 1 == 1 { result = multiplyMod(result, factor, modulus: modulus) }
                factor = multiplyMod(factor, factor, modulus: modulus)
                bits >>= 1
            }
        }
        return result
    }

    func paddedData(length: Int) -> Data {
        guard length > 0 else { return Data() }
        var bytes: [UInt8] = []
        for limb in limbs.reversed() {
            bytes.append(UInt8((limb >> 24) & 0xff)); bytes.append(UInt8((limb >> 16) & 0xff))
            bytes.append(UInt8((limb >> 8) & 0xff)); bytes.append(UInt8(limb & 0xff))
        }
        while bytes.first.map({ $0 == 0 }) == true { bytes.removeFirst() }
        if bytes.count > length { return Data(bytes.suffix(length)) }
        return Data(repeating: 0, count: length - bytes.count) + Data(bytes)
    }
}

private enum BridgeRemoteDesktopError: Error, LocalizedError {
    case authentication(String)

    var errorDescription: String? {
        switch self { case .authentication(let message): return message }
    }
}
