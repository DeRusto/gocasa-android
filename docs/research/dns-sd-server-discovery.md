# DNS-SD server discovery for GoCasa and the Display app

Research for issue #6. Checked 2026-11-01 against primary sources (library repos via the GitHub API, developer.android.com, Chromium/ChromiumOS source, developer.chrome.com, docs.docker.com). Items marked **Unverified** were not confirmed at the source or on hardware.

## Short answer

- **Go library:** use [`github.com/brutella/dnssd`](https://github.com/brutella/dnssd). Fallback: [`github.com/libp2p/zeroconf/v2`](https://github.com/libp2p/zeroconf). Both are pure Go, so `CGO_ENABLED=0` and the `FROM scratch` image still work.
- **Docker:** mDNS doesn't leave the default bridge network that GoCasa's `compose.yaml` uses. Advertising needs `network_mode: host` on Linux Docker Engine. The other option is for the host's own Avahi to advertise the service.
- **Android in ARCVM:** ChromeOS's `patchpanel` daemon forwards mDNS between the LAN and the ARC guest by design, so `NsdManager` should work. On Wi-Fi, the app must hold a `WifiManager.MulticastLock`. **Not tested on a Chromebook.**
- **Android 17 caveat (affects every target, not just ChromeOS):** when the app targets SDK 37, it needs `ACCESS_LOCAL_NETWORK` both for the WebView to reach the server and for NSD discovery. The NSD picker (`FLAG_SHOW_PICKER`) avoids that prompt.
- **ChromeOS extension or web page:** Manifest V3 extensions and web pages have no mDNS or raw-socket API. `chrome.mdns` and `chrome.sockets.*` are for Chrome Apps only, and Chrome Apps are deprecated. What's left: the user types the URL or a `gocasa.local` hostname once, or the page probes a remembered address. Both are subject to Chrome's Local Network Access prompt.

## 1. Go library for advertising `_gocasa._tcp`

GoCasa constraints (from `goCasa/go.mod` and `Dockerfile`): `go 1.27.2`, `CGO_ENABLED=0`, a `FROM scratch` runtime image, and user `65532`. Any library that wraps Avahi or Bonjour through cgo or D-Bus is ruled out. The candidates below are all pure Go.

Repo data comes from the GitHub API (`repos/<r>`, `commits?per_page=1`, `tags`) and each repo's `go.mod`, fetched 2026-11-01.

| Library | Last commit | Latest tag | Deps (go.mod) | Probing/announce | Notes |
|---|---|---|---|---|---|
| [brutella/dnssd](https://github.com/brutella/dnssd) | 2026-02-27 | v1.2.14 | miekg/dns, vishvananda/netlink (Linux), x/net | Yes. The README says the responder probes the instance name and host name, then announces | MIT. `Config{Name, Type, Port, Ifaces}` → `NewService` → `NewResponder().Add()` → `Respond(ctx)`. Live TXT update via `UpdateText`. Also used by the author's HomeKit stack (`hap`) |
| [libp2p/zeroconf/v2](https://github.com/libp2p/zeroconf) | 2025-03-28 | v2.2.0 | miekg/dns, x/net (2021 pins) | Yes. `server.go` has `probe()` | Fork of grandcat that merged its pending PRs. `Register(instance, service, domain, port, txt, ifaces)`. `RegisterProxy` lets you set the host and IPs explicitly |
| [grandcat/zeroconf](https://github.com/grandcat/zeroconf) | 2023-01-19 | none | | Partial | The libp2p fork's README calls it unmaintained. Skip it |
| [hashicorp/mdns](https://github.com/hashicorp/mdns) | 2026-10-19 | v1.0.7 | miekg/dns, x/net | **No.** A grep of `server.go` finds no probe or announce code, so it only answers queries | The most active repo, but it's a minimal responder: no name-conflict handling, and new clients see the service only when they query |

**Recommendation:** use `brutella/dnssd`. It probes and announces as RFC 6762 requires, renames on a conflict, can be limited to an interface (`Ifaces`), and is maintained. If its `netlink` dependency is unwanted, use `libp2p/zeroconf/v2`, whose API is a single `Register` call.

Suggested record: instance name = the household name, type `_gocasa._tcp`, port = the HTTP port. TXT could carry `path=/` and a `ver=` value. That's a design suggestion, not a researched fact.

**Unverified:** whether either library binds UDP 5353 cleanly next to a running `avahi-daemon` on the same host (port sharing via `SO_REUSEADDR`/`SO_REUSEPORT`). Test this on the target host.

### Docker / host networking

GoCasa's [`compose.yaml`](https://github.com/DeRusto/goCasa/blob/main/compose.yaml) uses the default bridge network with `ports: "8080:8080"`.

- On a bridge network, the container's multicast (224.0.0.251:5353) stays on the Docker bridge and is not routed to the LAN. Any A record the library builds would also carry the container's 172.x address. **Unverified on the Docker side:** the [host network driver page](https://docs.docker.com/engine/network/drivers/host/) doesn't mention multicast. This follows from how Linux bridge and NAT work.
- With `network_mode: host` (Linux Docker Engine), the container shares the host's network stack. In that mode `ports:` is ignored ([Docker docs](https://docs.docker.com/engine/network/drivers/host/)). Advertising then works as it would for a bare binary.
- Docker Desktop 4.34+ host networking "works at layer 4" only, and processes can't bind to the host's IPs ([Docker docs](https://docs.docker.com/engine/network/drivers/host/)). Expect mDNS not to reach the LAN from Docker Desktop (**unverified**).
- Practical shape: put DNS-SD behind an opt-in setting such as `MDNS=1`. Document `network_mode: host` for Linux. For bridge setups, document an Avahi static service file on the host (`/etc/avahi/services/gocasa.service`) as an alternative.

## 2. Android `NsdManager` inside ChromeOS ARCVM

- ChromeOS's `patchpanel` daemon runs an "mDNS forwarder proxying mDNS traffic between physical networks and guest platforms in both directions." Guest platforms include ARCVM ([patchpanel README](https://chromium.googlesource.com/chromiumos/platform2/+/HEAD/patchpanel/README.md)). It also forwards SSDP.
- `multicast_forwarder.h` rewrites mDNS A records that point to the guest IP "so that Android can advertise services to devices on the LAN." It has a per-guest inbound flag, and a comment says that flag "only affects ARC" ([source](https://chromium.googlesource.com/chromiumos/platform2/+/HEAD/patchpanel/multicast_forwarder.h)).
- `manager.h` says inbound Wi-Fi multicast (mDNS and SSDP) is forwarded to ARC only while the Android Wi-Fi multicast lock is held. For ARC V+, it adds that "any offload service also needs to be registered" ([source](https://chromium.googlesource.com/chromiumos/platform2/+/HEAD/patchpanel/manager.h), `NotifyAndroidWifiMulticastLockChange`).

What this means for the Display app: acquire a [`WifiManager.MulticastLock`](https://developer.android.com/reference/android/net/wifi/WifiManager.MulticastLock) while discovering, then use `NsdManager.discoverServices("_gocasa._tcp", PROTOCOL_DNS_SD, …)` and resolve ([NSD guide](https://developer.android.com/develop/connectivity/wifi/use-nsd)).

**Unverified:**
- Behaviour on real ARCVM hardware.
- What the ARC V+ "offload service" condition means for an ordinary app.
- Whether Ethernet-connected Chromebooks forward inbound multicast without the lock. The comment only mentions Wi-Fi.

Test this on the target Chromebook before relying on it, and always keep manual URL entry as a fallback.

### Android 17 local network permission (all Display targets)

From [Local network permission](https://developer.android.com/privacy-and-security/local-network-permission):

- Apps targeting SDK 37+ need `ACCESS_LOCAL_NETWORK` (in the `NEARBY_DEVICES` group) for TCP and UDP to the LAN. This covers "all networking APIs", and "Traffic originating from Android Webviews … will inherit permission state from the host app." Resolving `.local` names also requires it.
- Apps targeting 36 or lower keep an implicit grant through `INTERNET`, for now.
- NSD picker path: `DiscoveryRequest.Builder("_gocasa._tcp").setFlags(DiscoveryRequest.FLAG_SHOW_PICKER)` with `registerServiceInfoCallback`. The user picks one service, and connections to its addresses then don't need `ACCESS_LOCAL_NETWORK`. That grant persists across reboots.

That picker matches "find the household's server once" well, but it needs a platform with the API. LineageOS and ARCVM Android versions lag behind, so check the API level on each device. Otherwise, request `ACCESS_LOCAL_NETWORK` at runtime, or stay on target SDK 36 for now.

## 3. ChromeOS extension or web page

- `chrome.mdns` is listed only under Platform Apps APIs and needs the `mdns` permission. Chrome Apps "was deprecated in 2020" ([reference](https://developer.chrome.com/docs/apps/reference/mdns)). `chrome.sockets.udp` is likewise apps-only.
- The [extensions API index](https://developer.chrome.com/docs/extensions/reference/api) has no sockets, mDNS or discovery API. The closest are `printerProvider` and `dns` (Dev channel).
- Web pages, and extension pages doing `fetch`, are subject to [Local Network Access](https://developer.chrome.com/blog/local-network-access). It ships as a permission prompt in Chrome 142 ("Look for and connect to any device on your local network"). `.local` hostnames count as local for the mixed-content exemption. The article doesn't say whether extensions are exempt (**unverified**).

Options that remain for an extension build:
1. **Manual entry plus memory:** the user types the server URL once, and the extension stores it.
2. **`.local` hostname:** GoCasa (or host Avahi) publishes a host name such as `gocasa.local`, which the user types or the extension tries by default. **Unverified:** whether Chrome on ChromeOS resolves `.local` names for navigation and `fetch`. Chromium has code that treats `.local` as mDNS names, but ChromeOS behaviour wasn't confirmed.
3. **Lean on the Android app:** on Chromebooks, the ARCVM Display app (section 2) is the discovery path. The extension build gets manual or `.local` entry only.

Not recommended: scanning the subnet with `fetch` from a page. It's slow, the Local Network Access prompt still gates it, and it's brittle.
