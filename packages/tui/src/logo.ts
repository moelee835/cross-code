declare const CROSS_CODE_BUILD: boolean | undefined

const crossCode = typeof CROSS_CODE_BUILD === "boolean" && CROSS_CODE_BUILD

const openCodeLogo = {
  left: ["                   ", "█▀▀█ █▀▀█ █▀▀█ █▀▀▄", "█__█ █__█ █^^^ █__█", "▀▀▀▀ █▀▀▀ ▀▀▀▀ ▀~~▀"],
  right: ["             ▄     ", "█▀▀▀ █▀▀█ █▀▀█ █▀▀█", "█___ █__█ █__█ █^^^", "▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀"],
}

const crossCodeLogo = {
  left: [
    "                             ",
    "▄█▀▀▀ ██▀█▄ ▄█▀█▄ ▄█▀▀▀ ▄█▀▀▀",
    "██    ██▄█▀ ██ ██  ▀▀█▄  ▀▀█▄",
    "▀█▄▄▄ ██ ██ ▀█▄█▀ ▄▄▄█▀ ▄▄▄█▀",
  ],
  right: ["                       ", "▄█▀▀▀ ▄█▀█▄ ██▀█▄ ██▀▀▀", "██    ██ ██ ██ ██ ██▀▀ ", "▀█▄▄▄ ▀█▄█▀ ██▄█▀ ██▄▄▄"],
}

export const go = {
  left: ["    ", "█▀▀▀", "█_^█", "▀▀▀▀"],
  right: ["    ", "█▀▀█", "█__█", "▀▀▀▀"],
}

export const logo = crossCode ? crossCodeLogo : openCodeLogo
export const logoMark = crossCode ? ["▄█▀▀▀", "██   ", "▀█▄▄▄"] : go.right.slice(1)
export const productName = crossCode ? "Cross Code" : "OpenCode"
export const productInitials = crossCode ? "CC" : "OC"
export const binaryName = crossCode ? "cross-code" : "opencode"
