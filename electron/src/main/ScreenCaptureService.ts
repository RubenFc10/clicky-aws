import { desktopCapturer, screen } from 'electron'
import type { MonitorInfo } from '../shared/sessionTypes'

// ─── ScreenCaptureService ─────────────────────────────────────────────────────

export class ScreenCaptureService {
  // Returns all connected monitors with their metadata
  getAllMonitorInfo(): MonitorInfo[] {
    return screen.getAllDisplays().map((display, index) => ({
      monitorId: `display-${display.id}`,
      bounds: {
        x: display.bounds.x,
        y: display.bounds.y,
        width: display.bounds.width,
        height: display.bounds.height,
      },
      workAreaBounds: {
        x: display.workArea.x,
        y: display.workArea.y,
        width: display.workArea.width,
        height: display.workArea.height,
      },
      scaleFactor: display.scaleFactor,
      isPrimary: index === 0,
    }))
  }

  // Captures the primary display and returns a base64-encoded PNG.
  // thumbnailSize is set to the display's native resolution so the image is full-res.
  async captureMainDisplay(): Promise<string> {
    const primaryDisplay = screen.getPrimaryDisplay()
    const { width, height } = primaryDisplay.bounds

    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: Math.round(width * primaryDisplay.scaleFactor),
        height: Math.round(height * primaryDisplay.scaleFactor),
      },
    })

    if (sources.length === 0) {
      throw new Error('[ScreenCaptureService] no screen sources returned by desktopCapturer')
    }

    // desktopCapturer returns sources sorted by size; the first screen source
    // corresponds to the primary display on most Windows configurations.
    const primarySource = sources[0]
    const pngBuffer = primarySource.thumbnail.toPNG()
    return pngBuffer.toString('base64')
  }

  // Captures all connected displays. Returns a Map<displayId, base64PNG> where
  // displayId matches String(Electron.Display.id).
  //
  // Matching strategy (in priority order):
  //   1. source.display_id === String(display.id)  — reliable on Windows 10/11 + Electron 11+
  //   2. screenshot dimensions === physical display dimensions — only used when exactly ONE
  //      source matches; ambiguous cases (multiple same-resolution displays) produce an error
  //      and that display is omitted rather than silently duplicating another display's image.
  async captureAllDisplays(): Promise<Map<string, string>> {
    const allDisplays = screen.getAllDisplays()

    // Request a large thumbnail size (4K max). Each source's thumbnail will be at its
    // natural resolution up to this cap, so smaller displays are not upscaled.
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 3840, height: 2160 },
    })

    const capturedDisplays = new Map<string, string>()

    for (const display of allDisplays) {
      const displayId = String(display.id)

      // Strategy 1: match by display_id (most reliable)
      const sourceMatchedByDisplayId = sources.find(
        source => source.display_id === displayId
      )
      if (sourceMatchedByDisplayId !== undefined) {
        capturedDisplays.set(displayId, sourceMatchedByDisplayId.thumbnail.toPNG().toString('base64'))
        continue
      }

      // Strategy 2: match by screenshot pixel dimensions
      const physicalWidth  = Math.round(display.bounds.width  * display.scaleFactor)
      const physicalHeight = Math.round(display.bounds.height * display.scaleFactor)

      const sourcesCandidatesByDimensions = sources.filter(source => {
        const { width, height } = source.thumbnail.getSize()
        return width === physicalWidth && height === physicalHeight
      })

      if (sourcesCandidatesByDimensions.length === 1) {
        capturedDisplays.set(displayId, sourcesCandidatesByDimensions[0].thumbnail.toPNG().toString('base64'))
      } else if (sourcesCandidatesByDimensions.length > 1) {
        // Multiple sources share the same resolution and display_id was not populated.
        // We cannot determine which source belongs to which display without display_id.
        // Picking arbitrarily would silently annotate the wrong monitor, so we omit this
        // display entirely and let SessionManager skip its finalize event.
        console.error(
          `[ScreenCaptureService] AMBIGUOUS match for displayId=${displayId}: ` +
          `${sourcesCandidatesByDimensions.length} sources at ${physicalWidth}×${physicalHeight} ` +
          `and display_id not populated. ` +
          `Omitting this display — ensure display_id is available (Electron 11+ on Windows 10/11).`
        )
        // Intentionally NOT added to capturedDisplays to prevent duplicating
        // another display's screenshot onto this one.
      } else {
        console.error(
          `[ScreenCaptureService] no source matched displayId=${displayId} ` +
          `(physical ${physicalWidth}×${physicalHeight}, display_id fallback also failed)`
        )
      }
    }

    return capturedDisplays
  }
}
