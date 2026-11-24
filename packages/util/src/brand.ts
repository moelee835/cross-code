export * as Brand from "./brand.js"

declare const CROSS_CODE_BUILD: boolean | undefined

export const crossCode = typeof CROSS_CODE_BUILD === "boolean" && CROSS_CODE_BUILD
export const name = crossCode ? "Cross Code" : "OpenCode"
export const command = crossCode ? "cross-code" : "opencode"
export const initials = crossCode ? "CC" : "OC"
export const repository = crossCode
  ? "https://github.com/moelee835/cross-code"
  : "https://github.com/anomalyco/opencode"
export const documentation = crossCode ? `${repository}/blob/dev/CROSS-CODE.md` : "https://opencode.ai/docs"
export const website = crossCode ? repository : "https://opencode.ai"
