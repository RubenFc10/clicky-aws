import { describe, it, expect } from 'vitest'
import {
  dipToDisplayRelative,
  isPointWithinDisplay,
  isPointNearWindow,
  computeAnnotationScale,
} from '../../../shared/coordinateUtils'
import type { Bounds } from '../../../shared/coordinateUtils'

// ─── Display fixtures ─────────────────────────────────────────────────────────

// Xiaomi G27i Pro 1080p — primary, upper-left at origin
const PRIMARY_DISPLAY: Bounds = { x: 0, y: 0, width: 1920, height: 1080 }

// Samsung Odyssey — secondary, to the right of primary
const SECONDARY_RIGHT: Bounds = { x: 1920, y: 0, width: 2560, height: 1440 }

// Display placed to the left of primary (negative origin)
const SECONDARY_LEFT: Bounds = { x: -2560, y: 0, width: 2560, height: 1440 }

// Display below primary (vertical arrangement)
const SECONDARY_BELOW: Bounds = { x: 0, y: 1080, width: 1920, height: 1080 }

// ─── dipToDisplayRelative ─────────────────────────────────────────────────────

describe('dipToDisplayRelative', () => {
  it('primary display origin maps to (0, 0)', () => {
    expect(dipToDisplayRelative(0, 0, PRIMARY_DISPLAY)).toEqual({ x: 0, y: 0 })
  })

  it('center of primary maps to half-dimensions', () => {
    expect(dipToDisplayRelative(960, 540, PRIMARY_DISPLAY)).toEqual({ x: 960, y: 540 })
  })

  it('secondary right: subtracts display origin correctly', () => {
    // Cursor at global (2000, 100) on secondary display starting at x=1920
    expect(dipToDisplayRelative(2000, 100, SECONDARY_RIGHT)).toEqual({ x: 80, y: 100 })
  })

  it('secondary right: left edge of display maps to x=0', () => {
    expect(dipToDisplayRelative(1920, 500, SECONDARY_RIGHT)).toEqual({ x: 0, y: 500 })
  })

  it('secondary left (negative origin): correct display-relative coords', () => {
    // Cursor at global (-100, 200) — display starts at x=-2560
    expect(dipToDisplayRelative(-100, 200, SECONDARY_LEFT)).toEqual({ x: 2460, y: 200 })
  })

  it('secondary left: right edge of left display maps correctly', () => {
    // Right edge of left display is at global x = -2560 + 2560 = 0
    expect(dipToDisplayRelative(-1, 0, SECONDARY_LEFT)).toEqual({ x: 2559, y: 0 })
  })

  it('display below primary: y offset subtracted', () => {
    expect(dipToDisplayRelative(960, 1200, SECONDARY_BELOW)).toEqual({ x: 960, y: 120 })
  })
})

// ─── isPointWithinDisplay ─────────────────────────────────────────────────────

describe('isPointWithinDisplay', () => {
  it('center of primary is within primary', () => {
    expect(isPointWithinDisplay(960, 540, PRIMARY_DISPLAY)).toBe(true)
  })

  it('top-left corner of primary is within primary', () => {
    expect(isPointWithinDisplay(0, 0, PRIMARY_DISPLAY)).toBe(true)
  })

  it('exact right edge of primary is NOT within primary (half-open interval)', () => {
    expect(isPointWithinDisplay(1920, 540, PRIMARY_DISPLAY)).toBe(false)
  })

  it('first pixel of secondary right is within secondary right', () => {
    expect(isPointWithinDisplay(1920, 0, SECONDARY_RIGHT)).toBe(true)
  })

  it('primary right edge is not within secondary right (boundary is exclusive on primary)', () => {
    expect(isPointWithinDisplay(1919, 540, SECONDARY_RIGHT)).toBe(false)
  })

  it('negative coordinate on left display is within that display', () => {
    expect(isPointWithinDisplay(-100, 500, SECONDARY_LEFT)).toBe(true)
  })

  it('primary origin (0,0) is not within left display', () => {
    // Left display covers [-2560, -1], so x=0 is outside
    expect(isPointWithinDisplay(0, 0, SECONDARY_LEFT)).toBe(false)
  })

  it('display scaleFactor does not affect DIP bounds check (bounds already in DIP)', () => {
    // Both displays have same DIP bounds regardless of scaleFactor
    const highDpiDisplay: Bounds = { x: 0, y: 0, width: 1920, height: 1080 }
    expect(isPointWithinDisplay(1500, 800, highDpiDisplay)).toBe(true)
  })
})

