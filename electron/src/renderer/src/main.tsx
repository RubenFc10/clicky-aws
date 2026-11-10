import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './global.css'

// window.electronAPI is typed via the global declaration in src/shared/ipcTypes.ts
ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
