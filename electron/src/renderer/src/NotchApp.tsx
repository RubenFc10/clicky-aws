import React, { useState, useEffect, useRef, useCallback } from 'react'
import { NOTCH_STATE, SESSION_STATE } from '../../shared/sessionTypes'
import type { NotchState, SessionState, SessionPayload } from '../../shared/sessionTypes'
import { AudioRecorderService } from './services/AudioRecorderService'

// ─── Model configuration ──────────────────────────────────────────────────────

const MODEL_OPTIONS = [
  { value: 'haiku-4.5',  label: 'Haiku',  badge: 'FAST'  },
  { value: 'sonnet-4.6', label: 'Sonnet', badge: 'SMART' },
  { value: 'opus-4.6',   label: 'Opus',   badge: 'BEST'  },
] as const

type ModelValue = typeof MODEL_OPTIONS[number]['value']
const VALID_MODEL_VALUES = MODEL_OPTIONS.map(m => m.value) as readonly string[]

function loadSavedModel(): ModelValue {
  const saved = localStorage.getItem('clicky-model')
  return saved !== null && VALID_MODEL_VALUES.includes(saved) ? (saved as ModelValue) : 'haiku-4.5'
}

// ─── Island geometry ──────────────────────────────────────────────────────────

// Compact pill dimensions — matches DynamicNotch baseWidth/baseHeight
const COMPACT_W  = 190
const COMPACT_H  = 38
const COMPACT_R  = 19   // bottom corner radius

// Expanded card dimensions
const EXPANDED_W = 440
const EXPANDED_H = 240
const EXPANDED_R = 24   // bottom corner radius

// ─── NotchApp ─────────────────────────────────────────────────────────────────

export default function NotchApp(): React.JSX.Element {
  const [notchState, setNotchState]     = useState<NotchState>(NOTCH_STATE.COLLAPSED)
  const [sessionState, setSessionState] = useState<SessionState>(SESSION_STATE.IDLE)
  const [selectedModel, setSelectedModel] = useState<ModelValue>(loadSavedModel)
  const [lastPayload, setLastPayload]   = useState<SessionPayload | null>(null)
  const [audioLevel, setAudioLevel]     = useState(0)   // 0-1, for the level bar
  const [recordSeconds, setRecordSeconds] = useState(0) // elapsed recording time

  const audioServiceRef  = useRef(new AudioRecorderService())
  const recordTimerRef   = useRef<ReturnType<typeof setInterval> | null>(null)
  const recordStartRef   = useRef<number>(0)

  // Track expansion direction so we can apply the correct easing
  const prevNotchStateRef = useRef<NotchState>(NOTCH_STATE.COLLAPSED)

  useEffect(() => { injectIslandStyles() }, [])

  // IPC listeners
  useEffect(() => {
    const cleanupNotch   = window.electronAPI.onNotchStateChanged((s) => {
      prevNotchStateRef.current = notchState
      setNotchState(s)
    })
    const cleanupSession = window.electronAPI.onSessionStateChanged((s) => {
      setSessionState(s)
      handleAudioLifecycle(s)
    })
    const cleanupPayload = window.electronAPI.onSessionPayloadReady((p) => {
      setLastPayload(p)
    })
    const cleanupCancel  = window.electronAPI.onSessionCancelled(() => {
      audioServiceRef.current.cancelRecording()
    })
    return () => { cleanupNotch(); cleanupSession(); cleanupPayload(); cleanupCancel() }
  }, [notchState])

  function handleAudioLifecycle(state: SessionState): void {
    if (state === SESSION_STATE.RECORDING_AND_TRACKING) {
      recordStartRef.current = Date.now()
      setRecordSeconds(0)
      recordTimerRef.current = setInterval(() => {
        setRecordSeconds(Math.floor((Date.now() - recordStartRef.current) / 1000))
      }, 1000)
      audioServiceRef.current.startRecording().catch((err) => {
        console.error('[NotchApp] mic failed:', err)
      })
    } else {
      if (recordTimerRef.current !== null) {
        clearInterval(recordTimerRef.current)
        recordTimerRef.current = null
      }
      if (state === SESSION_STATE.FINALIZING) {
        audioServiceRef.current.stopRecording().catch(() => {})
      } else if (state === SESSION_STATE.IDLE) {
        audioServiceRef.current.cancelRecording()
        setRecordSeconds(0)
        setAudioLevel(0)
      }
    }
  }

  const handleModelSelect = useCallback((v: ModelValue) => {
    setSelectedModel(v)
    localStorage.setItem('clicky-model', v)
  }, [])

  const handleMouseEnter = useCallback(() => {
    window.electronAPI.requestNotchState(NOTCH_STATE.EXPANDED)
  }, [])

  const handleMouseLeave = useCallback(() => {
    window.electronAPI.requestNotchState(NOTCH_STATE.PROXIMITY)
  }, [])

  const isRecording  = sessionState === SESSION_STATE.RECORDING_AND_TRACKING
  const isProcessing = sessionState === SESSION_STATE.FINALIZING || sessionState === SESSION_STATE.PROCESSING
  const isExpanded   = notchState === NOTCH_STATE.EXPANDED

  if (notchState === NOTCH_STATE.COLLAPSED) return <></>

  return (
    <div style={rootStyle}>
      <Island
        isExpanded={isExpanded}
        isRecording={isRecording}
        isProcessing={isProcessing}
        audioLevel={audioLevel}
        recordSeconds={recordSeconds}
        selectedModel={selectedModel}
        lastPayload={lastPayload}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        onModelSelect={handleModelSelect}
      />
    </div>
  )
}

