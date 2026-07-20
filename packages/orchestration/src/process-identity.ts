import { hostname as localHostname } from "node:os"
import { type DurableLeaseRecord, EXIT_CODES, RalphError } from "@ralph-next/domain"
import type { LeaseOwnerProbeResult } from "@ralph-next/persistence"
import {
  captureProcessIdentity,
  type PidLiveness,
  type ProcessIdentity,
  probePidLiveness,
  processStartToken,
} from "@ralph-next/supervisor/process-identity"

export { type PidLiveness, type ProcessIdentity, probePidLiveness, processStartToken }

export async function captureCurrentProcessIdentity(): Promise<ProcessIdentity> {
  try {
    return {
      ...(await captureProcessIdentity()),
    }
  } catch (error) {
    throw new RalphError(
      "RALPH_PROCESS_IDENTITY_UNAVAILABLE",
      "Could not establish a stable process-start identity for the supervisor",
      {
        exitCode: EXIT_CODES.operationalError,
        hint: "Restore access to the local process table; Ralph will not acquire a writer lease using PID alone.",
        cause: error,
      },
    )
  }
}

export async function probeProcessIdentity(
  owner: Pick<DurableLeaseRecord, "pid" | "processStartToken" | "hostname">,
): Promise<LeaseOwnerProbeResult> {
  const hostname = localHostname()
  if (owner.hostname.toLocaleLowerCase("und") !== hostname.toLocaleLowerCase("und")) {
    return {
      status: "unreachable",
      reason: `owner host ${owner.hostname} cannot be probed from ${hostname}`,
    }
  }

  const liveness = probePidLiveness(owner.pid)
  if (!liveness.alive && !liveness.inaccessible) {
    return { status: "dead", reason: `PID ${owner.pid} is not present on ${hostname}` }
  }
  if (liveness.inaccessible) {
    return {
      status: "alive",
      reason: `PID ${owner.pid} exists but its identity is inaccessible; takeover is denied conservatively`,
    }
  }

  try {
    const observedProcessStartToken = await processStartToken(owner.pid)
    if (observedProcessStartToken === owner.processStartToken) {
      return {
        status: "alive",
        observedProcessStartToken,
        reason: `PID ${owner.pid} and its process-start token still match`,
      }
    }
    return {
      status: "identity-mismatch",
      observedProcessStartToken,
      reason: `PID ${owner.pid} was reused by a different process start identity`,
    }
  } catch (error) {
    const after = probePidLiveness(owner.pid)
    if (!after.alive && !after.inaccessible) {
      return {
        status: "dead",
        reason: `PID ${owner.pid} exited while its start identity was being probed`,
      }
    }
    return {
      status: "alive",
      reason: `PID ${owner.pid} remains present but its start identity could not be read: ${
        error instanceof Error ? error.message : String(error)
      }`,
    }
  }
}
