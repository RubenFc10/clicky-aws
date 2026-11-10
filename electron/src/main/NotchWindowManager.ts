import { BrowserWindow, screen, ipcMain } from 'electron'
import { join } from 'path'
import type { Rectangle, WebContents } from 'electron'
import { IPC_CHANNELS } from '../shared/ipcTypes'
import { NOTCH_STATE } from '../shared/sessionTypes'
import type { NotchState } from '../shared/sessionTypes'
import { isPointNearWindow } from '../shared/coordinateUtils'
import type { Bounds } from '../shared/coordinateUtils'

// ─── Notch Dimensions (DIP pixels) ───────────────────────────────────────────

const NOTCH_COLLAPSED_WIDTH  = 40
const NOTCH_COLLAPSED_HEIGHT = 4
// Compact pill matches dynamicnotch base dimensions: 190×38
const NOTCH_PROXIMITY_WIDTH  = 190
const NOTCH_PROXIMITY_HEIGHT = 38
const NOTCH_EXPANDED_WIDTH   = 440
// Taller expanded card to accommodate the reference-matched three-row layout
const NOTCH_EXPANDED_HEIGHT  = 240

// Pixels from the notch bounds at which we enter PROXIMITY state
const PROXIMITY_THRESHOLD_PX = 40

// Milliseconds to wait after CSS collapse animation before resizing window.
// On Windows, setBounds() clips any ongoing CSS animation, so we let the
// animation finish first (300ms matches the spring collapse animation duration).
const COLLAPSE_RESIZE_DELAY_MS = 300

// ─── NotchWindowManager ───────────────────────────────────────────────────────

export class NotchWindowManager {
  private notchWindow: BrowserWindow | null = null
  // Default is PROXIMITY — the compact pill is always visible (never fully collapsed).
  // COLLAPSED is only used during screen capture to hide the window temporarily.
  private currentNotchState: NotchState = NOTCH_STATE.PROXIMITY
  // Timer that fires resize AFTER the CSS collapse animation completes
  private collapseResizeTimer: ReturnType<typeof setTimeout> | null = null
  private hiddenForCapture = false

  constructor() {
    // Register IPC handler in constructor (once per manager instance)
    // so the renderer can request state changes (e.g., on mouse enter/leave)
    ipcMain.on(IPC_CHANNELS.NOTCH_STATE_REQUEST, (_event, requestedState: NotchState) => {
      this.transitionToState(requestedState)
    })
  }