// ─── Island component (single morphing element) ───────────────────────────────

type IslandProps = {
  isExpanded: boolean
  isRecording: boolean
  isProcessing: boolean
  audioLevel: number
  recordSeconds: number
  selectedModel: ModelValue
  lastPayload: SessionPayload | null
  onMouseEnter: () => void
  onMouseLeave: () => void
  onModelSelect: (v: ModelValue) => void
}

function Island({
  isExpanded, isRecording, isProcessing, audioLevel, recordSeconds,
  selectedModel, lastPayload, onMouseEnter, onMouseLeave, onModelSelect,
}: IslandProps): React.JSX.Element {
  const hasActivity = isRecording || isProcessing

  // Easing for the shape morph depends on direction
  const expandEase  = 'cubic-bezier(0.34, 1.56, 0.64, 1)'  // bouncy spring
  const collapseEase = 'cubic-bezier(0.25, 1, 0.5, 1)'      // crisp ease-out

  const morphDuration = isExpanded ? '460ms' : '280ms'
  const morphEase     = isExpanded ? expandEase : collapseEase

  const islandStyle: React.CSSProperties = {
    position: 'relative',
    width:  isExpanded ? EXPANDED_W : COMPACT_W,
    height: isExpanded ? EXPANDED_H : COMPACT_H,
    background: '#050505',
    borderRadius: `0 0 ${isExpanded ? EXPANDED_R : COMPACT_R}px ${isExpanded ? EXPANDED_R : COMPACT_R}px`,
    boxShadow: isExpanded
      ? '0 16px 56px rgba(0,0,0,0.92), 0 4px 24px rgba(0,0,0,0.6), inset 0 -1px 0 rgba(255,255,255,0.10), inset 1px 0 0 rgba(255,255,255,0.07), inset -1px 0 0 rgba(255,255,255,0.07)'
      : '0 4px 20px rgba(0,0,0,0.65), inset 0 -1px 0 rgba(255,255,255,0.08), inset 1px 0 0 rgba(255,255,255,0.05), inset -1px 0 0 rgba(255,255,255,0.05)',
    overflow: 'hidden',
    pointerEvents: 'auto',
    userSelect: 'none',
    transition: [
      `width ${morphDuration} ${morphEase}`,
      `height ${morphDuration} ${morphEase}`,
      `border-radius ${morphDuration} ${morphEase}`,
      `box-shadow 300ms ease`,
    ].join(', '),
  }

  // Compact content: visible when pill, hidden when expanded
  const compactContentStyle: React.CSSProperties = {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0 12px 0 10px',
    opacity: isExpanded ? 0 : 1,
    transition: isExpanded ? 'opacity 80ms ease' : 'opacity 150ms ease 180ms',
    pointerEvents: isExpanded ? 'none' : 'auto',
  }

  // Expanded content: visible only when expanded, appears after spring settles
  const expandedContentStyle: React.CSSProperties = {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    flexDirection: 'column',
    padding: '14px 16px 14px',
    opacity: isExpanded ? 1 : 0,
    transition: isExpanded ? 'opacity 180ms ease 260ms' : 'opacity 60ms ease',
    pointerEvents: isExpanded ? 'auto' : 'none',
  }

  const dotColor = isRecording ? '#FF453A' : isProcessing ? '#FF9F0A' : '#30D158'

  const compactDotStyle: React.CSSProperties = {
    width: 6, height: 6,
    borderRadius: '50%',
    background: dotColor,
    flexShrink: 0,
    animation: hasActivity ? 'island-dot-pulse 1s ease-in-out infinite' : 'none',
  }

  return (
    <div
      style={islandStyle}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {/* ── Compact pill content ── */}
      <div style={compactContentStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <div style={compactDotStyle} />
          <span style={compactLabelStyle}>Clicky</span>
          {hasActivity && (
            <span style={compactStatusStyle}>
              {isRecording ? 'Recording' : 'Processing'}
            </span>
          )}
        </div>
        {isRecording && <WaveformBars small />}
      </div>

      {/* ── Expanded card content ── */}
      <div style={expandedContentStyle}>
        <ExpandedContent
          isRecording={isRecording}
          isProcessing={isProcessing}
          audioLevel={audioLevel}
          recordSeconds={recordSeconds}
          selectedModel={selectedModel}
          lastPayload={lastPayload}
          onModelSelect={onModelSelect}
        />
      </div>
    </div>
  )
}

// ─── Expanded content layout ──────────────────────────────────────────────────

type ExpandedContentProps = {
  isRecording: boolean
  isProcessing: boolean
  audioLevel: number
  recordSeconds: number
  selectedModel: ModelValue
  lastPayload: SessionPayload | null
  onModelSelect: (v: ModelValue) => void
}

function ExpandedContent({
  isRecording, isProcessing, audioLevel, recordSeconds,
  selectedModel, lastPayload, onModelSelect,
}: ExpandedContentProps): React.JSX.Element {
  const isActive   = isRecording || isProcessing
  const dotColor   = isRecording ? '#FF453A' : isProcessing ? '#FF9F0A' : '#30D158'
  const statusText = isRecording ? 'Recording' : isProcessing ? 'Processing…' : 'Ready'
  const shortcutHint = isRecording ? 'Release to send' : isProcessing ? 'Analysing…' : 'Hold to capture'

  return (
    <>
      {/* ── Row 1: Icon + title/status + waveform ── */}
      <div style={row1Style}>
        <ClickyIcon dotColor={dotColor} isActive={isActive} />
        <div style={titleBlockStyle}>
          <span style={expandedTitleStyle}>Clicky</span>
          <span style={expandedSubtitleStyle}>{statusText}</span>
        </div>
        <div style={row1RightStyle}>
          {isRecording && <WaveformBars />}
          {isProcessing && <SpinnerDots />}
        </div>
      </div>

      {/* ── Thin separator ── */}
      <div style={separatorStyle} />

      {/* ── Row 2: Audio level / progress ── */}
      <div style={row2Style}>
        <LevelBar level={audioLevel} isRecording={isRecording} isProcessing={isProcessing} />
        <div style={row2LabelsStyle}>
          <span style={row2LabelStyle}>
            {isRecording
              ? formatSeconds(recordSeconds)
              : lastPayload !== null
                ? `${lastPayload.durationMs}ms`
                : 'CTRL + ALT'}
          </span>
          <span style={row2HintStyle}>{shortcutHint}</span>
        </div>
      </div>

      {/* ── Thin separator ── */}
      <div style={separatorStyle} />

      {/* ── Row 3: Model selector ── */}
      <div style={row3Style}>
        {MODEL_OPTIONS.map((opt) => {
          const isSel = selectedModel === opt.value
          return (
            <button
              key={opt.value}
              style={getModelButtonStyle(isSel)}
              onClick={() => onModelSelect(opt.value)}
            >
              <span style={modelNameStyle}>{opt.label}</span>
              <span style={getModelBadgeStyle(isSel)}>{opt.badge}</span>
            </button>
          )
        })}
      </div>
    </>
  )
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function ClickyIcon({ dotColor, isActive }: { dotColor: string; isActive: boolean }): React.JSX.Element {
  return (
    <div style={iconBoxStyle}>
      {/* "C" lettermark */}
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" style={{ display: 'block' }}>
        <path
          d="M14 6.5C13 5.3 11.6 4.5 10 4.5C7 4.5 4.5 7 4.5 10C4.5 13 7 15.5 10 15.5C11.6 15.5 13 14.7 14 13.5"
          stroke="white"
          strokeWidth="1.8"
          strokeLinecap="round"
          fill="none"
          opacity="0.9"
        />
      </svg>
      {/* Status dot */}
      <div style={{
        position: 'absolute',
        bottom: 1,
        right: 1,
        width: 7,
        height: 7,
        borderRadius: '50%',
        background: dotColor,
        border: '1.5px solid #050505',
        animation: isActive ? 'island-dot-pulse 1s ease-in-out infinite' : 'none',
      }} />
    </div>
  )
}

function WaveformBars({ small = false }: { small?: boolean }): React.JSX.Element {
  const count   = small ? 3 : 5
  const heights = [0.5, 1.0, 0.7, 0.9, 0.55]  // relative heights
  const w       = small ? 2 : 2.5
  const maxH    = small ? 10 : 14
  const gap     = small ? 2 : 2.5

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap, height: maxH }}>
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          style={{
            width: w,
            height: maxH * heights[i % heights.length],
            borderRadius: 2,
            background: '#FF453A',
            opacity: 0.9,
            animation: `island-wave-${(i % 4) + 1} 0.9s ease-in-out infinite`,
            animationDelay: `${i * 0.12}s`,
          }}
        />
      ))}
    </div>
  )
}

