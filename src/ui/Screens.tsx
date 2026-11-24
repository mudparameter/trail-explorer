import { useState } from 'react';
import type { ImportStatus, Status } from '../core/api.ts';
import { trail } from './api.ts';

const inAYear = () => {
  const d = new Date();
  d.setFullYear(d.getFullYear() + 1);
  return d.toISOString().slice(0, 10);
};

export function KeyForm({ onSaved }: { onSaved?(): void }) {
  const [key, setKey] = useState('');
  const [expires, setExpires] = useState(inAYear);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <ol>
        <li>Sign in to <a href="https://connect.garmin.com" target="_blank" rel="noreferrer">Garmin Connect</a> on the web.</li>
        <li>Open Settings, then Personal API Key, then Create Key.</li>
        <li>Choose one year, the longest Garmin offers.</li>
        <li>Copy the key and paste it here. Garmin shows it only once.</li>
      </ol>
      <form className="form" onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        const r = await trail.saveKey(key, expires || null);
        setBusy(false);
        if (r.ok) {
          setKey('');
          onSaved?.();
        } else setError(r.error);
      }}>
        <label>Garmin personal API key<input type="password" value={key} autoComplete="off" onChange={(e) => setKey(e.target.value)} /></label>
        <label>Key expires on (optional)<input type="date" value={expires} onChange={(e) => setExpires(e.target.value)} /></label>
        {error && <p className="error" role="alert">{error}</p>}
        <button disabled={busy || !key.trim()}>{busy ? 'Checking with Garmin…' : 'Save key'}</button>
      </form>
      <p className="small">The key is encrypted on this computer with your system keychain and sent only to Garmin. Your system may ask to let Trail Explorer use the keychain.</p>
    </>
  );
}

function Confirm({ label, question, action }: { label: string; question: string; action(): Promise<unknown> }) {
  const [ask, setAsk] = useState(false);
  if (!ask) return <button onClick={() => setAsk(true)}>{label}</button>;
  return (
    <span className="row">
      {question}
      <button onClick={() => { setAsk(false); void action(); }}>{label}</button>
      <button onClick={() => setAsk(false)}>Cancel</button>
    </span>
  );
}

export function Settings({ status }: { status: Status }) {
  const [replace, setReplace] = useState(false);
  const form = replace || !status.hasKey || !!status.keyProblem;
  return (
    <main className="page">
      <h1>Settings</h1>
      <h2>Garmin key</h2>
      <p>{status.keyProblem ?? (status.hasKey ? 'A key is saved.' : 'No key is saved.')}</p>
      {status.hasKey && !form && (
        <>
          <p>
            <label>Expires on <input type="date" value={status.keyExpires ?? ''} onChange={(e) => void trail.setKeyExpires(e.target.value || null)} /></label>
            <span className="small"> The app reminds you two weeks before.</span>
          </p>
          <div className="row">
            <button onClick={() => setReplace(true)}>Replace key</button>
            <Confirm label="Remove key" question="Remove the key? Your rides stay." action={() => trail.removeKey()} />
          </div>
        </>
      )}
      {form && <KeyForm onSaved={() => setReplace(false)} />}
      <ImportRides status={status.import} />
      <h2>Ride data</h2>
      <p>{status.sync.onMap} rides are stored on this computer.</p>
      <Confirm label="Delete all rides" question="Delete every ride from this computer? Garmin may only return about the last three years." action={() => trail.deleteRides()} />
      <p className="small">While a key is saved, the next sync downloads rides again. Remove the key first to keep them deleted.</p>
      <p className="small">Trail Explorer {status.version}</p>
    </main>
  );
}

