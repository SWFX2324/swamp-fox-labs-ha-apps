# Changelog

## 1.7.0

**Model tuning**, from 10 days of the app's own accuracy log (about 100,000 real
long-distance paths decoded near the QTH) and live ionosonde readings.

- **The model was pessimistic, and is less so now.** On 30 m to 10 m it rated
  only about two thirds of the paths PSKReporter showed open as fair or good
  (78% counting the low bands, which it nearly always got right), and it missed
  most 10 m and 12 m openings. Replaying the log on 40 m to 10 m, the new model
  rates about 86% fair or good, up from 64%, while rating hardly any closed
  paths open (about 2%).
- **foF2 runs higher at low sunspot numbers.** At today's sunspot numbers (33–48)
  the model ran about 25% below live ionosondes, day and night. It's lifted there,
  which matters most for the 24-hour outlook (where the live anchor fades) and
  for the *model MUF* fallback in the band table. From SSN 100 up it's unchanged.
- **Ratings use the operational MUF.** The MUF is a median, and signals get
  through above it (ITU-R P.1240; the log found decodes about 15% above the
  model's MUF). A band is now good up to the MUF, fair to 10% above, poor to 20%
  above. This applies to path ratings, the *At your QTH now* column and the band
  sensors, so expect more bands rated open, mostly on 10–17 m.
- **20 m at night is still rated closed** most of the time. Those openings are
  real but thin (about 5 long-distance paths per check, against 76 by day), and
  the model now puts the best of them just past *poor*. The log will show
  whether it needs more.
- **The accuracy log records grid squares** at both ends of each rated path (no
  callsigns), so the next tuning can be replayed exactly. It also notes which
  model rated each check, holds about a month (10 MB, up from 3 MB), and the
  Model check note shows the old model's score next to the new one for comparison.

## 1.6.4

The repository is now **swamp-fox-labs-ha-apps** (it was swamp-fox-labs-apps).
Nothing changes in normal use and there's nothing to do: GitHub forwards the old
address, so Home Assistant keeps finding updates. The app's links, blueprint
sources and image labels now use the new name. Images up to 1.6.3 carry the old
name in their signature; the Documentation tab shows how to check either.

## 1.6.3

- **"At your QTH now" works without a nearby ionosonde.** It needs an ionosonde
  within 3000 km that reported in the last 3 hours, and in North America that's
  rare: most have been offline for years, and Idaho often reports only now and
  then. The column then said n/a. It now falls back to the propagation model's
  MUF, scaled by how the live ionosondes elsewhere compare with it, and the header
  says *model MUF*. The note names the nearest ionosonde heard from in the last
  week and when it last reported.
- **The band sensors use the same estimate**, so `sensor.ham_local_muf` and
  `sensor.ham_band_*` have a value instead of unknown when no ionosonde is near.
  A new `source` attribute on `sensor.ham_local_muf` says `ionosonde` or `model`.
- **Clearer location errors.** With Home Assistant open over plain http, the
  "Use my location" buttons explain that browsers only share location with https
  pages, instead of showing the browser's raw error.

## 1.6.2

Fixes for the first GitHub code scanning (CodeQL) results. Nothing changes in
normal use.

- **MQTT over TLS checks the broker's certificate.** It used to accept any
  certificate. The Mosquitto app is reached without TLS on Home Assistant's
  internal network, so this only affects a broker set up for TLS; one with a
  self-signed certificate is now refused, with the reason in the log.
- The repeater radius and POTA range menus are built as elements instead of from
  HTML text.
- A test escapes the version number fully when matching it.

## 1.6.1

- **Every Home Assistant user can open the dashboard.** Home Assistant now enforces
  admin-only panels (Supervisor 2026.10.2), which hid the dashboard from regular
  users. It's open to all users again, and the app itself keeps the shared
  settings for admins: only they can run setup for the app's configuration or add
  and remove saved paths. Other users' setup and settings stay in their own
  browser.

## 1.6.0

Easier to automate, better documented, and tested end to end.

- **Blueprints**: five ready-made Home Assistant automations, importable with one
  click from the documentation: a VHF band opens, a band opens on a saved path, a
  watched DX callsign is spotted, a POTA activation appears nearby, and turning
  off antenna switches when lightning is near (optionally back on once it's safe).
- **Documentation reorganized** by tab, with a screenshot of each, a contents list,
  a new **Troubleshooting and FAQ** section, and a **Security and privacy** section.
- **End-to-end tests**: CI now starts the whole server against saved responses
  from every outside service and checks each part of the API, the security rules,
  and that recent data survives a restart. Blueprints are checked in CI too.
- **AppArmor checked in CI**: every change now builds the real image and runs it
  under its enforced AppArmor profile, calling every endpoint and failing on any
  denied access, so a problem like 1.5.0's blocked locale data is caught first.
- The dashboard now says "app" instead of "add-on", matching Home Assistant.

## 1.5.2

- **DX cluster spots work again.** The VE7CC cluster, the default until now, has
  stopped answering logins: the app sent its callsign, reported itself logged in,
  and then waited for spots that never came, reconnecting every 10 minutes. The
  app now only reports a connection once the cluster answers, and when one of the
  public nodes (W3LPL, VE7CC, NC7J) doesn't answer within 2 minutes or goes quiet,
  it moves to the next. W3LPL (`w3lpl.net:7373`) is the new default; existing
  installs set to VE7CC move to it automatically while VE7CC isn't answering. A
  cluster you chose yourself is never replaced.
- Errors fetching data now name the source, so the log shows which one failed.

## 1.5.1

- Fixed NOAA alerts failing since 1.5.0, which also showed "NOAA SWPC not
  responding" on the Space weather cards. The enforced AppArmor profile blocked
  Node.js from reading its own locale data (`/usr/share/icu`), which sorting the
  alerts needed; the profile now allows reading `/usr/share`, and the alerts no
  longer need locale data at all.

## 1.5.0

Security.

- **AppArmor is now enforced.** The profile that ran in complain mode since 1.2.0
  (with nothing logged on a real install) now blocks anything outside it: the app
  can only read its own code, write to its own storage, and make network
  connections. Settings → **Data sources and connections** shows the profile the
  app is running under.
- **Signed images.** Published images are signed with Cosign by the build
  workflow (keyless, tied to this repository), and the workflow verifies each
  signature. The documentation shows how to check one yourself.
- **Automatic escaping check.** A new test fails if dashboard code ever puts data
  from outside the app (APRS comments, cluster spots, QRZ records and so on) into
  the page without escaping it. A few spots that showed the app's own text are now
  escaped too, so the rule has no exceptions.
- Fixed the documented command for checking AppArmor's log: `journalctl` isn't
  available in the Terminal & SSH app; the docs now use `ha host logs`.

## 1.4.0

Easier to use and to find your way around.

- **Collapsible cards**: every card has a ▾ at its top right to collapse it. The
  dashboard remembers per browser, and settings can expand them all again.
- **Plain-language explanations**: tap a dotted word (SFI, Kp, Bz, MUF, foF2,
  sporadic-E, control point, Doppler, CTCSS and more) for a short explanation. The
  Reference tab has the full glossary of 37 terms.
- **Settings in two places, made clear**: settings show what this browser uses
  next to the app's configuration (which Home Assistant's sensors and alerts use),
  and a dot by your callsign at the top shows when this browser is overriding it.
- **What's new**: after an update, a short note lists the new features once.
- **Tips**: one-time tips point out that callsigns are clickable and that the
  propagation map can be clicked to analyze a path.

## 1.3.0

- **WWV and WWVH time signals** on the Propagation tab: your path rating to NIST's
  time stations on every frequency (WWV 2.5–25 MHz, WWVH 2.5–15 MHz), now and for
  the next 24 hours, with the best frequency right now and a countdown to each
  station's hourly space weather report. Since they're always on the air, they're
  a quick check of which frequencies are open toward Colorado and Hawaii. Click a
  station for the full path analysis.

## 1.2.0

Reliability and security.

- **Restarts keep PSKReporter data.** Results and any rate-limit back-off are saved
  in the app's storage and restored on start, so an update or restart shows recent
  data straight away instead of refetching and often hitting PSKReporter's rate
  limit.
- **Bounded memory.** The data cache sweeps out old entries and holds at most 500,
  and the data source status list keeps at most 200, so memory use stays flat over
  months of lookups and paths.
- **AppArmor profile**, in complain mode for now: it logs anything outside the
  profile without blocking it. A later release enforces it once real installs show
  no surprises. See the documentation for how to check the log.
- **Model check.** The app now compares the propagation model with the real
  long-distance paths PSKReporter shows near you, every 15 minutes, using data it
  already has. The Propagation tab shows how often the model agreed over the last 7
  days, and the log (no callsigns) can be downloaded to help tune the model.

## 1.1.1

- Fixed: when PSKReporter couldn't be reached (for example rate limiting right after
  the app restarts), the VHF openings card was left blank. It now says why and that
  it will fill in once PSKReporter answers, and the band table's note explains an
  empty "Heard nearby" column the same way.

