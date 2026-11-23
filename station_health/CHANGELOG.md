# Changelog

## 1.0.8

- **A NAS that goes quiet says what to do.** When the Synology NAS stops reporting
  while Home Assistant's Synology DSM integration still says it's loaded (it doesn't
  always reconnect after a NAS restart), the NAS card says to reload that integration,
  with a link straight to it. Before, it only said "Not reporting".

## 1.0.7

- **Mark a device as stored.** An offline UniFi device now has a **Mark stored** button.
  A stored device stops counting as an alert and shows a grey "Stored" label in the
  device list, Uptime and Recent Activity. The mark clears itself once the device is
  connected again, and **Undo** removes it sooner. It's the app's own note, kept in
  /data; nothing changes on the device or in Home Assistant.

## 1.0.6

- **Updates are a vertical list.** Under each heading, every group has its own line
  with how many items it covers and whether it's current, has updates waiting, or has
  no data.

## 1.0.5

- **Updates are sorted into rows:** Home Assistant, Devices, Network & storage and
  Containers, each with a heading and a fixed order, instead of one line that
  reshuffled whenever something had an update waiting.
- **HACS add-ons share one chip.** Custom integrations and cards installed through
  HACS are grouped as "HACS" in the Home Assistant row; each one still appears by name
  when its update is waiting.
- **Raspberry Pi firmware shows as "Raspberry Pi"** in Devices. Hovering a chip shows
  how many items it covers.

## 1.0.4

- **UniFi devices fit a phone.** Each device is a card with its name and state on top
  and labelled values below (clients, traffic, CPU and memory, temperature, uptime,
  firmware), instead of a table squeezed to the screen. Traffic, CPU and temperature,
  hidden on phones before, now show there too. Desktop is unchanged.

## 1.0.3

- **The banner counts alerts:** "1 Alert", "2 Alerts", or "Everything is normal".
- **"What happened" is now "Recent Activity"**, and it collapses with a click on its
  title. The page remembers your choice in this browser.
- **An integration that recovers stops being an alert within a minute.** Integration
  states were read with the registries, every 10 minutes, so a fixed integration kept
  showing as broken. They're now read with the entity states.
- **Integration alerts name the integration**, for example "System Bridge
  (192.168.1.20)", not just an entry titled with an address.

## 1.0.2

- **A UniFi Express meshed in as an access point is listed as one.** Express units
  report themselves as gateways, so one that went offline was shown as the gateway
  being down, in red. The app now treats only the device the console names as the WAN
  gateway as the gateway.

## 1.0.1

- **The footer shows the real version** instead of "dev". Home Assistant's container
  start-up hid the version from the app, which also made browsers re-fetch the page's
  script and styles after every restart.

## 1.0.0

First release.

- **One page for everything you run:** Home Assistant's host, a Synology NAS, PCs with
  System Bridge, Portainer containers (grouped by compose stack), UniFi devices,
  backups and pending updates.
- **Your UniFi network:** each network (VLAN) with its clients, wired and Wi-Fi split,
  traffic and busiest clients, plus the internet connection's throughput, latency and
  last speed test. Needs a View Only local UniFi account; without one, the UniFi
  devices still show from Home Assistant's UniFi integration.
- **Uptime for the last 24 hours** and **a log of the last 7 days** (outages, updates
  installed, new devices), each outage listed with what changed just before it.
- **View only.** Nothing on the page can start, stop, restart or change anything, and
  the app only sends read requests to Home Assistant and the UniFi console.
- Light and dark appearance, phone and desktop layouts.
