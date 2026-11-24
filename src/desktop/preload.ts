import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { ConfigState, Status, TrailApi } from '../core/api.ts';

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
  addDroppedMap: (f) => call('addMapPath', webUtils.getPathForFile(f)),
  renameMap: (id, n) => call('renameMap', id, n),
  removeMap: (id) => call('removeMap', id),
  addZone: (z) => call('addZone', z),
  editZone: (id, e) => call('editZone', id, e),
  removeZone: (id) => call('removeZone', id),
  pickConfigDir: () => call('pickConfigDir'),
  useDefaultConfigDir: () => call('useDefaultConfigDir'),
  openConfigDir: () => call('openConfigDir'),
  getSaved: () => call('getSaved'),
  saveView: (v) => call('saveView', v),
  saveShowZones: (on) => call('saveShowZones', on),
  findRoads: (c, r) => call('findRoads', c, r),
};
contextBridge.exposeInMainWorld('trail', api);
