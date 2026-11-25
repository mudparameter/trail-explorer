import type { FeatureCollection } from 'geojson';
import type { MagicRequest, PlanRequest } from './planner.ts';
import type { Difficulty, PlannedRoute, RouteStats } from './route.ts';
import type { SavedRoute } from './routes.ts';
import type { Activity } from './activities.ts';
// The only interface between the window and the rest of the app.
// A web version would back this with a server.
import type { Config, FILES, Problem } from './config.ts';
import type { Area, AreaEdit, AreaGroup, GroupEdit } from './areas.ts';
import type { Road, RoadKind } from './roads.ts';
import type { Shape } from './shapes.ts';
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
  /** Rides with a track, by kind of activity. */
  activities: Partial<Record<Activity, number>>;
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
  /** Metres of each kind inside the area. */
  totals: Partial<Record<RoadKind, number>>;
}
/** A group of areas. Joined, it is one area, with its own state and roads; separate, just a heading. */
export interface GroupView extends AreaGroup {
  /** Its areas' ids, in list order. */
  members: string[];
  /** Every one of its areas is shown. */
  on: boolean;
  /** Kinds every one of its areas leaves off. */
  hide: RoadKind[];
  state: AreaView['state'];
  error: string | null;
  done: number;
  total: number;
  /** Joined groups only, like an area's: changes when its roads change. */
  version: number;
  /** Joined groups only: metres of each kind inside any of its shapes, overlaps counted once. */
  totals: Partial<Record<RoadKind, number>>;
}
export interface AreasState {
  areas: AreaView[];
  groups: GroupView[];
}
/** Getting chosen areas ready for route planning. */
export interface PlanProgress {
  stage: 'roads' | 'elevation' | 'network';
  done: number;
  total: number;
}
export interface PlanNetwork {
  /** Names this network; routes are asked for by it. */
  key: string;
  /** Every path in the areas, with kind, ridden and restricted. */
  geojson: FeatureCollection;
  /** Metres of path, and of that, ridden. */
  total: number;
  ridden: number;
  bounds: Bounds;
  /** Elevation tiles that could not be downloaded. Routes there have no elevation. */
  missingElevation: number;
}
/** A saved route, with its points and stats worked out again from its GPX file. */
export interface RouteDetail {
  route: SavedRoute;
  line: [number, number, number][];
  stats: RouteStats;
}
/** Asking for routes again. */
export interface PlanMore {
  /** 0 the first time; each new set uses the next. */
  variant?: number;
  /** Ids of routes already shown, left out of the new set. */
  seen?: string[];
  /** Routes rated this way come first. */
  difficulty?: Difficulty | null;
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
  getAreas(): Promise<AreasState>;
  onAreas(fn: (a: AreasState) => void): () => void;
  /** The roads and trails in an area, or in a joined group. Empty until it is ready. */
  getAreaRoads(id: string): Promise<Result<{ version: number; roads: Road[] }>>;
  /** Saves a new area and starts downloading its data. Returns its id. */
  addArea(area: { shape: Shape; name?: string | null; group?: string | null }): Promise<Result<string>>;
  editArea(id: string, edit: AreaEdit): Promise<Result>;
  /** Removes an area. Data another area also uses is kept. */
  removeArea(id: string): Promise<Result>;
  /** Tries an area's download again, or every area's in a group. */
  retryArea(id: string): Promise<Result>;
  /** Makes a group of these areas, taking them out of any other. Returns its id. */
  addGroup(name: string, areaIds: string[]): Promise<Result<string>>;
  editGroup(id: string, edit: GroupEdit): Promise<Result>;
  /** Removes a group. Its areas stay, on their own, unless `withAreas`. */
  removeGroup(id: string, withAreas: boolean): Promise<Result>;

  /** Gets areas ready for route planning: their paths, which you have ridden, and elevation. */
  planPrepare(areaIds: string[]): Promise<Result<PlanNetwork>>;
  onPlanProgress(fn: (p: PlanProgress) => void): () => void;
  /** Three to five routes for a request, best first. */
  planRoutes(key: string, request: PlanRequest, more?: PlanMore): Promise<Result<PlannedRoute[]>>;
  /** Routes near a distance and of a difficulty, with everything else chosen to suit it. */
  planMagic(key: string, request: Omit<MagicRequest, 'variant'>, more?: PlanMore): Promise<Result<PlannedRoute[]>>;
  getRoutes(): Promise<SavedRoute[]>;
  getRoute(id: string): Promise<Result<RouteDetail>>;
  /** Saves one of the routes just planned. Returns it as saved. */
  saveRoute(plannedId: string, name: string): Promise<Result<SavedRoute>>;
  renameRoute(id: string, name: string): Promise<Result>;
  deleteRoute(id: string): Promise<Result>;
  /** Asks where to save the route's .gpx file. False when cancelled. */
  exportRoute(id: string): Promise<Result<boolean>>;
}
