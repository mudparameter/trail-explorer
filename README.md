# Trail Explorer

See everywhere you have ridden on one map.

Trail Explorer is a desktop app for macOS and Linux. It downloads your rides from Garmin Connect and draws them as a heatmap: each section of trail is colored by how many times you have ridden it.

![Trail Explorer showing a heatmap of rides around a town](docs/screenshot.png)
<sub>Screenshot from the end-to-end test, with made-up rides.</sub>

## Features

- **Heatmap of every ride.** Each pass counts, so five laps count as five and an out-and-back counts as two. Colors run from blue (ridden once) to white (40 times or more).
- **Syncs from Garmin.** Uses your Garmin personal API key and picks up new rides on its own. It includes cycling activities with GPS and leaves out virtual and indoor rides.
- **Map layers.** The world map (OpenFreeMap), a world topo map (OpenTopoMap) and a Spain topo map (IGN). You can switch each one on or off, reorder them and set how see-through they are.
- **Offline maps.** Add a `.pmtiles` or `.mbtiles` map, or the `.zip` that [BBBike](https://extract.bbbike.org) sends, for a detailed map that works without internet.
- **Private.** Rides stay on your computer. The Garmin key is encrypted with your system keychain and sent only to Garmin.

## Install

There are no published downloads yet, so build it yourself (see [Development](#development) for setup):

| System | Command | Output |
|---|---|---|
| Linux (x64, Debian or Ubuntu) | `npm run package:linux` | `dist/<version>/trail-explorer_<version>_amd64.deb` |
| macOS (Apple silicon) | `npm run package:macos` | `dist/<version>/Trail Explorer-<version>-arm64.dmg` |

On Linux, install the package with:

```sh
sudo apt install ./dist/0.1.1/trail-explorer_0.1.1_amd64.deb
```

The package also installs an AppArmor profile, so the app runs on Ubuntu 24.04 and later without any extra setup.

On Linux the key is stored with GNOME Keyring or KWallet. Standard Ubuntu, Fedora and KDE desktops already run one. If none is running, Trail Explorer will not save the key, because without a keyring it could not encrypt it properly.

## Getting started

1. Sign in to [Garmin Connect](https://connect.garmin.com) on the web.
2. Open **Settings → Personal API Key → Create Key**. Choose one year, the longest Garmin offers.
3. Copy the key and paste it into Trail Explorer. Garmin shows it only once.

The first sync downloads every ride Garmin returns, which seems to be about the last three years. Later syncs only fetch new rides. Once you have added the key's expiry date, the app reminds you two weeks before it runs out.

### Adding a detailed offline map

1. Go to [extract.bbbike.org](https://extract.bbbike.org) and draw a box around your area.
2. Choose the format **PMTiles Shortbread** (MBTiles Shortbread works too) and enter your email address.
3. When the link arrives, download the `.zip`, then use **Add map** in Trail Explorer or drop the file on the window. You don't need to unzip it.

## Development

You need [Node.js](https://nodejs.org) 22.12 or newer. The repo has an `.nvmrc`, so with [nvm](https://github.com/nvm-sh/nvm):

```sh
nvm install        # reads .nvmrc
npm ci
```

**Linux (Ubuntu 24.04 and later):** Ubuntu blocks the sandbox Electron uses unless an AppArmor profile allows it. Run this once for each checkout:

```sh
sudo scripts/linux-sandbox.sh
```

It installs `/etc/apparmor.d/trail-explorer-dev` for this folder's copy of Electron. It is the same kind of profile Chrome and VS Code install. Without it, `npm start` and `npm run dev` stop and tell you to run the script.

| Command | What it does |
|---|---|
| `npm run dev` | Runs the app with hot reload. |
| `npm start` | Builds and runs the app once. |
| `npm test` | Runs the unit tests. |
| `npm run typecheck` | Runs the TypeScript checks. |
| `SHOTS=folder node test/e2e.ts` | Drives the real app against a fake Garmin server and saves screenshots to `folder`. |
| `npm run check-garmin-key` | Tests a real Garmin key from the terminal: how far back rides go and how fast downloads are. |

The development copy is named **Trail Explorer Dev**. It has its own data folder and keychain entry, so it never touches the installed app's rides or key. The first time you run `npm run dev`, it copies your rides and maps (never the key) from the installed app. Run `npm run dev -- --fresh-copy` to copy them again.

App data is stored in:

- macOS: `~/Library/Application Support/Trail Explorer`
- Linux: `~/.config/Trail Explorer`

### Layout

```
src/core/      FIT parsing, track simplification and the heatmap builder (no Electron)
src/desktop/   Electron main process: Garmin sync, SQLite store, maps, key storage
src/ui/        React renderer, MapLibre map
resources/     Bundled map styles, sprites and fonts
scripts/       Dev runner, sandbox setup, style generator, Garmin key check
test/          Unit tests, fake Garmin server, end-to-end test
```

## Credits

World map by [OpenFreeMap](https://openfreemap.org), © OpenMapTiles, data © OpenStreetMap contributors. Topo map by [OpenTopoMap](https://opentopomap.org) (CC BY-SA). Spain topo © [IGN](https://www.ign.es) (CC BY 4.0). Fonts: Noto Sans (SIL Open Font License). Icons: VersaTiles and Maki. See [`resources/CREDITS.txt`](resources/CREDITS.txt).

## License

[MIT](LICENSE)
