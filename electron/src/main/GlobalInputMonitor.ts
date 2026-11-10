import { utilityProcess, screen } from 'electron'
import { join } from 'path'

// ─── Types ────────────────────────────────────────────────────────────────────

export type GlobalInputCallbacks = {
  onSessionStart: () => void
  onSessionEnd: () => void
  onSessionCancel: () => void
  onMouseMove: (x: number, y: number) => void
  // Fires on EVERY mouse move (not just during sessions) for cursor follower and
  // notch proximity detection. Optional so callers that don't need it can omit it.
  onGlobalMouseMove?: (x: number, y: number) => void
}

type WorkerMessage =
  | { type: 'ready' }
  | { type: 'session_start' }
  | { type: 'session_end' }
  | { type: 'session_cancel' }
  | { type: 'mouse_trigger' }
  | { type: 'stopped' }
  | { type: 'load_error'; message: string; raw: string }
  | { type: 'start_error'; message: string }
  | { type: 'stop_error'; message: string }

type WorkerCommand =
  | { type: 'stop' }
  | { type: 'exit' }

type ChildProcess = ReturnType<typeof utilityProcess.fork>

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_RESTART_ATTEMPTS          = 3
const STARTUP_WATCHDOG_TIMEOUT_MS   = 15_000
const SHUTDOWN_HANDSHAKE_TIMEOUT_MS = 3_000
const EXIT_ACK_TIMEOUT_MS           = 3_000
const RESTART_DELAY_MS              = 1_000

// ─── GlobalInputMonitor ───────────────────────────────────────────────────────

export class GlobalInputMonitor {
  private callbacks: GlobalInputCallbacks

  // Worker lifecycle state
  private workerGeneration = 0
  private child: ChildProcess | null = null
  private stopRequested = false
  private workerReady = false
  private restartCount = 0
  private workerSessionActive = false

  // Timer handles — all must be cleared on stop() to prevent post-shutdown activity
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private startupWatchdog: ReturnType<typeof setTimeout> | null = null
  private shutdownHandshakeTimer: ReturnType<typeof setTimeout> | null = null
  private exitAckTimer: ReturnType<typeof setTimeout> | null = null

  constructor(callbacks: GlobalInputCallbacks) {
    this.callbacks = callbacks
  }

  start(): void {
    this.stopRequested = false
    this.restartCount = 0
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    this.startWorker()
    console.log('[GlobalInputMonitor] started — listening for CTRL+ALT')
  }

  // stop() must remain void (not async) for compatibility with SessionManager.stop(): void
  // which is called synchronously in app.on('window-all-closed'). The shutdown handshake
  // completes asynchronously; app quit terminates the utility process regardless.
  stop(): void {
    this.stopRequested = true

    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }

    if (this.child === null) return

    if (!this.workerReady) {
      // Worker still starting — clear watchdog and kill immediately
      if (this.startupWatchdog !== null) {
        clearTimeout(this.startupWatchdog)
        this.startupWatchdog = null
      }
      this.child.kill()
      return
    }

    this.child.postMessage({ type: 'stop' } satisfies WorkerCommand)

    this.shutdownHandshakeTimer = setTimeout(() => {
      this.shutdownHandshakeTimer = null
      console.warn('[GlobalInputMonitor] shutdown handshake timeout — force-killing worker')
      this.child?.kill()
    }, SHUTDOWN_HANDSHAKE_TIMEOUT_MS)

