# Security policy

## Supported versions

Only the latest release of each app gets fixes. Home Assistant offers the update
as soon as it's published, so the fix for a problem is to update.

| App | Supported |
| --- | --- |
| Ham Radio Dashboard, latest release | Yes |
| Ham Radio Dashboard, older releases | No |
| ADS-B Tracker, latest release | Yes |
| ADS-B Tracker, older releases | No |
| Weather Observatory, latest release | Yes |
| Weather Observatory, older releases | No |
| Station Health, latest release | Yes |
| Station Health, older releases | No |

## Reporting a vulnerability

Please don't open a public issue. Report it privately instead:
[**Report a vulnerability**](https://github.com/SWFX2324/swamp-fox-labs-ha-apps/security/advisories/new)
(the Security tab, then **Report a vulnerability**). Only the maintainer sees it.

Include what you found, the app version, and how to reproduce it. You'll hear back
within a week. Once it's fixed, a release goes out and the advisory is published,
crediting you unless you'd rather not be named.

## What's in scope

- The app's server and dashboard (`ham_dashboard/app`): for example a way around
  the admin-only check on setup and saved paths, reading or writing outside the
  app's storage, or the app trusting requests that don't come through Home
  Assistant's ingress.
- The ADS-B Tracker's server and page (`adsb_tracker/app`): for example making
  it fetch anything other than its fixed adsb.fi paths, or reaching it other than
  through ingress.
- Weather Observatory's server and page (`weather_observatory/app`): for example
  making it call a Home Assistant service that changes something, exposing its
  token or the exact home location, fetching anything other than its fixed
  weather sources, or reaching it other than through ingress.
- Station Health's server and page (`station_health/app`): for example making it
  send Home Assistant anything other than its read-only requests, sending the UniFi
  console anything other than a sign-in and GET requests, exposing the Supervisor
  token or the UniFi password to the page, letting a network client's name run code
  in the page, or reaching it other than through ingress.
- The image and how it's built: the AppArmor profile, the Dockerfile, the GitHub
  Actions workflows and image signing.

Problems in Home Assistant itself, the Supervisor, or the public data services
the dashboard reads (NOAA, PSKReporter, POTA and the rest) belong with those
projects.

## How the app is protected

The dashboard is receive-only and only reads public data. It runs under its own
enforced AppArmor profile, is reached only through Home Assistant's ingress, and
only Home Assistant admins can change shared settings. Every image is signed with
Cosign by this repository's build workflow, and actions and the base image are
pinned to exact versions, updated through Dependabot. The details, including how
to verify an image's signature, are in the
[documentation](ham_dashboard/DOCS.md#security-and-privacy).
