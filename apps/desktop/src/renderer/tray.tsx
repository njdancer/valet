import './styles/app.css'
import { boot, devFake } from './boot'
import { TrayPopover } from './tray/TrayPopover'

document.documentElement.dataset['window'] = 'tray'
const root = document.getElementById('root')
/** The mounted page; tests unmount it before their window goes. */
export const mounted = root === null ? null : boot(<TrayPopover />, root, window, devFake)
