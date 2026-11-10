import { screen } from 'electron'
import { randomUUID } from 'crypto'
import { IPC_CHANNELS } from '../shared/ipcTypes'
import { SESSION_STATE } from '../shared/sessionTypes'
import type {
  SessionState,
  MousePointPayload,
  GlobalMousePayload,
  FinalizeSessionPayload,
  AnnotatedScreenshotPayload,
  SessionPayload,
  DisplayScreenshot,
  Stroke,
} from '../shared/sessionTypes'
import { GlobalInputMonitor } from './GlobalInputMonitor'
import { ScreenCaptureService } from './ScreenCaptureService'
import type { NotchWindowManager } from './NotchWindowManager'
import type { DisplayOverlayManager } from './DisplayOverlayManager'

// ─── Throttle Constants ───────────────────────────────────────────────────────

// Minimum time between session mouse point IPC messages (≈60 fps)
const MOUSE_THROTTLE_INTERVAL_MS = 16
// Minimum pixel distance before a new point is recorded (avoids micro-jitter)
const MOUSE_MIN_DISTANCE_PX = 3
// Time before screenshot capture after hiding windows (ms) — lets OS compositor
// actually hide the windows before desktopCapturer grabs the framebuffer
const CAPTURE_HIDE_SETTLE_MS = 80
// Max wait for all overlay annotations before assembling a partial payload
const ANNOTATION_TIMEOUT_MS = 10_000

// ─── SessionManager ───────────────────────────────────────────────────────────

export class SessionManager {
  private currentState: SessionState = SESSION_STATE.IDLE
  private currentSessionId: string | null = null
  private sessionStartedAt: number = 0

  // Session mouse throttle state
  private lastSessionMouseSentAt: number = 0
  private lastSessionMouseRelX: number = -1
  private lastSessionMouseRelY: number = -1

  // Throttle for coordinate diagnostics — 1 log per second max to avoid console flooding
  private diagnosticLogThrottleAt: number = 0
  private static readonly DIAGNOSTIC_LOG_INTERVAL_MS = 1000

  // Per-display original screenshots captured at session end, keyed by displayId.
  // Held until all overlays return their annotations.
  private pendingScreenshotsPerDisplay: Map<string, string> = new Map()

  // Annotation aggregation: each DisplayOverlay sends one AnnotatedScreenshotPayload.
  // We wait for all before assembling the final SessionPayload.
  private pendingAnnotations: Map<string, AnnotatedScreenshotPayload> = new Map()
  private expectedAnnotationCount: number = 0
  private annotationTimeoutTimer: ReturnType<typeof setTimeout> | null = null

  private readonly inputMonitor: GlobalInputMonitor
  private readonly screenCapture: ScreenCaptureService

  // Set after window managers are created (can't be set in constructor because
  // the BrowserWindows don't exist until app.whenReady())
  private notchManager: NotchWindowManager | null = null
  private overlayManager: DisplayOverlayManager | null = null

  constructor() {
    this.screenCapture = new ScreenCaptureService()
    this.inputMonitor = new GlobalInputMonitor({
      onSessionStart:      () => this.handleSessionStart(),
      onSessionEnd:        () => this.handleSessionEnd(),
      onSessionCancel:     () => this.handleSessionCancel(),
      onMouseMove:         (physX, physY) => this.handleSessionMouseMove(physX, physY),
      onGlobalMouseMove:   (physX, physY) => this.handleGlobalMouseMove(physX, physY),
    })
  }

  // Wire in the window managers after they've been created in app.whenReady()
  setManagerReferences(
    notchWindowManager: NotchWindowManager,
    displayOverlayManager: DisplayOverlayManager
  ): void {
    this.notchManager   = notchWindowManager
    this.overlayManager = displayOverlayManager
  }

  start(): void {
    this.inputMonitor.start()
  }

  stop(): void {
    this.inputMonitor.stop()
  }

  // Secondary cancel path for renderer-initiated aborts (e.g. ESC in a focused input).
  cancelSession(): void {
    this.handleSessionCancel()
  }

