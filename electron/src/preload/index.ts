import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS, type ClickyElectronAPI } from '../shared/ipcTypes'
import type {
  SessionState,
  NotchState,
  MousePointPayload,
  GlobalMousePayload,
  FinalizeSessionPayload,
  AnnotatedScreenshotPayload,
  SessionPayload,
} from '../shared/sessionTypes'

// Helper: register a one-way main→renderer listener and return a cleanup function.
// Using a factory avoids duplicating the addListener/removeListener pattern for every channel.
function makeMainToRendererListener<T>(
  channel: string,
  callback: (data: T) => void
): () => void {
  const listener = (_event: Electron.IpcRendererEvent, data: T): void => callback(data)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

// ─── Bridge ───────────────────────────────────────────────────────────────────

const clickyElectronAPI: ClickyElectronAPI = {
  // ── App info ──
  getPlatform: () => process.platform,

  // ── Bedrock stub ──
  invokeBedrockChat: (userMessage: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.BEDROCK_CHAT, userMessage),

  onBedrockStreamChunk: (callback: (chunk: string) => void) =>
    makeMainToRendererListener<string>(IPC_CHANNELS.BEDROCK_STREAM_CHUNK, callback),

  // ── Cursor: main → all overlay renderers ──
  onCursorGlobalMove: (callback: (payload: GlobalMousePayload) => void) =>
    makeMainToRendererListener<GlobalMousePayload>(IPC_CHANNELS.CURSOR_GLOBAL_MOVE, callback),

  // ── Notch state: bidirectional ──
  onNotchStateChanged: (callback: (state: NotchState) => void) =>
    makeMainToRendererListener<NotchState>(IPC_CHANNELS.NOTCH_STATE_CHANGED, callback),

  requestNotchState: (requestedState: NotchState) => {
    ipcRenderer.send(IPC_CHANNELS.NOTCH_STATE_REQUEST, requestedState)
  },

  // ── Session: main → renderer listeners ──
  onSessionStateChanged: (callback: (state: SessionState) => void) =>
    makeMainToRendererListener<SessionState>(IPC_CHANNELS.SESSION_STATE_CHANGED, callback),

  onSessionMousePoint: (callback: (point: MousePointPayload) => void) =>
    makeMainToRendererListener<MousePointPayload>(IPC_CHANNELS.SESSION_MOUSE_POINT, callback),

  onSessionFinalize: (callback: (payload: FinalizeSessionPayload) => void) =>
    makeMainToRendererListener<FinalizeSessionPayload>(IPC_CHANNELS.SESSION_FINALIZE, callback),

  onSessionCancelled: (callback: () => void) =>
    makeMainToRendererListener<void>(IPC_CHANNELS.SESSION_CANCELLED, callback),

  onSessionPayloadReady: (callback: (payload: SessionPayload) => void) =>
    makeMainToRendererListener<SessionPayload>(IPC_CHANNELS.SESSION_PAYLOAD_READY, callback),

  // ── Session: renderer → main (fire-and-forget) ──
  submitSessionAnnotation: (annotationPayload: AnnotatedScreenshotPayload) => {
    ipcRenderer.send(IPC_CHANNELS.SESSION_ANNOTATION_READY, annotationPayload)
  },

  cancelSession: () => {
    ipcRenderer.send(IPC_CHANNELS.SESSION_CANCEL_REQUEST)
  },
}

contextBridge.exposeInMainWorld('electronAPI', clickyElectronAPI)
