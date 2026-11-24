import { useState } from 'react';
import type { Status } from '../core/api.ts';
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
      <h2>Change colors, maps and where the map opens</h2>
      <p>Open Customize. Everything there is saved as plain files in the config folder, which you can also edit by hand or copy to another computer.</p>
      <h2>What the colors mean</h2>
      <p>The color shows how many times you have ridden each section. Every pass counts: five laps count as five, and an out-and-back counts as two. Trails closer together than about 15 meters may be joined.</p>
      <h2>Which rides are included</h2>
      <p>Cycling activities with GPS. Virtual and indoor rides are left out. Garmin appears to return about the last three years. Rides already in the app stay.</p>
      <h2>Map credits</h2>
      <p>World map by OpenFreeMap, © OpenMapTiles, data from OpenStreetMap. Topo map by OpenTopoMap (CC-BY-SA), SRTM. Spain topo CC BY 4.0 ign.es. Custom maps © OpenStreetMap contributors. Fonts: Noto Sans (SIL Open Font License). Icons: VersaTiles and Maki.</p>
    </main>
  );
}
