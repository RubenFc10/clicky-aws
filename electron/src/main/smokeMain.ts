// Smoke test main process entry point.
// Forks a utilityProcess running smokeTestWorker.js, coordinates the test protocol,
// and prints a compatibility report. Never imported by the production app.

import { app, utilityProcess } from 'electron'
import { join } from 'path'

// Messages received from the worker (sent via process.parentPort.postMessage in the worker)
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

// ─── Timing constants ─────────────────────────────────────────────────────────

// Guards against uIOhook.start() hanging indefinitely. Starts immediately after fork().
// Cleared only when READY, load_error, or start_error is received.
const STARTUP_WATCHDOG_TIMEOUT_MS = 15_000

// How long to wait for all three input event types after READY is confirmed.
// Starts only after the startup watchdog has been cleared by READY.
const EVENT_WAIT_TIMEOUT_MS = 15_000

// How long to wait for STOPPED after sending STOP to the worker.
const SHUTDOWN_HANDSHAKE_TIMEOUT_MS = 3_000

// How long to wait for the worker's exit event after sending EXIT acknowledgement.
// If the worker does not exit within this window, it is force-killed and cleanExit is set false.
const EXIT_ACK_TIMEOUT_MS = 3_000

// ─── Test state ───────────────────────────────────────────────────────────────

const REQUIRED_EVENT_TYPES: ReadonlyArray<'keydown' | 'keyup' | 'mousemove'> = ['keydown', 'keyup', 'mousemove']
const receivedEventTypes = new Set<'keydown' | 'keyup' | 'mousemove'>()

const testResults = {
  moduleLoaded:      false,
  uiohookStarted:    false,
  keydownReceived:   false,
  keyupReceived:     false,
  mousemoveReceived: false,
  cleanStop:         false,
  cleanExit:         false,
}

let startupWatchdogTimer:   ReturnType<typeof setTimeout> | null = null
let eventWaitTimer:         ReturnType<typeof setTimeout> | null = null
let shutdownHandshakeTimer: ReturnType<typeof setTimeout> | null = null
let exitAckTimer:           ReturnType<typeof setTimeout> | null = null
let shutdownAlreadyInitiated = false
let reportAlreadyPrinted     = false
// Set to true when the startup watchdog fires, so any late READY messages are ignored.
let startupTimedOut          = false
// Set to true when any forced termination occurs (shutdown handshake timeout, exitAck timeout,
// or watchdog). Prevents child.on('exit') from recording cleanExit = true after a forced kill.
let exitWasForced            = false

// ─── Report ───────────────────────────────────────────────────────────────────

function printFinalReport(): void {
  console.log('\n[SmokeTest] ════════ RISULTATI COMPATIBILITÀ ════════\n')
  console.log(`  1. Modulo nativo caricato (require + node-gyp-build):   ${testResults.moduleLoaded      ? '✓ PASS' : '✗ FAIL'}`)
  console.log(`  2. uIOhook.start() completato senza errori:             ${testResults.uiohookStarted    ? '✓ PASS' : '✗ FAIL'}`)
  console.log(`  3. Evento keydown globale ricevuto:                     ${testResults.keydownReceived    ? '✓ PASS' : '✗ FAIL'}`)
  console.log(`  4. Evento keyup globale ricevuto:                       ${testResults.keyupReceived      ? '✓ PASS' : '✗ FAIL'}`)
  console.log(`  5. Evento mousemove globale ricevuto:                   ${testResults.mousemoveReceived  ? '✓ PASS' : '✗ FAIL'}`)
  console.log(`  6. uIOhook.stop() completato (STOPPED ricevuto):        ${testResults.cleanStop         ? '✓ PASS' : '✗ FAIL'}`)
  console.log(`  7. Exit code 0 dopo handshake:                          ${testResults.cleanExit          ? '✓ PASS' : '✗ FAIL'}`)

  const allPassed = Object.values(testResults).every(Boolean)
  console.log(`\n  COMPATIBILITÀ CONFERMATA: ${allPassed ? '✓ SÌ' : '✗ NO'}`)
  console.log('  (richiede PASS su tutti e 7 i punti)\n')
  console.log('[SmokeTest] ═══════════════════════════════════════\n')
}

// Guard wrapper: ensures the report is printed exactly once regardless of how
// many code paths converge on termination (watchdog safety net, exit event, etc.).
function printFinalReportOnce(): void {
  if (reportAlreadyPrinted) return
  reportAlreadyPrinted = true
  printFinalReport()
}

// ─── Watchdog helpers ─────────────────────────────────────────────────────────

// Called when the worker confirms startup completed (READY) or failed terminally
// (load_error, start_error). Clears the startup watchdog so it cannot fire late.
function clearStartupWatchdog(): void {
  if (startupWatchdogTimer !== null) {
    clearTimeout(startupWatchdogTimer)
    startupWatchdogTimer = null
  }
}

// ─── Shutdown ─────────────────────────────────────────────────────────────────

