import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { initializeAppUpdate } from './lib/appUpdate'
import App from './family/FamilyApp'
import './appStyles'

initializeAppUpdate()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
