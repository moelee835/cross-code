export * as CrossCodeUpdate from "./cross-code-update"

import { createHash } from "node:crypto"
import { createWriteStream } from "node:fs"
import { chmod, mkdtemp, open, rename, rm, stat } from "node:fs/promises"
import path from "node:path"
import { pipeline } from "node:stream/promises"
import { Schema } from "effect"
import { parseReleaseVersion } from "./updater-action"

const repository = "moelee835/cross-code"
const tagPrefix = "cross-code-v"
const checksumFile = "SHA256SUMS"
const api = `https://api.github.com/repos/${repository}/releases`
const releases = `https://github.com/${repository}/releases`
const download = `${releases}/download`
const maxArchiveSize = 512 * 1024 * 1024

const ReleaseInfo = Schema.Struct({
  tag_name: Schema.String,
  draft: Schema.Boolean,
  assets: Schema.Array(Schema.Struct({ name: Schema.String, state: Schema.String, size: Schema.Int })),
})
const decodeRelease = Schema.decodeUnknownSync(ReleaseInfo)
const decodeReleases = Schema.decodeUnknownSync(Schema.Array(ReleaseInfo))
type Fetch = (url: string, init?: RequestInit) => Promise<Response>

interface Release {
  readonly version: string
  readonly tag: string
  readonly archive: string
  readonly size?: number
}

function archiveName() {
  if (process.platform === "darwin" && process.arch === "arm64") return "cross-code-darwin-arm64.tar.gz"
  if (process.platform === "linux" && process.arch === "x64") return "cross-code-linux-x64.tar.gz"
  throw new Error("Cross Code updates are available for Linux x64 and macOS arm64.")
}

async function get(request: Fetch, url: string, signal: AbortSignal, accept: string, ...allowedStatuses: number[]) {
  const response = await request(url, { headers: { accept, "User-Agent": "Cross-Code" }, signal })
  if (!response.ok && !allowedStatuses.includes(response.status))
    throw new Error(`GitHub returned HTTP ${response.status} for ${url}`)
  return response
}

export async function release(signal: AbortSignal, target?: string, request: Fetch = fetch): Promise<Release> {
  const archive = archiveName()
  const version = target?.trim().replace(/^v/, "")
  if (version !== undefined && !parseReleaseVersion(version)) throw new Error(`Invalid Cross Code version: ${target}`)
  const url = version === undefined ? `${api}?per_page=100` : `${api}/tags/${encodeURIComponent(tagPrefix + version)}`
  const timeout = AbortSignal.any([signal, AbortSignal.timeout(10_000)])
  const response = await get(request, url, timeout, "application/vnd.github+json", 403, 429)
  if (!response.ok) {
    await response.body?.cancel()
    return publicRelease(request, timeout, archive, version)
  }
  const data: unknown = await response.json()
  const candidates = version === undefined ? decodeReleases(data) : [decodeRelease(data)]
  const eligible = candidates.flatMap((candidate) => {
    if (candidate.draft || !candidate.tag_name.startsWith(tagPrefix)) return []
    const candidateVersion = candidate.tag_name.slice(tagPrefix.length)
    if (!parseReleaseVersion(candidateVersion) || (version !== undefined && candidateVersion !== version)) return []
    const asset = candidate.assets.find((item) => item.name === archive && item.state === "uploaded")
    if (!asset || asset.size <= 0 || asset.size > maxArchiveSize) return []
    if (!candidate.assets.some((item) => item.name === checksumFile && item.state === "uploaded")) return []
    return [{ version: candidateVersion, tag: candidate.tag_name, archive, size: asset.size }]
  })
  const selected = eligible.sort((left, right) => Bun.semver.order(right.version, left.version))[0]
  if (!selected) throw new Error(`No complete Cross Code release was found for ${archive}.`)
  return selected
}

async function publicRelease(request: Fetch, signal: AbortSignal, archive: string, version?: string): Promise<Release> {
  const versions = version === undefined ? await feedVersions(request, signal) : [version]
  for (const candidate of versions) {
    const tag = tagPrefix + candidate
    const url = `${download}/${encodeURIComponent(tag)}/${checksumFile}`
    const checksums = await get(request, url, signal, "text/plain", 404)
    if (checksums.ok && findChecksum(await checksums.text(), archive)) return { version: candidate, tag, archive }
  }
  throw new Error(`No complete Cross Code release was found for ${archive} using public release downloads.`)
}

