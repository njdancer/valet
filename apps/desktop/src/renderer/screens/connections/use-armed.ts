// Arming, as the confirmation panel does it: a button that approves stays disabled for `delayMs`
// after it appears and whenever the window comes back, so a click already on its way (or a key
// held from another window) can't land on it.

import { useEffect, useState } from 'react'

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
