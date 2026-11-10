import React, { useEffect, useRef } from 'react'
import type { GlobalMousePayload } from '../../shared/sessionTypes'

// ─── Cursor Follower Spring Physics Constants ─────────────────────────────────

const SPRING_STIFFNESS = 150   // Higher = snappier follow
const SPRING_DAMPING   = 15    // Higher = less oscillation
const SPRING_MASS      = 1

// Cursor icon tip renders slightly below and to the right of the system cursor
// so the two pointers don't overlap.
const ORB_CURSOR_OFFSET_PX = 10

// Size of the cursor icon in CSS pixels.
const CURSOR_SIZE_PX = 26

// If no mouse move arrives for this many ms the cursor enters idle/breathing mode.
const IDLE_THRESHOLD_MS = 1000

// ─── CursorFollower ───────────────────────────────────────────────────────────

// A red orb rendered in a DisplayOverlay that follows the cursor with spring physics.
// Each overlay window runs its own CursorFollower instance and only shows the orb
// when the cursor is on its display (matched via the ?displayId URL param).
export function CursorFollower(): React.JSX.Element {
  // The div element the orb is rendered inside
  const orbRef = useRef<HTMLDivElement>(null)

  // All physics state is in refs (never useState) to avoid re-renders on every RAF frame
  const posX = useRef(0)
  const posY = useRef(0)
  const velX = useRef(0)
  const velY = useRef(0)
  const targetX = useRef(0)
  const targetY = useRef(0)

  // Which display this overlay window covers — read once from URL on mount
  const myDisplayId = useRef<string>('')

  // Whether the cursor is currently on this display
  const isCursorOnThisDisplay = useRef(false)

  // Timestamp of the last mouse move — used to detect idle and start breathing
  const lastMovedAtMs = useRef(0)

  // RAF handle for cleanup
  const rafHandle = useRef<number | null>(null)

  // Timestamp of the previous RAF frame — used to compute actual elapsed dt.
  // Using actual dt instead of a constant 1/60 prevents the spring from running
  // at 4× real-time on 240 Hz displays (where RAF fires every ~4 ms, not ~16 ms).
  const prevFrameMs = useRef<number>(0)

  // IPC cleanup functions
  const cleanupCursorListener = useRef<(() => void) | null>(null)

  useEffect(() => {
    // Read the display ID assigned to this overlay window via the URL query param
    myDisplayId.current = new URLSearchParams(window.location.search).get('displayId') ?? ''
    if (myDisplayId.current === '') {
      console.warn('[CursorFollower] no ?displayId in URL — orb will follow on all displays')
    }

    // Diagnostic: log renderer viewport info to compare against main-process display.bounds.
    // Cross-reference with [overlay-diag] and [coord-diagnostic] logs in the main process
    // to verify that CSS pixels and DIP coords are consistent across all displays.
    console.log(
      `[renderer-diag] displayId=${myDisplayId.current}`,
      `innerW=${window.innerWidth}`,
      `innerH=${window.innerHeight}`,
      `dpr=${window.devicePixelRatio}`
    )

    // Inject the breathing CSS animation once into the document head
    injectBreathingKeyframes()

    // Subscribe to cursor move events from main process
    cleanupCursorListener.current = window.electronAPI.onCursorGlobalMove(handleCursorMove)

    // Start the RAF animation loop
    rafHandle.current = requestAnimationFrame(animationLoop)

    // Log viewport dimensions whenever the window is resized — the setBounds call in
    // DisplayOverlayManager.ready-to-show triggers a resize event after show(), so this
    // confirms whether the CSS viewport updated from primary.workArea.height to the
    // display's full height (1440 for Xiaomi, 2560 for Samsung portrait).
    const onViewportResize = (): void => {
      console.log(
        `[renderer-diag-resize] displayId=${myDisplayId.current}`,
        `innerW=${window.innerWidth}`,
        `innerH=${window.innerHeight}`
      )
    }
    window.addEventListener('resize', onViewportResize)

    return () => {
      cleanupCursorListener.current?.()
      if (rafHandle.current !== null) cancelAnimationFrame(rafHandle.current)
      window.removeEventListener('resize', onViewportResize)
    }
  }, [])

  // ─── Cursor move handler (fires from IPC, not RAF) ────────────────────────

  function handleCursorMove(cursorPayload: GlobalMousePayload): void {
    const cursorIsOnThisDisplay =
      myDisplayId.current === '' || cursorPayload.displayId === myDisplayId.current

    if (!cursorIsOnThisDisplay) {
      // Cursor moved off our display — hide the orb (handled in RAF loop via flag)
      isCursorOnThisDisplay.current = false
      return
    }

    // On first entry to this display (isCursorOnThisDisplay transitions false → true),
    // snap the spring position directly to the cursor. Without this snap, the spring
    // animates from its last frozen position (or from (0,0) on first use) all the way
    // to the cursor, overshooting by ~83 px when entering the Samsung from y=0 to
    // displayRelY≈917 — the visible "orb is lower than the cursor" artifact.
    if (!isCursorOnThisDisplay.current) {
      posX.current = cursorPayload.displayRelX + ORB_CURSOR_OFFSET_PX
      posY.current = cursorPayload.displayRelY + ORB_CURSOR_OFFSET_PX
      velX.current = 0
      velY.current = 0
    }

    isCursorOnThisDisplay.current = true
    lastMovedAtMs.current = Date.now()

    // Target position: display-relative DIP coords + offset so orb trails the cursor
    targetX.current = cursorPayload.displayRelX + ORB_CURSOR_OFFSET_PX
    targetY.current = cursorPayload.displayRelY + ORB_CURSOR_OFFSET_PX
  }

  // ─── RAF animation loop (spring physics + teardrop morph + breathing) ────

  function animationLoop(nowMs: number): void {
    const orbElement = orbRef.current
    if (orbElement === null) {
      rafHandle.current = requestAnimationFrame(animationLoop)
      return
    }

    const isIdle = isCursorOnThisDisplay.current && (nowMs - lastMovedAtMs.current) > IDLE_THRESHOLD_MS

    if (!isCursorOnThisDisplay.current) {
      // Cursor is on a different display — hide the orb
      orbElement.style.opacity = '0'
      rafHandle.current = requestAnimationFrame(animationLoop)
      return
    }

    // Actual elapsed time since the previous frame, clamped to prevent large jumps on tab
    // focus or when the tab was backgrounded. Using real dt (not a constant 1/60) ensures
    // spring physics run at 1× real-time on all displays — without this, a 240 Hz display
    // fires RAF 4× more often than 60 Hz, causing the spring to advance 4× too fast and
    // overshoot noticeably when the cursor enters this display from a different one.
    const rawDt = prevFrameMs.current > 0 ? (nowMs - prevFrameMs.current) / 1000 : 1 / 60
    prevFrameMs.current = nowMs
    const dtSeconds = Math.min(rawDt, 1 / 30)

    // Spring step for X
    const springForceX = SPRING_STIFFNESS * (targetX.current - posX.current)
    const dampingForceX = SPRING_DAMPING * velX.current
    velX.current += ((springForceX - dampingForceX) / SPRING_MASS) * dtSeconds
    posX.current += velX.current * dtSeconds

    // Spring step for Y
    const springForceY = SPRING_STIFFNESS * (targetY.current - posY.current)
    const dampingForceY = SPRING_DAMPING * velY.current
    velY.current += ((springForceY - dampingForceY) / SPRING_MASS) * dtSeconds
    posY.current += velY.current * dtSeconds

    // Stretch the cursor icon in the direction of movement when fast.
    // The cursor arrow always points top-left (no rotation) so only scale is applied.
    const speed = Math.sqrt(velX.current * velX.current + velY.current * velY.current)
    const stretchFactor = Math.min(speed * 0.0025, 0.3)
    const scaleX = 1 + stretchFactor
    const scaleY = 1 - stretchFactor * 0.4

    // Breathing animation when idle
    if (isIdle) {
      orbElement.style.animation = 'clicky-orb-breathe 2s ease-in-out infinite'
    } else {
      orbElement.style.animation = 'none'
    }

    orbElement.style.opacity = '1'
    orbElement.style.transform = [
      `translate(${posX.current}px, ${posY.current}px)`,
      `scale(${scaleX}, ${scaleY})`,
    ].join(' ')

    rafHandle.current = requestAnimationFrame(animationLoop)
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: 0,
        height: 0,
        pointerEvents: 'none',
        zIndex: 9999,
      }}
    >
      <div
        ref={orbRef}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: CURSOR_SIZE_PX,
          height: CURSOR_SIZE_PX,
          opacity: 0,
          willChange: 'transform, opacity',
          pointerEvents: 'none',
        }}
      >
        <svg
          width={CURSOR_SIZE_PX}
          height={CURSOR_SIZE_PX}
          viewBox="0 0 18 20"
          fill="none"
          style={{ overflow: 'visible' }}
        >
          <defs>
            <linearGradient id="clicky-cursor-grad" x1="1" y1="1" x2="13" y2="18" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stopColor="#99EEFF" />
              <stop offset="100%" stopColor="#11AADD" />
            </linearGradient>
            <filter id="clicky-cursor-glow" x="-60%" y="-60%" width="220%" height="220%">
              <feGaussianBlur in="SourceAlpha" stdDeviation="2" result="blur" />
              <feFlood floodColor="#44CCFF" floodOpacity="0.5" result="color" />
              <feComposite in="color" in2="blur" operator="in" result="outerGlow" />
              <feMerge>
                <feMergeNode in="outerGlow" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>
          {/* Simple triangle cursor — tip at (1,1), flat left edge, points upper-left */}
          <path
            d="M1,1 L1,18 L15,9 Z"
            fill="url(#clicky-cursor-grad)"
            filter="url(#clicky-cursor-glow)"
            stroke="rgba(220,245,255,0.3)"
            strokeWidth="0.5"
            strokeLinejoin="round"
          />
        </svg>
      </div>
    </div>
  )
}

// ─── CSS injection ────────────────────────────────────────────────────────────

function injectBreathingKeyframes(): void {
  if (document.getElementById('clicky-orb-styles') !== null) return

  const styleElement = document.createElement('style')
  styleElement.id = 'clicky-orb-styles'
  styleElement.textContent = `
    @keyframes clicky-orb-breathe {
      0%, 100% { transform: scale(1); opacity: 0.85; }
      50%       { transform: scale(1.18); opacity: 1; }
    }
  `
  document.head.appendChild(styleElement)
}
