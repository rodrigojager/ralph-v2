export type SecretProcessRequest = {
  executable: string
  args: readonly string[]
  stdin?: string
  timeoutMs: number
}

export type SecretProcessResult = {
  exitCode: number
  stdout: string
  stderr: string
  timedOut: boolean
}

export interface SecretProcessRunner {
  run(request: SecretProcessRequest): Promise<SecretProcessResult>
}

export class BunSecretProcessRunner implements SecretProcessRunner {
  async run(request: SecretProcessRequest): Promise<SecretProcessResult> {
    const child = Bun.spawn([request.executable, ...request.args], {
      stdin: request.stdin === undefined ? "ignore" : "pipe",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    })
    if (request.stdin !== undefined) {
      const stdin = child.stdin
      if (!stdin) throw new Error("Secret process stdin pipe was not created")
      stdin.write(request.stdin)
      stdin.end()
    }

    let timedOut = false
    let forceKill: ReturnType<typeof setTimeout> | undefined
    const timeout = setTimeout(() => {
      timedOut = true
      child.kill()
      forceKill = setTimeout(() => child.kill(9), 500)
    }, request.timeoutMs)
    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      return { exitCode, stdout, stderr, timedOut }
    } finally {
      clearTimeout(timeout)
      if (forceKill) clearTimeout(forceKill)
    }
  }
}
