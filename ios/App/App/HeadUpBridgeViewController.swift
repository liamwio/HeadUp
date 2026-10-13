import UIKit
import Capacitor

class HeadUpBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(HeadUpDevicePlugin())
    }
}

/// Streams bounded export chunks to a temporary file, then asks the system to
/// copy it to a user-selected destination. No photo-library-wide access needed.
@objc(HeadUpDevicePlugin)
public class HeadUpDevicePlugin: CAPPlugin, CAPBridgedPlugin, UIDocumentPickerDelegate {
    public let identifier = "HeadUpDevicePlugin"
    public let jsName = "HeadUpDevice"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "beginExport", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "appendExport", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "finishExport", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "abortExport", returnType: CAPPluginReturnPromise)
    ]
    private var token: String?
    private var directory: URL?
    private var file: URL?
    private var handle: FileHandle?
    private var expected = 0
    private var written = 0
    private var finishing: CAPPluginCall?
    private weak var picker: UIDocumentPickerViewController?

    @objc public func beginExport(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard self.token == nil else { call.reject("另一个文件正在导出"); return }
            guard let size = call.getInt("size"), size >= 0, size <= 64 * 1024 * 1024 else {
                call.reject("文件超过64MB，请使用分卷备份"); return
            }
            let proposed = (call.getString("name") ?? "headup-export") as NSString
            let leaf = proposed.lastPathComponent
            let name = leaf.isEmpty || leaf == "." || leaf == ".." ? "headup-export" : String(leaf.prefix(150))
            let key = UUID().uuidString
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent("headup-" + key, isDirectory: true)
            let file = directory.appendingPathComponent(name)
            do {
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
                self.directory = directory
                guard FileManager.default.createFile(atPath: file.path, contents: nil,
                    attributes: [.protectionKey: FileProtectionType.complete]) else {
                    throw CocoaError(.fileWriteUnknown)
                }
                self.handle = try FileHandle(forWritingTo: file)
                self.file = file; self.token = key; self.expected = size; self.written = 0
                call.resolve(["token": key])
            } catch { self.cleanUp(); call.reject("无法准备导出文件") }
        }
    }

    @objc public func appendExport(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let key = call.getString("token"), key == self.token,
                  self.finishing == nil, let handle = self.handle,
                  let text = call.getString("data"), text.utf8.count <= 262144,
                  let bytes = Data(base64Encoded: text), bytes.count <= 192 * 1024,
                  self.written + bytes.count <= self.expected else {
                call.reject("导出数据无效或会话已结束"); return
            }
            do { try handle.write(contentsOf: bytes); self.written += bytes.count; call.resolve() }
            catch { self.cleanUp(); call.reject("写入文件失败，请检查可用空间") }
        }
    }

    @objc public func finishExport(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let key = call.getString("token"), key == self.token,
                  self.finishing == nil, self.written == self.expected,
                  let file = self.file, let controller = self.bridge?.viewController,
                  controller.presentedViewController == nil else {
                call.reject("导出尚未完成或已有系统窗口打开"); return
            }
            do { try self.handle?.close(); self.handle = nil }
            catch { self.cleanUp(); call.reject("无法完成文件写入"); return }
            let picker = UIDocumentPickerViewController(forExporting: [file], asCopy: true)
            picker.delegate = self; picker.modalPresentationStyle = .fullScreen
            self.finishing = call; self.picker = picker
            controller.present(picker, animated: true)
        }
    }

    @objc public func abortExport(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if let key = call.getString("token"), key == self.token {
                let pending = self.finishing
                self.picker?.dismiss(animated: true)
                self.cleanUp(); pending?.reject("已取消保存")
            }
            call.resolve()
        }
    }

    public func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        let pending = finishing
        cleanUp()
        if urls.isEmpty { pending?.reject("未选择保存位置") } else { pending?.resolve() }
    }

    public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        let pending = finishing
        cleanUp(); pending?.reject("已取消保存")
    }

    private func cleanUp() {
        try? handle?.close()
        // Only this session's UUID directory is owned by the exporter.
        if let directory = directory { try? FileManager.default.removeItem(at: directory) }
        handle = nil; token = nil; directory = nil; file = nil
        finishing = nil; picker = nil; expected = 0; written = 0
    }
}