function SpinnerDots(): React.JSX.Element {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          style={{
            width: 4,
            height: 4,
            borderRadius: '50%',
            background: '#FF9F0A',
            animation: 'island-spinner-dot 1.1s ease-in-out infinite',
            animationDelay: `${i * 0.2}s`,
          }}
        />
      ))}
    </div>
  )
}

function LevelBar({ level, isRecording, isProcessing }: { level: number; isRecording: boolean; isProcessing: boolean }): React.JSX.Element {
  const color  = isRecording ? '#FF453A' : isProcessing ? '#FF9F0A' : '#30D158'
  const fillW  = isProcessing ? undefined : `${Math.max(2, level * 100)}%`

  return (
    <div style={levelTrackStyle}>
      <div style={{
        height: '100%',
        width: fillW,
        background: color,
        borderRadius: 2,
        opacity: (isRecording || isProcessing) ? 1 : 0.3,
        transition: 'width 80ms ease, opacity 300ms ease',
        animation: isProcessing ? 'island-processing-bar 1.6s ease-in-out infinite' : 'none',
      }} />
    </div>
  )
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatSeconds(s: number): string {
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const rootStyle: React.CSSProperties = {
  width: '100vw',
  height: '100vh',
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'center',
  overflow: 'hidden',
  pointerEvents: 'none',
}

// ── Compact ──

const compactLabelStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: 'rgba(255,255,255,0.88)',
  fontFamily: '-apple-system, "SF Pro Text", system-ui, sans-serif',
  letterSpacing: '0.01em',
}

const compactStatusStyle: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 400,
  color: 'rgba(255,255,255,0.38)',
  fontFamily: '-apple-system, "SF Pro Text", system-ui, sans-serif',
}

