export type RunOptions = {
  command: string
  args: string[]
  cwd: string
  stdin?: string
  signal?: AbortSignal
  env?: Record<string, string>
  timeoutMs?: number
  maxOutputBytes?: number
  trimOutput?: boolean
}

export type RunCliResult = {
  exitCode: number
  stdout: string
  stderr: string
}

export async function runCli(options: RunOptions): Promise<RunCliResult> {
  const process = Bun.spawn([options.command, ...options.args], {
    cwd: options.cwd,
    env: options.env ?? processEnv(),
    stdin: options.stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
    signal: options.signal,
  })

  const timer = options.timeoutMs === undefined ? undefined : setTimeout(() => process.kill("SIGKILL"), options.timeoutMs)
  async function read(stream: ReadableStream<Uint8Array>): Promise<string> {
    const chunks: Uint8Array[] = []
    let size = 0
    for await (const chunk of stream) {
      size += chunk.length
      if (options.maxOutputBytes !== undefined && size > options.maxOutputBytes) {
        process.kill("SIGKILL")
        throw new Error("Command output exceeded the configured limit")
      }
      chunks.push(chunk)
    }
    return Buffer.concat(chunks).toString("utf8")
  }

  try {
    if (options.stdin !== undefined) {
      process.stdin.write(options.stdin)
      process.stdin.end()
    }

    const [stdout, stderr, exitCode] = await Promise.all([
      read(process.stdout),
      read(process.stderr),
      process.exited,
    ])

    return {
      exitCode,
      stdout: options.trimOutput === false ? stdout : stdout.trim(),
      stderr: options.trimOutput === false ? stderr : stderr.trim(),
    }
  } catch (error) {
    process.kill("SIGKILL")
    await process.exited
    throw error
  } finally {
    clearTimeout(timer)
  }
}

function processEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(Bun.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
}
