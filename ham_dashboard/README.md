# Ham Radio Dashboard

![logo](logo.png)

A read-only propagation and space-weather dashboard for amateur radio operators,
in its own Home Assistant sidebar panel. It works on phones and desktops, in light
and dark mode.

![Space weather view](https://raw.githubusercontent.com/SWFX2324/swamp-fox-labs-ha-apps/main/docs/screenshot-weather.png)

- **Propagation** tab: how each HF band should work from your QTH to any callsign,
  grid, prefix or point on the map, right now and hour by hour for the next 24 hours,
  on the short and long path, with PSKReporter decodes as a reality check. Save paths
  to get Home Assistant sensors and alerts for them
- HF band conditions, 160 m – 10 m: N0NBH/HamQSL ratings plus a local estimate from
  the nearest ionosonde, and measured activity heard nearby
  from PSKReporter
- **VHF openings**: 6 m and 2 m openings measured from PSKReporter, with a map of
  the long-distance paths heard near you and a Home Assistant alert when a band opens
- Station storm safety from NWS alerts and an optional lightning sensor, with a
  Home Assistant sensor that can disconnect your antennas
- NOAA R/S/G scales, SFI, sunspot number, K/A index, X-ray flux, solar wind and Bz
- Zoomable maps with Dark, Streets, Satellite and Topo layers, and a gray line map
  with sunrise, sunset and gray line times for your grid, plus the
  KC2G MUF and foF2 maps
- Kp chart with the 3-day forecast, and the solar cycle chart
- Live DX cluster spots, and PSKReporter "who's hearing me"
- NOAA alerts, watches and warnings
- **Repeaters** tab: nearby repeaters on a map and in a filterable list, from HearHam
- **APRS** tab: live stations, tracks and local weather stations around you, from
  APRS-IS (receive-only)
- **POTA** tab: Parks on the Air activators on a world map and in a filterable list
- **Satellites** tab: pass predictions with a sky plot and Doppler-corrected
  frequencies for ISS, SO-50, RS-44 and more
- **Home Assistant sensors and alerts** (as an MQTT device when Mosquitto is installed): band conditions, space weather, satellite
  passes and POTA activity as entities, plus events for watched DX and nearby POTA
  activations, and ready-made blueprints for openings, DX spots, nearby POTA and
  lightning
- **Reference** tab: the US amateur band plan by license class, and GMRS/FRS,
  MURS and CB channel charts
- **NCDXF beacons**: which beacon is on each band right now, rated for your path
- **WWV and WWVH**: path ratings to NIST’s time stations on every frequency, now and for the next 24 hours
- **Callsign lookup** tab: QRZ.com (with your own login) or free FCC data for US
  calls, with beam heading and great-circle path from your QTH

<p>
  <img src="https://raw.githubusercontent.com/SWFX2324/swamp-fox-labs-ha-apps/main/docs/screenshot-propagation.png" alt="Propagation view: band ratings for a path to Japan, the path map and a 24-hour band-by-hour outlook" width="66%">
  <img src="https://raw.githubusercontent.com/SWFX2324/swamp-fox-labs-ha-apps/main/docs/screenshot-phone.png" alt="The dashboard on a phone" width="24%">
</p>
<p>
  <img src="https://raw.githubusercontent.com/SWFX2324/swamp-fox-labs-ha-apps/main/docs/screenshot-sats.png" alt="Satellites view: upcoming passes, sky track and Doppler" width="66%">
</p>

## Getting started

Open the panel after installing and a short setup takes you through station type
(licensed amateur, GMRS or just listening), callsign and location, or set `callsign`
and `grid` on the **Configuration** tab. Add
your QRZ username and password there too if you want worldwide callsign lookups.
See the **Documentation** tab for details.

## Credits

Data from N0NBH/HamQSL, NOAA SWPC, KC2G, PSKReporter, HearHam, APRS-IS, POTA,
CelesTrak, the National Weather Service, OpenStreetMap, USGS The National Map, QRZ.com, callook.info and the W3LPL, VE7CC and NC7J DX clusters. The world outline comes
from [world-atlas](https://github.com/topojson/world-atlas) (Natural Earth, public
domain).

Maps use [Leaflet](https://leafletjs.com/) 1.9.4 (BSD 2-Clause License, included in
`app/static/lib/leaflet`). Satellite orbits are computed with [satellite.js](https://github.com/shashwatak/satellite-js)
5.0.0 (MIT License, included in `app/lib`).

## Developing

The backend is one Node.js file with no dependencies. To run it outside Home
Assistant:

```bash
CALLSIGN=N0CALL GRID=DM14xd PORT=8099 node ham_dashboard/app/server.js
```

Then open http://localhost:8099. Outside Home Assistant any client may connect; set
`INGRESS_ONLY=true` to test the "ingress proxy only" rule locally. Run the unit and
end-to-end tests with:

```bash
node --test "ham_dashboard/tests/*.test.js"
```

The end-to-end tests start the server with every outside service replaced by saved
responses in `ham_dashboard/tests/fixtures`, so they run offline.

Home Assistant blueprints for the dashboard's events live in
[`blueprints/automation`](../blueprints/automation); the documentation links each one
for import.
