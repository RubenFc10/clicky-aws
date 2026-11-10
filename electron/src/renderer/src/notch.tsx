import React from 'react'
import ReactDOM from 'react-dom/client'
import NotchApp from './NotchApp'

// window.electronAPI is typed via the global declaration in src/shared/ipcTypes.ts

const rootElement = document.getElementById('root')
if (rootElement === null) {
  throw new Error('[notch] #root element not found — check notch.html')
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <NotchApp />
  </React.StrictMode>
)