function initiateShutdown(child: Electron.UtilityProcess): void {
  if (shutdownAlreadyInitiated) return
  shutdownAlreadyInitiated = true

  if (eventWaitTimer !== null) {
    clearTimeout(eventWaitTimer)
    eventWaitTimer = null
  }

  // Event flags are updated immediately when each message arrives (not deferred here),
  // so testResults.{keydown,keyup,mousemove}Received are already accurate at this point.

  console.log('[SmokeTest] Avvio shutdown — invio STOP al worker')
  child.postMessage({ type: 'stop' })

  // Force-kill the worker if the STOP→STOPPED handshake does not complete in time.
  shutdownHandshakeTimer = setTimeout(() => {
    shutdownHandshakeTimer = null
    console.log('[SmokeTest] ✗ Worker non ha risposto entro 3s — TERMINAZIONE FORZATA')
    testResults.cleanStop = false
    testResults.cleanExit = false
    exitWasForced = true
    child.kill()
    // Safety net: if child.kill() does not trigger the exit event, force quit after 2s.
    setTimeout(() => {
      printFinalReportOnce()
      app.quit()
    }, 2000)
  }, SHUTDOWN_HANDSHAKE_TIMEOUT_MS)
}

function checkAllEventsReceivedAndShutdown(child: Electron.UtilityProcess): void {
  const allEventsReceived = REQUIRED_EVENT_TYPES.every(eventType => receivedEventTypes.has(eventType))
  if (allEventsReceived) {
    console.log('[SmokeTest] ✓ Tutti e 3 gli eventi ricevuti — avvio shutdown anticipato')
    initiateShutdown(child)
  }
}

