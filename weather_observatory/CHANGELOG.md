# Changelog

## 1.0.0

First release as a Home Assistant app. It replaces the Weather Observatory Lovelace
card (1.1.1) and can run beside it while you try it. See
[Moving from the Weather Observatory card](DOCS.md#moving-from-the-weather-observatory-card).

**New**

- **Installs from the app store**, with a **Weather** sidebar entry. No files in
  `www/`, no dashboard resource and no YAML.
- **The weather entity is a setting**, found automatically when left empty, instead of
  being fixed to `weather.forecast_home`.
- **Public services are called by the app**, once for every open page, with the
  identifying User-Agent the National Weather Service asks for. Each source keeps its
  own cache and error, so one failing never blanks another.
- **Light and dark appearance**, following your device or chosen in the header, like
  the other Swamp Fox Labs apps.
- **Alerts are colour-coded by severity** and list what to do.
- **Tap, drag or hover on the 24-hour chart** to read any hour.
- **Sun panel** shows where the sun is in the sky and the time to the next sunrise or
  sunset.
- Settings to turn the NWS and air quality panels off (for homes outside the US).

**Fixed (compared with the card)**

- The radar no longer reloads every map tile on each animation frame, which made it
  flicker.
- The forecast-hour slider updates as you drag, not only when you let go.
- The selected hour no longer jumps to a different time when you switch chart tabs.
- The station distance uses your units (miles with Fahrenheit) instead of always
  kilometres.
- Map tiles come from Esri: OpenStreetMap's tile policy doesn't allow distributed apps
  to use its servers.
