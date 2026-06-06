# PUBG Mortar Distance Calculator

Simple screen overlay tool. Calculates mortar distance by measuring pixel distance between 2 points and converting to in-game meters.

## Setup

```
npm install
npm start
```

Requires Node.js + npm installed.

## Build (Windows .exe)

```
npm run dist
```

The portable .exe is generated in the `dist` folder.

## Usage

1. **Calibrate**: Set how many on-screen pixels = 100m in-game.
   - In PUBG, open map, find the white 100x100 grid square
   - Measure how many pixels wide it is on your screen (e.g. 50px)
   - Enter that number in the "100m = ? pixels" field

2. **Keybind**: Default is `Alt+Z`. Change if needed, click Set.

3. **Measure**: Press your keybind while hovering over PUBG
   - An overlay appears — click Point A (mortar position), then Point B (target)
   - Distance shows in the main window
   - ESC to cancel

4. **Discord**: Paste your webhook URL, click "Send to Discord"

## Math

```
pixel_distance = sqrt((x2-x1)^2 + (y2-y1)^2)   <- Pythagorean
ingame_distance = (pixel_distance / pixels_per_100m) * 100
```

No game data is read. Pure screen pixel measurement.

## Notes

- Window stays visible while PUBG is running (always-on-top not set on main window by default)
- The transparent overlay only appears during capture, then disappears
- Minimizing the main window hides it to the tray; click the tray icon to show it again
- Settings (webhook, pixels, keybind) are auto-saved in localStorage
