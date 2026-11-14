# Changelog

## 1.2.0

First release as a Home Assistant app. It replaces the ADS-B Tracker custom
integration (frontend 1.1.1, backend 1.0.0) and can run beside it while you try it.
See [Moving from the custom integration](DOCS.md#moving-from-the-custom-integration).

**New**

- **Installs from the app store**, with an **ADS-B** sidebar entry. It needs no
  Home Assistant access, YAML or files in `www/`.
- **Tracking stops by itself when the flight is over.** Earlier versions followed
  the aircraft, not the flight, and kept a saved flight forever. Reopening the next
  day could show the same plane on a different trip under your old flight number.
  Now tracking stops, with a message, when:
  - the aircraft starts broadcasting a different flight number,
  - it has been on the ground for 15 minutes after flying, or
  - there has been no position for 2 hours.

  A saved flight more than 12 hours old isn't resumed. Searching by registration or
  ICAO hex still follows the airframe from flight to flight.
- **Flight status** at a glance: on the ground, climbing, in flight, descending,
  landed or signal lost. Also the distance flown so far, speed in mph as well as
  knots, compass heading, and a red warning for emergency squawks (7500, 7600, 7700).
- **Light and dark appearance**, following your device or chosen with the button in
  the header.
- **More airlines** convert from ticket numbers to broadcast callsigns, including the
  big US regionals (SkyWest, Republic, Envoy, Endeavor and others), Canada, Mexico,
  and the main European and Asian carriers.

**Changed**

- **The map fills the screen.** The flight card, aircraft list and help sit beside
  it, or below it on a phone.
- **Flight search is the main control.** The aircraft filter moved into the aircraft
  list, where it belongs.
- **Following doesn't fight you.** Dragging the map stops following, and a **Follow
  flight** button brings it back. The map only moves when the aircraft does.
- **The map presets no longer stop tracking.** Lower 48, Alaska and Hawaii just move
  the map. Earlier versions cleared your flight.
- **One status line** instead of the same message in three places. The airspace
  overview card is gone; its counts are in the aircraft list header.
- **The help is a short, collapsible list.**
- Removed **Regional view**, which jumped to a fixed point in Southern California.
  Use **Scan map here** instead.

**Fixed**

- **No more false one-minute freezes.** The old backend answered "rate limited" to a
  second lookup that arrived within 1.1 seconds of another one, for example two open
  tabs, or a search right after an update. The page then stopped every tab for 60
  seconds. Now that request just waits its turn, and the page only pauses for a
  cooldown that adsb.fi actually asked for.
- **adsb.fi's Retry-After is honoured exactly**, whether it gives seconds or a date,
  with no minimum added. The cooldown survives an app restart, and the page counts
  down from the real number.
- **Leaflet is part of the app** instead of loading from unpkg, so the map works
  when that CDN is slow or blocked.
- **The whole page works under Home Assistant ingress.** Every link is relative,
  and nothing reaches into Home Assistant's own page.
