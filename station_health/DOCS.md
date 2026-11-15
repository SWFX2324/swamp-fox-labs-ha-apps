# Station Health

One view-only page for everything you run: Home Assistant's machine, your NAS and
PCs, Docker containers, your UniFi network and its VLANs, backups and updates. It adds
a **Station Health** panel to the sidebar for administrators.

It reads Home Assistant and, if you set it up, your UniFi console. It changes nothing
in either: nothing on the page can start, stop, restart or change anything.

## Contents

- [What it reads](#what-it-reads)
- [Getting started](#getting-started)
- [Adding your UniFi console (VLANs and internet)](#adding-your-unifi-console-vlans-and-internet)
- [Settings](#settings)
- [What's on the page](#whats-on-the-page)
- [How often it updates](#how-often-it-updates)
- [Troubleshooting](#troubleshooting)
- [Security and privacy](#security-and-privacy)

## What it reads

Everything is optional; panels for things you don't have stay hidden.

| Panel | Comes from |
| --- | --- |
| Home Assistant host | The Supervisor (uptime, disk, versions) |
| NAS | The [Synology DSM](https://www.home-assistant.io/integrations/synology_dsm/) integration |
| PCs | The [System Bridge](https://www.home-assistant.io/integrations/system_bridge/) integration |
| Containers | The [Portainer](https://www.home-assistant.io/integrations/portainer/) integration |
| UniFi devices, Wi-Fi networks | The [UniFi Network](https://www.home-assistant.io/integrations/unifi/) integration |
| Networks (VLANs), internet | Your UniFi console directly, with a View Only login (below) |
| Backups | Home Assistant's automatic backups |
| Updates | Every `update` entity in Home Assistant |
| Uptime and the log | Home Assistant's Recorder history of the entities above |

## Getting started

1. Add this repository to Home Assistant (see the [repository README](../README.md)),
   then install **Station Health** from the app store.
2. Start it. **Show in sidebar** is on by default.
3. Open **Station Health** in the sidebar.

Without any settings it shows everything Home Assistant knows. Add your UniFi console
to see each VLAN and the internet connection.

## Adding your UniFi console (VLANs and internet)

Home Assistant's UniFi integration reports devices and Wi-Fi networks, but not each
network (VLAN) or the internet connection's throughput, so the app asks the console
itself. It needs a **local** UniFi account; a **View Only** one is enough, and is the
safest choice because it can't change anything.

On a UniFi OS console (UniFi OS 4 and later):

1. Sign in to your console by its address, for example `https://192.168.1.1`.
2. Open **People** (called **Admins & Users** on some versions) and choose
   **Add New Person**.
3. Account type **Admin**, with the role **View Only** (Network: View Only, and
   nothing more anywhere else).
4. Turn on **Local Account Only**, then set a username and password.
5. Create it.

You can use the same account for Home Assistant's UniFi integration: with View Only
access it creates read-only sensors and no switches.

Then, on the app's **Configuration** tab, fill in the console's address, the username
and the password, save, and restart the app.

## Settings

| Setting | What it does |
| --- | --- |
| **UniFi console address** | The console's IP address or host name, for example `192.168.1.1`. For a self-hosted UniFi Network server, add its port: `192.168.1.5:8443`. Empty: UniFi data comes from Home Assistant only. |
| **UniFi username / password** | The local View Only account. The password stays in the app. |
| **UniFi site** | `default` unless you run more than one site. |
| **Verify SSL certificate** | Off for a console with its own self-signed certificate, which is the usual case at home. Turn it on if the console has a trusted certificate. |

Restart the app after changing them.

## What's on the page

- **Overview:** any alerts, counted in the banner ("2 Alerts") and listed: a host or PC not
  reporting, a container that isn't running, a UniFi device offline, the internet
  down, a failed or old backup, an integration that won't load. Tiles summarise
  containers, hosts, the internet, the network, the last backup and pending updates.
- **Internet:** current download and upload, a 24-hour graph (the app samples the
  connection every 5 minutes), latency, drops and the console's last speed test.
- **Networks:** one card per network with its VLAN ID and subnet, clients (wired and
  Wi-Fi), current traffic, the three busiest clients and devices first seen today.
- **UniFi devices:** state, clients, traffic, CPU and memory, temperature, PoE use on
  switches, uptime and firmware.
- **Hosts:** CPU, memory, disk and temperature where the integration reports them. A
  PC that stops reporting shows as "no data" rather than down: it may just be asleep.
- **Containers:** state, CPU, memory against the container's limit, the last Docker
  event and whether a newer image is available. Compose stacks (`nextcloud_app`,
  `nextcloud_db`) are grouped.
- **Uptime:** the last 24 hours in 30-minute blocks for every host, UniFi device,
  container (or stack) and the internet. Grey means no data, for example a PC asleep.
- **Backups & updates:** the last good backup and the next one, and every pending
  update. Install updates where you normally do; the page has a link to Home
  Assistant's Updates page.
- **Recent Activity:** the last 7 days of outages, updates installed and new devices on
  the network. Each outage lists any update or container event in the 15 minutes
  before it, which often points at the cause. Collapse it with its title; the page
  remembers that in your browser.

## How often it updates

The page refreshes every 30 seconds while it's open; **Refresh** fetches everything at
once. Home Assistant's history behind the uptime chart and the log is read every 5
minutes. The internet graph's samples are kept for 24 hours in the app's own storage.

## Troubleshooting

- **"The UniFi console refused the username or password"**: the account must be a
  local one (Local Account Only), not a Ubiquiti cloud account.
- **"The UniFi console's certificate isn't trusted"**: turn off **Verify SSL
  certificate**, or give the console a trusted certificate.
- **A PC shows "no data"**: System Bridge isn't answering. The PC may be asleep or off,
  or System Bridge isn't running on it.
- **No containers**: add the Portainer integration to Home Assistant.

## Security and privacy

- The panel is for **administrators only**, because it lists network clients, their
  addresses and host details.
- The app only **reads**. To Home Assistant it sends only read messages (states,
  registries, history) and never calls a service; to the UniFi console it signs in and
  sends only GET requests. A View Only UniFi account makes that a guarantee on the
  UniFi side too.
- The UniFi password and Home Assistant's token stay in the app and never reach the
  browser. Your WAN address isn't shown.
- Inside Home Assistant only the ingress proxy can reach the app, and it runs under an
  enforced AppArmor profile.
