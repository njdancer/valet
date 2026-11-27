import './styles/app.css'
import { boot, devFake } from './boot'
import { ControlPanel } from './control/App'

const root = document.getElementById('root')
/** The mounted page; tests unmount it before their window goes. */
export const mounted = root === null ? null : boot(<ControlPanel />, root, window, devFake)
