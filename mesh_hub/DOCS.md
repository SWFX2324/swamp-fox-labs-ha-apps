# Mesh Hub

Meshtastic and MeshCore on one page: your own nodes over Wi-Fi, the nodes they hear on
a map and in a list, your channels and direct messages, and public nodes near your
home from the community maps. It adds a **Mesh** panel to the sidebar for
administrators.

## Contents

- [What it needs](#what-it-needs)
- [Getting started](#getting-started)
- [Settings](#settings)
- [What's on the page](#whats-on-the-page)
- [Messages](#messages)
- [Public nodes](#public-nodes)
- [Troubleshooting](#troubleshooting)
- [Security and privacy](#security-and-privacy)
- [Data sources and credits](#data-sources-and-credits)

## What it needs

One or both of:

- **A Meshtastic node on your network.** Any node with Wi-Fi (ESP32 boards such as
  the Heltec V3/V4, T-Beam, Station G2) or Ethernet (RAK with the Ethernet module).
  Turn on Wi-Fi in the node's network settings (in the Meshtastic app: **Settings →
  Network**). The node's API listens on port **4403**. nRF52 boards without Wi-Fi
  (RAK4631 on its own, T-Echo, T1000-E) can't be reached this way.
- **A MeshCore companion radio running Wi-Fi companion firmware.** Flash the
  *Companion Radio (Wi-Fi)* build for your board from the MeshCore flasher and give it
  your Wi-Fi details. It listens on port **5000**. The Bluetooth and USB companion
  builds can't be reached over the network.

Give each radio a fixed address (a DHCP reservation in your router) so the app always
finds it.

Mesh Hub connects to the radios; it doesn't need a Bluetooth adapter or a USB
connection to Home Assistant.

## Getting started

1. Add this repository to Home Assistant (see the [repository README](../README.md)),
   then install **Mesh Hub** from the app store.
2. On the app's **Configuration** tab, enter your Meshtastic node's address, your
   MeshCore radio's address, or both. Save.
3. Start the app. **Show in sidebar** is on by default.
4. Open **Mesh** in the sidebar. Each radio shows *Connecting…*, then *Loading…* while
   it sends its node list, then *Connected*.

## Settings

| Setting | What it does |
| --- | --- |
| **Meshtastic node address** | IP address or host name of your Meshtastic node, e.g. `192.168.1.50`. Empty: no Meshtastic radio. |
| **Meshtastic port** | The node's API port. `4403` unless you changed it. |
| **MeshCore radio address** | IP address or host name of your MeshCore companion radio. Empty: no MeshCore radio. |
| **MeshCore port** | `5000` unless your firmware was built with another. |
| **Sending messages** | On: the page can send on your channels and to other nodes. Off: the page only reads. |
| **Public map nodes** | Adds public nodes near home from meshmap.net and the MeshCore map. |
| **Public map radius (km)** | How far from home to show public nodes (10 to 500 km, default 100). |

Restart the app after changing a setting.

## What's on the page

- **Tabs:** **All** shows both networks together; **Meshtastic** and **MeshCore** show
  one each. The tab you pick is remembered in your browser. The two networks use
  different radio protocols and can't hear each other, so each node, channel and
  message belongs to one of them.
- **Header badges:** each radio's connection (green or blue when connected, red when
  it can't be reached). A radio that isn't set up has no badge.
- **Your radios:** name, connection, battery, firmware, radio settings (Meshtastic:
  region and modem preset; MeshCore: frequency, spreading factor and bandwidth), how
  many nodes or contacts it knows, and for MeshCore the signal of the last packet it
  heard. If a radio can't be reached, the reason is shown here.
- **Map:** filled dots are nodes your radios know, coloured by network; dots fade when
  a node hasn't been heard for two hours. Your own radio has a ring. Hollow dots are
  public map nodes (turn them off with **Public nodes**), and the dashed circle is the
  public map radius around your home. Click a dot for details: type, hardware, when it
  was heard, hops, SNR and RSSI, battery and voltage, channel use, weather sensors,
  altitude and distance. **Message** opens a direct chat with it.
- **Nodes:** the same nodes as a list. Choose **Heard by my radios**, **Radios + public
  maps** or **Public maps only**; filter by name, ID, type or hardware; click a column
  heading to sort. Click a row to find the node on the map.

For a Meshtastic node, *hops* is how many times a packet was relayed on its way to
you (0 means heard directly). For a MeshCore contact it's the length of the path your
radio knows to it; a dash means no path yet (messages to it are flooded).

## Messages

The chat lists your radio's channels (Meshtastic: the primary channel, named after
its preset when it has no name, and any secondary channels; MeshCore: the channels set
up on the radio, such as *Public*) and your direct conversations. A number shows
unread messages; what you've read is remembered in your browser.

- Each incoming message shows when it arrived, how many hops it took, and its SNR (and
  RSSI on Meshtastic). On a channel, click the sender's name to message them directly.
- Press **Enter** to send, **Shift+Enter** for a new line. The counter shows the
  length in bytes: Meshtastic allows 200, MeshCore 140 (emoji take 4 bytes each).
- After sending: *Sending…* means it's with your radio; **✓ Sent** means another node
  passed it on (Meshtastic) or the radio sent it (MeshCore); **✓✓ Delivered** means
  the recipient confirmed it (direct messages only). *Failed* gives the reason the
  mesh reported.
- On MeshCore, direct messages work with nodes in the radio's contact list. A node
  that has advertised appears there (or after you add it in the MeshCore app, if the
  radio is set to add contacts by hand).
- The app keeps the newest 1,000 messages for each network, so they're there after a
  restart. While the app isn't running, a Meshtastic node holds only a few recent
  messages for it; a MeshCore radio holds them until the app connects again.

## Public nodes

With **Public map nodes** on, the app downloads the public lists and keeps the nodes
within your radius of Home Assistant's home location (**Settings → System →
General**). Without a home location it uses your radio's position.

- **Meshtastic:** [meshmap.net](https://meshmap.net) shows nodes the public Meshtastic
  MQTT server has seen with a position, i.e. nodes with an MQTT gateway nearby. The list
  is downloaded every 10 minutes; nodes not heard for a day are left out.
- **MeshCore:** the [MeshCore map](https://map.meshcore.io) shows nodes people have
  uploaded. The full list is large (tens of MB), so it's downloaded every 6 hours and
  read piece by piece, keeping only the nodes nearby. Nodes not heard for 10 days are
  left out.

A node your radio also hears is shown once, with what your radio knows. Public nodes
can't be messaged; they're for seeing who's around.

## Troubleshooting

**A radio stays on *Offline*.** The reason is shown under the radio:

- *refused the connection*: the address is right but nothing is listening on that
  port. For Meshtastic, check that Wi-Fi is on in the node's network settings; for
  MeshCore, that the radio runs the Wi-Fi companion firmware. Check the port.
- *Can't reach … on the network* or *didn't answer*: the address is wrong or the radio
  is off or off Wi-Fi. Check the address in your router's client list.
- *Another app may have taken it over*: a Meshtastic node accepts one network app
  connection at a time. If the Meshtastic phone app (or another program) connects to
  the node over Wi-Fi, Mesh Hub is pushed off, and it keeps trying again. The phone
  app over **Bluetooth** works alongside Mesh Hub.

The app retries on its own, sooner at first and then every two minutes.

**No channels or no nodes show.** Wait for *Connected*: a node with a long node list
takes a few seconds to send it all.

**My message shows *Sending…* for a long time.** On Meshtastic, no node passed it on:
nobody else may be in range. Busy channels and duty-cycle limits also delay messages.

**No public nodes.** Check that **Public map nodes** is on and that Home Assistant has
a home location. If a map couldn't be downloaded, the page says so at the top and the
app tries again in 15 minutes. Few or no nodes may simply be nearby: try a bigger
radius.

**The map is grey.** The map tiles come from Esri over the internet; the browser you're
using needs internet access.

## Security and privacy

- **Admins only:** the panel can send messages from your radios, so only Home
  Assistant administrators can open it. Inside Home Assistant the app accepts
  connections only from Home Assistant's ingress proxy, so nothing else on your network
  can use it to send messages.
- **Home Assistant access:** the app reads one thing, your home location
  (`/api/config`), to centre the map and pick public nodes. It calls no services and
  reads no entities.
- **Outside connections:** your radios at the addresses you entered, `meshmap.net` and
  `map.meshcore.io` (only with **Public map nodes** on). Your location isn't sent to
  either; the app downloads the public lists and filters them itself. The page loads
  map tiles from Esri.
- **What's stored:** messages and the nearby public nodes, in the app's own data folder.
  Your tab, appearance and what you've read are kept in your browser.
- **Turning sending off** (**Sending messages**) makes the page read-only.
- An enforced AppArmor profile limits the app to what it needs.

## Data sources and credits

- Meshtastic® is a registered trademark of Meshtastic LLC. MeshCore is an open-source
  project by the MeshCore developers. Mesh Hub isn't affiliated with either.
- Public Meshtastic nodes: [meshmap.net](https://meshmap.net)
  ([source](https://github.com/brianshea2/meshmap.net)), from the public Meshtastic MQTT
  server.
- Public MeshCore nodes: the [MeshCore map](https://map.meshcore.io).
- Map tiles: Esri World Street Map. Sources: Esri, HERE, Garmin, USGS, Intermap,
  INCREMENT P, NRCAN, METI, TomTom and the GIS User Community.
- Map library: [Leaflet](https://leafletjs.com/) 1.9.4, BSD 2-Clause license
  (`app/static/lib/leaflet/LICENSE`).
