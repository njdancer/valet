import './styles/tokens.css'
import './styles/app.css'
import './styles/controls.css'
import './styles/screens.css'
import { boot, devFake } from './boot'
import { ControlPanel } from './control/App'

const root = document.getElementById('root')
if (root !== null) void boot(<ControlPanel />, root, window, devFake)
