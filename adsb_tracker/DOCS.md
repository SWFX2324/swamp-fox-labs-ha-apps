# ADS-B Tracker

Follow a flight anywhere in the world from public ADS-B data. Made for the
"is Mom's plane in the air yet, and where is it now?" kind of question: type the flight
number from the ticket, and the app finds the aircraft and keeps the map on it from
take-off to landing.

It adds an **ADS-B** panel to the Home Assistant sidebar. There's nothing to set up
and it changes nothing in Home Assistant.

## Contents

- [Getting started](#getting-started)
- [Finding a flight](#finding-a-flight)
- [While a flight is tracked](#while-a-flight-is-tracked)
- [Looking around an area](#looking-around-an-area)
- [How often it updates](#how-often-it-updates)
- [Appearance](#appearance)
- [Moving from the custom integration](#moving-from-the-custom-integration)
- [Troubleshooting and FAQ](#troubleshooting-and-faq)
- [Security and privacy](#security-and-privacy)
- [Data sources and credits](#data-sources-and-credits)

## Getting started

1. Add this repository to Home Assistant (see the [repository README](../README.md)),
   then install **ADS-B Tracker** from the app store.
2. Start it. **Show in sidebar** is on by default.
3. Open **ADS-B** in the sidebar.

To put it next to **Ham Radio**, open your profile and choose **Change the order and
hide items from the sidebar** (or press and hold the sidebar title), then drag
**ADS-B** where you want it. The order is saved per user, on each device.

## Finding a flight

Pick what you're searching by, type it, and press **Find & track** (or Enter):

| Search by | Example | Notes |
| --- | --- | --- |
| **Flight number** | `AA1920`, `DL 789` | The number on the ticket. Most US airlines, the big US regionals and major international carriers are converted to the callsign the aircraft broadcasts (AA1920 → AAL1920). |
| **Callsign** | `AAL1920`, `SKW5123` | Exactly what the aircraft broadcasts. Use this for airlines the app doesn't convert. |
| **Registration** | `N195UW` | The tail number. Follows that airframe from flight to flight. |
| **ICAO hex** | `A17C95` | The aircraft's six-character transponder address. Also follows the airframe. |

- **One match** is locked on straight away. It's shown alone (**Isolate**) and the
  map follows it (**Follow**).
- **Several matches** (it happens with reused callsigns) are listed. Pick the right
  one and press **Track this flight**.
- **No match** usually means the flight hasn't taken off or switched its transponder
  on yet. It can also mean the flight broadcasts a different callsign, or it's outside
  public coverage. The app checks again every minute, so you can search before
  departure and leave the page open.

**Codeshares and regional flights.** A ticket for "AA 5123" may be flown by a
regional airline that broadcasts its own callsign, for example `ENY5123`, `RPA5123`,
`SKW5123`, `EDV5123` or `PDT5123`. If the flight number finds nothing, search the
operating airline's callsign. The airline's app or your booking usually says "operated
by…".

The app knows nothing about schedules, routes, gates or arrival times. It shows only
positions that receivers actually picked up.

## While a flight is tracked

The **Tracking** card shows:

- **Status:** On the ground, Climbing, In flight, Descending, Landed or Signal lost.
  An emergency squawk (7500 hijack, 7600 radio failure, 7700 emergency) shows as a
  red warning instead.
- Altitude, ground speed (knots and mph), heading, vertical speed, squawk and ICAO
  address.
- **Position age:** how old the last position is. Receivers report in bursts, so a
  few seconds is normal.
- **Next update:** when the app will ask again.
- When tracking started and how far the aircraft has flown since, measured along the
  green trail.

**Follow** keeps the map centred on the aircraft. Dragging the map turns it off so
you can look around; **Follow flight** on the map turns it back on. **Isolate** hides
every other aircraft.

**Signal lost.** Over oceans, mountains and remote areas no volunteer receivers may
hear the aircraft. The app keeps the same aircraft locked, keeps retrying, and shows
the last known details clearly marked as not live. Old positions disappear from the
map after two minutes, so you never mistake them for a live one.

**Reopening.** The tracked flight and its trail are saved in this browser. Close the
panel, come back later and it carries on. A flight saved more than 12 hours ago isn't
resumed.

**When tracking ends by itself.** Airlines fly the same aircraft several times a day,
so following it forever would eventually show someone else's trip. When you tracked a
flight number or callsign, tracking stops with a message when:

- the aircraft starts broadcasting a **different flight number**. Your flight has
  almost certainly landed. You can choose to follow the new flight.
- it has been **on the ground for 15 minutes** after flying,
- there's been **no position for 2 hours**.

Searching by registration or ICAO hex means "follow this airframe", so a new flight
number doesn't stop it.

**Stop tracking** clears the flight and returns to the map.

## Looking around an area

Pan and zoom the map, choose a radius (25–250 NM) and press **Scan map here** to load
every aircraft around the map's centre. Pick one on the map or in the list and press
**Track this flight** to follow it anywhere. Scanning is turned off while a flight is
tracked, so the two don't compete for the feed.

**Lower 48**, **Alaska** and **Hawaii** jump the map to those areas. They never load
aircraft, and they don't stop a tracked flight.

The **Aircraft** list's filter box narrows loaded aircraft by callsign, registration,
type or ICAO code.

## How often it updates

adsb.fi is free and asks for at most one request per second from each user. This app
stays far below that:

| What's on screen | Requests to adsb.fi |
| --- | --- |
| The map alone, or a preset (Lower 48, Alaska, Hawaii) | **None** |
| A tracked flight, zoomed in | Every 15 seconds |
| A tracked flight, zoomed out (zoom 5 or less), or on the ground | Every 60 seconds |
| A flight that hasn't been found yet | Every 60 seconds |
| A scanned area | Every 60 seconds, or 3 minutes zoomed out |
| **Pause**, or the page hidden | None |

- **Every viewer shares one budget.** Two people, or two tabs, watching the same
  flight cost one request: the app keeps answers for 12 seconds and joins identical
  requests that are already on their way. Different lookups are spaced at least
  1.1 seconds apart.
- **Cooldowns are respected.** If adsb.fi says "too many requests", the app stops for
  exactly as long as it asks, for every viewer. The cooldown survives reloads and app
  restarts, and a new search or **Pause/Resume** can't skip it. The header shows the
  countdown and your flight stays locked.
- If the feed doesn't answer, the app waits 30 seconds before trying again rather
  than retrying in a loop.

## Appearance

The app follows your device's light or dark setting. The button at the top right
switches between **automatic**, **light** and **dark**. The choice is saved in this
browser. In dark mode the street map is dimmed to match.

## Moving from the custom integration

Earlier versions were a custom integration (`custom_components/adsb_tracker` and
`www/adsb-tracker.js`) with its own **ADS-B** sidebar entry. The app replaces it, and
both can run side by side while you try the app. You'll see two **ADS-B** entries
until you remove the old one.

When you're happy with the app:

1. Make a backup (**Settings → System → Backups**).
2. Remove the line `adsb_tracker: {}` from `configuration.yaml`.
3. Restart Home Assistant (**Settings → System → ⋮ → Restart Home Assistant**). The
   old sidebar entry disappears.
4. Delete the old files with the File editor or Terminal app:
   - `/config/custom_components/adsb_tracker/`
   - `/config/www/adsb-tracker.js`
   - `/config/www/adsb-loader.js`

A flight tracked in the old version isn't carried over, because old saved flights
have no timestamps to judge their age by. Search for it again in the app.

## Troubleshooting and FAQ

**My flight isn't found.** Check it has actually departed: many aircraft only appear
once the transponder is on at the gate or on the runway. Then try the operating
airline's callsign (see [codeshares](#finding-a-flight)), or the registration if you
know it. The app keeps checking every minute.

**"The public feed asked us to slow down."** adsb.fi has asked for a pause. The app
waits as long as it says and then carries on by itself, with your flight still locked.
If it happens often, check whether something else on your network also uses adsb.fi.

**"Can't reach the ADS-B Tracker app."** The app is stopped or restarting. Check
**Settings → Apps → ADS-B Tracker** and its **Log** tab.

**The map is blank but the flight card updates.** Map tiles come straight from Esri
to your browser, so a content blocker or firewall may be stopping
`server.arcgisonline.com`.

**The position jumps or is a minute old.** Coverage depends on volunteer receivers.
Where few of them are, positions arrive late or in gaps. The **Position age** row
shows how fresh the data is.

**Two ADS-B entries in the sidebar.** The old custom integration is still installed;
see [Moving from the custom integration](#moving-from-the-custom-integration).

## Security and privacy

- The app has **no access to Home Assistant**: no API token, no host network, no
  hardware, and no ports opened on your network. You reach it only through Home
  Assistant's sign-in (ingress), and inside Home Assistant it refuses connections from
  anything but the ingress proxy.
- It only ever contacts **one fixed address**, `opendata.adsb.fi/api/`, using paths
  built from validated search values. It can't be used to fetch anything else.
- What you search is sent to adsb.fi. Your location isn't requested or sent.
- The tracked flight, its trail and your appearance choice are saved **in your
  browser** only. The app itself saves just the feed cooldown, in its own data folder.
- An enforced AppArmor profile limits the app to what it needs.

## Data sources and credits

- Aircraft data: [adsb.fi](https://adsb.fi) open data API
  ([terms](https://github.com/adsbfi/opendata)), free for **personal, non-commercial**
  use with attribution. Thanks to the volunteers who feed it.
- Map tiles: Esri World Street Map. Sources: Esri, HERE, Garmin, USGS, Intermap,
  INCREMENT P, NRCAN, METI, TomTom and the GIS User Community.
- Map library: [Leaflet](https://leafletjs.com/) 1.9.4, BSD 2-Clause license
  (`app/static/lib/leaflet/LICENSE`).
