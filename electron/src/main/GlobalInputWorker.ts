// utilityProcess worker for global keyboard/mouse monitoring via uiohook-napi.
// Runs in a separate OS process to isolate the WH_KEYBOARD_LL hook from the main
// process where getUserMedia() initialises Windows Media Foundation — which would
// otherwise suppress CTRL/ALT keyup delivery and leave sessions permanently active.

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

type MainCommand =
  | { type: 'stop' }
  | { type: 'exit' }

// How long to wait for the main process to send EXIT acknowledgement before
// exiting unilaterally. Keeps the worker from hanging if main crashes.
const EXIT_ACK_WAIT_TIMEOUT_MS = 3_000

function sendToMain(message: WorkerMessage): void {
  process.parentPort.postMessage(message)
}

function classifyLoadError(rawMessage: string): string {
  if (rawMessage.includes('MODULE_NOT_FOUND') || rawMessage.includes('Cannot find module')) {
    return 'Module resolution failure — node_modules path not found from utilityProcess context'
  }
  if (rawMessage.includes('Module compiled against different Node.js version')) {
    return 'ABI mismatch — binary compiled for a different Node.js ABI version'
  }
  if (rawMessage.includes('invalid ELF header') || rawMessage.includes('not a valid Win32 application')) {
    return 'Invalid binary or architecture mismatch (x86 vs x64 or arm64)'
  }
  if (rawMessage.toLowerCase().includes('access denied') || rawMessage.includes('EPERM')) {
    return 'Permission denied — insufficient privileges to load the native module'
  }
  return 'Unknown error — see raw message for manual diagnosis'
}

// Sends a terminal message to main, then waits for an EXIT acknowledgement before
// calling process.exit(exitCode). This two-step approach ensures the main process
// has a chance to receive and record the error before the channel closes.
//
// The fallback timer guarantees the worker never hangs if main crashes or never ACKs.
// All existing message listeners are replaced — the worker accepts only EXIT after this.
function waitForExitAckAndQuit(exitCode: number): void {
  const fallbackTimer = setTimeout(() => {
    // EXIT ACK never arrived — exit with a non-zero code so main cannot mistake
    // an unacknowledged success path for a clean exit.
    process.exit(exitCode === 0 ? 2 : exitCode)
  }, EXIT_ACK_WAIT_TIMEOUT_MS)
  // Do NOT unref: this timer must keep the worker alive while waiting for EXIT ACK.

  process.parentPort.removeAllListeners('message')
  process.parentPort.on('message', (event: { data: MainCommand }) => {
    if (event.data.type === 'exit') {
      clearTimeout(fallbackTimer)
      process.exit(exitCode)
    }
  })
}

// Loads uiohook-napi via dynamic require so load_error can be sent before exit.
// A static import failure crashes before any code runs — dynamic require allows
// the error to be reported to the coordinator first.
function loadUiohookOrWaitExit(): typeof import('uiohook-napi') {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const loaded = require('uiohook-napi') as typeof import('uiohook-napi')
    return loaded
  } catch (err) {
    const rawMessage = err instanceof Error ? err.message : String(err)
    sendToMain({ type: 'load_error', message: classifyLoadError(rawMessage), raw: rawMessage })
    waitForExitAckAndQuit(1)
    throw new Error('unreachable')
  }
}

const { uIOhook, UiohookKey } = loadUiohookOrWaitExit()

// CTRL_KEYS: both left and right CTRL variants trigger the session.
// ALT_KEYS: only left Alt. Excluding RightAlt prevents AltGr from starting a session —
// on Windows, pressing AltGr sends a synthetic LeftCtrl DOWN + RightAlt DOWN pair,
// so European keyboard layouts (typing @, [, {, etc.) would otherwise start a session.
const CTRL_KEYS = new Set<number>([UiohookKey.Ctrl, UiohookKey.CtrlRight])
const ALT_KEYS  = new Set<number>([UiohookKey.Alt])

const ctrlHeldKeys = new Set<number>()
const altHeldKeys  = new Set<number>()
let sessionActive = false

function isCtrlAltHeld(): boolean {
  return ctrlHeldKeys.size > 0 && altHeldKeys.size > 0
}

function evaluateSessionState(): void {
  const shouldBeActive = isCtrlAltHeld()
  if (shouldBeActive && !sessionActive) {
    sessionActive = true
    sendToMain({ type: 'session_start' })
  } else if (!shouldBeActive && sessionActive) {
    sessionActive = false
    ctrlHeldKeys.clear()
    altHeldKeys.clear()
    sendToMain({ type: 'session_end' })
  }
}

uIOhook.on('keydown', (event) => {
  if (CTRL_KEYS.has(event.keycode)) ctrlHeldKeys.add(event.keycode)
  if (ALT_KEYS.has(event.keycode))  altHeldKeys.add(event.keycode)

  if (event.keycode === UiohookKey.Escape && sessionActive) {
    sessionActive = false
    ctrlHeldKeys.clear()
    altHeldKeys.clear()
    sendToMain({ type: 'session_cancel' })
    return
  }

  evaluateSessionState()
})

uIOhook.on('keyup', (event) => {
  if (CTRL_KEYS.has(event.keycode)) ctrlHeldKeys.delete(event.keycode)
  if (ALT_KEYS.has(event.keycode))  altHeldKeys.delete(event.keycode)
  evaluateSessionState()
})

uIOhook.on('mousemove', () => {
  sendToMain({ type: 'mouse_trigger' })
})

// Listen for the STOP command from the coordinator.
// process.parentPort.on('message') receives a MessageEvent — the actual payload is
// in event.data, NOT on the event object directly.
process.parentPort.on('message', (event: { data: MainCommand }) => {
  const command = event.data
  if (command.type === 'stop') {
    try {
      uIOhook.stop()
      sendToMain({ type: 'stopped' })
      waitForExitAckAndQuit(0)
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      sendToMain({ type: 'stop_error', message: errorMessage })
      waitForExitAckAndQuit(1)
    }
  }
})

// Start uiohook — registers the low-level OS keyboard/mouse hooks.
try {
  uIOhook.start()
  sendToMain({ type: 'ready' })
} catch (err) {
  const errorMessage = err instanceof Error ? err.message : String(err)
  sendToMain({ type: 'start_error', message: errorMessage })
  // waitForExitAckAndQuit replaces the STOP listener set above.
  waitForExitAckAndQuit(1)
}

// Force module treatment so local type declarations do not bleed into TypeScript's
// global script scope (relevant when tsconfig includes other script-mode files).
export {}
