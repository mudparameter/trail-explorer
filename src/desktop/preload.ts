import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { AreasState, ConfigState, PlanProgress, Status, TrailApi } from '../core/api.ts';

const call = (name: string, ...args: unknown[]) => ipcRenderer.invoke(`trail:${name}`, ...args);

const api: TrailApi = {
  getStatus: () => call('getStatus'),
  onStatus: (fn) => {
    const h = (_: unknown, s: Status) => fn(s);
    ipcRenderer.on('trail:status', h);
    return () => ipcRenderer.off('trail:status', h);
  },
  saveKey: (k, e) => call('saveKey', k, e),
  setKeyExpires: (e) => call('setKeyExpires', e),
  removeKey: () => call('removeKey'),
  syncNow: () => call('syncNow'),
  deleteRides: () => call('deleteRides'),
  getConfig: () => call('getConfig'),
  onConfig: (fn) => {
    const h = (_: unknown, c: ConfigState) => fn(c);
    ipcRenderer.on('trail:config', h);
    return () => ipcRenderer.off('trail:config', h);
  },
  saveConfig: (f, v) => call('saveConfig', f, v),
  saveLayers: (l) => call('saveLayers', l),
  pickMap: () => call('pickMap'),
  importRides: () => call('importRides'),
  addDroppedMap: (f) => call('addMapPath', webUtils.getPathForFile(f)),
  renameMap: (id, n) => call('renameMap', id, n),
  removeMap: (id) => call('removeMap', id),
  addZone: (z) => call('addZone', z),
  editZone: (id, e) => call('editZone', id, e),
  removeZone: (id) => call('removeZone', id),
  exportConfig: () => call('exportConfig'),
  importConfig: (zip) => call('importConfig', zip),
  pickConfigDir: () => call('pickConfigDir'),
  useDefaultConfigDir: () => call('useDefaultConfigDir'),
  openConfigDir: () => call('openConfigDir'),
  getSaved: () => call('getSaved'),
  saveView: (v) => call('saveView', v),
  saveShowZones: (on) => call('saveShowZones', on),
  getAreas: () => call('getAreas'),
  onAreas: (fn) => {
    const h = (_: unknown, a: AreasState) => fn(a);
    ipcRenderer.on('trail:areas', h);
    return () => ipcRenderer.off('trail:areas', h);
  },
  getAreaRoads: (id) => call('getAreaRoads', id),
  addArea: (a) => call('addArea', a),
  editArea: (id, e) => call('editArea', id, e),
  removeArea: (id) => call('removeArea', id),
  retryArea: (id) => call('retryArea', id),
  addGroup: (name, ids) => call('addGroup', name, ids),
  editGroup: (id, e) => call('editGroup', id, e),
  removeGroup: (id, withAreas) => call('removeGroup', id, withAreas),
  planPrepare: (ids) => call('planPrepare', ids),
  onPlanProgress: (fn) => {
    const h = (_: unknown, p: PlanProgress) => fn(p);
    ipcRenderer.on('trail:plan', h);
    return () => ipcRenderer.off('trail:plan', h);
  },
  planRoutes: (k, r, o) => call('planRoutes', k, r, o),
  planMagic: (k, r, o) => call('planMagic', k, r, o),
  getRoutes: () => call('getRoutes'),
  getRoute: (id) => call('getRoute', id),
  saveRoute: (id, n) => call('saveRoute', id, n),
  renameRoute: (id, n) => call('renameRoute', id, n),
  deleteRoute: (id) => call('deleteRoute', id),
  exportRoute: (id) => call('exportRoute', id),
};
contextBridge.exposeInMainWorld('trail', api);