## 1.1.0

New:

- **NCDXF/IARU beacons** on the Propagation tab: which of the 18 beacons is on the air
  on each band right now, with a countdown, and how your path to each one rates.
  Click a beacon to analyze the path.
- **Reference tab**: the US amateur band plan by license class (opens on your own
  class from your FCC record), GMRS and FRS channels with power limits and repeater
  pairs, and MURS and CB channels.

Polish:

- **Faster first load**: files are compressed, and the world outline only loads for
  the Plain map layer. Over a slow connection on a Raspberry Pi-class machine the
  first load dropped from about 480 KB to 130 KB, and the band table fills in
  half the time.
- **Times in UTC**: a new setting shows every time on the dashboard in UTC (24-hour,
  marked Z) instead of local time.
- **Settings** are grouped into Station, Display and Help.
- **Phones**: all tabs fit in two rows instead of a row that scrolls sideways.
- **Light mode**: captions and links are darker so they're easy to read, and the
  24-hour outlook's shades are easier to tell apart.
- **Accessibility**: focus outlines on every control you can tab to; charts and map
  markers describe themselves to screen readers (the K-index and sunspot charts
  read out their latest values); the main tabs use the right markup for
  navigation; motion is reduced when your device asks for it.

## 1.0.2

- The app now runs on the Alpine 3.24 base image with Node.js 24. Home Assistant
  stopped updating the Alpine 3.21 base in June 2026, so this keeps the app on a
  base image that still gets security fixes. Nothing else changes.

