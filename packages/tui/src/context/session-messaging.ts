import { createEffect, createSignal, onCleanup } from "solid-js"
import { useClient } from "./client"

export function registerOpenSessions(sessions: () => readonly string[]) {
  const client = useClient()
  const [enabled, setEnabled] = createSignal(false)
  if (!client.restart) return enabled

  let leaseID: string | undefined
  let generation = 0
  let pending = false
  let dirty = false
  let unavailable = false
  let disposed = false
  let open: readonly string[] = []
  const sync = async () => {
    dirty = true
    if (pending || unavailable || disposed) return
    pending = true
    try {
      while (dirty && !disposed && !unavailable) {
        dirty = false
        const api = client.api.experimental["session-messaging"]
        const current = generation
        const id = leaseID
        try {
          const lease = id
            ? await api.refreshLease({ leaseID: id, sessions: open })
            : await api.openLease({ sessions: open })
          if (disposed || current !== generation) {
            if (!id) void api.closeLease({ leaseID: lease.leaseID }).catch(() => {})
            continue
          }
          leaseID = lease.leaseID
          setEnabled(true)
        } catch {
          if (current !== generation || disposed) continue
          leaseID = undefined
          setEnabled(false)
          // Failed renewal may mean the server restarted or the heartbeat arrived after expiry.
          if (id) dirty = true
          else unavailable = true
        }
      }
    } finally {
      pending = false
    }
  }

  createEffect(() => {
    open = [...new Set(sessions().filter((id) => id.startsWith("ses_")))].slice(0, 128)
    void sync()
  })
  const timer = setInterval(() => void sync(), 10_000)
  const off = client.event.on("server.connected", () => {
    if (leaseID) void client.api.experimental["session-messaging"].closeLease({ leaseID }).catch(() => {})
    generation++
    unavailable = false
    leaseID = undefined
    setEnabled(false)
    void sync()
  })
  const created = client.event.on("session.created", (event) => {
    if (open.includes(event.data.sessionID)) void sync()
  })
  onCleanup(() => {
    off()
    created()
    disposed = true
    clearInterval(timer)
    if (leaseID) void client.api.experimental["session-messaging"].closeLease({ leaseID }).catch(() => {})
  })
  return enabled
}