  createWindow(): void {
    const primaryDisplay = screen.getPrimaryDisplay()
    // Start at PROXIMITY size — the compact pill is always visible from launch.
    const initialBounds = this.computeGlobalNotchBounds(NOTCH_STATE.PROXIMITY, primaryDisplay.bounds)

    this.notchWindow = new BrowserWindow({
      ...initialBounds,
      show: false,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      // NotchWindow is created BEFORE DisplayOverlays so overlays are topmost in z-stack.
      // On Windows, creation order determines z-order within the same alwaysOnTop level.
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    })

    // Apply screen-saver level AFTER creation (alwaysOnTop flag alone is insufficient on Windows)
    this.notchWindow.setAlwaysOnTop(true, 'screen-saver')

    // PROXIMITY state: interactive from start — the pill receives hover events
    this.notchWindow.setIgnoreMouseEvents(false)

    this.notchWindow.on('ready-to-show', () => {
      this.notchWindow!.show()
    })

    this.notchWindow.on('closed', () => {
      this.notchWindow = null
    })

    if (process.env['ELECTRON_RENDERER_URL']) {
      this.notchWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/notch.html`)
    } else {
      this.notchWindow.loadFile(join(__dirname, '../renderer/notch.html'))
    }
  }

  // Called on EVERY global mouse move (not just during sessions) for hover detection.
  // The notch has two visible states: PROXIMITY (compact pill, always shown) and
  // EXPANDED (full card on hover). COLLAPSED is never entered during normal use —
  // the compact pill stays visible at all times, just like dynamicnotch.
  evaluateHoverProximity(globalDipX: number, globalDipY: number): void {
    if (this.notchWindow === null) return

    const primaryDisplay = screen.getPrimaryDisplay()

    // All hover math is in primary-display-relative DIP coords.
    const cursorRelToPrimaryX = globalDipX - primaryDisplay.bounds.x
    const cursorRelToPrimaryY = globalDipY - primaryDisplay.bounds.y

    const proximityLocal = this.computeLocalNotchBounds(NOTCH_STATE.PROXIMITY, primaryDisplay.bounds.width)
    const expandedLocal  = this.computeLocalNotchBounds(NOTCH_STATE.EXPANDED,  primaryDisplay.bounds.width)

    if (this.currentNotchState === NOTCH_STATE.PROXIMITY) {
      // Cursor entered the compact pill → expand
      if (isPointNearWindow(cursorRelToPrimaryX, cursorRelToPrimaryY, proximityLocal, 0)) {
        this.transitionToState(NOTCH_STATE.EXPANDED)
      }
    } else if (this.currentNotchState === NOTCH_STATE.EXPANDED) {
      // Cursor left the expanded card → collapse back to compact pill
      if (!isPointNearWindow(cursorRelToPrimaryX, cursorRelToPrimaryY, expandedLocal, 0)) {
        this.transitionToState(NOTCH_STATE.PROXIMITY)
      }
    }
    // COLLAPSED is handled only by hideForCapture/showAfterCapture — not reachable via mouse.
  }

  hideForCapture(): void {
    if (this.notchWindow === null || this.hiddenForCapture) return
    this.hiddenForCapture = true
    // Transition to COLLAPSED and hide the window so it doesn't appear in screenshots.
    // After capture, showAfterCapture() restores the compact pill (PROXIMITY).
    this.currentNotchState = NOTCH_STATE.COLLAPSED
    this.notchWindow.webContents.send(IPC_CHANNELS.NOTCH_STATE_CHANGED, NOTCH_STATE.COLLAPSED)
    this.notchWindow.hide()
  }

  showAfterCapture(): void {
    if (this.notchWindow === null || !this.hiddenForCapture) return
    this.hiddenForCapture = false
    // Restore the compact pill — the minimum visible state
    this.currentNotchState = NOTCH_STATE.PROXIMITY
    const primaryDisplay = screen.getPrimaryDisplay()
    this.notchWindow.setBounds(this.computeGlobalNotchBounds(NOTCH_STATE.PROXIMITY, primaryDisplay.bounds))
    this.notchWindow.webContents.send(IPC_CHANNELS.NOTCH_STATE_CHANGED, NOTCH_STATE.PROXIMITY)
    this.notchWindow.show()
  }

  getWebContents(): WebContents | null {
    if (this.notchWindow === null || this.notchWindow.isDestroyed()) return null
    return this.notchWindow.webContents
  }

  destroy(): void {
    ipcMain.removeAllListeners(IPC_CHANNELS.NOTCH_STATE_REQUEST)
    if (this.collapseResizeTimer !== null) {
      clearTimeout(this.collapseResizeTimer)
      this.collapseResizeTimer = null
    }
    if (this.notchWindow !== null && !this.notchWindow.isDestroyed()) {
      this.notchWindow.close()
    }
    this.notchWindow = null
  }

  // ─── Private state transition logic ──────────────────────────────────────────

  private transitionToState(newState: NotchState): void {
    if (this.currentNotchState === newState) return
    if (this.notchWindow === null || this.notchWindow.isDestroyed()) return

    console.log(`[NotchWindowManager] state: ${this.currentNotchState} → ${newState}`)

    const previousState = this.currentNotchState
    this.currentNotchState = newState

    const primaryDisplay = screen.getPrimaryDisplay()

    // Notify renderer first so CSS animation starts simultaneously with the resize
    this.notchWindow.webContents.send(IPC_CHANNELS.NOTCH_STATE_CHANGED, newState)

    // Cancel any pending collapse resize timer when transitioning away from an in-progress collapse
    if (this.collapseResizeTimer !== null) {
      clearTimeout(this.collapseResizeTimer)
      this.collapseResizeTimer = null
    }

    // EXPANDED→PROXIMITY is a collapse: delay setBounds so the CSS spring animation
    // plays before the window shrinks and clips the content.
    // All other transitions (PROXIMITY→EXPANDED) are expansions: resize immediately
    // so the window is large enough for content to animate into.
    const isCollapsing = previousState === NOTCH_STATE.EXPANDED && newState === NOTCH_STATE.PROXIMITY

    if (isCollapsing) {
      this.collapseResizeTimer = setTimeout(() => {
        if (this.notchWindow === null || this.notchWindow.isDestroyed()) return
        const newBounds = this.computeGlobalNotchBounds(newState, primaryDisplay.bounds)
        this.notchWindow.setBounds(newBounds)
        this.collapseResizeTimer = null
      }, COLLAPSE_RESIZE_DELAY_MS)
    } else {
      const newBounds = this.computeGlobalNotchBounds(newState, primaryDisplay.bounds)
      this.notchWindow.setBounds(newBounds)
    }

    // The notch is always interactive (never click-through in normal operation).
    // COLLAPSED is only used by hideForCapture which calls hide() directly, not setIgnoreMouseEvents.
    this.notchWindow.setIgnoreMouseEvents(false)
  }

  // Returns absolute global DIP bounds for the notch given a state.
  // Anchored to the top-center of the primary display.
  private computeGlobalNotchBounds(state: NotchState, primaryDisplayBounds: Rectangle): Rectangle {
    const localBounds = this.computeLocalNotchBounds(state, primaryDisplayBounds.width)
    return {
      x: primaryDisplayBounds.x + localBounds.x,
      y: primaryDisplayBounds.y + localBounds.y,
      width: localBounds.width,
      height: localBounds.height,
    }
  }

  // Returns primary-display-relative DIP bounds for the notch given a state.
  // These are used for proximity math (cursor coords are also made primary-relative).
  private computeLocalNotchBounds(state: NotchState, primaryDisplayWidth: number): Bounds {
    switch (state) {
      case NOTCH_STATE.COLLAPSED:
        return {
          x: Math.round((primaryDisplayWidth - NOTCH_COLLAPSED_WIDTH) / 2),
          y: 0,
          width: NOTCH_COLLAPSED_WIDTH,
          height: NOTCH_COLLAPSED_HEIGHT,
        }
      case NOTCH_STATE.PROXIMITY:
        return {
          x: Math.round((primaryDisplayWidth - NOTCH_PROXIMITY_WIDTH) / 2),
          y: 0,
          width: NOTCH_PROXIMITY_WIDTH,
          height: NOTCH_PROXIMITY_HEIGHT,
        }
      case NOTCH_STATE.EXPANDED:
        return {
          x: Math.round((primaryDisplayWidth - NOTCH_EXPANDED_WIDTH) / 2),
          y: 0,
          width: NOTCH_EXPANDED_WIDTH,
          height: NOTCH_EXPANDED_HEIGHT,
        }
    }
  }
}
