// Standalone, unprivileged replacement helper. The running App owns preparation and user consent.
// This helper never changes code-signing, quarantine, Gatekeeper, or system policy.
import Foundation
import AppKit
import Darwin

@_silgen_name("proc_pidpath") private func processPath(_ pid: Int32, _ buffer: UnsafeMutableRawPointer, _ size: UInt32) -> Int32
@_silgen_name("renameatx_np") private func exchangePaths(_ fromFD: Int32, _ from: UnsafePointer<CChar>, _ toFD: Int32, _ to: UnsafePointer<CChar>, _ flags: UInt32) -> Int32

private struct UpdateRequest: Decodable {
    let schemaVersion: Int
    let runId: String
    let nonce: String
    let parentPid: Int32
    let parentStartedAt: String
    let currentApp: String
    let stagedApp: String
    let workDir: String
    let expectedBundleId: String
    let previousVersion: String
    let previousBuildId: String
    let expectedVersion: String
    let expectedBuildId: String
    let expectedTarget: String
    let launchEnvironment: [String: String]?
    let timeoutMs: Int?
}
private struct HelperFailure: Error, CustomStringConvertible {
    let description: String
    init(_ value: String) { description = value }
}
private struct BuildIdentity: Equatable {
    let version: String
    let buildId: String
}
private struct OwnedProcess {
    let pid: Int32
    let startedAt: String
}
private let fm = FileManager.default
private var request: UpdateRequest?
private var lockFD: Int32 = -1
private var launched: OwnedProcess?
private var swapped = false
private var replacementLaunchAttempted = false
private var safeParentExited = false
private var safeToWrite = false
private let environmentKeys: Set<String> = [
    "XR_COLLECTOR_PROFILE", "XR_COLLECTOR_VAULT", "XR_COLLECTOR_AGENT_PORT",
    "XR_COLLECTOR_VALIDATION_HIDDEN", "XR_COLLECTOR_VALIDATION_CONTROL",
    "XR_COLLECTOR_VALIDATION_WINDOW_SIZE", "XR_COLLECTOR_UPDATE_BASE_URL",
    "XR_COLLECTOR_EXPORT_DIR", "XR_COLLECTOR_BACKUP_DIR"
]
private func fail(_ text: String) -> HelperFailure { HelperFailure(text) }
private func canonical(_ path: String) throws -> String {
    guard path.hasPrefix("/"), !path.contains("\0") else { throw fail("path_not_absolute") }
    let url = URL(fileURLWithPath: path)
    guard url.standardizedFileURL.path == path, url.resolvingSymlinksInPath().path == path else { throw fail("path_contains_symlink_or_traversal") }
    return path
}
private func metadata(_ path: String, directory: Bool) throws -> stat {
    var value = stat()
    guard lstat(path, &value) == 0, value.st_uid == getuid() else { throw fail("path_not_owned") }
    guard value.st_mode & mode_t(S_IFMT) == mode_t(directory ? S_IFDIR : S_IFREG) else { throw fail("unexpected_path_type") }
    return value
}
private func readObject(_ path: String, limit: Int = 65536) throws -> [String: Any] {
    let attributes = try metadata(path, directory: false)
    guard attributes.st_size > 0, attributes.st_size <= limit else { throw fail("json_size_invalid") }
    guard let object = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: path))) as? [String: Any] else { throw fail("json_object_required") }
    return object
}
private func synchronizeDirectory(_ path: String) {
    let fd = open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
    if fd >= 0 { _ = fsync(fd); close(fd) }
}
private func writeObject(_ object: [String: Any], to path: String) throws {
    let parent = URL(fileURLWithPath: path).deletingLastPathComponent().path
    let temporary = parent + "/.helper-" + UUID().uuidString
    let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    let fd = open(temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
    guard fd >= 0 else { throw fail("status_create_failed") }
    defer { close(fd); _ = unlink(temporary) }
    try data.withUnsafeBytes { bytes in
        var offset = 0
        while offset < bytes.count {
            let count = Darwin.write(fd, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
            guard count > 0 else { throw fail("status_write_failed") }
            offset += count
        }
    }
    guard fsync(fd) == 0, rename(temporary, path) == 0 else { throw fail("status_commit_failed") }
    synchronizeDirectory(parent)
}
private func status(_ phase: String, _ extra: [String: Any] = [:]) throws {
    guard safeToWrite, let r = request else { return }
    var object: [String: Any] = ["schemaVersion": 1, "runId": r.runId, "phase": phase, "at": ISO8601DateFormatter().string(from: Date())]
    for (key, value) in extra { object[key] = value }
    try writeObject(object, to: r.workDir + "/result.json")
}
private func pidPath(_ pid: Int32) -> String? {
    var buffer = [CChar](repeating: 0, count: 4096)
    guard processPath(pid, &buffer, UInt32(buffer.count)) > 0 else { return nil }
    return String(cString: buffer)
}
private func processStartedAt(_ pid: Int32) -> String? {
    let task = Process(), pipe = Pipe()
    task.executableURL = URL(fileURLWithPath: "/bin/ps")
    task.arguments = ["-p", String(pid), "-o", "lstart="]
    task.environment = ["LC_ALL": "C"]
    task.standardOutput = pipe
    task.standardError = FileHandle.nullDevice
    do { try task.run() } catch { return nil }
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    task.waitUntilExit()
    let value = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
    return task.terminationStatus == 0 && value != "" ? value : nil
}
private func inside(_ path: String, _ directory: String) -> Bool { path.hasPrefix(directory + "/") }
private func sameProcess(_ process: OwnedProcess, appPath: String) -> Bool {
    guard let executable = pidPath(process.pid), inside(executable, appPath + "/Contents"), processStartedAt(process.pid) == process.startedAt else { return false }
    return true
}
private func pumpRunLoop() { RunLoop.current.run(until: Date().addingTimeInterval(0.05)) }
private func waitFor(_ seconds: TimeInterval, until condition: () throws -> Bool) throws -> Bool {
    let deadline = Date().addingTimeInterval(seconds)
    repeat { if try condition() { return true }; pumpRunLoop() } while Date() < deadline
    return try condition()
}
private func identity(_ appPath: String, _ r: UpdateRequest) throws -> BuildIdentity {
    _ = try canonical(appPath)
    _ = try metadata(appPath, directory: true)
    let infoPath = appPath + "/Contents/Info.plist"
    _ = try metadata(infoPath, directory: false)
    guard let info = try PropertyListSerialization.propertyList(from: Data(contentsOf: URL(fileURLWithPath: infoPath)), format: nil) as? [String: Any],
          info["CFBundleIdentifier"] as? String == r.expectedBundleId,
          let version = info["CFBundleShortVersionString"] as? String,
          let executable = info["CFBundleExecutable"] as? String,
          !executable.isEmpty, !executable.contains("/"), !executable.contains("\0") else { throw fail("bundle_identity_invalid") }
    let executablePath = appPath + "/Contents/MacOS/" + executable
    _ = try metadata(executablePath, directory: false)
    guard access(executablePath, X_OK) == 0 else { throw fail("bundle_executable_invalid") }
    let build = try readObject(appPath + "/Contents/Resources/build-info.json")
    guard build["schemaVersion"] as? Int == 1, build["kind"] as? String == "packaged",
          build["version"] as? String == version, build["target"] as? String == r.expectedTarget,
          let buildId = build["buildId"] as? String,
          !buildId.isEmpty else { throw fail("bundle_build_info_invalid") }
    return BuildIdentity(version: version, buildId: buildId)
}
private func exchange(_ r: UpdateRequest) throws {
    // RENAME_SWAP is atomic on one filesystem: the public application path never disappears.
    let result = r.currentApp.withCString { from in r.stagedApp.withCString { to in exchangePaths(AT_FDCWD, from, AT_FDCWD, to, 0x00000002) } }
    guard result == 0 else { throw fail("atomic_exchange_failed_\(errno)") }
    synchronizeDirectory(URL(fileURLWithPath: r.currentApp).deletingLastPathComponent().path)
    synchronizeDirectory(r.workDir)
}
private func validateMessage(_ path: String, _ r: UpdateRequest) throws -> [String: Any]? {
    guard fm.fileExists(atPath: path) else { return nil }
    let value = try readObject(path)
    guard value["schemaVersion"] as? Int == 1, value["runId"] as? String == r.runId, value["nonce"] as? String == r.nonce else { throw fail("control_identity_mismatch") }
    return value
}
private func acknowledgement(_ r: UpdateRequest, process: OwnedProcess?) throws -> Bool {
    guard let object = try validateMessage(r.workDir + "/ack.json", r),
          object["version"] as? String == r.expectedVersion,
          object["buildId"] as? String == r.expectedBuildId,
          let pidNumber = object["pid"] as? NSNumber,
          let startedAt = object["launchedStartedAt"] as? String else { return false }
    let ackProcess = OwnedProcess(pid: pidNumber.int32Value, startedAt: startedAt)
    guard process == nil || (process!.pid == ackProcess.pid && process!.startedAt == ackProcess.startedAt),
          sameProcess(ackProcess, appPath: r.currentApp),
          try identity(r.currentApp, r) == BuildIdentity(version: r.expectedVersion, buildId: r.expectedBuildId) else { return false }
    return true
}
private func launch(_ r: UpdateRequest, rollback: Bool = false) throws -> OwnedProcess {
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.createsNewApplicationInstance = true
    configuration.activates = false
    configuration.arguments = rollback ? [] : ["--xr-update-run=" + r.workDir, "--xr-update-nonce=" + r.nonce]
    var environment = r.launchEnvironment ?? [:]
    if !rollback { environment["XR_COLLECTOR_UPDATE_RUN"] = r.workDir; environment["XR_COLLECTOR_UPDATE_NONCE"] = r.nonce }
    configuration.environment = environment
    var application: NSRunningApplication?, launchError: Error?, completed = false
    NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: r.currentApp), configuration: configuration) { value, error in
        application = value; launchError = error; completed = true
    }
    guard try waitFor(30, until: { completed }), launchError == nil, let application = application,
          let startedAt = processStartedAt(application.processIdentifier) else { throw fail("application_launch_failed") }
    let process = OwnedProcess(pid: application.processIdentifier, startedAt: startedAt)
    guard sameProcess(process, appPath: r.currentApp) else { throw fail("launched_process_identity_mismatch") }
    return process
}
private func stopLaunched(_ process: OwnedProcess, _ r: UpdateRequest) throws {
    if sameProcess(process, appPath: r.currentApp) {
        // Ask the exact replacement App to quit through its normal runtime shutdown. A signal
        // could leave its search child or a write behind while the old App starts again.
        guard let application = NSRunningApplication(processIdentifier: process.pid),
              sameProcess(process, appPath: r.currentApp), application.terminate() else { throw fail("new_application_declined_quit") }
        guard try waitFor(15, until: { !sameProcess(process, appPath: r.currentApp) }) else { throw fail("new_application_did_not_exit") }
    }
    guard try shutdownAcknowledged(process, r) else { throw fail("new_application_shutdown_unconfirmed") }
}
private func shutdownAcknowledged(_ process: OwnedProcess, _ r: UpdateRequest) throws -> Bool {
    guard let value = try validateMessage(r.workDir + "/shutdown-safe.json", r) else { return false }
    return (value["pid"] as? NSNumber)?.int32Value == process.pid
        && value["startedAt"] as? String == process.startedAt
        && value["version"] as? String == r.expectedVersion
        && value["buildId"] as? String == r.expectedBuildId
}
private func complete(_ r: UpdateRequest) throws {
    guard try acknowledgement(r, process: launched) else { throw fail("runtime_acknowledgement_invalid") }
    try status("succeeded", ["version": r.expectedVersion, "buildId": r.expectedBuildId])
    // A verified, running B is committed before deleting A. Cleanup failure cannot roll B back.
    do {
        guard try identity(r.stagedApp, r) == BuildIdentity(version: r.previousVersion, buildId: r.previousBuildId) else { throw fail("backup_identity_changed") }
        try fm.removeItem(atPath: r.stagedApp)
        synchronizeDirectory(r.workDir)
    } catch { try? status("succeeded", ["version": r.expectedVersion, "buildId": r.expectedBuildId, "backupRetained": true]) }
}
private func rollback(_ r: UpdateRequest, reason: String) throws {
    if let process = launched { try stopLaunched(process, r) }
    guard try identity(r.currentApp, r) == BuildIdentity(version: r.expectedVersion, buildId: r.expectedBuildId),
          try identity(r.stagedApp, r) == BuildIdentity(version: r.previousVersion, buildId: r.previousBuildId) else { throw fail("rollback_identity_mismatch") }
    try exchange(r)
    swapped = false
    try status("rolled_back", ["reason": reason, "version": r.previousVersion])
    let original = try launch(r, rollback: true)
    try status("rolled_back", ["reason": reason, "version": r.previousVersion, "restartedPid": original.pid])
}
private func main() throws {
    guard CommandLine.arguments.count == 3, ["--request", "--recover", "--rollback", "--cleanup"].contains(CommandLine.arguments[1]) else { throw fail("usage_expected_request_path") }
    let recovering = CommandLine.arguments[1] == "--recover"
    let rollingBack = CommandLine.arguments[1] == "--rollback"
    let cleaning = CommandLine.arguments[1] == "--cleanup"
    let requestPath = try canonical(CommandLine.arguments[2])
    let attributes = try metadata(requestPath, directory: false)
    guard attributes.st_size > 0, attributes.st_size <= 65536, attributes.st_mode & 0o077 == 0 else { throw fail("request_permissions_or_size_invalid") }
    let r = try JSONDecoder().decode(UpdateRequest.self, from: Data(contentsOf: URL(fileURLWithPath: requestPath)))
    request = r
    guard r.schemaVersion == 1, let uuid = UUID(uuidString: r.runId), uuid.uuidString.lowercased() == r.runId,
          r.nonce.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
          r.expectedTarget == "darwin-arm64",
          r.expectedVersion != r.previousVersion, r.expectedBuildId != r.previousBuildId,
          (r.timeoutMs ?? 60000) >= 1000, (r.timeoutMs ?? 60000) <= 120000 else { throw fail("request_identity_invalid") }
    let ownPath = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath().path
    let suffix = "/Contents/Resources/bin/xr-mac-update-helper"
    guard ownPath.hasSuffix(suffix) else { throw fail("helper_not_in_application_bundle") }
    let ownApp = String(ownPath.dropLast(suffix.count))
    guard try canonical(r.currentApp) == ownApp, ownApp.hasSuffix(".app") else { throw fail("current_application_mismatch") }
    let parent = URL(fileURLWithPath: ownApp).deletingLastPathComponent().path
    guard try canonical(r.workDir) == parent + "/.xr-update-" + r.runId,
          try canonical(r.stagedApp) == r.workDir + "/stage.app", requestPath == r.workDir + "/request.json" else { throw fail("workspace_layout_invalid") }
    let work = try metadata(r.workDir, directory: true)
    guard work.st_mode & 0o777 == 0o700, access(parent, W_OK | X_OK) == 0,
          (r.launchEnvironment ?? [:]).allSatisfy({ environmentKeys.contains($0.key) && !$0.value.contains("\0") && $0.value.utf8.count <= 4096 }) else { throw fail("workspace_permissions_or_environment_invalid") }
    safeToWrite = true
    lockFD = open(r.workDir + "/helper.lock", O_RDWR | O_CREAT | O_NOFOLLOW, 0o600)
    guard lockFD >= 0, flock(lockFD, LOCK_EX | LOCK_NB) == 0 else { safeToWrite = false; throw fail("helper_already_running") }
    let caller = getppid()
    guard let callerPath = pidPath(caller), inside(callerPath, r.currentApp + "/Contents") else { throw fail("caller_not_current_application") }
    let old = BuildIdentity(version: r.previousVersion, buildId: r.previousBuildId)
    let new = BuildIdentity(version: r.expectedVersion, buildId: r.expectedBuildId)
    let currentIdentity = try identity(r.currentApp, r)
    if cleaning {
        let result = try readObject(r.workDir + "/result.json")
        guard result["schemaVersion"] as? Int == 1, result["runId"] as? String == r.runId,
              let phase = result["phase"] as? String, ["succeeded", "rolled_back", "failed"].contains(phase),
              phase == "succeeded" ? currentIdentity == new : currentIdentity == old else { throw fail("cleanup_terminal_identity_mismatch") }
        // Keep the journal lock through recursive removal so no recovery helper can enter between
        // validation and deletion. Suppress catch-path status writes once cleanup begins.
        safeToWrite = false
        try fm.removeItem(atPath: r.workDir)
        synchronizeDirectory(parent)
        flock(lockFD, LOCK_UN); close(lockFD); lockFD = -1
        return
    }
    if rollingBack {
        guard currentIdentity == new, try identity(r.stagedApp, r) == old,
              let handoff = try validateMessage(r.workDir + "/handoff.json", r),
              (handoff["parentPid"] as? NSNumber)?.int32Value == r.parentPid,
              handoff["expectedVersion"] as? String == r.expectedVersion,
              handoff["expectedBuildId"] as? String == r.expectedBuildId,
              let startedAt = processStartedAt(caller) else { throw fail("rollback_preflight_identity_mismatch") }
        let failedApplication = OwnedProcess(pid: caller, startedAt: startedAt)
        try status("rollback_prepared", ["callerPid": caller, "callerStartedAt": startedAt])
        guard try waitFor(30, until: { !sameProcess(failedApplication, appPath: r.currentApp) }) else { throw fail("rollback_caller_exit_timeout") }
        guard try shutdownAcknowledged(failedApplication, r) else { throw fail("rollback_caller_shutdown_unconfirmed") }
        try rollback(r, reason: "replacement_startup_failed")
        return
    }
    if recovering {
        // Infer the actual exchange from both bundle identities; a killed helper may not have
        // committed its last journal write. A valid ready B may finish an interrupted attempt.
        if currentIdentity == new {
            if try acknowledgement(r, process: nil) {
                if fm.fileExists(atPath: r.stagedApp) {
                    guard try identity(r.stagedApp, r) == old else { throw fail("recovery_backup_identity_mismatch") }
                    try complete(r)
                } else { try status("succeeded", ["version": r.expectedVersion, "buildId": r.expectedBuildId]) }
            } else {
                // B may still be starting or its candidate ack may have raced with process exit.
                // Preserve the recovery boundary; never turn this into permission to downgrade.
                try status("recovery_required", ["reason": "replacement_runtime_not_ready", "backupRetained": true])
            }
            return
        }
        guard currentIdentity == old, try identity(r.stagedApp, r) == new else { throw fail("recovery_requires_runtime_ready_or_original_application") }
        try status("rolled_back", ["reason": "interrupted_before_commit", "version": r.previousVersion])
        return
    }
    guard caller == r.parentPid, processStartedAt(caller) == r.parentStartedAt,
          currentIdentity == old, try identity(r.stagedApp, r) == new,
          !fm.fileExists(atPath: r.workDir + "/ack.json"), !fm.fileExists(atPath: r.workDir + "/handoff.json") else { throw fail("preflight_identity_mismatch") }
    var currentStat = stat(), stageStat = stat()
    guard stat(r.currentApp, &currentStat) == 0, stat(r.stagedApp, &stageStat) == 0, currentStat.st_dev == stageStat.st_dev else { throw fail("staging_not_same_filesystem") }
    try status("prepared")
    let originalProcess = OwnedProcess(pid: r.parentPid, startedAt: r.parentStartedAt)
    var handoff = false
    while !handoff {
        if try validateMessage(r.workDir + "/abort.json", r) != nil { throw fail("update_cancelled") }
        if let message = try validateMessage(r.workDir + "/handoff.json", r) {
            guard (message["parentPid"] as? NSNumber)?.int32Value == r.parentPid,
                  message["expectedVersion"] as? String == r.expectedVersion,
                  message["expectedBuildId"] as? String == r.expectedBuildId else { throw fail("handoff_identity_mismatch") }
            handoff = true
        } else {
            guard sameProcess(originalProcess, appPath: r.currentApp) else { throw fail("parent_exited_without_handoff") }
            Thread.sleep(forTimeInterval: 0.1)
        }
    }
    try status("waiting_for_exit")
    guard try waitFor(30, until: { !sameProcess(originalProcess, appPath: r.currentApp) }) else { throw fail("parent_exit_timeout") }
    safeParentExited = true
    // Revalidate just before touching either bundle, after the source process is gone.
    guard try identity(r.currentApp, r) == old, try identity(r.stagedApp, r) == new else { throw fail("pre_swap_identity_changed") }
    try exchange(r)
    swapped = true
    try status("swapped")
    replacementLaunchAttempted = true
    launched = try launch(r)
    try status("waiting_for_runtime", ["launchedPid": launched!.pid, "launchedStartedAt": launched!.startedAt])
    let acknowledged = try waitFor(Double(r.timeoutMs ?? 60000) / 1000, until: { try acknowledgement(r, process: launched) })
    guard try (acknowledged || acknowledgement(r, process: launched)) else {
        try status("recovery_required", ["reason": "runtime_acknowledgement_timeout", "backupRetained": true])
        return
    }
    try complete(r)
    swapped = false
}

