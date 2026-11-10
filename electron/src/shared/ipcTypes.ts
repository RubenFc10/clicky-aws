import type {
  SessionState,
  NotchState,
  MousePointPayload,
  GlobalMousePayload,
  FinalizeSessionPayload,
  AnnotatedScreenshotPayload,
  SessionPayload,
} from './sessionTypes'

// ─── IPC Channel Registry ─────────────────────────────────────────────────────
// All channel names in one place to prevent string typos across main/preload/renderer.

export const IPC_CHANNELS = {
  // ── Bedrock (future) ──
  BEDROCK_CHAT: 'bedrock:chat',
  BEDROCK_STREAM_CHUNK: 'bedrock:stream-chunk',
  BEDROCK_STREAM_END: 'bedrock:stream-end',

  // ── App info ──
  GET_PLATFORM: 'app:get-platform',

  // ── Cursor: main → all overlay renderers (always-on, 60fps) ──
  CURSOR_GLOBAL_MOVE: 'cursor:global-move',  // GlobalMousePayload

  // ── Notch window state: bidirectional ──
  NOTCH_STATE_CHANGED: 'notch:state-changed',  // main → notch renderer: NotchState
  NOTCH_STATE_REQUEST: 'notch:state-request',  // notch renderer → main: NotchState

  // ── Session lifecycle: main → renderer (one-way) ──
  SESSION_STATE_CHANGED: 'session:state-changed',   // SessionState
  SESSION_MOUSE_POINT: 'session:mouse-point',        // MousePointPayload (session only)
  SESSION_FINALIZE: 'session:finalize',              // FinalizeSessionPayload (per display)
  SESSION_CANCELLED: 'session:cancelled',            // void

  // ── Session lifecycle: renderer → main (one-way) ──
  SESSION_ANNOTATION_READY: 'session:annotation-ready',  // AnnotatedScreenshotPayload
  SESSION_CANCEL_REQUEST: 'session:cancel-request',       // void (ESC in renderer)

  // ── Session result: main → notch renderer ──
  SESSION_PAYLOAD_READY: 'session:payload-ready',  // SessionPayload
} as const

// ─── Bridge API Type ──────────────────────────────────────────────────────────
// Everything exposed on window.electronAPI via contextBridge.

export type ClickyElectronAPI = {
  // ── App info ──
  getPlatform: () => NodeJS.Platform

  // ── Bedrock (stub) ──
  invokeBedrockChat: (userMessage: string) => Promise<string>
  onBedrockStreamChunk: (callback: (chunk: string) => void) => () => void

  // ── Cursor: main → overlay renderers ──
  onCursorGlobalMove: (callback: (payload: GlobalMousePayload) => void) => () => void

  // ── Notch: bidirectional ──
  onNotchStateChanged: (callback: (state: NotchState) => void) => () => void
  requestNotchState: (state: NotchState) => void

  // ── Session: main → renderer listeners (each returns a cleanup fn) ──
  onSessionStateChanged: (callback: (state: SessionState) => void) => () => void
  onSessionMousePoint: (callback: (point: MousePointPayload) => void) => () => void
  onSessionFinalize: (callback: (payload: FinalizeSessionPayload) => void) => () => void
  onSessionCancelled: (callback: () => void) => () => void
  onSessionPayloadReady: (callback: (payload: SessionPayload) => void) => () => void

  // ── Session: renderer → main (fire-and-forget) ──
  submitSessionAnnotation: (payload: AnnotatedScreenshotPayload) => void
  cancelSession: () => void
}

// Extend the global Window type so renderer code gets full autocomplete.
declare global {
  interface Window {
    electronAPI: ClickyElectronAPI
  }
}