// ─── App entry ────────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  // __dirname at runtime = out-smoke/main/ — the worker lives in the same directory
  const workerPath = join(__dirname, 'smokeTestWorker.js')
  console.log(`[SmokeTest] Avvio worker: ${workerPath}`)

  const child = utilityProcess.fork(workerPath)

  // Startup watchdog: starts immediately after fork().
  // If uIOhook.start() hangs indefinitely without throwing, READY is never sent,
  // the event-wait timer never starts, and the test would run forever without this guard.
  startupWatchdogTimer = setTimeout(() => {
    startupWatchdogTimer = null
    console.log(`[SmokeTest] ✗ Watchdog avvio scattato — READY non ricevuto entro ${STARTUP_WATCHDOG_TIMEOUT_MS / 1000}s`)
    testResults.uiohookStarted = false
    testResults.cleanStop = false
    testResults.cleanExit = false
    // Prevent any late READY message (still in flight) from setting uiohookStarted = true
    // or starting the event-reception timer on a worker that is already being killed.
    startupTimedOut = true
    exitWasForced = true

    child.kill()
    // Safety net: if child.kill() does not trigger the exit event, force quit after 2s.
    setTimeout(() => {
      printFinalReportOnce()
      app.quit()
    }, 2000)
  }, STARTUP_WATCHDOG_TIMEOUT_MS)

  // ─── Message handler ──────────────────────────────────────────────────────

  child.on('message', (rawMessage: unknown) => {
    const message = rawMessage as WorkerMessage

    switch (message.type) {

      case 'module_loaded':
        // Module loaded — startup watchdog is NOT cleared yet because uIOhook.start()
        // may still hang. Keep the watchdog running until READY or a start error.
        testResults.moduleLoaded = true
        console.log('[SmokeTest] ✓ Modulo uiohook-napi caricato')
        break

      case 'ready':
        // Discard any READY that arrives after the startup watchdog already fired and killed
        // the worker. Without this guard, a message in transit could start eventWaitTimer
        // on a dead process, leaving the main process alive for another 15s before timing out.
        if (startupTimedOut) {
          console.log('[SmokeTest] READY tardivo ignorato — startup watchdog già scattato')
          break
        }
        // uIOhook.start() succeeded — clear the startup watchdog, it is no longer needed.
        clearStartupWatchdog()
        testResults.uiohookStarted = true
        console.log(`[SmokeTest] ✓ uIOhook.start() completato — in attesa di input (${EVENT_WAIT_TIMEOUT_MS / 1000}s)...`)
        console.log('[SmokeTest]   Premi tasti e muovi il mouse per verificare la consegna degli eventi')

        // The event-reception timer starts ONLY after READY is confirmed.
        // Starting it earlier would risk expiring before uiohook is running.
        eventWaitTimer = setTimeout(() => {
          eventWaitTimer = null
          const missingEvents = REQUIRED_EVENT_TYPES.filter(eventType => !receivedEventTypes.has(eventType))
          if (missingEvents.length > 0) {
            console.log(`[SmokeTest] Timeout — eventi mancanti: ${missingEvents.join(', ')}`)
          }
          initiateShutdown(child)
        }, EVENT_WAIT_TIMEOUT_MS)
        break

      case 'keydown':
        if (!receivedEventTypes.has('keydown')) {
          receivedEventTypes.add('keydown')
          // Update the flag immediately so it is accurate if the worker exits
          // unexpectedly before initiateShutdown() is ever called.
          testResults.keydownReceived = true
          console.log(`[SmokeTest] ✓ keydown ricevuto (keycode=${message.keycode})`)
          checkAllEventsReceivedAndShutdown(child)
        }
        break

      case 'keyup':
        if (!receivedEventTypes.has('keyup')) {
          receivedEventTypes.add('keyup')
          testResults.keyupReceived = true
          console.log(`[SmokeTest] ✓ keyup ricevuto (keycode=${message.keycode})`)
          checkAllEventsReceivedAndShutdown(child)
        }
        break

      case 'mousemove':
        if (!receivedEventTypes.has('mousemove')) {
          receivedEventTypes.add('mousemove')
          testResults.mousemoveReceived = true
          console.log(`[SmokeTest] ✓ mousemove ricevuto (x=${message.x}, y=${message.y})`)
          checkAllEventsReceivedAndShutdown(child)
        }
        break

      case 'stopped':
        // uIOhook.stop() succeeded — clear the shutdown handshake timer and ACK.
        testResults.cleanStop = true
        if (shutdownHandshakeTimer !== null) {
          clearTimeout(shutdownHandshakeTimer)
          shutdownHandshakeTimer = null
        }
        console.log('[SmokeTest] ✓ uIOhook.stop() completato — invio EXIT al worker')
        // Send EXIT acknowledgement so the worker can call process.exit(0).
        child.postMessage({ type: 'exit' })
        // Guard: a successful STOPPED alone must never count as a clean exit — the worker
        // must actually terminate with exit code 0. Start a bounded timer to enforce this.
        exitAckTimer = setTimeout(() => {
          exitAckTimer = null
          console.log('[SmokeTest] ✗ Worker non è uscito entro 3s dopo EXIT — TERMINAZIONE FORZATA')
          testResults.cleanExit = false
          exitWasForced = true
          child.kill()
          // Safety net in case child.kill() does not trigger the exit event.
          setTimeout(() => {
            printFinalReportOnce()
            app.quit()
          }, 2000)
        }, EXIT_ACK_TIMEOUT_MS)
        break

      case 'load_error':
        // Module failed to load — clear startup watchdog, record error, ACK so worker can exit.
        clearStartupWatchdog()
        console.log('[SmokeTest] ✗ Caricamento modulo fallito')
        console.log(`[SmokeTest]   Causa: ${message.message}`)
        console.log(`[SmokeTest]   Raw:   ${message.raw}`)
        // Send EXIT acknowledgement so the worker can call process.exit(1).
        // The worker waits for this before exiting, ensuring the error is recorded here first.
        child.postMessage({ type: 'exit' })
        break

      case 'start_error':
        // uIOhook.start() threw — clear startup watchdog, record error, ACK so worker can exit.
        clearStartupWatchdog()
        console.log(`[SmokeTest] ✗ uIOhook.start() fallito: ${message.message}`)
        child.postMessage({ type: 'exit' })
        break

      case 'stop_error':
        // uIOhook.stop() threw — clear handshake timer, record error, ACK so worker can exit.
        if (shutdownHandshakeTimer !== null) {
          clearTimeout(shutdownHandshakeTimer)
          shutdownHandshakeTimer = null
        }
        console.log(`[SmokeTest] ✗ uIOhook.stop() fallito: ${message.message}`)
        child.postMessage({ type: 'exit' })
        break
    }
  })

  // ─── Exit handler ─────────────────────────────────────────────────────────

  child.on('exit', (exitCode: number) => {
    // Clear any timers that may still be running (defensive — most paths clear them earlier).
    clearStartupWatchdog()
    if (shutdownHandshakeTimer !== null) {
      clearTimeout(shutdownHandshakeTimer)
      shutdownHandshakeTimer = null
    }
    if (eventWaitTimer !== null) {
      clearTimeout(eventWaitTimer)
      eventWaitTimer = null
    }
    if (exitAckTimer !== null) {
      clearTimeout(exitAckTimer)
      exitAckTimer = null
    }

    if (exitCode === 0 && testResults.cleanStop && !exitWasForced) {
      // Genuine clean exit: STOPPED was received, exit code is 0, and no forced termination
      // occurred. exitWasForced guards against child.kill() accidentally producing exitCode 0
      // on some platforms after the STOP→STOPPED handshake or exitAck timeouts already fired.
      testResults.cleanExit = true
      console.log('[SmokeTest] ✓ Worker terminato con exit code 0')
    } else if (exitWasForced) {
      testResults.cleanExit = false
      console.log(`[SmokeTest] ✗ Terminazione forzata — exit code ${exitCode}`)
    } else if (exitCode !== 0) {
      testResults.cleanExit = false
      console.log(`[SmokeTest] ✗ Worker terminato con exit code ${exitCode}`)
    } else {
      // exitCode === 0 but STOPPED was never received — forced exit without clean handshake.
      testResults.cleanExit = false
      console.log('[SmokeTest] ✗ Exit code 0 ma STOPPED non ricevuto — shutdown non pulito')
    }

    printFinalReportOnce()
    app.quit()
  })
})
