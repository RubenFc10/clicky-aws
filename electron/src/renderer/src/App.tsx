import React from 'react'
import { CursorFollower } from './CursorFollower'
import { DrawingCanvas } from './DrawingCanvas'

// Overlay window renderer — renders a click-through layer per display.
// - CursorFollower: red orb that tracks the cursor with spring physics
// - DrawingCanvas:  captures and annotates mouse strokes during sessions
function App(): React.JSX.Element {
  return (
    <>
      <CursorFollower />
      <DrawingCanvas />
    </>
  )
}

export default App
