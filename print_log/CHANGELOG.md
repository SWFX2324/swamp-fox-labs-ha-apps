# Changelog

## 1.0.3

- **The camera shows when nothing is printing**, with the temperatures, the printer's
  state and the last job. It refreshes every 30 seconds when idle and every 10 while
  printing.
- **"On the printer" shows the five most recent files** and scrolls for the rest (it
  stopped at eight before). The list keeps its place when the page refreshes.

## 1.0.2

- **The printer's files load.** The printer refused the file list with "session reuse
  required": the app's data connection didn't resume the encrypted session the way
  the printer requires. Listing, sending, starting and downloading files work now.

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
