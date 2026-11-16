# Changelog

## 1.0.7

- **The printer's certificate is checked** on its file connection: it must come from
  Bambu Lab's authorities and name the printer's serial number before the app sends
  the access code. Before, the app didn't check it, so anything answering at the
  printer's address on your network could have collected the code.

## 1.0.6

- **Chamber light switch on the camera**: turn the printer's chamber light on or off
  from the camera card, so the picture isn't black. It uses the light the Bambu Lab
  integration provides, and is hidden when **Printer controls** is off.

## 1.0.5

- **No broken camera picture while it loads**: the camera card shows "Loading camera…"
  until the first picture arrives, instead of a broken image icon and its label.

## 1.0.4

- **Energy card** in place of "Failed and stopped prints": the printer's power right
  now, a two-hour graph, and the electricity cost of the print in progress, today,
  this month and per print. Power is estimated from the heaters and temperatures, or
  read from a smart plug's power sensor (the new **Power sensor** setting). Set your
  rate with **Electricity price per kWh** (0.30 by default). Failed and stopped prints
  are still under Print history.
- **Each print's cost includes electricity** once the app has measured it.
- **The Start buttons' text is readable**: it was grey on blue.

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
