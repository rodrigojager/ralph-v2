import { dlopen } from "bun:ffi"

const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9
const JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION = 1
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x0000_2000
const PROCESS_TERMINATE = 0x0001
const PROCESS_SET_QUOTA = 0x0100
const TERMINATED_EXIT_CODE = 137
const JOB_CONTROLLER_STARTUP_TIMEOUT_MS = 20_000
const JOB_CONTROLLER_CLOSE_TIMEOUT_MS = 5_000

type WindowsHandle = number | bigint
type JobControllerProcess = Bun.Subprocess<"pipe", "pipe", "pipe">

function isUnavailableBunFfi(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes("dlopen() is not available in this build") ||
      error.message.includes("TinyCC is disabled"))
  )
}

const kernel32 = (() => {
  if (process.platform !== "win32") return undefined
  try {
    return dlopen("kernel32.dll", {
      CreateJobObjectW: { args: ["ptr", "ptr"], returns: "u64" },
      SetInformationJobObject: { args: ["u64", "u32", "ptr", "u32"], returns: "i32" },
      OpenProcess: { args: ["u32", "bool", "u32"], returns: "u64" },
      AssignProcessToJobObject: { args: ["u64", "u64"], returns: "i32" },
      QueryInformationJobObject: {
        args: ["u64", "u32", "ptr", "u32", "ptr"],
        returns: "i32",
      },
      TerminateJobObject: { args: ["u64", "u32"], returns: "i32" },
      CloseHandle: { args: ["u64"], returns: "i32" },
      GetLastError: { args: [], returns: "u32" },
    })
  } catch (error) {
    if (isUnavailableBunFfi(error)) return undefined
    throw error
  }
})()

const WINDOWS_JOB_CONTROLLER_SCRIPT = `
$ErrorActionPreference = "Stop"
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class RalphWindowsJobController {
  const int JobObjectExtendedLimitInformation = 9;
  const int JobObjectLimitKillOnJobClose = 0x00002000;
  const uint ProcessTerminate = 0x0001;
  const uint ProcessSetQuota = 0x0100;

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr CreateJobObject(IntPtr attributes, string name);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetInformationJobObject(
    IntPtr job,
    int informationClass,
    IntPtr information,
    uint informationLength
  );

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr OpenProcess(uint access, bool inheritHandle, uint processId);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool TerminateJobObject(IntPtr job, uint exitCode);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool CloseHandle(IntPtr handle);

  static void Fail(string operation) {
    throw new InvalidOperationException(
      operation + " failed with Windows error " + Marshal.GetLastWin32Error()
    );
  }

  public static void Run(int processId) {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) Fail("CreateJobObjectW");
    try {
      IntPtr limits = Marshal.AllocHGlobal(144);
      try {
        for (int index = 0; index < 144; index++) Marshal.WriteByte(limits, index, 0);
        Marshal.WriteInt32(limits, 16, JobObjectLimitKillOnJobClose);
        if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, limits, 144)) {
          Fail("SetInformationJobObject");
        }
      } finally {
        Marshal.FreeHGlobal(limits);
      }

      IntPtr process = OpenProcess(ProcessTerminate | ProcessSetQuota, false, (uint)processId);
      if (process == IntPtr.Zero) Fail("OpenProcess");
      try {
        if (!AssignProcessToJobObject(job, process)) Fail("AssignProcessToJobObject");
      } finally {
        CloseHandle(process);
      }

      Console.Out.WriteLine("RALPH_JOB_READY");
      Console.Out.Flush();
      string command;
      while ((command = Console.In.ReadLine()) != null) {
        if (command == "terminate") {
          if (!TerminateJobObject(job, 137)) Fail("TerminateJobObject");
          break;
        }
        if (command == "close") break;
      }
    } finally {
      CloseHandle(job);
    }
  }
}
'@
[RalphWindowsJobController]::Run([int]$env:RALPH_JOB_TARGET_PID)
`
const WINDOWS_JOB_CONTROLLER_ENCODED = Buffer.from(
  WINDOWS_JOB_CONTROLLER_SCRIPT,
  "utf16le",
).toString("base64")