## 1.0.1

Security and polish. No new features, and nothing changes in Home Assistant.

- **Only Home Assistant can connect.** The app now accepts connections only from
  Home Assistant's ingress proxy, so other apps on Home Assistant's internal network
  can no longer reach the dashboard or its setup directly.
- **Changes need a same-origin request.** Setup and saved paths accept only JSON
  requests from the dashboard itself, so another website can't send changes
  through your logged-in browser.
- **Security headers** on every response, including a content security policy that
  only allows the app's own scripts.
- Links and photos from QRZ and FCC data are only used if they're plain https links.
- The build is pinned to exact versions of its GitHub Actions and base image, and
  Dependabot proposes updates for review.
- **No more stale pages after an update.** The page asks for this version's files by
  name, so a browser can't mix old and new code.
- **Clear error messages** everywhere, instead of "HTTP 400". If the app itself
  can't be reached (for example while it restarts), a banner says so.
- **Warnings on cards** when a source they depend on is failing, rate limited or
  reconnecting, with how old the data is. Hover the warning for details.

## 1.0.0

- **Propagation tab**: point-to-point analysis from your QTH to any callsign, grid
  square, prefix or point on the map.
  - Ratings for every HF band on the short and long path right now, with what
    limits each one (the MUF, daytime absorption, or the auroral zone in a storm).
  - A 24-hour band-by-hour outlook, with the good windows listed.
  - PSKReporter decodes between your area and the target's, in both directions, as
    a reality check.
  - A map with the short and long path and the control points where the MUF is set.
  - Opens from every DX cluster spot (↗) and from Callsign lookup.
  - The estimate is a simplified ITU-R P.533-style model anchored to live
    ionosondes, not VOACAP. See the documentation for how it works.
- Callsigns without a QRZ or FCC record are placed from their prefix, split by call
  area for the US, Canada, Japan, Australia, Russia and Brazil.
- **Saved paths**: keep up to 10 paths. Each gets a `sensor.ham_path_<name>` sensor
  with the best band now, every band's rating and the next good hour, and a
  `ham_dashboard_path_open` event when a band on it turns good.
