// ─── Session State Machine ────────────────────────────────────────────────────

export const SESSION_STATE = {
  IDLE: 'IDLE',
  RECORDING_AND_TRACKING: 'RECORDING_AND_TRACKING',
  FINALIZING: 'FINALIZING',
  PROCESSING: 'PROCESSING',
} as const

export type SessionState = (typeof SESSION_STATE)[keyof typeof SESSION_STATE]

// ─── Notch Window State ───────────────────────────────────────────────────────

export const NOTCH_STATE = {
  COLLAPSED: 'COLLAPSED',  // thin bar 40×4, cursor far away
  PROXIMITY: 'PROXIMITY',  // medium pill 80×18, cursor within ~40px of top
  EXPANDED: 'EXPANDED',    // full card 440×140, cursor inside pill
} as const

export type NotchState = (typeof NOTCH_STATE)[keyof typeof NOTCH_STATE]

// ─── Stroke Data ─────────────────────────────────────────────────────────────

export type StrokePoint = {
  x: number
  y: number
  timestamp: number
}

// A single continuous mouse path drawn during one session.
// A new stroke begins when the cursor pauses for more than STROKE_GAP_THRESHOLD_MS.
export type Stroke = {
  strokeId: string
  sessionId: string
  points: StrokePoint[]
  startedAt: number
  endedAt: number
}

// ─── Monitor Metadata ─────────────────────────────────────────────────────────

export type MonitorBounds = {
  x: number
  y: number
  width: number
  height: number
}

export type MonitorInfo = {
  monitorId: string
  bounds: MonitorBounds
  workAreaBounds: MonitorBounds
  scaleFactor: number
  isPrimary: boolean
}

// ─── Multi-Display Screenshot ─────────────────────────────────────────────────

// Per-display screenshot assembled after the annotation phase.
// displayId matches String(Electron.Display.id).
export type DisplayScreenshot = {
  displayId: string
  screenshotOriginalBase64: string
  screenshotAnnotatedBase64: string
  strokes: Stroke[]
}

// ─── Global Mouse Payload ─────────────────────────────────────────────────────

// Sent from main to ALL DisplayOverlay renderers on every throttled mouse move.
// Used by CursorFollower to position the Red Orb on the correct display.
//
// Coordinate notes:
//   dipX/dipY: global DIP coordinates (Electron screen API space).
//   displayRelX/Y: DIP coords minus the display's DIP origin.
//     Maps directly to CSS pixel offsets within the overlay window that covers displayId.
//   displayId: String(Electron.Display.id) of the display the cursor is on.
export type GlobalMousePayload = {
  dipX: number
  dipY: number
  displayId: string
  displayRelX: number  // = dipX - display.bounds.x
  displayRelY: number  // = dipY - display.bounds.y
}

// ─── Session Payload (assembled after session ends) ───────────────────────────

// Complete context object for a Bedrock multimodal request.
// screenshotOriginalBase64 and screenshotAnnotatedBase64 are from the primary display
// for backward compatibility. Full per-display data is in screenshotsPerDisplay.
export type SessionPayload = {
  sessionId: string
  timestamp: number
  durationMs: number
  strokes: Stroke[]              // all strokes from all displays combined
  monitors: MonitorInfo[]
  screenshotOriginalBase64: string    // primary display (backward compat)
  screenshotAnnotatedBase64: string   // primary display annotated (backward compat)
  screenshotsPerDisplay: DisplayScreenshot[]  // all displays
}

// ─── IPC Payloads ────────────────────────────────────────────────────────────

// Session-scoped mouse point: sent for each throttled move during a session.
// x/y are display-relative DIP coordinates for CSS rendering on that display.
// globalX/globalY are absolute DIP for reference or Notch proximity checks.
export type MousePointPayload = {
  x: number           // display-relative DIP X → CSS pixel X in the overlay
  y: number           // display-relative DIP Y → CSS pixel Y in the overlay
  globalX: number     // global DIP X
  globalY: number     // global DIP Y
  timestamp: number
  sessionId: string
  displayId: string   // String(Electron.Display.id) of the display
}

// Sent from main to a specific display's overlay when the session ends and
// the screenshot for that display is ready for annotation.
export type FinalizeSessionPayload = {
  sessionId: string
  screenshotOriginalBase64: string  // original screenshot for THIS display
  displayId: string                  // which display this finalize is for
  monitors: MonitorInfo[]
  startedAt: number
}

// Sent from a DisplayOverlay renderer to main after it finishes annotating.
// displayId identifies which overlay is responding (required for aggregation).
export type AnnotatedScreenshotPayload = {
  sessionId: string
  displayId: string              // which overlay sent this
  screenshotAnnotatedBase64: string
  strokes: Stroke[]
}
