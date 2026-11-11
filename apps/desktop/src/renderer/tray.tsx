import './styles/app.css'
import { boot, devFake } from './boot'
import { TrayPopover } from './tray/TrayPopover'

document.documentElement.dataset['window'] = 'tray'
const root = document.getElementById('root')
if (root !== null) void boot(<TrayPopover />, root, window, devFake)
