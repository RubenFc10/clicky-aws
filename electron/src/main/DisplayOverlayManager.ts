import { BrowserWindow, screen } from 'electron'
import { join } from 'path'
import type { Display } from 'electron'
import { IPC_CHANNELS } from '../shared/ipcTypes'
import type { GlobalMousePayload } from '../shared/sessionTypes'

// Pairs a BrowserWindow with the Electron display ID it covers.
type OverlayEntry = {
  displayId: string   // String(Electron.Display.id)
  window: BrowserWindow
}

// ─── DisplayOverlayManager ────────────────────────────────────────────────────

export class DisplayOverlayManager {
  private overlayEntries: OverlayEntry[] = []

  // Creates one full-screen click-through overlay for every connected display.
  // Also hooks into display hot-plug events to add/remove overlays dynamically.
  // Must be called AFTER NotchWindowManager.createWindow() so overlays are topmost in z-stack.
  createOverlaysForAllDisplays(): void {
    for (const display of screen.getAllDisplays()) {
      this.createOverlayForDisplay(display)
    }

    screen.on('display-added', (_event, addedDisplay) => {
      console.log(`[DisplayOverlayManager] display added: id=${addedDisplay.id}`)
      this.createOverlayForDisplay(addedDisplay)
    })

    screen.on('display-removed', (_event, removedDisplay) => {
      const removedId = String(removedDisplay.id)
      console.log(`[DisplayOverlayManager] display removed: id=${removedId}`)
      const entryIndex = this.overlayEntries.findIndex(entry => entry.displayId === removedId)
      if (entryIndex !== -1) {
        const entry = this.overlayEntries[entryIndex]
        if (!entry.window.isDestroyed()) entry.window.close()
        this.overlayEntries.splice(entryIndex, 1)
      }
    })

    screen.on('display-metrics-changed', (_event, changedDisplay) => {
      const changedId = String(changedDisplay.id)
      console.log(`[DisplayOverlayManager] display metrics changed: id=${changedId}`)
      const entry = this.overlayEntries.find(entry => entry.displayId === changedId)
      if (entry === undefined || entry.window.isDestroyed()) return
      entry.window.setBounds({
        x: changedDisplay.bounds.x,
        y: changedDisplay.bounds.y,
        width: changedDisplay.bounds.width,
        height: changedDisplay.bounds.height,
      })
    })
  }

  // Sends a cursor-position update to all overlay windows (~60fps via RAF in renderer).
  broadcastCursorMove(cursorPayload: GlobalMousePayload): void {
    for (const entry of this.overlayEntries) {
      if (entry.window.isDestroyed()) continue
      entry.window.webContents.send(IPC_CHANNELS.CURSOR_GLOBAL_MOVE, cursorPayload)
    }
  }

  // Sends a message to a specific display's overlay (e.g., SESSION_FINALIZE for annotation).
  sendToDisplay(displayId: string, channel: string, payload: unknown): void {
    const entry = this.overlayEntries.find(e => e.displayId === displayId)
    if (entry === undefined || entry.window.isDestroyed()) {
      console.warn(`[DisplayOverlayManager] sendToDisplay: no active overlay for displayId=${displayId}`)
      return
    }
    entry.window.webContents.send(channel, payload)
  }

  // Sends a message to ALL overlay windows (e.g., SESSION_STATE_CHANGED, SESSION_CANCELLED).
  broadcastToAllOverlays(channel: string, payload?: unknown): void {
    for (const entry of this.overlayEntries) {
      if (entry.window.isDestroyed()) continue
      entry.window.webContents.send(channel, payload)
    }
  }

  // Returns the display IDs of currently active (non-destroyed) overlays.
  // Used by SessionManager to know which overlays to send SESSION_FINALIZE to.
  getActiveDisplayIds(): string[] {
    return this.overlayEntries
      .filter(entry => !entry.window.isDestroyed())
      .map(entry => entry.displayId)
  }

  // Hides all overlays before screenshot capture so the UI doesn't appear in screenshots.
  hideAllForCapture(): void {
    for (const entry of this.overlayEntries) {
      if (!entry.window.isDestroyed()) entry.window.hide()
    }
  }

