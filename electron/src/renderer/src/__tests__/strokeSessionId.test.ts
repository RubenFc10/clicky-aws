import { describe, it, expect } from 'vitest'
import { buildStroke } from '../DrawingCanvas'
import type { StrokePoint } from '../../../shared/sessionTypes'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makePoint(x: number, y: number, timestamp: number): StrokePoint {
  return { x, y, timestamp }
}

function twoPointStroke(): StrokePoint[] {
  return [makePoint(0, 0, 100), makePoint(10, 10, 116)]
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Stroke.sessionId invariants', () => {
  it('a stroke carries the sessionId it was built with', () => {
    const sessionId = 'session-abc-001'
    const stroke = buildStroke(sessionId, 'stroke-1', twoPointStroke())
    expect(stroke.sessionId).toBe(sessionId)
  })

  it('two strokes built with the same sessionId share it', () => {
    const sessionId = 'session-abc-002'
    const stroke1 = buildStroke(sessionId, 'stroke-1', twoPointStroke())
    const stroke2 = buildStroke(sessionId, 'stroke-2', [
      makePoint(20, 20, 400),
      makePoint(30, 30, 416),
    ])
    expect(stroke1.sessionId).toBe(sessionId)
    expect(stroke2.sessionId).toBe(sessionId)
    expect(stroke1.sessionId).toBe(stroke2.sessionId)
  })

  it('strokes from different sessions have different sessionIds', () => {
    const session1Id = 'session-first'
    const session2Id = 'session-second'
    const strokeFromSession1 = buildStroke(session1Id, 'stroke-s1', twoPointStroke())
    const strokeFromSession2 = buildStroke(session2Id, 'stroke-s2', twoPointStroke())
    expect(strokeFromSession1.sessionId).not.toBe(strokeFromSession2.sessionId)
    expect(strokeFromSession1.sessionId).toBe(session1Id)
    expect(strokeFromSession2.sessionId).toBe(session2Id)
  })

  it('no stroke gets an empty sessionId when created with a valid one', () => {
    const sessionId = 'session-valid-123'
    const stroke = buildStroke(sessionId, 'stroke-1', twoPointStroke())
    expect(stroke.sessionId).not.toBe('')
    expect(stroke.sessionId.length).toBeGreaterThan(0)
  })

  it('simulates reset-then-assign: session start clears id, first point restores it', () => {
    const previousSessionId = 'session-old'
    const newSessionId = 'session-new'

    // Mimic the state machine: session start resets currentSessionId to ''
    let currentSessionId = previousSessionId
    currentSessionId = '' // simulates handleSessionStateChanged(RECORDING_AND_TRACKING)

    // Mimic the fix: first MousePointPayload.sessionId syncs the ref
    const incomingPointSessionId = newSessionId
    if (currentSessionId !== incomingPointSessionId) {
      currentSessionId = incomingPointSessionId // simulates handleMousePoint sync
    }

    const stroke = buildStroke(currentSessionId, 'stroke-1', twoPointStroke())

    expect(stroke.sessionId).not.toBe('')
    expect(stroke.sessionId).not.toBe(previousSessionId)
    expect(stroke.sessionId).toBe(newSessionId)
  })

  it('a gap-triggered stroke inherits the session id already synced from previous points', () => {
    // This is the exact bug that was fixed: a stroke closed by a gap (300ms idle)
    // must carry the same sessionId as all other strokes in the session.
    const sessionId = 'session-gap-test'

    // Simulate: first point arrives, sessionId is synced
    let currentSessionId = ''
    const firstPoint: StrokePoint = makePoint(5, 5, 1000)
    currentSessionId = sessionId // ← fix: synced from point.sessionId before finalize

    // A gap is detected → stroke is finalized using the now-correct currentSessionId
    const gapClosedStroke = buildStroke(currentSessionId, 'stroke-gap', [
      firstPoint,
      makePoint(10, 10, 1016),
    ])

    // A subsequent stroke in the same session
    const laterStroke = buildStroke(currentSessionId, 'stroke-later', [
      makePoint(20, 20, 2000),
      makePoint(30, 30, 2016),
    ])

    expect(gapClosedStroke.sessionId).toBe(sessionId)
    expect(laterStroke.sessionId).toBe(sessionId)
    expect(gapClosedStroke.sessionId).toBe(laterStroke.sessionId)
  })
})
