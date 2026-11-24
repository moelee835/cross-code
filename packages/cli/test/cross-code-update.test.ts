import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { CrossCodeUpdate } from "../src/services/cross-code-update"

const supported =
  (process.platform === "linux" && process.arch === "x64") ||
  (process.platform === "darwin" && process.arch === "arm64")
const archive = `cross-code-${process.platform}-${process.arch}.tar.gz`
const signal = new AbortController().signal
const version = "0.1.1-dev.12"

function release(version: string, options: { draft?: boolean; asset?: string; size?: number } = {}) {
  return {
    tag_name: `cross-code-v${version}`,
    draft: options.draft ?? false,
    assets: [
      { name: options.asset ?? archive, state: "uploaded", size: options.size ?? 128 },
      { name: "SHA256SUMS", state: "uploaded", size: 128 },
    ],
  }
}

test.skipIf(!supported)("selects the newest complete published prerelease by version", async () => {
  const request = async (url: string | URL | Request) => {
    expect(String(url)).toBe("https://api.github.com/repos/moelee835/cross-code/releases?per_page=100")
    return Response.json([
      release("1.0.0", { draft: true }),
      release("0.1.1-dev.9"),
      release("0.1.1-dev.99", { asset: "different-platform.tar.gz" }),
      release(version),
      release("0.1.0-alpha.8"),
    ])
  }
  expect((await CrossCodeUpdate.release(signal, undefined, request)).version).toBe(version)
})

test.skipIf(!supported)("finds a published prerelease through the public feed when the API returns 403", async () => {
  const root = "https://github.com/moelee835/cross-code/releases"
  const request = async (url: string) => {
    if (url === "https://api.github.com/repos/moelee835/cross-code/releases?per_page=100") {
      return Response.json({ message: "API rate limit exceeded" }, { status: 403 })
    }
    if (url === `${root}.atom`) {
      return new Response(
        `<feed xmlns="http://www.w3.org/2005/Atom">
          <entry><link rel="alternate" type="text/html" href="${root}/tag/cross-code-v0.1.1-dev.9"/></entry>
          <entry><link rel="alternate" type="text/html" href="${root}/tag/cross-code-v${version}"/></entry>
          <entry><link rel="alternate" type="text/html" href="${root}/tag/cross-code-v0.1.1-dev.13"/></entry>
        </feed>`,
      )
    }
    if (url === `${root}/download/cross-code-v0.1.1-dev.13/SHA256SUMS`) return new Response(null, { status: 404 })
    expect(url).toBe(`${root}/download/cross-code-v${version}/SHA256SUMS`)
    return new Response(`${"0".repeat(64)}  ${archive}\n`)
  }

  expect((await CrossCodeUpdate.release(signal, undefined, request)).version).toBe(version)
})

test.skipIf(!supported).each([200, 403, 429])(
  "verifies an archive before replacing the executable (API %i)",
  async (apiStatus) => {
    const oldBinary = "#!/bin/sh\nprintf 'cross-code v0.1.0-alpha.8\\n'\n"
    const newBinary = `#!/bin/sh\nprintf 'cross-code v${version}\\n'\n`
    const tar = await new Bun.Archive({ "cross-code": newBinary }).blob()
    const bytes = Bun.gzipSync(await tar.bytes())
    const sha256 = createHash("sha256").update(bytes).digest("hex")
    const request = (checksum: string) => async (url: string | URL | Request) => {
      const address = String(url)
      if (address.startsWith("https://api.github.com/")) {
        expect(address).toBe(`https://api.github.com/repos/moelee835/cross-code/releases/tags/cross-code-v${version}`)
        return Response.json(release(version, { size: bytes.length }), { status: apiStatus })
      }
      const root = `https://github.com/moelee835/cross-code/releases/download/cross-code-v${version}`
      if (address === `${root}/SHA256SUMS`) return new Response(`${checksum}  ${archive}\n`)
      expect(address).toBe(`${root}/${archive}`)
      return new Response(bytes)
    }
    const dir = await mkdtemp(path.join(tmpdir(), "cross-code-update-"))
    try {
      const executable = path.join(dir, "cross-code")
      await writeFile(executable, oldBinary)
      await chmod(executable, 0o755)
      const selected = await CrossCodeUpdate.release(signal, version, request(sha256))

      await expect(CrossCodeUpdate.install(selected, executable, signal, request("0".repeat(64)))).rejects.toThrow(
        "SHA-256",
      )
      expect(await readFile(executable, "utf8")).toBe(oldBinary)
      expect(await readdir(dir)).toEqual(["cross-code"])

      await CrossCodeUpdate.install(selected, executable, signal, request(sha256))
      expect(await CrossCodeUpdate.installedVersion(executable, signal)).toBe(version)
      expect(await readdir(dir)).toEqual(["cross-code"])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  },
)
