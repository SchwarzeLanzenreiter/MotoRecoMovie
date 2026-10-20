import { createRoot } from 'react-dom/client'
import { App } from './ui/App'
import { runAutotest } from './autotest'

createRoot(document.getElementById('root')!).render(<App />)
runAutotest()