// ─── isPointNearWindow ────────────────────────────────────────────────────────

describe('isPointNearWindow', () => {
  // Notch in COLLAPSED state: 40×4 at top-center of a 1920px display
  const NOTCH_COLLAPSED: Bounds = { x: 940, y: 0, width: 40, height: 4 }

  it('cursor directly on notch is near', () => {
    expect(isPointNearWindow(960, 2, NOTCH_COLLAPSED, 40)).toBe(true)
  })

  it('cursor 30px below top of screen is within 40px proximity', () => {
    // Notch at y=0, h=4; cursor at y=30 is 26px below notch bottom
    expect(isPointNearWindow(960, 30, NOTCH_COLLAPSED, 40)).toBe(true)
  })

  it('cursor 50px below top of screen exceeds 40px threshold', () => {
    // 50px below notch bottom (y=4) → distance is 46px > 40px
    expect(isPointNearWindow(960, 50, NOTCH_COLLAPSED, 40)).toBe(false)
  })

  it('cursor 35px above top (negative y, possible) is within proximity', () => {
    expect(isPointNearWindow(960, -35, NOTCH_COLLAPSED, 40)).toBe(true)
  })

  it('cursor far left of notch is not in proximity zone', () => {
    expect(isPointNearWindow(0, 0, NOTCH_COLLAPSED, 40)).toBe(false)
  })

  it('cursor at horizontal proximity edge (notch left - proximityPx) is exactly at boundary', () => {
    // notch.x=940, threshold=40 → boundary at x=900
    expect(isPointNearWindow(900, 2, NOTCH_COLLAPSED, 40)).toBe(true)
  })

  it('cursor one pixel outside horizontal proximity is not near', () => {
    expect(isPointNearWindow(899, 2, NOTCH_COLLAPSED, 40)).toBe(false)
  })
})

// ─── Portrait monitor fixtures ────────────────────────────────────────────────

// Samsung Odyssey 32" in portrait (90° rotation): 1440 wide × 2560 tall in DIP.
// Positioned to the right of the Xiaomi primary (1920px wide).
// scaleFactor 1.0 (100% DPI) — bounds are already in DIP so rotation doesn't change math.
const SAMSUNG_PORTRAIT: Bounds = { x: 1920, y: 0, width: 1440, height: 2560 }

// Same Samsung but at 125% DPI (scaleFactor 1.25). DIP bounds are identical —
// scaleFactor only affects physical pixel resolution, NOT the DIP coordinate space.
const SAMSUNG_PORTRAIT_125: Bounds = { x: 1920, y: 0, width: 1440, height: 2560 }

// ─── dipToDisplayRelative — portrait cases ────────────────────────────────────

describe('dipToDisplayRelative — portrait monitor', () => {
  it('top-left of portrait display maps to (0, 0)', () => {
    expect(dipToDisplayRelative(1920, 0, SAMSUNG_PORTRAIT)).toEqual({ x: 0, y: 0 })
  })

  it('top-right corner of portrait display', () => {
    // right edge at DIP x = 1920 + 1440 - 1 = 3359
    expect(dipToDisplayRelative(3359, 0, SAMSUNG_PORTRAIT)).toEqual({ x: 1439, y: 0 })
  })

  it('bottom-left corner of portrait display', () => {
    // bottom at DIP y = 2559
    expect(dipToDisplayRelative(1920, 2559, SAMSUNG_PORTRAIT)).toEqual({ x: 0, y: 2559 })
  })

  it('bottom-right corner of portrait display', () => {
    expect(dipToDisplayRelative(3359, 2559, SAMSUNG_PORTRAIT)).toEqual({ x: 1439, y: 2559 })
  })

  it('center of portrait display', () => {
    // DIP center: x = 1920 + 720 = 2640, y = 1280
    expect(dipToDisplayRelative(2640, 1280, SAMSUNG_PORTRAIT)).toEqual({ x: 720, y: 1280 })
  })

  it('portrait at 125% DPI: same DIP bounds produce same display-relative coords', () => {
    // scaleFactor affects physical pixels only; DIP coords and bounds are identical
    expect(dipToDisplayRelative(2640, 1280, SAMSUNG_PORTRAIT_125)).toEqual({ x: 720, y: 1280 })
  })

  it('portrait display has height > width (sanity check)', () => {
    expect(SAMSUNG_PORTRAIT.height).toBeGreaterThan(SAMSUNG_PORTRAIT.width)
  })
})