  // Called by IPC when a DisplayOverlay renderer has finished annotating its screenshot.
  // Accumulates responses from all displays before assembling the final payload.
  handleAnnotationReady(annotationPayload: AnnotatedScreenshotPayload): void {
    if (this.currentState !== SESSION_STATE.PROCESSING) return
    if (annotationPayload.sessionId !== this.currentSessionId) return

    this.pendingAnnotations.set(annotationPayload.displayId, annotationPayload)

    if (this.pendingAnnotations.size >= this.expectedAnnotationCount) {
      if (this.annotationTimeoutTimer !== null) {
        clearTimeout(this.annotationTimeoutTimer)
        this.annotationTimeoutTimer = null
      }
      this.assembleFinalPayload()
    }
  }

  // ─── Always-on global mouse handler ──────────────────────────────────────────

  // Fires for EVERY mouse move (not just during sessions).
  // Uses getCursorScreenPoint() as the canonical DIP source, then broadcasts to
  // overlay renderers for the cursor orb and to NotchWindowManager for proximity.
  //
  // Why getCursorScreenPoint() instead of screenToDipPoint(uiohookCoords):
  // On Windows with per-monitor DPI awareness v2 (Electron's default), WH_MOUSE_LL
  // (what uiohook uses) may return virtual-screen coordinates in a scale that differs
  // from Electron's DIP space on non-100%-DPI or portrait monitors. getCursorScreenPoint()
  // is Electron's own API and always returns the correct global DIP position.
  // uiohook event is kept as a trigger only; its x/y are used solely for diagnostics.
  private handleGlobalMouseMove(uiohookX: number, uiohookY: number): void {
    const dipPoint = screen.getCursorScreenPoint()

    const nearestDisplay = screen.getDisplayNearestPoint(dipPoint)
    const displayId = String(nearestDisplay.id)
    const displayRelX = dipPoint.x - nearestDisplay.bounds.x
    const displayRelY = dipPoint.y - nearestDisplay.bounds.y

    const cursorGlobalPayload: GlobalMousePayload = {
      dipX: dipPoint.x,
      dipY: dipPoint.y,
      displayId,
      displayRelX,
      displayRelY,
    }

    this.overlayManager?.broadcastCursorMove(cursorGlobalPayload)
    this.notchManager?.evaluateHoverProximity(dipPoint.x, dipPoint.y)

    // Diagnostic: compare uiohook coords vs getCursorScreenPoint (canonical) vs the
    // old screenToDipPoint approach. Throttled to 1 log/s.
    // On the Samsung portrait, check these logs to confirm getCursorScreenPoint
    // matches the expected DIP position and that the old approach diverged.
    const now = Date.now()
    if (now - this.diagnosticLogThrottleAt >= SessionManager.DIAGNOSTIC_LOG_INTERVAL_MS) {
      this.diagnosticLogThrottleAt = now
      const screenToDipForComparison = process.platform === 'win32'
        ? screen.screenToDipPoint({ x: uiohookX, y: uiohookY })
        : { x: uiohookX, y: uiohookY }
      console.debug(
        '[coord-diagnostic]',
        `uiohook=(${uiohookX},${uiohookY})`,
        `getCursorScreenPoint=(${dipPoint.x},${dipPoint.y})`,
        `screenToDipPoint(uiohook)=(${Math.round(screenToDipForComparison.x)},${Math.round(screenToDipForComparison.y)})`,
        `displayId=${displayId}`,
        `displayBounds=${nearestDisplay.bounds.x},${nearestDisplay.bounds.y}+${nearestDisplay.bounds.width}×${nearestDisplay.bounds.height}`,
        `displayRel=(${Math.round(displayRelX)},${Math.round(displayRelY)})`,
        `rotation=${nearestDisplay.rotation}`,
        `scaleFactor=${nearestDisplay.scaleFactor}`
      )
    }
  }

  // ─── Session-only mouse handler ───────────────────────────────────────────────

