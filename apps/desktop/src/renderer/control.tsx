import './styles/app.css'
import { boot, devFake } from './boot'
import { ControlPanel } from './control/App'

const root = document.getElementById('root')
if (root !== null) void boot(<ControlPanel />, root, window, devFake)
