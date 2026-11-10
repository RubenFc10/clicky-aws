import React, { useEffect, useRef, useCallback } from 'react'
import type { SessionState, Stroke, StrokePoint, FinalizeSessionPayload, MousePointPayload } from '../../shared/sessionTypes'
import { SESSION_STATE } from '../../shared/sessionTypes'
import type { AnnotatedScreenshotPayload } from '../../shared/sessionTypes'
import { computeAnnotationScale } from '../../shared/coordinateUtils'

// ─── Constants ────────────────────────────────────────────────────────────────

// A new stroke is started when no mouse point arrives within this window.
// 300ms feels right: it splits intentional pauses but doesn't fragment fast sketches.
const STROKE_GAP_THRESHOLD_MS = 300

// Stroke visual style
const STROKE_COLOR   = '#FF3333'
const STROKE_GLOW    = 'rgba(255, 80, 80, 0.55)'
const STROKE_WIDTH   = 3.5
const STROKE_BLUR    = 10

// ─── DrawingCanvas ────────────────────────────────────────────────────────────

export function DrawingCanvas(): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  // All strokes completed in the current session.
  // Stored as a ref to avoid triggering re-renders on every mouse move.
  const allStrokes = useRef<Stroke[]>([])

  // The stroke currently being drawn (points accumulated since last gap)
  const currentStrokePoints = useRef<StrokePoint[]>([])
  const currentStrokeId = useRef<string>(newStrokeId())
  const currentSessionId = useRef<string>('')
  const lastPointTimestamp = useRef<number>(0)

  // This overlay's display ID — read once from the URL query param on mount.
  // Only mouse points and finalize events matching this displayId are processed.
  // If no displayId is present (unexpected), all events are processed as a fallback.
  const myDisplayId = useRef<string>('')

  // ─── Canvas setup ──────────────────────────────────────────────────────────

  // Size the canvas to the overlay window's physical pixel resolution for crisp HiDPI rendering.
  // window.innerWidth/Height equals the DIP size of this overlay (which covers exactly one display).
  // window.devicePixelRatio gives the scale factor for this specific display.
  //
  // We also listen for viewport resize events: on Windows, Chromium initialises the CSS
  // viewport from the primary display's workArea when a BrowserWindow is created with
  // show:false. DisplayOverlayManager forces two WM_SIZE messages after show() (via a
  // 1-pixel setSize trick) to push the correct display dimensions into the renderer.
  // Those WM_SIZE messages fire the window resize event AFTER this useEffect has already
  // run, so we must update the canvas then to avoid the canvas buffer being smaller than
  // the CSS '100vh' height — a mismatch would stretch the buffer and shift all drawn
  // strokes to the wrong screen position (observed: strokes ~950 px below cursor on Samsung).
  useEffect(() => {
    myDisplayId.current = new URLSearchParams(window.location.search).get('displayId') ?? ''
    if (myDisplayId.current === '') {
      console.warn('[DrawingCanvas] no ?displayId in URL — will process events from all displays')
    }

    const canvas = canvasRef.current
    if (canvas === null) return

    const resizeCanvasToViewport = (): void => {
      const dpr = window.devicePixelRatio || 1
      canvas.width  = window.innerWidth  * dpr
      canvas.height = window.innerHeight * dpr
      const ctx = canvas.getContext('2d')
      if (ctx !== null) ctx.scale(dpr, dpr)
      console.debug(
        '[DrawingCanvas] canvas resized:',
        `window=${window.innerWidth}×${window.innerHeight}`,
        `dpr=${dpr}`,
        `canvas=${canvas.width}×${canvas.height}`,
        `displayId=${myDisplayId.current}`
      )
    }

    resizeCanvasToViewport()
    window.addEventListener('resize', resizeCanvasToViewport)
    return () => window.removeEventListener('resize', resizeCanvasToViewport)
  }, [])

  // ─── Drawing primitives ────────────────────────────────────────────────────

  const getContext = useCallback((): CanvasRenderingContext2D | null => {
    return canvasRef.current?.getContext('2d') ?? null
  }, [])

  // Apply the standard stroke style once before drawing
  const applyStrokeStyle = useCallback((ctx: CanvasRenderingContext2D): void => {
    ctx.strokeStyle = STROKE_COLOR
    ctx.lineWidth   = STROKE_WIDTH
    ctx.lineCap     = 'round'
    ctx.lineJoin    = 'round'
    ctx.shadowColor = STROKE_GLOW
    ctx.shadowBlur  = STROKE_BLUR
  }, [])

  // Draw the last segment of an in-progress stroke using the midpoint quadratic bezier
  // algorithm so that all segments join smoothly (C1 continuity).
  const drawLatestSegment = useCallback(
    (ctx: CanvasRenderingContext2D, points: StrokePoint[]): void => {
      if (points.length < 2) return

      applyStrokeStyle(ctx)
      ctx.beginPath()

      if (points.length === 2) {
        // Not enough points for a bezier — draw a straight segment
        ctx.moveTo(points[0].x, points[0].y)
        ctx.lineTo(points[1].x, points[1].y)
      } else {
        const secondToLast = points[points.length - 2]
        const last         = points[points.length - 1]
        const beforeThat   = points[points.length - 3]

        // Midpoints for C1-continuous bezier join
        const prevMidX = (beforeThat.x + secondToLast.x) / 2
        const prevMidY = (beforeThat.y + secondToLast.y) / 2
        const currMidX = (secondToLast.x + last.x) / 2
        const currMidY = (secondToLast.y + last.y) / 2

        ctx.moveTo(prevMidX, prevMidY)
        ctx.quadraticCurveTo(secondToLast.x, secondToLast.y, currMidX, currMidY)
      }

      ctx.stroke()
    },
    [applyStrokeStyle]
  )

  const clearCanvas = useCallback((): void => {
    const canvas = canvasRef.current
    if (canvas === null) return
    const ctx = canvas.getContext('2d')
    if (ctx === null) return
    ctx.clearRect(0, 0, canvas.width / (window.devicePixelRatio || 1), canvas.height / (window.devicePixelRatio || 1))
  }, [])

  // ─── Stroke management ────────────────────────────────────────────────────

  const finalizeCurrentStroke = useCallback((): void => {
    const points = currentStrokePoints.current
    if (points.length < 2) {
      currentStrokePoints.current = []
      return
    }

    const completedStroke = buildStroke(
      currentSessionId.current,
      currentStrokeId.current,
      points
    )

    allStrokes.current.push(completedStroke)
    currentStrokePoints.current = []
    currentStrokeId.current = newStrokeId()
  }, [])

  // ─── IPC: mouse point received ─────────────────────────────────────────────

  const handleMousePoint = useCallback(
    (point: MousePointPayload): void => {
      // Only process points from this overlay's display
      if (myDisplayId.current !== '' && point.displayId !== myDisplayId.current) return

      const ctx = getContext()
      if (ctx === null) return

      // Sync the session ID from the point payload before any stroke is finalized.
      if (currentSessionId.current !== point.sessionId) {
        currentSessionId.current = point.sessionId
      }

      const now = point.timestamp

      // Detect stroke gap: if the cursor was idle for > STROKE_GAP_THRESHOLD_MS,
      // close the previous stroke and start a new one
      if (
        lastPointTimestamp.current > 0 &&
        now - lastPointTimestamp.current > STROKE_GAP_THRESHOLD_MS &&
        currentStrokePoints.current.length > 0
      ) {
        finalizeCurrentStroke()
      }

      lastPointTimestamp.current = now
      currentStrokePoints.current.push({ x: point.x, y: point.y, timestamp: now })
      drawLatestSegment(ctx, currentStrokePoints.current)
    },
    [getContext, finalizeCurrentStroke, drawLatestSegment]
  )

  // ─── IPC: session state changed ────────────────────────────────────────────

  const handleSessionStateChanged = useCallback(
    (state: SessionState): void => {
      if (state === SESSION_STATE.RECORDING_AND_TRACKING) {
        // New session starting — clear canvas and reset all stroke state.
        clearCanvas()
        allStrokes.current = []
        currentStrokePoints.current = []
        currentStrokeId.current = newStrokeId()
        currentSessionId.current = ''
        lastPointTimestamp.current = 0
      }

      if (state === SESSION_STATE.IDLE) {
        // Cancelled path: clear everything
        clearCanvas()
        allStrokes.current = []
        currentStrokePoints.current = []
        lastPointTimestamp.current = 0
      }
    },
    [clearCanvas]
  )

  // ─── IPC: finalize (screenshot ready from main) ────────────────────────────

  const handleSessionFinalize = useCallback(
    async (finalizePayload: FinalizeSessionPayload): Promise<void> => {
      // Only handle finalize events for this overlay's display
      if (myDisplayId.current !== '' && finalizePayload.displayId !== myDisplayId.current) return

      currentSessionId.current = finalizePayload.sessionId

      // Close the last in-progress stroke
      finalizeCurrentStroke()

      // Build the annotated screenshot:
      // 1. Draw the original screenshot onto a hidden offscreen canvas
      // 2. Overlay the red strokes on top
      // 3. Export as base64 PNG
      const annotatedBase64 = await createAnnotatedScreenshot(
        finalizePayload.screenshotOriginalBase64,
        allStrokes.current
      )

      const annotationPayload: AnnotatedScreenshotPayload = {
        sessionId: finalizePayload.sessionId,
        displayId: finalizePayload.displayId,
        screenshotAnnotatedBase64: annotatedBase64,
        strokes: [...allStrokes.current],
      }

      window.electronAPI.submitSessionAnnotation(annotationPayload)
    },
    [finalizeCurrentStroke]
  )

  // ─── IPC: session cancelled ────────────────────────────────────────────────

  const handleSessionCancelled = useCallback((): void => {
    clearCanvas()
    allStrokes.current = []
    currentStrokePoints.current = []
    lastPointTimestamp.current = 0
  }, [clearCanvas])

  // ─── Register IPC listeners ────────────────────────────────────────────────

  useEffect(() => {
    const cleanupMousePoint    = window.electronAPI.onSessionMousePoint(handleMousePoint)
    const cleanupStateChanged  = window.electronAPI.onSessionStateChanged(handleSessionStateChanged)
    const cleanupFinalize      = window.electronAPI.onSessionFinalize(handleSessionFinalize)
    const cleanupCancelled     = window.electronAPI.onSessionCancelled(handleSessionCancelled)

    return () => {
      cleanupMousePoint()
      cleanupStateChanged()
      cleanupFinalize()
      cleanupCancelled()
    }
  }, [handleMousePoint, handleSessionStateChanged, handleSessionFinalize, handleSessionCancelled])

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100vw',
        height: '100vh',
        pointerEvents: 'none',
        zIndex: 100,
      }}
    />
  )
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function newStrokeId(): string {
  return `stroke-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

// Pure factory for a completed Stroke. Exported so unit tests can verify the
// sessionId-assignment invariant without rendering the React component.
export function buildStroke(
  sessionId: string,
  strokeId: string,
  points: StrokePoint[]
): Stroke {
  return {
    strokeId,
    sessionId,
    points: [...points],
    startedAt: points[0].timestamp,
    endedAt:   points[points.length - 1].timestamp,
  }
}

// Creates an offscreen canvas with the original screenshot underneath and
// the red strokes on top, then returns it as a base64 PNG string.
async function createAnnotatedScreenshot(
  screenshotOriginalBase64: string,
  strokes: Stroke[]
): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      const offscreenCanvas = document.createElement('canvas')
      offscreenCanvas.width  = img.naturalWidth
      offscreenCanvas.height = img.naturalHeight

      const ctx = offscreenCanvas.getContext('2d')
      if (ctx === null) {
        resolve(screenshotOriginalBase64)
        return
      }

      // 1. Draw the original screenshot
      ctx.drawImage(img, 0, 0)

      // 2. Scale stroke coordinates from CSS pixels to screenshot pixels.
      //    Strokes are recorded in display-relative DIP (CSS) pixels.
      //    The screenshot may differ from CSS * devicePixelRatio on portrait monitors
      //    where desktopCapturer may return a different image resolution.
      //    Use the actual image dimensions rather than dpr to stay correct in all cases.
      const annotationScale = computeAnnotationScale(
        img.naturalWidth,
        img.naturalHeight,
        window.innerWidth,
        window.innerHeight
      )

      // Phase 2 diagnostic: log scale factors to verify portrait orientation handling.
      console.debug(
        '[DrawingCanvas] annotation scale:',
        `img=${img.naturalWidth}×${img.naturalHeight}`,
        `window=${window.innerWidth}×${window.innerHeight}`,
        `scaleX=${annotationScale.x.toFixed(3)}`,
        `scaleY=${annotationScale.y.toFixed(3)}`
      )

      // 3. Draw all strokes
      ctx.strokeStyle = STROKE_COLOR
      ctx.lineWidth   = STROKE_WIDTH * annotationScale.x
      ctx.lineCap     = 'round'
      ctx.lineJoin    = 'round'
      ctx.shadowColor = STROKE_GLOW
      ctx.shadowBlur  = STROKE_BLUR * annotationScale.x

      for (const stroke of strokes) {
        if (stroke.points.length < 2) continue
        ctx.beginPath()
        ctx.moveTo(stroke.points[0].x * annotationScale.x, stroke.points[0].y * annotationScale.y)
        for (let i = 1; i < stroke.points.length - 1; i++) {
          const midX = ((stroke.points[i].x + stroke.points[i + 1].x) / 2) * annotationScale.x
          const midY = ((stroke.points[i].y + stroke.points[i + 1].y) / 2) * annotationScale.y
          ctx.quadraticCurveTo(
            stroke.points[i].x * annotationScale.x,
            stroke.points[i].y * annotationScale.y,
            midX,
            midY
          )
        }
        const lastPoint = stroke.points[stroke.points.length - 1]
        ctx.lineTo(lastPoint.x * annotationScale.x, lastPoint.y * annotationScale.y)
        ctx.stroke()
      }

      resolve(offscreenCanvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, ''))
    }

    img.onerror = () => resolve(screenshotOriginalBase64)
    img.src = `data:image/png;base64,${screenshotOriginalBase64}`
  })
}
