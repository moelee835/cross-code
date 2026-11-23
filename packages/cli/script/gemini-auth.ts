import type { BunPlugin } from "bun"
import { createHash } from "node:crypto"

const version = "2.0.1"
const integrity = "txV23q60qvdFLa6SEH4jzqUt7NvsjzhP5SIGwut44dUkGKrt13IFtcn60037pUcvyEdHvFRvf11pUzBy2gifFQ=="
const entryPoint = "package/dist/server.js"
const licensePath = "package/LICENSE"

export async function loadGeminiAuth() {
  const file = process.env.CROSS_CODE_GEMINI_AUTH_ARCHIVE
  const bytes = file ? await Bun.file(file).bytes() : await download()
  if (createHash("sha512").update(bytes).digest("base64") !== integrity)
    throw new Error(`Integrity mismatch for opencode-gemini-auth@${version}`)
  const archive = new Bun.Archive(Bun.gunzipSync(bytes))
  const files = await archive.files([entryPoint, licensePath])
  const server = files.get(entryPoint)
  const license = files.get(licensePath)
  if (!server || !license) throw new Error(`Missing server bundle or license in opencode-gemini-auth@${version}`)
  return { server: await server.text(), license }
}

async function download() {
  const response = await fetch(
    `https://registry.npmjs.org/opencode-gemini-auth/-/opencode-gemini-auth-${version}.tgz`,
    { signal: AbortSignal.timeout(60_000) },
  )
  if (!response.ok) throw new Error(`Unable to download opencode-gemini-auth@${version}: HTTP ${response.status}`)
  return new Uint8Array(await response.arrayBuffer())
}

export function geminiAuthPlugin(server: string | undefined): BunPlugin {
  return {
    name: "cross-code-gemini-auth",
    setup(build) {
      build.onResolve({ filter: /^#cross-code-gemini-auth$/ }, () => ({
        path: "gemini-auth",
        namespace: "cross-code",
      }))
      // Resolve the upstream bundle's @opencode/plugin import from the CLI workspace.
      build.onLoad({ filter: /^gemini-auth$/, namespace: "cross-code" }, () => ({
        contents: server ?? "export default undefined",
        loader: "js",
        resolveDir: import.meta.dirname,
      }))
    },
  }
}