async function feedVersions(request: Fetch, signal: AbortSignal) {
  const feed = await get(request, `${releases}.atom`, signal, "application/atom+xml")
  const prefix = `${releases}/tag/${tagPrefix}`
  const links = (await feed.text()).matchAll(/<link\b[^>]*\bhref="([^"]+)"/g)
  const versions = new Set<string>()
  for (const [, href] of links) {
    if (!href.startsWith(prefix)) continue
    const version = href.slice(prefix.length).replace(/%2b/gi, "+")
    if (parseReleaseVersion(version)) versions.add(version)
  }
  return [...versions].sort((left, right) => Bun.semver.order(right, left))
}

function findChecksum(checksums: string, archive: string) {
  return checksums
    .split(/\r?\n/)
    .map((line) => line.match(/^([a-f0-9]{64}) [ *](\S+)$/i))
    .find((entry) => entry?.[2] === archive)?.[1]
}

export async function installedVersion(executable: string, signal: AbortSignal) {
  const process = Bun.spawn([executable, "--version"], {
    stdout: "pipe",
    stderr: "ignore",
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
  })
  const [stdout, exit] = await Promise.all([new Response(process.stdout).text(), process.exited])
  const version = stdout.trim().match(/^cross-code v([^\s]+)$/)?.[1]
  if (exit !== 0 || !version || !parseReleaseVersion(version))
    throw new Error("Could not verify the Cross Code executable.")
  return version
}

export async function install(release: Release, executable: string, signal: AbortSignal, request: Fetch = fetch) {
  const timeout = AbortSignal.any([signal, AbortSignal.timeout(180_000)])
  const directory = await mkdtemp(path.join(path.dirname(executable), ".cross-code-update-"))
  try {
    const source = `${download}/${encodeURIComponent(release.tag)}`
    const checksums = await get(request, `${source}/${checksumFile}`, timeout, "text/plain")
    const expected = findChecksum(await checksums.text(), release.archive)
    if (!expected) throw new Error(`Missing SHA-256 checksum for ${release.archive}.`)

    const archive = path.join(directory, release.archive)
    const response = await get(request, `${source}/${release.archive}`, timeout, "application/octet-stream")
    if (!response.body) throw new Error("The Cross Code archive download had no content.")
    const reader = response.body.getReader()
    const hash = createHash("sha256")
    const limit = release.size ?? maxArchiveSize
    let size = 0
    await pipeline(
      async function* () {
        try {
          for (;;) {
            const chunk = await reader.read()
            if (chunk.done) break
            size += chunk.value.length
            if (size > limit) throw new Error("The Cross Code archive exceeds its allowed size.")
            hash.update(chunk.value)
            yield chunk.value
          }
        } finally {
          await reader.cancel().catch(() => {})
        }
      },
      createWriteStream(archive, { flags: "wx", mode: 0o600 }),
      { signal: timeout },
    )
    if ((release.size !== undefined && size !== release.size) || hash.digest("hex") !== expected.toLowerCase())
      throw new Error("The downloaded Cross Code archive failed SHA-256 verification.")

    // Extract only the executable bytes to a staging file in the destination filesystem.
    const staged = path.join(directory, "cross-code")
    const file = await open(staged, "wx", 0o700)
    try {
      const tar = Bun.spawn(["tar", "-xOzf", archive, "--", "cross-code"], {
        stdout: file.fd,
        stderr: "pipe",
        signal: timeout,
      })
      const [stderr, exit] = await Promise.all([new Response(tar.stderr).text(), tar.exited])
      if (exit !== 0) throw new Error(`Could not unpack Cross Code: ${stderr.trim()}`)
    } finally {
      await file.close()
    }
    if ((await installedVersion(staged, timeout)) !== release.version)
      throw new Error("The downloaded executable version differs from its release tag.")
    await chmod(staged, (await stat(executable)).mode & 0o777)
    timeout.throwIfAborted()
    await rename(staged, executable)
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {})
  }
}
