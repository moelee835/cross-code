/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { createSignal, onCleanup } from "solid-js"
import { DialogProductTour, type TourPeer } from "../../src/component/dialog-product-tour"
import { ConfigProvider } from "../../src/config"
import { Keymap } from "../../src/context/keymap"
import { ThemeProvider } from "../../src/context/theme"
import { DialogProvider } from "../../src/ui/dialog"
import { ToastProvider } from "../../src/ui/toast"
import { emptyThemeSource, tmpdir } from "../fixture/fixture"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

test.each([44, 100])("tour works with keyboard input at %i columns", async (width) => {
  const [connected, setConnected] = createSignal(false)
  const actions: string[] = []
  await using temporary = await tmpdir()
  const app = await renderTour(temporary.path, width, {
    start: 0,
    connected,
    messaging: () => "unmanaged",
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
    expect(app.captureCharFrame()).toContain("1/3  Connect a model")
    app.mockInput.pressEnter()
    expect(actions).toEqual(["connect"])
    setConnected(true)
    await app.renderOnce()
    app.mockInput.pressEnter()
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("2/3  Try a prompt")

    app.mockInput.pressEnter()
    expect(actions).toEqual(["connect", "fill"])
    app.mockInput.pressArrow("right")
    app.mockInput.pressEnter()
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("3/3  Send a peer message")

    app.mockInput.pressEnter()
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("Example · Session A")
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
    expect(app.captureCharFrame()).toContain("A peer is ready")
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
  onCleanup(Keymap.use().mode.push("modal"))
  return <DialogProductTour {...props} />
}
