import { app, ipcMain, screen } from 'electron'
import { IPC_CHANNELS } from '../shared/ipcTypes'
import { SessionManager } from './SessionManager'
import { NotchWindowManager } from './NotchWindowManager'
import { DisplayOverlayManager } from './DisplayOverlayManager'
import type { AnnotatedScreenshotPayload } from '../shared/sessionTypes'

// ─── Singletons ───────────────────────────────────────────────────────────────

const sessionManager    = new SessionManager()
const notchManager      = new NotchWindowManager()
const overlayManager    = new DisplayOverlayManager()

// ─── App lifecycle ────────────────────────────────────────────────────────────

// Logs all connected displays with their DIP bounds, rotation, scaleFactor, and primary flag.
// Called once at startup to assist with coordinate debugging on multi-monitor setups.
// Check these logs when diagnosing portrait/landscape DPI coordinate issues.
function logAllDisplayInfo(): void {
  const allDisplays = screen.getAllDisplays()
  console.log(`[main] connected displays: ${allDisplays.length}`)
  for (const display of allDisplays) {
    console.log(
      `[main] display id=${display.id}`,
      `label="${display.label}"`,
      `bounds=${display.bounds.x},${display.bounds.y} ${display.bounds.width}×${display.bounds.height}`,
      `scaleFactor=${display.scaleFactor}`,
      `rotation=${display.rotation}`,
      `primary=${display.id === screen.getPrimaryDisplay().id}`,
      `workArea=${display.workArea.x},${display.workArea.y} ${display.workArea.width}×${display.workArea.height}`
    )
  }
}

app.whenReady().then(() => {
  logAllDisplayInfo()

  // Create NotchWindow FIRST so it sits below DisplayOverlays in the z-stack.
  // On Windows, creation order determines z-order within the same alwaysOnTop level.
  notchManager.createWindow()

  // Create one click-through overlay per connected display (created AFTER notch → topmost)
  overlayManager.createOverlaysForAllDisplays()

  // Wire managers into SessionManager now that BrowserWindows exist
  sessionManager.setManagerReferences(notchManager, overlayManager)
  sessionManager.start()

  app.on('activate', () => {
    // macOS: re-create windows if all were closed (Dock icon click)
    // For this overlay app the Notch window is the primary window
    // This path is unlikely on Windows but kept for cross-platform compatibility
    console.log('[main] app activated')
  })
})

app.on('window-all-closed', () => {
  sessionManager.stop()
  overlayManager.destroyAll()
  notchManager.destroy()
  if (process.platform !== 'darwin') app.quit()
})

// ─── IPC Handlers ────────────────────────────────────────────────────────────

// A DisplayOverlay renderer has annotated its screenshot — accumulate and check for completion
ipcMain.on(IPC_CHANNELS.SESSION_ANNOTATION_READY, (_event, annotationPayload: AnnotatedScreenshotPayload) => {
  sessionManager.handleAnnotationReady(annotationPayload)
})

// Renderer requests a session cancel (e.g. ESC key in a focused input)
ipcMain.on(IPC_CHANNELS.SESSION_CANCEL_REQUEST, () => {
  sessionManager.cancelSession()
})

// Bedrock stub (future phase)
ipcMain.handle(IPC_CHANNELS.BEDROCK_CHAT, async (_event, userMessage: string) => {
  console.log('[main] bedrock:chat received:', userMessage)
  return 'Bedrock integration not yet wired up.'
})

ipcMain.handle(IPC_CHANNELS.GET_PLATFORM, () => process.platform)