  // Fires only while a session is RECORDING_AND_TRACKING.
  // Sends throttled display-relative DIP mouse points to the overlay for drawing strokes.
  // Uses getCursorScreenPoint() as canonical DIP source for the same reason as
  // handleGlobalMouseMove — uiohook coords are trigger-only.
  private handleSessionMouseMove(_uiohookX: number, _uiohookY: number): void {
    if (this.currentState !== SESSION_STATE.RECORDING_AND_TRACKING) return

    const now = Date.now()
    if (now - this.lastSessionMouseSentAt < MOUSE_THROTTLE_INTERVAL_MS) return

    const dipPoint = screen.getCursorScreenPoint()

    const nearestDisplay = screen.getDisplayNearestPoint(dipPoint)
    const displayId = String(nearestDisplay.id)
    const displayRelX = dipPoint.x - nearestDisplay.bounds.x
    const displayRelY = dipPoint.y - nearestDisplay.bounds.y

    const distancePx = Math.sqrt(
      Math.pow(displayRelX - this.lastSessionMouseRelX, 2) +
      Math.pow(displayRelY - this.lastSessionMouseRelY, 2)
    )
    if (distancePx < MOUSE_MIN_DISTANCE_PX && this.lastSessionMouseRelX !== -1) return

    this.lastSessionMouseSentAt = now
    this.lastSessionMouseRelX = displayRelX
    this.lastSessionMouseRelY = displayRelY

    const sessionMousePayload: MousePointPayload = {
      x: displayRelX,            // display-relative DIP → maps directly to CSS pixels in overlay
      y: displayRelY,
      globalX: dipPoint.x,
      globalY: dipPoint.y,
      timestamp: now,
      sessionId: this.currentSessionId!,
      displayId,
    }

    // Broadcast to all overlays; each DrawingCanvas filters by its own displayId
    this.overlayManager?.broadcastToAllOverlays(IPC_CHANNELS.SESSION_MOUSE_POINT, sessionMousePayload)
  }

  // ─── Session lifecycle handlers ───────────────────────────────────────────────

  private handleSessionStart(): void {
    if (this.currentState !== SESSION_STATE.IDLE) {
      console.warn('[SessionManager] session start ignored — not idle')
      return
    }

    this.currentSessionId = randomUUID()
    this.sessionStartedAt = Date.now()
    this.resetSessionMouseThrottle()

    console.log(`[SessionManager] session started — id: ${this.currentSessionId}`)
    this.transitionTo(SESSION_STATE.RECORDING_AND_TRACKING)
  }

  private async handleSessionEnd(): Promise<void> {
    if (this.currentState !== SESSION_STATE.RECORDING_AND_TRACKING) return

    this.transitionTo(SESSION_STATE.FINALIZING)
    console.log('[SessionManager] session ending — capturing all displays…')

    let capturedDisplays: Map<string, string> = new Map()

    // Hide ALL windows before capture so the UI doesn't appear in screenshots.
    // try/finally guarantees windows are restored even if capture throws.
    try {
      this.overlayManager?.hideAllForCapture()
      this.notchManager?.hideForCapture()
      await sleep(CAPTURE_HIDE_SETTLE_MS)
      capturedDisplays = await this.screenCapture.captureAllDisplays()
    } catch (captureError) {
      console.error('[SessionManager] screen capture failed:', captureError)
    } finally {
      this.overlayManager?.showAllAfterCapture()
      this.notchManager?.showAfterCapture()
    }

    if (capturedDisplays.size === 0) {
      console.error('[SessionManager] no displays captured — cancelling session')
      this.handleSessionCancel()
      return
    }

    // Store original screenshots so assembleFinalPayload() can include them
    this.pendingScreenshotsPerDisplay.clear()
    for (const [displayId, base64Png] of capturedDisplays) {
      this.pendingScreenshotsPerDisplay.set(displayId, base64Png)
    }

    const monitors = this.screenCapture.getAllMonitorInfo()
    const activeDisplayIds = this.overlayManager?.getActiveDisplayIds() ?? []

    // Set up aggregator BEFORE sending finalize events so no annotations arrive early
    this.setupAnnotationAggregator(activeDisplayIds.length)

    this.transitionTo(SESSION_STATE.PROCESSING)

    // Send SESSION_FINALIZE to each display's overlay with its own screenshot.
    // Each overlay draws strokes on top and returns SESSION_ANNOTATION_READY.
    for (const displayId of activeDisplayIds) {
      const displayScreenshotBase64 = capturedDisplays.get(displayId)
      if (displayScreenshotBase64 === undefined) {
        console.warn(`[SessionManager] no screenshot for displayId=${displayId} — skipping finalize`)
        this.expectedAnnotationCount--  // won't get an annotation for this display
        continue
      }

      const finalizePayload: FinalizeSessionPayload = {
        sessionId: this.currentSessionId!,
        screenshotOriginalBase64: displayScreenshotBase64,
        displayId,
        monitors,
        startedAt: this.sessionStartedAt,
      }

      this.overlayManager?.sendToDisplay(displayId, IPC_CHANNELS.SESSION_FINALIZE, finalizePayload)
    }
  }

