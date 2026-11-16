# Print Log

A page for your Bambu Lab printer: every job it prints, the filament each AMS slot
fed and what it cost, how much is left on each spool, and the print in progress
with Pause, Resume and Stop. You can send a sliced file to the printer, start it,
and download files for Bambu Studio. It adds a **Print Log** panel to the sidebar
for administrators.

## Contents

- [What it needs](#what-it-needs)
- [Getting started](#getting-started)
- [Turning on printer controls (Developer LAN mode)](#turning-on-printer-controls-developer-lan-mode)
- [The printer's files (access code)](#the-printers-files-access-code)
- [Settings](#settings)
- [What's on the page](#whats-on-the-page)
- [How jobs are recorded](#how-jobs-are-recorded)
- [Troubleshooting](#troubleshooting)
- [Security and privacy](#security-and-privacy)

## What it needs

- The **[Bambu Lab integration](https://github.com/greghesp/ha-bambulab)**, installed
  from HACS and set up for your printer. Print Log finds the printer, its AMS units and
  their spools through it. Any printer the integration supports works (X1, P1, A1,
  H2D, X2D and others); several printers are shown with a picker at the top.
- **Recorder**, which Home Assistant has by default.

## Getting started

1. Add this repository to Home Assistant (see the [repository README](../README.md)),
   then install **Print Log** from the app store.
2. Start it. **Show in sidebar** is on by default.
3. Open **Print Log** in the sidebar.

On first start it reads the jobs in Recorder's history (10 days unless you keep more),
so the history isn't empty. From then on it keeps its own log, so jobs stay after
Recorder forgets them.

## Turning on printer controls (Developer LAN mode)

Pause, Resume, Stop and Start go through the Bambu Lab integration. Recent Bambu
firmware only accepts those commands from Home Assistant when the printer is in
**Developer LAN mode**. Until then the page shows the buttons greyed out, with the
reason, and everything else works.

On the printer's screen, open the network settings, turn on **LAN Only** and then
**Developer Mode** (the wording varies a little by model and firmware). The Bambu Lab
integration then adds the printer's Pause, Resume and Stop buttons, and the page's
controls light up.

Check Bambu Lab's notes for your printer before you switch: in Developer LAN mode,
Bambu Handy and printing through Bambu's cloud may stop working, and you print from
Bambu Studio over your network instead.

If you'd rather the page only read, turn off **Printer controls** on the app's
Configuration tab.

## The printer's files (access code)

To list the files on the printer, send it a `.3mf`, start one or download one, the app
connects to the printer's storage the way Bambu Studio does, using the printer's
**access code**:

1. On the printer's screen, open the network settings and note the **Access Code**.
2. On the app's **Configuration** tab, paste it into **Printer access code**, save, and
   restart the app.

With more than one printer, also fill in **Printer serial number** for the printer the
code belongs to.

The code stays in the app; it's never shown on the page or written to the log. The app
only connects to the address the Bambu Lab integration reports for the printer.

## Settings

| Setting | What it does |
| --- | --- |
| **Printer controls** | On: Pause, Resume, Stop and Start are on the page. Off: the page only reads. |
| **Printer access code** | Optional. Enables the printer's files (above). |
| **Printer serial number** | Only with more than one printer: which one the access code is for. |
| **Electricity price per kWh** | What you pay for electricity (0.30 by default), for the energy card and each print's cost. |
| **Power sensor** | Optional. A smart plug's power sensor (in W), for example `sensor.printer_plug_power`. Empty: the power is estimated (below). |
| **Low spool warning (g)** | A spool with less than this gets a heads-up (150 g by default). A spool that will run out within two weeks at your recent pace gets one too. |
| **Default price per kg** | For any material that isn't in the price list. |
| **Filament prices** | Price per kilogram for each material, as the AMS names it (PLA, PETG, ASA, …). A variant such as PETG-HF uses PETG's price unless it has its own line. |

Restart the app after changing them.

## What's on the page

- **The print in progress:** a camera picture every 10 seconds, progress, layer, time
  left and when it'll finish, the nozzle, bed and chamber temperatures, and which slot
  is feeding. **Pause** and **Resume** act straight away; **Stop** asks first, because
  it can't be undone. When nothing is printing, the card still shows the camera (a
  picture every 30 seconds), the temperatures, the printer's state and the last job.
  The **Light** button on the camera turns the chamber light on and off.
- **Start a print:** the sliced `.3mf` files on the printer, newest first: the five
  most recent show, and the list scrolls for the rest. **Start**
  opens a dialog: pick the plate (with its picture), check the AMS slot for each
  filament (the app picks the closest material and colour and warns about a mismatch or
  a spool that's too low), and choose bed leveling, flow calibration and timelapse.
  Make sure the build plate is clear before you start. Drop a `.3mf` on the card, or
  use **Choose file**, to send one to the printer. Export it from Bambu Studio with
  **File > Export > Export plate sliced file**. The download button saves a file to open
  in Bambu Studio.
- **Spools:** each slot's filament, colour and amount (from the spool's RFID tag; a
  spool without one shows the amount as unknown), how much it fed in the last 30 days,
  and a heads-up when it's low. Each AMS shows its humidity (with the AMS's own 1 to 5
  dryness level) and whether it's drying. **Reorder** lists spools by when they'll run
  out at your recent pace.
- **This month:** prints, success rate, print time, filament used and wasted, and cost,
  next to last month's.
- **Filament per day:** grams for each of the last 30 days, failed prints in red, and
  the split by material.
- **Energy:** the printer's power right now, what that costs an hour, a graph of the
  last two hours, and the electricity cost of the print in progress (or the last one),
  today, this month and the average print. Without a power sensor the watts are
  **estimated**: a heater still warming up counts at full power (bed about 700 W,
  each nozzle 60 W, chamber 350 W), one holding its temperature at a share of that,
  plus 14 W idle or 45 W printing for the electronics, fans and motors. It's a fair
  guide, not a meter; a smart plug with power monitoring gives real numbers. The
  app adds the energy up every 30 seconds from when it's running (1.0.4 on), so the
  totals start then.
- **Print history:** every job, newest first, with its plate, time, grams per slot,
  cost (filament plus electricity; hover for the split) and result. **Failed or
  stopped** shows just those, with how far each got. A download button appears when the job's file is still on the
  printer.

The page refreshes every 5 seconds while something prints and every 30 seconds
otherwise.

## How jobs are recorded

Print Log rebuilds each job from the Bambu Lab integration's entities in Recorder's
history, every two minutes and as soon as a print ends:

- A job runs from when the printer starts preparing until it reports finished or
  failed. A short Wi-Fi drop mid-print doesn't split it.
- A print you stop is reported by the printer as failed. One stopped from this page is
  logged as **Stopped**; one stopped elsewhere shows as failed.
- **Grams** are the slicer's weight for the job; for a failed or stopped job, the share
  it got through.
- **Grams per slot** split the job by how long each slot was the one feeding (the
  integration reports it), or, failing that, by each spool's drop in level. It's close,
  but not exact.
- **Cost** is grams per slot times that material's price.

The log is kept in the app's own storage (`/data/jobs.json`), so it's in Home
Assistant's backups of the app.

## Troubleshooting

- **The page says no printer was found:** set up the Bambu Lab integration first.
- **Pause, Resume and Stop are greyed out with "Developer LAN mode":** see
  [Turning on printer controls](#turning-on-printer-controls-developer-lan-mode).
- **"The printer refused the access code":** check the code on the printer's screen.
  It changes if you reset it there.
- **"The printer refused the file connection (port 990)":** LAN access is off on the
  printer, or something on your network blocks Home Assistant from reaching it.
- **"That .3mf isn't sliced yet":** export a sliced file from Bambu Studio (File >
  Export > Export plate sliced file), not the project.
- **A job is missing:** it ended while Home Assistant was off and Recorder didn't record
  it, or before the history Print Log could read on its first start.
- **Grams per slot look off:** they're an estimate; see above.

## Security and privacy

- The panel is for **administrators only**, so only administrators can pause, stop or
  start a print.
- To Home Assistant the app sends only reads (states, registries, history) and exactly
  three kinds of service call: `button.press` on the printer's own Pause, Resume or Stop
  button, `light.turn_on` and `light.turn_off` on the printer's own chamber light, and
  `bambu_lab.print_project_file`. The app refuses any other message before it leaves.
  With **Printer controls** off, it sends none of them.
- Every action is checked against the printer's state when it arrives: stop only while
  printing or paused, start only when idle, and only with a file that's on the printer,
  a plate that's in it and loaded AMS slots.
- Actions are POST requests from the page itself; requests from other sites are refused.
- Files sent to the printer must be `.3mf` (checked by their content, not just the
  name), go only to the printer's storage, and names can't contain path characters.
- The printer's access code and Home Assistant's token stay in the app and never reach
  the browser or the log.
- Inside Home Assistant only the ingress proxy can reach the app, and it runs under an
  enforced AppArmor profile. The printer connection uses TLS; the printer's certificate
  is issued by Bambu Lab rather than a public authority, so the app doesn't verify it
  and only ever connects to the address the integration reports.
