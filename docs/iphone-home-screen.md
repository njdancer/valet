# iPhone home screen

Valet saves the home screen layout of an iPhone plugged in to the Mac by USB, keeps it after the
phone is unplugged, and lets agents study it and plan a new one. Built-in tools under
**iPhone home screen** (`apps/desktop/src/main/core/iphone.ts`, `packages/iphone`).

- **How it talks to the phone.** The Mac's own usbmuxd (`/var/run/usbmuxd`), lockdownd with the
  pair record the Mac already holds (the phone must have trusted the Mac), then SpringBoard's
  service, `com.apple.springboardservices`, the same one libimobiledevice and pymobiledevice3 use.
  It is not a supported Apple API. Our own TypeScript client and plist codec, no dependencies.
- **Saving.** Whenever a phone is plugged in by USB, Valet reads its layout (and app icons, and
  the wallpaper) by itself, retrying for ten minutes while the phone is locked. `iphone_snapshot`
  does the same on request. Each snapshot keeps the phone's raw layout exactly as it came
  (`<data>/iphone/snapshots/<id>.plist`); 30 are kept, backups taken before a write forever.
- **The proposal** is Valet's own file (`<data>/iphone/proposal.json`). Agents change it with
  `iphone_edit` (move, set a page or the dock, make, rename or empty folders, add or move pages),
  `iphone_name_pages`, `iphone_plan_focus`, `iphone_undo` and `iphone_reset`. Nothing is ever added
  or taken off the home screen. Every change bumps its revision; previews redraw on it.
- **Putting it on the phone** (`iphone_apply`): only with Touch ID at the Mac (an
  `irreversible-call` approval), the phone plugged in and unlocked, and its layout unchanged since
  the proposal started. Valet saves a backup first, writes, reads the layout back and says what
  iOS changed. Each item is written back from its own raw entry, so widget settings Valet doesn't
  understand go back as they were.
- **What it can't do.** Focus settings can't be read or set: `iphone_plan_focus` records the plan
  and gives the person a checklist for Settings › Focus. Whether widgets survive a write is
  unproven. Icons always fill from the top left, so gaps aren't possible. iOS may reflow icons after
  a write.
