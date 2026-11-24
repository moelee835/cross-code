import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createResource, createSignal, For, Match, Show, Switch } from "solid-js"
import { Keymap } from "../context/keymap"
import { useTheme } from "../context/theme"
import { DialogButtons, DialogHeader, DialogLayout, useDialog, type DialogButton } from "../ui/dialog"
import { tourCopy, type TourLanguage } from "../util/product-tour-copy"

const languages = [
  { id: "ko", label: "한국어" },
  { id: "en", label: "English" },
] as const

export type TourPeer = { type: "inactive" | "missing" | "unavailable" } | { type: "ready"; sessionID: string }

export function DialogProductTour(props: {
  start: 0 | 1 | 2
  language: () => TourLanguage
  setLanguage: (language: TourLanguage) => void
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
  const dimensions = useTerminalDimensions()
  const cardPadding = () => (dimensions().height < 26 ? 0 : 1)
  const copy = () => tourCopy[props.language()]
  const [step, setStep] = createSignal<number>(props.start)
  const [active, setActive] = createSignal(0)
  const [example, setExample] = createSignal(false)
  let scroll: ScrollBoxRenderable | undefined
  dialog.setCentered(true)

  const [peer, { refetch }] = createResource(
    () => (step() === 2 && props.messaging() === "enabled" ? props.sessionID() : undefined),
    props.loadPeer,
  )
  const peerStatus = () => {
    const service = props.messaging()
    if (service !== "enabled") return service
    if (!props.sessionID()) return "empty"
    if (peer.loading) return "loading"
    return peer()?.type ?? "unavailable"
  }
  const readyPeer = () => {
    if (peerStatus() !== "ready") return
    const value = peer()
    return value?.type === "ready" ? value.sessionID : undefined
  }
  const go = (next: number) => {
    setStep(next)
    setActive(0)
    setExample(false)
    scroll?.scrollTo(0)
  }
  const finish = () => {
    props.finish()
    dialog.clear()
  }
  const buttons = (): DialogButton[] => {
    const labels = copy()
    if (step() === 0)
      return [
        ...(props.connected() ? [] : [{ label: labels.connect, run: props.connect }]),
        { label: labels.next, run: () => go(1) },
        { label: labels.skip, run: finish },
      ]
    if (step() === 1)
      return [
        { label: labels.fill, run: () => props.insert() },
        { label: labels.next, run: () => go(2) },
        { label: labels.back, run: () => go(0) },
      ]
    const target = readyPeer()
    const check = props.messaging() === "enabled" && props.sessionID() && !peer.loading
    return [
      {
        label: example() ? labels.hideExample : labels.showExample,
        run: () => {
          setExample((value) => !value)
          scroll?.scrollTo(0)
        },
      },
      ...(target
        ? [{ label: labels.tryPeer, run: () => props.insert(target) }]
        : check
          ? [{ label: labels.check, run: () => void refetch() }]
          : []),
      { label: labels.back, run: () => go(1) },
      { label: labels.done, run: finish },
    ]
  }
  const selected = () => Math.min(active(), buttons().length - 1)
  const move = (offset: number) => setActive((selected() + offset + buttons().length) % buttons().length)
  const page = (direction: number) => {
    if (scroll) scroll.scrollBy(direction * Math.max(1, scroll.viewport.height - 1))
  }
  Keymap.createLayer(() => ({
    mode: "modal",
    commands: [
      { bind: "return", title: "Choose tour action", group: "Dialog", run: () => buttons()[selected()]?.run() },
      { bind: "left", title: "Previous tour action", group: "Dialog", run: () => move(-1) },
      { bind: "shift+tab", title: "Previous tour action", group: "Dialog", run: () => move(-1) },
      { bind: "right", title: "Next tour action", group: "Dialog", run: () => move(1) },
      { bind: "tab", title: "Next tour action", group: "Dialog", run: () => move(1) },
      { bind: "up", title: "Scroll tour up", group: "Dialog", run: () => scroll?.scrollBy(-1) },
      { bind: "down", title: "Scroll tour down", group: "Dialog", run: () => scroll?.scrollBy(1) },
      { bind: "pageup", title: "Scroll tour up", group: "Dialog", run: () => page(-1) },
      { bind: "pagedown", title: "Scroll tour down", group: "Dialog", run: () => page(1) },
      {
        bind: "l",
        title: "Change tour language",
        group: "Dialog",
        run: () => props.setLanguage(props.language() === "en" ? "ko" : "en"),
      },
    ],
  }))

  return (
    <DialogLayout
      inset={dimensions().width <= 44 ? 1 : undefined}
      header={
        <box gap={1}>
          <DialogHeader title={copy().title} />
          <box flexDirection="row" alignItems="center" gap={1}>
            <text fg={theme.text.muted}>{copy().language} · L</text>
            <For each={languages}>
              {(language) => (
                <box
                  paddingLeft={1}
                  paddingRight={1}
                  backgroundColor={props.language() === language.id ? theme.background.raised.high : undefined}
                  onMouseUp={() => props.setLanguage(language.id)}
                >
                  <text
                    fg={props.language() === language.id ? theme.text.base : theme.text.action.primary.selected}
                    attributes={props.language() === language.id ? TextAttributes.BOLD : undefined}
                  >
                    {language.label}
                  </text>
                </box>
              )}
            </For>
          </box>
        </box>
      }
      buttons={<DialogButtons buttons={buttons()} active={selected()} onActive={setActive} />}
    >
      <box gap={1}>
        <box flexDirection="row" gap={1}>
          <For each={copy().steps}>
            {(label, index) => (
              <box
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={step() === index() ? theme.background.raised.high : undefined}
              >
                <text
                  fg={step() === index() ? theme.text.base : theme.text.muted}
                  attributes={step() === index() ? TextAttributes.BOLD : undefined}
                >
                  {index() + 1} {label}
                </text>
              </box>
            )}
          </For>
        </box>
        <scrollbox
          ref={(element: ScrollBoxRenderable) => (scroll = element)}
          maxHeight={Math.max(2, dimensions().height - 10)}
          contentOptions={{ minHeight: 0 }}
        >
          <box gap={1}>
            <Switch>
              <Match when={step() === 0}>
                <box
                  backgroundColor={theme.background.raised.high}
                  paddingLeft={1}
                  paddingRight={1}
                  paddingY={cardPadding()}
                >
                  <text attributes={TextAttributes.BOLD} fg={theme.text.base}>
                    {copy().modelTitle}
                  </text>
                  <text fg={theme.text.muted} wrapMode="word">
                    <span style={{ fg: theme.text.action.primary.selected }}>/connect</span> · {copy().modelAction}
                  </text>
                </box>
                <Show when={props.connected()}>
                  <text fg={theme.text.feedback.success.base} attributes={TextAttributes.BOLD}>
                    {copy().modelReady}
                  </text>
                  <text fg={theme.text.muted} wrapMode="word">
                    {copy().modelNext}
                  </text>
                </Show>
              </Match>
              <Match when={step() === 1}>
                <box
                  backgroundColor={theme.background.raised.high}
                  paddingLeft={1}
                  paddingRight={1}
                  paddingY={cardPadding()}
                >
                  <text attributes={TextAttributes.BOLD} fg={theme.text.base}>
                    {copy().promptTitle}
                  </text>
                  <text fg={theme.text.base} wrapMode="word">
                    {copy().sample}
                  </text>
                </box>
                <text fg={theme.text.muted} wrapMode="word">
                  {copy().promptAction}
                </text>
                <text fg={theme.text.muted} wrapMode="word">
                  {copy().promptReturn}
                </text>
              </Match>
              <Match when={step() === 2}>
                <box
                  backgroundColor={theme.background.raised.high}
                  paddingLeft={1}
                  paddingRight={1}
                  paddingY={cardPadding()}
                >
                  <text attributes={TextAttributes.BOLD} fg={theme.text.base}>
                    {copy().peerTitle}
                  </text>
                  <text attributes={TextAttributes.BOLD} fg={theme.text.base} wrapMode="word">
                    {copy().peerFirstPrompt}
                  </text>
                  <text fg={theme.text.muted} wrapMode="word">
                    <span style={{ fg: theme.text.action.primary.selected }}>/peer-messaging</span> ·{" "}
                    {copy().peerAction}
                  </text>
                </box>
                <text attributes={TextAttributes.BOLD} fg={theme.text.base} wrapMode="word">
                  {copy().peerBenefit}
                </text>
                <Show
                  when={example()}
                  fallback={
                    <box>
                      <text
                        attributes={TextAttributes.BOLD}
                        fg={peerStatus() === "ready" ? theme.text.feedback.success.base : theme.text.base}
                        wrapMode="word"
                      >
                        {copy().peer[peerStatus()].title}
                      </text>
                      <Show when={copy().peer[peerStatus()].hint}>
                        {(hint) => (
                          <text fg={theme.text.muted} wrapMode="word">
                            {hint()}
                          </text>
                        )}
                      </Show>
                    </box>
                  }
                >
                  <box backgroundColor={theme.background.raised.high} paddingLeft={1} paddingRight={1}>
                    <text attributes={TextAttributes.BOLD} fg={theme.text.base}>
                      {copy().exampleTitle}
                    </text>
                    <For each={copy().example}>
                      {(line) => (
                        <text fg={theme.text.base} wrapMode="word">
                          {line}
                        </text>
                      )}
                    </For>
                  </box>
                </Show>
              </Match>
            </Switch>
          </box>
        </scrollbox>
      </box>
    </DialogLayout>
  )
}
