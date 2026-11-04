# Ham Radio Dashboard

A read-only propagation, space-weather and station-lookup dashboard for amateur radio
operators. It adds a **Ham Radio** panel to the Home Assistant sidebar, with eight
tabs: **Space weather**, **Propagation**, **Repeaters**, **APRS**, **POTA**,
**Satellites**, **Callsign lookup** and **Reference**. It also publishes its data to Home Assistant as sensors and
fires events you can use in automations (see [Home Assistant sensors and alerts](#home-assistant-sensors-and-alerts)).

## Contents

- [Getting started](#getting-started)
- [Space weather](#space-weather)
- [Propagation](#propagation)
- [Repeaters](#repeaters)
- [APRS](#aprs)
- [POTA](#pota)
- [Satellites](#satellites)
- [Callsign lookup](#callsign-lookup)
- [Reference](#reference)
- [Maps](#maps)
- [Home Assistant sensors and alerts](#home-assistant-sensors-and-alerts)
- [Configuration](#configuration)
- [Troubleshooting and FAQ](#troubleshooting-and-faq)
- [Security and privacy](#security-and-privacy)
- [Data sources](#data-sources)
- [Notes](#notes)

## Getting started

The first time you open the dashboard, a short **setup** asks:

1. How you'll use it: **licensed amateur**, **GMRS**, or **just listening** (no license).
2. Your callsign, if you have one. Listeners skip this step.
3. Your grid square. You can type it, use your device's location, or (for US hams)
   fill it in from your FCC license.
4. Distance units and which connections to turn on (APRS, DX cluster, storm alerts,
   Home Assistant sensors).

Saving writes these into the app's **Configuration** tab and restarts the app, which
takes about 10 seconds. Only Home Assistant administrators can do this; for other
users, setup saves to their own browser (see [Who can use it](#security-and-privacy)). You can skip setup, and run it again from settings (⚙ at the
top right).

After setup, and once in every new browser, a short **tour** walks through the tabs.
It's skippable and can be replayed from settings. To see the whole first run again
(for example after an update), use **Start over as a new user** in settings.

### Licensed, GMRS or just listening

Everything on the dashboard is receive-only public information, so no license is
needed to use it. A few connections need an amateur callsign, so they work
differently for GMRS users and listeners:

| | Licensed amateur | GMRS / listener |
| --- | --- | --- |
| APRS live map | Logs in receive-only with your callsign | Logs in receive-only with a generated listener ID (like `SWL48213`) that can't be mistaken for a real callsign |
| DX cluster spots | Logs in with your callsign | Off: cluster nodes are run by hams and expect an amateur callsign |
| "Who's hearing you" | Your PSKReporter reports | Hidden: it shows where *your* amateur transmissions are heard |
| Everything else | ✓ | ✓ |

GMRS callsigns are never used to log in to amateur networks.

### Finding your way around

- **Collapse cards** you don't need with the ▾ at their top right. The dashboard
  remembers per browser; **Expand all collapsed cards** in settings brings them back.
- **Tap any dotted word** (MUF, Kp, foF2, sporadic-E…) for a short plain-language
  explanation. The **Reference** tab has the full glossary.
- **Callsigns are clickable** anywhere on the dashboard (to look them up), and DX
  spots have a ↗ to analyze the path to that station.
- After an update, a short **What's new** note lists the new features once.

### Settings

Settings (⚙) is saved per browser, so each person can have their own. There are two
places settings live:

- **The app's configuration** (set during setup, or on the app's Configuration tab
  in Home Assistant) applies everywhere and is what Home Assistant's sensors, alerts,
  saved paths and the model check use.
- **This browser's settings** can override the callsign, grid and units for what
  you see here. Settings shows both side by side, and a small dot appears next to
  your callsign at the top while this browser is overriding the app.

This browser's settings:

- **Station**: your callsign and grid square for this browser, if different from the
  app's configuration.
- **Display**: distance units; **Times** in local time or UTC (24-hour, marked Z);
  and **Show these tabs**, to hide tabs you don't use. Space weather always stays.
- **Help**: the tour, setup again, or start over as a new user.

### Data sources and connections

When a source a card depends on is failing, rate limited or reconnecting, the card shows
a yellow warning next to its title; hover it for details. For the full picture, open settings (⚙) → **Data sources and
connections**. It lists each data source with when it last updated and any error
(for example "Rate limited" when PSKReporter asks the app to slow down), plus the
DX cluster, APRS-IS and Home Assistant connections.

**Copy details for a bug report** copies the app version and this list, ready to
paste into a [GitHub issue](https://github.com/SWFX2324/swamp-fox-labs-ha-apps/issues/new/choose).
It leaves out your callsign and shortens your grid to 4 characters, since issues
are public.

## Space weather

![The Space weather tab](https://raw.githubusercontent.com/SWFX2324/swamp-fox-labs-ha-apps/main/docs/screenshots/weather.png)

- **Solar & geomagnetic conditions** – SFI, sunspot number, A and K index, X-ray flux,
  solar wind speed, Bz and estimated noise floor.
- **NOAA space weather scales** – current R (radio blackout), S (radiation) and G
  (geomagnetic) levels, yesterday's maximum and the 3-day probability forecast.
- **HF band conditions, 160 m – 10 m**
  - *HamQSL* day/night ratings by N0NBH.
  - Below the table, the next sunrise or sunset at your QTH and what the bands
    usually do then, and when you're in the gray line. This is a rule of thumb from
    the sun, not a forecast.
  - *At your QTH now* – a local estimate that compares each band with the MUF(3000)
    measured by the nearest ionosonde (within 3000 km, last 3 hours), adjusted for
    daytime D-layer absorption on 80/60/40 m and for geomagnetic storms. When no
    ionosonde nearby has reported, the column header says *model MUF* and the
    MUF comes from the propagation model instead: the sunspot number and the
    sun's height at your QTH, scaled by how the live ionosondes elsewhere compare
    with it. That's common in North America, where most ionosondes are offline.
  - *Heard nearby* – measured activity: how many distinct stations PSKReporter
    monitors within about 500 miles of you decoded on each band in the last 15
    minutes (mostly FT8/FT4), how many of them were DX (over about 1,550 miles
    away), and the farthest one. Zero can also mean nobody nearby is listening on
    that band. Updated every 5 minutes.
- **VHF openings, 6 m and 2 m** – measured from the same PSKReporter query as
  "Heard nearby". A band shows as **Open** when monitors within about 500 miles of
  you decode at least 3 stations, or 2 stations heard by 2 monitors, farther away
  than normal ground wave and tropo reach: about 500 miles on 6 m (sporadic-E and
  beyond) and 310 miles on 2 m (tropo ducting and Es). One distant station shows as
  **Possible**. Meteor scatter (MSK144) is left out, since it reaches those
  distances on any day.
  - Each band shows which way the stations are, the farthest one, the likely
    propagation (sporadic-E, multi-hop, tropo) from the path length, and how long
    it has been open.
  - The map draws every long path, from the station heard to the monitor that
    heard it, and the table lists the longest.
  - **No reports** means nothing on that band was decoded near you: the band is
    closed, or nobody close is listening. **Closed** means monitors nearby are
    decoding only local stations.
  - An opening ends after two quiet checks in a row (10 minutes), so one quiet
    check doesn't end it.
  - HamQSL's global aurora and sporadic-E indicators are shown below.
- **Station storm safety** – a Safe / Caution / Danger status for your station,
  with a red banner on every tab when it's Danger. It combines:
  - National Weather Service alerts for your grid square (US only). Severe
    thunderstorm, tornado and extreme wind warnings mean Danger. Watches, and
    special weather statements about thunderstorms, mean Caution.
  - The NWS hourly forecast: thunderstorms expected within 3 hours mean Caution.
  - An optional lightning sensor in Home Assistant (Ecowitt WH57, Ambient Weather,
    ESPHome AS3935 and similar). A strike within `lightning_alert_distance` in the
    last 30 minutes means Danger, and within twice that distance means Caution.
- **Maps** – live gray line (day/night/twilight) with sunrise, sunset and gray-line
  times at your QTH, plus the KC2G MUF and foF2 maps.
- **Kp chart** – the past 4 days and the 3-day forecast.
- **Solar cycle** – monthly sunspot number since 2008 and the NOAA prediction.
- **DX cluster spots** – live telnet feed, filterable by band, mode and the
  spotter's continent.
- **Who's hearing you** – PSKReporter reception reports for your callsign, plotted
  on the gray line map.
- **NOAA alerts, watches and warnings** from the last 72 hours, plus the full 3-day
  forecast text.

## Propagation

![The Propagation tab](https://raw.githubusercontent.com/SWFX2324/swamp-fox-labs-ha-apps/main/docs/screenshots/propagation.png)

Point-to-point analysis: how each HF band should work from your QTH to anywhere,
right now and over the next 24 hours.

- **Pick a target** by typing a callsign, a grid square (`JO31`, `PM95ux`) or a
  prefix (`JA`, `VK6`), or by clicking the map. Every DX cluster spot has a ↗
  link, and Callsign lookup has a **Propagation to** link.
  - Callsigns are placed from QRZ or FCC data when available, otherwise from the
    prefix. Big countries (US, Canada, Japan, Australia, Russia, Brazil) are split
    by call area, but a prefix location is still approximate and the page says so.
- **Right now** shows the distance, beam heading (short and long path), number of
  hops, the path MUF and the best band, then a rating for every band on the short
  and long path. Hover a rating to see what limits it: the MUF, daytime absorption,
  or the auroral zone during a storm.
- **Heard** is measured, not modeled: PSKReporter decodes in the last 15 minutes
  between stations near you and near the target. ↓ counts stations near the target
  heard near you; ↑ counts stations near you heard near the target. The ↓ direction
  comes from the same query as band activity; the ↑ direction needs a query for the
  target's area, limited to one new area every 5 minutes, as PSKReporter asks.
- **Next 24 hours** is a band-by-hour grid for the short or long path (darker green
  = more open), with the good windows listed above it and the MUF along the bottom.
- **The map** draws the short path, the long path (dashed) and the control points
  where the path MUF is set. Hover a control point for its foF2, MUF and the
  ionosonde it's anchored to.

### How the estimate works

A simplified model in the spirit of ITU-R P.533, not VOACAP:

1. The great-circle path is split into F2 hops of up to 4000 km. As in P.533, the
   path MUF is set at the midpoint up to 2000 km, at points 1000 km from each end
   up to 4000 km, at each hop up to 7000 km, and at points 2000 km from each end on
   longer paths.
2. foF2 at each control point comes from a small model driven by the sunspot number
   (from today's solar flux) and the sun's height there, checked against real
   ionosonde readings at today's low sunspot numbers, and **anchored to live
   ionosondes**: it's scaled by how far the nearest ionosonde (within 1500 km)
   differs from the model right now, or by the worldwide median when none is close.
   The anchor fades over the first hours of the outlook.
3. Each hop's MUF uses the secant law, scaled to the measured M(3000) factor.
4. D-layer absorption (George and Bradley) depends on the sun along the path, the
   sunspot number and the frequency. It closes the low bands on long daylight paths.
5. Paths through the auroral zone lose one or two steps when Kp is 4 or more.
6. Ratings compare each band with the path MUF. The MUF is a median, and signals
   get through above it, so a band is **good** up to the MUF, **fair** up to 10%
   above it, **poor** up to 20% above, and **closed** beyond that. The same scale
   rates the bands in the *At your QTH now* column.

**Model check.** Every 15 minutes the app compares the model with reality: it takes
the long-distance paths (2000 km or more) that PSKReporter shows being decoded near
you and records how the model rated each one at that moment. After a few days the
Propagation tab shows how often the model agreed, for example "of 1,400 real paths
heard near you, the model rated 71% fair or good". The check uses data the app has
already fetched, so it adds no PSKReporter traffic, and the log stores only bands,
counts, ratings and the 4-character grid squares at each end of the rated paths
(no callsigns). It stays on your install and holds about a month (10 MB) before
dropping its older half; **Download the log** saves it if you'd like to send it in
to help tune the model. The note covers the current model only, and for a while
also shows how the model before 1.7.0 did.

Treat it as a guide to when and where to listen. It doesn't know about noise at
either end, antennas, power, sporadic-E, or flares and storms that haven't happened
yet. When PSKReporter shows real decodes, they beat the estimate.

### NCDXF/IARU beacons

At the bottom of the Propagation tab. Eighteen beacons around the world take turns
on 14.100, 18.110, 21.150, 24.930 and 28.200 MHz: each sends its callsign in CW,
then dashes at 100 W, 10 W, 1 W and 0.1 W, and every beacon comes around on every
band each 3 minutes.

- The top row shows which beacon is on the air on each band right now, how your
  path to it rates, and a countdown to the next one. Tune in: if you hear it, the
  band is open in that direction.
- The table rates your path to every beacon on every band, with the one that's
  transmitting outlined. Click a beacon to analyze the full path to it.

The schedule comes from the clock (it's synchronized to UTC), so it needs no data
source. Beacons are sometimes off the air; [NCDXF](https://www.ncdxf.org/beacon/)
lists their status.

### WWV and WWVH time signals

Below the beacons. NIST's time stations transmit around the clock: WWV in Fort
Collins, Colorado on 2.5, 5, 10, 15, 20 and 25 MHz, and WWVH on Kauai, Hawaii on
2.5, 5, 10 and 15 MHz. Because they're always on, at known power from known places,
they're the simplest band check there is: if you hear WWV on 15 MHz, 15 MHz is open
toward Colorado right now.

- A tile for each station shows its best frequency for your path right now, the
  distance and beam heading, and a countdown to its hourly space weather report
  (solar flux, A and K index: WWV at 18 minutes past the hour, WWVH at 45).
- The grid rates every frequency now and for each of the next 24 hours.
- Click a station to analyze the full path to it.

WWV and WWVH share four frequencies, so you may hear both at once: WWV announces the
time in a male voice, WWVH in a female voice just before.

### Saved paths

**☆ Save path** keeps up to 10 paths you care about (a club station, a country you
need, a sked). Saved paths show as chips under the search box, and each one gets a
Home Assistant sensor (`sensor.ham_path_<name>`) and an event when a band opens on
it (see [Home Assistant sensors and alerts](#home-assistant-sensors-and-alerts)).
Saved paths are stored by the app, so every browser sees the same list. Removing a
path removes its sensor.

## Repeaters

![The Repeaters tab](https://raw.githubusercontent.com/SWFX2324/swamp-fox-labs-ha-apps/main/docs/screenshots/repeaters.png)

Repeaters near your grid square, from the community-maintained
[HearHam](https://hearham.com/) directory.

- A map centred on your QTH with range rings. Hover a dot for the repeaters at that
  site, and click it to jump to the row in the list.
- A list sorted by distance, with output frequency, offset (hover it for the input
  frequency), CTCSS tone or DMR color code, mode, linked network (AllStar, IRLP,
  EchoLink, DMR) and on-air status.
- Filters for band, mode, search radius, on-air only, and callsign/city search.
- Links to each repeater's HearHam and RepeaterBook pages.

The add-on downloads the HearHam directory at most once a day and keeps a copy in
its data folder, so the list keeps working across restarts and changing your grid
updates it instantly. Listings can be out of date, so confirm frequency and tone
before you transmit.

## APRS

![The APRS tab](https://raw.githubusercontent.com/SWFX2324/swamp-fox-labs-ha-apps/main/docs/screenshots/aprs.png)

Live APRS activity around you, received directly from the
[APRS-IS](https://www.aprs2.net/) network. The add-on keeps one receive-only
connection (it never transmits), filtered to `aprs_radius` around the add-on's grid
square.

- A map with range rings showing mobiles, fixed stations, digipeaters and iGates,
  weather stations and objects. Moving stations show a heading tick and their recent
  track. Hover a station for speed, altitude, path and comment, and click it to
  find it in the list.
- A list of stations heard in the last 15 minutes, hour or 3 hours, filterable by
  type and searchable. Each one links to its aprs.fi page, and callsigns open a
  lookup.
- Local weather stations (APRS and CWOP) with temperature, wind, humidity, pressure
  and rain.

Stations are dropped after 3 hours without a packet. The feed follows the add-on's
grid square; changing the grid in a browser moves the map but not the feed.

## POTA

![The POTA tab](https://raw.githubusercontent.com/SWFX2324/swamp-fox-labs-ha-apps/main/docs/screenshots/pota.png)

Parks on the Air activators on the air right now, from [pota.app](https://pota.app/).

- A world map with the live gray line, colored by mode (CW, phone, digital).
  Activators who've gone QRT show hollow.
- A list with frequency, band, mode, park, distance and direction, filterable by
  band, mode and distance, and sortable by newest or nearest. Park references link
  to the park's pota.app page, and callsigns open a lookup.

Spots refresh every minute while the tab is open. SOTA isn't included: the SOTA API
only allows approved applications.

## Satellites

![The Satellites tab](https://raw.githubusercontent.com/SWFX2324/swamp-fox-labs-ha-apps/main/docs/screenshots/satellites.png)

Pass predictions for your grid square over the next 24 hours, for popular FM and
linear amateur satellites: ISS, SO-50, PO-101, AO-91, RS-44, FO-29 and AO-7.

- A list of upcoming passes with rise time, countdown, maximum elevation, direction
  and duration, filterable by FM/linear and minimum elevation. Passes in progress
  are marked **Up now**.
- A sky plot of the selected pass (the centre is straight up, the edge is the
  horizon) with rise, highest point, set and the satellite's current position.
- Doppler-corrected downlink and uplink frequencies at rise, highest point and set.
  For linear birds it shows the shift at the centre of the passband.

Orbits come from [CelesTrak](https://celestrak.org/) (downloaded twice a day) and
are computed with SGP4 using [satellite.js](https://github.com/shashwatak/satellite-js).
Satellites go on and off the air often, so check
[AMSAT live status](https://www.amsat.org/status/) before you transmit.

## Callsign lookup

![The Callsign lookup tab](https://raw.githubusercontent.com/SWFX2324/swamp-fox-labs-ha-apps/main/docs/screenshots/lookup.png)

Type a callsign, or click any callsign in the DX spots, PSKReporter or repeater
lists. The lookup shows name, address, grid, license class and dates, QSL methods,
the QRZ photo when there is one, and the distance, beam heading (short and long
path) and great-circle path from your QTH.

- **US callsigns** work with no setup, using FCC data from
  [callook.info](https://callook.info/).
- **Worldwide callsigns** need your QRZ.com login in the add-on options. A
  [QRZ XML Logbook Data subscription](https://www.qrz.com/page/xml_data.html) unlocks
  full details; without one, QRZ returns basic information only and US calls are
  filled in from FCC data.

Each callsign is cached for a day so repeated lookups don't hit QRZ again.

## Reference

![The Reference tab](https://raw.githubusercontent.com/SWFX2324/swamp-fox-labs-ha-apps/main/docs/screenshots/reference.png)

- **US amateur band plan**: where each license class (Technician, General, Advanced,
  Amateur Extra) can transmit on every band from 160 m to 70 cm, with CW/data,
  phone and all-mode segments drawn to scale and power notes where they differ.
  It opens on your own class, from the FCC record for your callsign, and remembers
  the class you pick. From FCC Part 97; check the current rules or the ARRL band
  chart before you transmit.
- **GMRS and FRS channels**: all 22 channels with GMRS and FRS power limits and the
  repeater input for channels 15–22. GMRS stations see this first.
- **MURS and CB**: the license-free services, with their channels and power.

## Maps

The gray line, Repeaters, APRS, POTA and Lookup maps can be zoomed and panned.
Click a map first to zoom with the scroll wheel (so scrolling the page never zooms
a map by accident), pinch on a phone, or use the + and − buttons. The ⌂ button
resets the view.

The layers button (top right) picks the base map, remembered per map:

- **Dark** and **Streets** – [OpenStreetMap](https://www.openstreetmap.org/copyright).
  Dark is the same map with a dark filter.
- **Satellite (US)** and **Topo (US)** – [USGS The National Map](https://www.usgs.gov/programs/national-geospatial-program/national-map),
  public domain. Detailed across the US; outside the US there's imagery only when
  zoomed far out.
- **Plain (offline)** – the simple land outline bundled with the add-on, for when
  you'd rather not load map tiles.

World maps also have a **Day / night** overlay you can switch off. Map tiles are
loaded by your browser straight from OpenStreetMap or USGS, which means those
services see which area you're viewing.

## Home Assistant sensors and alerts

With `ha_sensors` on, the add-on updates these entities every 5 minutes, using the
add-on's `grid` for anything location-based:

| Entity | State |
| --- | --- |
| `sensor.ham_solar_flux`, `sensor.ham_sunspot_number`, `sensor.ham_a_index`, `sensor.ham_k_index` | Solar and geomagnetic indices |
| `sensor.ham_xray_flux`, `sensor.ham_solar_wind_speed`, `sensor.ham_bz`, `sensor.ham_noise_floor` | X-ray class, solar wind (km/s), Bz (nT), noise estimate |
| `sensor.ham_noaa_r_scale`, `sensor.ham_noaa_s_scale`, `sensor.ham_noaa_g_scale` | NOAA scale level, 0–5 |
| `binary_sensor.ham_radio_blackout` | On at R1 or higher |
| `binary_sensor.ham_geomagnetic_storm` | On at G1 or higher, or Kp 5+ |
| `sensor.ham_local_muf` | MUF(3000) at your QTH (MHz): from the nearest ionosonde, or the propagation model when none nearby is reporting (the `source` attribute says which) |
| `sensor.ham_band_160m` … `sensor.ham_band_10m` | `Good`, `Fair`, `Poor` or `Closed` at your QTH, with HamQSL day/night ratings as attributes |
| `sensor.ham_next_pass_iss`, `sensor.ham_next_pass_so_50`, … | Rise time of each satellite's next pass of 10° or more, with elevation, azimuths and frequencies as attributes |
| `sensor.ham_next_good_pass` | The next pass of any satellite reaching 30° or more |
| `sensor.ham_pota_nearby` | Number of POTA activators within your POTA alert radius, with the closest ten as an attribute |
| `sensor.ham_activity_160m` … `sensor.ham_activity_10m` | Stations heard nearby on that band in the last 15 minutes, with DX count and farthest station as attributes |
| `binary_sensor.ham_6m_open`, `binary_sensor.ham_2m_open` | On while that band is open (see VHF openings), with the status, stations, direction, likely propagation, farthest station and `open_since` as attributes |
| `sensor.ham_path_<name>` | One per saved path: the best band on the short path right now (or `None`), with every band's rating, the MUF, distance, bearing, the next good hour per band, the long path's best band and PSKReporter decodes heard nearby as attributes |
| `binary_sensor.ham_lightning_danger` | On when storm safety is Danger (safety device class), with the reasons as an attribute. Updated every minute. |
| `sensor.ham_storm_status` | `Safe`, `Caution` or `Danger` |
| `sensor.ham_nws_alerts` | Number of active NWS alerts for your location, with the list as an attribute |
| `sensor.ham_lightning_distance` | Distance to the last strike, when a lightning sensor is set |

It also fires events:

- `ham_dashboard_dx_spot` when a DX cluster spot matches your `spot_watch` list
  (`dx`, `frequency_khz`, `band`, `mode`, `spotter`, `comment`, `watch`).
- `ham_dashboard_pota_spot` when a new POTA activation appears within
  `pota_alert_radius` (`activator`, `reference`, `park`, `frequency_khz`, `band`,
  `mode`, `distance_km`, `bearing`).
- `ham_dashboard_storm_danger` when storm safety changes to Danger (`reasons`).
- `ham_dashboard_vhf_opening` when 6 m or 2 m opens (`band`, `stations`,
  `receivers`, `toward`, `likely`, `farthest_call`, `farthest_grid`, `farthest_km`,
  `regions`). It fires at most once an hour per band, and not for an opening
  already in progress when the app starts.
- `ham_dashboard_path_open` when a band on a saved path turns Good (`path`, `label`,
  `band`, `muf_mhz`, `target_grid`, `heard`, `distance_km`, `bearing`). It
  fires at most every 2 hours per band and path, and not for a band that's already
  good when the app starts or the path is saved.

From 1.0 on, these entity IDs, attributes and event names stay the same, so updates
won't break your automations. If one ever has to change, the changelog will say so
first.

DX and POTA alerts fire at most once every 30 minutes per station and band.

### Blueprints

Blueprints are ready-made automations: import one, pick what should happen (a phone
notification, a light, anything Home Assistant can do), and save. No YAML needed.
Each one fills in useful details you can use in your notification text, listed in
its description.

| Blueprint | What it does | Import |
| --- | --- | --- |
| **VHF band opens** | Runs your actions when 6 m or 2 m opens near you. | [Import](https://my.home-assistant.io/redirect/blueprint_import/?blueprint_url=https%3A%2F%2Fgithub.com%2FSWFX2324%2Fswamp-fox-labs-ha-apps%2Fblob%2Fmain%2Fblueprints%2Fautomation%2Fham_vhf_opening.yaml) |
| **Band opens on a saved path** | Runs your actions when a band turns Good on one of your saved paths (or a chosen one). | [Import](https://my.home-assistant.io/redirect/blueprint_import/?blueprint_url=https%3A%2F%2Fgithub.com%2FSWFX2324%2Fswamp-fox-labs-ha-apps%2Fblob%2Fmain%2Fblueprints%2Fautomation%2Fham_path_open.yaml) |
| **Watched DX is spotted** | Runs your actions when the DX cluster spots a callsign on your `spot_watch` list, optionally only on some bands. | [Import](https://my.home-assistant.io/redirect/blueprint_import/?blueprint_url=https%3A%2F%2Fgithub.com%2FSWFX2324%2Fswamp-fox-labs-ha-apps%2Fblob%2Fmain%2Fblueprints%2Fautomation%2Fham_dx_spot.yaml) |
| **POTA activation nearby** | Runs your actions when a new park activation appears within a distance you choose. | [Import](https://my.home-assistant.io/redirect/blueprint_import/?blueprint_url=https%3A%2F%2Fgithub.com%2FSWFX2324%2Fswamp-fox-labs-ha-apps%2Fblob%2Fmain%2Fblueprints%2Fautomation%2Fham_pota_nearby.yaml) |
| **Disconnect antennas when lightning is near** | Runs your actions turns off switches (an antenna relay, say) when storm safety turns to Danger, and optionally turns them back on after it has been safe for a while. | [Import](https://my.home-assistant.io/redirect/blueprint_import/?blueprint_url=https%3A%2F%2Fgithub.com%2FSWFX2324%2Fswamp-fox-labs-ha-apps%2Fblob%2Fmain%2Fblueprints%2Fautomation%2Fham_lightning_disconnect.yaml) |

The **Import** links open your Home Assistant (via my.home-assistant.io). You can
also go to Settings → Automations & scenes → Blueprints → **Import blueprint** and
paste the blueprint's address from the
[blueprints folder](https://github.com/SWFX2324/swamp-fox-labs-ha-apps/tree/main/blueprints/automation).
The lightning blueprint is an aid, not a guarantee: disconnect antennas whenever you
hear thunder.

### MQTT or REST

How the entities are created depends on whether the **Mosquitto broker** app is
installed:

- **With Mosquitto (recommended):** the add-on finds the broker automatically and
  registers the entities through MQTT discovery, grouped under one **Ham Radio**
  device in **Settings → Devices & services → MQTT**. You can rename them, put them
  in areas and hide the ones you don't use. Their last values are kept on the
  broker, so they're available as soon as Home Assistant restarts, and they show
  as unavailable if the add-on stops. No broker settings are needed.
- **Without Mosquitto:** the entities are created through Home Assistant's REST
  API. They work the same in automations, but they can't be renamed in the UI and
  show as unavailable for a few minutes after Home Assistant restarts, until the
  next update.

The entity IDs are the same either way, so automations keep working if you switch.
When you install Mosquitto later, restart this add-on: it clears the old REST
entities and registers the MQTT ones in their place. Turning `ha_mqtt` off removes
the MQTT device again. Events (`ham_dashboard_*`) always go through the REST API.

### Example automations

Replace `notify.mobile_app_your_phone` with your own notify service.

```yaml
- alias: "Disconnect antennas on lightning danger"
  triggers:
    - trigger: state
      entity_id: binary_sensor.ham_lightning_danger
      to: "on"
  actions:
    # Replace with the smart plug or relay that feeds your antenna switch.
    - action: switch.turn_off
      target:
        entity_id: switch.antenna_relay
    - action: notify.mobile_app_your_phone
      data:
        message: "Lightning danger: {{ state_attr('binary_sensor.ham_lightning_danger', 'reasons') | join(', ') }}. Antennas disconnected."

- alias: "10m has DX"
  triggers:
    - trigger: numeric_state
      entity_id: sensor.ham_activity_10m
      attribute: dx_stations
      above: 3
  actions:
    - action: notify.mobile_app_your_phone
      data:
        message: "10m is open: {{ state_attr('sensor.ham_activity_10m', 'dx_stations') }} DX stations heard nearby, farthest {{ state_attr('sensor.ham_activity_10m', 'farthest_call') }}"

- alias: "6m is open"
  triggers:
    - trigger: event
      event_type: ham_dashboard_vhf_opening
      event_data:
        band: 6m
  actions:
    - action: notify.mobile_app_your_phone
      data:
        message: >-
          6m is open toward {{ trigger.event.data.toward }}
          ({{ trigger.event.data.likely }}): {{ trigger.event.data.stations }} stations,
          farthest {{ trigger.event.data.farthest_call }} {{ trigger.event.data.farthest_grid }}

- alias: "15m opens to Japan"
  # Needs a saved path named "Japan".
  triggers:
    - trigger: event
      event_type: ham_dashboard_path_open
      event_data:
        path: japan
        band: 15m
  actions:
    - action: notify.mobile_app_your_phone
      data:
        message: "15m is open to Japan (MUF {{ trigger.event.data.muf_mhz }} MHz, beam {{ trigger.event.data.bearing | round(0) }}°)"

- alias: "10m is open"
  triggers:
    - trigger: state
      entity_id: sensor.ham_band_10m
      to: ["Good", "Fair"]
  actions:
    - action: notify.mobile_app_your_phone
      data:
        message: "10m is {{ trigger.to_state.state }} (MUF {{ states('sensor.ham_local_muf') }} MHz)"

- alias: "Geomagnetic storm"
  triggers:
    - trigger: state
      entity_id: binary_sensor.ham_geomagnetic_storm
      to: "on"
  actions:
    - action: notify.mobile_app_your_phone
      data:
        message: "Geomagnetic storm {{ state_attr('binary_sensor.ham_geomagnetic_storm', 'level') }}, Kp {{ states('sensor.ham_k_index') }}"

- alias: "POTA activator nearby"
  triggers:
    - trigger: event
      event_type: ham_dashboard_pota_spot
  actions:
    - action: notify.mobile_app_your_phone
      data:
        message: >
          {{ trigger.event.data.activator }} at {{ trigger.event.data.reference }}
          ({{ trigger.event.data.park }}) on {{ trigger.event.data.frequency_khz }} kHz
          {{ trigger.event.data.mode }}

- alias: "Watched DX spotted"
  triggers:
    - trigger: event
      event_type: ham_dashboard_dx_spot
  actions:
    - action: notify.mobile_app_your_phone
      data:
        message: "{{ trigger.event.data.dx }} on {{ trigger.event.data.frequency_khz }} kHz {{ trigger.event.data.mode }}"

- alias: "Good satellite pass in 10 minutes"
  triggers:
    - trigger: template
      value_template: >
        {{ as_timestamp(states('sensor.ham_next_good_pass'), 0) - as_timestamp(now()) < 600
           and as_timestamp(states('sensor.ham_next_good_pass'), 0) > as_timestamp(now()) }}
  actions:
    - action: notify.mobile_app_your_phone
      data:
        message: >
          {{ state_attr('sensor.ham_next_good_pass', 'satellite') }} rises in 10 minutes,
          max {{ state_attr('sensor.ham_next_good_pass', 'max_elevation') | round }}°
```

## Configuration

| Option | Description |
| --- | --- |
| `station_type` | `amateur`, `gmrs` or `listener`. See [Licensed, GMRS or just listening](#licensed-gmrs-or-just-listening). Set by setup. |
| `callsign` | Your callsign. Used to log in to the DX cluster and as the default for PSKReporter. Optional for GMRS and empty for listeners. |
| `grid` | Your Maidenhead grid square (4 or 6 characters, e.g. `DM14xd`). |
| `distance_units` | `mi` or `km`. |
| `dx_cluster_enabled` | Keep a telnet connection to a DX cluster for live spots. |
| `dx_cluster_host` / `dx_cluster_port` | The cluster to use. Default: `w3lpl.net:7373`. While it's one of the public nodes `w3lpl.net:7373`, `dxc.ve7cc.net:23` or `dxc.nc7j.com:7373`, the app moves to the next of these when a node doesn't answer the login within 2 minutes or goes quiet for 10. Any other cluster is used as is. |
| `qrz_username` / `qrz_password` | Optional. Your QRZ.com login, for worldwide callsign lookups. The password is only sent to QRZ and is never shown in the dashboard or logs. |
| `aprs_enabled` | Keep a receive-only APRS-IS connection for the APRS tab. Needs `callsign` and `grid`. |
| `aprs_radius` | How far around your grid to receive APRS stations, in your distance units (10–300, default 100). |
| `ha_sensors` | Publish `sensor.ham_*` and `binary_sensor.ham_*` entities and fire `ham_dashboard_*` events. On by default. |
| `ha_mqtt` | When the Mosquitto broker app is installed, create the entities through MQTT discovery under a **Ham Radio** device. On by default. See [MQTT or REST](#mqtt-or-rest). |
| `spot_watch` | Callsigns or prefixes to watch on the DX cluster, e.g. `VP8PJ` or `3Y0`. Matches are highlighted in the spots table and fire a `ham_dashboard_dx_spot` event. |
| `pota_alert_radius` | Fire a `ham_dashboard_pota_spot` event for new POTA activations within this distance, in your units. `0` turns POTA alerts off. Default 100. |
| `nws_alerts` | Use National Weather Service alerts and the hourly forecast for storm safety (US only). On by default. |
| `lightning_entity` | Optional. A Home Assistant sensor whose state is the distance to the last lightning strike, e.g. `sensor.ecowitt_lightning_distance`. |
| `lightning_alert_distance` | Strikes within this distance (your units) in the last 30 minutes mean Danger. Default 15. |

`callsign`, `grid` and `distance_units` are the defaults for everyone who opens the
panel. Each person can also click the callsign/grid chip at the top right and enter
their own. That choice is saved in their browser only, so several operators can
share one Home Assistant. The QRZ login is shared by everyone using the panel.

## Troubleshooting and FAQ

**The panel says "Open the dashboard from the Home Assistant sidebar."**
The dashboard only accepts connections through Home Assistant's own proxy (see
[Security and privacy](#security-and-privacy)). Open it from the **Ham Radio** item
in the sidebar rather than by its internal address.

**A card says "PSKReporter rate limited", or VHF openings and "Heard nearby" are
empty.** PSKReporter asks clients to query at most every 5 minutes and sometimes
asks the app to slow down, especially right after a restart if it was queried
shortly before. The app waits 15 minutes and tries again on its own; the cards say
so while they wait. Recent results are kept across restarts, so this is rarer from
1.2.0 on.

**The band table says "model MUF".** No ionosonde within 3000 km has reported in
the last 3 hours, so "At your QTH" uses the propagation model. The note under the
table names the nearest ionosonde heard from in the last week and when it last
reported. In North America only a few ionosondes still report (Idaho is often
the only one), so this is normal there. The measured "Heard nearby" column is the
reality check.

**"Your browser only shares your location with https pages".** Browsers only
give a page your location over https. When Home Assistant is open over plain
http (like `http://homeassistant.local:8123`), enter your grid square instead,
or use Home Assistant's https address.

**My phone shows a different callsign or grid than my desktop.** Settings are
saved per browser, and a browser can override the app's configuration. Settings
shows both side by side, and a dot by your callsign at the top marks an override.
**Use app configuration** in settings clears the override.

**A band shows Closed but I can hear stations (or the other way round).** The
ratings are estimates from a model, not measurements. The **Heard** column on the
Propagation tab and "Heard nearby" in the band table are measured and win when they
disagree. The app keeps a log comparing the two; **Download the log** on the
Propagation tab helps tune the model.

**The DX cluster panel is empty.** The cluster needs a licensed amateur callsign
to log in. Check settings → **Data sources and connections** for the DX cluster's
status.

**Sensors don't show up in Home Assistant.** Check that `ha_sensors` is on, then
look at **Home Assistant** in settings → **Data sources and connections**. With the
Mosquitto broker installed the sensors appear as an MQTT device; otherwise they're
created directly (see [MQTT or REST](#mqtt-or-rest)). A saved path's sensor appears
within 5 minutes of saving it.

**Something looks broken after an update.** Reload the page. If it persists,
reporting it helps (below).

**Reporting a problem.** In settings → **Data sources and connections**, use
**Copy details for a bug report** (it leaves out your callsign and shortens your
grid) and paste it into a
[GitHub issue](https://github.com/SWFX2324/swamp-fox-labs-ha-apps/issues/new/choose),
with the app's log from Settings → Apps → Ham Radio Dashboard → **Log**.

## Security and privacy

The dashboard is receive-only: it never transmits, and it only reads public data.

- **Restarts.** PSKReporter results and any rate-limit back-off are kept in the
  app's storage, so restarting or updating the app doesn't refetch them straight
  away (PSKReporter asks clients to query at most every 5 minutes).
- **AppArmor.** The app ships its own enforced AppArmor profile: it can only read
  its own code, write to its own storage, and make network connections, and
  anything else is blocked. Settings → **Data sources and connections** shows the
  profile the app is running under. If something ever fails and you suspect
  AppArmor, run this in the Terminal & SSH app and include the output in a bug
  report:
  `ha host logs --lines 20000 | grep 'apparmor="DENIED"' | grep ham_dashboard`.
- **Signed images.** Every published image is signed with Cosign, keyless, by this
  repository's build workflow. To check an image came from here:
  `cosign verify ghcr.io/swfx2324/ham-dashboard-amd64:1.6.4 --certificate-identity
  https://github.com/SWFX2324/swamp-fox-labs-ha-apps/.github/workflows/build.yaml@refs/heads/main
  --certificate-oidc-issuer https://token.actions.githubusercontent.com`
  (use `ham-dashboard-aarch64` on a Raspberry Pi, and your installed version).
  Images up to 1.6.3 were signed before the repository was renamed: for those,
  use `swamp-fox-labs-apps` in place of `swamp-fox-labs-ha-apps` in the identity.
- **Who can use it.** Every Home Assistant user sees **Ham Radio** in the
  sidebar and can use the whole dashboard, including their own browser settings.
  Only administrators can change what the household shares: setup (the app's
  configuration) and saved paths, which drive sensors and automations. For
  everyone else the **Save path** and remove buttons are hidden, and setup saves
  to their browser only. The app checks this itself, from the user Home
  Assistant says is viewing; if it can't confirm an admin, it refuses the change.
  Each person can hide it from their own sidebar; **Show in sidebar** on the
  app's Info tab hides it for everyone.
- **Security and privacy.** The dashboard only accepts connections from Home
  Assistant's ingress proxy, so it's reachable only through the sidebar. Your QRZ password stays in the app's
  configuration and is only ever sent to QRZ. Map tiles come from OpenStreetMap
  and USGS, which see the map area you're viewing (the **Plain** layer avoids
  them), and PSKReporter queries include your 2-character grid field.

## Data sources

- [N0NBH / HamQSL](https://www.hamqsl.com/solar.html) solar XML (cached 30 min)
- [NOAA SWPC](https://www.swpc.noaa.gov/) JSON and text products (5–60 min)
- [KC2G](https://prop.kc2g.com/) ionosonde data and MUF/foF2 maps (10 min)
- [PSKReporter](https://pskreporter.info/) (cached 5 min per callsign, as they request)
- [HearHam](https://hearham.com/) repeater directory (downloaded at most once a day)
- [QRZ.com](https://www.qrz.com/) XML callbook and [callook.info](https://callook.info/)
  FCC data (cached a day per callsign, fetched only when you look a call up)
- DX cluster via telnet (live)
- [APRS-IS](https://www.aprs2.net/) via `rotate.aprs2.net:14580`, receive-only (live)
- [POTA](https://pota.app/) activator spots (cached 1 min; polled every 2 min for alerts)
- [CelesTrak](https://celestrak.org/) amateur satellite elements (cached 12 h)
- [PSKReporter](https://pskreporter.info/) area query for band activity and VHF openings (one query every 5 minutes, as PSKReporter asks)
- [National Weather Service](https://www.weather.gov/documentation/services-web-api) alerts (cached 2 min) and hourly forecast (cached 30 min)

The add-on caches everything server-side, so opening the dashboard on several
devices doesn't multiply the requests to these free services.

## Notes

- The "At your QTH" rating and the Propagation tab are estimates, not VOACAP
  predictions. Both are most useful when an ionosonde is reasonably close; the
  PSKReporter decodes shown next to them are the reality check.
- The DX cluster requires a callsign to log in. Without one, the spots panel stays
  empty.
- Storm safety is an aid, not a guarantee. Disconnect antennas whenever you hear
  thunder, whatever the dashboard says. Blitzortung lightning data isn't used: its
  terms don't allow storm warnings or equipment protection.
- RepeaterBook isn't used as a data source. Its API is limited to approved apps and
  excludes nearby-repeater finders, so the dashboard only links to its pages.
