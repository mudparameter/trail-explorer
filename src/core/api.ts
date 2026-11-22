// The only interface between the window and the rest of the app.
// A web version would back this with a server.

export interface SyncStatus {
  state: 'idle' | 'listing' | 'downloading' | 'waiting' | 'offline' | 'key-rejected' | 'error';
  message: string;
  done: number;
  total: number;
  /** Rides with a track on the map. */
  onMap: number;
  noGps: number;
  failed: number;
  lastSync: string | null;
  buildingHeatmap: boolean;
}
export interface Status {
  hasKey: boolean;
  /** A key was saved, but it can no longer be read or Garmin refused it. */
  keyProblem: string | null;
  keyExpires: string | null;
  sync: SyncStatus;
  heatmapVersion: number;
  version: string;
}
export type Bounds = [number, number, number, number];
export interface MapInfo {
  id: string;
  name: string;
  kind: 'shortbread' | 'raster' | 'vector';
  bounds: Bounds;
  minzoom: number;
  maxzoom: number;
  /** Data layers inside the file, for maps we have no styling for. */
  layers: string[];
  attribution: string;
}
export interface LayerState {
  id: string;
  on: boolean;
  opacity: number;
}
export interface View {
  center: [number, number];
  zoom: number;
}
export interface Saved {
  /** Top first. */
  layers: LayerState[] | null;
  view: View | null;
  focus: Bounds | null;
}
export type Result<T = void> = { ok: true; value: T } | { ok: false; error: string };

export interface TrailApi {
  getStatus(): Promise<Status>;
  onStatus(fn: (s: Status) => void): () => void;
  saveKey(key: string, expires: string | null): Promise<Result>;
  setKeyExpires(expires: string | null): Promise<Result>;
  removeKey(): Promise<Result>;
  syncNow(): Promise<Result>;
  deleteRides(): Promise<Result>;
  listMaps(): Promise<MapInfo[]>;
  /** Opens a file picker. Null when cancelled. */
  pickMap(): Promise<Result<MapInfo | null>>;
  addDroppedMap(file: File): Promise<Result<MapInfo>>;
  renameMap(id: string, name: string): Promise<Result>;
  removeMap(id: string): Promise<Result>;
  getSaved(): Promise<Saved>;
  saveLayers(layers: LayerState[]): Promise<void>;
  saveView(view: View): Promise<void>;
}