// ─── isPointWithinDisplay — portrait cases ────────────────────────────────────

describe('isPointWithinDisplay — portrait monitor', () => {
  it('center of portrait display is within it', () => {
    expect(isPointWithinDisplay(2640, 1280, SAMSUNG_PORTRAIT)).toBe(true)
  })

  it('top-left corner of portrait is within it', () => {
    expect(isPointWithinDisplay(1920, 0, SAMSUNG_PORTRAIT)).toBe(true)
  })

  it('right edge of portrait is NOT within (half-open)', () => {
    // x = 1920 + 1440 = 3360 is the first pixel OUTSIDE
    expect(isPointWithinDisplay(3360, 1000, SAMSUNG_PORTRAIT)).toBe(false)
  })

  it('bottom edge of portrait is NOT within (half-open)', () => {
    // y = 2560 is the first pixel OUTSIDE
    expect(isPointWithinDisplay(2000, 2560, SAMSUNG_PORTRAIT)).toBe(false)
  })

  it('primary display origin is not within portrait display', () => {
    expect(isPointWithinDisplay(0, 0, SAMSUNG_PORTRAIT)).toBe(false)
  })

  it('point just left of portrait is not within it', () => {
    expect(isPointWithinDisplay(1919, 500, SAMSUNG_PORTRAIT)).toBe(false)
  })
})

// ─── computeAnnotationScale ───────────────────────────────────────────────────

describe('computeAnnotationScale', () => {
  it('landscape 1080p at 100% DPI: scale is 1×1', () => {
    // Screenshot 1920×1080, overlay window 1920×1080
    expect(computeAnnotationScale(1920, 1080, 1920, 1080)).toEqual({ x: 1, y: 1 })
  })

  it('landscape 1080p at 150% DPI: scale is 1.5×1.5', () => {
    // Screenshot 2880×1620 (physical), overlay CSS 1920×1080
    const scale = computeAnnotationScale(2880, 1620, 1920, 1080)
    expect(scale.x).toBeCloseTo(1.5)
    expect(scale.y).toBeCloseTo(1.5)
  })

  it('landscape 1440p at 125% DPI: scale is 1.25×1.25', () => {
    // Screenshot 3200×1800, overlay CSS 2560×1440
    const scale = computeAnnotationScale(3200, 1800, 2560, 1440)
    expect(scale.x).toBeCloseTo(1.25)
    expect(scale.y).toBeCloseTo(1.25)
  })

  it('portrait Samsung at 100% DPI: scale is 1×1', () => {
    // Screenshot 1440×2560, overlay CSS 1440×2560
    expect(computeAnnotationScale(1440, 2560, 1440, 2560)).toEqual({ x: 1, y: 1 })
  })

  it('portrait Samsung at 125% DPI: scale is 1.25×1.25', () => {
    // Screenshot 1800×3200 (physical), overlay CSS 1440×2560 (DIP)
    const scale = computeAnnotationScale(1800, 3200, 1440, 2560)
    expect(scale.x).toBeCloseTo(1.25)
    expect(scale.y).toBeCloseTo(1.25)
  })

  it('non-square scale: image rotated vs window (desktopCapturer landscape on portrait OS view)', () => {
    // Edge case: if desktopCapturer returns 2560×1440 for a portrait window 1440×2560
    // scaleX = 2560/1440 ≈ 1.778, scaleY = 1440/2560 = 0.5625
    const scale = computeAnnotationScale(2560, 1440, 1440, 2560)
    expect(scale.x).toBeCloseTo(2560 / 1440)
    expect(scale.y).toBeCloseTo(1440 / 2560)
  })

  it('stroke point pipeline: CSS → annotationScale → screenshot pixel', () => {
    // Cursor at CSS (720, 1280) on portrait Samsung at 125% DPI
    // Expected screenshot position: (720 * 1.25, 1280 * 1.25) = (900, 1600)
    const scale = computeAnnotationScale(1800, 3200, 1440, 2560)
    const cssPoint = { x: 720, y: 1280 }
    const screenshotPoint = {
      x: cssPoint.x * scale.x,
      y: cssPoint.y * scale.y,
    }
    expect(screenshotPoint.x).toBeCloseTo(900)
    expect(screenshotPoint.y).toBeCloseTo(1600)
  })
})