- Entity IDs, attributes and event names are now stable: from 1.0 on they won't
  change without notice in the changelog.

## 0.9.1

- **Data sources and connections** in settings: when each data source last
  updated and any error (including rate limiting), plus the DX cluster, APRS-IS and
  Home Assistant connections. **Copy details for a bug report** copies the version
  and this list for a GitHub issue, without your callsign and with only a
  4-character grid.
- Under the HF band table: the next sunrise or sunset at your QTH and what the
  bands usually do then, and a note while you're in the gray line.
- GitHub: bug report and feature request forms, and the build and check workflows
  moved to current action versions (Node 24).

## 0.9.0

- **VHF openings**: a new card on the Space weather tab shows when 6 m and 2 m are
  open, measured from PSKReporter: monitors near you decoding stations farther
  away than ground wave and tropo normally reach. It shows the direction, the
  farthest station, the likely propagation (sporadic-E, multi-hop or tropo) and how
  long the band has been open, with a map of the paths and a list of the longest.
  It uses the same PSKReporter query as "Heard nearby", so it adds no traffic.
- Home Assistant: new `binary_sensor.ham_6m_open` and `binary_sensor.ham_2m_open`,
  and a `ham_dashboard_vhf_opening` event when a band opens.
- **Prebuilt images**: installs and updates now download a ready image from GitHub
  Container Registry instead of building on your machine, which is much faster on
  a Raspberry Pi.
- Every change is now checked automatically: Home Assistant's app linter, a syntax
  check and unit tests for the grid, sun and band math, the APRS parser and the
  VHF opening detection.

## 0.8.1

- Fixed: the tour and setup boxes couldn't be clicked when they sat over a map (the
  clicks went to the map instead). Maps now always stay underneath them.
- **Start over as a new user** in settings: clears this browser's dashboard settings
  and opens setup with blank answers, so you can go through first run the way a new
  user sees it. Your Home Assistant configuration only changes if you save at the end.
- Skipping setup now starts the tour, like finishing it does.

## 0.8.0

- **Setup on first run**: pick licensed amateur, GMRS or just listening, then your
  callsign (if any), grid square (typed, from your device's location, or from your
  FCC license) and units, and which connections to use. It saves to the app's
  Configuration tab and restarts the app. It can be skipped and rerun from settings.
- **Guided tour**: a short, skippable walk through the tabs, shown once per browser
  and replayable from settings.
- **Station types**: new `station_type` option. GMRS users and listeners get APRS
  through a receive-only listener ID; the DX cluster and "who's hearing you" are
  amateur-only and say so instead of showing empty panels.
- **Hide tabs** per browser from settings.
- The HF band table now runs **160 m to 10 m**: 6 m (VHF) is replaced by 160 m. In
  Home Assistant, `sensor.ham_band_6m` and `sensor.ham_activity_6m` are replaced by
  `sensor.ham_band_160m` and `sensor.ham_activity_160m`; update any automations that
  used the 6 m sensors. 6 m stays in the DX spot, POTA and repeater band filters.
- Existing installs keep working as before (station type defaults to amateur) and
  see the tour once.

## 0.7.1

- Map markers are easy to click again: a click within about 15 pixels of a station
  or repeater counts, like before the switch to zoomable maps. Arrow and diamond
  markers have bigger click areas too.
- The APRS and POTA maps no longer refresh while your pointer is over them, so a
  marker can't disappear mid-click. They catch up as soon as the pointer leaves.
- Fix: the Repeaters and APRS maps could open zoomed all the way in to street
  level in a new browser tab.

## 0.7.0

- **Zoomable maps**: the gray line, Repeaters, APRS, POTA and Lookup maps can be
  zoomed and panned (scroll wheel after clicking the map, pinch on phones, or the
  + and − buttons). A ⌂ button resets the view.
- **Map layers**: pick Dark, Streets, Satellite (US), Topo (US) or Plain on each
  map; the choice is remembered per map. Day/night shading is an overlay you can
  turn off, and now lines up exactly at every zoom.
- The APRS "Show within" picker is replaced by real zoom.
- Maps use Leaflet 1.9.4 (BSD license, included), OpenStreetMap tiles and USGS
  National Map imagery.

