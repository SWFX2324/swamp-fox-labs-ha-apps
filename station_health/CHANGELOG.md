# Changelog

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
