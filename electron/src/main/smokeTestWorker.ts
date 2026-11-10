// Smoke test utility process worker.
// Loads uiohook-napi, starts the global hook, and reports keyboard/mouse events
// to the main process via parentPort IPC. Never imported by the production app.

type WorkerMessage =
  | { type: 'module_loaded' }
  | { type: 'ready' }
  | { type: 'keydown'; keycode: number }
  | { type: 'keyup'; keycode: number }
  | { type: 'mousemove'; x: number; y: number }
  | { type: 'stopped' }
  | { type: 'load_error'; message: string; raw: string }
  | { type: 'start_error'; message: string }
  | { type: 'stop_error'; message: string }

type MainCommand =
  | { type: 'stop' }
  | { type: 'exit' }

// How long to wait for the main process to send the EXIT acknowledgement
// before exiting unilaterally. Keeps the worker from hanging if main crashes.
const EXIT_ACK_WAIT_TIMEOUT_MS = 3000

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
// The fallback timer (EXIT_ACK_WAIT_TIMEOUT_MS) guarantees the worker never hangs
// indefinitely if the main process crashes or never sends EXIT.
//
// All existing message listeners are replaced — the worker accepts only EXIT after this.
function waitForExitAckAndQuit(exitCode: number): void {
  const fallbackTimer = setTimeout(() => {
    // EXIT ACK was never received within the timeout — exit with a non-zero code so the
    // main process cannot mistake an unacknowledged success path for a clean exit.
    // Only an actual EXIT command received from main grants the intended exitCode.
    process.exit(exitCode === 0 ? 2 : exitCode)
  }, EXIT_ACK_WAIT_TIMEOUT_MS)
  // Do NOT unref: this timer must keep the worker alive while waiting for EXIT ACK.
  // Unrefing would allow the process to exit before the timeout if nothing else runs.

  process.parentPort.removeAllListeners('message')
  process.parentPort.on('message', (event: { data: MainCommand }) => {
    if (event.data.type === 'exit') {
      clearTimeout(fallbackTimer)
      process.exit(exitCode)
    }
  })
}

// Step 1: Load the native module.
// On failure: sends load_error then waits for EXIT ACK — the main process can
// read and record the classified error before the channel closes.
// The 'throw' after waitForExitAckAndQuit is unreachable at runtime but needed
// so TypeScript's control-flow analysis recognises that this branch never returns.
function loadUiohookOrWaitExit(): typeof import('uiohook-napi') {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const loaded = require('uiohook-napi') as typeof import('uiohook-napi')
    sendToMain({ type: 'module_loaded' })
    return loaded
  } catch (err) {
    const rawMessage = err instanceof Error ? err.message : String(err)
    sendToMain({ type: 'load_error', message: classifyLoadError(rawMessage), raw: rawMessage })
    waitForExitAckAndQuit(1)
    throw new Error('unreachable')
  }
}

const uiohookNapi = loadUiohookOrWaitExit()
const { uIOhook } = uiohookNapi

// Step 2: Register global input event listeners before starting the hook.
uIOhook.on('keydown', (event) => {
  sendToMain({ type: 'keydown', keycode: event.keycode })
})

uIOhook.on('keyup', (event) => {
  sendToMain({ type: 'keyup', keycode: event.keycode })
})

uIOhook.on('mousemove', (event) => {
  sendToMain({ type: 'mousemove', x: event.x, y: event.y })
})

// Step 3: Listen for the STOP command from the main process.
// process.parentPort.on('message') receives a MessageEvent — the actual payload is in event.data,
// NOT on the event object directly. This distinction is critical for utilityProcess IPC.
//
// On success: sends STOPPED then calls waitForExitAckAndQuit(0).
// On stop failure: sends stop_error then calls waitForExitAckAndQuit(1).
// In both cases waitForExitAckAndQuit replaces this listener with an EXIT-only handler.
process.parentPort.on('message', (event: { data: MainCommand }) => {
  const command = event.data

  if (command.type === 'stop') {
    try {
      uIOhook.stop()
      sendToMain({ type: 'stopped' })
      // Success path: wait for EXIT ACK from main, then exit cleanly.
      waitForExitAckAndQuit(0)
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      sendToMain({ type: 'stop_error', message: errorMessage })
      // Error path: wait for EXIT ACK from main, then exit with failure code.
      waitForExitAckAndQuit(1)
    }
  }
})

// Step 4: Start uiohook — this call registers the low-level OS keyboard/mouse hooks.
// On failure: sends start_error then waits for EXIT ACK (same two-step pattern).
try {
  uIOhook.start()
  sendToMain({ type: 'ready' })
} catch (err) {
  const errorMessage = err instanceof Error ? err.message : String(err)
  sendToMain({ type: 'start_error', message: errorMessage })
  // waitForExitAckAndQuit replaces the STOP listener set in Step 3.
  // No further STOP commands can arrive or be processed after this point.
  waitForExitAckAndQuit(1)
}

// Force module treatment so local type declarations do not bleed into TypeScript's
// global script scope (relevant when tsconfig includes other script-mode files).
export {}