<p align="center">
  <a href="https://github.com/moelee835/cross-code">
    <picture>
      <source srcset=".github/assets/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset=".github/assets/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src=".github/assets/logo-ornate-light.svg" alt="OpenCode, the upstream project">
    </picture>
  </a>
</p>
<p align="center"><strong>Cross Code</strong> adds asynchronous messaging between OpenCode coding sessions.</p>
<p align="center">
  <a href="https://github.com/moelee835/cross-code/issues"><img alt="Issues" src="https://img.shields.io/github/issues/moelee835/cross-code?style=flat-square" /></a>
  <a href="https://github.com/moelee835/cross-code/releases"><img alt="Cross Code release" src="https://img.shields.io/github/v/release/moelee835/cross-code?include_prereleases&style=flat-square" /></a>
  <a href="https://github.com/moelee835/cross-code/actions/workflows/cross-code-release.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/moelee835/cross-code/cross-code-release.yml?style=flat-square" /></a>
</p>

<p align="center">
  <a href="#installation">Installation</a> |
  <a href="#peer-messaging">Peer messaging</a> |
  <a href="#agents">Agents</a> |
  <a href="#documentation">Documentation</a>
</p>

[![Upstream OpenCode terminal interface](services/site/public/v1/docs/assets/lander/screenshot.png)](https://github.com/anomalyco/opencode)

---

### Installation

Install Cross Code from the release archive for your platform. The following example uses Linux x86_64, including WSL on x86_64. [Cross Code releases](https://github.com/moelee835/cross-code/releases)

```bash
(
  set -e
  temp_dir=$(mktemp -d)
  trap 'rm -rf -- "$temp_dir"' EXIT
  cd "$temp_dir"

  release="https://github.com/moelee835/cross-code/releases/download/cross-code-v0.1.0-alpha.6"
  archive="cross-code-linux-x64.tar.gz"
  curl -fsSLO "$release/$archive"
  curl -fsSLO "$release/SHA256SUMS"
  sha256sum --ignore-missing -c SHA256SUMS
  tar -xzf "$archive" cross-code
  mkdir -p "$HOME/.local/bin"
  install -m 755 cross-code "$HOME/.local/bin/cross-code"
)

export PATH="$HOME/.local/bin:$PATH"
cross-code --version
```

> [!TIP]
> Add the `export PATH` line to `~/.bashrc` or `~/.zshrc` to keep `cross-code` available in new terminals.

### Downloads

The current prerelease packages the Cross Code CLI and terminal UI for these platforms.

| Platform | Download |
| -------- | -------- |
| Linux and WSL (x86_64) | [cross-code-linux-x64.tar.gz](https://github.com/moelee835/cross-code/releases/download/cross-code-v0.1.0-alpha.6/cross-code-linux-x64.tar.gz) |
| macOS (Apple Silicon) | [cross-code-darwin-arm64.tar.gz](https://github.com/moelee835/cross-code/releases/download/cross-code-v0.1.0-alpha.6/cross-code-darwin-arm64.tar.gz) |

On macOS, use the same installation commands with `archive="cross-code-darwin-arm64.tar.gz"` and replace the `sha256sum` line with `grep -F "  $archive" SHA256SUMS | shasum -a 256 -c`. [SHA256SUMS](https://github.com/moelee835/cross-code/releases/download/cross-code-v0.1.0-alpha.6/SHA256SUMS)

#### Installation Directory

The commands above install the executable in `$HOME/.local/bin`. To upgrade, replace that executable and run `cross-code service restart` before reopening your sessions.

### Peer Messaging

Sessions on the same local managed server can discover each other after opting in. Sending a message returns a request ID immediately and queues a model turn in the receiving session. The sender can keep working or accept another prompt. When the receiving turn finishes, its response is delivered to the sender's session.

```bash
cross-code service set env OPENCODE_FLAGS session_messaging
cross-code service restart
```

1. Run `cross-code` in two terminals in the same Git repository. Its root and subdirectories work together as soon as you run `git init`. A separately initialized nested repository has its own peers.
2. Connect a model with `/connect` if needed. For Gemini with a personal Google account, choose **Google** and use a Gemini API key. [Gemini setup](./CROSS-CODE.md#connect-a-gemini-model)
3. Run `/peer-messaging` in both sessions. Ask one agent to list its peers, then ask it to send a task to the other session.

To discover or message peers from a script, use the session commands. [Peer messaging CLI](./CROSS-CODE.md#send-messages-from-the-cli)

### Agents

Cross Code includes OpenCode's built-in agents. Switch between `build` and `plan` with the `Tab` key.

- **build** - Default, full-access agent for development work
- **plan** - Read-only agent for analysis and code exploration
  - Denies file edits by default
  - Asks permission before running bash commands
  - Ideal for exploring unfamiliar codebases or planning changes

Also included is a **general** subagent for complex searches and multistep tasks.
This is used internally and can be invoked using `@general` in messages.

Learn more about [agents](https://opencode.ai/docs/agents).

### Documentation

Read the Cross Code guide for installation, Gemini configuration, and peer messaging CLI commands. OpenCode's documentation covers the underlying configuration and agent behavior. [Cross Code guide](./CROSS-CODE.md) · [OpenCode documentation](https://opencode.ai/docs)

### Contributing

Report Cross Code issues in this repository and target the `dev` branch for pull requests. See the repository guide for development conventions. [Issues](https://github.com/moelee835/cross-code/issues) · [Repository guide](./AGENTS.md)

### About Cross Code

Cross Code builds on OpenCode. The logo and preview above come from the upstream project. [OpenCode source](https://github.com/anomalyco/opencode) · [License](./LICENSE)

---

**Project links** [Releases](https://github.com/moelee835/cross-code/releases) | [Issues](https://github.com/moelee835/cross-code/issues)