    console.log('[GlobalInputMonitor] stop requested — waiting for worker shutdown')
  }

  private startWorker(): void {
    if (this.child !== null) return  // prevent duplicate workers

    const myGeneration = ++this.workerGeneration
    this.workerReady = false

    // __dirname at runtime = out/main/ — the worker lives in the same directory
    const workerPath = join(__dirname, 'GlobalInputWorker.js')
    const child = utilityProcess.fork(workerPath)
    this.child = child

    // Startup watchdog: if the worker never sends 'ready', uIOhook.start() may have
    // hung. Treat this as a permanent failure — do not attempt restart.
    this.startupWatchdog = setTimeout(() => {
      this.startupWatchdog = null
      if (this.workerGeneration !== myGeneration) return
      console.error('[GlobalInputMonitor] startup watchdog fired — worker never sent READY')
      this.stopRequested = true  // permanent failure — do not restart
      child.kill()
    }, STARTUP_WATCHDOG_TIMEOUT_MS)

    child.on('message', (rawMessage: unknown) => {
      if (this.workerGeneration !== myGeneration) return  // discard messages from stale workers
      const message = rawMessage as WorkerMessage

      switch (message.type) {

        case 'ready':
          if (this.startupWatchdog !== null) {
            clearTimeout(this.startupWatchdog)
            this.startupWatchdog = null
          }
          this.workerReady = true
          console.log('[GlobalInputMonitor] worker ready')
          break

        case 'session_start':
          this.workerSessionActive = true
          this.callbacks.onSessionStart()
          break

        case 'session_end':
          this.workerSessionActive = false
          this.callbacks.onSessionEnd()
          break

        case 'session_cancel':
          this.workerSessionActive = false
          this.callbacks.onSessionCancel()
          break

        case 'mouse_trigger': {
          // The coordinator is the canonical source of DIP coordinates. uiohook pixel
          // coordinates can diverge from Electron DIP space on high-DPI or portrait
          // monitors (WH_MOUSE_LL scale vs per-monitor DPI awareness v2). Calling
          // getCursorScreenPoint() here — not in the worker — ensures the right scale.
          const dipPoint = screen.getCursorScreenPoint()
          this.callbacks.onGlobalMouseMove?.(dipPoint.x, dipPoint.y)
          if (this.workerSessionActive) {
            this.callbacks.onMouseMove(dipPoint.x, dipPoint.y)
          }
          break
        }

        case 'stopped':
          if (this.shutdownHandshakeTimer !== null) {
            clearTimeout(this.shutdownHandshakeTimer)
            this.shutdownHandshakeTimer = null
          }
          child.postMessage({ type: 'exit' } satisfies WorkerCommand)
          this.exitAckTimer = setTimeout(() => {
            this.exitAckTimer = null
            console.warn('[GlobalInputMonitor] exit ack timeout — force-killing worker')
            child.kill()
          }, EXIT_ACK_TIMEOUT_MS)
          break

        case 'load_error':
          if (this.startupWatchdog !== null) {
            clearTimeout(this.startupWatchdog)
            this.startupWatchdog = null
          }
          console.error(`[GlobalInputMonitor] worker load error: ${message.message}`)
          console.error(`[GlobalInputMonitor]   raw: ${message.raw}`)
          // Permanent failure (ABI mismatch / module not found) — do not restart
          this.stopRequested = true
          child.postMessage({ type: 'exit' } satisfies WorkerCommand)
          break

        case 'start_error':
          if (this.startupWatchdog !== null) {
            clearTimeout(this.startupWatchdog)
            this.startupWatchdog = null
          }
          console.error(`[GlobalInputMonitor] worker start error: ${message.message}`)
          // Permanent failure — do not restart
          this.stopRequested = true
          child.postMessage({ type: 'exit' } satisfies WorkerCommand)
          break

        case 'stop_error':
          if (this.shutdownHandshakeTimer !== null) {
            clearTimeout(this.shutdownHandshakeTimer)
            this.shutdownHandshakeTimer = null
          }
          console.error(`[GlobalInputMonitor] worker stop error: ${message.message}`)
          child.postMessage({ type: 'exit' } satisfies WorkerCommand)
          break
      }
    })

    child.on('exit', (exitCode: number) => {
      if (this.workerGeneration !== myGeneration) return  // stale exit — ignore

      // Clear any timers that may still be running (defensive — most paths clear earlier)
      if (this.startupWatchdog !== null) {
        clearTimeout(this.startupWatchdog)
        this.startupWatchdog = null
      }
      if (this.shutdownHandshakeTimer !== null) {
        clearTimeout(this.shutdownHandshakeTimer)
        this.shutdownHandshakeTimer = null
      }
      if (this.exitAckTimer !== null) {
        clearTimeout(this.exitAckTimer)
        this.exitAckTimer = null
      }

      this.child = null
      this.workerReady = false

      // Cancel any active session before deciding on restart — prevents the session
      // from being stuck open if the worker crashes mid-recording.
      if (this.workerSessionActive) {
        this.workerSessionActive = false
        this.callbacks.onSessionCancel()
      }

      if (this.stopRequested) {
        console.log(`[GlobalInputMonitor] worker exited (code ${exitCode}) — shutdown was intentional`)
        return
      }

      // Unexpected exit — attempt bounded restart with delay
      if (this.restartCount >= MAX_RESTART_ATTEMPTS) {
        console.error('[GlobalInputMonitor] max restart attempts reached — giving up')
        return
      }

      this.restartCount++
      console.warn(
        `[GlobalInputMonitor] worker crashed (code ${exitCode}) — restart ${this.restartCount}/${MAX_RESTART_ATTEMPTS} in ${RESTART_DELAY_MS}ms`
      )
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null
        if (!this.stopRequested) {
          this.startWorker()
        }
      }, RESTART_DELAY_MS)
    })
  }
}
