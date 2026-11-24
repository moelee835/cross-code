/** @jsxImportSource @opentui/solid */
import { TextAttributes } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { createSignal, onMount } from "solid-js"
import { DialogProductTour, type TourPeer } from "../../src/component/dialog-product-tour"
import { ConfigProvider } from "../../src/config"
import { Keymap } from "../../src/context/keymap"
import { ThemeProvider } from "../../src/context/theme"
import { DialogProvider, useDialog } from "../../src/ui/dialog"
import { ToastProvider } from "../../src/ui/toast"
import type { TourLanguage } from "../../src/util/product-tour-copy"
import { emptyThemeSource, tmpdir } from "../fixture/fixture"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

test.each([44, 100])("tour works with keyboard input at %i columns", async (width) => {
  const [connected, setConnected] = createSignal(false)
  const [language, setLanguage] = createSignal<TourLanguage>("en")
  const actions: string[] = []
  await using temporary = await tmpdir()
  const app = await renderTour(temporary.path, width, {
    start: 0,
    language,
    setLanguage,
    connected,
    messaging: () => "enabled",
    sessionID: () => undefined,
    loadPeer: async () => {
      throw new Error("The offline tour should not look up peers")
    },
    connect: () => actions.push("connect"),
    insert: () => actions.push("fill"),
    finish: () => actions.push("finish"),
  })

  try {
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("Product tour")
    expect(app.captureCharFrame()).toContain("Connect a model")
    app.mockInput.pressEnter()
    expect(actions).toEqual(["connect"])
    setConnected(true)
    await app.renderOnce()
    app.mockInput.pressEnter()
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("Get your first reply")

    app.mockInput.pressKey("l")
    await app.renderOnce()
    const korean = app.captureCharFrame()
    expect(korean).toContain("제품 투어")
    expect(korean).toContain("첫 응답 받기")
    expect(korean).toContain("이 프로젝트의 주요")

    app.mockInput.pressEnter()
    expect(actions).toEqual(["connect", "fill"])
    app.mockInput.pressArrow("right")
    app.mockInput.pressEnter()
    await app.renderOnce()
    const peerFrame = app.captureCharFrame()
    expect(peerFrame).toContain("다른 세션에 메시지 보내기")
    expect(peerFrame).toContain("먼저 세션을 만드세요")
    expect(
      app
        .captureSpans()
        .lines.flatMap((line) => line.spans)
        .some((span) => span.text.includes("새 세션마다 먼저") && (span.attributes & TextAttributes.BOLD) !== 0),
    ).toBe(true)

    app.mockInput.pressEnter()
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("메시지 흐름 예시")
    expect(app.captureCharFrame()).toContain("B → A  나중에 답변 도착")
    app.mockInput.pressKey("l")
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("Example exchange")
    app.mockInput.pressArrow("left")
    app.mockInput.pressEnter()
    expect(actions).toEqual(["connect", "fill", "finish"])
  } finally {
    app.renderer.destroy()
  }
})

test("the practice action passes only the available peer to the composer", async () => {
  const request = Promise.withResolvers<TourPeer>()
  const loaded: string[] = []
  const inserted: Array<string | undefined> = []
  await using temporary = await tmpdir()
  const app = await renderTour(temporary.path, 80, {
    start: 2,
    language: () => "en",
    setLanguage: () => {},
    connected: () => true,
    messaging: () => "enabled",
    sessionID: () => "ses_sender",
    loadPeer: (sessionID) => {
      loaded.push(sessionID)
      return request.promise
    },
    connect: () => {},
    insert: (peerID) => inserted.push(peerID),
    finish: () => {},
  })

  try {
    await app.renderOnce()
    expect(loaded).toEqual(["ses_sender"])
    request.resolve({ type: "ready", sessionID: "ses_receiver" })
    await request.promise
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("Peer ready")
    expect(app.captureCharFrame()).toContain("Send one prompt in each new session first.")
    expect(inserted).toEqual([])

    app.mockInput.pressArrow("right")
    app.mockInput.pressEnter()
    expect(inserted).toEqual(["ses_receiver"])
  } finally {
    app.renderer.destroy()
  }
})

function renderTour(directory: string, width: number, props: Parameters<typeof DialogProductTour>[0]) {
  return testRender(
    () => (
      <TestTuiContexts directory={directory} paths={{ state: directory }}>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <ThemeProvider mode="dark" source={emptyThemeSource}>
            <Keymap.Provider>
              <ToastProvider>
                <DialogProvider>
                  <ModalTour {...props} />
                </DialogProvider>
              </ToastProvider>
            </Keymap.Provider>
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width, height: 24, kittyKeyboard: true },
  )
}

function ModalTour(props: Parameters<typeof DialogProductTour>[0]) {
  const dialog = useDialog()
  onMount(() => dialog.replace(() => <DialogProductTour {...props} />))
  return null
}
