// The only interface between the window and the rest of the app.
// A web version would back this with a server.
import type { Config, FILES, Problem } from './config.ts';
import type { Area, AreaEdit } from './areas.ts';
import type { Road, RoadKind } from './roads.ts';
import type { CircleEdit } from './zones.ts';

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
/** Reading rides from an export .zip. */
export interface ImportStatus {
  state: 'reading' | 'done' | 'error';
  /** The .zip's file name. */
  file: string;
  /** Ride files found so far. */
  found: number;
  added: number;
  /** Already here, from Garmin or an earlier import. */
  had: number;
  noGps: number;
  unread: number;
  /** Indoor and virtual rides. */
  skipped: number;
  /** Files that are not activities, such as daily health data. */
  other: number;
  message: string;
}
export interface Status {
  hasKey: boolean;
  /** A key was saved, but it can no longer be read or Garmin refused it. */
  keyProblem: string | null;
  keyExpires: string | null;
  sync: SyncStatus;
  /** The last import since the app started, if any. */
  import: ImportStatus | null;
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
  /** Ride line width, for the heatmap layer. */
  width?: number;
}
export interface View {
  center: [number, number];
  zoom: number;
}
export interface Saved {
  /** Where the map was left. */
  view: View | null;
  focus: Bounds | null;
  showZones: boolean;
}
export interface ConfigState {
  config: Config;
  problems: Problem[];
  /** The config folder in use. */
  dir: string;
  /** Why this folder: the default one, one picked in Settings, or the TRAIL_CONFIG variable. */
  source: 'default' | 'chosen' | 'env';
  /** Map files that could be read, by layer id. */
  maps: Record<string, MapInfo>;
}
/** An area, with how its download is going and what it holds. */
export interface AreaView extends Area {
  /** ready: all its data is here. queued: waiting for a download slot. */
  state: 'ready' | 'queued' | 'downloading' | 'error';
  error: string | null;
  /** Tiles of data downloaded, of the tiles it needs. */
  done: number;
  total: number;
  /** Changes when its roads change, so the window knows to fetch them again. 0 until ready. */
  version: number;
  /** Metres of each kind inside the circle. */
  totals: Partial<Record<RoadKind, number>>;
}
export type ConfigFile = (typeof FILES)[number];
export type Result<T = void> = { ok: true; value: T } | { ok: false; error: string };

export interface TrailApi {
  getStatus(): Promise<Status>;
  onStatus(fn: (s: Status) => void): () => void;
  saveKey(key: string, expires: string | null): Promise<Result>;
  setKeyExpires(expires: string | null): Promise<Result>;
  removeKey(): Promise<Result>;
  syncNow(): Promise<Result>;
  /** Asks for an export .zip and adds the rides in it. Null if none was chosen. */
  importRides(): Promise<Result<ImportStatus | null>>;
  deleteRides(): Promise<Result>;
  getConfig(): Promise<ConfigState>;
  onConfig(fn: (c: ConfigState) => void): () => void;
  /** Checks and writes one config file. Refused, with the reasons, when anything in it is wrong. */
  saveConfig(file: ConfigFile, value: unknown): Promise<Result>;
  /** Saves the order, visibility, opacity and ride line width of the layers, top first. */
  saveLayers(layers: LayerState[]): Promise<Result>;
  /** Opens a file picker and adds the map to the config folder. Null when cancelled. */
  pickMap(): Promise<Result<MapInfo | null>>;
  addDroppedMap(file: File): Promise<Result<MapInfo>>;
  renameMap(id: string, name: string): Promise<Result>;
  /** Removes a map layer and deletes its file from the config folder. */
  removeMap(id: string): Promise<Result>;
  addZone(zone: Required<CircleEdit>): Promise<Result>;
  editZone(id: string, edit: CircleEdit): Promise<Result>;
  removeZone(id: string): Promise<Result>;
  /** Asks for a folder to use as the config folder. False when cancelled. */
  pickConfigDir(): Promise<Result<boolean>>;
  useDefaultConfigDir(): Promise<Result>;
  openConfigDir(): Promise<void>;
  getSaved(): Promise<Saved>;
  saveView(view: View): Promise<void>;
  saveShowZones(on: boolean): Promise<void>;
  getAreas(): Promise<AreaView[]>;
  onAreas(fn: (a: AreaView[]) => void): () => void;
  /** The roads and trails in an area. Empty until it is ready. */
  getAreaRoads(id: string): Promise<Result<{ version: number; roads: Road[] }>>;
  /** Saves a new area and starts downloading its data. Returns its id. */
  addArea(area: { center: [number, number]; radius: number; name?: string | null }): Promise<Result<string>>;
  editArea(id: string, edit: AreaEdit): Promise<Result>;
  /** Removes an area. Data another area also uses is kept. */
  removeArea(id: string): Promise<Result>;
  retryArea(id: string): Promise<Result>;
}
