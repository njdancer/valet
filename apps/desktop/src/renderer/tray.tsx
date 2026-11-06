import './styles/tokens.css'
import './styles/app.css'
import './styles/controls.css'
import './styles/screens.css'
import { boot, devFake } from './boot'
import { TrayPopover } from './tray/TrayPopover'

const root = document.getElementById('root')
if (root !== null) void boot(<TrayPopover />, root, window, devFake)
