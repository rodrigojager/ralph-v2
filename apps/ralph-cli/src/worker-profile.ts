import { hashCanonicalValue } from "@ralph-next/prd"

export function workerProfileConfigHash(value: unknown): string {
  return hashCanonicalValue("ralph.worker.profile-config.v1", value)
}