  private handleSessionCancel(): void {
    if (this.currentState === SESSION_STATE.IDLE) return

    if (this.annotationTimeoutTimer !== null) {
      clearTimeout(this.annotationTimeoutTimer)
      this.annotationTimeoutTimer = null
    }

    console.log('[SessionManager] session cancelled')
    this.transitionTo(SESSION_STATE.IDLE)
    this.currentSessionId = null
    this.pendingAnnotations.clear()
    this.pendingScreenshotsPerDisplay.clear()

    this.overlayManager?.broadcastToAllOverlays(IPC_CHANNELS.SESSION_CANCELLED)
    this.sendToNotch(IPC_CHANNELS.SESSION_CANCELLED)
  }

  // ─── Annotation aggregation ───────────────────────────────────────────────────

  private setupAnnotationAggregator(annotationCount: number): void {
    this.pendingAnnotations.clear()
    this.expectedAnnotationCount = annotationCount

    // Safety net: if any overlay doesn't respond within 10s, assemble with what we have
    this.annotationTimeoutTimer = setTimeout(() => {
      console.warn(
        `[SessionManager] annotation timeout — received ${this.pendingAnnotations.size}/${this.expectedAnnotationCount} annotations, assembling partial payload`
      )
      this.assembleFinalPayload()
    }, ANNOTATION_TIMEOUT_MS)
  }

  private assembleFinalPayload(): void {
    const allStrokes: Stroke[] = []
    const screenshotsPerDisplay: DisplayScreenshot[] = []

    for (const [displayId, annotation] of this.pendingAnnotations) {
      allStrokes.push(...annotation.strokes)

      const originalScreenshotBase64 = this.pendingScreenshotsPerDisplay.get(displayId) ?? ''
      screenshotsPerDisplay.push({
        displayId,
        screenshotOriginalBase64: originalScreenshotBase64,
        screenshotAnnotatedBase64: annotation.screenshotAnnotatedBase64,
        strokes: annotation.strokes,
      })
    }

    const primaryDisplayId = String(screen.getPrimaryDisplay().id)
    const primaryScreenshot = screenshotsPerDisplay.find(
      screenshot => screenshot.displayId === primaryDisplayId
    )

    const finalPayload: SessionPayload = {
      sessionId: this.currentSessionId!,
      timestamp: this.sessionStartedAt,
      durationMs: Date.now() - this.sessionStartedAt,
      strokes: allStrokes,
      monitors: this.screenCapture.getAllMonitorInfo(),
      // Primary display fields kept for backward compatibility
      screenshotOriginalBase64: primaryScreenshot?.screenshotOriginalBase64 ?? '',
      screenshotAnnotatedBase64: primaryScreenshot?.screenshotAnnotatedBase64 ?? '',
      screenshotsPerDisplay,
    }

    console.log(
      `[SessionManager] payload assembled — ${allStrokes.length} strokes across ` +
      `${screenshotsPerDisplay.length} displays, ${finalPayload.durationMs}ms duration`
    )

    this.pendingAnnotations.clear()
    this.pendingScreenshotsPerDisplay.clear()
    this.transitionTo(SESSION_STATE.IDLE)
    this.currentSessionId = null

    // Payload goes to NotchWindow renderer (the UI that handles AI responses)
    this.sendToNotch(IPC_CHANNELS.SESSION_PAYLOAD_READY, finalPayload)
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  private transitionTo(newState: SessionState): void {
    console.log(`[SessionManager] state: ${this.currentState} → ${newState}`)
    this.currentState = newState

    // Broadcast session state to ALL renderers (overlays need it for drawing, notch for audio/UI)
    this.overlayManager?.broadcastToAllOverlays(IPC_CHANNELS.SESSION_STATE_CHANGED, newState)
    this.sendToNotch(IPC_CHANNELS.SESSION_STATE_CHANGED, newState)
  }

  private sendToNotch(channel: string, payload?: unknown): void {
    const notchWebContents = this.notchManager?.getWebContents()
    if (notchWebContents === null || notchWebContents === undefined) return
    if (notchWebContents.isDestroyed()) return
    notchWebContents.send(channel, payload)
  }

  private resetSessionMouseThrottle(): void {
    this.lastSessionMouseSentAt = 0
    this.lastSessionMouseRelX = -1
    this.lastSessionMouseRelY = -1
  }
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function sleep(durationMs: number): Promise<void> {
  return new Promise<void>(resolve => setTimeout(resolve, durationMs))
}