do {
    try main()
    if lockFD >= 0 { close(lockFD) }
} catch {
    let reason = String(describing: error)
    if swapped, let r = request {
        if replacementLaunchAttempted {
            do {
                if try acknowledgement(r, process: launched) { try complete(r); swapped = false }
                else { try status("recovery_required", ["reason": reason, "backupRetained": true]) }
            } catch { try? status("recovery_required", ["reason": reason, "recoveryError": String(describing: error), "backupRetained": true]) }
        } else {
            do { try rollback(r, reason: reason) }
            catch { try? status("recovery_required", ["reason": reason, "recoveryError": String(describing: error)]) }
        }
    } else if safeParentExited, let r = request {
        do {
            guard try identity(r.currentApp, r) == BuildIdentity(version: r.previousVersion, buildId: r.previousBuildId) else { throw fail("original_application_identity_changed") }
            let original = try launch(r, rollback: true)
            try status("rolled_back", ["reason": reason, "version": r.previousVersion, "restartedPid": original.pid])
        } catch { try? status("recovery_required", ["reason": reason, "recoveryError": String(describing: error)]) }
    } else { try? status("failed", ["reason": reason]) }
    if lockFD >= 0 { close(lockFD) }
    FileHandle.standardError.write(Data((reason + "\n").utf8))
    exit(1)
}