export function Help() {
  return (
    <main className="page">
      <h1>Help</h1>
      <h2>Add a detailed map of a region</h2>
      <ol>
        <li>Go to <a href="https://extract.bbbike.org" target="_blank" rel="noreferrer">extract.bbbike.org</a>.</li>
        <li>Draw a box around the area you want.</li>
        <li>For the format, choose PMTiles Shortbread. MBTiles Shortbread works too.</li>
        <li>Enter an email address. BBBike sends a link when the map is ready, usually in a few minutes.</li>
        <li>In Trail Explorer, choose Add map and pick the .zip you downloaded, or drop it on the window. You do not need to unzip it.</li>
      </ol>
      <p>The app keeps its own copy, so you can delete the download. Custom maps work without internet.</p>
      <h2>Hide places, such as around home</h2>
      <p>Under Excluded zones in the sidebar, choose Add zone and click the map. Rides are left out inside the circle. Edit sets its size; Move places it again. Zones are drawn in red on your map only.</p>
      <h2>Find roads and trails in an area</h2>
      <p>
        Under Roads and trails in the sidebar, choose Draw a circle. Click the centre, move the mouse out, and click again. The circle
        is kept, and its roads, tracks, cycleways and trails download in the background, so you can draw several while you wait.
        Each one can be named, turned off, filtered by kind with ▸, or deleted with ×. Click a name in the list, or a line on the map,
        to show it. Roads and trails are dashed and drawn under your rides, so anything still dashed is somewhere you
        haven't ridden yet. The Roads and trails layer under Layers sets their opacity and line width for every circle. Circles that overlap share their data, so a circle inside or over another downloads only what is new. Downloading
        needs the internet and sends each circle's position to an OpenStreetMap data server.
      </p>
      <h2>Plan a route</h2>
      <p>
        Draw circles first. Then choose Route planner under Roads and trails. It opens a separate mode, with a blue bar on top, in
        four steps: tick the circles to use, click the map for a start (and a finish, or loop back), set the distance, climbing
        and how much new trail you want, and pick from three to five routes. Each shows its difficulty and why, distance, climbing and
        descent in metric and imperial, steep parts and an elevation profile. Save the ones you like. Saved routes are under Routes,
        in a table you can sort by clicking a column; there you can rename, view, download as .gpx or delete them.
      </p>
      <p>
        Routes are worked out on your computer from the downloaded OpenStreetMap paths, the same way every time. They stay inside the
        circles. Elevation is from free terrain data with 10 to 30 m detail, so short steep pitches are smoothed and climbing can be
        off by 10 to 20%. Paths marked private or no bikes are left out unless you allow them.
      </p>
      <h2>Hide your rides</h2>
      <p>Untick My rides under Layers. Tick it again to bring them back. Its Line width slider makes ride lines thinner or thicker; double-click it to reset.</p>
      <h2>Change colors, maps and where the map opens</h2>
      <p>Open Customize. Everything there is saved as plain files in the config folder, which you can also edit by hand or copy to another computer.</p>
      <h2>What the colors mean</h2>
      <p>The color shows how many times you have ridden each section. Every pass counts: five laps count as five, and an out-and-back counts as two. Trails closer together than about 15 meters may be joined.</p>
      <h2>Which rides are included</h2>
      <p>
        Every activity with GPS: rides, hikes, runs, walks, ski days and so on. Virtual and indoor activities, and ones without a map
        such as strength training, are left out. Garmin appears to return about the last three years. Activities already in the app
        stay. For older ones, use Import rides in Settings with Garmin's Export your data .zip.
      </p>
      <h2>Show only some kinds of activity</h2>
      <p>Under Rides in the sidebar, untick a kind, such as Walking and hiking, to leave it off the heatmap. It is saved as "hide" in heatmap.json.</p>
      <h2>Map credits</h2>
      <p>World map by OpenFreeMap, © OpenMapTiles, data from OpenStreetMap. Topo map by OpenTopoMap (CC-BY-SA), SRTM. Spain topo CC BY 4.0 ign.es. Custom maps and road and trail searches © OpenStreetMap contributors (ODbL), via the Overpass API. Elevation: Mapzen Terrain Tiles on AWS (USGS 3DEP, SRTM, GMTED2010, ETOPO1 and others). Fonts: Noto Sans (SIL Open Font License). Icons: VersaTiles and Maki.</p>
    </main>
  );
}

/** Adds rides from an export .zip, such as Garmin's "Export your data" or Strava's. */
function ImportRides({ status: s }: { status: ImportStatus | null }) {
  const [error, setError] = useState<string | null>(null);
  const reading = s?.state === 'reading';
  return (
    <>
      <h2>Import rides</h2>
      <p>
        Add rides from a .zip of ride files, such as the export Garmin Connect or Strava emails you. Rides already here, from Garmin
        or an earlier import, are left out. The .zip is only read: just the new rides are kept.
      </p>
      <button disabled={reading} onClick={async () => {
        setError(null);
        const r = await trail.importRides();
        if (!r.ok) setError(r.error);
      }}>{reading ? 'Importing…' : 'Import rides from a .zip'}</button>
      {error && <p className="small error" role="alert">{error}</p>}
      {s && (
        <p className={`small${s.state === 'error' ? ' error' : ''}`} role="status">
          {reading ? `Reading ${s.file}: ${s.found} file${s.found === 1 ? '' : 's'} checked, ${s.added} new ride${s.added === 1 ? '' : 's'} so far…` : s.message}
        </p>
      )}
    </>
  );
}
