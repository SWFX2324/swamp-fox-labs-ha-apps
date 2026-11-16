# Changelog

## 1.0.1

- **This month and Filament per day work inside Home Assistant.** The app read dates
  in a format the container's Node.js doesn't have, so the month showed "Invalid
  Date" with no prints and the daily chart put everything on one day.

## 1.0.0

- First release: a history of every print from Home Assistant's Bambu Lab integration,
  with filament per AMS slot, cost, failures and their reasons; spools with what's left,
  AMS humidity and drying, and a reorder list; this month's statistics and filament per
  day.
- The print in progress with its camera, and Pause, Resume and Stop (with Developer LAN
  mode on the printer).
- The printer's files with the access code: send a sliced `.3mf`, start it with the AMS
  slot for each filament, and download files for Bambu Studio.
- **Printer controls** can be turned off for a page that only reads.