function lastWindowsError(operation: string): Error {
  return new Error(
    `${operation} failed with Windows error ${kernel32?.symbols.GetLastError() ?? 0}`,
  )
}

function extendedLimitInformation(): Uint8Array {
  if (process.arch !== "x64" && process.arch !== "arm64") {
    throw new Error(`Windows Job Objects are unsupported on architecture ${process.arch}`)
  }
  // JOBOBJECT_EXTENDED_LIMIT_INFORMATION is 144 bytes on 64-bit Windows.
  // LimitFlags is the first DWORD after two LARGE_INTEGER fields.
  const bytes = new Uint8Array(144)
  new DataView(bytes.buffer).setUint32(16, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, true)
  return bytes
}

function controllerEnvironment(pid: number): Record<string, string> {
  const environment: Record<string, string> = { RALPH_JOB_TARGET_PID: String(pid) }
  for (const key of [
    "SystemRoot",
    "WINDIR",
    "SystemDrive",
    "PATH",
    "PATHEXT",
    "TEMP",
    "TMP",
    "PSModulePath",
  ]) {
    const value = process.env[key]
    if (value !== undefined) environment[key] = value
  }
  return environment
}

async function waitForControllerReady(
  child: JobControllerProcess,
  stderrPromise: Promise<string>,
): Promise<void> {
  const reader = child.stdout.getReader()
  const decoder = new TextDecoder()
  let output = ""
  let timeout: ReturnType<typeof setTimeout> | undefined
  const deadline = performance.now() + JOB_CONTROLLER_STARTUP_TIMEOUT_MS
  try {
    while (!output.includes("RALPH_JOB_READY")) {
      const remaining = deadline - performance.now()
      if (remaining <= 0) throw new Error("Windows Job Object controller readiness timed out")
      const item = await Promise.race([
        reader.read().then((result) => ({ kind: "read" as const, result })),
        new Promise<{ kind: "timeout" }>((resolveTimeout) => {
          timeout = setTimeout(() => resolveTimeout({ kind: "timeout" }), remaining)
        }),
      ])
      if (timeout) {
        clearTimeout(timeout)
        timeout = undefined
      }
      if (item.kind === "timeout") {
        throw new Error("Windows Job Object controller readiness timed out")
      }
      if (item.result.done) {
        const stderr = await stderrPromise.catch(() => "")
        throw new Error(
          `Windows Job Object controller exited before readiness: ${stderr || "no diagnostics"}`,
        )
      }
      output += decoder.decode(item.result.value, { stream: true })
    }
  } finally {
    if (timeout) clearTimeout(timeout)
    reader.releaseLock()
  }
}

async function controllerForProcess(pid: number): Promise<{
  child: JobControllerProcess
  stderr: Promise<string>
}> {
  const powershell = Bun.which("powershell.exe") ?? Bun.which("pwsh.exe") ?? Bun.which("pwsh")
  if (!powershell) throw new Error("PowerShell is unavailable for Windows Job Object containment")
  const child = Bun.spawn(
    [
      powershell,
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      WINDOWS_JOB_CONTROLLER_ENCODED,
    ],
    {
      env: controllerEnvironment(pid),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    },
  )
  const stderr = new Response(child.stderr).text()
  try {
    await waitForControllerReady(child, stderr)
    return { child, stderr }
  } catch (error) {
    if (child.exitCode === null) child.kill(9)
    await child.exited.catch(() => undefined)
    await stderr.catch(() => "")
    throw error
  }
}

/**
 * A private Windows Job Object whose handle remains owned by the supervisor.
 * Descendants inherit membership, so termination does not depend on the
 * original parent PID remaining alive. Windows ARM64 Bun builds without FFI
 * delegate handle ownership to a hidden PowerShell/.NET controller process.
 */
export class WindowsProcessJob {
  #handle: WindowsHandle | null
  #controller: JobControllerProcess | undefined
  #controllerStderr: Promise<string> | undefined
  #closing: Promise<void> | undefined

  private constructor(input: {
    handle?: WindowsHandle
    controller?: JobControllerProcess
    controllerStderr?: Promise<string>
  }) {
    this.#handle = input.handle ?? null
    this.#controller = input.controller
    this.#controllerStderr = input.controllerStderr
  }