## 0.6.0

- **MQTT entities**: when the Mosquitto broker app is installed, the sensors are
  registered through MQTT discovery under one **Ham Radio** device. They can be
  renamed, assigned to areas and hidden, keep their values across Home Assistant
  restarts, and show as unavailable when the add-on stops. Broker settings come
  from Supervisor automatically. Without Mosquitto, the REST API is used as before.
  Switching clears the old entities so entity IDs stay the same. New `ha_mqtt`
  option (on by default).
- The add-on now backs off for 15 minutes when a data source answers "too many
  requests" (HTTP 429), instead of retrying every minute.
- Build: the base image is now set in the Dockerfile and `build.yaml` is gone,
  as Supervisor 2026.04 and later require.

## 0.5.0

- **Measured band activity**: the band table has a new "Heard nearby" column
  showing how many stations PSKReporter monitors within about 500 miles decoded
  on each band in the last 15 minutes, how many were DX, and the farthest. Also
  published as `sensor.ham_activity_80m` … `sensor.ham_activity_6m`.
- **Station storm safety**: Safe / Caution / Danger from National Weather Service
  alerts and hourly forecast, plus an optional lightning sensor already in Home
  Assistant (Ecowitt, Ambient, ESPHome AS3935). Danger shows a banner on every
  tab, turns on `binary_sensor.ham_lightning_danger` and fires
  `ham_dashboard_storm_danger`, so an automation can disconnect your antennas.
- New `nws_alerts`, `lightning_entity` and `lightning_alert_distance` options.

## 0.4.1

- Fix: Home Assistant sensors and alerts didn't start. The add-on now finds its
  Supervisor token in s6-overlay's saved container environment, where the base
  image keeps it, instead of only looking in its own environment.

## 0.4.0

- **Home Assistant sensors**: solar and geomagnetic indices, NOAA R/S/G scales,
  storm and blackout binary sensors, local MUF, per-band conditions (80 m to 6 m),
  next satellite passes and nearby POTA activations, as `sensor.ham_*` and
  `binary_sensor.ham_*` entities.
- **Alerts**: `ham_dashboard_dx_spot` events for callsigns on your new `spot_watch`
  list, and `ham_dashboard_pota_spot` events for activations within the new
  `pota_alert_radius`. Watched callsigns are highlighted in the DX spots table.
- New **POTA** tab: activators on the air on a world map and in a filterable list.
- New **Satellites** tab: 24-hour pass predictions for ISS, SO-50, PO-101, AO-91,
  RS-44, FO-29 and AO-7, with a sky plot and Doppler-corrected frequencies.
- The band estimate now lives in one shared module used by both the dashboard and
  the Home Assistant sensors, so they always agree.
- On phones the tab bar scrolls sideways and keeps the active tab in view.

## 0.3.0

- New **APRS** tab: live stations around you from APRS-IS (receive-only), on a
  range-ring map with tracks and headings, plus a filterable list of stations heard
  and a panel of local weather stations. Each station links to aprs.fi.
- New `aprs_enabled` and `aprs_radius` options.

## 0.2.0

- New **Repeaters** tab: repeaters near your grid square from the HearHam directory,
  with a range-ring map, distance and direction, tone, offset, mode, linked network,
  on-air status, and band, mode, radius and search filters.
- New **Callsign lookup** tab: QRZ.com lookups with your own QRZ login, plus free
  FCC data from callook.info for US calls. Shows license details, QSL info, the QRZ
  photo, and the beam heading, distance and great-circle path from your QTH.
- Callsigns in DX spots, PSKReporter reports and the repeater list are clickable
  and open a lookup.
- New optional `qrz_username` and `qrz_password` options.
- The top-level tabs are linkable (`#weather`, `#repeaters`, `#lookup`) and the last
  one you used is remembered.
- Phone layout: the header no longer sticks to the top, and tables drop secondary
  columns to fit the screen.

## 0.1.0

- First release: solar and geomagnetic tiles, NOAA R/S/G scales and forecast,
  HF band conditions (HamQSL plus a local ionosonde estimate), gray line, MUF and
  foF2 maps, Kp and solar cycle charts, DX cluster spots, PSKReporter
  "who's hearing me", and NOAA alerts.
