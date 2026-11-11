// The confirmation's arming delay. A client can time a call so the confirmation window appears under
// a click the person was already making in another app. So Allow stays off for CONFIRM_ARM_MS after
// the window mounts, and again whenever it regains focus or becomes visible, as browser permission
// prompts do. The main process enforces the same delay on its side.

import { useEffect, useState } from 'react'

/**
 * False until `delayMs` has passed since mount, and false again from the moment the window loses
 * focus or is hidden until `delayMs` after it comes back.
 */
export function useArmed(delayMs: number): boolean {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const disarm = () => {
      clearTimeout(timer)
      setArmed(false)
    }
    const restart = () => {
      disarm()
      timer = setTimeout(() => setArmed(true), delayMs)
    }
    const onVisibility = () => (document.visibilityState === 'visible' ? restart() : disarm())
    restart()
    window.addEventListener('focus', restart)
    window.addEventListener('blur', disarm)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('focus', restart)
      window.removeEventListener('blur', disarm)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [delayMs])
  return armed
}
