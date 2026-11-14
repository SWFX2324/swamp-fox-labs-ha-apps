# Weather Observatory

A full-page weather station for the Home Assistant sidebar, built on the weather
entity you already have (for example Met.no). No account or API key needed.

- Current conditions, a 24-hour chart of temperature, rain or wind (tap or drag to
  read any hour), the daily outlook, and the last 24 hours as Home Assistant recorded
  them.
- Animated precipitation radar for your area with pan, pinch zoom and frame scrubbing.
- National Weather Service alerts and the nearest station's measurements (US).
- Modeled air quality (US AQI, PM2.5, PM10) and the sun's position, sunrise and
  sunset.
- Every panel shows where its data came from and how old it is. A missing value
  stays blank instead of turning into 0, and a failed refresh says so rather than
  showing old data as current.
- Public services see only your area rounded to about 11 km, never your exact
  location.
- Light and dark appearance, phone and desktop layouts.

See the [documentation](DOCS.md) for details.

Radar © RainViewer. Alerts and observations: National Weather Service. Air quality:
CAMS via Open-Meteo. Map tiles © Esri.