// ── Expanded row 1 ──

const row1Style: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  flexShrink: 0,
}

const iconBoxStyle: React.CSSProperties = {
  position: 'relative',
  width: 36,
  height: 36,
  borderRadius: 10,
  background: 'rgba(255,255,255,0.07)',
  border: '1px solid rgba(255,255,255,0.09)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
}

const titleBlockStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 1,
  flex: 1,
  minWidth: 0,
}

const expandedTitleStyle: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 700,
  color: 'rgba(255,255,255,0.92)',
  fontFamily: '-apple-system, "SF Pro Display", system-ui, sans-serif',
  letterSpacing: '-0.01em',
  lineHeight: 1.2,
}

const expandedSubtitleStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 400,
  color: 'rgba(255,255,255,0.38)',
  fontFamily: '-apple-system, "SF Pro Text", system-ui, sans-serif',
  lineHeight: 1.3,
}

const row1RightStyle: React.CSSProperties = {
  flexShrink: 0,
  display: 'flex',
  alignItems: 'center',
  minWidth: 40,
  justifyContent: 'flex-end',
}

// ── Separator ──

const separatorStyle: React.CSSProperties = {
  height: 1,
  background: 'rgba(255,255,255,0.055)',
  borderRadius: 1,
  flexShrink: 0,
  margin: '10px 0',
}

