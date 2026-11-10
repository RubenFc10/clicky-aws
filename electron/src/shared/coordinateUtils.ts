// Coordinate systems used in this codebase:
//
// DIP (Device-Independent Pixels): canonical coordinate space for all logic here.
//   screen.getCursorScreenPoint(), display.bounds, getDisplayNearestPoint()
//   and BrowserWindow.getBounds() (Electron 23+) all use DIP.
//   SessionManager uses getCursorScreenPoint() as the authoritative DIP source
//   for mouse position — uiohook events are trigger-only.
//
//   On Windows with per-monitor DPI awareness v2 (Electron's default), WH_MOUSE_LL
//   (uiohook) may report coordinates in a different scale than Electron's DIP space
//   on non-100%-DPI or portrait monitors. getCursorScreenPoint() is always correct.
//
// DISPLAY-RELATIVE DIP: global DIP minus the display's DIP origin.
//   Used for CSS pixel positioning within a DisplayOverlay.
//   Each overlay window is positioned at display.bounds.{x,y}, so
//   display-relative coords map directly to CSS pixel offsets within the window.
//   Can be negative if the display origin itself is negative (left of primary).
//
// SCREENSHOT PIXELS: physical resolution of the image returned by desktopCapturer.
//   May differ from CSS * devicePixelRatio on portrait monitors.
//   Always use computeAnnotationScale(img.naturalWidth, img.naturalHeight, innerW, innerH)
//   to map CSS stroke coordinates to screenshot pixel coordinates.

export type Bounds = { x: number; y: number; width: number; height: number }
export type Point = { x: number; y: number }

// Computes per-axis scale factors to map CSS-pixel stroke coordinates to screenshot pixel
// coordinates. Uses actual image dimensions rather than assuming screenshot = CSS * dpr.
//
// For portrait monitors, desktopCapturer may return an image sized differently from
// window.innerWidth/Height * devicePixelRatio — using img.naturalWidth/Height is the
// only reliable source of truth.
//
//   imageX = cssX * (imagePixelWidth  / overlayCssWidth)
//   imageY = cssY * (imagePixelHeight / overlayCssHeight)
export function computeAnnotationScale(
  imagePixelWidth: number,
  imagePixelHeight: number,
  overlayCssWidth: number,
  overlayCssHeight: number
): Point {
  return {
    x: imagePixelWidth  / overlayCssWidth,
    y: imagePixelHeight / overlayCssHeight,
  }
}

// Convert global DIP coordinates to display-relative DIP coordinates.
// The result maps directly to CSS pixel positions within the DisplayOverlay
// window that covers the given display.
export function dipToDisplayRelative(
  globalDipX: number,
  globalDipY: number,
  displayBounds: Bounds
): Point {
  return {
    x: globalDipX - displayBounds.x,
    y: globalDipY - displayBounds.y,
  }
}

// Returns true if the DIP point falls within the display bounds.
// Uses half-open interval [x, x+width) to avoid double-counting at shared edges.
export function isPointWithinDisplay(
  dipX: number,
  dipY: number,
  displayBounds: Bounds
): boolean {
  return (
    dipX >= displayBounds.x &&
    dipX < displayBounds.x + displayBounds.width &&
    dipY >= displayBounds.y &&
    dipY < displayBounds.y + displayBounds.height
  )
}

// Returns true if the DIP point is within the proximity zone around a window.
// The zone extends proximityPx pixels beyond every edge of the window bounds.
// Used for NotchWindow hover detection: cursor approaching from any direction.
export function isPointNearWindow(
  dipX: number,
  dipY: number,
  windowBounds: Bounds,
  proximityPx: number
): boolean {
  return (
    dipX >= windowBounds.x - proximityPx &&
    dipX <= windowBounds.x + windowBounds.width + proximityPx &&
    dipY >= windowBounds.y - proximityPx &&
    dipY <= windowBounds.y + windowBounds.height + proximityPx
  )
}
