# Weather Observatory

A full-page weather station in the Home Assistant sidebar. It shows the weather
entity you already have, adds radar, National Weather Service alerts and a nearby
station, and labels where every number came from.

It adds a **Weather** panel to the sidebar. It reads Home Assistant but changes
nothing in it.

## Contents

- [Requirements](#requirements)
- [Getting started](#getting-started)
- [Settings](#settings)
- [What's on the page](#whats-on-the-page)
- [How often it updates](#how-often-it-updates)
- [Appearance](#appearance)
- [Moving from the Weather Observatory card](#moving-from-the-weather-observatory-card)
- [Updating, rolling back and removing](#updating-rolling-back-and-removing)
- [Troubleshooting and FAQ](#troubleshooting-and-faq)
- [Security and privacy](#security-and-privacy)
- [Data sources and credits](#data-sources-and-credits)

## Requirements

- Home Assistant OS or a Supervised install (apps need the Supervisor), on amd64 or
  aarch64.
- A **weather entity** that supports forecasts, such as the built-in
  [Met.no](https://www.home-assistant.io/integrations/met/) integration
  (`weather.forecast_home`). Any weather integration that offers hourly and daily
  forecasts works.
- Your **home location** set in Settings → System → General.
- **Recorder** keeping the weather entity (it does by default) for the "Past 24h"
  chart and the pressure trend.
- The **Sun** integration (on by default) for the sun panel.
- The National Weather Service panels cover the **United States** only.

## Getting started

1. Add this repository to Home Assistant (see the [repository README](../README.md)),
   then install **Weather Observatory** from the app store.
2. Start it. **Show in sidebar** is on by default.
3. Open **Weather** in the sidebar.

There's nothing to set up if you use Met.no: the app finds `weather.forecast_home`
by itself. To move the entry, open your profile and choose **Change the order and
hide items from the sidebar**, then drag **Weather** where you want it.

## Settings

All optional, on the app's **Configuration** tab:

| Setting | What it does |
| --- | --- |
| **Weather entity** | The entity to show, for example `weather.openweathermap`. Empty: `weather.forecast_home` if it's working, otherwise the first working weather entity. |
| **Place name** | Text under the title. Empty: the nearest town from the National Weather Service, or your Home Assistant location name. |
| **National Weather Service** | Alerts and the nearby station observation. Turn it off outside the US. |
| **Air quality** | The modeled air quality panel. |

Restart the app after changing them.

## What's on the page

**Current conditions.** Temperature, condition, today's high and low, humidity,
dew point, pressure with its 3-hour trend, cloud cover, UV index, gusts (or
visibility when the source has no gusts) and wind. These come from your weather
entity, so they are the source's **model estimate** for your area, not a
measurement at your home.

**The next 24 hours.** A chart of temperature (with the chance of rain as bars),
rain amount or wind. Tap, drag or hover on the chart, or use the slider, to read any
hour below it. The selected hour stays selected when you switch between Temperature,
Rain and Wind. **Past 24h** shows what Home Assistant actually recorded for the
entity, never a backfilled forecast.

**Precipitation radar.** The last two hours of radar frames for your area. Drag to
pan, pinch or use + and − to zoom, and the target button to come back to your area.
Play loops the frames; the slider picks one. Each frame shows its time and age, and
the latest frame is marked stale when it's more than 25 minutes old. Radar tiles go
up to zoom 7; closer in, they are enlarged. An empty radar doesn't prove it isn't
raining: radar can miss light or shallow precipitation.

**Alerts.** Active National Weather Service alerts for your area, worst first, each
with its details and instructions. "No active alerts" is shown only right after a
successful check. If the latest check failed, or the last good one is more than 20
minutes old, the banner says it's the **last successful check** instead.

**Daily outlook.** Up to seven days of highs, lows and chance of rain. A dash means
the forecast doesn't include that value (Met.no, for example, often has no chance of
rain).

**Air quality.** US AQI, PM2.5 and PM10 from the CAMS model, for the current hour.

**Sun & daylight.** Where the sun is in the sky (east on the left, west on the
right), the next sunrise and sunset, and the time until the next one.

**Nearby station observation.** The latest measured conditions from the nearest of
the three closest NWS stations that has a recent report. Converted to the same units
as your weather entity. Marked **STALE** when the newest usable report is more than
3 hours old.

The footer shows how fresh each source is. **Refresh** in the header fetches
everything again (at most twice a minute).

## How often it updates

The page asks the app for new data every minute while it's open and visible. The app
keeps one shared copy for all open pages and fetches from each source only when its
copy is due:

| Source | Refetched after |
| --- | --- |
| Current conditions (Home Assistant) | 30 seconds |
| Hourly forecast | 5 minutes |
| Daily forecast | 15 minutes |
| Recorded history | 30 minutes |
| Sun | 1 minute |
| NWS alerts | 5 minutes |
| NWS station observation | 10 minutes |
| Air quality | 30 minutes |
| Radar frames | 5 minutes |

When nobody has the page open, the app fetches nothing. A source that fails is
retried after a short wait, and its last good data is kept, labelled as such, in the
meantime. One source failing never affects another.

The forecast times show when the app **received** the forecast, not when the weather
model ran.

## Appearance

The button at the top right cycles **automatic** (follows your device), **light** and
**dark**. The choice is saved in your browser.

## Moving from the Weather Observatory card

If you used the earlier Weather Observatory **Lovelace card** (`weather-observatory.js`
in `www/`), the app replaces it. The two can run side by side while you try the app:
the app doesn't touch your dashboards, resources or files.

To remove the card once you're happy with the app:

1. Delete the dashboard view or dashboard that uses `custom:weather-observatory`
   (for example the **Weather** view in your Home Dashboard, or a separate **Weather**
   dashboard).
2. In **Settings → Dashboards → ⋮ → Resources**, delete
   `/local/weather-observatory.js`.
3. Delete `www/weather-observatory.js` with the File editor or Samba.

Leave other views, resources and images alone. If the old card used
`/local/header_weather.png`, other cards may use it too. The app has its own icon and
doesn't need it.

What changed from the card:

- It's an app with its own sidebar entry, so it needs no files in `www/`, no resource
  and no YAML.
- Public services are called by the app, not by each browser. NWS gets the
  identifying User-Agent it asks for, and every open page shares one set of requests.
- Map tiles come from Esri instead of OpenStreetMap, whose tile policy doesn't allow
  distributed apps to use its servers.
- The weather entity is a setting (or found automatically) rather than fixed.
- The radar no longer reloads the map on every animation frame, the chart's hour
  follows your finger as you drag, and the selected hour no longer jumps when you
  switch between chart tabs.

## Updating, rolling back and removing

- **Update:** Home Assistant offers updates like any app. Update from the app's page.
- **Roll back:** before updating, Home Assistant offers to back up the app; restore
  that backup (Settings → System → Backups) to go back. The app keeps no data of its
  own besides its settings, so a reinstall of an older version loses nothing.
- **Remove:** uninstall from the app's page. The sidebar entry goes with it. Nothing
  in Home Assistant needs cleaning up.

## Troubleshooting and FAQ

**"Weather unavailable" or "no weather entity".** Check you have a weather
integration (Settings → Devices & services). If you have several, pick one in the
app's settings. The app needs the entity to offer forecasts; most do.

**The daily or hourly panel says the forecast is unavailable.** Some weather
integrations offer only one of hourly, daily or twice-daily forecasts. The panel
reports what the entity returned.

**Past 24h is empty.** The entity's history comes from Recorder. If Recorder
excludes the weather entity, or history was just purged, there's nothing to show.

**The NWS panels say they cover only the US.** Turn **National Weather Service** off
in the settings outside the US.

**The radar map is grey.** The browser loads map tiles from Esri and radar tiles from
RainViewer directly. A network filter or ad blocker that blocks those hosts will
leave the map blank; the rest of the page keeps working.

**Feels-like or gusts show "—".** The weather source didn't supply them. Met.no often
doesn't. The app never fills in a guess.

**The app's log.** Settings → Apps → Weather Observatory → **Log** shows the
chosen entity and any source that's failing.

## Security and privacy

- The app reads Home Assistant through the Supervisor (`homeassistant_api`) with a
  token that never leaves the app. It reads states, your home location, forecasts
  (`weather.get_forecasts`, which changes nothing) and Recorder history. It doesn't
  call any service that changes anything.
- You reach it only through Home Assistant's sign-in (ingress). Inside Home
  Assistant it refuses connections from anything but the ingress proxy. It opens no
  ports.
- Public services (NWS, Open-Meteo, RainViewer) are called by the app with your home
  location **rounded to 0.1°** (about 11 km). The exact location never leaves Home
  Assistant and isn't sent to the page.
- Your browser loads map tiles from Esri and radar tiles from RainViewer, so those
  services see your IP address and the map area you look at.
- The page's appearance choice is saved in your browser. The app saves nothing.
- An enforced AppArmor profile limits the app to what it needs.

## Data sources and credits

- Forecasts and current conditions: your Home Assistant weather entity (for Met.no:
  the Norwegian Meteorological Institute).
- Alerts and station observations: [National Weather Service API](https://www.weather.gov/documentation/services-web-api)
  (US government data).
- Radar: [RainViewer](https://www.rainviewer.com/api.html), free for personal use with
  attribution.
- Air quality: [Open-Meteo Air Quality API](https://open-meteo.com/en/docs/air-quality-api),
  data from the Copernicus Atmosphere Monitoring Service (CAMS), CC BY 4.0, free for
  non-commercial use.
- Map tiles: Esri World Light Gray and Dark Gray Canvas. Sources: Esri, HERE, Garmin,
  © OpenStreetMap contributors, and the GIS user community.
- Map library: [Leaflet](https://leafletjs.com/) 1.9.4, BSD 2-Clause license
  (`app/static/lib/leaflet/LICENSE`).
