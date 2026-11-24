import { onCleanup } from "solid-js"
import { DialogProductTour, type TourPeer } from "../component/dialog-product-tour"
import { emptyPrompt } from "../prompt/history"
import { useDialog } from "../ui/dialog"
import { useToast } from "../ui/toast"
import { useClient } from "./client"
import { useData } from "./data"
import { usePromptRef } from "./prompt"
import { useRoute } from "./route"
import { useStorage } from "./storage"

const firstPrompt = "Briefly explain the main directories in this project. Read files only and make no changes."

export function createProductTour(input: {
  invite: boolean
  connected: () => boolean
  peerMessagingEnabled: () => boolean
  connect: () => void
}) {
  const client = useClient()
  const data = useData()
  const dialog = useDialog()
  const prompt = usePromptRef()
  const route = useRoute()
  const toast = useToast()
  const [progress, update] = useStorage().store("product-tour", { initial: { hidden: false, firstResponse: false } })
  let awaitingSample = false

  const sessionID = () =>
    route.data.type === "session" && route.data.sessionID.startsWith("ses_") ? route.data.sessionID : undefined
  const messaging = () => (!client.restart ? "unmanaged" : input.peerMessagingEnabled() ? "enabled" : "disabled")

  const loadPeer = async (id: string): Promise<TourPeer> => {
    const api = client.api.experimental["session-messaging"]
    try {
      const participation = await api.participation({ sessionID: id })
      if (!participation.enabled) return { type: "inactive" }
      const [peer] = await api.peers({ sessionID: id })
      return peer ? { type: "ready", sessionID: peer.sessionID } : { type: "missing" }
    } catch {
      return { type: "unavailable" }
    }
  }

  onCleanup(
    data.on("session.execution.succeeded", (event) => {
      if (!awaitingSample) return
      const messages = data.session.message.list(event.data.sessionID)
      const user = messages.findLastIndex((message) => message.type === "user")
      const message = messages[user]
      if (message?.type !== "user" || message.text !== firstPrompt) return
      if (!messages.slice(user + 1).some((item) => item.type === "assistant")) return
      awaitingSample = false
      void update((draft) => {
        draft.firstResponse = true
      }).then(
        () => toast.show({ message: "First response received. Open /tour to try peer messaging.", variant: "success" }),
        toast.error,
      )
    }),
  )

  const insert = (peerID?: string) => {
    const composer = prompt.current
    const current = composer?.current
    if (!composer || !current || composer.mode !== "normal") {
      toast.show({ message: "Open a chat prompt before filling it with an example.", variant: "info" })
      return
    }
    if (
      current.text ||
      current.files?.length ||
      current.agents?.length ||
      current.skills?.length ||
      current.pasted.length
    ) {
      toast.show({ message: "Clear or save your current draft before filling the prompt.", variant: "info" })
      return
    }
    const text = peerID
      ? `Use session_message_send to ask peer ${peerID} to reply with “received”. Report the request ID and continue without waiting for the reply.`
      : firstPrompt
    if (!peerID && !progress.firstResponse) awaitingSample = true
    dialog.clear()
    composer.set({ ...emptyPrompt(), text })
    composer.focus()
  }

  const dismiss = () => {
    void update((draft) => {
      draft.hidden = true
    }).catch(toast.error)
  }

  return {
    visible: () => input.invite && client.connection.status() === "connected" && !progress.hidden,
    dismiss,
    open() {
      const start = progress.firstResponse ? 2 : input.connected() ? 1 : 0
      dialog.replace(() => (
        <DialogProductTour
          start={start}
          connected={input.connected}
          messaging={messaging}
          sessionID={sessionID}
          loadPeer={loadPeer}
          connect={input.connect}
          insert={insert}
          finish={dismiss}
        />
      ))
    },
  }
}
