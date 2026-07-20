import { dlopen, type Pointer } from "bun:ffi"

const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9
const JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION = 1
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x0000_2000
const PROCESS_TERMINATE = 0x0001
const PROCESS_SET_QUOTA = 0x0100
const TERMINATED_EXIT_CODE = 137

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
      CreateJobObjectW: { args: ["ptr", "ptr"], returns: "ptr" },
      SetInformationJobObject: { args: ["ptr", "u32", "ptr", "u32"], returns: "i32" },
      OpenProcess: { args: ["u32", "bool", "u32"], returns: "ptr" },
      AssignProcessToJobObject: { args: ["ptr", "ptr"], returns: "i32" },
      QueryInformationJobObject: {
        args: ["ptr", "u32", "ptr", "u32", "ptr"],
        returns: "i32",
      },
      TerminateJobObject: { args: ["ptr", "u32"], returns: "i32" },
      CloseHandle: { args: ["ptr"], returns: "i32" },
      GetLastError: { args: [], returns: "u32" },
    })
  } catch (error) {
    if (isUnavailableBunFfi(error)) return undefined
    throw error
  }
})()

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

/**
 * A private Windows Job Object whose handle remains owned by the supervisor.
 * Descendants inherit membership, so termination does not depend on the
 * original parent PID remaining alive.
 */
export class WindowsProcessJob {
  #handle: Pointer | null

  private constructor(handle: Pointer) {
    this.#handle = handle
  }

  static create(): WindowsProcessJob {
    if (!kernel32) throw new Error("Windows Job Objects are unavailable in this Bun build")
    const handle = kernel32.symbols.CreateJobObjectW(null, null)
    if (!handle) throw lastWindowsError("CreateJobObjectW")
    const limits = extendedLimitInformation()
    if (
      kernel32.symbols.SetInformationJobObject(
        handle,
        JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
        limits,
        limits.byteLength,
      ) === 0
    ) {
      const error = lastWindowsError("SetInformationJobObject")
      kernel32.symbols.CloseHandle(handle)
      throw error
    }
    return new WindowsProcessJob(handle)
  }

  static tryCreate(): WindowsProcessJob | undefined {
    return kernel32 ? WindowsProcessJob.create() : undefined
  }

  assign(pid: number): void {
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
    if (!job || !kernel32) return false
    return kernel32.symbols.TerminateJobObject(job, TERMINATED_EXIT_CODE) !== 0
  }

  close(): void {
    const job = this.#handle
    if (!job) return
    this.#handle = null
    kernel32?.symbols.CloseHandle(job)
  }

  #requiredHandle(): Pointer {
    if (!this.#handle) throw new Error("Windows Job Object is already closed")
    return this.#handle
  }
}
