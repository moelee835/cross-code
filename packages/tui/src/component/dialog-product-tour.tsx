import { createResource, createSignal, Match, Show, Switch } from "solid-js"
import { Keymap } from "../context/keymap"
import { useTheme } from "../context/theme"
import { DialogButtons, DialogHeader, DialogLayout, useDialog, type DialogButton } from "../ui/dialog"

const steps = ["Connect a model", "Try a prompt", "Send a peer message"] as const

export type TourPeer = { type: "inactive" | "missing" | "unavailable" } | { type: "ready"; sessionID: string }

export function DialogProductTour(props: {
  start: 0 | 1 | 2
  connected: () => boolean
  messaging: () => "unmanaged" | "disabled" | "enabled"
  sessionID: () => string | undefined
  loadPeer: (sessionID: string) => Promise<TourPeer>
  connect: () => void
  insert: (peerID?: string) => void
  finish: () => void
}) {
  const dialog = useDialog()
  const theme = useTheme().surface("dialog")
  const [step, setStep] = createSignal<number>(props.start)
  const [active, setActive] = createSignal(0)
  const [example, setExample] = createSignal(false)
  const [peer, { refetch }] = createResource(
    () => (step() === 2 && props.messaging() === "enabled" ? props.sessionID() : undefined),
    props.loadPeer,
  )
  const readyPeer = () => {
    if (!props.sessionID() || props.messaging() !== "enabled" || peer.loading) return
    const value = peer()
    return value?.type === "ready" ? value.sessionID : undefined
  }
  const go = (next: number) => {
    setStep(next)
    setActive(0)
    setExample(false)
  }
  const finish = () => {
    props.finish()
    dialog.clear()
  }
  const buttons = (): DialogButton[] => {
    if (step() === 0)
      return [
        ...(props.connected() ? [] : [{ label: "Connect", run: props.connect }]),
        { label: "Next", run: () => go(1) },
        { label: "Skip tour", run: finish },
      ]
    if (step() === 1)
      return [
        { label: "Fill input", run: () => props.insert() },
        { label: "Next", run: () => go(2) },
        { label: "Back", run: () => go(0) },
      ]
    const target = readyPeer()
    const check = props.messaging() === "enabled" && props.sessionID() && !peer.loading
    return [
      { label: "Example", run: () => setExample((value) => !value) },
      ...(target
        ? [{ label: "Try", run: () => props.insert(target) }]
        : check
          ? [{ label: "Check", run: () => void refetch() }]
          : []),
      { label: "Back", run: () => go(1) },
      { label: "Done", run: finish },
    ]
  }
  const selected = () => Math.min(active(), buttons().length - 1)
  const move = (offset: number) => setActive((selected() + offset + buttons().length) % buttons().length)
  Keymap.createLayer(() => ({
    mode: "modal",
    commands: [
      { bind: "return", title: "Choose tour action", group: "Dialog", run: () => buttons()[selected()]?.run() },
      { bind: "left", title: "Previous tour action", group: "Dialog", run: () => move(-1) },
      { bind: "shift+tab", title: "Previous tour action", group: "Dialog", run: () => move(-1) },
      { bind: "right", title: "Next tour action", group: "Dialog", run: () => move(1) },
      { bind: "tab", title: "Next tour action", group: "Dialog", run: () => move(1) },
    ],
  }))

  return (
    <DialogLayout
      header={<DialogHeader title={`${step() + 1}/3  ${steps[step()]}`} />}
      buttons={<DialogButtons buttons={buttons()} active={selected()} onActive={setActive} />}
    >
      <box gap={1}>
        <Switch>
          <Match when={step() === 0}>
            <text fg={theme.text.muted} wrapMode="word">
              {props.connected()
                ? "A provider is connected. Continue to try a prompt."
                : "Open /connect and choose a provider, then select a model. Run /tour to continue."}
            </text>
          </Match>
          <Match when={step() === 1}>
            <text fg={theme.text.muted} wrapMode="word">
              Fill the composer with a sample question about this project. Press Enter in the composer when you're ready
              to send it. After the reply, reopen /tour to continue.
            </text>
          </Match>
          <Match when={step() === 2}>
            <text fg={theme.text.muted} wrapMode="word">
              Open two sessions in the same Git project. Run /peer-messaging in each. A send returns a request ID so you
              can keep working while the reply arrives.
            </text>
            <text fg={theme.text.muted} wrapMode="word">
              <Switch>
                <Match when={props.messaging() === "unmanaged"}>
                  Peer messaging needs the local Cross Code background service.
                </Match>
                <Match when={props.messaging() === "disabled"}>
                  Add session_messaging to the service's OPENCODE_FLAGS and restart the local service with remote access
                  disabled.
                </Match>
                <Match when={!props.sessionID()}>Open a session and run /tour there to check for peers.</Match>
                <Match when={peer.loading}>Checking participation and peers…</Match>
                <Match when={peer()?.type === "inactive"}>
                  Run /peer-messaging in this session, then reopen /tour.
                </Match>
                <Match when={peer()?.type === "missing"}>
                  No peers yet. Open a second session and enable it there.
                </Match>
                <Match when={readyPeer()}>A peer is ready. Try fills your prompt with a test message.</Match>
                <Match when={true}>Couldn't check peers. Open Example to see how it works.</Match>
              </Switch>
            </text>
            <Show when={example()}>
              <text fg={theme.text.base} wrapMode="word">
                Example · Session A sends “Reply with received” to B and gets a request ID. A can submit another prompt
                while B works. B's response later appears in A.
              </text>
            </Show>
          </Match>
        </Switch>
      </box>
    </DialogLayout>
  )
}
