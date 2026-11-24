import { Brand } from "@opencode/util/brand"

export { command as binaryName, initials as productInitials, name as productName } from "@opencode/util/brand"

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

export const logo = Brand.crossCode ? crossCodeLogo : openCodeLogo
export const logoMark = Brand.crossCode ? ["▄█▀▀▀", "██   ", "▀█▄▄▄"] : go.right.slice(1)