// ── Row 2 ──

const row2Style: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  flexShrink: 0,
}

const levelTrackStyle: React.CSSProperties = {
  height: 3,
  background: 'rgba(255,255,255,0.08)',
  borderRadius: 2,
  overflow: 'hidden',
}

const row2LabelsStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
}

const row2LabelStyle: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 500,
  fontFamily: '-apple-system, "SF Pro Text", system-ui, sans-serif',
  color: 'rgba(255,255,255,0.32)',
  letterSpacing: '0.03em',
  fontVariantNumeric: 'tabular-nums',
}

const row2HintStyle: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 400,
  color: 'rgba(255,255,255,0.22)',
  fontFamily: '-apple-system, "SF Pro Text", system-ui, sans-serif',
}

// ── Row 3: model pills ──

const row3Style: React.CSSProperties = {
  display: 'flex',
  gap: 5,
  flexShrink: 0,
}

function getModelButtonStyle(isSelected: boolean): React.CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    padding: '5px 10px',
    borderRadius: 7,
    border: isSelected
      ? '1px solid rgba(10,132,255,0.45)'
      : '1px solid rgba(255,255,255,0.08)',
    background: isSelected
      ? 'rgba(10,132,255,0.16)'
      : 'rgba(255,255,255,0.04)',
    color: isSelected
      ? 'rgba(10,132,255,1)'
      : 'rgba(255,255,255,0.42)',
    cursor: 'pointer',
    fontFamily: '-apple-system, "SF Pro Text", system-ui, sans-serif',
    fontSize: 12,
    transition: 'background 150ms ease, color 150ms ease, border-color 150ms ease',
    whiteSpace: 'nowrap',
    pointerEvents: 'auto',
  }
}

const modelNameStyle: React.CSSProperties = {
  fontWeight: 600,
}

function getModelBadgeStyle(isSelected: boolean): React.CSSProperties {
  return {
    fontSize: 8.5,
    fontWeight: 700,
    letterSpacing: '0.07em',
    opacity: isSelected ? 0.72 : 0.38,
  }
}

// ─── CSS injection ────────────────────────────────────────────────────────────

function injectIslandStyles(): void {
  if (document.getElementById('clicky-island-styles') !== null) return
  const el = document.createElement('style')
  el.id = 'clicky-island-styles'
  el.textContent = `
    /* Activity dot pulse */
    @keyframes island-dot-pulse {
      0%, 100% { opacity: 1;    transform: scale(1); }
      50%       { opacity: 0.4; transform: scale(0.8); }
    }

    /* Waveform bars — 4 variants so each bar moves out of phase */
    @keyframes island-wave-1 {
      0%, 100% { transform: scaleY(0.4); } 50% { transform: scaleY(1.0); }
    }
    @keyframes island-wave-2 {
      0%, 100% { transform: scaleY(0.7); } 50% { transform: scaleY(0.5); }
    }
    @keyframes island-wave-3 {
      0%, 100% { transform: scaleY(1.0); } 50% { transform: scaleY(0.35); }
    }
    @keyframes island-wave-4 {
      0%, 100% { transform: scaleY(0.5); } 50% { transform: scaleY(0.9); }
    }

    /* Processing spinner dots */
    @keyframes island-spinner-dot {
      0%, 80%, 100% { opacity: 0.2; transform: scale(0.8); }
      40%           { opacity: 1;   transform: scale(1); }
    }

    /* Processing bar sweep when no real level data */
    @keyframes island-processing-bar {
      0%   { width: 0%;   opacity: 0.6; }
      50%  { width: 72%;  opacity: 1; }
      100% { width: 0%;   opacity: 0.6; }
    }
  `
  document.head.appendChild(el)
}