  static async createForProcess(pid: number): Promise<WindowsProcessJob> {
    if (kernel32) {
      const handle = kernel32.symbols.CreateJobObjectW(null, null)
      if (!handle) throw lastWindowsError("CreateJobObjectW")
      const job = new WindowsProcessJob({ handle })
      try {
        job.#configureNative()
        job.#assignNative(pid)
        return job
      } catch (error) {
        await job.close()
        throw error
      }
    }
    const controller = await controllerForProcess(pid)
    return new WindowsProcessJob({
      controller: controller.child,
      controllerStderr: controller.stderr,
    })
  }

  hasProcessAccounting(): boolean {
    return this.#handle !== null && kernel32 !== undefined
  }

  activeProcessCount(): number {
    const job = this.#handle
    if (!job || !kernel32) return 0
    // JOBOBJECT_BASIC_ACCOUNTING_INFORMATION is 48 bytes. ActiveProcesses is
    // the DWORD at byte offset 40 on both 32-bit and 64-bit Windows.
    const accounting = new Uint8Array(48)
    const queried = kernel32.symbols.QueryInformationJobObject(
      job,
      JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION,
      accounting,
      accounting.byteLength,
      null,
    )
    if (queried === 0) throw lastWindowsError("QueryInformationJobObject")
    return new DataView(accounting.buffer).getUint32(40, true)
  }

  terminate(): boolean {
    const job = this.#handle
    if (job && kernel32) {
      return kernel32.symbols.TerminateJobObject(job, TERMINATED_EXIT_CODE) !== 0
    }
    const controller = this.#controller
    if (!controller || controller.exitCode !== null) return false
    try {
      void Promise.resolve(controller.stdin.write("terminate\n")).catch(() => undefined)
      return true
    } catch {
      return false
    }
  }

  close(): Promise<void> {
    this.#closing ??= this.#closeOnce()
    return this.#closing
  }

  #configureNative(): void {
    const job = this.#requiredHandle()
    const limits = extendedLimitInformation()
    if (
      kernel32?.symbols.SetInformationJobObject(
        job,
        JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
        limits,
        limits.byteLength,
      ) === 0
    ) {
      throw lastWindowsError("SetInformationJobObject")
    }
  }

  #assignNative(pid: number): void {
    const job = this.#requiredHandle()
    const processHandle = kernel32?.symbols.OpenProcess(
      PROCESS_TERMINATE | PROCESS_SET_QUOTA,
      false,
      pid,
    )
    if (!processHandle) throw lastWindowsError("OpenProcess")
    try {
      if (kernel32?.symbols.AssignProcessToJobObject(job, processHandle) === 0) {
        throw lastWindowsError("AssignProcessToJobObject")
      }
    } finally {
      kernel32?.symbols.CloseHandle(processHandle)
    }
  }

  async #closeOnce(): Promise<void> {
    const job = this.#handle
    this.#handle = null
    if (job && kernel32) kernel32.symbols.CloseHandle(job)

    const controller = this.#controller
    const stderrPromise = this.#controllerStderr
    this.#controller = undefined
    this.#controllerStderr = undefined
    if (!controller) return
    if (controller.exitCode === null) {
      try {
        await controller.stdin.write("close\n")
        await controller.stdin.end()
      } catch {
        controller.kill(9)
      }
    }
    let timeout: ReturnType<typeof setTimeout> | undefined
    const outcome = await Promise.race([
      controller.exited.then(() => "exited" as const),
      new Promise<"timeout">((resolveTimeout) => {
        timeout = setTimeout(() => resolveTimeout("timeout"), JOB_CONTROLLER_CLOSE_TIMEOUT_MS)
      }),
    ])
    if (timeout) clearTimeout(timeout)
    if (outcome === "timeout" && controller.exitCode === null) {
      controller.kill(9)
      await controller.exited.catch(() => undefined)
    }
    await stderrPromise?.catch(() => "")
  }

  #requiredHandle(): WindowsHandle {
    if (!this.#handle) throw new Error("Windows Job Object is already closed")
    return this.#handle
  }
}