  // Restores overlay visibility after screenshot capture completes.
  showAllAfterCapture(): void {
    for (const entry of this.overlayEntries) {
      if (!entry.window.isDestroyed()) entry.window.show()
    }
  }

  destroyAll(): void {
    screen.removeAllListeners('display-added')
    screen.removeAllListeners('display-removed')
    screen.removeAllListeners('display-metrics-changed')
    for (const entry of this.overlayEntries) {
      if (!entry.window.isDestroyed()) entry.window.close()
    }
    this.overlayEntries = []
  }

  // ─── Private ─────────────────────────────────────────────────────────────────

  private createOverlayForDisplay(display: Display): void {
    const { x, y, width, height } = display.bounds
    const displayId = String(display.id)

    const overlayWindow = new BrowserWindow({
      x,
      y,
      width,
      height,
      // Overlays are transparent click-through windows — there is no visible content
      // to flash before the renderer is ready, so show:true is safe and preferable.
      // With show:false, Chromium initialises the renderer's CSS viewport from the
      // PRIMARY display's workArea height (e.g. 1392 on the Xiaomi) even for overlay
      // windows that live on other displays. With show:true, the HWND is live and
      // visible from creation so Chromium derives the viewport from the actual window
      // bounds of the display it covers (1440 or 2560 for Samsung portrait).
      show: true,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      // Overlays are created AFTER NotchWindow — this creation order means they sit
      // topmost in z-stack within the same alwaysOnTop level on Windows.
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    })

    overlayWindow.setAlwaysOnTop(true, 'screen-saver')
    // Overlays are always click-through — only the cursor orb renders here, no interactive UI
    overlayWindow.setIgnoreMouseEvents(true, { forward: true })

    // Forward [renderer-diag] messages from this overlay's renderer to the main-process
    // console so they appear alongside [overlay-diag] and [coord-diagnostic] logs without
    // needing to open DevTools for each individual overlay window.
    // Registered before loadURL/loadFile so no messages are missed during page load.
    overlayWindow.webContents.on('console-message', (_event, _level, message) => {
      if (message.startsWith('[renderer-diag]')) {
        console.log(`[renderer-diag→main displayId=${displayId}]`, message)
      }
    })

    overlayWindow.on('ready-to-show', () => {
      // Diagnostic: compare display.bounds (DIP from Electron screen API) against the
      // window's actual getBounds() (also DIP). A mismatch here indicates Electron placed
      // the overlay at the wrong position for this display. Cross-reference against
      // [coord-diagnostic] in SessionManager and [renderer-diag] in CursorFollower.
      const actual = overlayWindow.getBounds()
      console.log(
        `[overlay-diag] displayId=${displayId}`,
        `display.bounds=${display.bounds.x},${display.bounds.y} ${display.bounds.width}×${display.bounds.height}`,
        `rotation=${display.rotation}`,
        `scaleFactor=${display.scaleFactor}`,
        `overlay.getBounds=${actual.x},${actual.y} ${actual.width}×${actual.height}`
      )
      // Window was created with show:true so it is already visible — no show() call needed.
    })

    overlayWindow.on('closed', () => {
      const index = this.overlayEntries.findIndex(e => e.displayId === displayId)
      if (index !== -1) this.overlayEntries.splice(index, 1)
    })

    // Pass displayId as a query parameter so the renderer knows which display it covers.
    // The renderer reads it via: new URLSearchParams(window.location.search).get('displayId')
    const displayIdParam = encodeURIComponent(displayId)
    if (process.env['ELECTRON_RENDERER_URL']) {
      overlayWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?displayId=${displayIdParam}`)
    } else {
      overlayWindow.loadFile(join(__dirname, '../renderer/index.html'), {
        query: { displayId: displayId },
      })
    }

    this.overlayEntries.push({ displayId, window: overlayWindow })
    console.log(`[DisplayOverlayManager] overlay created for displayId=${displayId} at ${x},${y} ${width}×${height}`)
  }
}
